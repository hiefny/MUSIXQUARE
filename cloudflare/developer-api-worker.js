/**
 * MUSIXQUARE Developer API public edge Worker.
 *
 * This Worker intentionally has no binding to PRO room Durable Objects, R2,
 * signaling, or the browser-facing PRO Worker. It authenticates a room-bound
 * API key, applies ingress and room-serial limits, then sends one allowlisted
 * intent to the private Developer API Facade service binding.
 */

import {
  INITIAL_PRO_ROOM_GENERATION,
  isProRoomGeneration,
  proRoomGenerationHeaderValue,
  proRoomObjectName,
} from './pro-room-generation.js';

const PRO_ROOM_GENERATION_HEADER = 'x-mxqr-pro-room-generation';
const API_KEY_RE = /^mxqr_live_([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;
const ROOM_CODE_RE = /^0\d{5}$/;
const REQUEST_ID_RE = /^req_[A-Za-z0-9_-]{22}$/;
const DIGEST_RE = /^[A-Za-z0-9_-]{43}$/;
const DECOMMISSION_REQUEST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AUTHORIZATION_MAX_BYTES = 128;
const URL_MAX_BYTES = 2_048;
const ETAG_HEADER_MAX_BYTES = 128;
const COMMAND_REQUEST_MAX_BYTES = 1_024;
const COMMAND_RESPONSE_MAX_BYTES = 8 * 1024;
const QUEUE_MUTATION_REQUEST_MAX_BYTES = 128 * 1024;
const MEDIA_UPLOAD_REQUEST_MAX_BYTES = 16 * 1024;
const MUTATION_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{14,126})[A-Za-z0-9]$/;
const COMMAND_ID_RE = /^cmd_[A-Za-z0-9_-]{22}$/;
const QUEUE_ITEM_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const QUEUE_ITEM_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASSET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const SHA256_RE = /^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/;
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS = 5_000;
const QUEUE_ITEM_ADDED_BY_VALUES = new Set(['participant', 'current_api_key', 'another_api_key']);
const PLAYLIST_MAX_ITEMS = 1_000;
const YOUTUBE_BATCH_MAX_ITEMS = 100;
const ASSET_MAX_BYTES = 200 * 1024 * 1024;
const PLAYBACK_MAX_POSITION_SECONDS = 7 * 24 * 60 * 60;
// The PRO room core remains capped at 1.2 MiB, while its independently stored
// public playlist is capped below 3 MiB. Leave bounded framing room so every
// accepted queue remains readable through the unchanged public API contract.
const FACADE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const RATE_REQUEST_MAX_BYTES = 4 * 1024;
const RATE_STATE_MAX_ITEMS = 256;
const INGRESS_LIMIT_PER_MINUTE = 120;
const KEY_READ_LIMIT_PER_MINUTE = 60;
const ROOM_READ_LIMIT_PER_MINUTE = 180;
const KEY_COMMAND_LIMIT_PER_MINUTE = 30;
const ROOM_COMMAND_LIMIT_PER_MINUTE = 90;
const KEY_QUEUE_WRITE_LIMIT_PER_MINUTE = 10;
const ROOM_QUEUE_WRITE_LIMIT_PER_MINUTE = 30;
const KEY_MEDIA_UPLOAD_LIMIT_PER_HOUR = 10;
const ROOM_MEDIA_UPLOAD_LIMIT_PER_HOUR = 30;
const SCOPE_ROOM_READ = 1;
const SCOPE_PLAYBACK_READ = 2;
const SCOPE_PLAYBACK_CONTROL = 4;
const SCOPE_QUEUE_READ = 8;
const SCOPE_QUEUE_WRITE = 16;
const SCOPE_MEDIA_UPLOAD = 32;
const SCOPE_EFFECTS_READ = 64;
const SCOPE_EFFECTS_CONTROL = 128;
const ALL_SCOPE_BITS =
  SCOPE_ROOM_READ |
  SCOPE_PLAYBACK_READ |
  SCOPE_PLAYBACK_CONTROL |
  SCOPE_QUEUE_READ |
  SCOPE_QUEUE_WRITE |
  SCOPE_MEDIA_UPLOAD |
  SCOPE_EFFECTS_READ |
  SCOPE_EFFECTS_CONTROL;
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
  IDEMPOTENCY_CONFLICT: 'This idempotency key was already used for another command.',
  IDEMPOTENCY_KEY_REQUIRED: 'A valid Idempotency-Key header is required.',
  INTERNAL_RESPONSE_INVALID: 'The Developer API backend returned an invalid response.',
  INVALID_REQUEST: 'The request is invalid.',
  COMMAND_CAPACITY_EXCEEDED: 'The room cannot accept another playback command right now.',
  COORDINATOR_INCOMPATIBLE: 'The active room coordinator cannot accept API commands.',
  NO_MEDIA: 'The room has no playable media.',
  NOT_FOUND: 'The requested resource was not found.',
  ASSET_CAPACITY_EXCEEDED: 'The room cannot accept another media asset right now.',
  PLAYLIST_CAPACITY_EXCEEDED: 'The room playlist is full.',
  PLAYLIST_REVISION_CONFLICT:
    'The playlist changed. Read it again and retry with the new revision.',
  QUEUE_MODE_REVISION_CONFLICT:
    'The repeat or shuffle state changed. Read it again and retry with the new revision.',
  RESERVATION_CAPACITY_EXCEEDED: 'This API key has too many unfinished uploads.',
  ROOM_QUOTA_EXCEEDED: 'The PRO room storage quota would be exceeded.',
  ROOM_STATE_CAPACITY_EXCEEDED: 'The room state cannot accept this change right now.',
  UPLOAD_INCOMPLETE: 'The direct upload has not finished yet.',
  UPLOAD_MISMATCH: 'The uploaded object does not match its reservation.',
  RATE_LIMITED: 'Too many requests. Try again later.',
  ROOM_SLEEPING: 'The room is sleeping and cannot accept playback commands.',
  UNAUTHORIZED: 'A valid Developer API key is required.',
});

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function proRoomGenerationWireFields(roomGeneration) {
  if (!isProRoomGeneration(roomGeneration)) throw new Error('Invalid room generation');
  return { roomGeneration };
}

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
  const label =
    typeof value?.label === 'string' &&
    value.label.length >= 1 &&
    value.label.length <= 64 &&
    !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value.label)
      ? value.label
      : null;
  if (
    !value ||
    typeof value !== 'object' ||
    !/^[A-Za-z0-9_-]{16}$/.test(String(value.key_id || '')) ||
    !ROOM_CODE_RE.test(String(value.room_code || '')) ||
    !isProRoomGeneration(value.room_generation) ||
    label === null ||
    !DIGEST_RE.test(String(value.secret_digest || '')) ||
    value.digest_version !== 1 ||
    !validScopeMask(value.scope_mask) ||
    (value.status !== 'active' && value.status !== 'revoked') ||
    !isSafeNonNegativeInteger(value.created_at) ||
    !isSafeNonNegativeInteger(value.updated_at) ||
    value.updated_at < value.created_at ||
    !isSafeNonNegativeInteger(value.expires_at) ||
    value.expires_at <= value.created_at ||
    (value.last_used_hour !== null && !isSafeNonNegativeInteger(value.last_used_hour)) ||
    (value.status === 'active' && value.revoked_at !== null) ||
    (value.status === 'revoked' &&
      (!isSafeNonNegativeInteger(value.revoked_at) || value.revoked_at < value.created_at))
  ) {
    return null;
  }
  return {
    keyId: value.key_id,
    roomCode: value.room_code,
    roomGeneration: value.room_generation,
    label,
    digest: value.secret_digest,
    scopeMask: value.scope_mask,
    status: value.status,
    expiresAt: value.expires_at,
    lastUsedHour: value.last_used_hour,
  };
}

async function lookupKey(env, keyId) {
  if (!env.DEVELOPER_API_DB?.prepare) throw new Error('Developer API D1 binding unavailable');
  return env.DEVELOPER_API_DB.prepare(
    `SELECT key_id, room_code, room_generation, label, secret_digest, digest_version, scope_mask,
            status, created_at, updated_at, expires_at, revoked_at, last_used_hour
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

export async function expireDeveloperApiKeys(env, nowMs = Date.now()) {
  if (!isSafeNonNegativeInteger(nowMs)) {
    throw new Error('Invalid Developer API expiry timestamp');
  }
  if (!env.DEVELOPER_API_DB?.prepare) {
    throw new Error('Developer API D1 binding unavailable');
  }
  return env.DEVELOPER_API_DB.prepare(
    `UPDATE mxqr_developer_api_keys
     SET status = 'revoked',
         revoked_at = expires_at,
         updated_at = CASE WHEN updated_at > expires_at THEN updated_at ELSE expires_at END
     WHERE status = 'active' AND expires_at <= ?1`,
  )
    .bind(nowMs)
    .run();
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
  const currentHour = Math.floor(nowMs / 3_600_000) * 3_600_000;
  if (row.lastUsedHour === null || row.lastUsedHour < currentHour) {
    updateLastUsedBestEffort(env, context, row.keyId, nowMs);
  }
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

async function readRequestJsonLimited(request, maxBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    return null;
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > maxBytes)) {
    return null;
  }
  if (!request.body) return null;
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

async function hasNonEmptyRequestBody(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const normalized = declared.trim();
    if (!/^\d+$/.test(normalized) || Number(normalized) !== 0) return true;
  }
  if (!request.body) return false;

  let reader;
  try {
    reader = request.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      if (value?.byteLength) {
        await reader.cancel().catch(() => {});
        return true;
      }
    }
  } catch {
    // A bodyless endpoint cannot safely treat an unreadable stream as empty.
    return true;
  } finally {
    reader?.releaseLock();
  }
}

function parseDeveloperCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type === 'play' || value.type === 'pause' || value.type === 'next') {
    return hasExactKeys(value, ['type']) ? { type: value.type } : null;
  }
  if (value.type === 'seek') {
    return hasExactKeys(value, ['type', 'positionSeconds']) &&
      typeof value.positionSeconds === 'number' &&
      Number.isFinite(value.positionSeconds) &&
      value.positionSeconds >= 0 &&
      value.positionSeconds <= PLAYBACK_MAX_POSITION_SECONDS
      ? { type: 'seek', positionSeconds: value.positionSeconds }
      : null;
  }
  if (value.type === 'play_item') {
    return hasExactKeys(value, ['type', 'queueItemId']) &&
      typeof value.queueItemId === 'string' &&
      QUEUE_ITEM_UUID_RE.test(value.queueItemId)
      ? { type: 'play_item', queueItemId: value.queueItemId }
      : null;
  }
  if (value.type === 'set_effects') {
    const effects = hasExactKeys(value, ['type', 'effects'])
      ? parseEffectsPatch(value.effects)
      : null;
    return effects ? { type: 'set_effects', effects } : null;
  }
  return null;
}

function parseQueueModeUpdate(value) {
  return hasExactKeys(value, ['baseRevision', 'repeatMode', 'shuffleEnabled']) &&
    isSafeNonNegativeInteger(value.baseRevision) &&
    ['off', 'all', 'one'].includes(value.repeatMode) &&
    typeof value.shuffleEnabled === 'boolean'
    ? {
        baseRevision: value.baseRevision,
        repeatMode: value.repeatMode,
        shuffleEnabled: value.shuffleEnabled,
      }
    : null;
}

const EFFECT_REVERB_FIELDS = Object.freeze({
  mixPercent: [0, 100],
  decaySeconds: [0.1, 30],
  preDelaySeconds: [0, 1],
  lowCutPercent: [0, 100],
  highCutPercent: [0, 100],
});

function boundedFiniteNumber(value, minimum, maximum) {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

function parseReverbPatch(value, requireComplete = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const allowed = Object.keys(EFFECT_REVERB_FIELDS);
  if (
    keys.length === 0 ||
    keys.some((key) => !allowed.includes(key)) ||
    (requireComplete &&
      (keys.length !== allowed.length || allowed.some((key) => !keys.includes(key))))
  ) {
    return null;
  }
  const parsed = {};
  for (const key of keys) {
    const [minimum, maximum] = EFFECT_REVERB_FIELDS[key];
    if (!boundedFiniteNumber(value[key], minimum, maximum)) return null;
    parsed[key] = value[key];
  }
  return parsed;
}

function parseEqualizer(value) {
  if (
    !hasExactKeys(value, ['bandsDb']) ||
    !Array.isArray(value.bandsDb) ||
    value.bandsDb.length !== 5 ||
    value.bandsDb.some((band) => !boundedFiniteNumber(band, -12, 12))
  ) {
    return null;
  }
  return { bandsDb: [...value.bandsDb] };
}

function parseVirtualBass(value) {
  return hasExactKeys(value, ['strengthPercent']) &&
    boundedFiniteNumber(value.strengthPercent, 0, 100)
    ? { strengthPercent: value.strengthPercent }
    : null;
}

function parseVirtualSurround(value) {
  return hasExactKeys(value, ['widthPercent']) && boundedFiniteNumber(value.widthPercent, 0, 200)
    ? { widthPercent: value.widthPercent }
    : null;
}

function parseVirtualTreble(value) {
  return hasExactKeys(value, ['enabled']) && typeof value.enabled === 'boolean'
    ? { enabled: value.enabled }
    : null;
}

function parseEffects(value, requireComplete) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = ['reverb', 'equalizer', 'virtualBass', 'virtualSurround', 'virtualTreble'];
  const keys = Object.keys(value);
  if (
    keys.length === 0 ||
    keys.some((key) => !allowed.includes(key)) ||
    (requireComplete &&
      (keys.length !== allowed.length || allowed.some((key) => !keys.includes(key))))
  ) {
    return null;
  }
  const effects = {};
  for (const key of keys) {
    const parsed =
      key === 'reverb'
        ? parseReverbPatch(value.reverb, requireComplete)
        : key === 'equalizer'
          ? parseEqualizer(value.equalizer)
          : key === 'virtualBass'
            ? parseVirtualBass(value.virtualBass)
            : key === 'virtualSurround'
              ? parseVirtualSurround(value.virtualSurround)
              : parseVirtualTreble(value.virtualTreble);
    if (!parsed) return null;
    effects[key] = parsed;
  }
  return effects;
}

function parseEffectsPatch(value) {
  return parseEffects(value, false);
}

function parseEffectsState(value) {
  return parseEffects(value, true);
}

function parseMetadata(value) {
  const name = boundedString(value?.name, 512);
  if (!name) return null;
  const metadata = { name };
  for (const key of ['title', 'artist', 'thumbnail']) {
    if (value[key] === undefined) continue;
    const parsed = boundedString(value[key], 512);
    if (!parsed) return null;
    metadata[key] = parsed;
  }
  return metadata;
}

function parseYouTubeVideoIds(value, playlistId, videoId) {
  if (value === undefined) return undefined;
  if (
    !playlistId ||
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS ||
    value.some((item) => typeof item !== 'string' || !YOUTUBE_VIDEO_ID_RE.test(item)) ||
    !value.includes(videoId)
  ) {
    return null;
  }
  return [...value];
}

function parseYouTubeQueueItem(value) {
  if (
    !hasExactKeys(
      value,
      ['videoId', 'name'],
      ['playlistId', 'videoIds', 'title', 'artist', 'thumbnail'],
    ) ||
    !YOUTUBE_VIDEO_ID_RE.test(value.videoId || '') ||
    (value.playlistId !== undefined && !YOUTUBE_PLAYLIST_ID_RE.test(value.playlistId || ''))
  ) {
    return null;
  }
  const videoIds = parseYouTubeVideoIds(value.videoIds, value.playlistId, value.videoId);
  if (videoIds === null) return null;
  const metadata = parseMetadata(value);
  return metadata
    ? {
        type: 'add_youtube',
        videoId: value.videoId,
        ...(value.playlistId === undefined ? {} : { playlistId: value.playlistId }),
        ...(videoIds === undefined ? {} : { videoIds }),
        ...metadata,
      }
    : null;
}

function canonicalizeYouTubeBatchItems(items) {
  const result = [];
  const playlistStates = new Map();
  for (const item of items) {
    if (item.playlistId === undefined) {
      result.push(item);
      continue;
    }
    const state = playlistStates.get(item.playlistId);
    if (state === undefined) {
      playlistStates.set(item.playlistId, {
        index: result.length,
        hasManifest: item.videoIds !== undefined,
      });
      result.push(item);
      continue;
    }

    const existing = result[state.index];
    if (state.hasManifest !== (item.videoIds !== undefined)) return null;
    if (state.hasManifest) {
      if (
        existing.videoIds.length !== item.videoIds.length ||
        existing.videoIds.some((videoId, index) => videoId !== item.videoIds[index])
      ) {
        return null;
      }
      continue;
    }

    const videoIds = [...(existing.videoIds || [existing.videoId]), item.videoId];
    if (videoIds.length > YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS) return null;
    result[state.index] = { ...existing, videoIds };
  }
  return result;
}

function parseYouTubeQueueItemBatch(value) {
  if (
    !hasExactKeys(value, ['items']) ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.items.length > YOUTUBE_BATCH_MAX_ITEMS
  ) {
    return null;
  }
  const items = value.items.map((item) => parseYouTubeQueueItem(item));
  if (items.some((item) => item === null)) return null;
  const canonicalItems = canonicalizeYouTubeBatchItems(items);
  if (!canonicalItems) return null;
  return {
    type: 'add_youtube_batch',
    items: canonicalItems.map(({ type: _type, ...item }) => item),
  };
}

function parseQueueOrder(value) {
  if (
    !hasExactKeys(value, ['basePlaylistRevision', 'queueItemIds']) ||
    !isSafeNonNegativeInteger(value.basePlaylistRevision) ||
    !Array.isArray(value.queueItemIds) ||
    value.queueItemIds.length > PLAYLIST_MAX_ITEMS ||
    value.queueItemIds.some((queueItemId) => !QUEUE_ITEM_UUID_RE.test(queueItemId || '')) ||
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

function isAudioCandidate(name, mime) {
  if (/^audio\//i.test(mime) || mime.toLowerCase() === 'application/ogg') return true;
  if (mime.toLowerCase() !== 'application/octet-stream') return false;
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  return DEVELOPER_AUDIO_EXTENSIONS.has(extension);
}

function parseMediaUpload(value) {
  if (
    !hasExactKeys(
      value,
      ['name', 'byteLength', 'mime'],
      ['sha256', 'title', 'artist', 'thumbnail'],
    ) ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    value.byteLength > ASSET_MAX_BYTES ||
    !MIME_RE.test(value.mime || '') ||
    (value.sha256 !== undefined && !SHA256_RE.test(value.sha256 || ''))
  ) {
    return null;
  }
  const metadata = parseMetadata(value);
  return metadata && isAudioCandidate(metadata.name, value.mime)
    ? {
        ...metadata,
        byteLength: value.byteLength,
        mime: value.mime,
        ...(value.sha256 === undefined ? {} : { sha256: value.sha256 }),
      }
    : null;
}

const COMMAND_STATUSES = new Set(['pending', 'dispatched', 'applied', 'rejected', 'expired']);
const COMMAND_RESULT_CODES = new Set([
  'applied',
  'already_applied',
  'busy',
  'no_media',
  'stale_queue',
  'unsupported_mode',
  'expired',
  'execution_failed',
  'coordinator_changed',
  'coordinator_incompatible',
  'coordinator_unavailable',
]);

function validateCommandPayload(value, roomCode) {
  if (
    !hasExactKeys(
      value,
      ['schemaVersion', 'roomCode', 'commandId', 'status', 'createdAtMs', 'expiresAtMs'],
      ['completedAtMs', 'resultCode'],
    ) ||
    value.schemaVersion !== 1 ||
    value.roomCode !== roomCode ||
    !COMMAND_ID_RE.test(value.commandId || '') ||
    !COMMAND_STATUSES.has(value.status) ||
    !isSafeNonNegativeInteger(value.createdAtMs) ||
    !isSafeNonNegativeInteger(value.expiresAtMs) ||
    value.expiresAtMs <= value.createdAtMs
  ) {
    return null;
  }
  const terminal =
    value.status === 'applied' || value.status === 'rejected' || value.status === 'expired';
  if (terminal) {
    if (
      !isSafeNonNegativeInteger(value.completedAtMs) ||
      value.completedAtMs < value.createdAtMs ||
      !COMMAND_RESULT_CODES.has(value.resultCode)
    ) {
      return null;
    }
  } else if (value.completedAtMs !== undefined || value.resultCode !== undefined) {
    return null;
  }
  if (
    value.status === 'applied' &&
    value.resultCode !== 'applied' &&
    value.resultCode !== 'already_applied'
  ) {
    return null;
  }
  if (value.status === 'expired' && value.resultCode !== 'expired') return null;
  if (
    value.status === 'rejected' &&
    ['applied', 'already_applied', 'expired'].includes(value.resultCode)
  ) {
    return null;
  }
  return value;
}

function validQueueItem(value) {
  if (
    !hasExactKeys(
      value,
      ['queueItemId', 'kind', 'name', 'addedBy'],
      ['title', 'artist', 'thumbnail', 'byteLength'],
    ) ||
    typeof value.queueItemId !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(value.queueItemId) ||
    (value.kind !== 'youtube' && value.kind !== 'audio') ||
    boundedString(value.name, 512) === null
  ) {
    return false;
  }
  if (!QUEUE_ITEM_ADDED_BY_VALUES.has(value.addedBy)) return false;
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
  if (
    !value ||
    typeof value !== 'object' ||
    (expectedView === 'effects' ? value.schemaVersion !== 2 : value.schemaVersion !== 1)
  ) {
    return null;
  }
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
  if (expectedView === 'effects') {
    if (
      !hasExactKeys(value, [
        'schemaVersion',
        'view',
        'roomCode',
        'revision',
        'updatedAtMs',
        'effects',
      ]) ||
      !isSafeNonNegativeInteger(value.revision) ||
      !isSafeNonNegativeInteger(value.updatedAtMs) ||
      !parseEffectsState(value.effects)
    ) {
      return null;
    }
    return value;
  }
  if (expectedView === 'queue-mode') {
    if (
      !hasExactKeys(value, [
        'schemaVersion',
        'view',
        'roomCode',
        'revision',
        'playlistRevision',
        'updatedAtMs',
        'repeatMode',
        'shuffleEnabled',
      ]) ||
      !isSafeNonNegativeInteger(value.revision) ||
      !isSafeNonNegativeInteger(value.playlistRevision) ||
      !isSafeNonNegativeInteger(value.updatedAtMs) ||
      !['off', 'all', 'one'].includes(value.repeatMode) ||
      typeof value.shuffleEnabled !== 'boolean'
    ) {
      return null;
    }
    return value;
  }
  return null;
}

function validQuota(value) {
  return (
    hasExactKeys(value, ['limitBytes', 'perAssetLimitBytes', 'usedBytes', 'reservedBytes']) &&
    Object.values(value).every(isSafeNonNegativeInteger)
  );
}

function validUploadGenerationMetadata(headers, roomGeneration) {
  const value = headers['x-amz-meta-mxqr-generation'];
  return value === String(roomGeneration);
}

function validateUploadPayload(value, roomCode, roomGeneration, expectedMedia) {
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'roomCode',
      'assetId',
      'queueItemId',
      'byteLength',
      'uploadExpiresAtMs',
      'completionExpiresAtMs',
      'upload',
      'quota',
    ]) ||
    value.schemaVersion !== 1 ||
    value.roomCode !== roomCode ||
    !ASSET_ID_RE.test(value.assetId || '') ||
    !QUEUE_ITEM_UUID_RE.test(value.queueItemId || '') ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    value.byteLength > ASSET_MAX_BYTES ||
    value.byteLength !== expectedMedia.byteLength ||
    !isSafeNonNegativeInteger(value.uploadExpiresAtMs) ||
    !isSafeNonNegativeInteger(value.completionExpiresAtMs) ||
    value.completionExpiresAtMs < value.uploadExpiresAtMs ||
    !validQuota(value.quota) ||
    !hasExactKeys(value.upload, ['method', 'url', 'headers']) ||
    value.upload.method !== 'PUT'
  ) {
    return null;
  }
  let uploadUrl;
  try {
    uploadUrl = new URL(value.upload.url);
  } catch {
    return null;
  }
  if (
    uploadUrl.protocol !== 'https:' ||
    uploadUrl.username ||
    uploadUrl.password ||
    uploadUrl.hash ||
    !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(uploadUrl.hostname) ||
    !uploadUrl.searchParams.has('X-Amz-Signature')
  ) {
    return null;
  }
  const headers = value.upload.headers;
  const allowedHeaders = new Set([
    'content-length',
    'content-type',
    'x-amz-meta-mxqr-room',
    'x-amz-meta-mxqr-generation',
    'x-amz-meta-mxqr-asset',
    'x-amz-meta-mxqr-version',
    'x-amz-meta-mxqr-bytes',
    'x-amz-meta-mxqr-sha256',
  ]);
  if (
    !headers ||
    typeof headers !== 'object' ||
    Array.isArray(headers) ||
    Object.keys(headers).some((key) => !allowedHeaders.has(key)) ||
    headers['content-length'] !== String(value.byteLength) ||
    headers['x-amz-meta-mxqr-room'] !== roomCode ||
    !validUploadGenerationMetadata(headers, roomGeneration) ||
    headers['x-amz-meta-mxqr-asset'] !== value.assetId ||
    headers['x-amz-meta-mxqr-version'] !== '1' ||
    headers['x-amz-meta-mxqr-bytes'] !== String(value.byteLength) ||
    !MIME_RE.test(headers['content-type'] || '') ||
    headers['content-type'] !== expectedMedia.mime ||
    (headers['x-amz-meta-mxqr-sha256'] !== undefined &&
      !SHA256_RE.test(headers['x-amz-meta-mxqr-sha256'])) ||
    (expectedMedia.sha256 === undefined
      ? headers['x-amz-meta-mxqr-sha256'] !== undefined
      : headers['x-amz-meta-mxqr-sha256'] !== expectedMedia.sha256)
  ) {
    return null;
  }
  return value;
}

function validateUploadCompletionPayload(value, roomCode, expectedAssetId) {
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'roomCode',
      'asset',
      'queueItem',
      'playlistRevision',
      'quota',
    ]) ||
    value.schemaVersion !== 1 ||
    value.roomCode !== roomCode ||
    !isSafeNonNegativeInteger(value.playlistRevision) ||
    !validQuota(value.quota) ||
    !validQueueItem(value.queueItem) ||
    value.queueItem.kind !== 'audio' ||
    !hasExactKeys(value.asset, ['kind', 'assetId', 'version', 'byteLength', 'mime'], ['sha256']) ||
    value.asset.kind !== 'pro-r2' ||
    !ASSET_ID_RE.test(value.asset.assetId || '') ||
    value.asset.assetId !== expectedAssetId ||
    value.asset.version !== 1 ||
    !Number.isSafeInteger(value.asset.byteLength) ||
    value.asset.byteLength <= 0 ||
    value.asset.byteLength > ASSET_MAX_BYTES ||
    value.asset.byteLength !== value.queueItem.byteLength ||
    !MIME_RE.test(value.asset.mime || '') ||
    (value.asset.sha256 !== undefined && !SHA256_RE.test(value.asset.sha256 || ''))
  ) {
    return null;
  }
  return value;
}

function parseRoute(method, url) {
  if (method === 'GET') {
    const readMatch = url.pathname.match(
      /^\/v1\/rooms\/(0\d{5})(?:\/(playback|queue|effects|queue-mode))?$/,
    );
    if (readMatch) {
      const view = readMatch[2] || 'room';
      return {
        kind: 'read',
        roomCode: readMatch[1],
        view,
        requiredScope:
          view === 'room'
            ? SCOPE_ROOM_READ
            : view === 'playback'
              ? SCOPE_PLAYBACK_READ
              : view === 'queue'
                ? SCOPE_QUEUE_READ
                : view === 'effects'
                  ? SCOPE_EFFECTS_READ
                  : SCOPE_PLAYBACK_READ,
      };
    }
    const statusMatch = url.pathname.match(
      /^\/v1\/rooms\/(0\d{5})\/commands\/(cmd_[A-Za-z0-9_-]{22})$/,
    );
    if (statusMatch) {
      return {
        kind: 'command-status',
        roomCode: statusMatch[1],
        commandId: statusMatch[2],
        // Status records are strictly key-bound by the PRO room service. A
        // key must be able to poll its own effect command without also being
        // granted unrelated playback control.
        requiredScope: 0,
      };
    }
    return null;
  }
  if (method === 'POST') {
    const createMatch = url.pathname.match(/^\/v1\/rooms\/(0\d{5})\/commands$/);
    if (createMatch) {
      return {
        kind: 'command-create',
        roomCode: createMatch[1],
        // The command body selects playback:control or effects:control after
        // strict parsing. Do not force effect-only credentials to inherit
        // playback authority.
        requiredScope: 0,
      };
    }
    const queueItemMatch = url.pathname.match(/^\/v1\/rooms\/(0\d{5})\/queue\/items$/);
    if (queueItemMatch) {
      return {
        kind: 'queue-add',
        roomCode: queueItemMatch[1],
        requiredScope: SCOPE_QUEUE_WRITE,
      };
    }
    const queueBatchMatch = url.pathname.match(/^\/v1\/rooms\/(0\d{5})\/queue\/items\/batch$/);
    if (queueBatchMatch) {
      return {
        kind: 'queue-add-batch',
        roomCode: queueBatchMatch[1],
        requiredScope: SCOPE_QUEUE_WRITE,
      };
    }
    const completeMatch = url.pathname.match(
      /^\/v1\/rooms\/(0\d{5})\/media\/uploads\/([A-Za-z0-9][A-Za-z0-9_-]{15,127})\/complete$/,
    );
    if (completeMatch) {
      return {
        kind: 'media-complete',
        roomCode: completeMatch[1],
        assetId: completeMatch[2],
        requiredScope: SCOPE_MEDIA_UPLOAD | SCOPE_QUEUE_WRITE,
      };
    }
    const uploadMatch = url.pathname.match(/^\/v1\/rooms\/(0\d{5})\/media\/uploads$/);
    if (uploadMatch) {
      return {
        kind: 'media-create',
        roomCode: uploadMatch[1],
        requiredScope: SCOPE_MEDIA_UPLOAD | SCOPE_QUEUE_WRITE,
      };
    }
    return null;
  }
  if (method === 'DELETE') {
    const clearMatch = url.pathname.match(/^\/v1\/rooms\/(0\d{5})\/queue\/items$/);
    if (clearMatch) {
      return {
        kind: 'queue-clear',
        roomCode: clearMatch[1],
        requiredScope: SCOPE_QUEUE_WRITE,
      };
    }
    const clearOwnedMatch = url.pathname.match(/^\/v1\/rooms\/(0\d{5})\/queue\/items\/owned$/);
    if (clearOwnedMatch) {
      return {
        kind: 'queue-clear-owned',
        roomCode: clearOwnedMatch[1],
        requiredScope: SCOPE_QUEUE_WRITE,
      };
    }
    const removeMatch = url.pathname.match(
      /^\/v1\/rooms\/(0\d{5})\/queue\/items\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
    );
    return removeMatch
      ? {
          kind: 'queue-remove',
          roomCode: removeMatch[1],
          queueItemId: removeMatch[2],
          requiredScope: SCOPE_QUEUE_WRITE,
        }
      : null;
  }
  if (method === 'PUT') {
    const queueModeMatch = url.pathname.match(/^\/v1\/rooms\/(0\d{5})\/queue-mode$/);
    if (queueModeMatch) {
      return {
        kind: 'queue-mode-update',
        roomCode: queueModeMatch[1],
        requiredScope: SCOPE_PLAYBACK_CONTROL,
      };
    }
    const orderMatch = url.pathname.match(/^\/v1\/rooms\/(0\d{5})\/queue\/order$/);
    return orderMatch
      ? {
          kind: 'queue-reorder',
          roomCode: orderMatch[1],
          requiredScope: SCOPE_QUEUE_WRITE,
        }
      : null;
  }
  return null;
}

async function callLimiter(env, objectName, operation, keyId = null, roomGeneration = null) {
  const namespace = env.DEVELOPER_API_LIMITERS;
  if (!namespace?.idFromName || !namespace?.get) return null;
  try {
    const stub = namespace.get(namespace.idFromName(objectName));
    const response = await stub.fetch('https://developer-api-rate.internal/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation,
        ...(keyId === null ? {} : { keyId }),
        ...(roomGeneration === null ? {} : proRoomGenerationWireFields(roomGeneration)),
      }),
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
    `room:${proRoomObjectName(principal.roomCode, principal.roomGeneration)}`,
    'authenticated-read',
    principal.keyId,
    principal.roomGeneration,
  );
}

async function authenticatedCommandLimit(env, principal) {
  return callLimiter(
    env,
    `room:${proRoomObjectName(principal.roomCode, principal.roomGeneration)}`,
    'authenticated-command',
    principal.keyId,
    principal.roomGeneration,
  );
}

async function authenticatedQueueWriteLimit(env, principal) {
  return callLimiter(
    env,
    `room:${proRoomObjectName(principal.roomCode, principal.roomGeneration)}`,
    'authenticated-queue-write',
    principal.keyId,
    principal.roomGeneration,
  );
}

async function authenticatedMediaUploadCreateLimit(env, principal) {
  return callLimiter(
    env,
    `room:${proRoomObjectName(principal.roomCode, principal.roomGeneration)}`,
    'authenticated-media-upload-create',
    principal.keyId,
    principal.roomGeneration,
  );
}

async function authenticatedMediaUploadCompleteLimit(env, principal) {
  return callLimiter(
    env,
    `room:${proRoomObjectName(principal.roomCode, principal.roomGeneration)}`,
    'authenticated-media-upload-complete',
    principal.keyId,
    principal.roomGeneration,
  );
}

function facadeGenerationHeaders(roomGeneration) {
  return {
    'content-type': 'application/json',
    [PRO_ROOM_GENERATION_HEADER]: proRoomGenerationHeaderValue(roomGeneration),
  };
}

function facadeGenerationBody(roomGeneration) {
  return { roomGeneration };
}

async function facadeRead(env, route, principal, effectsVersion) {
  if (!env.DEVELOPER_API_FACADE?.fetch) return { configurationError: true };
  let response;
  try {
    response = await env.DEVELOPER_API_FACADE.fetch(
      'https://developer-api-facade.internal/internal/v1/read',
      {
        method: 'POST',
        headers: facadeGenerationHeaders(principal.roomGeneration),
        body: JSON.stringify({
          roomCode: route.roomCode,
          ...facadeGenerationBody(principal.roomGeneration),
          keyId: principal.keyId,
          projection: route.view,
          ...(route.view === 'effects' ? { effectsVersion } : {}),
        }),
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

const COMMAND_ERROR_STATUSES = Object.freeze({
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  ROOM_SLEEPING: 409,
  COORDINATOR_INCOMPATIBLE: 409,
  NO_MEDIA: 409,
  IDEMPOTENCY_CONFLICT: 409,
  COMMAND_CAPACITY_EXCEEDED: 409,
  RATE_LIMITED: 429,
  BACKEND_UNAVAILABLE: 503,
  ASSET_CAPACITY_EXCEEDED: 409,
  PLAYLIST_CAPACITY_EXCEEDED: 409,
  PLAYLIST_REVISION_CONFLICT: 409,
  QUEUE_MODE_REVISION_CONFLICT: 409,
  RESERVATION_CAPACITY_EXCEEDED: 409,
  ROOM_QUOTA_EXCEEDED: 409,
  ROOM_STATE_CAPACITY_EXCEEDED: 409,
  UPLOAD_INCOMPLETE: 409,
  UPLOAD_MISMATCH: 409,
});

async function facadeCommand(env, path, body, roomCode, roomGeneration) {
  if (!env.DEVELOPER_API_FACADE?.fetch) return { configurationError: true };
  let response;
  try {
    response = await env.DEVELOPER_API_FACADE.fetch(
      `https://developer-api-facade.internal${path}`,
      {
        method: 'POST',
        headers: facadeGenerationHeaders(roomGeneration),
        body: JSON.stringify({ ...body, ...facadeGenerationBody(roomGeneration) }),
      },
    );
  } catch {
    return { backendError: true };
  }
  const value = await readJsonLimited(response, COMMAND_RESPONSE_MAX_BYTES);
  if (!response.ok) {
    if (
      hasExactKeys(value, ['error']) &&
      typeof value.error === 'string' &&
      COMMAND_ERROR_STATUSES[value.error] === response.status
    ) {
      return { errorCode: value.error, status: response.status };
    }
    return { backendError: true };
  }
  const payload = validateCommandPayload(value, roomCode);
  return payload ? { payload, status: response.status } : { invalidResponse: true };
}

async function facadeMutation(
  env,
  path,
  body,
  roomCode,
  roomGeneration,
  expectedStatus,
  validator,
) {
  if (!env.DEVELOPER_API_FACADE?.fetch) return { configurationError: true };
  let response;
  try {
    response = await env.DEVELOPER_API_FACADE.fetch(
      `https://developer-api-facade.internal${path}`,
      {
        method: 'POST',
        headers: facadeGenerationHeaders(roomGeneration),
        body: JSON.stringify({ ...body, ...facadeGenerationBody(roomGeneration) }),
      },
    );
  } catch {
    return { backendError: true };
  }
  const value = await readJsonLimited(response, MUTATION_RESPONSE_MAX_BYTES);
  if (!response.ok) {
    if (
      hasExactKeys(value, ['error']) &&
      typeof value.error === 'string' &&
      COMMAND_ERROR_STATUSES[value.error] === response.status
    ) {
      return { errorCode: value.error, status: response.status };
    }
    return { backendError: true };
  }
  const payload = validator(value, roomCode);
  return payload && response.status === expectedStatus
    ? { payload, status: response.status }
    : { invalidResponse: true };
}

function auditCommandBestEffort(
  env,
  context,
  requestId,
  principal,
  commandType,
  result,
  statusCode,
  nowMs,
) {
  auditWriteBestEffort(
    env,
    context,
    requestId,
    principal,
    `${commandType === 'set_effects' ? 'effects' : 'playback'}.command.${commandType}`,
    result,
    statusCode,
    nowMs,
  );
}

function auditWriteBestEffort(
  env,
  context,
  requestId,
  principal,
  action,
  result,
  statusCode,
  nowMs,
) {
  if (!context?.waitUntil || !env.DEVELOPER_API_DB?.prepare) return;
  const audit = env.DEVELOPER_API_DB.prepare(
    `INSERT INTO mxqr_developer_api_audit
       (request_id, key_id, room_code, room_generation, action, result, status_code, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      requestId,
      principal.keyId,
      principal.roomCode,
      principal.roomGeneration,
      action,
      result,
      statusCode,
      nowMs,
    )
    .run()
    .catch(() => {});
  context.waitUntil(audit);
}

async function etagFor(view, payload) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(payload))),
  );
  return `"mxqr-${view}-${base64UrlEncode(digest)}"`;
}

function ifNoneMatchMatches(value, currentEtag) {
  let index = 0;
  let matched = false;

  const skipOptionalWhitespace = () => {
    while (value[index] === ' ' || value[index] === '\t') index += 1;
  };

  skipOptionalWhitespace();
  if (value[index] === '*') {
    index += 1;
    skipOptionalWhitespace();
    return index === value.length;
  }

  while (index < value.length) {
    if (value.startsWith('W/', index)) index += 2;
    if (value[index] !== '"') return false;

    const tagStart = index;
    index += 1;
    while (index < value.length && value[index] !== '"') {
      const code = value.charCodeAt(index);
      if (code !== 0x21 && !(code >= 0x23 && code <= 0x7e) && !(code >= 0x80 && code <= 0xff)) {
        return false;
      }
      index += 1;
    }
    if (value[index] !== '"') return false;
    index += 1;

    if (value.slice(tagStart, index) === currentEtag) matched = true;
    skipOptionalWhitespace();
    if (index === value.length) return matched;
    if (value[index] !== ',') return false;
    index += 1;
    skipOptionalWhitespace();
  }

  return false;
}

function readIdempotencyKey(request) {
  const value = request.headers.get('idempotency-key');
  return value !== null && IDEMPOTENCY_KEY_RE.test(value) ? value : null;
}

async function handleApiRequest(request, env, context, requestId) {
  const mode = configuredMode(env);
  if (mode === 'off') return errorResponse('API_DISABLED', 503, requestId, { retryable: true });
  if (request.headers.has('origin')) {
    return errorResponse('BROWSER_ORIGIN_FORBIDDEN', 403, requestId);
  }
  const url = new URL(request.url);
  if (encoder.encode(request.url).byteLength > URL_MAX_BYTES || url.search || url.hash) {
    return errorResponse('NOT_FOUND', 404, requestId);
  }
  const route = parseRoute(request.method, url);
  if (!route) return errorResponse('NOT_FOUND', 404, requestId);
  const effectsVersionHeader = request.headers.get('x-mxqr-effects-version');
  if (effectsVersionHeader !== null && (route.kind !== 'read' || route.view !== 'effects')) {
    return errorResponse('INVALID_REQUEST', 400, requestId);
  }
  const effectsVersion =
    route.kind === 'read' && route.view === 'effects'
      ? effectsVersionHeader === '2'
        ? 2
        : null
      : 1;
  if (effectsVersion === null) {
    return errorResponse('INVALID_REQUEST', 400, requestId);
  }
  const writeRoute = [
    'command-create',
    'queue-mode-update',
    'queue-add',
    'queue-add-batch',
    'queue-clear',
    'queue-clear-owned',
    'queue-remove',
    'queue-reorder',
    'media-create',
    'media-complete',
  ].includes(route.kind);
  if (writeRoute && mode === 'read-only') {
    return errorResponse('NOT_FOUND', 404, requestId);
  }
  if (request.method === 'GET' && request.body) return errorResponse('NOT_FOUND', 404, requestId);
  if (
    (route.kind === 'queue-clear' ||
      route.kind === 'queue-clear-owned' ||
      route.kind === 'queue-remove' ||
      route.kind === 'media-complete') &&
    (await hasNonEmptyRequestBody(request))
  ) {
    return errorResponse('INVALID_REQUEST', 400, requestId);
  }

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
  const limiter =
    route.kind === 'command-create' || route.kind === 'queue-mode-update'
      ? await authenticatedCommandLimit(env, principal)
      : route.kind === 'queue-add' ||
          route.kind === 'queue-add-batch' ||
          route.kind === 'queue-clear' ||
          route.kind === 'queue-clear-owned' ||
          route.kind === 'queue-remove' ||
          route.kind === 'queue-reorder'
        ? await authenticatedQueueWriteLimit(env, principal)
        : route.kind === 'media-create'
          ? await authenticatedMediaUploadCreateLimit(env, principal)
          : route.kind === 'media-complete'
            ? await authenticatedMediaUploadCompleteLimit(env, principal)
            : await authenticatedReadLimit(env, principal);
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

  if (
    route.kind === 'queue-add' ||
    route.kind === 'queue-mode-update' ||
    route.kind === 'queue-add-batch' ||
    route.kind === 'queue-clear' ||
    route.kind === 'queue-clear-owned' ||
    route.kind === 'queue-remove' ||
    route.kind === 'queue-reorder' ||
    route.kind === 'media-create' ||
    route.kind === 'media-complete'
  ) {
    const rawIdempotencyKey = request.headers.get('idempotency-key');
    if (rawIdempotencyKey === null || rawIdempotencyKey.length === 0) {
      return errorResponse('IDEMPOTENCY_KEY_REQUIRED', 400, requestId);
    }
    const idempotencyKey = readIdempotencyKey(request);
    if (!idempotencyKey) return errorResponse('INVALID_REQUEST', 400, requestId);

    let path;
    let body;
    let expectedStatus;
    let validator;
    let auditAction;
    if (route.kind === 'queue-mode-update') {
      const queueMode = parseQueueModeUpdate(
        await readRequestJsonLimited(request, COMMAND_REQUEST_MAX_BYTES),
      );
      if (!queueMode) return errorResponse('INVALID_REQUEST', 400, requestId);
      path = '/internal/v1/queue-mode/update';
      body = {
        keyId: principal.keyId,
        roomCode: route.roomCode,
        idempotencyKey,
        queueMode,
      };
      expectedStatus = 200;
      validator = (value, roomCode) => validateFacadePayload(value, 'queue-mode', roomCode);
      auditAction = 'playback.queue_mode.update';
    } else if (route.kind === 'queue-add') {
      const mutation = parseYouTubeQueueItem(
        await readRequestJsonLimited(request, QUEUE_MUTATION_REQUEST_MAX_BYTES),
      );
      if (!mutation) return errorResponse('INVALID_REQUEST', 400, requestId);
      path = '/internal/v1/queue/mutate';
      body = {
        keyId: principal.keyId,
        roomCode: route.roomCode,
        actorName: principal.label,
        idempotencyKey,
        mutation,
      };
      expectedStatus = 201;
      validator = (value, roomCode) => validateFacadePayload(value, 'queue', roomCode);
      auditAction = 'queue.add_youtube';
    } else if (route.kind === 'queue-add-batch') {
      const mutation = parseYouTubeQueueItemBatch(
        await readRequestJsonLimited(request, QUEUE_MUTATION_REQUEST_MAX_BYTES),
      );
      if (!mutation) return errorResponse('INVALID_REQUEST', 400, requestId);
      path = '/internal/v1/queue/mutate';
      body = {
        keyId: principal.keyId,
        roomCode: route.roomCode,
        actorName: principal.label,
        idempotencyKey,
        mutation,
      };
      expectedStatus = 201;
      validator = (value, roomCode) => validateFacadePayload(value, 'queue', roomCode);
      auditAction = 'queue.add_youtube_batch';
    } else if (route.kind === 'queue-clear') {
      path = '/internal/v1/queue/mutate';
      body = {
        keyId: principal.keyId,
        roomCode: route.roomCode,
        idempotencyKey,
        mutation: { type: 'clear' },
      };
      expectedStatus = 200;
      validator = (value, roomCode) => validateFacadePayload(value, 'queue', roomCode);
      auditAction = 'queue.clear';
    } else if (route.kind === 'queue-clear-owned') {
      path = '/internal/v1/queue/mutate';
      body = {
        keyId: principal.keyId,
        roomCode: route.roomCode,
        idempotencyKey,
        mutation: { type: 'clear_owned' },
      };
      expectedStatus = 200;
      validator = (value, roomCode) => validateFacadePayload(value, 'queue', roomCode);
      auditAction = 'queue.clear_owned';
    } else if (route.kind === 'queue-remove') {
      path = '/internal/v1/queue/mutate';
      body = {
        keyId: principal.keyId,
        roomCode: route.roomCode,
        idempotencyKey,
        mutation: { type: 'remove', queueItemId: route.queueItemId },
      };
      expectedStatus = 200;
      validator = (value, roomCode) => validateFacadePayload(value, 'queue', roomCode);
      auditAction = 'queue.remove';
    } else if (route.kind === 'queue-reorder') {
      const mutation = parseQueueOrder(
        await readRequestJsonLimited(request, QUEUE_MUTATION_REQUEST_MAX_BYTES),
      );
      if (!mutation) return errorResponse('INVALID_REQUEST', 400, requestId);
      path = '/internal/v1/queue/mutate';
      body = { keyId: principal.keyId, roomCode: route.roomCode, idempotencyKey, mutation };
      expectedStatus = 200;
      validator = (value, roomCode) => validateFacadePayload(value, 'queue', roomCode);
      auditAction = 'queue.reorder';
    } else if (route.kind === 'media-create') {
      const media = parseMediaUpload(
        await readRequestJsonLimited(request, MEDIA_UPLOAD_REQUEST_MAX_BYTES),
      );
      if (!media) return errorResponse('INVALID_REQUEST', 400, requestId);
      path = '/internal/v1/media/uploads/create';
      body = { keyId: principal.keyId, roomCode: route.roomCode, idempotencyKey, media };
      expectedStatus = 201;
      validator = (value, roomCode) =>
        validateUploadPayload(value, roomCode, principal.roomGeneration, media);
      auditAction = 'media.upload.reserve';
    } else {
      path = '/internal/v1/media/uploads/complete';
      body = {
        keyId: principal.keyId,
        roomCode: route.roomCode,
        actorName: principal.label,
        idempotencyKey,
        assetId: route.assetId,
      };
      expectedStatus = 201;
      validator = (value, roomCode) =>
        validateUploadCompletionPayload(value, roomCode, route.assetId);
      auditAction = 'media.upload.complete';
    }

    const facade = await facadeMutation(
      env,
      path,
      body,
      route.roomCode,
      principal.roomGeneration,
      expectedStatus,
      validator,
    );
    const auditAtMs = Date.now();
    if (facade.configurationError) {
      auditWriteBestEffort(
        env,
        context,
        requestId,
        principal,
        auditAction,
        'api_not_configured',
        503,
        auditAtMs,
      );
      return errorResponse('API_NOT_CONFIGURED', 503, requestId, { retryable: true });
    }
    if (facade.errorCode) {
      auditWriteBestEffort(
        env,
        context,
        requestId,
        principal,
        auditAction,
        facade.errorCode.toLowerCase(),
        facade.status,
        auditAtMs,
      );
      return errorResponse(facade.errorCode, facade.status, requestId, {
        retryable:
          facade.status === 429 ||
          facade.status === 503 ||
          facade.errorCode === 'UPLOAD_INCOMPLETE',
        ...(facade.errorCode === 'UPLOAD_INCOMPLETE' ? { headers: { 'retry-after': '1' } } : {}),
      });
    }
    if (facade.backendError || facade.invalidResponse || !facade.payload) {
      const invalid = !facade.backendError && facade.invalidResponse;
      auditWriteBestEffort(
        env,
        context,
        requestId,
        principal,
        auditAction,
        invalid ? 'invalid_backend_response' : 'backend_unavailable',
        503,
        auditAtMs,
      );
      return errorResponse(
        invalid ? 'INTERNAL_RESPONSE_INVALID' : 'BACKEND_UNAVAILABLE',
        503,
        requestId,
        { retryable: true },
      );
    }
    auditWriteBestEffort(
      env,
      context,
      requestId,
      principal,
      auditAction,
      'applied',
      expectedStatus,
      auditAtMs,
    );
    return jsonResponse(facade.payload, expectedStatus, requestId, limiterHeaders);
  }

  if (route.kind === 'command-create') {
    const idempotencyKey = request.headers.get('idempotency-key');
    if (idempotencyKey === null || idempotencyKey.length === 0) {
      return errorResponse('IDEMPOTENCY_KEY_REQUIRED', 400, requestId);
    }
    if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      return errorResponse('INVALID_REQUEST', 400, requestId);
    }
    const command = parseDeveloperCommand(
      await readRequestJsonLimited(request, COMMAND_REQUEST_MAX_BYTES),
    );
    if (!command) return errorResponse('INVALID_REQUEST', 400, requestId);
    const commandScope =
      command.type === 'set_effects' ? SCOPE_EFFECTS_CONTROL : SCOPE_PLAYBACK_CONTROL;
    if ((principal.scopeMask & commandScope) !== commandScope) {
      return errorResponse('FORBIDDEN', 403, requestId);
    }
    const facade = await facadeCommand(
      env,
      '/internal/v1/commands/create',
      {
        keyId: principal.keyId,
        roomCode: route.roomCode,
        idempotencyKey,
        command,
      },
      route.roomCode,
      principal.roomGeneration,
    );
    const auditAtMs = Date.now();
    if (facade.configurationError) {
      auditCommandBestEffort(
        env,
        context,
        requestId,
        principal,
        command.type,
        'api_not_configured',
        503,
        auditAtMs,
      );
      return errorResponse('API_NOT_CONFIGURED', 503, requestId, { retryable: true });
    }
    if (facade.errorCode) {
      auditCommandBestEffort(
        env,
        context,
        requestId,
        principal,
        command.type,
        facade.errorCode.toLowerCase(),
        facade.status,
        auditAtMs,
      );
      return errorResponse(facade.errorCode, facade.status, requestId, {
        retryable: facade.status === 429 || facade.status === 503,
      });
    }
    const invalidCommandResponse =
      !facade.backendError && (facade.invalidResponse || facade.status !== 202);
    if (facade.backendError || invalidCommandResponse) {
      auditCommandBestEffort(
        env,
        context,
        requestId,
        principal,
        command.type,
        invalidCommandResponse ? 'invalid_backend_response' : 'backend_unavailable',
        503,
        auditAtMs,
      );
      return errorResponse(
        invalidCommandResponse ? 'INTERNAL_RESPONSE_INVALID' : 'BACKEND_UNAVAILABLE',
        503,
        requestId,
        { retryable: true },
      );
    }
    auditCommandBestEffort(
      env,
      context,
      requestId,
      principal,
      command.type,
      'accepted',
      202,
      auditAtMs,
    );
    return jsonResponse(facade.payload, 202, requestId, limiterHeaders);
  }

  if (route.kind === 'command-status') {
    const facade = await facadeCommand(
      env,
      '/internal/v1/commands/status',
      { roomCode: route.roomCode, keyId: principal.keyId, commandId: route.commandId },
      route.roomCode,
      principal.roomGeneration,
    );
    if (facade.configurationError) {
      return errorResponse('API_NOT_CONFIGURED', 503, requestId, { retryable: true });
    }
    if (facade.errorCode) {
      return errorResponse(facade.errorCode, facade.status, requestId, {
        retryable: facade.status === 429 || facade.status === 503,
      });
    }
    if (facade.backendError || facade.invalidResponse || facade.status !== 200) {
      return errorResponse(
        facade.invalidResponse ? 'INTERNAL_RESPONSE_INVALID' : 'BACKEND_UNAVAILABLE',
        503,
        requestId,
        { retryable: true },
      );
    }
    return jsonResponse(facade.payload, 200, requestId, limiterHeaders, 'private, no-cache');
  }

  const facade = await facadeRead(env, route, principal, effectsVersion);
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
  const representationHeaders = route.view === 'effects' ? { vary: 'X-MXQR-Effects-Version' } : {};
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch !== null && encoder.encode(ifNoneMatch).byteLength > ETAG_HEADER_MAX_BYTES) {
    return errorResponse('NOT_FOUND', 404, requestId);
  }
  if (ifNoneMatch !== null && ifNoneMatchMatches(ifNoneMatch, etag)) {
    return emptyResponse(304, requestId, { ...limiterHeaders, ...representationHeaders, etag });
  }
  return jsonResponse(
    facade.payload,
    200,
    requestId,
    { ...limiterHeaders, ...representationHeaders, etag },
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
          ...(typeof workerVersionId === 'string' && workerVersionId ? { workerVersionId } : {}),
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

  scheduled(controller, env, context) {
    const scheduledTime = Number(controller?.scheduledTime);
    const nowMs = isSafeNonNegativeInteger(scheduledTime) ? scheduledTime : Date.now();
    context.waitUntil(expireDeveloperApiKeys(env, nowMs));
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
  if (
    declared !== null &&
    (!/^\d+$/.test(declared.trim()) || Number(declared) > RATE_REQUEST_MAX_BYTES)
  ) {
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
    return [{ id: 'ingress', limit: INGRESS_LIMIT_PER_MINUTE, windowMs: 60_000, cost: 1 }];
  }
  if (
    hasExactKeys(value, ['operation', 'keyId', 'roomGeneration']) &&
    value.operation === 'authenticated-read' &&
    isProRoomGeneration(value.roomGeneration) &&
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
  if (
    hasExactKeys(value, ['operation', 'keyId', 'roomGeneration']) &&
    value.operation === 'authenticated-command' &&
    isProRoomGeneration(value.roomGeneration) &&
    typeof value.keyId === 'string' &&
    /^[A-Za-z0-9_-]{16}$/.test(value.keyId)
  ) {
    return [
      {
        id: `key:${value.keyId}:playback-control`,
        limit: KEY_COMMAND_LIMIT_PER_MINUTE,
        windowMs: 60_000,
        cost: 1,
      },
      {
        id: 'room:playback-control',
        limit: ROOM_COMMAND_LIMIT_PER_MINUTE,
        windowMs: 60_000,
        cost: 1,
      },
    ];
  }
  if (
    hasExactKeys(value, ['operation', 'keyId', 'roomGeneration']) &&
    value.operation === 'authenticated-queue-write' &&
    isProRoomGeneration(value.roomGeneration) &&
    typeof value.keyId === 'string' &&
    /^[A-Za-z0-9_-]{16}$/.test(value.keyId)
  ) {
    return [
      {
        id: `key:${value.keyId}:queue-write`,
        limit: KEY_QUEUE_WRITE_LIMIT_PER_MINUTE,
        windowMs: 60_000,
        cost: 1,
      },
      {
        id: 'room:queue-write',
        limit: ROOM_QUEUE_WRITE_LIMIT_PER_MINUTE,
        windowMs: 60_000,
        cost: 1,
      },
    ];
  }
  if (
    hasExactKeys(value, ['operation', 'keyId', 'roomGeneration']) &&
    value.operation === 'authenticated-media-upload-create' &&
    isProRoomGeneration(value.roomGeneration) &&
    typeof value.keyId === 'string' &&
    /^[A-Za-z0-9_-]{16}$/.test(value.keyId)
  ) {
    return [
      {
        id: `key:${value.keyId}:media-upload`,
        limit: KEY_MEDIA_UPLOAD_LIMIT_PER_HOUR,
        windowMs: 60 * 60_000,
        cost: 1,
      },
      {
        id: 'room:media-upload',
        limit: ROOM_MEDIA_UPLOAD_LIMIT_PER_HOUR,
        windowMs: 60 * 60_000,
        cost: 1,
      },
    ];
  }
  if (
    hasExactKeys(value, ['operation', 'keyId', 'roomGeneration']) &&
    value.operation === 'authenticated-media-upload-complete' &&
    isProRoomGeneration(value.roomGeneration) &&
    typeof value.keyId === 'string' &&
    /^[A-Za-z0-9_-]{16}$/.test(value.keyId)
  ) {
    return [
      {
        id: `key:${value.keyId}:media-upload-complete`,
        limit: 30,
        windowMs: 60 * 60_000,
        cost: 1,
      },
      {
        id: 'room:media-upload-complete',
        limit: 90,
        windowMs: 60 * 60_000,
        cost: 1,
      },
    ];
  }
  return null;
}

function exactInternalRoomGeneration(request, value) {
  const header = request.headers.get(PRO_ROOM_GENERATION_HEADER);
  const roomGeneration = /^(?:0|[1-9]\d*)$/.test(header || '') ? Number(header) : null;
  return {
    valid: isProRoomGeneration(roomGeneration) && value?.roomGeneration === roomGeneration,
    roomGeneration,
  };
}

export class DeveloperApiRateLimiter {
  constructor(state) {
    this.storage = state.storage;
    this.mutationTail = Promise.resolve();
  }

  enqueueMutation(task) {
    const run = this.mutationTail.then(task, task);
    this.mutationTail = run.catch(() => {});
    return run;
  }

  fetch(request) {
    return this.enqueueMutation(() => this.handleFetch(request));
  }

  async handleFetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/internal/admin/v1/decommission') {
      const value = await readRequestJsonLimited(request, 1024);
      const generation = exactInternalRoomGeneration(request, value);
      if (
        request.method !== 'POST' ||
        !hasExactKeys(value, ['roomCode', 'roomGeneration', 'requestId']) ||
        !ROOM_CODE_RE.test(value.roomCode) ||
        request.headers.get('x-mxqr-pro-room-code') !== value.roomCode ||
        !generation.valid ||
        !DECOMMISSION_REQUEST_ID_RE.test(value.requestId)
      ) {
        return Response.json({ error: 'INVALID_REQUEST' }, { status: 400 });
      }
      const storedIdentity = await this.storage.get('roomIdentity');
      const storedGeneration = storedIdentity?.roomGeneration;
      if (
        storedIdentity &&
        (!isProRoomGeneration(storedGeneration) || storedGeneration !== generation.roomGeneration)
      ) {
        return Response.json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, { status: 410 });
      }
      if (typeof this.storage.deleteAll === 'function') await this.storage.deleteAll();
      else if (typeof this.storage.delete === 'function') await this.storage.delete('buckets');
      await this.storage.put('decommissioned', {
        v: 1,
        roomCode: value.roomCode,
        ...proRoomGenerationWireFields(generation.roomGeneration),
        requestId: value.requestId,
        decommissionedAtMs: Date.now(),
      });
      if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
      return Response.json({
        ok: true,
        roomCode: value.roomCode,
        ...proRoomGenerationWireFields(generation.roomGeneration),
        status: 'decommissioned',
      });
    }
    if (await this.storage.get('decommissioned')) {
      return Response.json({ error: 'PRO_ROOM_DECOMMISSIONED' }, { status: 410 });
    }
    const body = await readRateRequest(request);
    const requested = rateBucketsForRequest(body);
    if (!requested) return Response.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    const authenticatedRoomGeneration =
      body.operation === 'ingress-read' ? null : body.roomGeneration;
    if (authenticatedRoomGeneration !== null) {
      const storedIdentity = await this.storage.get('roomIdentity');
      const storedGeneration = storedIdentity?.roomGeneration;
      if (
        storedIdentity &&
        (!isProRoomGeneration(storedGeneration) || storedGeneration !== authenticatedRoomGeneration)
      ) {
        return Response.json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, { status: 410 });
      }
      if (!storedIdentity) {
        await this.storage.put('roomIdentity', {
          v: 1,
          ...proRoomGenerationWireFields(authenticatedRoomGeneration),
        });
      }
    }
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

  alarm() {
    return this.enqueueMutation(() => this.handleAlarm());
  }

  async handleAlarm() {
    if (await this.storage.get('decommissioned')) {
      if (typeof this.storage.delete === 'function') await this.storage.delete('buckets');
      if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
      return;
    }
    const nowMs = Date.now();
    const stored = (await this.storage.get('buckets')) || {};
    for (const [id, bucket] of Object.entries(stored)) {
      if (!bucket || !Number.isSafeInteger(bucket.resetAtMs) || bucket.resetAtMs <= nowMs) {
        delete stored[id];
      }
    }
    const remaining = Object.values(stored);
    if (remaining.length === 0) {
      const roomIdentity = await this.storage.get('roomIdentity');
      if (roomIdentity && typeof this.storage.delete === 'function') {
        await this.storage.delete('buckets');
      } else if (typeof this.storage.deleteAll === 'function') {
        await this.storage.deleteAll();
      }
      if (typeof this.storage.deleteAlarm === 'function') {
        await this.storage.deleteAlarm();
      }
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
  'effects:read': SCOPE_EFFECTS_READ,
  'effects:control': SCOPE_EFFECTS_CONTROL,
});

export function isDeveloperApiRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_RE.test(value);
}
