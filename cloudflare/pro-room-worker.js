/**
 * MUSIXQUARE persistent PRO room service.
 *
 * The public bootstrap endpoint intentionally exposes only room status. Owner
 * claim credentials are issued offline with `issueProRoomActivationClaim` and
 * are never returned by this Worker. Persistent room state is serialized by a
 * per-room Durable Object; private media bytes live in a dedicated R2 bucket.
 */

const PRO_ROOM_CODE_RE = /^0\d{5}$/;
const INITIAL_PRO_ROOMS = Object.freeze([
  Object.freeze({ roomCode: '000000', label: 'MUSIXQUARE Developer' }),
  Object.freeze({ roomCode: '000001', label: 'Friends & Family' }),
]);
const INITIAL_PRO_ROOM_CODES = new Set(INITIAL_PRO_ROOMS.map((room) => room.roomCode));
const ACTIVATION_CLAIM_MAX_LIFETIME_MS = 15 * 60 * 1000;
const PRO_ROOM_REGISTRY_MAX_ITEMS = 1000;
const PRO_ROOM_REGISTRY_REFRESH_MS = 5_000;
const PIN_RE = /^\d{8}$/;
const QUEUE_ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{14,126})[A-Za-z0-9]$/;
const ADMIN_REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const SHA256_RE = /^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/;
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEVELOPER_AUDIO_EXTENSIONS = new Set([
  'mp3',
  'wav',
  'flac',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'opus',
  'webm',
  'aif',
  'aiff',
  'caf',
]);
const SYSTEM_AUDIO_LEASE_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const DEVELOPER_API_KEY_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const DEVELOPER_COMMAND_ID_RE = /^cmd_[A-Za-z0-9_-]{22}$/;
const BOT_BETA_ROOM_CODE = '000001';
const BOT_DEVELOPER_KEY_ID = 'MxqrGeminiBot001';
const BOT_REQUEST_ID_RE = IDEMPOTENCY_KEY_RE;
// A 24-byte random token is encoded as exactly 32 Base64URL characters. Unlike
// public resource identifiers, Base64URL tokens may legitimately begin with
// `-` or `_`; rejecting those values would make a server-issued BOT lease fail
// nondeterministically on its next request.
const BOT_LEASE_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

const SCHEMA_VERSION = 1;
// `pro-room:v1` remains a rollback shadow for rooms that still fit in the old
// single-record budget. The live v2 representation keeps the bounded core and
// playlist rows in separate keys so a large queue cannot crowd media
// completion metadata out of the Durable Object record.
const STORAGE_KEY = 'pro-room:v1';
const STORAGE_V2_CORE_KEY = 'pro-room:v2:core';
const STORAGE_V2_PLAYLIST_PREFIX = 'pro-room:v2:playlist:';
const STORAGE_V2_SCHEMA_VERSION = 2;
const ROOM_QUOTA_BYTES = 1024 * 1024 * 1024;
const ASSET_MAX_BYTES = 200 * 1024 * 1024;
const PLAYLIST_MAX_ITEMS = 1000;
const DEVELOPER_YOUTUBE_BATCH_MAX_ITEMS = 100;
const BOT_MAX_TRACK_ITEMS = 3;
const BOT_MEMBER_MINUTE_LIMIT = 3;
const BOT_ROOM_HOUR_LIMIT = 100;
const BOT_MEMBER_MINUTE_MS = 60 * 1000;
const BOT_ROOM_HOUR_MS = 60 * 60 * 1000;
const BOT_REQUEST_LEASE_MS = 45 * 1000;
// The elected coordinator is one of the 100 connected devices. Signaling
// separately admits at most 99 non-coordinator members for the same ceiling.
const PRESENCE_MAX_ITEMS = 100;
const SESSION_MAX_ITEMS = 128;
const ASSET_MAX_ITEMS = 1024;
const RESERVED_ASSET_MAX_ITEMS = 32;
const RESERVED_ASSET_MAX_ITEMS_PER_PARTICIPANT = 8;
const RESERVED_ASSET_MAX_ITEMS_PER_DEVELOPER_KEY = 2;
const IDEMPOTENCY_MAX_ITEMS = 256;
const RATE_LIMIT_MAX_ITEMS = 512;
const RECOVERY_NONCE_MAX_ITEMS = 128;
const STAGING_TOMBSTONE_MAX_ITEMS = ASSET_MAX_ITEMS;
const DEVELOPER_COMMAND_MAX_ITEMS = 64;
const DEVELOPER_COMMAND_MAX_ACTIVE_ITEMS = 8;
// The command ledger is intentionally separate from the browser mutation
// idempotency ledger. A long-lived coordinator writes a fresh playback
// checkpoint key every 10 seconds, so sharing the 256-slot browser ledger can
// evict a new API key immediately and turn a retry into a duplicate command.
// One room-bound API key may issue 30 commands/minute; 384 entries preserve a
// full ten-minute window even across a fixed-window rate-limit boundary.
const DEVELOPER_COMMAND_IDEMPOTENCY_MAX_ITEMS = 384;
// SQLite-backed Durable Object KV rejects a single value above 2 MiB. Keep
// enough headroom for storage encoding overhead and future schema additions.
// Playlist rows are stored independently and therefore have their own public
// snapshot budget below the client's 4 MiB response ceiling.
const STATE_MAX_BYTES = 1200 * 1024;
const PLAYLIST_STATE_MAX_BYTES = 3 * 1024 * 1024;
const PLAYLIST_ITEM_MAX_BYTES = 128 * 1024;
// Both the rolling-release full snapshot and the v2 compact mutation must be
// able to carry every playlist accepted by the 3 MiB persisted-state budget.
// Keep the endpoint bounded while matching the browser client's JSON ceiling.
const REQUEST_MAX_BYTES = 4 * 1024 * 1024;
const SMALL_REQUEST_MAX_BYTES = 16 * 1024;
const UNLOAD_CLOSE_REQUEST_MAX_BYTES = 4 * 1024;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const PRESENCE_TTL_SECONDS = 45;
const RESERVATION_TTL_SECONDS = 15 * 60;
// A completed upload is deliberately retained long enough for the client to
// append it to the authoritative playlist. If that never happens, the asset is
// an orphan and the Durable Object reclaims it after this grace period.
const ASSET_GC_GRACE_SECONDS = 15 * 60;
const ASSET_GC_RETRY_SECONDS = 60;
const PRESIGN_TTL_SECONDS = 10 * 60;
const DECOMMISSION_RETRY_MS = 60 * 1000;
const DECOMMISSION_FINAL_EMPTY_WINDOW_SECONDS = 60 * 60;
const DECOMMISSION_TOMBSTONE_MAINTENANCE_MS = 24 * 60 * 60 * 1000;
const SIGNALING_TICKET_TTL_SECONDS = 90;
const SYSTEM_AUDIO_MAX_PRESENCE_ITEMS = 4;
const SYSTEM_AUDIO_CLAIM_TTL_MS = 45 * 1000;
const SYSTEM_AUDIO_LIVE_TTL_MS = 2 * 60 * 60 * 1000;
const SYSTEM_AUDIO_TRACK_NAME_MAX_LENGTH = 160;
const SYSTEM_AUDIO_TRACK_MID_MAX_LENGTH = 64;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
// workerd rejects PBKDF2 counts above 100,000. Keep the stored record at the
// runtime ceiling so activation and PIN verification use the strongest value
// Cloudflare can execute instead of surfacing an unhandled NotSupportedError.
const PBKDF2_MAX_ITERATIONS = 100_000;
const PBKDF2_ITERATIONS = PBKDF2_MAX_ITERATIONS;
const MAX_DISPLAY_NAME_LENGTH = 64;
const MAX_MEDIA_NAME_LENGTH = 2048;
const MAX_TEXT_LENGTH = 2048;
const PLAYBACK_MAX_POSITION_SECONDS = 7 * 24 * 60 * 60;
const PLAYBACK_CLOCK_SKEW_MS = 60_000;
const RECOVERY_CLAIM_MAX_LIFETIME_MS = 15 * 60 * 1000;
const OWNER_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
// v1 covers direct playback controls and queue invalidations. v2 adds
// set_effects; v3 adds aggregate-aware next. Older frames remain valid so a
// rolling deploy does not strand an already-open tab.
const DEVELOPER_CONTROL_VERSION = 1;
const DEVELOPER_EFFECTS_CONTROL_VERSION = 2;
const DEVELOPER_NEXT_CONTROL_VERSION = 3;
const DEVELOPER_CONTROL_MAX_VERSION = DEVELOPER_NEXT_CONTROL_VERSION;
const DEVELOPER_COMMAND_TTL_MS = 30 * 1000;
const DEVELOPER_COMMAND_RETRY_MS = 5 * 1000;
const DEVELOPER_COMMAND_MAX_ATTEMPTS = 3;
const DEVELOPER_COMMAND_DISPATCH_TIMEOUT_MS = 900;
const DEVELOPER_COMMAND_RETENTION_MS = 10 * 60 * 1000;
// A command is persisted before its first cross-Worker WebSocket dispatch.
// Keep explicit serialized headroom in that first record, then consume it as
// dispatch/terminal fields are added. This makes a successful send incapable
// of being followed by a capacity rollback that erases the command ledger.
const DEVELOPER_COMMAND_DISPATCH_RESERVE_BYTES = 192;
const DEVELOPER_COMMAND_TERMINAL_RESERVE_BYTES = 256;
const DEVELOPER_COMMAND_RESULT_CODES = new Set([
  'applied',
  'already_applied',
  'busy',
  'no_media',
  'stale_queue',
  'unsupported_mode',
  'expired',
  'execution_failed',
]);

const CONTROLLER_CAPABILITIES = [
  'queue.mutate',
  'playback.control',
  'effects.control',
  'asset.upload',
  'coordinator.eligible',
  'members.manage',
];
const OWNER_CAPABILITIES = [...CONTROLLER_CAPABILITIES, 'room.configure'];

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

function isProRoomCode(value) {
  return typeof value === 'string' && PRO_ROOM_CODE_RE.test(value);
}

const registryCacheByDb = new WeakMap();

function registryCacheFor(db) {
  let cache = registryCacheByDb.get(db);
  if (!cache) {
    cache = {
      registered: new Set(),
      refreshedAtMs: 0,
      refreshPromise: null,
    };
    registryCacheByDb.set(db, cache);
  }
  return cache;
}

async function isFrontProvisionedRoom(roomCode, env, nowMs = Date.now()) {
  const db = env?.MUSIXQUARE_ADMIN_DB || env?.ADMIN_METRICS_DB || null;
  // Local/test environments without the shared registry keep the two launch
  // rooms. Production always binds D1 so a decommission tombstone can close
  // those launch codes just like every dynamically provisioned room.
  if (!db?.prepare) return INITIAL_PRO_ROOM_CODES.has(roomCode);
  const cache = registryCacheFor(db);
  if (nowMs - cache.refreshedAtMs < PRO_ROOM_REGISTRY_REFRESH_MS) {
    return cache.registered.has(roomCode);
  }
  if (!cache.refreshPromise) {
    cache.refreshPromise = (async () => {
      const result = await db
        .prepare(
          `SELECT room_code FROM mxqr_pro_room_registry
           WHERE status = 'registered'
           ORDER BY room_code ASC LIMIT ?1`,
        )
        .bind(PRO_ROOM_REGISTRY_MAX_ITEMS + 1)
        .all();
      const rows = Array.isArray(result?.results) ? result.results : [];
      if (rows.length > PRO_ROOM_REGISTRY_MAX_ITEMS) {
        throw new Error('PRO room registry exceeds its bounded cache capacity');
      }
      cache.registered = new Set(
        rows.map((row) => row?.room_code).filter((value) => isProRoomCode(value)),
      );
      cache.refreshedAtMs = Date.now();
    })().finally(() => {
      cache.refreshPromise = null;
    });
  }
  try {
    await cache.refreshPromise;
  } catch (error) {
    // Fail closed once the registry is bound. A stale positive result must not
    // keep a permanently deleted room open during a D1 incident.
    console.warn('[PRO registry] front-door refresh failed', error);
    cache.registered = new Set();
    cache.refreshedAtMs = Date.now();
    return false;
  }
  return cache.registered.has(roomCode);
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
    'access-control-allow-headers':
      'content-type,idempotency-key,authorization,x-mxqr-pro-participant-id,x-mxqr-pro-presence-incarnation',
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

function validDeveloperActorName(value) {
  return (
    boundedString(value, MAX_DISPLAY_NAME_LENGTH) !== null &&
    !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)
  );
}

function queueAdditionActorName(value, fallback = 'Peer') {
  const normalized =
    typeof value === 'string'
      ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim()
      : '';
  const source = normalized || fallback;
  let result = '';
  for (const character of source) {
    if (result.length + character.length > 30) break;
    result += character;
  }
  return result || 'Peer';
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

/** Owner-claim issuer used by the offline CLI and the Access-gated admin API. */
export async function issueProRoomActivationClaim(roomCode, secret, options = {}) {
  if (!isProRoomCode(roomCode)) throw new Error('Unsupported PRO room code');
  if (typeof secret !== 'string' || secret.length < 32)
    throw new Error('Activation secret too short');
  const nowMs = options.nowMs ?? Date.now();
  const expiresAtMs = options.expiresAtMs ?? nowMs + ACTIVATION_CLAIM_MAX_LIFETIME_MS;
  if (
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= nowMs ||
    expiresAtMs - nowMs > ACTIVATION_CLAIM_MAX_LIFETIME_MS
  ) {
    throw new Error('Invalid expiry');
  }
  const generation = options.generation ?? 0;
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Invalid generation');
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
      generation,
    },
    secret,
  );
}

async function verifyActivationClaim(token, roomCode, secret, nowMs) {
  if (typeof secret !== 'string' || secret.length < 32) return null;
  const payload = await verifySignedToken(token, secret);
  return payload &&
    payload.v === 1 &&
    payload.purpose === 'pro-room-activation' &&
    payload.roomCode === roomCode &&
    Number.isSafeInteger(payload.iat) &&
    payload.iat <= nowMs + 60_000 &&
    Number.isSafeInteger(payload.exp) &&
    payload.exp > nowMs &&
    payload.exp - payload.iat <= ACTIVATION_CLAIM_MAX_LIFETIME_MS &&
    typeof payload.nonce === 'string' &&
    payload.nonce.length >= 16 &&
    Number.isSafeInteger(payload.generation) &&
    payload.generation >= 0
    ? payload
    : null;
}

export async function issueProRoomOwnerRecoveryClaim(roomCode, secret, options = {}) {
  if (!isProRoomCode(roomCode)) throw new Error('Unsupported PRO room code');
  if (typeof secret !== 'string' || secret.length < 32)
    throw new Error('Activation secret too short');
  const nowMs = options.nowMs ?? Date.now();
  const expiresAtMs = options.expiresAtMs ?? nowMs + 10 * 60 * 1000;
  if (
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= nowMs ||
    expiresAtMs - nowMs > RECOVERY_CLAIM_MAX_LIFETIME_MS
  ) {
    throw new Error('Invalid expiry');
  }
  const nonce = options.nonce ?? randomToken(18);
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    throw new Error('Invalid nonce');
  }
  return createSignedToken(
    {
      v: 1,
      purpose: 'pro-room-owner-recovery',
      roomCode,
      iat: nowMs,
      exp: expiresAtMs,
      nonce,
    },
    secret,
  );
}

async function verifyOwnerRecoveryClaim(token, roomCode, secret, nowMs) {
  if (typeof secret !== 'string' || secret.length < 32) return null;
  const payload = await verifySignedToken(token, secret);
  if (
    !payload ||
    payload.v !== 1 ||
    payload.purpose !== 'pro-room-owner-recovery' ||
    payload.roomCode !== roomCode ||
    !Number.isSafeInteger(payload.iat) ||
    payload.iat > nowMs + 60_000 ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp <= nowMs ||
    payload.exp - payload.iat > RECOVERY_CLAIM_MAX_LIFETIME_MS ||
    typeof payload.nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(payload.nonce)
  ) {
    return null;
  }
  return payload;
}

async function derivePinHash(pin, salt, pepper, iterations = PBKDF2_ITERATIONS) {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > PBKDF2_MAX_ITERATIONS) {
    throw new RangeError('Invalid PBKDF2 iteration count');
  }
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
  if (
    typeof record.salt !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(record.salt) ||
    typeof record.hash !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(record.hash) ||
    !Number.isSafeInteger(record.iterations) ||
    record.iterations < 1 ||
    record.iterations > PBKDF2_MAX_ITERATIONS
  ) {
    return false;
  }
  try {
    const actual = await derivePinHash(pin, record.salt, pepper, record.iterations);
    return constantTimeEqual(actual, record.hash);
  } catch {
    // Corrupt or runtime-incompatible stored credentials fail closed instead
    // of turning a PIN attempt into a Worker exception.
    return false;
  }
}

async function readJsonBody(request, maxBytes, allowSimpleText = false, allowEmpty = false) {
  const contentType = request.headers.get('content-type') || '';
  const acceptedContentType = allowSimpleText
    ? /^text\/plain(?:\s*;|$)/i.test(contentType)
    : /^application\/json(?:\s*;|$)/i.test(contentType);
  if (!acceptedContentType && !allowEmpty) return { error: 'INVALID_REQUEST' };
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > maxBytes)) {
    return { error: 'REQUEST_TOO_LARGE', status: 413 };
  }
  const declaredLength = declared === null ? null : Number(declared);
  if (!request.body) {
    return allowEmpty && (declaredLength === null || declaredLength === 0)
      ? { empty: true }
      : { error: 'INVALID_REQUEST' };
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
  if (length === 0 && allowEmpty && (declaredLength === null || declaredLength === 0)) {
    return { empty: true };
  }
  if (!acceptedContentType) return { error: 'INVALID_REQUEST' };
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

function sessionCookieName(roomCode) {
  return `__Host-mxqr_pro_session_${roomCode}`;
}

function ownerCookieName(roomCode) {
  return `__Host-mxqr_pro_owner_${roomCode}`;
}

function requestSessionToken(request, roomCode) {
  const authorization = request.headers.get('authorization') || '';
  const bearer = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return bearer ? bearer[1] : cookieValue(request, sessionCookieName(roomCode));
}

function requestOwnerToken(request, roomCode) {
  return cookieValue(request, ownerCookieName(roomCode));
}

function sessionCookie(roomCode, token, maxAgeSeconds) {
  return `${sessionCookieName(roomCode)}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

function ownerCookie(roomCode, token) {
  return `${ownerCookieName(roomCode)}=${token}; Path=/; Max-Age=${OWNER_COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function initialRoomState(roomCode, provisioned = INITIAL_PRO_ROOM_CODES.has(roomCode)) {
  return {
    v: 1,
    roomCode,
    provisioned,
    activationClaimGeneration: 0,
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
      youtubeVideoId: null,
      youtubeSubIndex: null,
    },
    presence: {
      coordinatorEpoch: 0,
      revision: 0,
      coordinatorParticipantId: null,
      participants: {},
    },
    queueMode: initialQueueModeState(),
    systemAudio: initialSystemAudioState(),
    effects: initialEffectsState(),
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
    consumedRecoveryNonces: {},
    stagingTombstones: {},
    developerCommands: {},
    developerCommandIdempotency: {},
  };
}

function initialQueueModeState() {
  return {
    revision: 0,
    updatedAtMs: 0,
    repeatMode: 0,
    shuffleEnabled: false,
    shuffleOrder: [],
  };
}

function parseQueueModeValues(value, playlist, stored = false) {
  const keys = stored
    ? ['revision', 'updatedAtMs', 'repeatMode', 'shuffleEnabled', 'shuffleOrder']
    : ['repeatMode', 'shuffleEnabled', 'shuffleOrder'];
  if (!hasExactKeys(value, keys)) return null;
  if (
    (stored &&
      (!isSafeNonNegativeInteger(value.revision) ||
        !isSafeNonNegativeInteger(value.updatedAtMs))) ||
    (value.repeatMode !== 0 && value.repeatMode !== 1 && value.repeatMode !== 2) ||
    typeof value.shuffleEnabled !== 'boolean' ||
    !Array.isArray(value.shuffleOrder) ||
    value.shuffleOrder.length > PLAYLIST_MAX_ITEMS
  ) {
    return null;
  }
  const liveIds = new Set(playlist.map((item) => item.queueItemId));
  const seen = new Set();
  const shuffleOrder = [];
  for (const queueItemId of value.shuffleOrder) {
    if (
      !QUEUE_ITEM_ID_RE.test(queueItemId || '') ||
      !liveIds.has(queueItemId) ||
      seen.has(queueItemId)
    ) {
      return null;
    }
    seen.add(queueItemId);
    shuffleOrder.push(queueItemId);
  }
  if (
    (!value.shuffleEnabled && shuffleOrder.length !== 0) ||
    (value.shuffleEnabled && shuffleOrder.length !== playlist.length)
  ) {
    return null;
  }
  return {
    ...(stored ? { revision: value.revision, updatedAtMs: value.updatedAtMs } : {}),
    repeatMode: value.repeatMode,
    shuffleEnabled: value.shuffleEnabled,
    shuffleOrder,
  };
}

function normalizeStoredQueueMode(value, playlist) {
  return parseQueueModeValues(value, playlist, true);
}

function publicQueueMode(room) {
  return {
    schemaVersion: 1,
    view: 'queue-mode',
    roomCode: room.roomCode,
    revision: room.queueMode.revision,
    playlistRevision: room.playlistRevision,
    updatedAtMs: room.queueMode.updatedAtMs,
    repeatMode: room.queueMode.repeatMode,
    shuffleEnabled: room.queueMode.shuffleEnabled,
    shuffleOrder: [...room.queueMode.shuffleOrder],
  };
}

function developerQueueMode(room) {
  return {
    schemaVersion: 1,
    view: 'queue-mode',
    roomCode: room.roomCode,
    revision: room.queueMode.revision,
    playlistRevision: room.playlistRevision,
    updatedAtMs: room.queueMode.updatedAtMs,
    repeatMode:
      room.queueMode.repeatMode === 2 ? 'one' : room.queueMode.repeatMode === 1 ? 'all' : 'off',
    shuffleEnabled: room.queueMode.shuffleEnabled,
  };
}

function shuffledQueueItemIds(playlist) {
  const queueItemIds = playlist.map((item) => item.queueItemId);
  const random = new Uint32Array(1);
  for (let index = queueItemIds.length - 1; index > 0; index -= 1) {
    crypto.getRandomValues(random);
    const swapIndex = random[0] % (index + 1);
    [queueItemIds[index], queueItemIds[swapIndex]] = [queueItemIds[swapIndex], queueItemIds[index]];
  }
  return queueItemIds;
}

function reconcileQueueModePlaylist(room, nowMs = Date.now()) {
  const current = room.queueMode;
  const nextOrder = current.shuffleEnabled
    ? [
        ...current.shuffleOrder.filter((queueItemId) =>
          room.playlist.some((item) => item.queueItemId === queueItemId),
        ),
        ...room.playlist
          .map((item) => item.queueItemId)
          .filter((queueItemId) => !current.shuffleOrder.includes(queueItemId)),
      ]
    : [];
  if (
    nextOrder.length === current.shuffleOrder.length &&
    nextOrder.every((queueItemId, index) => queueItemId === current.shuffleOrder[index])
  ) {
    return false;
  }
  if (current.revision >= Number.MAX_SAFE_INTEGER) throw new RoomStateCapacityError();
  room.queueMode = {
    ...current,
    revision: current.revision + 1,
    updatedAtMs: nowMs,
    shuffleOrder: nextOrder,
  };
  return true;
}

function initialEffectsState() {
  return {
    revision: 0,
    updatedAtMs: 0,
    effects: {
      reverb: {
        mixPercent: 0,
        decaySeconds: 5,
        preDelaySeconds: 0.1,
        lowCutPercent: 0,
        highCutPercent: 0,
      },
      equalizer: { bandsDb: [0, 0, 0, 0, 0] },
      virtualBass: { strengthPercent: 0 },
      virtualSurround: { widthPercent: 100 },
    },
  };
}

const EFFECT_REVERB_FIELDS = Object.freeze({
  mixPercent: [0, 100],
  decaySeconds: [0.1, 30],
  preDelaySeconds: [0, 1],
  lowCutPercent: [0, 100],
  highCutPercent: [0, 100],
});

function boundedEffectNumber(value, minimum, maximum) {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

function parseEffectsReverb(value, complete = true) {
  const fields = Object.keys(EFFECT_REVERB_FIELDS);
  if (!hasExactKeys(value, complete ? fields : [], complete ? [] : fields)) return null;
  if (!complete && Object.keys(value).length === 0) return null;
  const result = {};
  for (const key of Object.keys(value)) {
    const [minimum, maximum] = EFFECT_REVERB_FIELDS[key];
    if (!boundedEffectNumber(value[key], minimum, maximum)) return null;
    result[key] = value[key];
  }
  return result;
}

function parseEffectsEqualizer(value) {
  if (
    !hasExactKeys(value, ['bandsDb']) ||
    !Array.isArray(value.bandsDb) ||
    value.bandsDb.length !== 5 ||
    value.bandsDb.some((band) => !boundedEffectNumber(band, -12, 12))
  ) {
    return null;
  }
  return { bandsDb: [...value.bandsDb] };
}

function parseEffectsVirtualBass(value) {
  return hasExactKeys(value, ['strengthPercent']) &&
    boundedEffectNumber(value.strengthPercent, 0, 100)
    ? { strengthPercent: value.strengthPercent }
    : null;
}

function parseEffectsVirtualSurround(value) {
  return hasExactKeys(value, ['widthPercent']) && boundedEffectNumber(value.widthPercent, 0, 200)
    ? { widthPercent: value.widthPercent }
    : null;
}

function parseRoomEffects(value) {
  if (!hasExactKeys(value, ['reverb', 'equalizer', 'virtualBass', 'virtualSurround'])) return null;
  const reverb = parseEffectsReverb(value.reverb);
  const equalizer = parseEffectsEqualizer(value.equalizer);
  const virtualBass = parseEffectsVirtualBass(value.virtualBass);
  const virtualSurround = parseEffectsVirtualSurround(value.virtualSurround);
  return reverb && equalizer && virtualBass && virtualSurround
    ? { reverb, equalizer, virtualBass, virtualSurround }
    : null;
}

function parseRoomEffectsPatch(value) {
  const allowed = ['reverb', 'equalizer', 'virtualBass', 'virtualSurround'];
  if (!hasExactKeys(value, [], allowed) || Object.keys(value).length === 0) return null;
  const result = {};
  for (const key of Object.keys(value)) {
    const parsed =
      key === 'reverb'
        ? parseEffectsReverb(value.reverb, false)
        : key === 'equalizer'
          ? parseEffectsEqualizer(value.equalizer)
          : key === 'virtualBass'
            ? parseEffectsVirtualBass(value.virtualBass)
            : parseEffectsVirtualSurround(value.virtualSurround);
    if (!parsed) return null;
    result[key] = parsed;
  }
  return result;
}

function mergeRoomEffectsPatch(current, patch) {
  return {
    reverb: { ...current.reverb, ...(patch.reverb || {}) },
    equalizer: patch.equalizer
      ? { bandsDb: [...patch.equalizer.bandsDb] }
      : { bandsDb: [...current.equalizer.bandsDb] },
    virtualBass: { ...(patch.virtualBass || current.virtualBass) },
    virtualSurround: { ...(patch.virtualSurround || current.virtualSurround) },
  };
}

function normalizeStoredEffects(value) {
  if (
    !hasExactKeys(value, ['revision', 'updatedAtMs', 'effects']) ||
    !isSafeNonNegativeInteger(value.revision) ||
    !isSafeNonNegativeInteger(value.updatedAtMs)
  ) {
    return null;
  }
  const effects = parseRoomEffects(value.effects);
  return effects ? { revision: value.revision, updatedAtMs: value.updatedAtMs, effects } : null;
}

function publicEffects(room) {
  return {
    schemaVersion: 1,
    view: 'effects',
    roomCode: room.roomCode,
    revision: room.effects.revision,
    updatedAtMs: room.effects.updatedAtMs,
    effects: structuredClone(room.effects.effects),
  };
}

function initialSystemAudioState(generation = 0) {
  return {
    generation,
    status: 'idle',
    ownerParticipantId: null,
    ownerPresenceIncarnationId: null,
    leaseId: null,
    claimExpiresAt: null,
    liveExpiresAt: null,
    publication: null,
  };
}

function publicSystemAudio(state) {
  return {
    generation: state.generation,
    status: state.status,
    ownerParticipantId: state.ownerParticipantId,
    claimExpiresAt: state.claimExpiresAt,
    liveExpiresAt: state.liveExpiresAt,
    publication: state.publication ? structuredClone(state.publication) : null,
  };
}

function parseSystemAudioPublication(value) {
  if (!hasExactKeys(value, ['publicationId', 'sessionId', 'tracks'])) return null;
  if (!OPAQUE_ID_RE.test(value.publicationId) || !OPAQUE_ID_RE.test(value.sessionId)) return null;
  if (!Array.isArray(value.tracks) || value.tracks.length !== 2) return null;
  const channels = new Set();
  const trackNames = new Set();
  const mids = new Set();
  const tracks = [];
  for (const rawTrack of value.tracks) {
    if (!hasExactKeys(rawTrack, ['trackName', 'channel'], ['mid'])) return null;
    const trackName = boundedString(rawTrack.trackName, SYSTEM_AUDIO_TRACK_NAME_MAX_LENGTH);
    if (
      !trackName ||
      (rawTrack.channel !== 'L' && rawTrack.channel !== 'R') ||
      channels.has(rawTrack.channel) ||
      trackNames.has(trackName)
    ) {
      return null;
    }
    const mid =
      rawTrack.mid === undefined
        ? undefined
        : boundedString(rawTrack.mid, SYSTEM_AUDIO_TRACK_MID_MAX_LENGTH);
    if (rawTrack.mid !== undefined && (!mid || mids.has(mid))) return null;
    channels.add(rawTrack.channel);
    trackNames.add(trackName);
    if (mid) mids.add(mid);
    tracks.push({
      trackName,
      channel: rawTrack.channel,
      ...(mid === undefined ? {} : { mid }),
    });
  }
  if (!channels.has('L') || !channels.has('R')) return null;
  return {
    publicationId: value.publicationId,
    sessionId: value.sessionId,
    tracks,
  };
}

function normalizeStoredSystemAudio(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !hasExactKeys(value, [
      'generation',
      'status',
      'ownerParticipantId',
      'ownerPresenceIncarnationId',
      'leaseId',
      'claimExpiresAt',
      'liveExpiresAt',
      'publication',
    ]) ||
    !isSafeNonNegativeInteger(value.generation)
  ) {
    return null;
  }
  if (value.status === 'idle') {
    return value.ownerParticipantId === null &&
      value.ownerPresenceIncarnationId === null &&
      value.leaseId === null &&
      value.claimExpiresAt === null &&
      value.liveExpiresAt === null &&
      value.publication === null
      ? initialSystemAudioState(value.generation)
      : null;
  }
  if (
    value.generation === 0 ||
    !OPAQUE_ID_RE.test(value.ownerParticipantId || '') ||
    !OPAQUE_ID_RE.test(value.ownerPresenceIncarnationId || '') ||
    !SYSTEM_AUDIO_LEASE_ID_RE.test(value.leaseId || '')
  ) {
    return null;
  }
  if (value.status === 'preparing') {
    if (
      !Number.isSafeInteger(value.claimExpiresAt) ||
      value.claimExpiresAt <= 0 ||
      value.liveExpiresAt !== null ||
      value.publication !== null
    ) {
      return null;
    }
    return {
      generation: value.generation,
      status: 'preparing',
      ownerParticipantId: value.ownerParticipantId,
      ownerPresenceIncarnationId: value.ownerPresenceIncarnationId,
      leaseId: value.leaseId,
      claimExpiresAt: value.claimExpiresAt,
      liveExpiresAt: null,
      publication: null,
    };
  }
  const publication = parseSystemAudioPublication(value.publication);
  if (
    value.status !== 'live' ||
    value.claimExpiresAt !== null ||
    !Number.isSafeInteger(value.liveExpiresAt) ||
    value.liveExpiresAt <= 0 ||
    !publication
  ) {
    return null;
  }
  return {
    generation: value.generation,
    status: 'live',
    ownerParticipantId: value.ownerParticipantId,
    ownerPresenceIncarnationId: value.ownerPresenceIncarnationId,
    leaseId: value.leaseId,
    claimExpiresAt: null,
    liveExpiresAt: value.liveExpiresAt,
    publication,
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

function publicPlaylistItem(item) {
  const source =
    item.source.kind === 'youtube'
      ? {
          kind: 'youtube',
          videoId: item.source.videoId,
          ...(item.source.playlistId === undefined ? {} : { playlistId: item.source.playlistId }),
        }
      : {
          kind: 'pro-r2',
          assetId: item.source.assetId,
          version: item.source.version,
          byteLength: item.source.byteLength,
          mime: item.source.mime,
          ...(item.source.sha256 === undefined ? {} : { sha256: item.source.sha256 }),
        };
  return {
    queueItemId: item.queueItemId,
    name: item.name,
    ...(item.title === undefined ? {} : { title: item.title }),
    ...(item.artist === undefined ? {} : { artist: item.artist }),
    ...(item.thumbnail === undefined ? {} : { thumbnail: item.thumbnail }),
    source,
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
        presenceIncarnationId: participant?.presenceIncarnationId || session.presenceIncarnationId,
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
    // Developer ownership is private server state. Keeping the public v1
    // playlist exact lets cached clients round-trip snapshots without learning
    // or being able to forge API-key attribution.
    playlist: room.playlist.map(publicPlaylistItem),
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

function developerQueueItem(item, requesterKeyId) {
  const developerText = (value) => {
    if (typeof value !== 'string' || value.length <= 512) return value;
    const truncated = value.slice(0, 512);
    return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated;
  };
  const addedBy = DEVELOPER_API_KEY_ID_RE.test(requesterKeyId || '')
    ? DEVELOPER_API_KEY_ID_RE.test(item.developerOwnerKeyId || '') &&
      item.developerOwnerKeyId === requesterKeyId
      ? 'current_api_key'
      : DEVELOPER_API_KEY_ID_RE.test(item.developerOwnerKeyId || '')
        ? 'another_api_key'
        : 'participant'
    : null;
  const metadata = {
    queueItemId: item.queueItemId,
    kind: item.source.kind === 'youtube' ? 'youtube' : 'audio',
    name: developerText(item.name),
    ...(addedBy === null ? {} : { addedBy }),
    ...(item.title === undefined ? {} : { title: developerText(item.title) }),
    ...(item.artist === undefined ? {} : { artist: developerText(item.artist) }),
    ...(item.thumbnail === undefined ? {} : { thumbnail: item.thumbnail }),
  };
  return item.source.kind === 'pro-r2'
    ? { ...metadata, byteLength: item.source.byteLength }
    : metadata;
}

function developerProjection(room, projection, nowMs, requesterKeyId) {
  if (projection === 'room') {
    const coordinator = room.presence.coordinatorParticipantId
      ? room.presence.participants[room.presence.coordinatorParticipantId]
      : null;
    return {
      schemaVersion: 1,
      view: 'room',
      roomCode: room.roomCode,
      status: room.status,
      runtime: room.runtime,
      revision: room.revision,
      participantCount: Object.keys(room.presence.participants).length,
      controlAvailable:
        room.runtime === 'awake' &&
        room.status === 'active' &&
        supportsDeveloperControl(coordinator),
      quota: { ...room.quota },
    };
  }
  const playlistById = new Map(room.playlist.map((item) => [item.queueItemId, item]));
  if (projection === 'playback') {
    const item = room.playback.queueItemId
      ? playlistById.get(room.playback.queueItemId) || null
      : null;
    if ((item === null) !== (room.playback.queueItemId === null)) return null;
    let positionSeconds = room.playback.positionSeconds;
    if (
      room.runtime === 'awake' &&
      room.playback.state === 'playing' &&
      room.playback.updatedAtMs > 0 &&
      nowMs > room.playback.updatedAtMs
    ) {
      positionSeconds = Math.min(
        PLAYBACK_MAX_POSITION_SECONDS,
        positionSeconds + (nowMs - room.playback.updatedAtMs) / 1_000,
      );
    }
    return {
      schemaVersion: 1,
      view: 'playback',
      roomCode: room.roomCode,
      revision: room.playback.revision,
      playlistRevision: room.playlistRevision,
      state: room.playback.state,
      queueItemId: room.playback.queueItemId,
      positionSeconds,
      observedAtMs: nowMs,
      item: item ? developerQueueItem(item, requesterKeyId) : null,
    };
  }
  if (projection === 'queue') {
    return {
      schemaVersion: 1,
      view: 'queue',
      roomCode: room.roomCode,
      playlistRevision: room.playlistRevision,
      currentQueueItemId: room.currentQueueItemId,
      items: room.playlist.map((item) => developerQueueItem(item, requesterKeyId)),
    };
  }
  if (projection === 'effects') return publicEffects(room);
  if (projection === 'queue-mode') return developerQueueMode(room);
  return null;
}

function parseDeveloperCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type === 'play' || value.type === 'pause' || value.type === 'next') {
    return hasExactKeys(value, ['type']) ? { type: value.type } : null;
  }
  if (value.type === 'seek') {
    return hasExactKeys(value, ['type', 'positionSeconds']) &&
      Number.isFinite(value.positionSeconds) &&
      value.positionSeconds >= 0 &&
      value.positionSeconds <= PLAYBACK_MAX_POSITION_SECONDS
      ? { type: 'seek', positionSeconds: value.positionSeconds }
      : null;
  }
  if (value.type === 'play_item') {
    return hasExactKeys(value, ['type', 'queueItemId']) &&
      QUEUE_ITEM_ID_RE.test(value.queueItemId || '')
      ? { type: 'play_item', queueItemId: value.queueItemId }
      : null;
  }
  if (value.type === 'set_effects') {
    const effects = hasExactKeys(value, ['type', 'effects'])
      ? parseRoomEffectsPatch(value.effects)
      : null;
    return effects ? { type: 'set_effects', effects } : null;
  }
  return null;
}

function requiredDeveloperControlVersion(command) {
  if (command?.type === 'next') return DEVELOPER_NEXT_CONTROL_VERSION;
  if (command?.type === 'set_effects') return DEVELOPER_EFFECTS_CONTROL_VERSION;
  return DEVELOPER_CONTROL_VERSION;
}

function supportsDeveloperControl(participant, requiredVersion = DEVELOPER_CONTROL_VERSION) {
  return (
    Number.isSafeInteger(participant?.developerControlVersion) &&
    participant.developerControlVersion >= requiredVersion &&
    participant.developerControlVersion <= DEVELOPER_CONTROL_MAX_VERSION
  );
}

function randomQueueItemId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function parseDeveloperMetadata(value, requiredName = true) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = requiredName ? boundedString(value.name, 512) : undefined;
  if (requiredName && !name) return null;
  const metadata = requiredName ? { name } : {};
  for (const key of ['title', 'artist', 'thumbnail']) {
    if (value[key] === undefined) continue;
    const parsed = boundedString(value[key], 512);
    if (!parsed) return null;
    metadata[key] = parsed;
  }
  return metadata;
}

function canonicalizeDeveloperYouTubeBatchItems(items) {
  const seenPlaylistIds = new Set();
  return items.filter((item) => {
    if (item.playlistId === undefined) return true;
    if (seenPlaylistIds.has(item.playlistId)) return false;
    seenPlaylistIds.add(item.playlistId);
    return true;
  });
}

function parseDeveloperQueueMutation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type === 'add_youtube') {
    if (
      !hasExactKeys(
        value,
        ['type', 'videoId', 'name'],
        ['playlistId', 'title', 'artist', 'thumbnail'],
      ) ||
      !YOUTUBE_VIDEO_ID_RE.test(value.videoId || '') ||
      (value.playlistId !== undefined && !YOUTUBE_PLAYLIST_ID_RE.test(value.playlistId || ''))
    ) {
      return null;
    }
    const metadata = parseDeveloperMetadata(value);
    if (!metadata) return null;
    return {
      type: 'add_youtube',
      videoId: value.videoId,
      ...(value.playlistId === undefined ? {} : { playlistId: value.playlistId }),
      ...metadata,
    };
  }
  if (value.type === 'add_youtube_batch') {
    if (
      !hasExactKeys(value, ['type', 'items']) ||
      !Array.isArray(value.items) ||
      value.items.length === 0 ||
      value.items.length > DEVELOPER_YOUTUBE_BATCH_MAX_ITEMS
    ) {
      return null;
    }
    const items = value.items.map((item) => {
      if (
        !hasExactKeys(item, ['videoId', 'name'], ['playlistId', 'title', 'artist', 'thumbnail']) ||
        !YOUTUBE_VIDEO_ID_RE.test(item.videoId || '') ||
        (item.playlistId !== undefined && !YOUTUBE_PLAYLIST_ID_RE.test(item.playlistId || ''))
      ) {
        return null;
      }
      const metadata = parseDeveloperMetadata(item);
      return metadata
        ? {
            videoId: item.videoId,
            ...(item.playlistId === undefined ? {} : { playlistId: item.playlistId }),
            ...metadata,
          }
        : null;
    });
    return items.some((item) => item === null)
      ? null
      : {
          type: 'add_youtube_batch',
          items: canonicalizeDeveloperYouTubeBatchItems(items),
        };
  }
  if (value.type === 'remove') {
    return hasExactKeys(value, ['type', 'queueItemId']) &&
      QUEUE_ITEM_ID_RE.test(value.queueItemId || '')
      ? { type: 'remove', queueItemId: value.queueItemId }
      : null;
  }
  if (value.type === 'clear') {
    return hasExactKeys(value, ['type']) ? { type: 'clear' } : null;
  }
  if (value.type === 'clear_owned') {
    return hasExactKeys(value, ['type']) ? { type: 'clear_owned' } : null;
  }
  if (value.type === 'reorder') {
    if (
      !hasExactKeys(value, ['type', 'basePlaylistRevision', 'queueItemIds']) ||
      !isSafeNonNegativeInteger(value.basePlaylistRevision) ||
      !Array.isArray(value.queueItemIds) ||
      value.queueItemIds.length > PLAYLIST_MAX_ITEMS ||
      value.queueItemIds.some((queueItemId) => !QUEUE_ITEM_ID_RE.test(queueItemId || '')) ||
      new Set(value.queueItemIds).size !== value.queueItemIds.length
    ) {
      return null;
    }
    return {
      type: 'reorder',
      basePlaylistRevision: value.basePlaylistRevision,
      queueItemIds: [...value.queueItemIds],
    };
  }
  return null;
}

function parseBotPlan(value) {
  if (
    !hasExactKeys(
      value,
      ['intent'],
      [
        'trackQueries',
        'playAddedIndex',
        'queueItemId',
        'playbackCommand',
        'repeatMode',
        'shuffleEnabled',
        'answer',
      ],
    ) ||
    !['add_youtube', 'play_existing', 'playback', 'queue_mode', 'answer'].includes(value.intent)
  ) {
    return null;
  }
  const answer = value.answer === undefined ? undefined : boundedString(value.answer, 240, true);
  if (value.answer !== undefined && answer === null) return null;
  if (value.intent === 'add_youtube') {
    if (
      !Array.isArray(value.trackQueries) ||
      value.trackQueries.length < 1 ||
      value.trackQueries.length > BOT_MAX_TRACK_ITEMS ||
      value.trackQueries.some((query) => boundedString(query, 160) === null)
    ) {
      return null;
    }
    const playAddedIndex = value.playAddedIndex === undefined ? -1 : value.playAddedIndex;
    if (
      !Number.isSafeInteger(playAddedIndex) ||
      playAddedIndex < -1 ||
      playAddedIndex >= value.trackQueries.length
    ) {
      return null;
    }
    return {
      intent: value.intent,
      trackQueries: value.trackQueries.map((query) => boundedString(query, 160)),
      playAddedIndex,
      ...(answer ? { answer } : {}),
    };
  }
  if (value.intent === 'play_existing') {
    return QUEUE_ITEM_ID_RE.test(value.queueItemId || '')
      ? { intent: value.intent, queueItemId: value.queueItemId, ...(answer ? { answer } : {}) }
      : null;
  }
  if (value.intent === 'playback') {
    return ['play', 'pause', 'next'].includes(value.playbackCommand)
      ? {
          intent: value.intent,
          playbackCommand: value.playbackCommand,
          ...(answer ? { answer } : {}),
        }
      : null;
  }
  if (value.intent === 'queue_mode') {
    if (
      (value.repeatMode === undefined && value.shuffleEnabled === undefined) ||
      (value.repeatMode !== undefined && !['off', 'all', 'one'].includes(value.repeatMode)) ||
      (value.shuffleEnabled !== undefined && typeof value.shuffleEnabled !== 'boolean')
    ) {
      return null;
    }
    return {
      intent: value.intent,
      ...(value.repeatMode === undefined ? {} : { repeatMode: value.repeatMode }),
      ...(value.shuffleEnabled === undefined ? {} : { shuffleEnabled: value.shuffleEnabled }),
      ...(answer ? { answer } : {}),
    };
  }
  return answer ? { intent: value.intent, answer } : null;
}

function parseBotTracks(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > BOT_MAX_TRACK_ITEMS) return null;
  const mutation = parseDeveloperQueueMutation({ type: 'add_youtube_batch', items: value });
  return mutation?.type === 'add_youtube_batch' && mutation.items.length === value.length
    ? mutation.items
    : null;
}

function isDeveloperAudioCandidate(name, mime) {
  if (typeof name !== 'string' || typeof mime !== 'string') return false;
  if (/^audio\//i.test(mime) || mime.toLowerCase() === 'application/ogg') return true;
  if (mime.toLowerCase() !== 'application/octet-stream') return false;
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  return DEVELOPER_AUDIO_EXTENSIONS.has(extension);
}

function parseDeveloperMediaUpload(value) {
  if (
    !hasExactKeys(
      value,
      ['name', 'byteLength', 'mime'],
      ['sha256', 'title', 'artist', 'thumbnail'],
    ) ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    value.byteLength > ASSET_MAX_BYTES ||
    typeof value.mime !== 'string' ||
    !MIME_RE.test(value.mime) ||
    (value.sha256 !== undefined && !SHA256_RE.test(value.sha256 || ''))
  ) {
    return null;
  }
  const metadata = parseDeveloperMetadata(value);
  if (!metadata || !isDeveloperAudioCandidate(metadata.name, value.mime)) return null;
  return {
    ...metadata,
    byteLength: value.byteLength,
    mime: value.mime,
    ...(value.sha256 === undefined ? {} : { sha256: value.sha256 }),
  };
}

function publicDeveloperCommand(record) {
  return {
    schemaVersion: 1,
    roomCode: record.roomCode,
    commandId: record.commandId,
    status: record.status,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
    ...(Number.isSafeInteger(record.completedAtMs) ? { completedAtMs: record.completedAtMs } : {}),
    ...(typeof record.resultCode === 'string' ? { resultCode: record.resultCode } : {}),
  };
}

async function fetchWithDeadline(fetcher, request, timeoutMs) {
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error('DEVELOPER_COMMAND_DISPATCH_TIMEOUT'));
    }, timeoutMs);
  });
  try {
    const boundedRequest = new Request(request, { signal: controller.signal });
    return await Promise.race([fetcher(boundedRequest), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
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

function playbackSemanticallyEqual(left, right) {
  return (
    left.coordinatorEpoch === right.coordinatorEpoch &&
    left.state === right.state &&
    left.queueItemId === right.queueItemId &&
    left.positionSeconds === right.positionSeconds &&
    left.youtubeVideoId === right.youtubeVideoId &&
    left.youtubeSubIndex === right.youtubeSubIndex
  );
}

function parsePlaybackCandidate(value, playlistById, currentQueueItemId, coordinatorEpoch) {
  if (
    !hasExactKeys(value, [
      'coordinatorEpoch',
      'revision',
      'state',
      'queueItemId',
      'positionSeconds',
      'updatedAtMs',
      'youtubeVideoId',
      'youtubeSubIndex',
    ]) ||
    value.coordinatorEpoch !== coordinatorEpoch ||
    !isSafeNonNegativeInteger(value.revision) ||
    typeof value.positionSeconds !== 'number' ||
    !Number.isFinite(value.positionSeconds) ||
    value.positionSeconds < 0 ||
    value.positionSeconds > PLAYBACK_MAX_POSITION_SECONDS ||
    !isSafeNonNegativeInteger(value.updatedAtMs)
  ) {
    return null;
  }
  if (value.state === 'idle') {
    if (
      value.queueItemId !== null ||
      currentQueueItemId !== null ||
      value.positionSeconds !== 0 ||
      value.youtubeVideoId !== null ||
      value.youtubeSubIndex !== null
    )
      return null;
  } else {
    const currentItem = playlistById.get(value.queueItemId);
    if (
      (value.state !== 'playing' && value.state !== 'paused') ||
      !QUEUE_ITEM_ID_RE.test(value.queueItemId) ||
      value.queueItemId !== currentQueueItemId ||
      !currentItem
    ) {
      return null;
    }
    if (currentItem.source.kind === 'youtube') {
      if (
        !YOUTUBE_VIDEO_ID_RE.test(value.youtubeVideoId) ||
        !isSafeNonNegativeInteger(value.youtubeSubIndex) ||
        value.youtubeSubIndex > 100_000
      ) {
        return null;
      }
    } else if (value.youtubeVideoId !== null || value.youtubeSubIndex !== null) {
      return null;
    }
  }
  return structuredClone(value);
}

function parsePlayback(
  value,
  playlistById,
  currentQueueItemId,
  coordinatorEpoch,
  currentPlayback,
  nowMs,
) {
  const parsed = parsePlaybackCandidate(value, playlistById, currentQueueItemId, coordinatorEpoch);
  if (!parsed) return null;
  const unchanged = playbackSemanticallyEqual(parsed, currentPlayback);
  const expectedRevision = currentPlayback.revision + (unchanged ? 0 : 1);
  if (!Number.isSafeInteger(expectedRevision) || parsed.revision !== expectedRevision) return null;
  if (unchanged) return structuredClone(currentPlayback);
  if (Math.abs(parsed.updatedAtMs - nowMs) > PLAYBACK_CLOCK_SKEW_MS) return null;
  parsed.revision = expectedRevision;
  // Persist a server clock checkpoint after accepting a reasonably fresh
  // client observation. This prevents a forged far-future timestamp from
  // accelerating a sleeping room's resume position.
  parsed.updatedAtMs = nowMs;
  return parsed;
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

class RoomStateCapacityError extends Error {
  constructor() {
    super('PRO room state exceeds its bounded storage budget');
    this.name = 'RoomStateCapacityError';
  }
}

function serializedStateByteLength(room) {
  return encoder.encode(JSON.stringify(room)).byteLength;
}

function playlistStorageKey(queueItemId) {
  return `${STORAGE_V2_PLAYLIST_PREFIX}${queueItemId}`;
}

function playlistItemSignature(item) {
  return JSON.stringify(item);
}

function parseStoredPlaylistItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { developerOwnerKeyId, ...publicValue } = value;
  const parsed = parsePlaylistItem(publicValue);
  if (!parsed) return null;
  if (developerOwnerKeyId === undefined) return parsed;
  return DEVELOPER_API_KEY_ID_RE.test(developerOwnerKeyId)
    ? { ...parsed, developerOwnerKeyId }
    : null;
}

function splitPersistentRoomState(room) {
  const { playlist: _playlist, ...core } = room;
  return {
    schemaVersion: STORAGE_V2_SCHEMA_VERSION,
    core,
    playlistOrder: room.playlist.map((item) => item.queueItemId),
  };
}

function serializedCoreStateByteLength(room) {
  return encoder.encode(JSON.stringify(splitPersistentRoomState(room))).byteLength;
}

function serializedPlaylistStateByteLength(room) {
  return encoder.encode(JSON.stringify(room.playlist)).byteLength;
}

function validStoredV2Core(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.schemaVersion !== STORAGE_V2_SCHEMA_VERSION ||
    !value.core ||
    typeof value.core !== 'object' ||
    Array.isArray(value.core) ||
    !Array.isArray(value.playlistOrder) ||
    value.playlistOrder.length > PLAYLIST_MAX_ITEMS
  ) {
    return false;
  }
  const ids = new Set();
  for (const queueItemId of value.playlistOrder) {
    if (!QUEUE_ITEM_ID_RE.test(queueItemId || '') || ids.has(queueItemId)) return false;
    ids.add(queueItemId);
  }
  return true;
}

async function putStorageEntries(storage, entries) {
  for (let offset = 0; offset < entries.length; offset += 128) {
    const batch = Object.fromEntries(entries.slice(offset, offset + 128));
    if (Object.keys(batch).length > 0) await storage.put(batch);
  }
}

async function getStorageEntries(storage, keys) {
  const values = new Map();
  for (let offset = 0; offset < keys.length; offset += 128) {
    const batch = keys.slice(offset, offset + 128);
    if (batch.length === 0) continue;
    if (batch.length === 1) {
      values.set(batch[0], await storage.get(batch[0]));
      continue;
    }
    const loaded = await storage.get(batch);
    if (!(loaded instanceof Map)) throw new Error('PRO_ROOM_PERSISTENCE_V2_BATCH_INVALID');
    for (const key of batch) values.set(key, loaded.get(key));
  }
  return values;
}

async function deleteStorageKeys(storage, keys) {
  for (let offset = 0; offset < keys.length; offset += 128) {
    const batch = keys.slice(offset, offset + 128);
    if (batch.length > 0) await storage.delete(batch);
  }
}

function assertBoundedRoomState(room) {
  if (
    Object.keys(room.presence.participants).length > PRESENCE_MAX_ITEMS ||
    Object.keys(room.sessions).length > SESSION_MAX_ITEMS ||
    Object.keys(room.assets).length > ASSET_MAX_ITEMS ||
    Object.keys(room.assets).length + Object.keys(room.stagingTombstones || {}).length >
      ASSET_MAX_ITEMS ||
    Object.keys(room.idempotency).length > IDEMPOTENCY_MAX_ITEMS ||
    Object.keys(room.rateLimits).length > RATE_LIMIT_MAX_ITEMS ||
    Object.keys(room.consumedRecoveryNonces || {}).length > RECOVERY_NONCE_MAX_ITEMS ||
    Object.keys(room.stagingTombstones || {}).length > STAGING_TOMBSTONE_MAX_ITEMS ||
    Object.keys(room.developerCommands || {}).length > DEVELOPER_COMMAND_MAX_ITEMS ||
    Object.keys(room.developerCommandIdempotency || {}).length >
      DEVELOPER_COMMAND_IDEMPOTENCY_MAX_ITEMS ||
    serializedCoreStateByteLength(room) > STATE_MAX_BYTES ||
    serializedPlaylistStateByteLength(room) > PLAYLIST_STATE_MAX_BYTES ||
    room.playlist.some(
      (item) => encoder.encode(playlistItemSignature(item)).byteLength > PLAYLIST_ITEM_MAX_BYTES,
    )
  ) {
    throw new RoomStateCapacityError();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      const workerVersionId = env?.CF_VERSION_METADATA?.id;
      return jsonResponse({
        ok: true,
        service: 'musixquare-pro-room',
        ...(typeof workerVersionId === 'string' && workerVersionId ? { workerVersionId } : {}),
      });
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
    if (!match || !isProRoomCode(match[1])) {
      return withPublicHeaders(errorResponse('ROOM_NOT_FOUND', 404), origin);
    }
    if (url.pathname.startsWith(`/v1/rooms/${match[1]}/internal/`)) {
      return withPublicHeaders(errorResponse('ROOM_NOT_FOUND', 404), origin);
    }
    if (!(await isFrontProvisionedRoom(match[1], env))) {
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
    this.systemAudioMigrationPending = false;
    this.effectsMigrationPending = false;
    this.queueModeMigrationPending = false;
    this.developerCommandMigrationPending = false;
    this.persistedPlaylistSignatures = new Map();
    this.hasV2Persistence = false;
    const load = async () => {
      await this.loadRoomFromStorage();
      this.normalizeLoadedSystemAudio();
      this.normalizeLoadedEffects();
      this.normalizeLoadedQueueMode();
      this.normalizeLoadedDeveloperCommands();
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
    if (!isProRoomCode(roomCode)) return false;
    if (!this.room) this.room = initialRoomState(roomCode);
    if (!Object.prototype.hasOwnProperty.call(this.room, 'provisioned')) {
      // v1 launch rooms predate the dynamic registry. No other room could have
      // persisted state before this field existed.
      this.room.provisioned = INITIAL_PRO_ROOM_CODES.has(roomCode);
    }
    if (!Number.isSafeInteger(this.room.activationClaimGeneration)) {
      this.room.activationClaimGeneration = 0;
    }
    if (!this.room.consumedRecoveryNonces) this.room.consumedRecoveryNonces = {};
    if (!this.room.stagingTombstones) this.room.stagingTombstones = {};
    this.normalizeLoadedSystemAudio();
    this.normalizeLoadedEffects();
    this.normalizeLoadedQueueMode();
    this.normalizeLoadedDeveloperCommands();
    if (!Object.prototype.hasOwnProperty.call(this.room.playback, 'youtubeVideoId')) {
      this.room.playback.youtubeVideoId = null;
      this.room.playback.youtubeSubIndex = null;
    }
    for (const session of Object.values(this.room.sessions)) {
      if (!Number.isSafeInteger(session.signalingTicketSequence)) {
        session.signalingTicketSequence = 0;
      }
    }
    return this.room.roomCode === roomCode;
  }

  normalizeLoadedSystemAudio() {
    if (!this.room) return;
    const normalizedSystemAudio = normalizeStoredSystemAudio(this.room.systemAudio);
    if (normalizedSystemAudio) {
      this.room.systemAudio = normalizedSystemAudio;
    } else {
      const storedGeneration = isSafeNonNegativeInteger(this.room.systemAudio?.generation)
        ? this.room.systemAudio.generation
        : 0;
      const mustFenceMalformedLease =
        this.room.systemAudio && this.room.systemAudio.status !== 'idle';
      this.room.systemAudio = initialSystemAudioState(
        mustFenceMalformedLease && storedGeneration < Number.MAX_SAFE_INTEGER
          ? storedGeneration + 1
          : storedGeneration,
      );
      this.systemAudioMigrationPending = true;
    }
  }

  normalizeLoadedEffects() {
    if (!this.room) return;
    const normalized = normalizeStoredEffects(this.room.effects);
    if (normalized) {
      this.room.effects = normalized;
      return;
    }
    // Effects predate this dedicated resource. An old room starts from the
    // same neutral DSP state as a fresh client, without changing snapshot v1.
    this.room.effects = initialEffectsState();
    this.effectsMigrationPending = true;
  }

  normalizeLoadedQueueMode() {
    if (!this.room) return;
    const normalized = normalizeStoredQueueMode(this.room.queueMode, this.room.playlist || []);
    if (normalized) {
      this.room.queueMode = normalized;
      return;
    }
    // Queue behavior predates this rolling-deploy-safe resource. Preserve the
    // old product default until a coordinator explicitly changes it.
    this.room.queueMode = initialQueueModeState();
    this.queueModeMigrationPending = true;
  }

  normalizeLoadedDeveloperCommands() {
    if (!this.room) return;
    if (
      !this.room.developerCommands ||
      typeof this.room.developerCommands !== 'object' ||
      Array.isArray(this.room.developerCommands)
    ) {
      this.room.developerCommands = {};
      this.developerCommandMigrationPending = true;
    }
    if (
      !this.room.developerCommandIdempotency ||
      typeof this.room.developerCommandIdempotency !== 'object' ||
      Array.isArray(this.room.developerCommandIdempotency)
    ) {
      this.room.developerCommandIdempotency = {};
      this.developerCommandMigrationPending = true;
    }
    for (const participant of Object.values(this.room.presence?.participants || {})) {
      if (
        !Number.isSafeInteger(participant.developerControlVersion) ||
        participant.developerControlVersion < 0 ||
        participant.developerControlVersion > DEVELOPER_CONTROL_MAX_VERSION
      ) {
        participant.developerControlVersion = 0;
        this.developerCommandMigrationPending = true;
      }
    }
    for (const record of Object.values(this.room.developerCommands)) {
      const requiredVersion = requiredDeveloperControlVersion(record?.command);
      if (record?.developerControlVersion !== requiredVersion) {
        record.developerControlVersion = requiredVersion;
        this.developerCommandMigrationPending = true;
      }
    }
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

  async withStateCapacityRollback(callback) {
    const rollbackRoom = structuredClone(this.room);
    try {
      return await callback();
    } catch (error) {
      if (!(error instanceof RoomStateCapacityError)) throw error;
      this.room = rollbackRoom;
      await this.persist();
      return errorResponse('ROOM_STATE_CAPACITY_EXCEEDED', 409);
    }
  }

  async loadRoomFromStorage() {
    const storedV2 = await this.storage.get(STORAGE_V2_CORE_KEY);
    if (storedV2 !== undefined && storedV2 !== null) {
      if (!validStoredV2Core(storedV2)) {
        throw new Error('PRO_ROOM_PERSISTENCE_V2_CORE_INVALID');
      }
      const playlistKeys = storedV2.playlistOrder.map(playlistStorageKey);
      const storedPlaylist = await getStorageEntries(this.storage, playlistKeys);
      const playlist = [];
      for (const queueItemId of storedV2.playlistOrder) {
        const item = parseStoredPlaylistItem(storedPlaylist.get(playlistStorageKey(queueItemId)));
        if (!item || item.queueItemId !== queueItemId) {
          throw new Error('PRO_ROOM_PERSISTENCE_V2_PLAYLIST_INVALID');
        }
        playlist.push(item);
      }
      const room = { ...storedV2.core, playlist };
      assertBoundedRoomState(room);
      this.room = room;
      this.persistedPlaylistSignatures = new Map(
        playlist.map((item) => [item.queueItemId, playlistItemSignature(item)]),
      );
      this.hasV2Persistence = true;
      return;
    }

    this.room = (await this.storage.get(STORAGE_KEY)) || null;
    this.persistedPlaylistSignatures = new Map();
    this.hasV2Persistence = false;
  }

  async persist() {
    assertBoundedRoomState(this.room);
    const storedCore = splitPersistentRoomState(this.room);
    const nextSignatures = new Map(
      this.room.playlist.map((item) => [item.queueItemId, playlistItemSignature(item)]),
    );
    const changedEntries = this.room.playlist
      .filter(
        (item) =>
          !this.hasV2Persistence ||
          this.persistedPlaylistSignatures.get(item.queueItemId) !==
            nextSignatures.get(item.queueItemId),
      )
      .map((item) => [playlistStorageKey(item.queueItemId), item]);
    const removedKeys = [...this.persistedPlaylistSignatures.keys()]
      .filter((queueItemId) => !nextSignatures.has(queueItemId))
      .map(playlistStorageKey);
    const legacyShadowFits = serializedStateByteLength(this.room) <= STATE_MAX_BYTES;
    const write = async (storage) => {
      await putStorageEntries(storage, changedEntries);
      await deleteStorageKeys(storage, removedKeys);
      await storage.put(STORAGE_V2_CORE_KEY, storedCore);
      // Keep an exact rollback shadow while it is representable by the old
      // single-record format. Once it no longer fits, retain the last valid
      // shadow instead of deleting the only state an older Worker understands.
      if (legacyShadowFits) await storage.put(STORAGE_KEY, this.room);
    };
    if (typeof this.storage.transaction === 'function') {
      await this.storage.transaction((transaction) => write(transaction));
    } else {
      // Unit-test and local compatibility fallback. Production SQLite-backed
      // Durable Objects provide transaction(), which makes row/core changes
      // atomic.
      await write(this.storage);
    }
    this.persistedPlaylistSignatures = nextSignatures;
    this.hasV2Persistence = true;
    await this.scheduleAlarm();
  }

  async scheduleAlarm() {
    if (typeof this.storage.setAlarm !== 'function') return;
    const candidates = [];
    if (this.room.status === 'decommissioning') {
      candidates.push(this.room.decommission?.retryAtMs, this.room.decommission?.purgeAfterMs);
    } else if (this.room.status === 'decommissioned') {
      candidates.push(this.room.decommission?.maintenanceAtMs);
    }
    for (const session of Object.values(this.room.sessions)) candidates.push(session.expiresAtMs);
    for (const participant of Object.values(this.room.presence.participants)) {
      candidates.push(participant.lastSeenAtMs + this.presenceTtlMs());
    }
    if (this.room.systemAudio.status === 'preparing') {
      candidates.push(this.room.systemAudio.claimExpiresAt);
    } else if (this.room.systemAudio.status === 'live') {
      candidates.push(this.room.systemAudio.liveExpiresAt);
    }
    for (const asset of Object.values(this.room.assets)) {
      if (asset.status === 'reserved') candidates.push(asset.expiresAtMs);
      if (Number.isSafeInteger(asset.stagingCleanupAfterMs)) {
        candidates.push(asset.stagingCleanupAfterMs);
      }
      if (asset.status === 'ready' && Number.isSafeInteger(asset.gcAfterMs)) {
        candidates.push(asset.gcAfterMs);
      }
    }
    for (const expiresAtMs of Object.values(this.room.consumedRecoveryNonces || {})) {
      candidates.push(expiresAtMs);
    }
    for (const tombstone of Object.values(this.room.stagingTombstones || {})) {
      candidates.push(tombstone.cleanupAfterMs);
    }
    for (const command of Object.values(this.room.developerCommands || {})) {
      if (command.status === 'pending' || command.status === 'dispatched') {
        candidates.push(command.expiresAtMs);
        if (
          command.attempts < DEVELOPER_COMMAND_MAX_ATTEMPTS &&
          Number.isSafeInteger(command.nextAttemptAtMs)
        ) {
          candidates.push(command.nextAttemptAtMs);
        }
      } else {
        candidates.push(command.retainUntilMs);
      }
    }
    for (const record of Object.values(this.room.developerCommandIdempotency || {})) {
      candidates.push(record.expiresAtMs);
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

  assetGcGraceMs() {
    return (
      configuredNumber(this.env.ASSET_GC_GRACE_SECONDS, ASSET_GC_GRACE_SECONDS, 60, 24 * 60 * 60) *
      1000
    );
  }

  referencedAssetIds() {
    return new Set(
      this.room.playlist
        .filter((item) => item.source.kind === 'pro-r2')
        .map((item) => item.source.assetId),
    );
  }

  reconcileAssetGarbageCollection(nowMs) {
    const referenced = this.referencedAssetIds();
    let changed = false;
    for (const asset of Object.values(this.room.assets)) {
      if (asset.status !== 'ready') continue;
      if (referenced.has(asset.assetId)) {
        if (asset.gcAfterMs !== undefined) {
          delete asset.gcAfterMs;
          changed = true;
        }
      } else if (!Number.isSafeInteger(asset.gcAfterMs)) {
        asset.gcAfterMs = nowMs + this.assetGcGraceMs();
        changed = true;
      }
    }
    return changed;
  }

  retainStagingTombstone(asset, nowMs = Date.now()) {
    if (!asset.stagingObjectKey || !Number.isSafeInteger(asset.uploadExpiresAtMs)) return;
    const cleanupAfterMs = Math.max(
      asset.uploadExpiresAtMs + 5_000,
      Number.isSafeInteger(asset.stagingCleanupAfterMs)
        ? asset.stagingCleanupAfterMs
        : nowMs + 5_000,
    );
    this.room.stagingTombstones[asset.assetId] = {
      objectKey: asset.stagingObjectKey,
      cleanupAfterMs,
    };
  }

  async fetch(request) {
    if (!(await this.ensureReady(request))) return errorResponse('ROOM_NOT_FOUND', 404);
    const url = new URL(request.url);
    if (url.search || url.hash || request.url.length > 8192) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (url.pathname.startsWith('/internal/bot/')) {
      if (request.method !== 'POST') return errorResponse('NOT_FOUND', 404);
      return this.withMutation(async () => {
        await this.prune(Date.now());
        return this.withStateCapacityRollback(async () => {
          if (url.pathname === '/internal/bot/context') {
            return this.handleInternalBotContext(request);
          }
          if (url.pathname === '/internal/bot/execute') {
            return this.handleInternalBotExecute(request);
          }
          return errorResponse('NOT_FOUND', 404);
        });
      });
    }
    if (url.pathname.startsWith('/internal/admin/')) {
      if (request.method === 'GET' && url.pathname === '/internal/admin/status') {
        return jsonResponse({
          roomCode: this.room.roomCode,
          provisioned: this.room.provisioned,
          status: this.room.status,
        });
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/provision') {
        return this.withMutation(async () => {
          if (this.room.status === 'decommissioning' || this.room.status === 'decommissioned') {
            return errorResponse('PRO_ROOM_PERMANENTLY_DECOMMISSIONED', 410);
          }
          if (!this.room.provisioned) {
            this.room.provisioned = true;
            await this.persist();
          }
          return jsonResponse({ ok: true, roomCode: this.room.roomCode, status: this.room.status });
        });
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/activation-claim') {
        return this.withMutation(() => this.handleInternalActivationClaim());
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/suspend') {
        return this.withMutation(() => this.handleInternalSuspend());
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/resume') {
        return this.withMutation(() => this.handleInternalResume());
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/decommission') {
        return this.withMutation(() => this.handleInternalDecommission(request));
      }
      return errorResponse('NOT_FOUND', 404);
    }
    if (url.pathname.startsWith('/internal/developer/')) {
      if (request.method !== 'POST') {
        return errorResponse('NOT_FOUND', 404);
      }
      return this.withMutation(async () => {
        await this.prune(Date.now());
        return this.withStateCapacityRollback(async () => {
          if (url.pathname === '/internal/developer/v1/read') {
            return this.handleInternalDeveloperRead(request);
          }
          if (url.pathname === '/internal/developer/v1/commands/create') {
            return this.handleInternalDeveloperCommandCreate(request);
          }
          if (url.pathname === '/internal/developer/v1/commands/status') {
            return this.handleInternalDeveloperCommandStatus(request);
          }
          if (url.pathname === '/internal/developer/v1/queue/mutate') {
            return this.handleInternalDeveloperQueueMutation(request);
          }
          if (url.pathname === '/internal/developer/v1/queue-mode/update') {
            return this.handleInternalDeveloperQueueModeUpdate(request);
          }
          if (url.pathname === '/internal/developer/v1/media/uploads/create') {
            return this.handleInternalDeveloperMediaUploadCreate(request);
          }
          if (url.pathname === '/internal/developer/v1/media/uploads/complete') {
            return this.handleInternalDeveloperMediaUploadComplete(request);
          }
          return errorResponse('NOT_FOUND', 404);
        });
      });
    }
    const prefix = `/v1/rooms/${this.room.roomCode}`;
    if (!url.pathname.startsWith(`${prefix}/`)) return errorResponse('ROOM_NOT_FOUND', 404);
    if (!this.room.provisioned) return errorResponse('ROOM_NOT_FOUND', 404);
    if (request.method === 'GET' && url.pathname === `${prefix}/bootstrap`) {
      return this.handleBootstrap();
    }
    return this.withMutation(async () => {
      await this.prune(Date.now());
      return this.withStateCapacityRollback(async () => {
        if (request.method === 'POST' && url.pathname === `${prefix}/activation`)
          return this.handleActivation(request);
        if (request.method === 'POST' && url.pathname === `${prefix}/owner-recovery`)
          return this.handleOwnerRecovery(request);
        if (request.method === 'POST' && url.pathname === `${prefix}/sessions`)
          return this.handleCreateSession(request);
        if (request.method === 'GET' && url.pathname === `${prefix}/snapshot`)
          return this.handleGetSnapshot(request);
        if (request.method === 'DELETE' && url.pathname === `${prefix}/sessions/current`)
          return this.handleCloseSession(request);
        if (request.method === 'POST' && url.pathname === `${prefix}/sessions/current/close`)
          return this.handleCloseSessionFenced(request);
        if (request.method === 'POST' && url.pathname === `${prefix}/pin`)
          return this.handleChangePin(request);
        if (request.method === 'POST' && url.pathname === `${prefix}/presence/heartbeat`)
          return this.handleHeartbeat(request);
        if (request.method === 'POST' && url.pathname === `${prefix}/presence/enter`)
          return this.handleEnterPresence(request);
        if (request.method === 'POST' && url.pathname === `${prefix}/presence/close`)
          return this.handleClosePresence(request);
        if (request.method === 'DELETE' && url.pathname === `${prefix}/presence/current`)
          return this.handleLeavePresence(request);
        if (request.method === 'POST' && url.pathname === `${prefix}/signaling-tickets`)
          return this.handleSignalingTicket(request);
        const developerCommandAck = url.pathname.match(
          new RegExp(`^${prefix}/developer-commands/(cmd_[A-Za-z0-9_-]{22})/ack$`),
        );
        if (request.method === 'POST' && developerCommandAck) {
          return this.handleDeveloperCommandAck(request, developerCommandAck[1]);
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/effects`)
          return this.handleGetEffects(request);
        if (request.method === 'PUT' && url.pathname === `${prefix}/effects`)
          return this.handleUpdateEffects(request);
        if (request.method === 'GET' && url.pathname === `${prefix}/queue-mode`)
          return this.handleGetQueueMode(request);
        if (request.method === 'PUT' && url.pathname === `${prefix}/queue-mode`)
          return this.handleUpdateQueueMode(request);
        if (request.method === 'GET' && url.pathname === `${prefix}/system-audio`)
          return this.handleGetSystemAudio(request);
        if (request.method === 'POST' && url.pathname === `${prefix}/system-audio/acquire`)
          return this.handleAcquireSystemAudio(request);
        if (request.method === 'POST' && url.pathname === `${prefix}/system-audio/commit`)
          return this.handleCommitSystemAudio(request);
        if (request.method === 'POST' && url.pathname === `${prefix}/system-audio/heartbeat`)
          return this.handleHeartbeatSystemAudio(request);
        if (request.method === 'POST' && url.pathname === `${prefix}/system-audio/release`)
          return this.handleReleaseSystemAudio(request);
        if (request.method === 'PUT' && url.pathname === `${prefix}/snapshot`)
          return this.handleUpdateSnapshot(request);
        if (request.method === 'POST' && url.pathname === `${prefix}/snapshot/compact`)
          return this.handleCompactSnapshotMutation(request);
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

  botRateLimitResponse(key, limit, nowMs) {
    const current = this.room.rateLimits[key];
    if (!current || current.resetAtMs <= nowMs || current.count < limit) return null;
    return errorResponse('RATE_LIMITED', 429, {
      'retry-after': String(Math.max(1, Math.ceil((current.resetAtMs - nowMs) / 1000))),
    });
  }

  recordBotRateLimit(key, windowMs, nowMs) {
    const current = this.room.rateLimits[key];
    if (!current || current.resetAtMs <= nowMs) {
      if (!current && Object.keys(this.room.rateLimits).length >= RATE_LIMIT_MAX_ITEMS) {
        const oldest = Object.entries(this.room.rateLimits).sort(
          ([, left], [, right]) => left.resetAtMs - right.resetAtMs,
        )[0]?.[0];
        if (oldest) delete this.room.rateLimits[oldest];
      }
      this.room.rateLimits[key] = { count: 1, resetAtMs: nowMs + windowMs };
      return;
    }
    current.count += 1;
  }

  publicBotContext(auth) {
    const playlist = this.room.playlist.slice(0, 100).map((item) => ({
      queueItemId: item.queueItemId,
      kind: item.source.kind === 'youtube' ? 'youtube' : 'audio',
      name: item.name.slice(0, 160),
      ...(typeof item.title === 'string' ? { title: item.title.slice(0, 160) } : {}),
      ...(typeof item.artist === 'string' ? { artist: item.artist.slice(0, 160) } : {}),
    }));
    return {
      actorName: queueAdditionActorName(auth.session.displayName, 'Peer'),
      room: {
        playlistRevision: this.room.playlistRevision,
        currentQueueItemId: this.room.currentQueueItemId,
        playbackState: this.room.playback.state,
        repeatMode:
          this.room.queueMode.repeatMode === 2
            ? 'one'
            : this.room.queueMode.repeatMode === 1
              ? 'all'
              : 'off',
        shuffleEnabled: this.room.queueMode.shuffleEnabled,
        playlist,
      },
    };
  }

  async handleInternalBotContext(request) {
    if (
      this.room.roomCode !== BOT_BETA_ROOM_CODE ||
      !this.room.provisioned ||
      this.room.status !== 'active'
    ) {
      return errorResponse('BOT_ROOM_ONLY', 400);
    }
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, 2 * 1024);
    if (
      parsed.response ||
      !hasExactKeys(parsed.value, ['roomCode', 'requestId', 'prompt']) ||
      parsed.value.roomCode !== this.room.roomCode ||
      !BOT_REQUEST_ID_RE.test(parsed.value.requestId || '') ||
      boundedString(parsed.value.prompt, 500) === null
    ) {
      return parsed.response || errorResponse('INVALID_REQUEST', 400);
    }

    const scope = `bot-context:${auth.tokenHash}`;
    const fingerprint = await this.idempotencyFingerprint(scope, {
      roomCode: this.room.roomCode,
      prompt: boundedString(parsed.value.prompt, 500),
    });
    const storageKey = `${scope}:${parsed.value.requestId}`;
    const receipt = this.room.idempotency[storageKey];
    if (receipt && !constantTimeEqual(receipt.fingerprint, fingerprint)) {
      return errorResponse('IDEMPOTENCY_CONFLICT', 409);
    }
    const nowMs = Date.now();
    if (receipt) {
      const executeReceipt =
        this.room.idempotency[`bot-execute:${auth.tokenHash}:${parsed.value.requestId}`];
      if (executeReceipt?.body) return jsonResponse({ replay: executeReceipt.body });
      const leaseExpiresAtMs = receipt.body?.leaseExpiresAtMs;
      return errorResponse(
        Number.isSafeInteger(leaseExpiresAtMs) && leaseExpiresAtMs > nowMs
          ? 'BOT_REQUEST_IN_PROGRESS'
          : 'BOT_REQUEST_EXPIRED',
        409,
        Number.isSafeInteger(leaseExpiresAtMs) && leaseExpiresAtMs > nowMs
          ? { 'retry-after': String(Math.max(1, Math.ceil((leaseExpiresAtMs - nowMs) / 1000))) }
          : {},
      );
    }

    const leaseToken = randomToken(24);
    {
      const minuteKey = `bot-minute:${auth.tokenHash}`;
      const hourKey = `bot-room-hour-v1:${this.room.roomCode}`;
      const minuteLimit = this.botRateLimitResponse(minuteKey, BOT_MEMBER_MINUTE_LIMIT, nowMs);
      if (minuteLimit) return minuteLimit;
      const hourLimit = this.botRateLimitResponse(hourKey, BOT_ROOM_HOUR_LIMIT, nowMs);
      if (hourLimit) return hourLimit;
      this.recordBotRateLimit(minuteKey, BOT_MEMBER_MINUTE_MS, nowMs);
      this.recordBotRateLimit(hourKey, BOT_ROOM_HOUR_MS, nowMs);
      // The former daily policy used a different key. Remove its inert room
      // state as soon as the new policy records a request.
      delete this.room.rateLimits[`bot-day:${this.room.roomCode}`];
      this.storeIdempotency(
        scope,
        parsed.value.requestId,
        fingerprint,
        { leaseToken, leaseExpiresAtMs: nowMs + BOT_REQUEST_LEASE_MS },
        200,
        nowMs + IDEMPOTENCY_TTL_MS,
      );
      await this.persist();
    }
    return jsonResponse({ leaseToken, ...this.publicBotContext(auth) });
  }

  async runBotDeveloperCommand(requestId, command) {
    const response = await this.handleInternalDeveloperCommandCreate(
      new Request('https://pro-room.internal/internal/developer/v1/commands/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode: this.room.roomCode,
          keyId: BOT_DEVELOPER_KEY_ID,
          idempotencyKey: `${requestId}.command`,
          command,
        }),
      }),
    );
    return response.ok;
  }

  async handleInternalBotExecute(request) {
    if (
      this.room.roomCode !== BOT_BETA_ROOM_CODE ||
      !this.room.provisioned ||
      this.room.status !== 'active'
    ) {
      return errorResponse('BOT_ROOM_ONLY', 400);
    }
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, 64 * 1024);
    if (
      parsed.response ||
      !hasExactKeys(parsed.value, ['roomCode', 'requestId', 'leaseToken', 'plan', 'tracks']) ||
      parsed.value.roomCode !== this.room.roomCode ||
      !BOT_REQUEST_ID_RE.test(parsed.value.requestId || '') ||
      !BOT_LEASE_TOKEN_RE.test(parsed.value.leaseToken || '') ||
      !Array.isArray(parsed.value.tracks)
    ) {
      return parsed.response || errorResponse('INVALID_REQUEST', 400);
    }
    const plan = parseBotPlan(parsed.value.plan);
    if (!plan) return errorResponse('INVALID_REQUEST', 400);
    const tracks =
      plan.intent === 'add_youtube'
        ? parseBotTracks(parsed.value.tracks)
        : parsed.value.tracks.length === 0
          ? []
          : null;
    if (!tracks) return errorResponse('INVALID_REQUEST', 400);

    const contextScope = `bot-context:${auth.tokenHash}`;
    const contextReceipt = this.room.idempotency[`${contextScope}:${parsed.value.requestId}`];
    if (
      !contextReceipt ||
      !constantTimeEqual(contextReceipt.body?.leaseToken, parsed.value.leaseToken)
    ) {
      return errorResponse('BOT_CONTEXT_REQUIRED', 409);
    }

    const scope = `bot-execute:${auth.tokenHash}`;
    const fingerprint = await this.idempotencyFingerprint(scope, { plan, tracks });
    const replay = this.replayIdempotency(scope, parsed.value.requestId, fingerprint);
    if (replay) return replay;
    if (
      !Number.isSafeInteger(contextReceipt.body?.leaseExpiresAtMs) ||
      contextReceipt.body.leaseExpiresAtMs <= Date.now()
    ) {
      return errorResponse('BOT_CONTEXT_REQUIRED', 409);
    }

    let addedCount = 0;
    let playbackChanged = false;
    if (plan.intent === 'add_youtube') {
      const queueResponse = await this.handleInternalDeveloperQueueMutation(
        new Request('https://pro-room.internal/internal/developer/v1/queue/mutate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            roomCode: this.room.roomCode,
            keyId: BOT_DEVELOPER_KEY_ID,
            idempotencyKey: `${parsed.value.requestId}.queue`,
            actorName: queueAdditionActorName(`${auth.session.displayName} · BOT`, 'BOT'),
            mutation: { type: 'add_youtube_batch', items: tracks },
          }),
        }),
      );
      if (!queueResponse.ok) return errorResponse('BOT_ACTION_FAILED', 409);
      addedCount = tracks.length;
      if (plan.playAddedIndex >= 0) {
        const targetVideoId = tracks[plan.playAddedIndex]?.videoId;
        const target = [...this.room.playlist]
          .reverse()
          .find(
            (item) =>
              item.source.kind === 'youtube' &&
              item.source.videoId === targetVideoId &&
              item.developerOwnerKeyId === BOT_DEVELOPER_KEY_ID,
          );
        if (target) {
          playbackChanged = await this.runBotDeveloperCommand(parsed.value.requestId, {
            type: 'play_item',
            queueItemId: target.queueItemId,
          });
        }
      }
    } else if (plan.intent === 'play_existing') {
      if (!this.room.playlist.some((item) => item.queueItemId === plan.queueItemId)) {
        return errorResponse('QUEUE_ITEM_NOT_FOUND', 404);
      }
      playbackChanged = await this.runBotDeveloperCommand(parsed.value.requestId, {
        type: 'play_item',
        queueItemId: plan.queueItemId,
      });
      if (!playbackChanged) return errorResponse('BOT_ACTION_FAILED', 409);
    } else if (plan.intent === 'playback') {
      playbackChanged = await this.runBotDeveloperCommand(parsed.value.requestId, {
        type: plan.playbackCommand,
      });
      if (!playbackChanged) return errorResponse('BOT_ACTION_FAILED', 409);
    } else if (plan.intent === 'queue_mode') {
      const queueModeResponse = await this.handleInternalDeveloperQueueModeUpdate(
        new Request('https://pro-room.internal/internal/developer/v1/queue-mode/update', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            roomCode: this.room.roomCode,
            keyId: BOT_DEVELOPER_KEY_ID,
            idempotencyKey: `${parsed.value.requestId}.mode`,
            queueMode: {
              baseRevision: this.room.queueMode.revision,
              repeatMode:
                plan.repeatMode ||
                (this.room.queueMode.repeatMode === 2
                  ? 'one'
                  : this.room.queueMode.repeatMode === 1
                    ? 'all'
                    : 'off'),
              shuffleEnabled:
                plan.shuffleEnabled === undefined
                  ? this.room.queueMode.shuffleEnabled
                  : plan.shuffleEnabled,
            },
          }),
        }),
      );
      if (!queueModeResponse.ok) return errorResponse('BOT_ACTION_FAILED', 409);
    }

    const fallbackSummary =
      addedCount > 0
        ? `Added ${addedCount} track${addedCount === 1 ? '' : 's'}${playbackChanged ? ' and started playback' : ''}.`
        : playbackChanged
          ? 'Playback updated.'
          : 'Done.';
    const responseBody = {
      ok: true,
      summary: addedCount > 0 ? fallbackSummary : plan.answer || fallbackSummary,
      addedCount,
      playbackChanged,
    };
    this.storeIdempotency(scope, parsed.value.requestId, fingerprint, responseBody);
    await this.persist();
    return jsonResponse(responseBody);
  }

  async handleInternalDeveloperRead(request) {
    if (!this.room.provisioned || this.room.status !== 'active') {
      return errorResponse('ROOM_NOT_FOUND', 404);
    }
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(parsed.value, ['projection'], ['keyId']) ||
      (parsed.value.keyId !== undefined &&
        !DEVELOPER_API_KEY_ID_RE.test(parsed.value.keyId || '')) ||
      !['room', 'playback', 'queue', 'effects', 'queue-mode'].includes(parsed.value.projection)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const projection = developerProjection(
      this.room,
      parsed.value.projection,
      Date.now(),
      parsed.value.keyId,
    );
    return projection ? jsonResponse(projection) : errorResponse('ROOM_STATE_INVALID', 503);
  }

  async handleInternalDeveloperCommandCreate(request) {
    if (!this.room.provisioned || this.room.status !== 'active') {
      return errorResponse('ROOM_NOT_FOUND', 404);
    }
    const parsed = await this.parseBody(request, 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(parsed.value, ['roomCode', 'keyId', 'idempotencyKey', 'command']) ||
      parsed.value.roomCode !== this.room.roomCode ||
      !DEVELOPER_API_KEY_ID_RE.test(parsed.value.keyId || '') ||
      !IDEMPOTENCY_KEY_RE.test(parsed.value.idempotencyKey || '')
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const command = parseDeveloperCommand(parsed.value.command);
    if (!command) return errorResponse('INVALID_REQUEST', 400);

    const scope = `developer:${parsed.value.keyId}:playback`;
    const fingerprint = await this.idempotencyFingerprint(scope, command);
    const replay = this.replayDeveloperCommandIdempotency(
      scope,
      parsed.value.idempotencyKey,
      fingerprint,
    );
    if (replay) return replay;

    const coordinatorId = this.room.presence.coordinatorParticipantId;
    const coordinator = coordinatorId ? this.room.presence.participants[coordinatorId] : null;
    if (this.room.runtime !== 'awake' || !coordinator) {
      return errorResponse('ROOM_SLEEPING', 409);
    }
    const requiredControlVersion = requiredDeveloperControlVersion(command);
    if (!supportsDeveloperControl(coordinator, requiredControlVersion)) {
      return errorResponse('COORDINATOR_INCOMPATIBLE', 409);
    }
    if (command.type === 'play_item') {
      if (!this.room.playlist.some((item) => item.queueItemId === command.queueItemId)) {
        return errorResponse('QUEUE_ITEM_NOT_FOUND', 404);
      }
    } else if (
      command.type !== 'set_effects' &&
      (!this.room.currentQueueItemId || !this.room.playback.queueItemId)
    ) {
      return errorResponse('NO_MEDIA', 409);
    }

    const activeCount = Object.values(this.room.developerCommands).filter(
      (record) => record.status === 'pending' || record.status === 'dispatched',
    ).length;
    if (activeCount >= DEVELOPER_COMMAND_MAX_ACTIVE_ITEMS) {
      return errorResponse('COMMAND_CAPACITY_EXCEEDED', 409);
    }
    const idempotencyStorageKey = this.developerCommandIdempotencyStorageKey(
      scope,
      parsed.value.idempotencyKey,
    );
    if (!this.reserveDeveloperCommandIdempotencySlot(idempotencyStorageKey)) {
      return errorResponse('COMMAND_CAPACITY_EXCEEDED', 409);
    }
    if (!this.reserveDeveloperCommandSlot()) {
      return errorResponse('COMMAND_CAPACITY_EXCEEDED', 409);
    }

    const nowMs = Date.now();
    const commandId = `cmd_${randomToken(16)}`;
    const record = {
      roomCode: this.room.roomCode,
      commandId,
      keyId: parsed.value.keyId,
      idempotencyKey: parsed.value.idempotencyKey,
      command,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + DEVELOPER_COMMAND_TTL_MS,
      retainUntilMs: nowMs + DEVELOPER_COMMAND_RETENTION_MS,
      coordinatorEpoch: this.room.presence.coordinatorEpoch,
      coordinatorParticipantId: coordinator.participantId,
      coordinatorPresenceIncarnationId: coordinator.presenceIncarnationId,
      developerControlVersion: requiredControlVersion,
      expected: {
        queueItemId: this.room.currentQueueItemId,
        playlistRevision: this.room.playlistRevision,
        playbackRevision: this.room.playback.revision,
      },
      status: 'pending',
      attempts: 0,
      nextAttemptAtMs: nowMs,
      dispatchCapacityReserve: 'd'.repeat(DEVELOPER_COMMAND_DISPATCH_RESERVE_BYTES),
      terminalCapacityReserve: 't'.repeat(DEVELOPER_COMMAND_TERMINAL_RESERVE_BYTES),
    };
    this.room.developerCommands[commandId] = record;
    const responseBody = publicDeveloperCommand(record);
    this.room.developerCommandIdempotency[idempotencyStorageKey] = {
      idempotencyKey: parsed.value.idempotencyKey,
      fingerprint,
      commandId,
      body: responseBody,
      status: 202,
      expiresAtMs: nowMs + DEVELOPER_COMMAND_RETENTION_MS,
    };

    // Persist before dispatch so a successful WebSocket send can never leave
    // an untracked command after a Worker interruption or response loss.
    await this.persist();
    if (await this.processDeveloperCommands(nowMs, commandId)) await this.persist();
    return jsonResponse(publicDeveloperCommand(record), 202);
  }

  async handleInternalDeveloperCommandStatus(request) {
    if (!this.room.provisioned || this.room.status !== 'active') {
      return errorResponse('ROOM_NOT_FOUND', 404);
    }
    const parsed = await this.parseBody(request, 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(parsed.value, ['roomCode', 'keyId', 'commandId']) ||
      parsed.value.roomCode !== this.room.roomCode ||
      !DEVELOPER_API_KEY_ID_RE.test(parsed.value.keyId || '') ||
      !DEVELOPER_COMMAND_ID_RE.test(parsed.value.commandId || '')
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const record = this.room.developerCommands[parsed.value.commandId];
    // A command created by another API key is deliberately indistinguishable
    // from an unknown ID.
    if (record && !constantTimeEqual(record.keyId, parsed.value.keyId)) {
      return errorResponse('COMMAND_NOT_FOUND', 404);
    }
    if (record) return jsonResponse(publicDeveloperCommand(record));

    // Terminal command records may leave the 64-slot polling ledger before
    // their ten-minute contract window under sustained use. The separate,
    // larger idempotency ledger retains the sanitized terminal body and is
    // still strictly key-bound.
    const prefix = `developer:${parsed.value.keyId}:playback:`;
    const retained = Object.entries(this.room.developerCommandIdempotency).find(
      ([storageKey, candidate]) =>
        storageKey.startsWith(prefix) &&
        candidate.commandId === parsed.value.commandId &&
        candidate.body?.commandId === parsed.value.commandId &&
        (candidate.body.status === 'applied' ||
          candidate.body.status === 'rejected' ||
          candidate.body.status === 'expired'),
    )?.[1];
    return retained ? jsonResponse(retained.body) : errorResponse('COMMAND_NOT_FOUND', 404);
  }

  async handleInternalDeveloperQueueMutation(request) {
    if (!this.room.provisioned || this.room.status !== 'active') {
      return errorResponse('ROOM_NOT_FOUND', 404);
    }
    // The public 64 KiB batch body is wrapped in an authenticated envelope.
    const parsed = await this.parseBody(request, 128 * 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(
        parsed.value,
        ['roomCode', 'keyId', 'idempotencyKey', 'mutation'],
        ['actorName'],
      ) ||
      parsed.value.roomCode !== this.room.roomCode ||
      !DEVELOPER_API_KEY_ID_RE.test(parsed.value.keyId || '') ||
      !IDEMPOTENCY_KEY_RE.test(parsed.value.idempotencyKey || '') ||
      (parsed.value.actorName !== undefined && !validDeveloperActorName(parsed.value.actorName))
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const mutation = parseDeveloperQueueMutation(parsed.value.mutation);
    if (!mutation) return errorResponse('INVALID_REQUEST', 400);
    const scope = `developer:${parsed.value.keyId}:queue:${mutation.type}`;
    const fingerprint = await this.idempotencyFingerprint(scope, mutation);
    const replay = this.replayIdempotency(
      scope,
      parsed.value.idempotencyKey,
      fingerprint,
      null,
      parsed.value.keyId,
    );
    if (replay) return replay;

    const nowMs = Date.now();
    let playlistChanged = false;
    if (mutation.type === 'add_youtube') {
      if (this.room.playlist.length >= PLAYLIST_MAX_ITEMS) {
        return errorResponse('PLAYLIST_CAPACITY_EXCEEDED', 409);
      }
      const queueItemId = randomQueueItemId();
      const item = {
        queueItemId,
        name: mutation.name,
        ...(mutation.title === undefined ? {} : { title: mutation.title }),
        ...(mutation.artist === undefined ? {} : { artist: mutation.artist }),
        ...(mutation.thumbnail === undefined ? {} : { thumbnail: mutation.thumbnail }),
        source: {
          kind: 'youtube',
          videoId: mutation.videoId,
          ...(mutation.playlistId === undefined ? {} : { playlistId: mutation.playlistId }),
        },
        developerOwnerKeyId: parsed.value.keyId,
      };
      this.room.playlist.push(item);
      playlistChanged = true;
    } else if (mutation.type === 'add_youtube_batch') {
      if (this.room.playlist.length + mutation.items.length > PLAYLIST_MAX_ITEMS) {
        return errorResponse('PLAYLIST_CAPACITY_EXCEEDED', 409);
      }
      if (
        this.room.playlistRevision >= Number.MAX_SAFE_INTEGER ||
        this.room.revision >= Number.MAX_SAFE_INTEGER
      ) {
        return errorResponse('ROOM_STATE_CAPACITY_EXCEEDED', 409);
      }
      const items = mutation.items.map((candidate) => ({
        queueItemId: randomQueueItemId(),
        name: candidate.name,
        ...(candidate.title === undefined ? {} : { title: candidate.title }),
        ...(candidate.artist === undefined ? {} : { artist: candidate.artist }),
        ...(candidate.thumbnail === undefined ? {} : { thumbnail: candidate.thumbnail }),
        source: {
          kind: 'youtube',
          videoId: candidate.videoId,
          ...(candidate.playlistId === undefined ? {} : { playlistId: candidate.playlistId }),
        },
        developerOwnerKeyId: parsed.value.keyId,
      }));
      this.room.playlist.push(...items);
      playlistChanged = true;
    } else if (mutation.type === 'remove') {
      const index = this.room.playlist.findIndex(
        (item) => item.queueItemId === mutation.queueItemId,
      );
      if (index === -1) return errorResponse('QUEUE_ITEM_NOT_FOUND', 404);
      const removedCurrent = this.room.currentQueueItemId === mutation.queueItemId;
      if (removedCurrent && this.room.playback.revision >= Number.MAX_SAFE_INTEGER) {
        return errorResponse('PLAYBACK_REVISION_EXHAUSTED', 409);
      }
      this.room.playlist.splice(index, 1);
      playlistChanged = true;
      if (removedCurrent) {
        this.room.currentQueueItemId = null;
        this.room.playback = {
          coordinatorEpoch: this.room.playback.coordinatorEpoch,
          revision: this.room.playback.revision + 1,
          state: 'idle',
          queueItemId: null,
          positionSeconds: 0,
          updatedAtMs: Math.max(this.room.playback.updatedAtMs, nowMs),
          youtubeVideoId: null,
          youtubeSubIndex: null,
        };
      }
    } else if (mutation.type === 'clear') {
      if (this.room.playlist.length > 0) {
        if (
          this.room.playlistRevision >= Number.MAX_SAFE_INTEGER ||
          this.room.revision >= Number.MAX_SAFE_INTEGER
        ) {
          return errorResponse('ROOM_STATE_CAPACITY_EXCEEDED', 409);
        }
        const clearCurrentPlayback =
          this.room.currentQueueItemId !== null ||
          this.room.playback.queueItemId !== null ||
          this.room.playback.state !== 'idle';
        if (clearCurrentPlayback && this.room.playback.revision >= Number.MAX_SAFE_INTEGER) {
          return errorResponse('PLAYBACK_REVISION_EXHAUSTED', 409);
        }
        this.room.playlist = [];
        playlistChanged = true;
        if (clearCurrentPlayback) {
          this.room.currentQueueItemId = null;
          this.room.playback = {
            coordinatorEpoch: this.room.playback.coordinatorEpoch,
            revision: this.room.playback.revision + 1,
            state: 'idle',
            queueItemId: null,
            positionSeconds: 0,
            updatedAtMs: Math.max(this.room.playback.updatedAtMs, nowMs),
            youtubeVideoId: null,
            youtubeSubIndex: null,
          };
        }
      }
    } else if (mutation.type === 'clear_owned') {
      const ownedQueueItemIds = new Set(
        this.room.playlist
          .filter((item) => item.developerOwnerKeyId === parsed.value.keyId)
          .map((item) => item.queueItemId),
      );
      if (ownedQueueItemIds.size > 0) {
        if (
          this.room.playlistRevision >= Number.MAX_SAFE_INTEGER ||
          this.room.revision >= Number.MAX_SAFE_INTEGER
        ) {
          return errorResponse('ROOM_STATE_CAPACITY_EXCEEDED', 409);
        }
        const clearCurrentPlayback =
          (this.room.currentQueueItemId !== null &&
            ownedQueueItemIds.has(this.room.currentQueueItemId)) ||
          (this.room.playback.queueItemId !== null &&
            ownedQueueItemIds.has(this.room.playback.queueItemId));
        if (clearCurrentPlayback && this.room.playback.revision >= Number.MAX_SAFE_INTEGER) {
          return errorResponse('PLAYBACK_REVISION_EXHAUSTED', 409);
        }
        this.room.playlist = this.room.playlist.filter(
          (item) => !ownedQueueItemIds.has(item.queueItemId),
        );
        playlistChanged = true;
        if (clearCurrentPlayback) {
          this.room.currentQueueItemId = null;
          this.room.playback = {
            coordinatorEpoch: this.room.playback.coordinatorEpoch,
            revision: this.room.playback.revision + 1,
            state: 'idle',
            queueItemId: null,
            positionSeconds: 0,
            updatedAtMs: Math.max(this.room.playback.updatedAtMs, nowMs),
            youtubeVideoId: null,
            youtubeSubIndex: null,
          };
        }
      }
    } else {
      if (mutation.basePlaylistRevision !== this.room.playlistRevision) {
        return errorResponse('PLAYLIST_REVISION_CONFLICT', 409);
      }
      const currentIds = this.room.playlist.map((item) => item.queueItemId);
      const requested = new Set(mutation.queueItemIds);
      if (
        currentIds.length !== mutation.queueItemIds.length ||
        currentIds.some((queueItemId) => !requested.has(queueItemId))
      ) {
        return errorResponse('PLAYLIST_REVISION_CONFLICT', 409);
      }
      playlistChanged = currentIds.some(
        (queueItemId, index) => queueItemId !== mutation.queueItemIds[index],
      );
      if (playlistChanged) {
        const itemById = new Map(this.room.playlist.map((item) => [item.queueItemId, item]));
        this.room.playlist = mutation.queueItemIds.map((queueItemId) => itemById.get(queueItemId));
      }
    }

    if (playlistChanged) {
      reconcileQueueModePlaylist(this.room, nowMs);
      this.room.playlistRevision += 1;
      this.room.revision += 1;
      this.reconcileAssetGarbageCollection(nowMs);
    }
    const responseBody = developerProjection(this.room, 'queue', nowMs, parsed.value.keyId);
    const responseStatus =
      mutation.type === 'add_youtube' || mutation.type === 'add_youtube_batch' ? 201 : 200;
    this.storeDeveloperQueueIdempotency(
      scope,
      parsed.value.idempotencyKey,
      fingerprint,
      responseStatus,
    );
    await this.persist();
    if (playlistChanged) {
      const addedCount =
        mutation.type === 'add_youtube'
          ? 1
          : mutation.type === 'add_youtube_batch'
            ? mutation.items.length
            : 0;
      this.scheduleDeveloperInvalidationHint(
        addedCount > 0
          ? { actorName: parsed.value.actorName, fallback: 'API', count: addedCount }
          : null,
      );
    }
    return jsonResponse(responseBody, responseStatus);
  }

  async handleInternalDeveloperQueueModeUpdate(request) {
    if (!this.room.provisioned || this.room.status !== 'active') {
      return errorResponse('ROOM_NOT_FOUND', 404);
    }
    const parsed = await this.parseBody(request, 4 * 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(parsed.value, ['roomCode', 'keyId', 'idempotencyKey', 'queueMode']) ||
      parsed.value.roomCode !== this.room.roomCode ||
      !DEVELOPER_API_KEY_ID_RE.test(parsed.value.keyId || '') ||
      !IDEMPOTENCY_KEY_RE.test(parsed.value.idempotencyKey || '') ||
      !parsed.value.queueMode ||
      typeof parsed.value.queueMode !== 'object' ||
      Array.isArray(parsed.value.queueMode) ||
      !hasExactKeys(parsed.value.queueMode, ['baseRevision', 'repeatMode', 'shuffleEnabled']) ||
      !isSafeNonNegativeInteger(parsed.value.queueMode.baseRevision) ||
      !['off', 'all', 'one'].includes(parsed.value.queueMode.repeatMode) ||
      typeof parsed.value.queueMode.shuffleEnabled !== 'boolean'
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }

    const mutation = parsed.value.queueMode;
    const scope = `developer:${parsed.value.keyId}:queue-mode:update`;
    const fingerprint = await this.idempotencyFingerprint(scope, mutation);
    const replay = this.replayIdempotency(scope, parsed.value.idempotencyKey, fingerprint);
    if (replay) return replay;
    if (mutation.baseRevision !== this.room.queueMode.revision) {
      return errorResponse('QUEUE_MODE_REVISION_CONFLICT', 409);
    }

    const repeatMode = mutation.repeatMode === 'one' ? 2 : mutation.repeatMode === 'all' ? 1 : 0;
    const shuffleEnabled = mutation.shuffleEnabled;
    const changed =
      repeatMode !== this.room.queueMode.repeatMode ||
      shuffleEnabled !== this.room.queueMode.shuffleEnabled;
    if (
      changed &&
      (this.room.queueMode.revision >= Number.MAX_SAFE_INTEGER ||
        this.room.revision >= Number.MAX_SAFE_INTEGER)
    ) {
      return errorResponse('ROOM_STATE_CAPACITY_EXCEEDED', 409);
    }

    if (changed) {
      const nowMs = Date.now();
      this.room.queueMode = {
        revision: this.room.queueMode.revision + 1,
        updatedAtMs: nowMs,
        repeatMode,
        shuffleEnabled,
        shuffleOrder: shuffleEnabled
          ? this.room.queueMode.shuffleEnabled
            ? [...this.room.queueMode.shuffleOrder]
            : shuffledQueueItemIds(this.room.playlist)
          : [],
      };
      this.room.revision += 1;
    }

    const responseBody = developerQueueMode(this.room);
    this.storeIdempotency(scope, parsed.value.idempotencyKey, fingerprint, responseBody);
    await this.persist();
    if (changed) this.scheduleDeveloperInvalidationHint();
    return jsonResponse(responseBody);
  }

  async handleInternalDeveloperMediaUploadCreate(request) {
    if (!this.room.provisioned || this.room.status !== 'active') {
      return errorResponse('ROOM_NOT_FOUND', 404);
    }
    const parsed = await this.parseBody(request, 16 * 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(parsed.value, ['roomCode', 'keyId', 'idempotencyKey', 'media']) ||
      parsed.value.roomCode !== this.room.roomCode ||
      !DEVELOPER_API_KEY_ID_RE.test(parsed.value.keyId || '') ||
      !IDEMPOTENCY_KEY_RE.test(parsed.value.idempotencyKey || '')
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const media = parseDeveloperMediaUpload(parsed.value.media);
    if (!media) return errorResponse('INVALID_MEDIA', 400);
    const scope = `developer:${parsed.value.keyId}:media:reserve`;
    const fingerprint = await this.idempotencyFingerprint(scope, media);
    const replay = this.replayIdempotency(scope, parsed.value.idempotencyKey, fingerprint);
    if (replay) return replay;
    if (!this.env.PRO_MEDIA_BUCKET || !r2S3Config(this.env)) {
      return errorResponse('MEDIA_NOT_CONFIGURED', 503);
    }
    if (this.room.playlist.length >= PLAYLIST_MAX_ITEMS) {
      return errorResponse('PLAYLIST_CAPACITY_EXCEEDED', 409);
    }
    const assets = Object.values(this.room.assets);
    const reservations = assets.filter((asset) => asset.status === 'reserved');
    if (assets.length + Object.keys(this.room.stagingTombstones).length >= ASSET_MAX_ITEMS) {
      return errorResponse('ASSET_CAPACITY_EXCEEDED', 409);
    }
    if (reservations.length >= RESERVED_ASSET_MAX_ITEMS) {
      return errorResponse('RESERVATION_CAPACITY_EXCEEDED', 409);
    }
    if (
      reservations.filter((asset) => asset.reservedByDeveloperKeyId === parsed.value.keyId)
        .length >= RESERVED_ASSET_MAX_ITEMS_PER_DEVELOPER_KEY
    ) {
      return errorResponse('RESERVATION_CAPACITY_EXCEEDED', 409);
    }
    if (
      this.room.quota.usedBytes + this.room.quota.reservedBytes + media.byteLength >
      ROOM_QUOTA_BYTES
    ) {
      return errorResponse('ROOM_QUOTA_EXCEEDED', 409);
    }

    const nowMs = Date.now();
    const assetId = `asset_${randomToken(24)}`;
    const queueItemId = randomQueueItemId();
    const version = 1;
    const objectPrefix = `rooms/${this.room.roomCode}/assets/${assetId}/v${version}`;
    const stagingObjectKey = `${objectPrefix}/staging_${randomToken(18)}`;
    const objectKey = `${objectPrefix}/object_${randomToken(24)}`;
    const uploadHeaders = {
      'content-length': String(media.byteLength),
      'content-type': media.mime,
      'x-amz-meta-mxqr-room': this.room.roomCode,
      'x-amz-meta-mxqr-asset': assetId,
      'x-amz-meta-mxqr-version': String(version),
      'x-amz-meta-mxqr-bytes': String(media.byteLength),
      ...(media.sha256 === undefined ? {} : { 'x-amz-meta-mxqr-sha256': media.sha256 }),
    };
    const presignTtl = Math.min(
      this.reservationTtlSeconds(),
      configuredNumber(this.env.PRESIGN_TTL_SECONDS, PRESIGN_TTL_SECONDS, 60, 3600),
    );
    const uploadExpiresAtMs = nowMs + presignTtl * 1000;
    // Completion keeps the original grace window: a large PUT may begin
    // before its signature expires and finish shortly afterward.
    const completionExpiresAtMs = nowMs + this.reservationTtlSeconds() * 1000;
    const uploadUrl = await createR2PresignedUrl({
      env: this.env,
      method: 'PUT',
      objectKey: stagingObjectKey,
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
      stagingObjectKey,
      uploadExpiresAtMs,
      reservedByDeveloperKeyId: parsed.value.keyId,
      developerQueueItemId: queueItemId,
      developerMetadata: {
        name: media.name,
        ...(media.title === undefined ? {} : { title: media.title }),
        ...(media.artist === undefined ? {} : { artist: media.artist }),
        ...(media.thumbnail === undefined ? {} : { thumbnail: media.thumbnail }),
      },
      byteLength: media.byteLength,
      name: media.name,
      mime: media.mime,
      ...(media.sha256 === undefined ? {} : { sha256: media.sha256 }),
      createdAtMs: nowMs,
      expiresAtMs: completionExpiresAtMs,
    };
    this.room.quota.reservedBytes += media.byteLength;
    this.room.revision += 1;
    const responseBody = {
      schemaVersion: 1,
      roomCode: this.room.roomCode,
      assetId,
      queueItemId,
      byteLength: media.byteLength,
      uploadExpiresAtMs,
      completionExpiresAtMs,
      upload: { method: 'PUT', url: uploadUrl, headers: uploadHeaders },
      quota: { ...this.room.quota },
    };
    // Never replay an expired signed URL. The reservation itself remains
    // completable through completionExpiresAtMs when the upload started in
    // time but crossed the signing deadline.
    this.storeIdempotency(
      scope,
      parsed.value.idempotencyKey,
      fingerprint,
      responseBody,
      201,
      uploadExpiresAtMs,
    );
    await this.persist();
    return jsonResponse(responseBody, 201);
  }

  async handleInternalDeveloperMediaUploadComplete(request) {
    if (!this.room.provisioned || this.room.status !== 'active') {
      return errorResponse('ROOM_NOT_FOUND', 404);
    }
    const parsed = await this.parseBody(request, 4 * 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(
        parsed.value,
        ['roomCode', 'keyId', 'idempotencyKey', 'assetId'],
        ['actorName'],
      ) ||
      parsed.value.roomCode !== this.room.roomCode ||
      !DEVELOPER_API_KEY_ID_RE.test(parsed.value.keyId || '') ||
      !IDEMPOTENCY_KEY_RE.test(parsed.value.idempotencyKey || '') ||
      !OPAQUE_ID_RE.test(parsed.value.assetId || '') ||
      (parsed.value.actorName !== undefined && !validDeveloperActorName(parsed.value.actorName))
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const assetId = parsed.value.assetId;
    const scope = `developer:${parsed.value.keyId}:media:complete:${assetId}`;
    const fingerprint = await this.idempotencyFingerprint(scope, { assetId });
    const replay = this.replayIdempotency(scope, parsed.value.idempotencyKey, fingerprint);
    if (replay) return replay;
    const asset = this.room.assets[assetId];
    if (!asset || asset.status !== 'reserved') return errorResponse('ASSET_NOT_FOUND', 404);
    if (!constantTimeEqual(asset.reservedByDeveloperKeyId || '', parsed.value.keyId)) {
      return errorResponse('ASSET_NOT_FOUND', 404);
    }
    if (
      !QUEUE_ITEM_ID_RE.test(asset.developerQueueItemId || '') ||
      !parseDeveloperMetadata(asset.developerMetadata)
    ) {
      return errorResponse('ROOM_STATE_INVALID', 503);
    }
    if (this.room.playlist.length >= PLAYLIST_MAX_ITEMS) {
      return errorResponse('PLAYLIST_CAPACITY_EXCEEDED', 409);
    }
    if (!this.env.PRO_MEDIA_BUCKET) return errorResponse('MEDIA_NOT_CONFIGURED', 503);
    if (serializedCoreStateByteLength(this.room) > STATE_MAX_BYTES - 32 * 1024) {
      return errorResponse('ROOM_STATE_CAPACITY_EXCEEDED', 409);
    }
    const expectedObjectMetadata = {
      'mxqr-room': this.room.roomCode,
      'mxqr-asset': asset.assetId,
      'mxqr-version': String(asset.version),
      'mxqr-bytes': String(asset.byteLength),
      ...(asset.sha256 === undefined ? {} : { 'mxqr-sha256': asset.sha256 }),
    };
    const objectMatchesReservation = (object) => {
      const metadata = object?.customMetadata || {};
      return (
        object?.size === asset.byteLength &&
        object?.httpMetadata?.contentType === asset.mime &&
        Object.entries(expectedObjectMetadata).every(
          ([metadataKey, metadataValue]) => metadata[metadataKey] === metadataValue,
        ) &&
        (asset.sha256 !== undefined || metadata['mxqr-sha256'] === undefined)
      );
    };

    let stagingObject;
    let finalObject;
    try {
      stagingObject = await this.env.PRO_MEDIA_BUCKET.head(asset.stagingObjectKey);
      if (!stagingObject) finalObject = await this.env.PRO_MEDIA_BUCKET.head(asset.objectKey);
    } catch {
      return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
    }
    // A previous attempt may have copied the final object and then lost its
    // response or been interrupted before the Durable Object commit. The
    // immutable final object is a valid recovery source when every reserved
    // property still matches; otherwise a missing staging object means the
    // client upload has not completed.
    if (!stagingObject && !objectMatchesReservation(finalObject)) {
      return errorResponse('UPLOAD_INCOMPLETE', 409);
    }
    if (stagingObject && !objectMatchesReservation(stagingObject)) {
      try {
        await this.env.PRO_MEDIA_BUCKET.delete(asset.stagingObjectKey);
      } catch {
        asset.expiresAtMs = Date.now() + 60_000;
        await this.persist();
        return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
      }
      this.room.quota.reservedBytes -= asset.byteLength;
      this.retainStagingTombstone(asset);
      delete this.room.assets[assetId];
      this.room.revision += 1;
      await this.persist();
      return errorResponse('UPLOAD_MISMATCH', 409);
    }

    if (!objectMatchesReservation(finalObject)) {
      try {
        const staged = await this.env.PRO_MEDIA_BUCKET.get(asset.stagingObjectKey);
        if (!staged?.body) return errorResponse('UPLOAD_INCOMPLETE', 409);
        await this.env.PRO_MEDIA_BUCKET.put(asset.objectKey, staged.body, {
          httpMetadata: { contentType: asset.mime },
          customMetadata: expectedObjectMetadata,
        });
        finalObject = await this.env.PRO_MEDIA_BUCKET.head(asset.objectKey);
        if (!objectMatchesReservation(finalObject)) {
          await this.env.PRO_MEDIA_BUCKET.delete(asset.objectKey).catch(() => {});
          return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
        }
      } catch {
        await this.env.PRO_MEDIA_BUCKET.delete(asset.objectKey).catch(() => {});
        return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
      }
    }

    const nowMs = Date.now();
    const queueItem = {
      queueItemId: asset.developerQueueItemId,
      ...asset.developerMetadata,
      source: publicAsset(asset),
      developerOwnerKeyId: parsed.value.keyId,
    };
    asset.status = 'ready';
    delete asset.expiresAtMs;
    asset.completedAtMs = nowMs;
    asset.stagingCleanupAfterMs = Math.max(asset.uploadExpiresAtMs + 5_000, nowMs + 60_000);
    this.room.quota.reservedBytes -= asset.byteLength;
    this.room.quota.usedBytes += asset.byteLength;
    this.room.playlist.push(queueItem);
    this.room.playlistRevision += 1;
    delete asset.reservedByDeveloperKeyId;
    delete asset.developerQueueItemId;
    delete asset.developerMetadata;
    this.reconcileAssetGarbageCollection(nowMs);
    this.room.revision += 1;
    const responseBody = {
      schemaVersion: 1,
      roomCode: this.room.roomCode,
      asset: publicAsset(asset),
      queueItem: developerQueueItem(queueItem, parsed.value.keyId),
      playlistRevision: this.room.playlistRevision,
      quota: { ...this.room.quota },
    };
    this.storeIdempotency(scope, parsed.value.idempotencyKey, fingerprint, responseBody, 201);
    await this.persist();
    this.scheduleDeveloperInvalidationHint({
      actorName: parsed.value.actorName,
      fallback: 'API',
      count: 1,
    });
    // State is authoritative once persisted. Staging cleanup is deliberately
    // after that commit, so interruption cannot strand a reserved asset whose
    // only recoverable upload object was already deleted. The normal alarm GC
    // retries this best-effort cleanup via stagingCleanupAfterMs.
    const cleanup = this.env.PRO_MEDIA_BUCKET.delete(asset.stagingObjectKey).catch(() => {});
    if (typeof this.state.waitUntil === 'function') this.state.waitUntil(cleanup);
    return jsonResponse(responseBody, 201);
  }

  reserveDeveloperCommandSlot() {
    const records = this.room.developerCommands;
    const ids = Object.keys(records);
    if (ids.length < DEVELOPER_COMMAND_MAX_ITEMS) return true;
    const evictable = ids
      .filter((id) => records[id].status !== 'pending' && records[id].status !== 'dispatched')
      .sort(
        (left, right) =>
          (records[left].completedAtMs || records[left].createdAtMs) -
          (records[right].completedAtMs || records[right].createdAtMs),
      )[0];
    if (!evictable) return false;
    // Status polling may lose an old terminal record under the strict 64-item
    // state bound, but an Idempotency-Key replay must still return the exact
    // terminal result for its full retention window.
    this.syncDeveloperCommandIdempotency(records[evictable]);
    delete records[evictable];
    return true;
  }

  developerCommandIdempotencyStorageKey(scope, key) {
    return `${scope}:${key}`;
  }

  reserveDeveloperCommandIdempotencySlot(storageKey, nowMs = Date.now()) {
    const records = this.room.developerCommandIdempotency;
    if (records[storageKey]) return true;
    for (const [key, record] of Object.entries(records)) {
      if (record.expiresAtMs <= nowMs) delete records[key];
    }
    // Never evict an unexpired record to admit a new command: doing so would
    // silently weaken exactly-once intent into best-effort deduplication.
    return Object.keys(records).length < DEVELOPER_COMMAND_IDEMPOTENCY_MAX_ITEMS;
  }

  syncDeveloperCommandIdempotency(command) {
    if (
      !command ||
      !DEVELOPER_API_KEY_ID_RE.test(command.keyId || '') ||
      !IDEMPOTENCY_KEY_RE.test(command.idempotencyKey || '')
    ) {
      return false;
    }
    const scope = `developer:${command.keyId}:playback`;
    const storageKey = this.developerCommandIdempotencyStorageKey(scope, command.idempotencyKey);
    const record = this.room.developerCommandIdempotency[storageKey];
    if (!record || record.commandId !== command.commandId) return false;
    record.body = publicDeveloperCommand(command);
    return true;
  }

  replayDeveloperCommandIdempotency(scope, key, fingerprint) {
    const storageKey = this.developerCommandIdempotencyStorageKey(scope, key);
    const record = this.room.developerCommandIdempotency[storageKey];
    if (!record) return null;
    if (!constantTimeEqual(record.fingerprint, fingerprint)) {
      return errorResponse('IDEMPOTENCY_CONFLICT', 409);
    }
    const commandId = record.body?.commandId;
    const command = DEVELOPER_COMMAND_ID_RE.test(commandId || '')
      ? this.room.developerCommands[commandId]
      : null;
    return command
      ? jsonResponse(publicDeveloperCommand(command), 202)
      : jsonResponse(record.body, record.status);
  }

  completeDeveloperCommand(record, status, resultCode, nowMs, acknowledged = false) {
    delete record.dispatchCapacityReserve;
    delete record.terminalCapacityReserve;
    delete record.nextAttemptAtMs;
    record.status = status;
    record.resultCode = resultCode;
    record.completedAtMs = nowMs;
    record.retainUntilMs = nowMs + DEVELOPER_COMMAND_RETENTION_MS;
    if (acknowledged) record.acknowledgedAtMs = nowMs;
    this.syncDeveloperCommandIdempotency(record);
  }

  scheduleDeveloperInvalidationHint(addition = null) {
    const coordinatorId = this.room.presence.coordinatorParticipantId;
    const coordinator = coordinatorId ? this.room.presence.participants[coordinatorId] : null;
    if (
      this.room.runtime !== 'awake' ||
      !coordinator ||
      !supportsDeveloperControl(coordinator) ||
      !Number.isSafeInteger(this.room.revision) ||
      this.room.revision < 0 ||
      !Number.isSafeInteger(this.room.playlistRevision) ||
      this.room.playlistRevision < 0
    ) {
      return;
    }
    const normalizedAddition =
      addition &&
      Number.isSafeInteger(addition.count) &&
      addition.count >= 1 &&
      addition.count <= 1000
        ? {
            type: 'pro-queue-addition',
            version: DEVELOPER_CONTROL_VERSION,
            roomCode: this.room.roomCode,
            coordinatorEpoch: this.room.presence.coordinatorEpoch,
            playlistRevision: this.room.playlistRevision,
            eventId: `qa_${this.room.roomCode}_${this.room.playlistRevision}_${this.room.revision}`,
            actorName: queueAdditionActorName(addition.actorName, addition.fallback),
            count: addition.count,
          }
        : null;
    const dispatch = this.dispatchDeveloperInvalidationHint({
      roomCode: this.room.roomCode,
      coordinatorEpoch: this.room.presence.coordinatorEpoch,
      coordinatorParticipantId: coordinator.participantId,
      coordinatorPresenceIncarnationId: coordinator.presenceIncarnationId,
      developerControlVersion: DEVELOPER_CONTROL_VERSION,
      revision: this.room.revision,
      playlistRevision: this.room.playlistRevision,
      ...(normalizedAddition ? { addition: normalizedAddition } : {}),
    });
    if (typeof this.state.waitUntil === 'function') this.state.waitUntil(dispatch);
  }

  async dispatchDeveloperInvalidationHint(hint) {
    const namespace = this.env.PRO_SIGNALING_ROOMS;
    if (!namespace || typeof namespace.idFromName !== 'function') return false;
    const frame = {
      type: 'developer-invalidation',
      version: DEVELOPER_CONTROL_VERSION,
      roomCode: hint.roomCode,
      coordinatorEpoch: hint.coordinatorEpoch,
      revision: hint.revision,
      playlistRevision: hint.playlistRevision,
    };
    try {
      const stub = namespace.get(namespace.idFromName(hint.roomCode));
      const response = await fetchWithDeadline(
        (boundedRequest) => stub.fetch(boundedRequest),
        new Request('https://signaling.internal/internal/developer/v1/invalidate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            roomCode: hint.roomCode,
            coordinatorEpoch: hint.coordinatorEpoch,
            coordinatorParticipantId: hint.coordinatorParticipantId,
            coordinatorPresenceIncarnationId: hint.coordinatorPresenceIncarnationId,
            developerControlVersion: hint.developerControlVersion,
            frame,
            ...(hint.addition ? { addition: hint.addition } : {}),
          }),
        }),
        DEVELOPER_COMMAND_DISPATCH_TIMEOUT_MS,
      );
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async dispatchDeveloperCommand(record) {
    const namespace = this.env.PRO_SIGNALING_ROOMS;
    if (!namespace || typeof namespace.idFromName !== 'function') return false;
    const frame = {
      type: 'developer-command',
      version: record.developerControlVersion,
      roomCode: this.room.roomCode,
      coordinatorEpoch: record.coordinatorEpoch,
      commandId: record.commandId,
      expiresAtMs: record.expiresAtMs,
      expected: structuredClone(record.expected),
      command: structuredClone(record.command),
    };
    try {
      const stub = namespace.get(namespace.idFromName(this.room.roomCode));
      const response = await fetchWithDeadline(
        (boundedRequest) => stub.fetch(boundedRequest),
        new Request('https://signaling.internal/internal/developer/v1/dispatch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            roomCode: this.room.roomCode,
            coordinatorEpoch: record.coordinatorEpoch,
            coordinatorParticipantId: record.coordinatorParticipantId,
            coordinatorPresenceIncarnationId: record.coordinatorPresenceIncarnationId,
            developerControlVersion: record.developerControlVersion,
            frame,
          }),
        }),
        DEVELOPER_COMMAND_DISPATCH_TIMEOUT_MS,
      );
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async processDeveloperCommands(nowMs = Date.now(), onlyCommandId = null) {
    let changed = false;
    const records = onlyCommandId
      ? [this.room.developerCommands[onlyCommandId]].filter(Boolean)
      : Object.values(this.room.developerCommands);
    for (const record of records) {
      if (record.status !== 'pending' && record.status !== 'dispatched') continue;
      if (record.expiresAtMs <= nowMs) {
        this.completeDeveloperCommand(record, 'expired', 'expired', nowMs);
        changed = true;
        continue;
      }
      const coordinator = this.room.presence.participants[record.coordinatorParticipantId];
      if (
        this.room.runtime !== 'awake' ||
        this.room.presence.coordinatorEpoch !== record.coordinatorEpoch ||
        this.room.presence.coordinatorParticipantId !== record.coordinatorParticipantId ||
        coordinator?.presenceIncarnationId !== record.coordinatorPresenceIncarnationId
      ) {
        this.completeDeveloperCommand(record, 'rejected', 'coordinator_changed', nowMs);
        changed = true;
        continue;
      }
      if (!supportsDeveloperControl(coordinator, record.developerControlVersion)) {
        this.completeDeveloperCommand(record, 'rejected', 'coordinator_incompatible', nowMs);
        changed = true;
        continue;
      }
      if (record.attempts >= DEVELOPER_COMMAND_MAX_ATTEMPTS || record.nextAttemptAtMs > nowMs) {
        continue;
      }
      // The persisted pre-dispatch record carried enough serialized padding
      // for every field added below. Consume it before the external send so a
      // successful WebSocket side effect cannot be erased by capacity rollback.
      delete record.dispatchCapacityReserve;
      const dispatched = await this.dispatchDeveloperCommand(record);
      record.attempts += 1;
      record.lastDispatchedAtMs = nowMs;
      record.nextAttemptAtMs = nowMs + DEVELOPER_COMMAND_RETRY_MS;
      if (dispatched) record.status = 'dispatched';
      if (!dispatched && record.attempts >= DEVELOPER_COMMAND_MAX_ATTEMPTS) {
        this.completeDeveloperCommand(record, 'rejected', 'coordinator_unavailable', nowMs);
      }
      changed = true;
    }
    return changed;
  }

  async handleDeveloperCommandAck(request, commandId) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, 1024);
    if (parsed.response) return parsed.response;
    if (
      !DEVELOPER_COMMAND_ID_RE.test(commandId) ||
      !hasExactKeys(parsed.value, ['resultCode']) ||
      !DEVELOPER_COMMAND_RESULT_CODES.has(parsed.value.resultCode)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const record = this.room.developerCommands[commandId];
    if (!record) return errorResponse('COMMAND_NOT_FOUND', 404);
    const nowMs = Date.now();
    if (
      this.room.presence.coordinatorEpoch !== record.coordinatorEpoch ||
      this.room.presence.coordinatorParticipantId !== auth.session.participantId ||
      record.coordinatorParticipantId !== auth.session.participantId ||
      record.coordinatorPresenceIncarnationId !== auth.participant.presenceIncarnationId
    ) {
      return errorResponse('COORDINATOR_MISMATCH', 409);
    }
    const equivalentSuccessfulAck =
      (record.resultCode === 'applied' || record.resultCode === 'already_applied') &&
      (parsed.value.resultCode === 'applied' || parsed.value.resultCode === 'already_applied');
    if (
      (record.resultCode === parsed.value.resultCode || equivalentSuccessfulAck) &&
      Number.isSafeInteger(record.acknowledgedAtMs)
    ) {
      return jsonResponse({ ok: true });
    }
    if (record.status === 'expired' && parsed.value.resultCode === 'expired') {
      // prune() runs before this route and may already have made expiry
      // authoritative. The exact coordinator's matching late ACK is still a
      // valid confirmation that the frame was discarded, not executed.
      record.acknowledgedAtMs = nowMs;
      this.syncDeveloperCommandIdempotency(record);
      await this.persist();
      return jsonResponse({ ok: true });
    }
    if (record.status !== 'pending' && record.status !== 'dispatched') {
      return errorResponse('COMMAND_ALREADY_COMPLETED', 409);
    }
    if (record.expiresAtMs <= nowMs) {
      if (parsed.value.resultCode !== 'expired') {
        return errorResponse('COMMAND_EXPIRED', 409);
      }
      this.completeDeveloperCommand(record, 'expired', 'expired', nowMs, true);
      await this.persist();
      return jsonResponse({ ok: true });
    }
    let resultCode = parsed.value.resultCode;
    let status =
      parsed.value.resultCode === 'applied' || parsed.value.resultCode === 'already_applied'
        ? 'applied'
        : parsed.value.resultCode === 'expired'
          ? 'expired'
          : 'rejected';
    if (status === 'applied' && record.command?.type === 'set_effects') {
      const patch = parseRoomEffectsPatch(record.command.effects);
      if (!patch || this.room.effects.revision >= Number.MAX_SAFE_INTEGER) {
        status = 'rejected';
        resultCode = 'execution_failed';
      } else {
        const effects = mergeRoomEffectsPatch(this.room.effects.effects, patch);
        if (JSON.stringify(effects) !== JSON.stringify(this.room.effects.effects)) {
          this.room.effects = {
            revision: this.room.effects.revision + 1,
            updatedAtMs: nowMs,
            effects,
          };
        }
      }
    }
    this.completeDeveloperCommand(record, status, resultCode, nowMs, true);
    await this.persist();
    return jsonResponse({ ok: true });
  }

  async handleInternalActivationClaim() {
    if (!this.room.provisioned) return errorResponse('PRO_ROOM_NOT_FOUND', 404);
    if (this.room.status !== 'unactivated') {
      return jsonResponse(
        { error: 'PRO_ROOM_ACTIVATION_UNAVAILABLE', status: this.room.status },
        409,
      );
    }
    const secret = String(this.env.PRO_ROOM_ACTIVATION_SECRET || '');
    if (secret.length < 32) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    if (this.room.activationClaimGeneration >= Number.MAX_SAFE_INTEGER) {
      return errorResponse('ACTIVATION_CLAIM_CAPACITY_EXCEEDED', 409);
    }
    const nowMs = Date.now();
    const expiresAt = nowMs + ACTIVATION_CLAIM_MAX_LIFETIME_MS;
    this.room.activationClaimGeneration += 1;
    // Persist the new generation before returning the credential. A lost
    // response may require the operator to issue again, but can never leave a
    // returned link valid without its generation being authoritative.
    await this.persist();
    const claim = await issueProRoomActivationClaim(this.room.roomCode, secret, {
      nowMs,
      expiresAtMs: expiresAt,
      generation: this.room.activationClaimGeneration,
    });
    return jsonResponse({
      roomCode: this.room.roomCode,
      activationUrl: `https://musixquare.com/${this.room.roomCode}#pro-claim=${encodeURIComponent(claim)}`,
      expiresAt,
    });
  }

  markRegistryActivationActive() {
    const db = this.env?.MUSIXQUARE_ADMIN_DB || this.env?.ADMIN_METRICS_DB || null;
    if (!db?.prepare) return;
    const update = db
      .prepare(
        `UPDATE mxqr_pro_room_registry
         SET activation_state = 'active', updated_at = ?2
         WHERE room_code = ?1 AND status = 'registered'`,
      )
      .bind(this.room.roomCode, Date.now())
      .run()
      .catch((error) => {
        console.warn('[PRO registry] activation-state update failed', error);
      });
    if (typeof this.state.waitUntil === 'function') this.state.waitUntil(update);
  }

  async parseBody(
    request,
    maxBytes = SMALL_REQUEST_MAX_BYTES,
    allowSimpleText = false,
    allowEmpty = false,
  ) {
    const parsed = await readJsonBody(request, maxBytes, allowSimpleText, allowEmpty);
    return parsed.error
      ? { response: errorResponse(parsed.error, parsed.status || 400) }
      : { value: parsed.value, empty: parsed.empty === true };
  }

  rateLimitKey(request, kind) {
    const ipHash = request.headers.get('x-mxqr-pro-ip-hash') || 'internal-test';
    return `${kind}:${ipHash}`;
  }

  readRateLimit(request, kind, limit, now = Date.now()) {
    const key = this.rateLimitKey(request, kind);
    const current = this.room.rateLimits[key];
    if (current && current.resetAtMs > now && current.count >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAtMs - now) / 1000));
      return errorResponse('RATE_LIMITED', 429, { 'retry-after': String(retryAfterSeconds) });
    }
    return null;
  }

  recordRateLimitHit(request, kind, windowMs, now = Date.now()) {
    const key = this.rateLimitKey(request, kind);
    const current = this.room.rateLimits[key];
    if (!current || current.resetAtMs <= now) {
      if (!current && Object.keys(this.room.rateLimits).length >= RATE_LIMIT_MAX_ITEMS) {
        const oldest = Object.entries(this.room.rateLimits).sort(
          ([, left], [, right]) => left.resetAtMs - right.resetAtMs,
        )[0]?.[0];
        if (oldest) delete this.room.rateLimits[oldest];
      }
      this.room.rateLimits[key] = { count: 1, resetAtMs: now + windowMs };
      return;
    }
    current.count += 1;
  }

  async applyRateLimit(request, kind, limit, windowMs) {
    const rateError = this.readRateLimit(request, kind, limit);
    if (rateError) return rateError;
    this.recordRateLimitHit(request, kind, windowMs);
    await this.persist();
    return null;
  }

  async createSessionRecord(role, displayName, nowMs, memberId = null) {
    const secret = String(this.env.PRO_ROOM_SESSION_SECRET || '');
    if (secret.length < 32) return null;
    const sessions = Object.entries(this.room.sessions);
    if (sessions.length >= SESSION_MAX_ITEMS) {
      const presentSessionHashes = new Set(
        Object.values(this.room.presence.participants).map(
          (participant) => participant.sessionHash,
        ),
      );
      const evictable = sessions
        .filter(([tokenHash]) => !presentSessionHashes.has(tokenHash))
        .sort(
          ([, left], [, right]) =>
            Number(left.role === 'owner') - Number(right.role === 'owner') ||
            left.createdAtMs - right.createdAtMs,
        )[0];
      if (!evictable) return null;
      delete this.room.sessions[evictable[0]];
    }
    const token = await createOpaqueCredential(secret);
    const tokenHash = await sha256Base64Url(token);
    const session = {
      memberId:
        memberId || (role === 'owner' ? `owner_${randomToken(18)}` : `member_${randomToken(18)}`),
      participantId: `participant_${randomToken(18)}`,
      presenceIncarnationId: null,
      signalingTicketSequence: 0,
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
    const token = requestOwnerToken(request, this.room.roomCode);
    const secret = String(this.env.PRO_ROOM_SESSION_SECRET || '');
    if (!(await verifyOpaqueCredential(token, secret))) return false;
    const hash = await sha256Base64Url(token);
    return constantTimeEqual(hash, this.room.ownerCredentialHash || '');
  }

  async authenticate(request) {
    const token = requestSessionToken(request, this.room.roomCode);
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
    if (options.activePresence) {
      const expectedParticipantId = request.headers.get('x-mxqr-pro-participant-id') || '';
      const expectedPresenceIncarnationId =
        request.headers.get('x-mxqr-pro-presence-incarnation') || '';
      const participant = this.room.presence.participants[auth.session.participantId];
      if (
        !OPAQUE_ID_RE.test(expectedParticipantId) ||
        !OPAQUE_ID_RE.test(expectedPresenceIncarnationId) ||
        auth.session.participantId !== expectedParticipantId ||
        auth.session.presenceIncarnationId !== expectedPresenceIncarnationId ||
        !participant ||
        participant.sessionHash !== auth.tokenHash ||
        participant.participantId !== expectedParticipantId ||
        participant.presenceIncarnationId !== expectedPresenceIncarnationId
      ) {
        return { response: errorResponse('PRESENCE_SUPERSEDED', 409) };
      }
      auth.participant = participant;
    }
    return auth;
  }

  async handleGetEffects(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    if (request.body && (request.headers.get('content-length') || '') !== '0') {
      return errorResponse('INVALID_REQUEST', 400);
    }
    return jsonResponse(publicEffects(this.room));
  }

  async handleUpdateEffects(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (!hasExactKeys(parsed.value, ['coordinatorEpoch', 'effects'])) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const effects = parseRoomEffects(parsed.value.effects);
    if (!isSafeNonNegativeInteger(parsed.value.coordinatorEpoch) || !effects) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (
      this.room.presence.coordinatorParticipantId !== auth.session.participantId ||
      this.room.presence.coordinatorEpoch !== parsed.value.coordinatorEpoch
    ) {
      return errorResponse('COORDINATOR_EPOCH_MISMATCH', 409);
    }
    if (JSON.stringify(effects) === JSON.stringify(this.room.effects.effects)) {
      return jsonResponse(publicEffects(this.room));
    }
    if (this.room.effects.revision >= Number.MAX_SAFE_INTEGER) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }
    this.room.effects = {
      revision: this.room.effects.revision + 1,
      updatedAtMs: Date.now(),
      effects,
    };
    await this.persist();
    return jsonResponse(publicEffects(this.room));
  }

  async handleGetQueueMode(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    if (request.body && (request.headers.get('content-length') || '') !== '0') {
      return errorResponse('INVALID_REQUEST', 400);
    }
    return jsonResponse(publicQueueMode(this.room));
  }

  async handleUpdateQueueMode(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, 128 * 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(parsed.value, [
        'coordinatorEpoch',
        'baseRevision',
        'playlistRevision',
        'repeatMode',
        'shuffleEnabled',
        'shuffleOrder',
      ]) ||
      !isSafeNonNegativeInteger(parsed.value.coordinatorEpoch) ||
      !isSafeNonNegativeInteger(parsed.value.baseRevision) ||
      !isSafeNonNegativeInteger(parsed.value.playlistRevision)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (
      this.room.presence.coordinatorParticipantId !== auth.session.participantId ||
      this.room.presence.coordinatorEpoch !== parsed.value.coordinatorEpoch
    ) {
      return errorResponse('COORDINATOR_EPOCH_MISMATCH', 409);
    }
    if (parsed.value.playlistRevision !== this.room.playlistRevision) {
      return jsonResponse(
        { error: 'PLAYLIST_REVISION_CONFLICT', queueMode: publicQueueMode(this.room) },
        409,
      );
    }
    if (parsed.value.baseRevision !== this.room.queueMode.revision) {
      return jsonResponse(
        { error: 'QUEUE_MODE_REVISION_CONFLICT', queueMode: publicQueueMode(this.room) },
        409,
      );
    }
    const queueMode = parseQueueModeValues(
      {
        repeatMode: parsed.value.repeatMode,
        shuffleEnabled: parsed.value.shuffleEnabled,
        shuffleOrder: parsed.value.shuffleOrder,
      },
      this.room.playlist,
    );
    if (!queueMode) return errorResponse('INVALID_QUEUE_MODE', 400);
    if (
      queueMode.repeatMode === this.room.queueMode.repeatMode &&
      queueMode.shuffleEnabled === this.room.queueMode.shuffleEnabled &&
      queueMode.shuffleOrder.length === this.room.queueMode.shuffleOrder.length &&
      queueMode.shuffleOrder.every(
        (queueItemId, index) => queueItemId === this.room.queueMode.shuffleOrder[index],
      )
    ) {
      return jsonResponse(publicQueueMode(this.room));
    }
    if (this.room.queueMode.revision >= Number.MAX_SAFE_INTEGER) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }
    this.room.queueMode = {
      revision: this.room.queueMode.revision + 1,
      updatedAtMs: Date.now(),
      ...queueMode,
    };
    await this.persist();
    return jsonResponse(publicQueueMode(this.room));
  }

  systemAudioResponse(extra = {}) {
    return jsonResponse({ systemAudio: publicSystemAudio(this.room.systemAudio), ...extra });
  }

  isSystemAudioOwner(auth) {
    const state = this.room.systemAudio;
    return (
      state.status !== 'idle' &&
      state.ownerParticipantId === auth.session.participantId &&
      state.ownerPresenceIncarnationId === auth.participant?.presenceIncarnationId
    );
  }

  clearSystemAudioLease() {
    const currentGeneration = isSafeNonNegativeInteger(this.room.systemAudio?.generation)
      ? this.room.systemAudio.generation
      : 0;
    const nextGeneration =
      currentGeneration < Number.MAX_SAFE_INTEGER ? currentGeneration + 1 : currentGeneration;
    this.room.systemAudio = initialSystemAudioState(nextGeneration);
    return true;
  }

  reconcileSystemAudio(nowMs) {
    const state = this.room.systemAudio;
    if (!state || state.status === 'idle') return false;
    const owner = this.room.presence.participants[state.ownerParticipantId];
    const ownerMissingOrSuperseded =
      !owner || owner.presenceIncarnationId !== state.ownerPresenceIncarnationId;
    const overDeviceLimit =
      Object.keys(this.room.presence.participants).length > SYSTEM_AUDIO_MAX_PRESENCE_ITEMS;
    const expired =
      (state.status === 'preparing' &&
        (!Number.isSafeInteger(state.claimExpiresAt) || state.claimExpiresAt <= nowMs)) ||
      (state.status === 'live' &&
        (!Number.isSafeInteger(state.liveExpiresAt) || state.liveExpiresAt <= nowMs));
    if (!ownerMissingOrSuperseded && !overDeviceLimit && !expired) return false;
    return this.clearSystemAudioLease();
  }

  validateSystemAudioLease(auth, generation, leaseId) {
    if (!isSafeNonNegativeInteger(generation) || !SYSTEM_AUDIO_LEASE_ID_RE.test(leaseId || '')) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (generation !== this.room.systemAudio.generation) {
      return errorResponse('SYSTEM_AUDIO_GENERATION_MISMATCH', 409);
    }
    if (!this.isSystemAudioOwner(auth)) {
      return errorResponse('SYSTEM_AUDIO_NOT_OWNER', 409);
    }
    if (!constantTimeEqual(leaseId, this.room.systemAudio.leaseId || '')) {
      return errorResponse('SYSTEM_AUDIO_LEASE_INVALID', 409);
    }
    return null;
  }

  async handleGetSystemAudio(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    if (request.body && (request.headers.get('content-length') || '') !== '0') {
      return errorResponse('INVALID_REQUEST', 400);
    }
    return this.systemAudioResponse();
  }

  async handleAcquireSystemAudio(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (!hasExactKeys(parsed.value, [])) return errorResponse('INVALID_REQUEST', 400);
    if (Object.keys(this.room.presence.participants).length > SYSTEM_AUDIO_MAX_PRESENCE_ITEMS) {
      return errorResponse('SYSTEM_AUDIO_DEVICE_LIMIT', 409);
    }

    if (this.room.systemAudio.status !== 'idle') {
      if (!this.isSystemAudioOwner(auth)) {
        return errorResponse('SYSTEM_AUDIO_OWNER_ACTIVE', 409);
      }
      auth.participant.lastSeenAtMs = Date.now();
      await this.persist();
      return this.systemAudioResponse({ leaseId: this.room.systemAudio.leaseId });
    }
    if (this.room.systemAudio.generation >= Number.MAX_SAFE_INTEGER) {
      return errorResponse('SYSTEM_AUDIO_GENERATION_EXHAUSTED', 409);
    }

    const nowMs = Date.now();
    this.room.systemAudio = {
      generation: this.room.systemAudio.generation + 1,
      status: 'preparing',
      ownerParticipantId: auth.session.participantId,
      ownerPresenceIncarnationId: auth.participant.presenceIncarnationId,
      leaseId: randomToken(32),
      claimExpiresAt: nowMs + SYSTEM_AUDIO_CLAIM_TTL_MS,
      liveExpiresAt: null,
      publication: null,
    };
    auth.participant.lastSeenAtMs = nowMs;
    await this.persist();
    return this.systemAudioResponse({ leaseId: this.room.systemAudio.leaseId });
  }

  async handleCommitSystemAudio(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (!hasExactKeys(parsed.value, ['generation', 'leaseId', 'publication'])) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const publication = parseSystemAudioPublication(parsed.value.publication);
    if (!publication) return errorResponse('INVALID_REQUEST', 400);
    const leaseError = this.validateSystemAudioLease(
      auth,
      parsed.value.generation,
      parsed.value.leaseId,
    );
    if (leaseError) return leaseError;

    if (this.room.systemAudio.status === 'live') {
      if (JSON.stringify(this.room.systemAudio.publication) !== JSON.stringify(publication)) {
        return errorResponse('SYSTEM_AUDIO_ALREADY_COMMITTED', 409);
      }
      return this.systemAudioResponse();
    }
    if (this.room.systemAudio.status !== 'preparing') {
      return errorResponse('SYSTEM_AUDIO_INVALID_TRANSITION', 409);
    }

    const nowMs = Date.now();
    this.room.systemAudio.status = 'live';
    this.room.systemAudio.claimExpiresAt = null;
    this.room.systemAudio.liveExpiresAt = nowMs + SYSTEM_AUDIO_LIVE_TTL_MS;
    this.room.systemAudio.publication = publication;
    auth.participant.lastSeenAtMs = nowMs;
    await this.persist();
    return this.systemAudioResponse();
  }

  async handleHeartbeatSystemAudio(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (!hasExactKeys(parsed.value, ['generation', 'leaseId'])) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const leaseError = this.validateSystemAudioLease(
      auth,
      parsed.value.generation,
      parsed.value.leaseId,
    );
    if (leaseError) return leaseError;
    auth.participant.lastSeenAtMs = Date.now();
    await this.persist();
    return this.systemAudioResponse();
  }

  async handleReleaseSystemAudio(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (!hasExactKeys(parsed.value, ['generation', 'leaseId'])) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const leaseError = this.validateSystemAudioLease(
      auth,
      parsed.value.generation,
      parsed.value.leaseId,
    );
    if (leaseError) return leaseError;
    this.clearSystemAudioLease();
    await this.persist();
    return this.systemAudioResponse();
  }

  joinPresence(session, tokenHash, nowMs) {
    const existing = this.room.presence.participants[session.participantId];
    if (existing) {
      existing.lastSeenAtMs = nowMs;
      session.presenceIncarnationId = existing.presenceIncarnationId;
      return false;
    }
    if (Object.keys(this.room.presence.participants).length >= PRESENCE_MAX_ITEMS) return null;
    const wasSleeping = this.room.runtime === 'sleeping';
    const presenceIncarnationId = `presence_${randomToken(18)}`;
    session.presenceIncarnationId = presenceIncarnationId;
    this.room.presence.participants[session.participantId] = {
      participantId: session.participantId,
      presenceIncarnationId,
      memberId: session.memberId,
      sessionHash: tokenHash,
      displayName: session.displayName,
      role: session.role,
      joinedAtMs: nowMs,
      lastSeenAtMs: nowMs,
      developerControlVersion: 0,
    };
    this.room.runtime = 'awake';
    this.room.presence.revision += 1;
    if (!this.room.presence.coordinatorParticipantId) {
      this.room.presence.coordinatorParticipantId = session.participantId;
      this.bumpCoordinatorEpoch(nowMs, wasSleeping);
    }
    this.reconcileSystemAudio(nowMs);
    this.room.revision += 1;
    return true;
  }

  enterPresence(session, tokenHash, nowMs, takeover = false) {
    const existing = this.room.presence.participants[session.participantId];
    if (!existing) {
      return this.joinPresence(session, tokenHash, nowMs) === null ? 'room-full' : 'entered';
    }
    if (existing.sessionHash !== tokenHash) return 'identity-mismatch';

    // A room cookie is shared by every tab in the same browser profile. Do
    // not let an ordinary resume silently rotate the live tab's incarnation:
    // doing so repeatedly replaces signaling sockets and, for a coordinator,
    // advances the room epoch until the whole topology becomes unstable. A
    // takeover is therefore an explicit, user-confirmed operation.
    if (!takeover) return 'active-elsewhere';

    // A resumed tab is a new presence incarnation even though its long-lived
    // HttpOnly session and participant identity are intentionally reused.
    // Rotating this nonce fences every active request captured by the prior
    // tab. A coordinator re-entry also advances the epoch exactly once: the
    // signaling Worker then closes every prior-epoch socket so legacy RTC data
    // channels cannot survive as a split-brain control plane. Member re-entry
    // deliberately leaves the room-wide epoch untouched.
    const presenceIncarnationId = `presence_${randomToken(18)}`;
    session.presenceIncarnationId = presenceIncarnationId;
    existing.presenceIncarnationId = presenceIncarnationId;
    existing.developerControlVersion = 0;
    existing.joinedAtMs = nowMs;
    existing.lastSeenAtMs = nowMs;
    if (this.room.presence.coordinatorParticipantId === session.participantId) {
      this.bumpCoordinatorEpoch(nowMs);
    }
    this.reconcileSystemAudio(nowMs);
    this.room.presence.revision += 1;
    this.room.revision += 1;
    return 'entered';
  }

  fenceDeveloperCommands(resultCode, nowMs = Date.now()) {
    let changed = false;
    for (const command of Object.values(this.room.developerCommands || {})) {
      if (command.status !== 'pending' && command.status !== 'dispatched') continue;
      this.completeDeveloperCommand(command, 'rejected', resultCode, nowMs);
      changed = true;
    }
    return changed;
  }

  bumpCoordinatorEpoch(nowMs, waking = false) {
    this.fenceDeveloperCommands('coordinator_changed', nowMs);
    this.room.presence.coordinatorEpoch += 1;
    this.room.playback.coordinatorEpoch = this.room.presence.coordinatorEpoch;
    this.room.playback.revision += 1;
    if (this.room.playback.state === 'playing' && waking) this.room.playback.updatedAtMs = nowMs;
  }

  freezePlayback(nowMs) {
    if (this.room.playback.state === 'playing' && this.room.playback.updatedAtMs > 0) {
      this.room.playback.positionSeconds = Math.min(
        PLAYBACK_MAX_POSITION_SECONDS,
        this.room.playback.positionSeconds +
          Math.max(0, (nowMs - this.room.playback.updatedAtMs) / 1000),
      );
      this.room.playback.updatedAtMs = nowMs;
      this.room.playback.revision += 1;
    }
  }

  decommissionPurgeAfterMs(nowMs) {
    const presignTtlMs =
      configuredNumber(this.env.PRESIGN_TTL_SECONDS, PRESIGN_TTL_SECONDS, 60, 3600) * 1000;
    let purgeAfterMs = nowMs + presignTtlMs + 5_000;
    for (const asset of Object.values(this.room.assets || {})) {
      if (Number.isSafeInteger(asset.expiresAtMs)) {
        purgeAfterMs = Math.max(purgeAfterMs, asset.expiresAtMs + 5_000);
      }
      if (Number.isSafeInteger(asset.uploadExpiresAtMs)) {
        purgeAfterMs = Math.max(purgeAfterMs, asset.uploadExpiresAtMs + 5_000);
      }
      if (Number.isSafeInteger(asset.stagingCleanupAfterMs)) {
        purgeAfterMs = Math.max(purgeAfterMs, asset.stagingCleanupAfterMs);
      }
    }
    for (const tombstone of Object.values(this.room.stagingTombstones || {})) {
      if (Number.isSafeInteger(tombstone.cleanupAfterMs)) {
        purgeAfterMs = Math.max(purgeAfterMs, tombstone.cleanupAfterMs);
      }
    }
    return purgeAfterMs;
  }

  decommissionFinalEmptyWindowMs() {
    return (
      configuredNumber(
        this.env.DECOMMISSION_FINAL_EMPTY_WINDOW_SECONDS,
        DECOMMISSION_FINAL_EMPTY_WINDOW_SECONDS,
        60,
        24 * 60 * 60,
      ) * 1000
    );
  }

  async purgeDecommissionedMediaPrefix() {
    const bucket = this.env.PRO_MEDIA_BUCKET;
    if (!bucket || typeof bucket.list !== 'function' || typeof bucket.delete !== 'function') {
      return { ok: false, deletedAny: false };
    }
    const prefix = `rooms/${this.room.roomCode}/`;
    let deletedAny = false;
    try {
      // Re-read the first page after every batch. Deleting while following an
      // old cursor can skip keys when the listing contracts underneath it.
      for (let round = 0; round < 32; round += 1) {
        const page = await bucket.list({ prefix, limit: 1000 });
        const keys = Array.isArray(page?.objects)
          ? page.objects.map((object) => object?.key).filter((key) => typeof key === 'string')
          : [];
        if (keys.length === 0) return { ok: true, deletedAny };
        deletedAny = true;
        await bucket.delete(keys);
      }
      return { ok: false, deletedAny };
    } catch {
      return { ok: false, deletedAny };
    }
  }

  async decommissionSignaling(requestId) {
    const namespace = this.env.PRO_SIGNALING_ROOMS;
    if (!namespace || typeof namespace.idFromName !== 'function') return false;
    try {
      const stub = namespace.get(namespace.idFromName(this.room.roomCode));
      const response = await stub.fetch(
        new Request('https://signaling.internal/internal/admin/v1/decommission', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': this.room.roomCode,
          },
          body: JSON.stringify({ roomCode: this.room.roomCode, requestId }),
        }),
      );
      const payload = await response
        .clone()
        .json()
        .catch(() => null);
      return (
        response.ok &&
        payload?.ok === true &&
        payload.roomCode === this.room.roomCode &&
        payload.status === 'decommissioned'
      );
    } catch {
      return false;
    }
  }

  async deleteDeveloperRoomData(requestId, nowMs = Date.now()) {
    const db = this.env.DEVELOPER_API_DB;
    if (!db?.prepare) return false;
    try {
      // Fence new credentials and audit writes before deleting existing rows.
      // The tombstone is permanent because a decommissioned room code is never
      // reused.
      await db
        .prepare(
          `INSERT INTO mxqr_developer_api_room_tombstones
            (room_code, request_id, decommissioned_at)
           VALUES (?1, ?2, ?3)
           ON CONFLICT(room_code) DO UPDATE SET
             request_id = excluded.request_id,
             decommissioned_at = MIN(
               mxqr_developer_api_room_tombstones.decommissioned_at,
               excluded.decommissioned_at
             )`,
        )
        .bind(this.room.roomCode, requestId, nowMs)
        .run();
      for (const table of [
        'mxqr_developer_api_keys',
        'mxqr_developer_api_audit',
        'mxqr_developer_api_admin_audit',
      ]) {
        await db
          .prepare(`DELETE FROM ${table} WHERE room_code = ?1`)
          .bind(this.room.roomCode)
          .run();
      }
      return true;
    } catch {
      return false;
    }
  }

  async clearDeveloperRoomLimiter(requestId) {
    const namespace = this.env.DEVELOPER_API_LIMITERS;
    if (!namespace || typeof namespace.idFromName !== 'function') return false;
    try {
      const stub = namespace.get(namespace.idFromName(`room:${this.room.roomCode}`));
      const response = await stub.fetch(
        new Request('https://developer-api.internal/internal/admin/v1/decommission', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': this.room.roomCode,
          },
          body: JSON.stringify({ roomCode: this.room.roomCode, requestId }),
        }),
      );
      const payload = await response
        .clone()
        .json()
        .catch(() => null);
      return response.ok && payload?.ok === true && payload.roomCode === this.room.roomCode;
    } catch {
      return false;
    }
  }

  async markRegistryDecommissioned(nowMs) {
    const db = this.env.MUSIXQUARE_ADMIN_DB || this.env.ADMIN_METRICS_DB || null;
    if (!db?.prepare) return false;
    try {
      await db
        .prepare(
          `INSERT INTO mxqr_pro_room_registry
            (room_code, label, status, activation_state, created_at, updated_at)
           VALUES (?1, 'Decommissioned PRO room', 'decommissioned', 'unactivated', ?2, ?2)
           ON CONFLICT(room_code) DO UPDATE SET
             label = 'Decommissioned PRO room',
             status = 'decommissioned',
             activation_state = 'unactivated',
             updated_at = excluded.updated_at`,
        )
        .bind(this.room.roomCode, nowMs)
        .run();
      const statement = db
        .prepare(
          `SELECT status FROM mxqr_pro_room_registry
           WHERE room_code = ?1 LIMIT 1`,
        )
        .bind(this.room.roomCode);
      const row =
        typeof statement.first === 'function'
          ? await statement.first()
          : (await statement.all())?.results?.[0] || null;
      return row?.status === 'decommissioned';
    } catch {
      return false;
    }
  }

  async maintainDecommissionedTombstone(nowMs = Date.now()) {
    if (this.room.status !== 'decommissioned' || !this.room.decommission) return false;
    const requestId = this.room.decommission.requestId;
    const media = await this.purgeDecommissionedMediaPrefix();
    const signaling = await this.decommissionSignaling(requestId);
    const developerData = await this.deleteDeveloperRoomData(requestId, nowMs);
    const developerLimiter = await this.clearDeveloperRoomLimiter(requestId);
    const registry = await this.markRegistryDecommissioned(nowMs);
    const repaired = media.ok && signaling && developerData && developerLimiter && registry;
    this.room.decommission.maintenanceAtMs =
      nowMs + (repaired ? DECOMMISSION_TOMBSTONE_MAINTENANCE_MS : DECOMMISSION_RETRY_MS);
    await this.persist();
    return repaired;
  }

  async continueDecommission(nowMs = Date.now()) {
    if (this.room.status !== 'decommissioning' || !this.room.decommission) {
      return this.room.status === 'decommissioned';
    }
    const job = this.room.decommission;

    if (!job.signalingCleared) {
      job.signalingCleared = await this.decommissionSignaling(job.requestId);
    }
    if (!job.initialSweepCompleted) {
      job.initialSweepCompleted = (await this.purgeDecommissionedMediaPrefix()).ok;
    }
    if (!job.developerDataCleared) {
      job.developerDataCleared = await this.deleteDeveloperRoomData(job.requestId, nowMs);
    }
    if (!job.developerLimiterCleared) {
      job.developerLimiterCleared = await this.clearDeveloperRoomLimiter(job.requestId);
    }

    if (nowMs < job.purgeAfterMs) {
      job.retryAtMs =
        job.signalingCleared &&
        job.initialSweepCompleted &&
        job.developerDataCleared &&
        job.developerLimiterCleared
          ? job.purgeAfterMs
          : Math.min(job.purgeAfterMs, nowMs + DECOMMISSION_RETRY_MS);
      await this.persist();
      return false;
    }

    // Repeat every externally writable cleanup after the URL-expiry fence.
    // Requests that authenticated just before decommission may otherwise
    // finish after the initial pass and recreate audit/limiter state.
    const finalSweep = await this.purgeDecommissionedMediaPrefix();
    job.developerDataCleared = await this.deleteDeveloperRoomData(job.requestId, nowMs);
    job.developerLimiterCleared = await this.clearDeveloperRoomLimiter(job.requestId);
    job.signalingCleared = await this.decommissionSignaling(job.requestId);
    if (
      !job.signalingCleared ||
      !job.developerDataCleared ||
      !job.developerLimiterCleared ||
      !finalSweep.ok
    ) {
      job.finalEmptySinceMs = null;
      job.retryAtMs = nowMs + DECOMMISSION_RETRY_MS;
      await this.persist();
      return false;
    }
    if (finalSweep.deletedAny || !Number.isSafeInteger(job.finalEmptySinceMs)) {
      job.finalEmptySinceMs = nowMs;
    }
    const finalEmptyAtMs = job.finalEmptySinceMs + this.decommissionFinalEmptyWindowMs();
    if (nowMs < finalEmptyAtMs) {
      job.retryAtMs = Math.min(finalEmptyAtMs, nowMs + DECOMMISSION_RETRY_MS);
      await this.persist();
      return false;
    }
    if (!(await this.markRegistryDecommissioned(nowMs))) {
      job.retryAtMs = nowMs + DECOMMISSION_RETRY_MS;
      await this.persist();
      return false;
    }

    this.room.status = 'decommissioned';
    this.room.decommission = {
      requestId: job.requestId,
      startedAtMs: job.startedAtMs,
      completedAtMs: nowMs,
      maintenanceAtMs: nowMs + DECOMMISSION_TOMBSTONE_MAINTENANCE_MS,
    };
    await this.persist();
    return true;
  }

  async handleInternalDecommission(request) {
    const parsed = await readJsonBody(request, SMALL_REQUEST_MAX_BYTES);
    if (
      parsed.error ||
      !hasExactKeys(parsed.value, ['roomCode', 'requestId']) ||
      parsed.value.roomCode !== this.room.roomCode ||
      !ADMIN_REQUEST_ID_RE.test(parsed.value.requestId)
    ) {
      return errorResponse(parsed.error || 'INVALID_REQUEST', parsed.status || 400);
    }
    if (this.room.status === 'decommissioned') {
      return jsonResponse({
        ok: true,
        roomCode: this.room.roomCode,
        status: 'decommissioned',
        changed: false,
        completedAtMs: this.room.decommission?.completedAtMs || null,
      });
    }
    if (this.room.status === 'decommissioning') {
      await this.continueDecommission(Date.now());
      return jsonResponse(
        {
          ok: true,
          roomCode: this.room.roomCode,
          status: this.room.status,
          changed: false,
          purgeAfterMs: this.room.decommission?.purgeAfterMs || null,
          completedAtMs: this.room.decommission?.completedAtMs || null,
        },
        this.room.status === 'decommissioned' ? 200 : 202,
      );
    }
    if (
      !this.env.PRO_MEDIA_BUCKET?.list ||
      !this.env.PRO_MEDIA_BUCKET?.delete ||
      !this.env.PRO_SIGNALING_ROOMS?.idFromName ||
      !this.env.DEVELOPER_API_DB?.prepare ||
      !this.env.DEVELOPER_API_LIMITERS?.idFromName ||
      !(this.env.MUSIXQUARE_ADMIN_DB || this.env.ADMIN_METRICS_DB)?.prepare
    ) {
      return errorResponse('PRO_ROOM_DECOMMISSION_NOT_CONFIGURED', 503);
    }

    const nowMs = Date.now();
    const purgeAfterMs = this.decommissionPurgeAfterMs(nowMs);
    const previousActivationGeneration = Number.isSafeInteger(this.room.activationClaimGeneration)
      ? this.room.activationClaimGeneration
      : 0;
    const previousAuthEpoch = Number.isSafeInteger(this.room.authEpoch) ? this.room.authEpoch : 0;
    const tombstone = initialRoomState(this.room.roomCode, false);
    tombstone.status = 'decommissioning';
    tombstone.activationClaimGeneration = Math.min(
      Number.MAX_SAFE_INTEGER,
      previousActivationGeneration + 1,
    );
    tombstone.authEpoch = Math.min(Number.MAX_SAFE_INTEGER, previousAuthEpoch + 1);
    tombstone.decommission = {
      requestId: parsed.value.requestId,
      startedAtMs: nowMs,
      purgeAfterMs,
      retryAtMs: nowMs,
      signalingCleared: false,
      initialSweepCompleted: false,
      developerDataCleared: false,
      developerLimiterCleared: false,
      finalEmptySinceMs: null,
    };
    this.room = tombstone;
    await this.persist();
    await this.continueDecommission(nowMs);
    return jsonResponse(
      {
        ok: true,
        roomCode: this.room.roomCode,
        status: this.room.status,
        changed: true,
        purgeAfterMs: this.room.decommission?.purgeAfterMs || null,
        completedAtMs: this.room.decommission?.completedAtMs || null,
      },
      this.room.status === 'decommissioned' ? 200 : 202,
    );
  }

  internalAdminStateResponse(changed) {
    return jsonResponse({
      ok: true,
      roomCode: this.room.roomCode,
      status: this.room.status,
      changed,
    });
  }

  async handleInternalSuspend() {
    if (!this.room.provisioned) return errorResponse('ROOM_NOT_FOUND', 404);
    if (this.room.status === 'suspended') return this.internalAdminStateResponse(false);
    if (this.room.status !== 'active') return errorResponse('ROOM_NOT_ACTIVE', 409);
    const playbackRevisionSteps =
      this.room.playback.state === 'playing' && this.room.playback.updatedAtMs > 0 ? 2 : 1;
    if (
      this.room.authEpoch >= Number.MAX_SAFE_INTEGER ||
      this.room.revision >= Number.MAX_SAFE_INTEGER ||
      this.room.presence.revision >= Number.MAX_SAFE_INTEGER ||
      this.room.presence.coordinatorEpoch >= Number.MAX_SAFE_INTEGER ||
      this.room.playback.revision > Number.MAX_SAFE_INTEGER - playbackRevisionSteps
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }

    const nowMs = Date.now();
    this.freezePlayback(nowMs);

    // Suspension is an authorization and topology fence, not data deletion.
    // Playlist, media assets, PIN, and the owner recovery credential remain in
    // the room while every transient browser/session identity is discarded.
    this.room.sessions = {};
    this.room.presence.participants = {};
    this.room.presence.coordinatorParticipantId = null;
    this.room.presence.revision += 1;
    this.room.authEpoch += 1;
    this.room.runtime = 'sleeping';
    this.reconcileSystemAudio(nowMs);
    this.bumpCoordinatorEpoch(nowMs);
    this.room.status = 'suspended';
    this.room.revision += 1;
    await this.persist();
    return this.internalAdminStateResponse(true);
  }

  async handleInternalResume() {
    if (!this.room.provisioned) return errorResponse('ROOM_NOT_FOUND', 404);
    if (this.room.status === 'active') return this.internalAdminStateResponse(false);
    if (this.room.status !== 'suspended') return errorResponse('ROOM_NOT_SUSPENDED', 409);
    if (this.room.revision >= Number.MAX_SAFE_INTEGER) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }

    // A resumed room is available for fresh PIN authentication only. No old
    // presence, cookie session, coordinator, or system-audio lease is revived.
    this.room.sessions = {};
    this.room.presence.participants = {};
    this.room.presence.coordinatorParticipantId = null;
    this.room.runtime = 'sleeping';
    this.reconcileSystemAudio(Date.now());
    this.room.status = 'active';
    this.room.revision += 1;
    await this.persist();
    return this.internalAdminStateResponse(true);
  }

  removePresence(participantId, nowMs) {
    if (!this.room.presence.participants[participantId]) return false;
    const wasCoordinator = this.room.presence.coordinatorParticipantId === participantId;
    delete this.room.presence.participants[participantId];
    this.reconcileSystemAudio(nowMs);
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
    if (
      !claimValid ||
      claimValid.generation !== this.room.activationClaimGeneration ||
      !temporaryPinValid
    ) {
      return errorResponse('ACTIVATION_INVALID', 401);
    }

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
    this.markRegistryActivationActive();
    const response = jsonResponse({ snapshot: publicSnapshot(this.room, created.session) }, 200, {
      'set-cookie': sessionCookie(this.room.roomCode, created.token, this.sessionTtlSeconds()),
    });
    response.headers.append('set-cookie', ownerCookie(this.room.roomCode, ownerCredential.token));
    return response;
  }

  async handleOwnerRecovery(request) {
    if (this.room.status !== 'active') return errorResponse('RECOVERY_UNAVAILABLE', 409);
    const rateError = await this.applyRateLimit(request, 'owner-recovery', 10, 60 * 60 * 1000);
    if (rateError) return rateError;
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (!hasExactKeys(parsed.value, ['claimToken'], ['displayName'])) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const displayName =
      parsed.value.displayName === undefined
        ? 'Owner'
        : boundedString(parsed.value.displayName, MAX_DISPLAY_NAME_LENGTH);
    if (!displayName) return errorResponse('INVALID_REQUEST', 400);
    const activationSecret = String(this.env.PRO_ROOM_ACTIVATION_SECRET || '');
    if (
      activationSecret.length < 32 ||
      String(this.env.PRO_ROOM_SESSION_SECRET || '').length < 32
    ) {
      return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    }
    const nowMs = Date.now();
    const claim = await verifyOwnerRecoveryClaim(
      parsed.value.claimToken,
      this.room.roomCode,
      activationSecret,
      nowMs,
    );
    if (!claim) return errorResponse('RECOVERY_INVALID', 401);
    const nonceHash = await sha256Base64Url(`owner-recovery:${claim.nonce}`);
    if (this.room.consumedRecoveryNonces[nonceHash]) {
      return errorResponse('RECOVERY_CLAIM_USED', 409);
    }
    if (Object.keys(this.room.consumedRecoveryNonces).length >= RECOVERY_NONCE_MAX_ITEMS) {
      return errorResponse('RECOVERY_CAPACITY_EXCEEDED', 409);
    }

    for (const [tokenHash, session] of Object.entries(this.room.sessions)) {
      if (session.role !== 'owner') continue;
      this.removePresence(session.participantId, nowMs);
      delete this.room.sessions[tokenHash];
    }
    const ownerCredential = await this.createOwnerCredential();
    const created = await this.createSessionRecord(
      'owner',
      displayName,
      nowMs,
      this.room.ownerMemberId,
    );
    if (!created || !ownerCredential) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    this.room.ownerCredentialHash = ownerCredential.hash;
    this.room.consumedRecoveryNonces[nonceHash] = claim.exp;
    this.joinPresence(created.session, created.tokenHash, nowMs);
    await this.persist();
    const response = jsonResponse({ snapshot: publicSnapshot(this.room, created.session) }, 200, {
      'set-cookie': sessionCookie(this.room.roomCode, created.token, this.sessionTtlSeconds()),
    });
    response.headers.append('set-cookie', ownerCookie(this.room.roomCode, ownerCredential.token));
    return response;
  }

  async handleCreateSession(request) {
    if (this.room.status === 'unactivated') return errorResponse('ACTIVATION_REQUIRED', 409);
    if (this.room.status === 'suspended') return errorResponse('ROOM_SUSPENDED', 423);
    const rateError = this.readRateLimit(request, 'pin-failure', 10);
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
    if (!(await verifyPin(body.pin, this.room.pin, pepper))) {
      this.recordRateLimitHit(request, 'pin-failure', 60 * 60 * 1000);
      await this.persist();
      return errorResponse('PIN_INVALID', 401);
    }
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
      {
        'set-cookie': sessionCookie(this.room.roomCode, created.token, this.sessionTtlSeconds()),
      },
    );
  }

  async handleGetSnapshot(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    return jsonResponse({ snapshot: publicSnapshot(this.room, auth.session) });
  }

  async handleEnterPresence(request) {
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    let takeover = false;
    const parsed = await this.parseBody(request, SMALL_REQUEST_MAX_BYTES, false, true);
    if (parsed.response) return parsed.response;
    if (!parsed.empty) {
      if (!hasExactKeys(parsed.value, ['takeover']) || parsed.value.takeover !== true) {
        return errorResponse('INVALID_REQUEST', 400);
      }
      takeover = true;
    }
    const entered = this.enterPresence(auth.session, auth.tokenHash, Date.now(), takeover);
    if (entered === 'room-full') return errorResponse('ROOM_FULL', 409);
    if (entered === 'active-elsewhere') {
      return errorResponse('PRESENCE_ACTIVE_ELSEWHERE', 409);
    }
    if (entered === 'identity-mismatch') {
      return errorResponse('PRESENCE_IDENTITY_MISMATCH', 409);
    }
    await this.persist();
    return jsonResponse({ snapshot: publicSnapshot(this.room, auth.session) });
  }

  async handleCloseSession(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    this.removePresence(auth.session.participantId, Date.now());
    delete this.room.sessions[auth.tokenHash];
    await this.persist();
    // The browser token is inert once its exact server record is removed. Do
    // not return a same-name cookie tombstone: a delayed response could arrive
    // after a replacement tab has installed a new room cookie and erase it.
    return jsonResponse({ ok: true });
  }

  async handleCloseSessionFenced(request) {
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, UNLOAD_CLOSE_REQUEST_MAX_BYTES, true);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (
      !hasExactKeys(body, ['expectedParticipantId', 'expectedPresenceIncarnationId']) ||
      typeof body.expectedParticipantId !== 'string' ||
      !OPAQUE_ID_RE.test(body.expectedParticipantId) ||
      typeof body.expectedPresenceIncarnationId !== 'string' ||
      !OPAQUE_ID_RE.test(body.expectedPresenceIncarnationId)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (
      auth.session.participantId !== body.expectedParticipantId ||
      auth.session.presenceIncarnationId !== body.expectedPresenceIncarnationId
    ) {
      return errorResponse('PRESENCE_IDENTITY_MISMATCH', 409);
    }
    const participant = this.room.presence.participants[body.expectedParticipantId];
    if (
      participant &&
      (participant.sessionHash !== auth.tokenHash ||
        participant.presenceIncarnationId !== body.expectedPresenceIncarnationId)
    ) {
      return errorResponse('PRESENCE_IDENTITY_MISMATCH', 409);
    }

    // The atomic presence close may already have removed the participant. The
    // session deliberately retains its last incarnation so this second phase
    // can still revoke exactly the server record represented by that cookie,
    // while a newer explicit enter rotates the value and fences this request
    // with a harmless 409.
    this.removePresence(body.expectedParticipantId, Date.now());
    delete this.room.sessions[auth.tokenHash];
    await this.persist();
    // Do not emit a cookie tombstone here. This response may arrive after a
    // different tab has authenticated again and installed a newer cookie with
    // the same room-scoped name; a delayed Max-Age=0 header would erase that
    // replacement even though the server mutation was correctly fenced to the
    // captured session/incarnation. The exact server-side session is already
    // revoked above, so leaving its now-inert browser token is the safe choice.
    return jsonResponse({ ok: true });
  }

  async handleChangePin(request) {
    const auth = await this.requireSession(request, { owner: true, activePresence: true });
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
    const nowMs = Date.now();
    for (const tokenHash of Object.keys(this.room.sessions)) {
      if (tokenHash === auth.tokenHash) continue;
      delete this.room.sessions[tokenHash];
    }
    // Revoke every other participant atomically. Calling removePresence in a
    // loop would briefly elect M1, then M2, then the owner and advance the
    // security epoch for each transient coordinator. No such intermediate
    // topology is externally valid during a PIN rotation.
    const ownerParticipant = auth.participant;
    ownerParticipant.lastSeenAtMs = nowMs;
    this.room.presence.participants = {
      [ownerSession.participantId]: ownerParticipant,
    };
    this.reconcileSystemAudio(nowMs);
    this.room.presence.coordinatorParticipantId = ownerSession.participantId;
    this.room.presence.revision += 1;
    this.room.runtime = 'awake';
    this.bumpCoordinatorEpoch(nowMs);
    this.room.revision += 1;
    await this.persist();
    return jsonResponse({ ok: true });
  }

  async handleHeartbeat(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const nowMs = Date.now();
    auth.participant.lastSeenAtMs = nowMs;
    await this.processDeveloperCommands(nowMs);
    await this.persist();
    return jsonResponse({ snapshot: publicSnapshot(this.room, auth.session) });
  }

  async handleLeavePresence(request) {
    const auth = await this.requireSession(request, { activePresence: true });
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

  async handleClosePresence(request) {
    // Keep the cookie session alive so a later tab can resume without asking
    // for the PIN. Only UI-driven explicit leave closes that session.
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, UNLOAD_CLOSE_REQUEST_MAX_BYTES, true);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (
      !hasExactKeys(body, [
        'idempotencyKey',
        'expectedParticipantId',
        'expectedPresenceIncarnationId',
        'baseRevision',
        'currentQueueItemId',
        'playback',
      ]) ||
      typeof body.idempotencyKey !== 'string' ||
      !IDEMPOTENCY_KEY_RE.test(body.idempotencyKey) ||
      typeof body.expectedParticipantId !== 'string' ||
      !OPAQUE_ID_RE.test(body.expectedParticipantId) ||
      typeof body.expectedPresenceIncarnationId !== 'string' ||
      !OPAQUE_ID_RE.test(body.expectedPresenceIncarnationId)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (auth.session.participantId !== body.expectedParticipantId) {
      return errorResponse('PRESENCE_IDENTITY_MISMATCH', 409);
    }

    const key = body.idempotencyKey;
    const mutation = {
      expectedParticipantId: body.expectedParticipantId,
      expectedPresenceIncarnationId: body.expectedPresenceIncarnationId,
      baseRevision: body.baseRevision,
      currentQueueItemId: body.currentQueueItemId,
      playback: body.playback,
    };
    // Scope replay to the captured presence incarnation and exact cookie
    // session. A processed old request may replay harmlessly after resume,
    // while a never-processed old request cannot target the new incarnation.
    const scope = `participant:${body.expectedParticipantId}:incarnation:${body.expectedPresenceIncarnationId}:session:${auth.tokenHash}:presence-close`;
    const fingerprint = await this.idempotencyFingerprint(scope, mutation);
    const replay = this.replayIdempotency(scope, key, fingerprint, auth.session);
    if (replay) return replay;
    const participant = this.room.presence.participants[body.expectedParticipantId];
    if (
      !participant ||
      participant.sessionHash !== auth.tokenHash ||
      participant.presenceIncarnationId !== body.expectedPresenceIncarnationId
    ) {
      return errorResponse('PRESENCE_IDENTITY_MISMATCH', 409);
    }
    if (!isSafeNonNegativeInteger(body.baseRevision) || body.baseRevision > this.room.revision) {
      return errorResponse('INVALID_REVISION', 400);
    }

    let checkpointChanged = false;
    if (body.playback === null) {
      if (body.currentQueueItemId !== null) return errorResponse('INVALID_PLAYBACK', 400);
    } else {
      if (this.room.presence.coordinatorParticipantId !== body.expectedParticipantId) {
        return errorResponse('COORDINATOR_REQUIRED', 403);
      }
      const playlistById = new Map(this.room.playlist.map((item) => [item.queueItemId, item]));
      const candidate = parsePlaybackCandidate(
        body.playback,
        playlistById,
        body.currentQueueItemId,
        this.room.presence.coordinatorEpoch,
      );
      if (!candidate) return errorResponse('INVALID_PLAYBACK', 400);

      const nowMs = Date.now();
      const semanticallyUnchanged =
        body.currentQueueItemId === this.room.currentQueueItemId &&
        playbackSemanticallyEqual(candidate, this.room.playback);
      if (
        !semanticallyUnchanged &&
        Math.abs(candidate.updatedAtMs - nowMs) > PLAYBACK_CLOCK_SKEW_MS
      ) {
        return errorResponse('INVALID_PLAYBACK', 400);
      }
      let accepted = parsePlayback(
        candidate,
        playlistById,
        body.currentQueueItemId,
        this.room.presence.coordinatorEpoch,
        this.room.playback,
        nowMs,
      );
      if (
        !accepted &&
        body.baseRevision < this.room.revision &&
        candidate.revision === this.room.playback.revision &&
        !semanticallyUnchanged &&
        this.room.playback.revision < Number.MAX_SAFE_INTEGER
      ) {
        // A periodic checkpoint can win the DO queue after pagehide captured
        // the same base revision. This is a sibling conflict, not an arbitrary
        // revision jump: rebase the fresh final observation exactly once so
        // presence never falls back to its TTL solely because of that race.
        accepted = {
          ...candidate,
          revision: this.room.playback.revision + 1,
          updatedAtMs: nowMs,
        };
      }
      if (accepted) {
        checkpointChanged =
          body.currentQueueItemId !== this.room.currentQueueItemId ||
          !playbackSemanticallyEqual(accepted, this.room.playback);
        this.room.currentQueueItemId = body.currentQueueItemId;
        this.room.playback = accepted;
      } else if (candidate.revision >= this.room.playback.revision) {
        // A narrowly stale unload can race an already-committed periodic
        // checkpoint. Older revisions are safe to ignore; equal/future
        // invalid revisions must never overwrite authoritative playback.
        return errorResponse('INVALID_PLAYBACK', 400);
      }
    }

    if (checkpointChanged) this.room.revision += 1;
    this.removePresence(body.expectedParticipantId, Date.now());
    const responseBody = { ok: true };
    this.storeIdempotency(scope, key, fingerprint, responseBody);
    await this.persist();
    return jsonResponse(responseBody);
  }

  async handleSignalingTicket(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, 1024, false, true);
    if (parsed.response) return parsed.response;
    const developerControlVersion = parsed.empty
      ? 0
      : hasExactKeys(parsed.value, ['developerControlVersion']) &&
          Number.isSafeInteger(parsed.value.developerControlVersion) &&
          parsed.value.developerControlVersion >= DEVELOPER_CONTROL_VERSION &&
          parsed.value.developerControlVersion <= DEVELOPER_CONTROL_MAX_VERSION
        ? parsed.value.developerControlVersion
        : null;
    if (developerControlVersion === null) return errorResponse('INVALID_REQUEST', 400);
    const previousControlVersion = auth.participant.developerControlVersion;
    auth.participant.developerControlVersion = developerControlVersion;
    if (
      previousControlVersion > developerControlVersion &&
      supportsDeveloperControl({ developerControlVersion: previousControlVersion }) &&
      this.room.presence.coordinatorParticipantId === auth.session.participantId
    ) {
      this.fenceDeveloperCommands('coordinator_incompatible', Date.now());
    }
    const secret = String(this.env.PRO_SIGNALING_SECRET || '');
    if (secret.length < 32) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    const nowMs = Date.now();
    const role =
      this.room.presence.coordinatorParticipantId === auth.session.participantId
        ? 'coordinator'
        : 'member';
    const issuedAtSeconds = Math.floor(nowMs / 1000);
    const expiresAtSeconds = issuedAtSeconds + SIGNALING_TICKET_TTL_SECONDS;
    const expiresAtMs = expiresAtSeconds * 1000;
    if (
      !Number.isSafeInteger(auth.session.signalingTicketSequence) ||
      auth.session.signalingTicketSequence >= Number.MAX_SAFE_INTEGER
    ) {
      return errorResponse('SIGNALING_TICKET_SEQUENCE_EXHAUSTED', 409);
    }
    const ticketSequence = auth.session.signalingTicketSequence + 1;
    auth.session.signalingTicketSequence = ticketSequence;
    const presenceIncarnationId = auth.participant.presenceIncarnationId;
    const ticket = await createProSignalingTicket(
      {
        v: 1,
        kind: 'pro-signaling',
        roomCode: this.room.roomCode,
        participantId: auth.session.participantId,
        role,
        coordinatorEpoch: this.room.presence.coordinatorEpoch,
        presenceIncarnationId,
        ticketSequence,
        developerControlVersion,
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
      presenceIncarnationId,
      ticketSequence,
    });
  }

  readIdempotencyKey(request) {
    const key = request.headers.get('idempotency-key') || '';
    return IDEMPOTENCY_KEY_RE.test(key) ? key : null;
  }

  async idempotencyFingerprint(scope, body) {
    return sha256Base64Url(`${scope}\n${JSON.stringify(body)}`);
  }

  replayIdempotency(scope, key, fingerprint, session = null, developerRequesterKeyId = null) {
    const record = this.room.idempotency[`${scope}:${key}`];
    if (!record) return null;
    if (!constantTimeEqual(record.fingerprint, fingerprint)) {
      return errorResponse('IDEMPOTENCY_CONFLICT', 409);
    }
    if (record.kind === 'snapshot') {
      return jsonResponse({ snapshot: publicSnapshot(this.room, session) }, record.status);
    }
    if (record.kind === 'developer-queue') {
      // The action is replayed from a compact receipt, while the response is
      // regenerated from authoritative state. Storing a full queue snapshot
      // per API mutation would duplicate up to 3 MiB in the room's 24-hour
      // idempotency ledger and make an otherwise healthy room unwritable.
      if (!DEVELOPER_API_KEY_ID_RE.test(developerRequesterKeyId || '')) {
        return errorResponse('ROOM_STATE_INVALID', 503);
      }
      return jsonResponse(
        developerProjection(this.room, 'queue', Date.now(), developerRequesterKeyId),
        record.status,
      );
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
    if (keys.length > IDEMPOTENCY_MAX_ITEMS) {
      keys
        .sort((left, right) => records[left].expiresAtMs - records[right].expiresAtMs)
        .slice(0, keys.length - IDEMPOTENCY_MAX_ITEMS)
        .forEach((oldKey) => delete records[oldKey]);
    }
  }

  storeSnapshotIdempotency(scope, key, fingerprint, committedRevision) {
    const records = this.room.idempotency;
    records[`${scope}:${key}`] = {
      fingerprint,
      kind: 'snapshot',
      committedRevision,
      status: 200,
      expiresAtMs: Date.now() + IDEMPOTENCY_TTL_MS,
    };
    const keys = Object.keys(records);
    if (keys.length > IDEMPOTENCY_MAX_ITEMS) {
      keys
        .sort((left, right) => records[left].expiresAtMs - records[right].expiresAtMs)
        .slice(0, keys.length - IDEMPOTENCY_MAX_ITEMS)
        .forEach((oldKey) => delete records[oldKey]);
    }
  }

  storeDeveloperQueueIdempotency(scope, key, fingerprint, status) {
    const records = this.room.idempotency;
    records[`${scope}:${key}`] = {
      fingerprint,
      kind: 'developer-queue',
      status,
      expiresAtMs: Date.now() + IDEMPOTENCY_TTL_MS,
    };
    const keys = Object.keys(records);
    if (keys.length > IDEMPOTENCY_MAX_ITEMS) {
      keys
        .sort((left, right) => records[left].expiresAtMs - records[right].expiresAtMs)
        .slice(0, keys.length - IDEMPOTENCY_MAX_ITEMS)
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
    const auth = await this.requireSession(request, { activePresence: true });
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
    const replay = this.replayIdempotency(scope, key, fingerprint, auth.session);
    if (replay) return replay;
    if (!isSafeNonNegativeInteger(body.baseRevision)) return errorResponse('INVALID_REVISION', 400);
    if (body.baseRevision !== this.room.revision) {
      return jsonResponse(
        { error: 'REVISION_CONFLICT', snapshot: publicSnapshot(this.room, auth.session) },
        409,
      );
    }
    const parsedPlaylist = parsePlaylist(body.playlist);
    if (!parsedPlaylist) return errorResponse('INVALID_PLAYLIST', 400);
    return this.commitParticipantSnapshot({
      auth,
      key,
      scope,
      fingerprint,
      playlist: parsedPlaylist,
      currentQueueItemId: body.currentQueueItemId,
      playbackInput: body.playback,
    });
  }

  async handleCompactSnapshotMutation(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const key = this.readIdempotencyKey(request);
    if (!key) return errorResponse('IDEMPOTENCY_KEY_REQUIRED', 400);
    const parsed = await this.parseBody(request, REQUEST_MAX_BYTES);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    if (
      !hasExactKeys(body, [
        'baseRevision',
        'playlistOrder',
        'upserts',
        'currentQueueItemId',
        'playback',
      ])
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const scope = `participant:${auth.session.participantId}:snapshot`;
    const fingerprint = await this.idempotencyFingerprint(scope, body);
    const replay = this.replayIdempotency(scope, key, fingerprint, auth.session);
    if (replay) return replay;
    if (!isSafeNonNegativeInteger(body.baseRevision)) return errorResponse('INVALID_REVISION', 400);
    if (body.baseRevision !== this.room.revision) {
      return jsonResponse(
        { error: 'REVISION_CONFLICT', snapshot: publicSnapshot(this.room, auth.session) },
        409,
      );
    }
    if (
      body.playlistOrder !== null &&
      (!Array.isArray(body.playlistOrder) || body.playlistOrder.length > PLAYLIST_MAX_ITEMS)
    ) {
      return errorResponse('INVALID_PLAYLIST', 400);
    }
    const playlistOrder = [];
    const requestedIds = new Set();
    const requestedOrder =
      body.playlistOrder === null
        ? this.room.playlist.map((item) => item.queueItemId)
        : body.playlistOrder;
    for (const queueItemId of requestedOrder) {
      if (!QUEUE_ITEM_ID_RE.test(queueItemId || '') || requestedIds.has(queueItemId)) {
        return errorResponse('INVALID_PLAYLIST', 400);
      }
      requestedIds.add(queueItemId);
      playlistOrder.push(queueItemId);
    }
    const upserts = parsePlaylist(body.upserts);
    if (!upserts) return errorResponse('INVALID_PLAYLIST', 400);
    const upsertsById = new Map();
    for (const item of upserts) {
      if (!requestedIds.has(item.queueItemId)) return errorResponse('INVALID_PLAYLIST', 400);
      upsertsById.set(item.queueItemId, item);
    }
    const existingById = new Map(
      this.room.playlist.map((item) => [item.queueItemId, publicPlaylistItem(item)]),
    );
    const playlist = [];
    for (const queueItemId of playlistOrder) {
      const item = upsertsById.get(queueItemId) || existingById.get(queueItemId);
      if (!item) return errorResponse('INVALID_PLAYLIST', 400);
      playlist.push(item);
    }
    return this.commitParticipantSnapshot({
      auth,
      key,
      scope,
      fingerprint,
      playlist,
      currentQueueItemId: body.currentQueueItemId,
      playbackInput: body.playback,
    });
  }

  async commitParticipantSnapshot({
    auth,
    key,
    scope,
    fingerprint,
    playlist: parsedPlaylist,
    currentQueueItemId,
    playbackInput,
  }) {
    const previousPlaylistById = new Map(
      this.room.playlist.map((item) => [item.queueItemId, item]),
    );
    const playlist = parsedPlaylist.map((item) => {
      const existingOwnerKeyId = previousPlaylistById.get(item.queueItemId)?.developerOwnerKeyId;
      return DEVELOPER_API_KEY_ID_RE.test(existingOwnerKeyId || '')
        ? { ...item, developerOwnerKeyId: existingOwnerKeyId }
        : item;
    });
    const addedCount = playlist.reduce(
      (count, item) => count + (previousPlaylistById.has(item.queueItemId) ? 0 : 1),
      0,
    );
    const playlistById = new Map(playlist.map((item) => [item.queueItemId, item]));
    if (
      currentQueueItemId !== null &&
      (!QUEUE_ITEM_ID_RE.test(currentQueueItemId) || !playlistById.has(currentQueueItemId))
    ) {
      return errorResponse('INVALID_QUEUE_ITEM_ID', 400);
    }
    const nowMs = Date.now();
    const playback = parsePlayback(
      playbackInput,
      playlistById,
      currentQueueItemId,
      this.room.presence.coordinatorEpoch,
      this.room.playback,
      nowMs,
    );
    if (!playback) {
      return errorResponse('INVALID_PLAYBACK', 400);
    }
    if (!this.validatePlaylistAssets(playlist)) return errorResponse('ASSET_NOT_READY', 409);

    const playlistChanged = JSON.stringify(playlist) !== JSON.stringify(this.room.playlist);
    this.room.playlist = playlist;
    this.room.currentQueueItemId = currentQueueItemId;
    this.room.playback = playback;
    this.reconcileAssetGarbageCollection(nowMs);
    if (playlistChanged) {
      reconcileQueueModePlaylist(this.room, nowMs);
      this.room.playlistRevision += 1;
    }
    this.room.revision += 1;
    const responseBody = { snapshot: publicSnapshot(this.room, auth.session) };
    this.storeSnapshotIdempotency(scope, key, fingerprint, this.room.revision);
    await this.persist();
    if (addedCount > 0) {
      this.scheduleDeveloperInvalidationHint({
        actorName: auth.session.displayName,
        fallback: 'Peer',
        count: addedCount,
      });
    }
    return jsonResponse(responseBody);
  }

  async handleCreateReservation(request) {
    const auth = await this.requireSession(request, { activePresence: true });
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
    const assets = Object.values(this.room.assets);
    const reservations = assets.filter((asset) => asset.status === 'reserved');
    if (assets.length + Object.keys(this.room.stagingTombstones).length >= ASSET_MAX_ITEMS) {
      return errorResponse('ASSET_CAPACITY_EXCEEDED', 409);
    }
    if (reservations.length >= RESERVED_ASSET_MAX_ITEMS) {
      return errorResponse('RESERVATION_CAPACITY_EXCEEDED', 409);
    }
    if (
      reservations.filter((asset) => asset.reservedByParticipantId === auth.session.participantId)
        .length >= RESERVED_ASSET_MAX_ITEMS_PER_PARTICIPANT
    ) {
      return errorResponse('RESERVATION_CAPACITY_EXCEEDED', 409);
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
    const objectPrefix = `rooms/${this.room.roomCode}/assets/${assetId}/v${version}`;
    const stagingObjectKey = `${objectPrefix}/staging_${randomToken(18)}`;
    const objectKey = `${objectPrefix}/object_${randomToken(24)}`;
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
      objectKey: stagingObjectKey,
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
      stagingObjectKey,
      uploadExpiresAtMs: nowMs + presignTtl * 1000,
      reservedByParticipantId: auth.session.participantId,
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
    // Completion remains creator-only and requires an active heartbeat. A
    // client that leaves mid-upload can rejoin, but another participant cannot
    // adopt its still-valid presigned staging URL/reservation.
    const auth = await this.requireSession(request, { activePresence: true });
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
    if (asset.reservedByParticipantId !== auth.session.participantId) {
      return errorResponse('RESERVATION_OWNER_REQUIRED', 403);
    }
    if (!this.env.PRO_MEDIA_BUCKET) return errorResponse('MEDIA_NOT_CONFIGURED', 503);
    if (serializedCoreStateByteLength(this.room) > STATE_MAX_BYTES - 8 * 1024) {
      return errorResponse('ROOM_STATE_CAPACITY_EXCEEDED', 409);
    }
    let object;
    try {
      object = await this.env.PRO_MEDIA_BUCKET.head(asset.stagingObjectKey);
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
        await this.env.PRO_MEDIA_BUCKET.delete(asset.stagingObjectKey);
      } catch {
        asset.expiresAtMs = Date.now() + 60_000;
        await this.persist();
        return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
      }
      this.room.quota.reservedBytes -= asset.byteLength;
      this.retainStagingTombstone(asset);
      delete this.room.assets[assetId];
      this.room.revision += 1;
      await this.persist();
      return errorResponse('UPLOAD_MISMATCH', 409);
    }
    const finalMetadata = {
      'mxqr-room': this.room.roomCode,
      'mxqr-asset': asset.assetId,
      'mxqr-version': String(asset.version),
      'mxqr-bytes': String(asset.byteLength),
      ...(asset.sha256 === undefined ? {} : { 'mxqr-sha256': asset.sha256 }),
    };
    try {
      const staged = await this.env.PRO_MEDIA_BUCKET.get(asset.stagingObjectKey);
      if (!staged?.body) return errorResponse('UPLOAD_INCOMPLETE', 409);
      await this.env.PRO_MEDIA_BUCKET.put(asset.objectKey, staged.body, {
        httpMetadata: { contentType: asset.mime },
        customMetadata: finalMetadata,
      });
      const finalObject = await this.env.PRO_MEDIA_BUCKET.head(asset.objectKey);
      const finalObjectMetadata = finalObject?.customMetadata || {};
      if (
        !finalObject ||
        finalObject.size !== asset.byteLength ||
        finalObject.httpMetadata?.contentType !== asset.mime ||
        Object.entries(finalMetadata).some(
          ([metadataKey, metadataValue]) => finalObjectMetadata[metadataKey] !== metadataValue,
        )
      ) {
        await this.env.PRO_MEDIA_BUCKET.delete(asset.objectKey).catch(() => {});
        return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
      }
      // A presigned staging URL is reusable until it expires. Delete now for
      // normal clients, then retain a cleanup marker so an after-completion
      // replay is deleted again once the URL can no longer be used.
      await this.env.PRO_MEDIA_BUCKET.delete(asset.stagingObjectKey).catch(() => {});
    } catch {
      await this.env.PRO_MEDIA_BUCKET.delete(asset.objectKey).catch(() => {});
      return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
    }
    const completedAtMs = Date.now();
    asset.status = 'ready';
    delete asset.expiresAtMs;
    asset.completedAtMs = completedAtMs;
    asset.stagingCleanupAfterMs = Math.max(asset.uploadExpiresAtMs + 5_000, completedAtMs + 60_000);
    this.room.quota.reservedBytes -= asset.byteLength;
    this.room.quota.usedBytes += asset.byteLength;
    // Completion and playlist insertion are separate idempotent operations.
    // Start a conservative orphan deadline now; a later accepted snapshot that
    // references this asset clears the marker.
    this.reconcileAssetGarbageCollection(completedAtMs);
    this.room.revision += 1;
    const responseBody = { asset: publicAsset(asset), quota: { ...this.room.quota } };
    this.storeIdempotency(scope, key, fingerprint, responseBody);
    await this.persist();
    return jsonResponse(responseBody);
  }

  async handleDownloadMedia(request, assetId) {
    const auth = await this.requireSession(request, { activePresence: true });
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
    const auth = await this.requireSession(request, { activePresence: true });
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
    if (!asset || (asset.status !== 'reserved' && asset.status !== 'ready')) {
      return errorResponse('ASSET_NOT_FOUND', 404);
    }
    if (
      this.room.playlist.some(
        (item) => item.source.kind === 'pro-r2' && item.source.assetId === assetId,
      )
    ) {
      return errorResponse('ASSET_IN_USE', 409);
    }
    if (!this.env.PRO_MEDIA_BUCKET) return errorResponse('MEDIA_NOT_CONFIGURED', 503);
    try {
      if (asset.stagingObjectKey) {
        await this.env.PRO_MEDIA_BUCKET.delete(asset.stagingObjectKey);
      }
      if (asset.status === 'ready') await this.env.PRO_MEDIA_BUCKET.delete(asset.objectKey);
    } catch {
      return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
    }
    if (asset.status === 'reserved') this.room.quota.reservedBytes -= asset.byteLength;
    else this.room.quota.usedBytes -= asset.byteLength;
    this.retainStagingTombstone(asset);
    delete this.room.assets[assetId];
    this.room.revision += 1;
    const responseBody = { ok: true, assetId, quota: { ...this.room.quota } };
    this.storeIdempotency(scope, key, fingerprint, responseBody);
    await this.persist();
    return jsonResponse(responseBody);
  }

  async prune(nowMs) {
    if (this.room.status === 'decommissioning') {
      await this.continueDecommission(nowMs);
      return true;
    }
    if (this.room.status === 'decommissioned') {
      if ((this.room.decommission?.maintenanceAtMs || 0) <= nowMs) {
        await this.maintainDecommissionedTombstone(nowMs);
        return true;
      }
      return false;
    }
    // This also migrates ready assets written before gcAfterMs existed and
    // repairs stale markers on assets that are referenced by the playlist.
    let changed =
      this.systemAudioMigrationPending ||
      this.effectsMigrationPending ||
      this.queueModeMigrationPending ||
      this.developerCommandMigrationPending ||
      this.reconcileSystemAudio(nowMs);
    changed = this.reconcileAssetGarbageCollection(nowMs) || changed;
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
    changed = (await this.processDeveloperCommands(nowMs)) || changed;
    for (const [commandId, command] of Object.entries(this.room.developerCommands)) {
      if (
        command.status !== 'pending' &&
        command.status !== 'dispatched' &&
        command.retainUntilMs <= nowMs
      ) {
        this.syncDeveloperCommandIdempotency(command);
        delete this.room.developerCommands[commandId];
        changed = true;
      }
    }
    for (const [key, record] of Object.entries(this.room.developerCommandIdempotency)) {
      if (record.expiresAtMs <= nowMs) {
        delete this.room.developerCommandIdempotency[key];
        changed = true;
      }
    }
    for (const [key, record] of Object.entries(this.room.idempotency)) {
      if (record.expiresAtMs <= nowMs) {
        delete this.room.idempotency[key];
        changed = true;
      }
    }
    for (const [assetId, tombstone] of Object.entries(this.room.stagingTombstones)) {
      if (tombstone.cleanupAfterMs > nowMs) continue;
      if (!this.env.PRO_MEDIA_BUCKET) {
        tombstone.cleanupAfterMs = nowMs + ASSET_GC_RETRY_SECONDS * 1000;
        changed = true;
        continue;
      }
      try {
        await this.env.PRO_MEDIA_BUCKET.delete(tombstone.objectKey);
        delete this.room.stagingTombstones[assetId];
        changed = true;
      } catch {
        tombstone.cleanupAfterMs = nowMs + ASSET_GC_RETRY_SECONDS * 1000;
        changed = true;
      }
    }
    const referencedAssets = this.referencedAssetIds();
    for (const [assetId, asset] of Object.entries(this.room.assets)) {
      if (
        asset.stagingObjectKey &&
        Number.isSafeInteger(asset.stagingCleanupAfterMs) &&
        asset.stagingCleanupAfterMs <= nowMs
      ) {
        if (!this.env.PRO_MEDIA_BUCKET) {
          asset.stagingCleanupAfterMs = nowMs + ASSET_GC_RETRY_SECONDS * 1000;
          changed = true;
        } else {
          try {
            await this.env.PRO_MEDIA_BUCKET.delete(asset.stagingObjectKey);
            delete asset.stagingObjectKey;
            delete asset.stagingCleanupAfterMs;
            delete asset.uploadExpiresAtMs;
            changed = true;
          } catch {
            asset.stagingCleanupAfterMs = nowMs + ASSET_GC_RETRY_SECONDS * 1000;
            changed = true;
          }
        }
      }
      if (asset.status === 'reserved' && asset.expiresAtMs <= nowMs) {
        if (!this.env.PRO_MEDIA_BUCKET) {
          asset.expiresAtMs = nowMs + 60_000;
          changed = true;
          continue;
        }
        try {
          await this.env.PRO_MEDIA_BUCKET.delete(asset.stagingObjectKey);
        } catch {
          asset.expiresAtMs = nowMs + 60_000;
          changed = true;
          continue;
        }
        this.room.quota.reservedBytes -= asset.byteLength;
        this.retainStagingTombstone(asset, nowMs);
        delete this.room.assets[assetId];
        changed = true;
        continue;
      }
      if (
        asset.status === 'ready' &&
        Number.isSafeInteger(asset.gcAfterMs) &&
        asset.gcAfterMs <= nowMs
      ) {
        // Never trust the marker alone: a later snapshot may have restored one
        // or several references since it was created.
        if (referencedAssets.has(assetId)) {
          delete asset.gcAfterMs;
          changed = true;
          continue;
        }
        if (!this.env.PRO_MEDIA_BUCKET) {
          asset.gcAfterMs = nowMs + ASSET_GC_RETRY_SECONDS * 1000;
          changed = true;
          continue;
        }
        try {
          await this.env.PRO_MEDIA_BUCKET.delete(asset.objectKey);
          if (asset.stagingObjectKey) {
            await this.env.PRO_MEDIA_BUCKET.delete(asset.stagingObjectKey);
          }
        } catch {
          // R2 is authoritative for byte deletion. Keep both the asset ledger
          // and used-byte charge intact until deletion succeeds.
          asset.gcAfterMs = nowMs + ASSET_GC_RETRY_SECONDS * 1000;
          changed = true;
          continue;
        }
        this.room.quota.usedBytes -= asset.byteLength;
        this.retainStagingTombstone(asset, nowMs);
        delete this.room.assets[assetId];
        this.room.revision += 1;
        changed = true;
      }
    }
    for (const [key, value] of Object.entries(this.room.rateLimits)) {
      if (value.resetAtMs <= nowMs) {
        delete this.room.rateLimits[key];
        changed = true;
      }
    }
    for (const [nonceHash, expiresAtMs] of Object.entries(this.room.consumedRecoveryNonces)) {
      if (expiresAtMs <= nowMs) {
        delete this.room.consumedRecoveryNonces[nonceHash];
        changed = true;
      }
    }
    if (changed) {
      await this.persist();
      this.systemAudioMigrationPending = false;
      this.effectsMigrationPending = false;
      this.queueModeMigrationPending = false;
      this.developerCommandMigrationPending = false;
    }
    return changed;
  }

  async alarm() {
    await this.withMutation(async () => {
      if (this.ready) await this.ready;
      if (!this.room) await this.loadRoomFromStorage();
      if (!this.room) return;
      this.normalizeLoadedSystemAudio();
      this.normalizeLoadedEffects();
      this.normalizeLoadedQueueMode();
      this.normalizeLoadedDeveloperCommands();
      await this.prune(Date.now());
      await this.scheduleAlarm();
    });
  }
}
