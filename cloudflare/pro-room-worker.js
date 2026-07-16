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
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const SHA256_RE = /^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/;
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SYSTEM_AUDIO_LEASE_ID_RE = /^[A-Za-z0-9_-]{43}$/;

const SCHEMA_VERSION = 1;
const STORAGE_KEY = 'pro-room:v1';
const ROOM_QUOTA_BYTES = 1024 * 1024 * 1024;
const ASSET_MAX_BYTES = 200 * 1024 * 1024;
const PLAYLIST_MAX_ITEMS = 1000;
// The elected coordinator is one of the 100 connected devices. Signaling
// separately admits at most 99 non-coordinator members for the same ceiling.
const PRESENCE_MAX_ITEMS = 100;
const SESSION_MAX_ITEMS = 128;
const ASSET_MAX_ITEMS = 1024;
const RESERVED_ASSET_MAX_ITEMS = 32;
const RESERVED_ASSET_MAX_ITEMS_PER_PARTICIPANT = 8;
const IDEMPOTENCY_MAX_ITEMS = 256;
const RATE_LIMIT_MAX_ITEMS = 512;
const RECOVERY_NONCE_MAX_ITEMS = 128;
const STAGING_TOMBSTONE_MAX_ITEMS = ASSET_MAX_ITEMS;
// Durable Object KV rejects a single key + value above 2 MiB. Keep enough
// headroom for storage encoding overhead and future schema additions.
const STATE_MAX_BYTES = 1200 * 1024;
const REQUEST_MAX_BYTES = 1500 * 1024;
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
      registered: new Set(INITIAL_PRO_ROOM_CODES),
      refreshedAtMs: 0,
      refreshPromise: null,
    };
    registryCacheByDb.set(db, cache);
  }
  return cache;
}

async function isFrontProvisionedRoom(roomCode, env, nowMs = Date.now()) {
  if (INITIAL_PRO_ROOM_CODES.has(roomCode)) return true;
  const db = env?.MUSIXQUARE_ADMIN_DB || env?.ADMIN_METRICS_DB || null;
  if (!db?.prepare) return false;
  const cache = registryCacheFor(db);
  if (cache.registered.has(roomCode)) return true;
  if (nowMs - cache.refreshedAtMs < PRO_ROOM_REGISTRY_REFRESH_MS) return false;
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
      for (const row of rows) {
        if (isProRoomCode(row?.room_code)) cache.registered.add(row.room_code);
      }
      cache.refreshedAtMs = Date.now();
    })().finally(() => {
      cache.refreshPromise = null;
    });
  }
  try {
    await cache.refreshPromise;
  } catch (error) {
    // Dynamic rooms fail closed while the registry is unavailable. The two
    // launch rooms remain on the immutable fast path above.
    console.warn('[PRO registry] front-door refresh failed', error);
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

async function readJsonBody(request, maxBytes, allowSimpleText = false) {
  const contentType = request.headers.get('content-type') || '';
  const acceptedContentType = allowSimpleText
    ? /^text\/plain(?:\s*;|$)/i.test(contentType)
    : /^application\/json(?:\s*;|$)/i.test(contentType);
  if (!acceptedContentType) return { error: 'INVALID_REQUEST' };
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
    systemAudio: initialSystemAudioState(),
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
    serializedStateByteLength(room) > STATE_MAX_BYTES
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
    const load = async () => {
      this.room = (await this.storage.get(STORAGE_KEY)) || null;
      this.normalizeLoadedSystemAudio();
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
      await this.storage.put(STORAGE_KEY, this.room);
      await this.scheduleAlarm();
      return errorResponse('ROOM_STATE_CAPACITY_EXCEEDED', 409);
    }
  }

  async persist() {
    assertBoundedRoomState(this.room);
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
      return errorResponse('NOT_FOUND', 404);
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

  async parseBody(request, maxBytes = SMALL_REQUEST_MAX_BYTES, allowSimpleText = false) {
    const parsed = await readJsonBody(request, maxBytes, allowSimpleText);
    return parsed.error
      ? { response: errorResponse(parsed.error, parsed.status || 400) }
      : { value: parsed.value };
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
    if (request.body) {
      const parsed = await this.parseBody(request);
      if (parsed.response) return parsed.response;
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
    if (request.body && (request.headers.get('content-length') || '') !== '0')
      return errorResponse('INVALID_REQUEST', 400);
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

  replayIdempotency(scope, key, fingerprint, session = null) {
    const record = this.room.idempotency[`${scope}:${key}`];
    if (!record) return null;
    if (!constantTimeEqual(record.fingerprint, fingerprint)) {
      return errorResponse('IDEMPOTENCY_CONFLICT', 409);
    }
    if (record.kind === 'snapshot') {
      return jsonResponse({ snapshot: publicSnapshot(this.room, session) }, record.status);
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
    const playlist = parsePlaylist(body.playlist);
    if (!playlist) return errorResponse('INVALID_PLAYLIST', 400);
    const playlistById = new Map(playlist.map((item) => [item.queueItemId, item]));
    if (
      body.currentQueueItemId !== null &&
      (!QUEUE_ITEM_ID_RE.test(body.currentQueueItemId) ||
        !playlistById.has(body.currentQueueItemId))
    ) {
      return errorResponse('INVALID_QUEUE_ITEM_ID', 400);
    }
    const playback = parsePlayback(
      body.playback,
      playlistById,
      body.currentQueueItemId,
      this.room.presence.coordinatorEpoch,
      this.room.playback,
      Date.now(),
    );
    if (!playback) {
      return errorResponse('INVALID_PLAYBACK', 400);
    }
    if (!this.validatePlaylistAssets(playlist)) return errorResponse('ASSET_NOT_READY', 409);

    const playlistChanged = JSON.stringify(playlist) !== JSON.stringify(this.room.playlist);
    this.room.playlist = playlist;
    this.room.currentQueueItemId = body.currentQueueItemId;
    this.room.playback = playback;
    this.reconcileAssetGarbageCollection(Date.now());
    if (playlistChanged) this.room.playlistRevision += 1;
    this.room.revision += 1;
    const responseBody = { snapshot: publicSnapshot(this.room, auth.session) };
    this.storeSnapshotIdempotency(scope, key, fingerprint, this.room.revision);
    await this.persist();
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
    if (serializedStateByteLength(this.room) > STATE_MAX_BYTES - 8 * 1024) {
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
    // This also migrates ready assets written before gcAfterMs existed and
    // repairs stale markers on assets that are referenced by the playlist.
    let changed = this.systemAudioMigrationPending || this.reconcileSystemAudio(nowMs);
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
    }
    return changed;
  }

  async alarm() {
    await this.withMutation(async () => {
      if (this.ready) await this.ready;
      if (!this.room) this.room = (await this.storage.get(STORAGE_KEY)) || null;
      if (!this.room) return;
      this.normalizeLoadedSystemAudio();
      await this.prune(Date.now());
      await this.scheduleAlarm();
    });
  }
}
