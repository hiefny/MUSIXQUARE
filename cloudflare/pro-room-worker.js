import {
  ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
  ACCOUNT_ASSERTION_HEADER,
  verifyAccountAssertion,
} from './account-assertion.js';
import {
  effectsContractVersion,
  initialEffectsState,
  mergeRoomEffectsPatch,
  normalizeStoredEffects,
  parseRoomEffects,
  parseRoomEffectsPatch,
  publicEffects,
  publicSettingsSync,
} from './pro-room-effects.js';
import {
  developerQueueMode,
  initialQueueModeState,
  normalizeStoredQueueMode,
  parseQueueModeValues,
  PLAYLIST_MAX_ITEMS,
  publicQueueMode,
  QUEUE_ITEM_ID_RE,
  shuffledQueueItemIds,
} from './pro-room-queue-mode.js';
import {
  capabilitiesFromPermissions,
  clonePermissionSet,
  DELEGATED_ADMIN_PERMISSIONS,
  isProInternalAuthorityPermission,
  MEMBER_PERMISSIONS,
  normalizePermissionSet,
  OWNER_PERMISSIONS,
  PRO_ROOM_PERMISSION_KEYS,
  requiredProSystemMessagePermission,
} from './pro-room-permissions.js';
import { hasExactKeys, isSafeNonNegativeInteger } from './pro-room-validation.js';
import {
  PRO_ROOM_ACTIVATION_CLAIM_MAX_LIFETIME_MS as ACTIVATION_CLAIM_MAX_LIFETIME_MS,
  PRO_ROOM_OWNER_TRANSFER_CLAIM_DEFAULT_LIFETIME_MS as OWNER_TRANSFER_CLAIM_DEFAULT_LIFETIME_MS,
  createProRoomOwnerTransferCommitProof as ownerTransferCommitProof,
  inspectProRoomOwnerTransferClaim as inspectOwnerTransferClaim,
  issueProRoomActivationClaim,
  issueProRoomOwnerRecoveryClaim,
  issueProRoomOwnerTransferClaim,
  verifyProRoomActivationClaim as verifyActivationClaim,
  verifyProRoomOwnerRecoveryClaim as verifyOwnerRecoveryClaim,
  verifyProRoomOwnerTransferRevocationReceipt as verifyOwnerTransferRevocationReceipt,
} from './pro-room-claims.js';
import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEqual,
  hmacBase64Url,
  hmacBytes,
  randomToken,
  sha256Base64Url,
  sha256Bytes,
} from './pro-room-crypto.js';
import { isSafeVisibleDisplayName } from './display-name-policy.js';
import {
  INITIAL_PRO_ROOM_GENERATION,
  isProRoomGeneration,
  proRoomGenerationHeaderValue,
  proRoomMediaPrefix,
  proRoomObjectName,
} from './pro-room-generation.js';
import { cancelReadableBody, readBodyBytesLimited } from './pro-room-body.js';
import { gateServiceMaintenance, readServiceMaintenance } from './service-maintenance.js';
import {
  finalizeProRoomActivationEntitlement,
  reserveProRoomActivationEntitlement,
  reserveProRoomOwnershipTransferEntitlement,
} from './pro-room-grants.js';

export { MusixquareServiceControl } from './service-control-object.js';
export {
  issueProRoomActivationClaim,
  issueProRoomOwnerRecoveryClaim,
  issueProRoomOwnerTransferClaim,
} from './pro-room-claims.js';

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
]);
const INITIAL_PRO_ROOM_CODES = new Set(INITIAL_PRO_ROOMS.map((room) => room.roomCode));
const OWNER_TRANSFER_COMPLETED_REPLAY_TTL_MS = 10 * 60 * 1000;
const OWNER_TRANSFER_COMPLETED_REPLAY_MAX_LIFETIME_MS = 15 * 60 * 1000;
const PRO_ROOM_REGISTRY_MAX_ITEMS = 1000;
const PRO_ROOM_REGISTRY_REFRESH_MS = 5_000;
const PRO_ROOM_GENERATION_HEADER = 'x-mxqr-pro-room-generation';
const PIN_RE = /^\d{8}$/;
const ACCOUNT_ID_RE = /^acct_[A-Za-z0-9_-]{22}$/;
const ACCOUNT_TABLE = 'mxqr_accounts';
const ACCOUNT_DELETION_TABLE = 'mxqr_account_deletions';
const OWNER_TRANSFER_ID_RE = /^transfer_[A-Za-z0-9_-]{22}$/;
const OWNER_TRANSFER_REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const OWNER_AUTHORITY_REMOVAL_ID_RE = /^removal_[A-Za-z0-9_-]{22}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{14,126})[A-Za-z0-9]$/;
const PRO_ROOM_SESSION_ACTOR_HEADER = 'x-mxqr-pro-session-actor';
const PRO_ROOM_SESSION_ACTOR_RE = /^[A-Za-z0-9_-]{43}$/;
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
const BOT_DEVELOPER_KEY_ID = 'MxqrGeminiBot001';
const BOT_REQUEST_ID_RE = IDEMPOTENCY_KEY_RE;
// A 24-byte random token is encoded as exactly 32 Base64URL characters. Unlike
// public resource identifiers, Base64URL tokens may legitimately begin with
// `-` or `_`; rejecting those values would make a server-issued BOT lease fail
// nondeterministically on its next request.
const BOT_LEASE_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

function proRoomGenerationWireFields(roomGeneration) {
  if (!isProRoomGeneration(roomGeneration)) throw new Error('Invalid room generation');
  return { roomGeneration };
}

function proRoomGenerationWireHeaders(roomGeneration) {
  if (!isProRoomGeneration(roomGeneration)) throw new Error('Invalid room generation');
  return { [PRO_ROOM_GENERATION_HEADER]: proRoomGenerationHeaderValue(roomGeneration) };
}

function proRoomGenerationUploadMetadataHeaders(roomGeneration) {
  if (!isProRoomGeneration(roomGeneration)) throw new Error('Invalid room generation');
  return { 'x-amz-meta-mxqr-generation': proRoomGenerationHeaderValue(roomGeneration) };
}

function responseRoomGenerationMatches(payload, roomGeneration) {
  if (!payload || typeof payload !== 'object' || !isProRoomGeneration(roomGeneration)) return false;
  return payload.roomGeneration === roomGeneration;
}

function exactInternalRoomGeneration(request, payload) {
  const header = request.headers.get(PRO_ROOM_GENERATION_HEADER);
  if (!/^(?:0|[1-9]\d*)$/.test(header || '')) return null;
  const roomGeneration = Number(header);
  if (!isProRoomGeneration(roomGeneration)) return null;
  return payload?.roomGeneration === undefined || payload.roomGeneration === roomGeneration
    ? roomGeneration
    : null;
}

const SCHEMA_VERSION = 1;
// Keep the bounded core and playlist rows in separate keys so a large queue
// cannot crowd media completion metadata out of the Durable Object record.
const STORAGE_V2_CORE_KEY = 'pro-room:v2:core';
const STORAGE_V2_PLAYLIST_PREFIX = 'pro-room:v2:playlist:';
const STORAGE_V2_SCHEMA_VERSION = 2;
const ROOM_QUOTA_BYTES = 1024 * 1024 * 1024;
const ASSET_MAX_BYTES = 200 * 1024 * 1024;
const DEVELOPER_YOUTUBE_BATCH_MAX_ITEMS = 100;
const YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS = 5000;
const DEVELOPER_REMOVE_MANY_MAX_ITEMS = 20;
const BOT_MAX_TRACK_ITEMS = 3;
const BOT_MEMBER_MINUTE_LIMIT = 3;
const BOT_ROOM_HOUR_LIMIT = 100;
const BOT_MEMBER_MINUTE_MS = 60 * 1000;
const BOT_ROOM_HOUR_MS = 60 * 60 * 1000;
const BOT_REQUEST_LEASE_MS = 45 * 1000;
// Every active PRO participant is an equal room member. Signaling applies the
// same 100-device ceiling to the corresponding authenticated control sockets.
const PRESENCE_MAX_ITEMS = 100;
const SESSION_MAX_ITEMS = 128;
const DEFAULT_PEER_DISPLAY_NAME = 'Peer';
const ASSET_MAX_ITEMS = 1024;
const RESERVED_ASSET_MAX_ITEMS = 32;
const RESERVED_ASSET_MAX_ITEMS_PER_PARTICIPANT = 8;
const RESERVED_ASSET_MAX_ITEMS_PER_DEVELOPER_KEY = 2;
const IDEMPOTENCY_MAX_ITEMS = 256;
// Developer mutations receive their own full 24-hour replay budget. Because
// the complete room core is deliberately bounded to one 1.2 MiB value, this
// ledger cannot grow without limit; once full, new mutations fail closed while
// all accepted receipts remain exact.
const DEVELOPER_MUTATION_IDEMPOTENCY_MAX_ITEMS = 256;
const RATE_LIMIT_MAX_ITEMS = 512;
const BOT_RATE_LIMIT_MAX_ITEMS = 512;
const RECOVERY_NONCE_MAX_ITEMS = 128;
const OWNER_TRANSFER_NONCE_MAX_ITEMS = 128;
const STAGING_TOMBSTONE_MAX_ITEMS = ASSET_MAX_ITEMS;
const DEVELOPER_COMMAND_MAX_ITEMS = 64;
const DEVELOPER_COMMAND_MAX_ACTIVE_ITEMS = 8;
// The command ledger is intentionally separate from the browser mutation
// idempotency ledger. Keeping the API window independent prevents sustained
// automation from evicting a fresh browser receipt and turning a retry into a
// duplicate command.
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
// Compact mutations must be able to carry every playlist accepted by the
// 3 MiB persisted-state budget. Keep the endpoint bounded while matching the
// browser client's JSON ceiling.
const REQUEST_MAX_BYTES = 4 * 1024 * 1024;
const PUBLIC_MUTATION_BODY_TIMEOUT_MS = 10_000;
const INTERNAL_REQUEST_BODY_TIMEOUT_MS = 2_000;
const SMALL_REQUEST_MAX_BYTES = 16 * 1024;
const UNLOAD_CLOSE_REQUEST_MAX_BYTES = 4 * 1024;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
// Google account identity is optional and must not inherit the 30-day room
// cookie lifetime. A fresh App-Worker assertion renews this short server-owned
// lease; logout-all therefore removes room authority even when another device
// cannot receive the browser logout event. The remaining lease is also the
// bounded grace window for a transient App/D1 outage.
const ACCOUNT_IDENTITY_LEASE_TTL_MS = 120 * 1000;
const ACCOUNT_IDENTITY_LEASE_RENEW_THRESHOLD_MS = 60 * 1000;
const PRESENCE_TTL_SECONDS = 45;
// Keep this in sync with src/pro-room/runtime.ts. The guard covers one normal
// client interval, one coalescing window, and one storage-retry interval.
const PRESENCE_HEARTBEAT_EXPECTED_INTERVAL_MS = 15_000;
const PRESENCE_HEARTBEAT_PERSIST_COALESCE_MS = 1_000;
const PRESENCE_HEARTBEAT_PERSIST_RETRY_MS = 1_000;
const ALARM_MAINTENANCE_RETRY_MAX_MS = 60_000;
const PRESENCE_HEARTBEAT_PERSIST_EXPIRY_GUARD_MS =
  PRESENCE_HEARTBEAT_EXPECTED_INTERVAL_MS +
  PRESENCE_HEARTBEAT_PERSIST_COALESCE_MS +
  PRESENCE_HEARTBEAT_PERSIST_RETRY_MS;
const PRESENCE_BROADCAST_RETRY_BASE_MS = 1_000;
const PRESENCE_BROADCAST_RETRY_MAX_MS = 60_000;
const PRESENCE_BROADCAST_RETRY_MAX_ATTEMPTS = 16;
const PLAYBACK_BROADCAST_RETRY_BASE_MS = 1_000;
const PLAYBACK_BROADCAST_RETRY_MAX_MS = 60_000;
const PLAYBACK_BROADCAST_RETRY_MAX_ATTEMPTS = 16;
// One undelivered canonical COMMIT may be the base for one newer PREPARE or
// CANCEL. Newer COMMITs supersede both, so the durable playback outbox never
// needs more than these two ordered records.
const PLAYBACK_BROADCAST_OUTBOX_MAX_ITEMS = 2;
const RESERVATION_TTL_SECONDS = 15 * 60;
// A completed upload is deliberately retained long enough for the client to
// append it to the authoritative playlist. If that never happens, the asset is
// an orphan and the Durable Object reclaims it after this grace period.
const ASSET_GC_GRACE_SECONDS = 15 * 60;
const ASSET_GC_RETRY_SECONDS = 60;
// A presigned PUT may have started before its signature expired but become
// visible in R2 only after the first cleanup pass. Keep checking the staging
// key until it has remained absent for the same one-hour continuous-empty
// window used by room decommissioning.
const STAGING_OBJECT_EMPTY_WINDOW_MS = 60 * 60 * 1000;
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
// Session admission sits behind the App facade's bounded response window. A
// room mutation can therefore commit after the browser receives a gateway
// timeout. Retain a compact receipt long enough for an explicit retry while
// avoiding permanent pressure on the room-wide 256-item browser ledger.
const SESSION_CREATE_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
// Playback controls are high-frequency, short-retry mutations. The browser
// retries one command for at most a few seconds, so retaining every full
// command response for 24 hours can saturate the shared 256-item browser
// ledger during ordinary all-day playback. Keep a generous ten-minute replay
// fence for controls while preserving the 24-hour contract for playlist,
// media, account, and other destructive browser mutations.
const PLAYBACK_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const PLAYBACK_IDEMPOTENCY_SCOPE_SEGMENT = ':playback-authority:';
// workerd rejects PBKDF2 counts above 100,000. Keep the stored record at the
// runtime ceiling so activation and PIN verification use the strongest value
// Cloudflare can execute instead of surfacing an unhandled NotSupportedError.
const PBKDF2_MAX_ITERATIONS = 100_000;
const PBKDF2_ITERATIONS = PBKDF2_MAX_ITERATIONS;
const MAX_DISPLAY_NAME_LENGTH = 64;
const MAX_MEDIA_NAME_LENGTH = 2048;
const MAX_TEXT_LENGTH = 2048;
const PLAYBACK_MAX_POSITION_SECONDS = 7 * 24 * 60 * 60;
const PLAYBACK_TRANSITION_DEADLINE_MS = 3_000;
// Encode the transition kind in a numeric field that older Workers already
// accept. This keeps an in-flight transition readable after a Worker rollback;
// the one millisecond deadline difference is operationally inert.
const PLAYBACK_ZERO_START_TRANSITION_DEADLINE_MS = PLAYBACK_TRANSITION_DEADLINE_MS - 1;
const PLAYBACK_COMMIT_LEAD_MS = 700;
// Strict event parsers make a new COMMIT JSON key unsafe during a rolling PWA
// deployment. A -1ms lead is an inert marker to old clients and lets refreshed
// clients recognize only an explicitly classified true zero-start. Legacy and
// unknown 700ms transitions fail safely as ordinary scheduled controls.
const PLAYBACK_ZERO_START_COMMIT_LEAD_MS = PLAYBACK_COMMIT_LEAD_MS - 1;
// A browser ENDED event is an observation, not a control command.  When the
// media reports a finite duration, require both the browser cursor and the
// server-projected room cursor to be genuinely near that end.  Unknown/live
// durations use the narrower timeline-alignment rule in
// applyPlaybackAuthorityCommand instead of being rejected wholesale.
const PLAYBACK_ENDED_NEAR_END_TOLERANCE_SECONDS = 2;
const PLAYBACK_UNKNOWN_DURATION_POSITION_TOLERANCE_SECONDS = 10;
const PLAYBACK_UNKNOWN_DURATION_MIN_PLAYING_MS = 750;
const PLAYBACK_TRANSITION_ID_RE = /^transition_[A-Za-z0-9_-]{22}$/;
const OWNER_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
// v1 covers direct playback controls and queue invalidations. v2 adds
// set_effects; v3 adds aggregate-aware next; v4 adds a bounded first-track
// title to queue-addition hints. Older frames remain valid so a rolling deploy
// does not strand an already-open tab.
const DEVELOPER_CONTROL_VERSION = 1;
const DEVELOPER_EFFECTS_CONTROL_VERSION = 2;
const DEVELOPER_NEXT_CONTROL_VERSION = 3;
const DEVELOPER_QUEUE_TITLE_CONTROL_VERSION = 4;
const DEVELOPER_CONTROL_MAX_VERSION = DEVELOPER_QUEUE_TITLE_CONTROL_VERSION;
const DEVELOPER_COMMAND_TTL_MS = 30 * 1000;
const DEVELOPER_COMMAND_MAX_ATTEMPTS = 3;
const DEVELOPER_COMMAND_DISPATCH_TIMEOUT_MS = 900;
const INTERNAL_SERVICE_RESPONSE_TIMEOUT_MS = 2_000;
const INTERNAL_SERVICE_RESPONSE_MAX_BYTES = 16 * 1024;
const DEVELOPER_COMMAND_RETENTION_MS = 10 * 60 * 1000;
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

const ACCOUNT_MEMBER_MAX_ITEMS = 100;
const ANONYMOUS_ADMIN_MAX_ITEMS = 100;
const ACCOUNT_DELETION_TOMBSTONE_MAX_ITEMS = 256;
const ACCOUNT_DELETION_TOMBSTONE_TTL_MS = 5 * 60 * 1000;

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
      registered: new Map(),
      suspended: new Map(),
      suspendedRechecks: new Map(),
      refreshedAtMs: 0,
      refreshPromise: null,
    };
    registryCacheByDb.set(db, cache);
  }
  return cache;
}

async function recheckSuspendedRoomGeneration(db, cache, roomCode, expectedGeneration) {
  const key = `${roomCode}:${expectedGeneration}`;
  if (!cache.suspendedRechecks.has(key)) {
    const recheck = (async () => {
      try {
        const statement = db
          .prepare(
            `SELECT room_generation, status FROM mxqr_pro_room_registry
             WHERE room_code = ?1 LIMIT 1`,
          )
          .bind(roomCode);
        const row =
          typeof statement.first === 'function'
            ? await statement.first()
            : (await statement.all())?.results?.[0] || null;
        const generation = Number(row?.room_generation);
        if (
          row?.status === 'registered' &&
          generation === expectedGeneration &&
          cache.suspended.get(roomCode) === expectedGeneration
        ) {
          cache.suspended.delete(roomCode);
          cache.registered.set(roomCode, expectedGeneration);
          return expectedGeneration;
        }
        // A still-suspended row, a recycled generation, a missing row, and
        // every other registry state remain closed at the public facade.
        return null;
      } catch {
        return null;
      }
    })();
    cache.suspendedRechecks.set(key, recheck);
    recheck.finally(() => {
      if (cache.suspendedRechecks.get(key) === recheck) {
        cache.suspendedRechecks.delete(key);
      }
    });
  }
  return cache.suspendedRechecks.get(key);
}

async function frontProvisionedRoomGeneration(
  roomCode,
  env,
  nowMs = Date.now(),
  allowSuspended = false,
) {
  const db = env?.MUSIXQUARE_ADMIN_DB || env?.ADMIN_METRICS_DB || null;
  // Local/test environments without the shared registry keep only the
  // developer canary. Production always binds D1 and resolves every room from
  // the canonical registry.
  if (!db?.prepare) {
    return INITIAL_PRO_ROOM_CODES.has(roomCode) ? INITIAL_PRO_ROOM_GENERATION : null;
  }
  const cache = registryCacheFor(db);
  if (nowMs - cache.refreshedAtMs < PRO_ROOM_REGISTRY_REFRESH_MS) {
    const registeredGeneration = cache.registered.get(roomCode);
    if (registeredGeneration !== undefined) return registeredGeneration;
    const suspendedGeneration = cache.suspended.get(roomCode);
    if (suspendedGeneration === undefined) return null;
    if (allowSuspended) return suspendedGeneration;
    // A transfer commit can promote D1 immediately after bootstrap populated
    // this short-lived suspended cache. Re-read only this exact room before a
    // non-allowlisted request so the new owner never inherits a five-second
    // false 404, while a still-suspended/recycled/unreadable row stays closed.
    return recheckSuspendedRoomGeneration(db, cache, roomCode, suspendedGeneration);
  }
  if (!cache.refreshPromise) {
    cache.refreshPromise = (async () => {
      const result = await db
        .prepare(
          `SELECT room_code, room_generation, status FROM mxqr_pro_room_registry
           WHERE status IN ('registered', 'suspended')
           ORDER BY room_code ASC LIMIT ?1`,
        )
        .bind(PRO_ROOM_REGISTRY_MAX_ITEMS + 1)
        .all();
      const rows = Array.isArray(result?.results) ? result.results : [];
      if (rows.length > PRO_ROOM_REGISTRY_MAX_ITEMS) {
        throw new Error('PRO room registry exceeds its bounded cache capacity');
      }
      const registered = new Map();
      const suspended = new Map();
      for (const row of rows) {
        const generation = Number(row?.room_generation);
        if (isProRoomCode(row?.room_code) && isProRoomGeneration(generation)) {
          if (row.status === 'registered') registered.set(row.room_code, generation);
          else if (row.status === 'suspended') suspended.set(row.room_code, generation);
        }
      }
      cache.registered = registered;
      cache.suspended = suspended;
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
    cache.registered = new Map();
    cache.suspended = new Map();
    cache.refreshedAtMs = Date.now();
    return null;
  }
  return (
    cache.registered.get(roomCode) ??
    (allowSuspended ? cache.suspended.get(roomCode) : undefined) ??
    null
  );
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

function devicePlatformFromRequest(request) {
  const userAgent = String(request.headers.get('user-agent') || '');
  if (
    /iPad|iPhone|iPod/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && /Mobile/i.test(userAgent))
  ) {
    return 'ios';
  }
  if (/Android/i.test(userAgent)) return 'android';
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos';
  if (/Linux|X11/i.test(userAgent)) return 'linux';
  return 'other';
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers':
      'content-type,idempotency-key,authorization,x-mxqr-pro-participant-id,x-mxqr-pro-presence-incarnation,x-mxqr-pro-effects-version',
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

function boundedString(value, maxLength, allowEmpty = false) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  if ((!allowEmpty && result.length === 0) || result.length > maxLength) return null;
  return result;
}

function generatedPeerOrdinal(value) {
  if (typeof value !== 'string') return null;
  const match = /^Peer ([1-9]\d*)$/i.exec(value.trim());
  if (!match) return null;
  const ordinal = Number(match[1]);
  return Number.isSafeInteger(ordinal) && ordinal >= 1 && ordinal <= SESSION_MAX_ITEMS
    ? ordinal
    : null;
}

function isGeneratedPeerNamespaceDisplayName(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  return (
    normalized.toLowerCase() === DEFAULT_PEER_DISPLAY_NAME.toLowerCase() ||
    /^Peer \d+$/i.test(normalized)
  );
}

function validDeveloperActorName(value) {
  const normalized = boundedString(value, MAX_DISPLAY_NAME_LENGTH);
  return normalized !== null && isSafeVisibleDisplayName(normalized);
}

function signalingDisplayName(value) {
  const normalized = boundedString(value, MAX_DISPLAY_NAME_LENGTH);
  return normalized !== null && isSafeVisibleDisplayName(normalized) ? normalized : 'Peer';
}

function queueAdditionActorName(value, fallback = 'Peer') {
  const normalized = boundedString(value, MAX_DISPLAY_NAME_LENGTH);
  const source =
    normalized !== null && isSafeVisibleDisplayName(normalized) ? normalized : fallback;
  let result = '';
  for (const character of source) {
    if (result.length + character.length > 30) break;
    result += character;
  }
  return result || 'Peer';
}

function queueAdditionTrackTitle(value) {
  const normalized =
    typeof value === 'string'
      ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim()
      : '';
  if (!normalized) return null;
  let result = '';
  for (const character of normalized) {
    if (result.length + character.length > 120) break;
    result += character;
  }
  return result || null;
}

async function createProSignalingTicket(payload, secret) {
  const encoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await hmacBase64Url(secret, encoded)}`;
}

async function createOpaqueCredential(secret) {
  const random = randomToken(32);
  return `v1.${random}.${await hmacBase64Url(secret, `v1.${random}`)}`;
}

async function createDeterministicOpaqueCredential(secret, context) {
  const deterministic = await hmacBase64Url(secret, `pro-room-credential\u0000${context}`);
  return `v1.${deterministic}.${await hmacBase64Url(secret, `v1.${deterministic}`)}`;
}

async function verifyOpaqueCredential(token, secret) {
  if (!token || typeof secret !== 'string' || secret.length < 32) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return false;
  return constantTimeEqual(await hmacBase64Url(secret, `${parts[0]}.${parts[1]}`), parts[2]);
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
  const bounded = await readBodyBytesLimited(request, maxBytes, INTERNAL_REQUEST_BODY_TIMEOUT_MS);
  if (bounded.error === 'too-large') return { error: 'REQUEST_TOO_LARGE', status: 413 };
  if (bounded.error === 'timeout' || bounded.error === 'aborted') {
    return { error: 'REQUEST_TIMEOUT', status: 408 };
  }
  if (bounded.error || !(bounded.body instanceof Uint8Array)) {
    return { error: 'INVALID_REQUEST' };
  }
  if (
    bounded.body.byteLength === 0 &&
    allowEmpty &&
    (declaredLength === null || declaredLength === 0)
  ) {
    return { empty: true };
  }
  if (!acceptedContentType) return { error: 'INVALID_REQUEST' };
  try {
    return {
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bounded.body)),
    };
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

function initialRoomState(
  roomCode,
  provisioned = INITIAL_PRO_ROOM_CODES.has(roomCode),
  roomGeneration = INITIAL_PRO_ROOM_GENERATION,
) {
  return {
    v: 1,
    roomCode,
    roomGeneration,
    provisioned,
    activationClaimGeneration: 0,
    ownershipTransferClaimGeneration: 0,
    status: 'unactivated',
    suspensionReason: null,
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
    pendingPlaybackTransition: null,
    pendingPlaybackBroadcasts: [],
    presence: {
      coordinatorEpoch: 0,
      revision: 0,
      coordinatorParticipantId: null,
      participants: {},
    },
    pendingPresenceBroadcast: null,
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
    ownerAuthorityEpoch: 0,
    developerAuthorityEpoch: 0,
    ownerMemberId: null,
    ownerAccountId: null,
    ownerDisplayName: null,
    accountMembers: {},
    anonymousAdministrators: {},
    accountDeletionTombstones: {},
    nextMemberDisplayNumber: 1,
    ownerCredentialHash: null,
    pendingOwnershipTransfer: null,
    completedOwnershipTransfer: null,
    ownerAuthorityRemoval: null,
    sessions: {},
    assets: {},
    idempotency: {},
    developerMutationIdempotency: {},
    rateLimits: {},
    botRateLimits: {},
    consumedRecoveryNonces: {},
    consumedOwnershipTransferClaims: {},
    stagingTombstones: {},
    developerCommands: {},
    developerCommandIdempotency: {},
  };
}

function internalOwnerTransferReconciliation(room) {
  const record = room.pendingOwnershipTransfer || room.completedOwnershipTransfer || null;
  if (!record) return null;
  const completed = room.completedOwnershipTransfer === record;
  return {
    phase: completed ? 'completed' : 'pending',
    transferId: record.transferId,
    claimGeneration: completed ? null : record.claimGeneration,
    requestId: record.requestId,
    targetAccountId: record.targetAccountId,
    previousOwnerAccountId: record.previousOwnerAccountId,
    preparedAtMs: record.preparedAtMs,
    expiresAtMs: record.expiresAtMs,
    committedAtMs: completed ? record.committedAtMs : null,
    replayUntilMs: completed ? record.replayUntilMs : record.expiresAtMs,
  };
}

function internalOwnerAuthorityRemoval(room) {
  const removal = room.ownerAuthorityRemoval;
  if (!removal) return null;
  return {
    accountId: removal.accountId,
    removalId: removal.removalId,
    removedAtMs: removal.removedAtMs,
    ownerAuthorityEpoch: removal.ownerAuthorityEpoch,
    fencedCoordinatorEpoch: removal.fencedCoordinatorEpoch,
    projectionAcked: removal.projectionAcked,
  };
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
          ...(item.source.videoIds === undefined ? {} : { videoIds: [...item.source.videoIds] }),
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

function sessionPermissionSet(room, session) {
  if (session.role === 'owner') return clonePermissionSet(OWNER_PERMISSIONS);
  if (session.accountId) {
    const member = room.accountMembers?.[session.accountId];
    if (member?.role === 'controller') {
      return normalizePermissionSet(member.permissions, DELEGATED_ADMIN_PERMISSIONS);
    }
    return clonePermissionSet(MEMBER_PERMISSIONS);
  }
  const administrator = room.anonymousAdministrators?.[session.memberId];
  return administrator
    ? normalizePermissionSet(administrator.permissions, DELEGATED_ADMIN_PERMISSIONS)
    : clonePermissionSet(MEMBER_PERMISSIONS);
}

function sessionCapabilities(room, session) {
  return capabilitiesFromPermissions(session.role, sessionPermissionSet(room, session));
}

function compareAdministratorText(left, right) {
  // Do not let an isolate's default locale affect a server-authoritative
  // projection. Relational string comparison has a fixed UTF-16 code-unit
  // order, and memberId provides the final deterministic tie-breaker.
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function publicAdministrators(room) {
  const liveCounts = new Map();
  for (const participant of Object.values(room.presence.participants || {})) {
    liveCounts.set(participant.memberId, (liveCounts.get(participant.memberId) || 0) + 1);
  }
  const ownerAccount = room.ownerAccountId ? room.accountMembers?.[room.ownerAccountId] : null;
  const administrators = [
    {
      memberId: room.ownerMemberId,
      memberDisplayNumber: 0,
      isAuthenticated: !!ownerAccount,
      displayName: ownerAccount?.displayName || room.ownerDisplayName || 'Owner',
      role: 'owner',
      permissions: clonePermissionSet(OWNER_PERMISSIONS),
      inheritedPermissions: [...PRO_ROOM_PERMISSION_KEYS],
      onlineDeviceCount: liveCounts.get(room.ownerMemberId) || 0,
    },
  ];
  for (const member of Object.values(room.accountMembers || {})) {
    if (member.role !== 'controller') continue;
    administrators.push({
      memberId: member.memberId,
      memberDisplayNumber: member.displayNumber,
      isAuthenticated: true,
      displayName: member.displayName,
      role: 'controller',
      permissions: clonePermissionSet(member.permissions),
      inheritedPermissions: [],
      onlineDeviceCount: liveCounts.get(member.memberId) || 0,
    });
  }
  for (const administrator of Object.values(room.anonymousAdministrators || {})) {
    administrators.push({
      memberId: administrator.memberId,
      memberDisplayNumber: administrator.displayNumber,
      isAuthenticated: false,
      displayName: administrator.displayName,
      role: 'controller',
      permissions: clonePermissionSet(administrator.permissions),
      inheritedPermissions: [],
      onlineDeviceCount: liveCounts.get(administrator.memberId) || 0,
    });
  }
  return administrators.sort((left, right) => {
    const ownerOrder = Number(right.role === 'owner') - Number(left.role === 'owner');
    if (ownerOrder !== 0) return ownerOrder;

    const leftOnline = left.onlineDeviceCount > 0;
    const rightOnline = right.onlineDeviceCount > 0;
    const onlineOrder = Number(rightOnline) - Number(leftOnline);
    if (onlineOrder !== 0) return onlineOrder;

    if (leftOnline) {
      const displayNumberOrder = left.memberDisplayNumber - right.memberDisplayNumber;
      if (displayNumberOrder !== 0) return displayNumberOrder;
    } else {
      const displayNameOrder = compareAdministratorText(left.displayName, right.displayName);
      if (displayNameOrder !== 0) return displayNameOrder;
    }

    return compareAdministratorText(left.memberId, right.memberId);
  });
}

function publicSnapshot(room, session = null) {
  const participants = Object.values(room.presence.participants)
    .sort(
      (left, right) =>
        left.joinedAtMs - right.joinedAtMs || left.participantId.localeCompare(right.participantId),
    )
    .map((participant) => {
      const participantSession = room.sessions[participant.sessionHash];
      const memberDisplayNumber =
        participant.memberDisplayNumber ??
        participantSession?.memberDisplayNumber ??
        participantSession?.peerOrdinal ??
        (participant.role === 'owner' ? 0 : null);
      return {
        participantId: participant.participantId,
        memberId: participant.memberId,
        memberDisplayNumber,
        isAuthenticated: typeof participant.accountId === 'string',
        displayName: participant.displayName,
        devicePlatform: participant.devicePlatform || 'other',
        role: participant.role,
        capabilities:
          participantSession && room.status === 'active'
            ? sessionCapabilities(room, participantSession)
            : [],
        joinedAtMs: participant.joinedAtMs,
      };
    });
  const participant = session ? room.presence.participants[session.participantId] : null;
  const viewer = session
    ? {
        memberId: session.memberId,
        memberDisplayNumber:
          session.memberDisplayNumber ?? session.peerOrdinal ?? (session.role === 'owner' ? 0 : 1),
        isAuthenticated: typeof session.accountId === 'string',
        participantId: session.participantId,
        presenceIncarnationId: participant?.presenceIncarnationId || session.presenceIncarnationId,
        displayName: session.displayName,
        role: session.role,
        capabilities: room.status === 'active' ? sessionCapabilities(room, session) : [],
        coordinatorEligible: false,
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
    effectsRevision: room.effects.revision,
    queueModeRevision: room.queueMode.revision,
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
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: publicAdministrators(room),
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

function developerProjection(room, projection, nowMs, requesterKeyId, effectsVersion = 1) {
  if (projection === 'room') {
    return {
      schemaVersion: 1,
      view: 'room',
      roomCode: room.roomCode,
      status: room.status,
      runtime: room.runtime,
      revision: room.revision,
      participantCount: Object.keys(room.presence.participants).length,
      // The Durable Object is the authority. Developer control no longer
      // depends on one browser tab remaining awake and relay-capable.
      controlAvailable: room.status === 'active',
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
      youtubeVideoId: room.playback.youtubeVideoId,
      youtubeSubIndex: room.playback.youtubeSubIndex,
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
  if (projection === 'effects') return publicEffects(room, effectsVersion);
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
  const result = [];
  const playlistAggregates = new Map();
  for (const item of items) {
    if (item.playlistId === undefined) {
      result.push(item);
      continue;
    }
    const aggregate = playlistAggregates.get(item.playlistId);
    if (aggregate === undefined) {
      playlistAggregates.set(item.playlistId, {
        index: result.length,
        mode: item.videoIds === undefined ? 'rows' : 'manifest',
      });
      result.push(item);
      continue;
    }
    const existing = result[aggregate.index];
    if (aggregate.mode === 'manifest') {
      if (
        item.videoIds === undefined ||
        existing.videoIds.length !== item.videoIds.length ||
        existing.videoIds.some((videoId, index) => videoId !== item.videoIds[index])
      ) {
        return null;
      }
      continue;
    }
    if (item.videoIds !== undefined) return null;
    const videoIds = [
      ...(existing.videoIds === undefined ? [existing.videoId] : existing.videoIds),
      item.videoId,
    ];
    if (videoIds.length > YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS) return null;
    result[aggregate.index] = { ...existing, videoIds };
  }
  return result;
}

function parseYouTubeVideoIds(value, videoId, playlistId) {
  if (value === undefined) return undefined;
  if (
    playlistId === undefined ||
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS ||
    !value.includes(videoId) ||
    value.some((candidate) => !YOUTUBE_VIDEO_ID_RE.test(candidate || ''))
  ) {
    return null;
  }
  return [...value];
}

function parseDeveloperQueueMutation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type === 'add_youtube') {
    if (
      !hasExactKeys(
        value,
        ['type', 'videoId', 'name'],
        ['playlistId', 'videoIds', 'title', 'artist', 'thumbnail'],
      ) ||
      !YOUTUBE_VIDEO_ID_RE.test(value.videoId || '') ||
      (value.playlistId !== undefined && !YOUTUBE_PLAYLIST_ID_RE.test(value.playlistId || ''))
    ) {
      return null;
    }
    const metadata = parseDeveloperMetadata(value);
    const videoIds = parseYouTubeVideoIds(value.videoIds, value.videoId, value.playlistId);
    if (!metadata || videoIds === null) return null;
    return {
      type: 'add_youtube',
      videoId: value.videoId,
      ...(value.playlistId === undefined ? {} : { playlistId: value.playlistId }),
      ...(videoIds === undefined ? {} : { videoIds }),
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
        !hasExactKeys(
          item,
          ['videoId', 'name'],
          ['playlistId', 'videoIds', 'title', 'artist', 'thumbnail'],
        ) ||
        !YOUTUBE_VIDEO_ID_RE.test(item.videoId || '') ||
        (item.playlistId !== undefined && !YOUTUBE_PLAYLIST_ID_RE.test(item.playlistId || ''))
      ) {
        return null;
      }
      const metadata = parseDeveloperMetadata(item);
      const videoIds = parseYouTubeVideoIds(item.videoIds, item.videoId, item.playlistId);
      return metadata && videoIds !== null
        ? {
            videoId: item.videoId,
            ...(item.playlistId === undefined ? {} : { playlistId: item.playlistId }),
            ...(videoIds === undefined ? {} : { videoIds }),
            ...metadata,
          }
        : null;
    });
    if (items.some((item) => item === null)) return null;
    const canonicalItems = canonicalizeDeveloperYouTubeBatchItems(items);
    return canonicalItems === null ? null : { type: 'add_youtube_batch', items: canonicalItems };
  }
  if (value.type === 'remove') {
    return hasExactKeys(value, ['type', 'queueItemId']) &&
      QUEUE_ITEM_ID_RE.test(value.queueItemId || '')
      ? { type: 'remove', queueItemId: value.queueItemId }
      : null;
  }
  if (value.type === 'remove_many') {
    if (
      !hasExactKeys(value, ['type', 'queueItemIds']) ||
      !Array.isArray(value.queueItemIds) ||
      value.queueItemIds.length < 1 ||
      value.queueItemIds.length > DEVELOPER_REMOVE_MANY_MAX_ITEMS ||
      value.queueItemIds.some((queueItemId) => !QUEUE_ITEM_ID_RE.test(queueItemId || '')) ||
      new Set(value.queueItemIds).size !== value.queueItemIds.length
    ) {
      return null;
    }
    return { type: 'remove_many', queueItemIds: [...value.queueItemIds] };
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
        'queueItemIds',
        'basePlaylistRevision',
        'playbackCommand',
        'repeatMode',
        'shuffleEnabled',
        'virtualTrebleEnabled',
        'answer',
      ],
    ) ||
    ![
      'add_youtube',
      'play_existing',
      'remove_items',
      'clear_queue',
      'playback',
      'queue_mode',
      'virtual_treble',
      'answer',
    ].includes(value.intent)
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
  if (value.intent === 'remove_items') {
    if (
      !hasExactKeys(value, ['intent', 'queueItemIds'], ['answer']) ||
      !Array.isArray(value.queueItemIds) ||
      value.queueItemIds.length < 1 ||
      value.queueItemIds.length > DEVELOPER_REMOVE_MANY_MAX_ITEMS ||
      value.queueItemIds.some((queueItemId) => !QUEUE_ITEM_ID_RE.test(queueItemId || '')) ||
      new Set(value.queueItemIds).size !== value.queueItemIds.length
    ) {
      return null;
    }
    return {
      intent: value.intent,
      queueItemIds: [...value.queueItemIds],
      ...(answer ? { answer } : {}),
    };
  }
  if (value.intent === 'clear_queue') {
    return hasExactKeys(value, ['intent', 'basePlaylistRevision'], ['answer']) &&
      isSafeNonNegativeInteger(value.basePlaylistRevision)
      ? {
          intent: value.intent,
          basePlaylistRevision: value.basePlaylistRevision,
          ...(answer ? { answer } : {}),
        }
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
  if (value.intent === 'virtual_treble') {
    return hasExactKeys(value, ['intent', 'virtualTrebleEnabled'], ['answer']) &&
      typeof value.virtualTrebleEnabled === 'boolean'
      ? {
          intent: value.intent,
          virtualTrebleEnabled: value.virtualTrebleEnabled,
          ...(answer ? { answer } : {}),
        }
      : null;
  }
  return answer ? { intent: value.intent, answer } : null;
}

function parseBotTracks(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > BOT_MAX_TRACK_ITEMS) return null;
  const mutation = parseDeveloperQueueMutation({ type: 'add_youtube_batch', items: value });
  return mutation?.type === 'add_youtube_batch' ? mutation.items : null;
}

function botDestructiveSummary(action, removedCount, languageHint = '') {
  const korean = /[가-힣]/u.test(languageHint);
  if (action === 'clear_queue') {
    if (removedCount === 0) {
      return korean ? '재생목록이 이미 비어 있어요.' : 'The queue was already empty.';
    }
    return korean
      ? `트랙 ${removedCount}개를 삭제해 재생목록을 비웠어요.`
      : `Cleared the queue and removed ${removedCount} track${removedCount === 1 ? '' : 's'}.`;
  }
  return korean
    ? `트랙 ${removedCount}개를 삭제했어요.`
    : `Removed ${removedCount} track${removedCount === 1 ? '' : 's'}.`;
}

function botDestructiveResult(action, removedCount, playbackChanged, languageHint = '') {
  return {
    ok: true,
    summary: botDestructiveSummary(action, removedCount, languageHint),
    addedCount: 0,
    playbackChanged,
  };
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

async function readResponseBytesLimited(response, maxBytes, signal) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > maxBytes)) {
    cancelReadableBody(response, 'INTERNAL_RESPONSE_TOO_LARGE');
    throw new Error('INTERNAL_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  let stop;
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  const abortReason = () =>
    signal.reason instanceof Error ? signal.reason : new Error('INTERNAL_RESPONSE_TIMEOUT');
  const abort = () => {
    stop({ kind: 'aborted' });
    cancelReadableBody(reader, abortReason());
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });

  try {
    while (true) {
      const outcome = await Promise.race([
        reader.read().then(
          (value) => ({ kind: 'read', value }),
          () => ({ kind: 'invalid' }),
        ),
        stopped,
      ]);
      if (outcome.kind === 'aborted') throw abortReason();
      if (outcome.kind !== 'read') throw new Error('INTERNAL_RESPONSE_INVALID');
      const { done, value } = outcome.value;
      if (done) break;
      if (!value) continue;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        cancelReadableBody(reader, 'INTERNAL_RESPONSE_TOO_LARGE');
        throw new Error('INTERNAL_RESPONSE_TOO_LARGE');
      }
      chunks.push(bytes);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    try {
      reader.releaseLock();
    } catch {
      // A non-cooperative stream may retain the timed-out pending read.
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchWithDeadline(
  fetcher,
  request,
  timeoutMs,
  maxBytes = INTERNAL_SERVICE_RESPONSE_MAX_BYTES,
) {
  const controller = new AbortController();
  let timeoutId = null;
  let timedOut = false;
  const operation = Promise.resolve()
    .then(() => fetcher(new Request(request, { signal: controller.signal })))
    .then(async (response) => {
      if (timedOut) {
        cancelReadableBody(response, 'INTERNAL_RESPONSE_TIMEOUT');
        return null;
      }
      const bytes = await readResponseBytesLimited(response, maxBytes, controller.signal);
      return timedOut ? null : { response, bytes };
    })
    // Normalize both an early dependency failure and a rejection that arrives
    // after the timeout so neither can surface as an unhandled rejection.
    .catch(() => null);
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('INTERNAL_RESPONSE_TIMEOUT'));
      resolve(null);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([operation, timeout]);
    if (!result) throw new Error('INTERNAL_RESPONSE_UNAVAILABLE');
    return result;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

function parseInternalJsonResponse(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
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
  if (
    hasExactKeys(source, ['kind', 'videoId'], ['playlistId', 'videoIds']) &&
    source.kind === 'youtube'
  ) {
    if (!YOUTUBE_VIDEO_ID_RE.test(source.videoId)) return null;
    if (source.playlistId !== undefined && !YOUTUBE_PLAYLIST_ID_RE.test(source.playlistId))
      return null;
    const videoIds = parseYouTubeVideoIds(source.videoIds, source.videoId, source.playlistId);
    if (videoIds === null) return null;
    return {
      queueItemId: value.queueItemId,
      name: value.name,
      ...optional,
      source: {
        kind: 'youtube',
        videoId: source.videoId,
        ...(source.playlistId === undefined ? {} : { playlistId: source.playlistId }),
        ...(videoIds === undefined ? {} : { videoIds }),
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

function preservesImmutableYouTubeManifest(previous, next) {
  const previousVideoIds =
    previous?.source.kind === 'youtube' ? previous.source.videoIds : undefined;
  const nextVideoIds = next?.source.kind === 'youtube' ? next.source.videoIds : undefined;
  if (previousVideoIds === undefined && nextVideoIds === undefined) return true;
  // A legacy playlist row may be enriched exactly once after the client has
  // resolved its canonical ordered manifest. The queue item and source
  // identity must not change during that bounded upgrade.
  if (previousVideoIds === undefined && Array.isArray(nextVideoIds)) {
    return (
      previous?.source.kind === 'youtube' &&
      next?.source.kind === 'youtube' &&
      previous.source.playlistId !== undefined &&
      previous.source.playlistId === next.source.playlistId &&
      previous.source.videoId === next.source.videoId
    );
  }
  return (
    previous?.source.kind === 'youtube' &&
    next?.source.kind === 'youtube' &&
    previous.source.playlistId === next.source.playlistId &&
    previous.source.videoId === next.source.videoId &&
    Array.isArray(previousVideoIds) &&
    Array.isArray(nextVideoIds) &&
    previousVideoIds.length === nextVideoIds.length &&
    previousVideoIds.every((videoId, index) => videoId === nextVideoIds[index])
  );
}

function playbackMatchesYouTubeManifest(playback, item) {
  if (item?.source.kind !== 'youtube' || item.source.videoIds === undefined) return true;
  return (
    isSafeNonNegativeInteger(playback.youtubeSubIndex) &&
    playback.youtubeSubIndex < item.source.videoIds.length &&
    item.source.videoIds[playback.youtubeSubIndex] === playback.youtubeVideoId
  );
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
        value.youtubeSubIndex > 100_000 ||
        !playbackMatchesYouTubeManifest(value, currentItem)
      ) {
        return null;
      }
    } else if (value.youtubeVideoId !== null || value.youtubeSubIndex !== null) {
      return null;
    }
  }
  return structuredClone(value);
}

function playbackPositionAt(playback, nowMs) {
  if (
    playback.state !== 'playing' ||
    !Number.isSafeInteger(playback.updatedAtMs) ||
    playback.updatedAtMs <= 0 ||
    nowMs <= playback.updatedAtMs
  ) {
    return playback.positionSeconds;
  }
  return Math.min(
    PLAYBACK_MAX_POSITION_SECONDS,
    playback.positionSeconds + (nowMs - playback.updatedAtMs) / 1_000,
  );
}

function playbackTraversalOrder(room) {
  return room.queueMode.shuffleEnabled
    ? [...room.queueMode.shuffleOrder]
    : room.playlist.map((item) => item.queueItemId);
}

function adjacentQueueItemId(room, direction, { repeatCurrent = false } = {}) {
  const order = playbackTraversalOrder(room);
  if (order.length === 0) return null;
  const current = room.currentQueueItemId;
  if (repeatCurrent && current && order.includes(current)) return current;
  const index = current ? order.indexOf(current) : -1;
  if (direction === 'next') {
    const nextIndex = index < 0 ? 0 : index + 1;
    if (nextIndex < order.length) return order[nextIndex];
    return room.queueMode.repeatMode === 1 ? order[0] : null;
  }
  if (index > 0) return order[index - 1];
  if (index === 0 && room.queueMode.repeatMode === 1 && order.length > 1) {
    return order[order.length - 1];
  }
  return current || order[0];
}

function parsePlaybackAuthorityCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!isSafeNonNegativeInteger(value.baseRevision)) return null;
  const base = { type: value.type, baseRevision: value.baseRevision };
  if (
    value.type === 'play' ||
    value.type === 'pause' ||
    value.type === 'stop' ||
    value.type === 'next' ||
    value.type === 'previous'
  ) {
    return hasExactKeys(value, ['type', 'baseRevision']) ? base : null;
  }
  if (value.type === 'seek') {
    return hasExactKeys(value, ['type', 'baseRevision', 'positionSeconds']) &&
      Number.isFinite(value.positionSeconds) &&
      value.positionSeconds >= 0 &&
      value.positionSeconds <= PLAYBACK_MAX_POSITION_SECONDS
      ? { ...base, positionSeconds: value.positionSeconds }
      : null;
  }
  if (value.type === 'select') {
    if (
      !hasExactKeys(
        value,
        ['type', 'baseRevision', 'queueItemId'],
        ['state', 'positionSeconds', 'youtubeVideoId', 'youtubeSubIndex'],
      ) ||
      !QUEUE_ITEM_ID_RE.test(value.queueItemId || '') ||
      (value.state !== undefined && value.state !== 'playing' && value.state !== 'paused') ||
      (value.positionSeconds !== undefined &&
        (!Number.isFinite(value.positionSeconds) ||
          value.positionSeconds < 0 ||
          value.positionSeconds > PLAYBACK_MAX_POSITION_SECONDS)) ||
      (value.youtubeVideoId !== undefined &&
        !YOUTUBE_VIDEO_ID_RE.test(value.youtubeVideoId || '')) ||
      (value.youtubeSubIndex !== undefined &&
        (!isSafeNonNegativeInteger(value.youtubeSubIndex) || value.youtubeSubIndex > 100_000))
    ) {
      return null;
    }
    if ((value.youtubeVideoId === undefined) !== (value.youtubeSubIndex === undefined)) return null;
    return {
      ...base,
      queueItemId: value.queueItemId,
      state: value.state || 'playing',
      positionSeconds: value.positionSeconds || 0,
      ...(value.youtubeVideoId === undefined
        ? {}
        : { youtubeVideoId: value.youtubeVideoId, youtubeSubIndex: value.youtubeSubIndex }),
    };
  }
  if (value.type === 'ended' || value.type === 'unavailable') {
    if (
      !hasExactKeys(
        value,
        [
          'type',
          'baseRevision',
          'queueItemId',
          'mediaKind',
          'observedPositionSeconds',
          'durationSeconds',
        ],
        ['youtubeVideoId', 'youtubeSubIndex'],
      ) ||
      !QUEUE_ITEM_ID_RE.test(value.queueItemId || '') ||
      (value.mediaKind !== 'file' && value.mediaKind !== 'youtube') ||
      !Number.isFinite(value.observedPositionSeconds) ||
      value.observedPositionSeconds < 0 ||
      value.observedPositionSeconds > PLAYBACK_MAX_POSITION_SECONDS ||
      (value.durationSeconds !== null &&
        (!Number.isFinite(value.durationSeconds) ||
          value.durationSeconds <= 0 ||
          value.durationSeconds > PLAYBACK_MAX_POSITION_SECONDS)) ||
      (value.youtubeVideoId !== undefined &&
        !YOUTUBE_VIDEO_ID_RE.test(value.youtubeVideoId || '')) ||
      (value.youtubeSubIndex !== undefined &&
        (!isSafeNonNegativeInteger(value.youtubeSubIndex) || value.youtubeSubIndex > 100_000)) ||
      (value.youtubeVideoId === undefined) !== (value.youtubeSubIndex === undefined)
    ) {
      return null;
    }
    return {
      ...base,
      queueItemId: value.queueItemId,
      mediaKind: value.mediaKind,
      observedPositionSeconds: value.observedPositionSeconds,
      durationSeconds: value.durationSeconds,
      ...(value.youtubeVideoId === undefined
        ? {}
        : { youtubeVideoId: value.youtubeVideoId, youtubeSubIndex: value.youtubeSubIndex }),
    };
  }
  return null;
}

function normalizeStoredPlaybackTransition(value, room) {
  if (value === null || value === undefined) return null;
  if (
    !hasExactKeys(
      value,
      [
        'transitionId',
        'coordinatorEpoch',
        'basePlaybackRevision',
        'createdAtMs',
        'deadlineAtMs',
        'target',
        'cohort',
        'ready',
        'developerCommandId',
      ],
      ['resumeFromSleep'],
    ) ||
    !PLAYBACK_TRANSITION_ID_RE.test(value.transitionId || '') ||
    value.coordinatorEpoch !== room.presence.coordinatorEpoch ||
    value.basePlaybackRevision !== room.playback.revision ||
    !isSafeNonNegativeInteger(value.createdAtMs) ||
    !isSafeNonNegativeInteger(value.deadlineAtMs) ||
    value.deadlineAtMs < value.createdAtMs ||
    value.deadlineAtMs - value.createdAtMs > PLAYBACK_TRANSITION_DEADLINE_MS ||
    !Array.isArray(value.cohort) ||
    value.cohort.length > PRESENCE_MAX_ITEMS ||
    new Set(value.cohort).size !== value.cohort.length ||
    value.cohort.some((incarnationId) => !OPAQUE_ID_RE.test(incarnationId || '')) ||
    !value.ready ||
    typeof value.ready !== 'object' ||
    Array.isArray(value.ready) ||
    Object.keys(value.ready).some(
      (incarnationId) =>
        !value.cohort.includes(incarnationId) ||
        (value.ready[incarnationId] !== 'ready' && value.ready[incarnationId] !== 'failed'),
    ) ||
    (value.resumeFromSleep !== undefined && value.resumeFromSleep !== true) ||
    (value.developerCommandId !== null &&
      !DEVELOPER_COMMAND_ID_RE.test(value.developerCommandId || ''))
  ) {
    return null;
  }
  const target = parsePlaybackCandidate(
    value.target,
    new Map(room.playlist.map((item) => [item.queueItemId, item])),
    value.target?.queueItemId ?? null,
    room.presence.coordinatorEpoch,
  );
  if (!target || target.revision !== room.playback.revision + 1) return null;
  return structuredClone(value);
}

function playbackTransitionCohortIsTerminal(pending) {
  return pending.cohort.every(
    (incarnationId) =>
      pending.ready[incarnationId] === 'ready' || pending.ready[incarnationId] === 'failed',
  );
}

function normalizeStoredPlaybackBroadcastRecord(value, room) {
  if (
    !hasExactKeys(value, [
      'kind',
      'coordinatorEpoch',
      'transitionId',
      'basePlaybackRevision',
      'playbackRevision',
      'targets',
      'event',
      'createdAtMs',
      'attempts',
      'retryAtMs',
    ]) ||
    (value.kind !== 'prepare' && value.kind !== 'cancel' && value.kind !== 'commit') ||
    value.coordinatorEpoch !== room.presence.coordinatorEpoch ||
    (value.transitionId !== null && !PLAYBACK_TRANSITION_ID_RE.test(value.transitionId || '')) ||
    !isSafeNonNegativeInteger(value.basePlaybackRevision) ||
    !isSafeNonNegativeInteger(value.playbackRevision) ||
    value.playbackRevision !== value.basePlaybackRevision + 1 ||
    !Array.isArray(value.targets) ||
    value.targets.length === 0 ||
    value.targets.length > PRESENCE_MAX_ITEMS ||
    new Set(value.targets).size !== value.targets.length ||
    value.targets.some((target) => !OPAQUE_ID_RE.test(target || '')) ||
    !isSafeNonNegativeInteger(value.createdAtMs) ||
    !isSafeNonNegativeInteger(value.attempts) ||
    value.attempts > PLAYBACK_BROADCAST_RETRY_MAX_ATTEMPTS ||
    !Number.isSafeInteger(value.retryAtMs) ||
    value.retryAtMs <= 0 ||
    !value.event ||
    typeof value.event !== 'object' ||
    Array.isArray(value.event)
  ) {
    return null;
  }

  const event = value.event;
  if (value.kind === 'prepare') {
    if (
      !hasExactKeys(event, [
        'type',
        'transitionId',
        'serverTimeMs',
        'deadlineAtMs',
        'basePlaybackRevision',
        'target',
      ]) ||
      event.type !== 'pro-playback-prepare' ||
      event.transitionId !== value.transitionId ||
      event.basePlaybackRevision !== value.basePlaybackRevision ||
      !isSafeNonNegativeInteger(event.serverTimeMs) ||
      !isSafeNonNegativeInteger(event.deadlineAtMs) ||
      event.deadlineAtMs < event.serverTimeMs ||
      event.deadlineAtMs - event.serverTimeMs > PLAYBACK_TRANSITION_DEADLINE_MS
    ) {
      return null;
    }
    const target = parsePlaybackCandidate(
      event.target,
      new Map(room.playlist.map((item) => [item.queueItemId, item])),
      event.target?.queueItemId ?? null,
      value.coordinatorEpoch,
    );
    if (!target || target.revision !== value.playbackRevision) return null;
  } else if (value.kind === 'cancel') {
    if (
      !hasExactKeys(event, ['type', 'transitionId', 'serverTimeMs', 'reason']) ||
      event.type !== 'pro-playback-cancel' ||
      event.transitionId !== value.transitionId ||
      !isSafeNonNegativeInteger(event.serverTimeMs) ||
      typeof event.reason !== 'string' ||
      event.reason.length === 0 ||
      event.reason.length > 64
    ) {
      return null;
    }
  } else {
    if (
      !hasExactKeys(event, ['type', 'transitionId', 'serverTimeMs', 'executeAtMs', 'playback']) ||
      event.type !== 'pro-playback-commit' ||
      event.transitionId !== value.transitionId ||
      !isSafeNonNegativeInteger(event.serverTimeMs) ||
      !isSafeNonNegativeInteger(event.executeAtMs)
    ) {
      return null;
    }
    const playback = parsePlaybackCandidate(
      event.playback,
      new Map(room.playlist.map((item) => [item.queueItemId, item])),
      event.playback?.queueItemId ?? null,
      value.coordinatorEpoch,
    );
    if (
      !playback ||
      playback.revision !== value.playbackRevision ||
      playback.updatedAtMs !== event.executeAtMs
    ) {
      return null;
    }
  }
  return structuredClone(value);
}

function normalizeStoredPlaybackBroadcasts(value, room) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > PLAYBACK_BROADCAST_OUTBOX_MAX_ITEMS) return [];
  const records = value.map((record) => normalizeStoredPlaybackBroadcastRecord(record, room));
  if (records.some((record) => record === null)) return [];
  if (records.length === 2) {
    const [first, second] = records;
    const commitThenSuccessor =
      first.kind === 'commit' &&
      second.kind !== 'commit' &&
      first.playbackRevision === second.basePlaybackRevision;
    const cancelThenTransition =
      first.kind === 'cancel' &&
      second.kind !== 'cancel' &&
      first.basePlaybackRevision === second.basePlaybackRevision &&
      first.playbackRevision === second.playbackRevision;
    if (!commitThenSuccessor && !cancelThenTransition) return [];
  }
  return records;
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
  return hex(await sha256Bytes(value));
}

async function botDerivedIdempotencyKey(requestId, operation) {
  const candidate = `${requestId}.${operation}`;
  if (IDEMPOTENCY_KEY_RE.test(candidate)) return candidate;
  return `bot-${operation}-${await sha256Hex(requestId)}`;
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

class RoomStateStorageCommitError extends Error {
  constructor(cause) {
    const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
    super(`PRO room state storage transaction failed${detail}`, { cause });
    this.name = 'RoomStateStorageCommitError';
  }
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
    Object.keys(room.accountMembers || {}).length > ACCOUNT_MEMBER_MAX_ITEMS ||
    Object.keys(room.anonymousAdministrators || {}).length > ANONYMOUS_ADMIN_MAX_ITEMS ||
    Object.keys(room.accountDeletionTombstones || {}).length >
      ACCOUNT_DELETION_TOMBSTONE_MAX_ITEMS ||
    Object.keys(room.assets).length > ASSET_MAX_ITEMS ||
    Object.keys(room.assets).length + Object.keys(room.stagingTombstones || {}).length >
      ASSET_MAX_ITEMS ||
    Object.keys(room.idempotency).length > IDEMPOTENCY_MAX_ITEMS ||
    Object.keys(room.developerMutationIdempotency || {}).length >
      DEVELOPER_MUTATION_IDEMPOTENCY_MAX_ITEMS ||
    Object.keys(room.rateLimits).length > RATE_LIMIT_MAX_ITEMS ||
    Object.keys(room.botRateLimits || {}).length > BOT_RATE_LIMIT_MAX_ITEMS ||
    Object.keys(room.consumedRecoveryNonces || {}).length > RECOVERY_NONCE_MAX_ITEMS ||
    Object.keys(room.consumedOwnershipTransferClaims || {}).length >
      OWNER_TRANSFER_NONCE_MAX_ITEMS ||
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
    const maintenanceResponse = await gateServiceMaintenance(request, env, { format: 'json' });
    if (maintenanceResponse) return maintenanceResponse;
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
    const ownerTransferPreparePath =
      request.method === 'POST' && url.pathname === `/v1/rooms/${match[1]}/owner-transfer/prepare`;
    const bootstrapPath =
      request.method === 'GET' && url.pathname === `/v1/rooms/${match[1]}/bootstrap`;
    const roomGeneration = await frontProvisionedRoomGeneration(
      match[1],
      env,
      Date.now(),
      ownerTransferPreparePath || bootstrapPath,
    );
    if (roomGeneration === null) {
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
    // Start the public-body deadline before the asynchronous IP HMAC. A slow
    // sender must not gain extra unbounded time merely because the facade is
    // completing unrelated control-plane work before forwarding the request.
    const bodyReadPromise =
      request.method === 'GET' || request.method === 'HEAD'
        ? Promise.resolve({ body: null })
        : readBodyBytesLimited(request, REQUEST_MAX_BYTES, PUBLIC_MUTATION_BODY_TIMEOUT_MS);
    const ipHash = await hmacBase64Url(rateSecret, `pro-room-rate:${rawIp}`);
    const headers = new Headers(request.headers);
    headers.set('x-mxqr-pro-room-code', match[1]);
    headers.set(PRO_ROOM_GENERATION_HEADER, proRoomGenerationHeaderValue(roomGeneration));
    headers.set('x-mxqr-pro-ip-hash', ipHash);
    headers.delete('cf-connecting-ip');
    headers.delete('x-forwarded-for');
    let body = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const buffered = await bodyReadPromise;
      if (buffered.error === 'too-large') {
        return withPublicHeaders(errorResponse('PRO_ROOM_REQUEST_BODY_TOO_LARGE', 413), origin);
      }
      if (buffered.error === 'timeout' || buffered.error === 'aborted') {
        return withPublicHeaders(errorResponse('PRO_ROOM_REQUEST_BODY_TIMEOUT', 408), origin);
      }
      if (buffered.error) {
        return withPublicHeaders(errorResponse('INVALID_REQUEST', 400), origin);
      }
      body = buffered.body;
    }
    const stub = env.PRO_ROOMS.get(
      env.PRO_ROOMS.idFromName(proRoomObjectName(match[1], roomGeneration)),
    );
    const upstreamInit = { method: request.method, headers, signal: request.signal };
    if (body !== null) upstreamInit.body = body;
    const response = await stub.fetch(new Request(request.url, upstreamInit));
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
    this.accountIdentityMigrationPending = false;
    this.developerCommandMigrationPending = false;
    this.playbackAuthorityMigrationPending = false;
    this.persistedPlaylistSignatures = new Map();
    this.persistedPresenceLastSeenAtMs = new Map();
    this.hasV2Persistence = false;
    this.heartbeatDurabilityDirty = false;
    this.lastHeartbeatDurabilityPersistedAtMs = null;
    this.heartbeatFlushGeneration = 0;
    this.pendingHeartbeatFlushGeneration = null;
    this.pendingHeartbeatFlushTimer = null;
    this.stateStorageRollbackDepth = 0;
    this.alarmMaintenanceDirty = false;
    this.alarmMaintenanceRetryAttempt = 0;
    this.alarmMaintenanceRetryTimer = null;
    // `undefined` means a restarted instance has not yet reconciled the
    // storage alarm; `null` means it has authoritatively removed one.
    this.scheduledAlarmMs = undefined;
    const load = async () => {
      await this.loadRoomFromStorage();
      this.normalizeLoadedSystemAudio();
      this.normalizeLoadedEffects();
      this.normalizeLoadedQueueMode();
      this.normalizeLoadedOwnershipTransfer();
      this.normalizeLoadedAccountIdentity();
      this.normalizeLoadedDeveloperCommands();
      this.normalizeLoadedSecurityLedgers();
      this.normalizeLoadedPlaybackAuthority();
      this.normalizeLoadedPlaybackBroadcasts();
      this.normalizeLoadedPresenceBroadcast();
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
    const generationHeader = request.headers.get(PRO_ROOM_GENERATION_HEADER);
    const roomGeneration =
      generationHeader === null || generationHeader === '' ? NaN : Number(generationHeader);
    if (!isProRoomGeneration(roomGeneration)) return false;
    if (!this.room) {
      this.room = initialRoomState(
        roomCode,
        roomGeneration === INITIAL_PRO_ROOM_GENERATION && INITIAL_PRO_ROOM_CODES.has(roomCode),
        roomGeneration,
      );
    }
    if (!isProRoomGeneration(this.room.roomGeneration)) return false;
    if (!Number.isSafeInteger(this.room.activationClaimGeneration)) {
      this.room.activationClaimGeneration = 0;
    }
    if (!isSafeNonNegativeInteger(this.room.ownershipTransferClaimGeneration)) {
      this.room.ownershipTransferClaimGeneration = 0;
    }
    if (!isSafeNonNegativeInteger(this.room.ownerAuthorityEpoch)) {
      this.room.ownerAuthorityEpoch = isSafeNonNegativeInteger(this.room.authEpoch)
        ? this.room.authEpoch
        : 0;
    }
    if (!isSafeNonNegativeInteger(this.room.developerAuthorityEpoch)) {
      this.room.developerAuthorityEpoch = 0;
    }
    if (!this.room.consumedRecoveryNonces) this.room.consumedRecoveryNonces = {};
    if (
      !this.room.consumedOwnershipTransferClaims ||
      typeof this.room.consumedOwnershipTransferClaims !== 'object' ||
      Array.isArray(this.room.consumedOwnershipTransferClaims)
    ) {
      this.room.consumedOwnershipTransferClaims = {};
    }
    if (!this.room.stagingTombstones) this.room.stagingTombstones = {};
    this.normalizeLoadedSystemAudio();
    this.normalizeLoadedEffects();
    this.normalizeLoadedQueueMode();
    this.normalizeLoadedOwnershipTransfer();
    this.normalizeLoadedAccountIdentity();
    this.normalizeLoadedDeveloperCommands();
    this.normalizeLoadedSecurityLedgers();
    this.normalizeLoadedPlaybackAuthority();
    this.normalizeLoadedPlaybackBroadcasts();
    this.normalizeLoadedPresenceBroadcast();
    this.reconcileMemberAuthoritySessions();
    if (!Object.prototype.hasOwnProperty.call(this.room.playback, 'youtubeVideoId')) {
      this.room.playback.youtubeVideoId = null;
      this.room.playback.youtubeSubIndex = null;
    }
    for (const session of Object.values(this.room.sessions)) {
      if (!Number.isSafeInteger(session.signalingTicketSequence)) {
        session.signalingTicketSequence = 0;
      }
    }
    return this.room.roomCode === roomCode && this.room.roomGeneration === roomGeneration;
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
      this.room.effects = normalized.state;
      this.effectsMigrationPending = this.effectsMigrationPending || normalized.migrated;
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
    // old product default until an authorized participant explicitly changes it.
    this.room.queueMode = initialQueueModeState();
    this.queueModeMigrationPending = true;
  }

  normalizeLoadedOwnershipTransfer(nowMs = Date.now()) {
    if (!this.room) return;
    const rawClaims = this.room.consumedOwnershipTransferClaims;
    const normalizedClaims = {};
    if (rawClaims && typeof rawClaims === 'object' && !Array.isArray(rawClaims)) {
      for (const [nonceHash, record] of Object.entries(rawClaims)) {
        if (
          Object.keys(normalizedClaims).length >= OWNER_TRANSFER_NONCE_MAX_ITEMS ||
          !/^[A-Za-z0-9_-]{43}$/.test(nonceHash) ||
          !record ||
          typeof record !== 'object' ||
          Array.isArray(record) ||
          !hasExactKeys(record, ['requestId', 'expiresAtMs']) ||
          !OWNER_TRANSFER_REQUEST_ID_RE.test(record.requestId || '') ||
          !Number.isSafeInteger(record.expiresAtMs) ||
          record.expiresAtMs <= nowMs
        ) {
          continue;
        }
        normalizedClaims[nonceHash] = record;
      }
    }
    this.room.consumedOwnershipTransferClaims = normalizedClaims;
    const allowedReasons = new Set([
      'operator_suspended',
      'owner_account_deleted',
      'ownership_transfer_pending',
    ]);
    this.room.suspensionReason =
      this.room.status === 'suspended'
        ? allowedReasons.has(this.room.suspensionReason)
          ? this.room.suspensionReason
          : 'operator_suspended'
        : null;

    const pending = this.room.pendingOwnershipTransfer;
    const validPending =
      pending &&
      typeof pending === 'object' &&
      !Array.isArray(pending) &&
      hasExactKeys(pending, [
        'transferId',
        'requestId',
        'targetAccountId',
        'targetDisplayName',
        'previousOwnerAccountId',
        'preservedOwnerMemberId',
        'pin',
        'claimNonceHash',
        'claimGeneration',
        'ownerAuthorityEpoch',
        'preparedAtMs',
        'expiresAtMs',
        'devicePlatform',
        'commitProofHash',
      ]) &&
      OWNER_TRANSFER_ID_RE.test(pending.transferId || '') &&
      OWNER_TRANSFER_REQUEST_ID_RE.test(pending.requestId || '') &&
      ACCOUNT_ID_RE.test(pending.targetAccountId || '') &&
      validDeveloperActorName(pending.targetDisplayName) &&
      (pending.previousOwnerAccountId === null ||
        ACCOUNT_ID_RE.test(pending.previousOwnerAccountId || '')) &&
      OPAQUE_ID_RE.test(pending.preservedOwnerMemberId || '') &&
      this.room.ownerMemberId === pending.preservedOwnerMemberId &&
      pending.pin &&
      typeof pending.pin === 'object' &&
      !Array.isArray(pending.pin) &&
      typeof pending.pin.salt === 'string' &&
      /^[A-Za-z0-9_-]{16,128}$/.test(pending.pin.salt) &&
      Number.isSafeInteger(pending.pin.iterations) &&
      pending.pin.iterations >= 1 &&
      pending.pin.iterations <= PBKDF2_MAX_ITERATIONS &&
      typeof pending.pin.hash === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(pending.pin.hash) &&
      /^[A-Za-z0-9_-]{43}$/.test(pending.claimNonceHash || '') &&
      isSafeNonNegativeInteger(pending.claimGeneration) &&
      isSafeNonNegativeInteger(pending.ownerAuthorityEpoch) &&
      Number.isSafeInteger(pending.preparedAtMs) &&
      pending.preparedAtMs >= 0 &&
      Number.isSafeInteger(pending.expiresAtMs) &&
      pending.expiresAtMs > pending.preparedAtMs &&
      ['ios', 'android', 'windows', 'macos', 'linux', 'other'].includes(pending.devicePlatform) &&
      /^[A-Za-z0-9_-]{43}$/.test(pending.commitProofHash || '');
    this.room.pendingOwnershipTransfer = validPending ? pending : null;

    const completed = this.room.completedOwnershipTransfer;
    const validCompleted =
      completed &&
      typeof completed === 'object' &&
      !Array.isArray(completed) &&
      hasExactKeys(completed, [
        'transferId',
        'requestId',
        'targetAccountId',
        'previousOwnerAccountId',
        'preservedOwnerMemberId',
        'claimNonceHash',
        'commitProofHash',
        'revocationReceiptHash',
        'ownerAuthorityEpoch',
        'authEpoch',
        'preparedAtMs',
        'expiresAtMs',
        'committedAtMs',
        'replayUntilMs',
        'sessionTokenHash',
        'ownerCredentialHash',
      ]) &&
      OWNER_TRANSFER_ID_RE.test(completed.transferId || '') &&
      OWNER_TRANSFER_REQUEST_ID_RE.test(completed.requestId || '') &&
      ACCOUNT_ID_RE.test(completed.targetAccountId || '') &&
      (completed.previousOwnerAccountId === null ||
        ACCOUNT_ID_RE.test(completed.previousOwnerAccountId || '')) &&
      OPAQUE_ID_RE.test(completed.preservedOwnerMemberId || '') &&
      this.room.ownerMemberId === completed.preservedOwnerMemberId &&
      /^[A-Za-z0-9_-]{43}$/.test(completed.claimNonceHash || '') &&
      /^[A-Za-z0-9_-]{43}$/.test(completed.commitProofHash || '') &&
      /^[A-Za-z0-9_-]{43}$/.test(completed.revocationReceiptHash || '') &&
      isSafeNonNegativeInteger(completed.ownerAuthorityEpoch) &&
      isSafeNonNegativeInteger(completed.authEpoch) &&
      Number.isSafeInteger(completed.preparedAtMs) &&
      completed.preparedAtMs >= 0 &&
      Number.isSafeInteger(completed.expiresAtMs) &&
      completed.expiresAtMs > completed.preparedAtMs &&
      Number.isSafeInteger(completed.committedAtMs) &&
      completed.committedAtMs >= 0 &&
      Number.isSafeInteger(completed.replayUntilMs) &&
      completed.replayUntilMs > completed.committedAtMs &&
      completed.replayUntilMs - completed.committedAtMs <=
        OWNER_TRANSFER_COMPLETED_REPLAY_MAX_LIFETIME_MS &&
      /^[A-Za-z0-9_-]{43}$/.test(completed.sessionTokenHash || '') &&
      /^[A-Za-z0-9_-]{43}$/.test(completed.ownerCredentialHash || '');
    this.room.completedOwnershipTransfer = validCompleted ? completed : null;

    const removal = this.room.ownerAuthorityRemoval;
    const validLegacyRemoval =
      removal &&
      typeof removal === 'object' &&
      !Array.isArray(removal) &&
      hasExactKeys(removal, ['accountId', 'removedAtMs', 'ownerAuthorityEpoch']) &&
      ACCOUNT_ID_RE.test(removal.accountId || '') &&
      Number.isSafeInteger(removal.removedAtMs) &&
      removal.removedAtMs >= 0 &&
      isSafeNonNegativeInteger(removal.ownerAuthorityEpoch);
    const validRemovalWithoutCoordinatorEpoch =
      removal &&
      typeof removal === 'object' &&
      !Array.isArray(removal) &&
      hasExactKeys(removal, [
        'accountId',
        'removalId',
        'removedAtMs',
        'ownerAuthorityEpoch',
        'projectionAcked',
      ]) &&
      ACCOUNT_ID_RE.test(removal.accountId || '') &&
      OWNER_AUTHORITY_REMOVAL_ID_RE.test(removal.removalId || '') &&
      Number.isSafeInteger(removal.removedAtMs) &&
      removal.removedAtMs >= 0 &&
      isSafeNonNegativeInteger(removal.ownerAuthorityEpoch) &&
      typeof removal.projectionAcked === 'boolean';
    const validRemoval =
      removal &&
      typeof removal === 'object' &&
      !Array.isArray(removal) &&
      hasExactKeys(removal, [
        'accountId',
        'removalId',
        'removedAtMs',
        'ownerAuthorityEpoch',
        'fencedCoordinatorEpoch',
        'projectionAcked',
      ]) &&
      ACCOUNT_ID_RE.test(removal.accountId || '') &&
      OWNER_AUTHORITY_REMOVAL_ID_RE.test(removal.removalId || '') &&
      Number.isSafeInteger(removal.removedAtMs) &&
      removal.removedAtMs >= 0 &&
      isSafeNonNegativeInteger(removal.ownerAuthorityEpoch) &&
      isSafeNonNegativeInteger(removal.fencedCoordinatorEpoch) &&
      typeof removal.projectionAcked === 'boolean';
    if (validRemoval) {
      this.room.ownerAuthorityRemoval = removal;
    } else if (validRemovalWithoutCoordinatorEpoch || validLegacyRemoval) {
      // A legacy single-phase purge cannot prove that its App-side D1
      // projection completed. Give it a stable reconciliation identity and
      // require the deletion saga to replay + acknowledge it before a new
      // owner may be installed. The first projection-saga format already has
      // that identity; preserve its acknowledgement while binding it to the
      // room's current monotonic signaling epoch during this one-time upgrade.
      this.room.ownerAuthorityRemoval = {
        accountId: removal.accountId,
        removalId: validRemovalWithoutCoordinatorEpoch
          ? removal.removalId
          : `removal_${randomToken(16)}`,
        removedAtMs: removal.removedAtMs,
        ownerAuthorityEpoch: removal.ownerAuthorityEpoch,
        fencedCoordinatorEpoch: this.room.presence.coordinatorEpoch,
        projectionAcked: validRemovalWithoutCoordinatorEpoch ? removal.projectionAcked : false,
      };
      this.accountIdentityMigrationPending = true;
    } else {
      this.room.ownerAuthorityRemoval = null;
    }
  }

  normalizeLoadedAccountDeletionTombstones() {
    if (!this.room) return;
    const stored = this.room.accountDeletionTombstones;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      this.room.accountDeletionTombstones = {};
      return;
    }
    const normalized = {};
    const entries = Object.entries(stored)
      .filter(
        ([accountId, expiresAtMs]) =>
          /^acct_[A-Za-z0-9_-]{22}$/.test(accountId) &&
          Number.isSafeInteger(expiresAtMs) &&
          expiresAtMs > 0,
      )
      // If a legacy/corrupt single-record state exceeds the current bound,
      // retain the tombstones that protect accounts for the longest period.
      .sort(([, left], [, right]) => right - left)
      .slice(0, ACCOUNT_DELETION_TOMBSTONE_MAX_ITEMS);
    for (const [accountId, expiresAtMs] of entries) normalized[accountId] = expiresAtMs;
    this.room.accountDeletionTombstones = normalized;
  }

  normalizeLoadedAccountIdentity() {
    if (!this.room) return;
    const canFenceAnonymousIdentityMigration =
      this.room.revision < Number.MAX_SAFE_INTEGER &&
      this.room.presence.revision < Number.MAX_SAFE_INTEGER;
    let anonymousIdentityChanged = false;
    this.normalizeLoadedAccountDeletionTombstones();
    if (
      !this.room.accountMembers ||
      typeof this.room.accountMembers !== 'object' ||
      Array.isArray(this.room.accountMembers)
    ) {
      this.room.accountMembers = {};
    }
    const normalizedMembers = {};
    let highestDisplayNumber = 0;
    for (const [accountId, member] of Object.entries(this.room.accountMembers)) {
      const permissions =
        member?.role === 'owner'
          ? clonePermissionSet(OWNER_PERMISSIONS)
          : member?.role === 'controller'
            ? normalizePermissionSet(member.permissions, DELEGATED_ADMIN_PERMISSIONS)
            : member?.role === 'member'
              ? clonePermissionSet(MEMBER_PERMISSIONS)
              : null;
      const valid =
        /^acct_[A-Za-z0-9_-]{22}$/.test(accountId) &&
        member &&
        typeof member === 'object' &&
        !Array.isArray(member) &&
        OPAQUE_ID_RE.test(member.memberId || '') &&
        validDeveloperActorName(member.displayName) &&
        Number.isSafeInteger(member.displayNumber) &&
        member.displayNumber >= 0 &&
        member.displayNumber <= SESSION_MAX_ITEMS &&
        (member.role === 'owner' || member.role === 'controller' || member.role === 'member') &&
        permissions !== null &&
        Number.isSafeInteger(member.createdAtMs) &&
        member.createdAtMs >= 0 &&
        Number.isSafeInteger(member.updatedAtMs) &&
        member.updatedAtMs >= member.createdAtMs;
      if (!valid || Object.keys(normalizedMembers).length >= ACCOUNT_MEMBER_MAX_ITEMS) continue;
      normalizedMembers[accountId] = {
        memberId: member.memberId,
        displayName: member.displayName,
        displayNumber: member.displayNumber,
        role: member.role,
        permissions,
        createdAtMs: member.createdAtMs,
        updatedAtMs: member.updatedAtMs,
      };
      highestDisplayNumber = Math.max(highestDisplayNumber, member.displayNumber);
    }
    this.room.accountMembers = normalizedMembers;
    if (
      typeof this.room.ownerAccountId !== 'string' ||
      !normalizedMembers[this.room.ownerAccountId] ||
      normalizedMembers[this.room.ownerAccountId].role !== 'owner'
    ) {
      this.room.ownerAccountId = null;
    }
    if (
      typeof this.room.ownerDisplayName !== 'string' ||
      !validDeveloperActorName(this.room.ownerDisplayName)
    ) {
      this.room.ownerDisplayName = this.room.ownerAccountId
        ? normalizedMembers[this.room.ownerAccountId]?.displayName || 'Owner'
        : Object.values(this.room.sessions || {}).find((session) => session.role === 'owner')
            ?.displayName || 'Owner';
    }
    if (
      !this.room.anonymousAdministrators ||
      typeof this.room.anonymousAdministrators !== 'object' ||
      Array.isArray(this.room.anonymousAdministrators)
    ) {
      this.room.anonymousAdministrators = {};
    }
    const normalizedAnonymousAdministrators = {};
    for (const [memberId, administrator] of Object.entries(this.room.anonymousAdministrators)) {
      const permissions = normalizePermissionSet(
        administrator?.permissions,
        DELEGATED_ADMIN_PERMISSIONS,
      );
      const valid =
        OPAQUE_ID_RE.test(memberId) &&
        administrator &&
        typeof administrator === 'object' &&
        !Array.isArray(administrator) &&
        administrator.memberId === memberId &&
        validDeveloperActorName(administrator.displayName) &&
        Number.isSafeInteger(administrator.displayNumber) &&
        administrator.displayNumber > 0 &&
        administrator.displayNumber <= SESSION_MAX_ITEMS &&
        permissions !== null &&
        Number.isSafeInteger(administrator.createdAtMs) &&
        administrator.createdAtMs >= 0 &&
        Number.isSafeInteger(administrator.updatedAtMs) &&
        administrator.updatedAtMs >= administrator.createdAtMs;
      if (
        !valid ||
        Object.keys(normalizedAnonymousAdministrators).length >= ANONYMOUS_ADMIN_MAX_ITEMS
      ) {
        continue;
      }
      normalizedAnonymousAdministrators[memberId] = {
        memberId,
        displayName: administrator.displayName,
        displayNumber: administrator.displayNumber,
        permissions,
        createdAtMs: administrator.createdAtMs,
        updatedAtMs: administrator.updatedAtMs,
      };
      highestDisplayNumber = Math.max(highestDisplayNumber, administrator.displayNumber);
    }
    this.room.anonymousAdministrators = normalizedAnonymousAdministrators;
    const storedNext = this.room.nextMemberDisplayNumber;
    this.room.nextMemberDisplayNumber =
      Number.isSafeInteger(storedNext) &&
      storedNext >= 1 &&
      storedNext <= SESSION_MAX_ITEMS + 1 &&
      storedNext > highestDisplayNumber
        ? storedNext
        : Math.min(SESSION_MAX_ITEMS + 1, highestDisplayNumber + 1);

    for (const session of Object.values(this.room.sessions || {})) {
      if (typeof session.accountId !== 'string') {
        delete session.accountId;
        delete session.accountLeaseExpiresAtMs;
        if (session.role !== 'owner' && !canFenceAnonymousIdentityMigration) continue;
        const fallbackDisplayNumber =
          session.role === 'owner'
            ? 0
            : Number.isSafeInteger(session.memberDisplayNumber)
              ? session.memberDisplayNumber
              : Number.isSafeInteger(session.peerOrdinal)
                ? session.peerOrdinal
                : this.nextAccountMemberDisplayNumber();
        if (Number.isSafeInteger(fallbackDisplayNumber)) {
          session.memberDisplayNumber = fallbackDisplayNumber;
        }
        continue;
      }
      const member = normalizedMembers[session.accountId];
      if (!member || session.memberId !== member.memberId) {
        delete session.accountId;
        delete session.accountLeaseExpiresAtMs;
        delete session.memberDisplayNumber;
        continue;
      }
      // Account authority is renewable proof, not a property of the long-lived
      // room cookie. Sessions written before this field existed fail closed on
      // the first prune and can immediately reattach from a still-valid App
      // account session without disturbing room playback.
      if (
        !Number.isSafeInteger(session.accountLeaseExpiresAtMs) ||
        session.accountLeaseExpiresAtMs <= 0
      ) {
        session.accountLeaseExpiresAtMs = 0;
      }
      session.displayName = member.displayName;
      session.memberDisplayNumber = member.displayNumber;
      session.role = member.role;
    }
    // A member number identifies a person, while `peerOrdinal` reserves each
    // physical device's admission slot. Rebuild missing/duplicate legacy
    // reservations deterministically so an account with three devices keeps
    // member #1 while the next member starts at #4 after an isolate restart.
    anonymousIdentityChanged =
      this.normalizeLoadedPhysicalSlotAssignments(canFenceAnonymousIdentityMigration) ||
      anonymousIdentityChanged;
    for (const participant of Object.values(this.room.presence?.participants || {})) {
      const session = this.room.sessions?.[participant.sessionHash];
      if (!session?.accountId) {
        if (session?.role !== 'owner' && !canFenceAnonymousIdentityMigration) {
          continue;
        }
        if (
          session?.role !== 'owner' &&
          session &&
          (participant.accountId !== undefined ||
            participant.memberId !== session.memberId ||
            participant.displayName !== session.displayName ||
            participant.role !== session.role ||
            participant.memberDisplayNumber !== session.memberDisplayNumber)
        ) {
          anonymousIdentityChanged = true;
        }
        delete participant.accountId;
        if (session) {
          participant.memberId = session.memberId;
          participant.displayName = session.displayName;
          participant.role = session.role;
        }
        if (Number.isSafeInteger(session?.memberDisplayNumber)) {
          participant.memberDisplayNumber = session.memberDisplayNumber;
        } else {
          delete participant.memberDisplayNumber;
        }
        continue;
      }
      participant.accountId = session.accountId;
      participant.memberId = session.memberId;
      participant.displayName = session.displayName;
      participant.memberDisplayNumber = session.memberDisplayNumber;
      participant.role = session.role;
    }
    if (anonymousIdentityChanged) {
      this.room.presence.revision += 1;
      this.room.revision += 1;
      this.accountIdentityMigrationPending = true;
    }
  }

  reconcileMemberAuthoritySessions() {
    for (const session of Object.values(this.room.sessions || {})) {
      if (session.role === 'owner' || session.memberId === this.room.ownerMemberId) {
        session.role = 'owner';
      } else if (session.accountId) {
        session.role = this.room.accountMembers?.[session.accountId]?.role || 'member';
      } else {
        session.role = this.room.anonymousAdministrators?.[session.memberId]
          ? 'controller'
          : 'member';
      }
      const participant = this.room.presence?.participants?.[session.participantId];
      if (participant) participant.role = session.role;
    }
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

  normalizeLoadedSecurityLedgers() {
    if (!this.room) return;
    if (!isSafeNonNegativeInteger(this.room.developerAuthorityEpoch)) {
      this.room.developerAuthorityEpoch = 0;
      this.developerCommandMigrationPending = true;
    }
    if (
      !this.room.developerMutationIdempotency ||
      typeof this.room.developerMutationIdempotency !== 'object' ||
      Array.isArray(this.room.developerMutationIdempotency)
    ) {
      this.room.developerMutationIdempotency = {};
      this.developerCommandMigrationPending = true;
    }
    if (
      !this.room.botRateLimits ||
      typeof this.room.botRateLimits !== 'object' ||
      Array.isArray(this.room.botRateLimits)
    ) {
      this.room.botRateLimits = {};
      this.developerCommandMigrationPending = true;
    }

    // Move legacy Developer API receipts out of the participant/browser
    // ledger without dropping any live record. If a mixed rolling-deploy
    // state already filled the new ledger, leave the remaining legacy
    // receipts in place; replay reads both ledgers until their TTL expires.
    for (const [storageKey, record] of Object.entries(this.room.idempotency || {})) {
      if (!storageKey.startsWith('developer:')) continue;
      if (this.room.developerMutationIdempotency[storageKey] !== undefined) {
        if (
          JSON.stringify(this.room.developerMutationIdempotency[storageKey]) ===
          JSON.stringify(record)
        ) {
          delete this.room.idempotency[storageKey];
          this.developerCommandMigrationPending = true;
        }
        continue;
      }
      if (
        Object.keys(this.room.developerMutationIdempotency).length >=
        DEVELOPER_MUTATION_IDEMPOTENCY_MAX_ITEMS
      ) {
        continue;
      }
      this.room.developerMutationIdempotency[storageKey] = record;
      delete this.room.idempotency[storageKey];
      this.developerCommandMigrationPending = true;
    }

    // BOT context limits are authenticated automation policy, while the
    // remaining map protects activation, owner recovery, and PIN admission.
    // Keeping their capacity independent prevents unrelated IP churn from
    // erasing or crowding out the room-wide BOT counter.
    for (const [key, record] of Object.entries(this.room.rateLimits || {})) {
      if (
        !key.startsWith('bot-minute:') &&
        !key.startsWith('bot-room-hour-v1:') &&
        !key.startsWith('bot-day:')
      ) {
        continue;
      }
      if (this.room.botRateLimits[key] !== undefined) {
        if (JSON.stringify(this.room.botRateLimits[key]) === JSON.stringify(record)) {
          delete this.room.rateLimits[key];
          this.developerCommandMigrationPending = true;
        }
        continue;
      }
      if (Object.keys(this.room.botRateLimits).length >= BOT_RATE_LIMIT_MAX_ITEMS) continue;
      this.room.botRateLimits[key] = record;
      delete this.room.rateLimits[key];
      this.developerCommandMigrationPending = true;
    }
  }

  normalizeLoadedPlaybackAuthority() {
    if (!this.room?.presence || !this.room.playback) return;
    let changed = false;
    // A PRO room has no browser coordinator. Keep the historical field as a
    // room-incarnation fence during this protocol cutover, but it must never
    // identify or grant authority to a participant.
    if (this.room.presence.coordinatorParticipantId !== null) {
      this.room.presence.coordinatorParticipantId = null;
      if (this.room.presence.coordinatorEpoch < Number.MAX_SAFE_INTEGER) {
        this.room.presence.coordinatorEpoch += 1;
      }
      changed = true;
    }
    if (this.room.playback.coordinatorEpoch !== this.room.presence.coordinatorEpoch) {
      this.room.playback.coordinatorEpoch = this.room.presence.coordinatorEpoch;
      if (this.room.playback.revision < Number.MAX_SAFE_INTEGER) {
        this.room.playback.revision += 1;
      }
      changed = true;
    }
    const pending = normalizeStoredPlaybackTransition(
      this.room.pendingPlaybackTransition,
      this.room,
    );
    if (pending === null && this.room.pendingPlaybackTransition !== null) changed = true;
    this.room.pendingPlaybackTransition = pending;
    this.playbackAuthorityMigrationPending = this.playbackAuthorityMigrationPending || changed;
  }

  normalizeLoadedPlaybackBroadcasts() {
    if (!this.room) return;
    const raw = this.room.pendingPlaybackBroadcasts;
    const normalized = normalizeStoredPlaybackBroadcasts(raw, this.room);
    if (JSON.stringify(raw ?? []) !== JSON.stringify(normalized)) {
      this.playbackAuthorityMigrationPending = true;
    }
    this.room.pendingPlaybackBroadcasts = normalized;
  }

  normalizeLoadedPresenceBroadcast() {
    if (!this.room) return;
    const pending = this.room.pendingPresenceBroadcast;
    if (pending === undefined || pending === null) {
      this.room.pendingPresenceBroadcast = null;
      return;
    }
    if (
      !hasExactKeys(pending, [
        'coordinatorEpoch',
        'presenceRevision',
        'roomRevision',
        'retryAtMs',
        'attempts',
      ]) ||
      !isSafeNonNegativeInteger(pending.coordinatorEpoch) ||
      !isSafeNonNegativeInteger(pending.presenceRevision) ||
      !isSafeNonNegativeInteger(pending.roomRevision) ||
      !Number.isSafeInteger(pending.retryAtMs) ||
      pending.retryAtMs <= 0 ||
      !isSafeNonNegativeInteger(pending.attempts) ||
      pending.attempts > PRESENCE_BROADCAST_RETRY_MAX_ATTEMPTS
    ) {
      this.room.pendingPresenceBroadcast = null;
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

  captureInMemoryState() {
    return {
      room: structuredClone(this.room),
      persistedPlaylistSignatures: new Map(this.persistedPlaylistSignatures),
      persistedPresenceLastSeenAtMs: new Map(this.persistedPresenceLastSeenAtMs),
      hasV2Persistence: this.hasV2Persistence,
      heartbeatDurabilityDirty: this.heartbeatDurabilityDirty,
      lastHeartbeatDurabilityPersistedAtMs: this.lastHeartbeatDurabilityPersistedAtMs,
      heartbeatFlushGeneration: this.heartbeatFlushGeneration,
      pendingHeartbeatFlushGeneration: this.pendingHeartbeatFlushGeneration,
      pendingHeartbeatFlushTimer: this.pendingHeartbeatFlushTimer,
      scheduledAlarmMs: this.scheduledAlarmMs,
      systemAudioMigrationPending: this.systemAudioMigrationPending,
      effectsMigrationPending: this.effectsMigrationPending,
      queueModeMigrationPending: this.queueModeMigrationPending,
      accountIdentityMigrationPending: this.accountIdentityMigrationPending,
      developerCommandMigrationPending: this.developerCommandMigrationPending,
      playbackAuthorityMigrationPending: this.playbackAuthorityMigrationPending,
      alarmMaintenanceDirty: this.alarmMaintenanceDirty,
      alarmMaintenanceRetryAttempt: this.alarmMaintenanceRetryAttempt,
      alarmMaintenanceRetryTimer: this.alarmMaintenanceRetryTimer,
    };
  }

  restoreInMemoryState(checkpoint) {
    if (
      this.pendingHeartbeatFlushTimer !== null &&
      this.pendingHeartbeatFlushTimer !== checkpoint.pendingHeartbeatFlushTimer
    ) {
      clearTimeout(this.pendingHeartbeatFlushTimer);
    }
    if (
      this.alarmMaintenanceRetryTimer !== null &&
      this.alarmMaintenanceRetryTimer !== checkpoint.alarmMaintenanceRetryTimer
    ) {
      clearTimeout(this.alarmMaintenanceRetryTimer);
    }
    this.room = checkpoint.room;
    this.persistedPlaylistSignatures = checkpoint.persistedPlaylistSignatures;
    this.persistedPresenceLastSeenAtMs = checkpoint.persistedPresenceLastSeenAtMs;
    this.hasV2Persistence = checkpoint.hasV2Persistence;
    this.heartbeatDurabilityDirty = checkpoint.heartbeatDurabilityDirty;
    this.lastHeartbeatDurabilityPersistedAtMs = checkpoint.lastHeartbeatDurabilityPersistedAtMs;
    this.heartbeatFlushGeneration = checkpoint.heartbeatFlushGeneration;
    this.pendingHeartbeatFlushGeneration = checkpoint.pendingHeartbeatFlushGeneration;
    this.pendingHeartbeatFlushTimer = checkpoint.pendingHeartbeatFlushTimer;
    this.scheduledAlarmMs = checkpoint.scheduledAlarmMs;
    this.systemAudioMigrationPending = checkpoint.systemAudioMigrationPending;
    this.effectsMigrationPending = checkpoint.effectsMigrationPending;
    this.queueModeMigrationPending = checkpoint.queueModeMigrationPending;
    this.accountIdentityMigrationPending = checkpoint.accountIdentityMigrationPending;
    this.developerCommandMigrationPending = checkpoint.developerCommandMigrationPending;
    this.playbackAuthorityMigrationPending = checkpoint.playbackAuthorityMigrationPending;
    this.alarmMaintenanceDirty = checkpoint.alarmMaintenanceDirty;
    this.alarmMaintenanceRetryAttempt = checkpoint.alarmMaintenanceRetryAttempt;
    this.alarmMaintenanceRetryTimer = checkpoint.alarmMaintenanceRetryTimer;
  }

  async withStateCapacityRollback(callback, options = {}) {
    const checkpoint = this.captureInMemoryState();
    const rollbackStorageFailure = options.rollbackStorageFailure === true;
    if (rollbackStorageFailure) this.stateStorageRollbackDepth += 1;
    try {
      return await callback();
    } catch (error) {
      if (error instanceof RoomStateCapacityError) {
        this.restoreInMemoryState(checkpoint);
        await this.persist();
        return errorResponse('ROOM_STATE_CAPACITY_EXCEEDED', 409);
      }
      if (rollbackStorageFailure && error instanceof RoomStateStorageCommitError) {
        // The SQLite transaction failed atomically, so the durable state still
        // matches this checkpoint. Restore every cache/fence alongside `room`
        // and let the caller observe the original storage failure. In
        // particular, a pending heartbeat retry must never persist the aborted
        // mutation later as a ghost commit.
        this.restoreInMemoryState(checkpoint);
      }
      throw error;
    } finally {
      if (rollbackStorageFailure) this.stateStorageRollbackDepth -= 1;
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
      this.persistedPresenceLastSeenAtMs = new Map(
        Object.values(room.presence.participants).map((participant) => [
          participant.participantId,
          participant.lastSeenAtMs,
        ]),
      );
      this.hasV2Persistence = true;
      return;
    }

    this.room = null;
    this.persistedPlaylistSignatures = new Map();
    this.persistedPresenceLastSeenAtMs = new Map(
      Object.values(this.room?.presence?.participants || {}).map((participant) => [
        participant.participantId,
        participant.lastSeenAtMs,
      ]),
    );
    this.hasV2Persistence = false;
  }

  invalidatePendingHeartbeatFlush() {
    if (this.pendingHeartbeatFlushTimer !== null) {
      clearTimeout(this.pendingHeartbeatFlushTimer);
      this.pendingHeartbeatFlushTimer = null;
    }
    if (this.pendingHeartbeatFlushGeneration === null) return;
    this.pendingHeartbeatFlushGeneration = null;
    this.heartbeatFlushGeneration += 1;
  }

  async scheduleHeartbeatPersistRetryAlarm() {
    if (typeof this.storage.setAlarm !== 'function') return;
    const retryAtMs = Date.now() + PRESENCE_HEARTBEAT_PERSIST_RETRY_MS;
    if (
      Number.isSafeInteger(this.scheduledAlarmMs) &&
      this.scheduledAlarmMs > Date.now() &&
      this.scheduledAlarmMs <= retryAtMs
    ) {
      return;
    }
    try {
      await this.storage.setAlarm(retryAtMs);
      this.scheduledAlarmMs = retryAtMs;
    } catch {
      // The next ordinary heartbeat can install another coalesced flush. A
      // storage outage must never escape the timer callback as an unhandled
      // rejection merely because even the recovery alarm could not be set.
    }
  }

  async flushHeartbeatDurability(generation) {
    if (this.pendingHeartbeatFlushGeneration !== generation) return;
    if (!this.heartbeatDurabilityDirty) return;
    try {
      await this.persist({
        retainEarlierAlarm: true,
        heartbeatFlushGeneration: generation,
      });
    } catch {
      // Keep the dirty bit set. A later heartbeat will schedule a fresh
      // generation, while the retry alarm lets an otherwise-idle room recover
      // without producing an unhandled timer-callback rejection.
      if (this.pendingHeartbeatFlushGeneration === generation) {
        this.pendingHeartbeatFlushGeneration = null;
        this.pendingHeartbeatFlushTimer = null;
        this.heartbeatFlushGeneration += 1;
      }
      await this.scheduleHeartbeatPersistRetryAlarm();
    }
  }

  scheduleHeartbeatDurability(nowMs) {
    this.heartbeatDurabilityDirty = true;
    if (this.pendingHeartbeatFlushGeneration !== null) return true;
    if (!Number.isSafeInteger(this.lastHeartbeatDurabilityPersistedAtMs)) return false;
    const windowEndsAtMs =
      this.lastHeartbeatDurabilityPersistedAtMs + PRESENCE_HEARTBEAT_PERSIST_COALESCE_MS;
    if (nowMs >= windowEndsAtMs) return false;
    const generation = this.heartbeatFlushGeneration + 1;
    this.heartbeatFlushGeneration = generation;
    this.pendingHeartbeatFlushGeneration = generation;
    // DurableObjectState.waitUntil() is a compatibility no-op. A timer keeps
    // the object non-hibernateable, so only dense traffic pays this cost: the
    // first heartbeat after a quiet period persists inline, and a second one
    // inside its one-second window opens the timer for the remaining duration.
    this.pendingHeartbeatFlushTimer = setTimeout(
      () => {
        if (this.pendingHeartbeatFlushGeneration === generation) {
          this.pendingHeartbeatFlushTimer = null;
        }
        readServiceMaintenance(this.env)
          .then((maintenance) => {
            if (maintenance.enabled) return undefined;
            return this.withMutation(async () => {
              if ((await readServiceMaintenance(this.env)).enabled) return;
              await this.flushHeartbeatDurability(generation);
            });
          })
          .catch(() => undefined);
      },
      Math.max(0, windowEndsAtMs - nowMs),
    );
    return true;
  }

  async persist(options = {}) {
    const heartbeatFlushGeneration = options.heartbeatFlushGeneration;
    if (
      heartbeatFlushGeneration !== undefined &&
      this.pendingHeartbeatFlushGeneration !== heartbeatFlushGeneration
    ) {
      return false;
    }
    try {
      await this.persistRoom(options);
    } catch (error) {
      // Do not absorb the pending generation until the full transaction and
      // alarm maintenance have both succeeded. If this was the only pending
      // heartbeat work, leave a short recovery alarm before propagating the
      // original mutation failure to its caller.
      if (
        !(error instanceof RoomStateStorageCommitError && this.stateStorageRollbackDepth > 0) &&
        this.heartbeatDurabilityDirty &&
        this.pendingHeartbeatFlushGeneration === null
      ) {
        await this.scheduleHeartbeatPersistRetryAlarm();
      }
      throw error;
    }
    if (this.heartbeatDurabilityDirty) {
      this.lastHeartbeatDurabilityPersistedAtMs = Date.now();
    }
    this.heartbeatDurabilityDirty = false;
    this.invalidatePendingHeartbeatFlush();
    if (options.flushPlaybackOutbox !== false) {
      // The canonical mutation and its playback event are now durable. Only at
      // this point may the cross-Worker dispatch begin.
      await this.flushPendingPlaybackBroadcasts(Date.now());
    }
    return true;
  }

  async persistRoom(options = {}) {
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
    const write = async (storage) => {
      await putStorageEntries(storage, changedEntries);
      await deleteStorageKeys(storage, removedKeys);
      await storage.put(STORAGE_V2_CORE_KEY, storedCore);
    };
    try {
      if (typeof this.storage.transaction === 'function') {
        await this.storage.transaction((transaction) => write(transaction));
      } else {
        // Unit-test and local compatibility fallback. Production SQLite-backed
        // Durable Objects provide transaction(), which makes row/core changes
        // atomic.
        await write(this.storage);
      }
    } catch (error) {
      throw new RoomStateStorageCommitError(error);
    }
    this.persistedPlaylistSignatures = nextSignatures;
    this.persistedPresenceLastSeenAtMs = new Map(
      Object.values(this.room.presence.participants).map((participant) => [
        participant.participantId,
        participant.lastSeenAtMs,
      ]),
    );
    this.hasV2Persistence = true;
    // The room transaction above is already authoritative. Alarm maintenance
    // is a post-commit scheduling concern: a transient setAlarm/deleteAlarm
    // failure must not turn a committed mutation into an apparent failed one.
    // Retry it independently without rolling the canonical state back.
    await this.maintainAlarm({ retainEarlier: options.retainEarlierAlarm === true });
  }

  clearAlarmMaintenanceRetry() {
    if (this.alarmMaintenanceRetryTimer !== null) {
      clearTimeout(this.alarmMaintenanceRetryTimer);
      this.alarmMaintenanceRetryTimer = null;
    }
  }

  scheduleAlarmMaintenanceRetry() {
    if (this.alarmMaintenanceRetryTimer !== null) return;
    const delay = Math.min(
      ALARM_MAINTENANCE_RETRY_MAX_MS,
      PRESENCE_HEARTBEAT_PERSIST_RETRY_MS * 2 ** Math.min(this.alarmMaintenanceRetryAttempt, 6),
    );
    this.alarmMaintenanceRetryAttempt += 1;
    this.alarmMaintenanceRetryTimer = setTimeout(() => {
      this.alarmMaintenanceRetryTimer = null;
      readServiceMaintenance(this.env)
        .then((maintenance) => {
          if (maintenance.enabled) return undefined;
          return this.withMutation(async () => {
            if ((await readServiceMaintenance(this.env)).enabled) return;
            if (!this.room || !this.alarmMaintenanceDirty) return;
            await this.maintainAlarm();
          });
        })
        .catch(() => {
          // maintainAlarm absorbs storage scheduling failures. Keep this guard
          // for an unexpected mutation-queue failure so a timer callback never
          // becomes an unhandled rejection and the maintenance work is retried.
          this.alarmMaintenanceDirty = true;
          this.scheduleAlarmMaintenanceRetry();
        });
    }, delay);
  }

  async maintainAlarm(options = {}) {
    try {
      await this.scheduleAlarm(options);
      this.alarmMaintenanceDirty = false;
      this.alarmMaintenanceRetryAttempt = 0;
      this.clearAlarmMaintenanceRetry();
      return true;
    } catch {
      this.alarmMaintenanceDirty = true;
      this.scheduleAlarmMaintenanceRetry();
      return false;
    }
  }

  async scheduleAlarm(options = {}) {
    if (typeof this.storage.setAlarm !== 'function') return;
    const nowMs = Date.now();
    const candidates = [];
    if (this.room.status === 'decommissioning') {
      candidates.push(this.room.decommission?.retryAtMs, this.room.decommission?.purgeAfterMs);
    } else if (this.room.status === 'decommissioned') {
      candidates.push(this.room.decommission?.maintenanceAtMs);
    }
    for (const session of Object.values(this.room.sessions)) {
      candidates.push(session.expiresAtMs);
      if (session.accountId) candidates.push(session.accountLeaseExpiresAtMs);
    }
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
    for (const record of Object.values(this.room.consumedOwnershipTransferClaims || {})) {
      candidates.push(record.expiresAtMs);
    }
    for (const expiresAtMs of Object.values(this.room.accountDeletionTombstones || {})) {
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
    for (const [storageKey, record] of Object.entries(this.room.idempotency || {})) {
      candidates.push(this.idempotencyExpiresAt(storageKey, record));
    }
    for (const record of Object.values(this.room.developerMutationIdempotency || {})) {
      candidates.push(record.expiresAtMs);
    }
    for (const record of Object.values(this.room.rateLimits || {})) {
      candidates.push(record.resetAtMs);
    }
    for (const record of Object.values(this.room.botRateLimits || {})) {
      candidates.push(record.resetAtMs);
    }
    if (this.room.pendingPresenceBroadcast) {
      const retryAtMs = this.room.pendingPresenceBroadcast.retryAtMs;
      candidates.push(retryAtMs <= nowMs ? nowMs + 1 : retryAtMs);
    }
    const playbackBroadcast = this.room.pendingPlaybackBroadcasts?.[0];
    if (playbackBroadcast) {
      candidates.push(
        playbackBroadcast.retryAtMs <= nowMs ? nowMs + 1 : playbackBroadcast.retryAtMs,
      );
    }
    if (this.room.pendingPlaybackTransition) {
      const deadlineAtMs = this.room.pendingPlaybackTransition.deadlineAtMs;
      // Persistence can begin before the rendezvous deadline and finish after
      // it. Cloudflare removes due alarms before invoking them, so dropping an
      // already-due deadline here would strand PREPARE until unrelated traffic
      // wakes the object. Install a next-tick alarm instead.
      candidates.push(deadlineAtMs <= nowMs ? nowMs + 1 : deadlineAtMs);
    }
    const next = candidates
      .filter((value) => Number.isSafeInteger(value) && value > nowMs)
      .sort((a, b) => a - b)[0];
    // An earlier alarm is safe: it will wake, find that a renewed lease has
    // not expired, and schedule the later deadline. Avoid moving the alarm
    // forward on every heartbeat, which otherwise turns presence liveness
    // into an extra Durable Object write every 15 seconds.
    if (next) {
      if (
        options.retainEarlier === true &&
        Number.isSafeInteger(this.scheduledAlarmMs) &&
        this.scheduledAlarmMs > nowMs &&
        this.scheduledAlarmMs <= next
      ) {
        return;
      }
      await this.storage.setAlarm(next);
      this.scheduledAlarmMs = next;
    } else if (typeof this.storage.deleteAlarm === 'function') {
      if (this.scheduledAlarmMs !== null) await this.storage.deleteAlarm();
      this.scheduledAlarmMs = null;
    }
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

  accountIdentityLeaseExpiresAt(nowMs = Date.now()) {
    return nowMs + ACCOUNT_IDENTITY_LEASE_TTL_MS;
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

  reconcileAssetGarbageCollection(nowMs, referenced = this.referencedAssetIds()) {
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

  async advanceStagingObjectCleanup(
    record,
    objectKey,
    nowMs,
    cleanupField = 'cleanupAfterMs',
    emptyField = 'emptySinceMs',
  ) {
    const object = await this.env.PRO_MEDIA_BUCKET.head(objectKey);
    if (object) {
      await this.env.PRO_MEDIA_BUCKET.delete(objectKey);
      // A late completion resets the continuous-empty proof even when this
      // cleanup successfully removed it.
      record[emptyField] = nowMs;
    } else if (!Number.isSafeInteger(record[emptyField])) {
      record[emptyField] = nowMs;
    } else if (record[emptyField] + STAGING_OBJECT_EMPTY_WINDOW_MS <= nowMs) {
      return true;
    }
    record[cleanupField] = nowMs + ASSET_GC_RETRY_SECONDS * 1000;
    return false;
  }

  async fetch(request) {
    const maintenanceResponse = await gateServiceMaintenance(request, this.env, { format: 'json' });
    if (maintenanceResponse) return maintenanceResponse;
    if (!(await this.ensureReady(request))) return errorResponse('ROOM_NOT_FOUND', 404);
    const url = new URL(request.url);
    if (url.search || url.hash || request.url.length > 8192) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (url.pathname === '/internal/authority/check') {
      if (request.method !== 'POST') return errorResponse('NOT_FOUND', 404);
      return this.withMutation(async () => {
        const accountDeletionResponse = await this.enforceOwnerAccountDeletionFence();
        if (accountDeletionResponse) return accountDeletionResponse;
        await this.prune(Date.now());
        return this.handleInternalAuthorityCheck(request);
      });
    }
    if (url.pathname.startsWith('/internal/bot/')) {
      if (request.method !== 'POST') return errorResponse('NOT_FOUND', 404);
      return this.withMutation(async () => {
        const accountDeletionResponse = await this.enforceOwnerAccountDeletionFence();
        if (accountDeletionResponse) return accountDeletionResponse;
        await this.prune(Date.now());
        return this.withStateCapacityRollback(
          async () => {
            if (url.pathname === '/internal/bot/context') {
              return this.handleInternalBotContext(request);
            }
            if (url.pathname === '/internal/bot/execute') {
              return this.handleInternalBotExecute(request);
            }
            return errorResponse('NOT_FOUND', 404);
          },
          {
            // BOT execution composes several independently durable operations
            // (queue mutation followed by an optional playback command). A late
            // failure must not rewind earlier commits in memory. Context lease
            // creation is a single state-only transaction and is safe to undo.
            rollbackStorageFailure: url.pathname === '/internal/bot/context',
          },
        );
      });
    }
    if (url.pathname.startsWith('/internal/admin/')) {
      if (request.method === 'GET' && url.pathname === '/internal/admin/status') {
        return this.withMutation(async () => {
          const accountDeletionResponse = await this.enforceOwnerAccountDeletionFence();
          // A terminal deletion may make this very status request perform the
          // durable self-suspension. Return that new state to the control plane;
          // an unverifiable Auth D1 verdict remains fail-closed.
          if (accountDeletionResponse && accountDeletionResponse.status !== 423) {
            return accountDeletionResponse;
          }
          return jsonResponse({
            roomCode: this.room.roomCode,
            roomGeneration: this.room.roomGeneration,
            provisioned: this.room.provisioned,
            status: this.room.status,
            suspensionReason: this.room.suspensionReason,
            ownerAccountLinked: typeof this.room.ownerAccountId === 'string',
            ownerAccountId: ACCOUNT_ID_RE.test(this.room.ownerAccountId || '')
              ? this.room.ownerAccountId
              : null,
            ownerAuthorityEpoch: this.room.ownerAuthorityEpoch,
            developerAuthorityEpoch: this.room.developerAuthorityEpoch,
            ownerAuthorityRemoval: internalOwnerAuthorityRemoval(this.room),
            ownerTransferReconciliation: internalOwnerTransferReconciliation(this.room),
          });
        });
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/provision') {
        return this.withMutation(async () => {
          return this.withStateCapacityRollback(
            async () => {
              if (this.room.status === 'decommissioning' || this.room.status === 'decommissioned') {
                return errorResponse('PRO_ROOM_PERMANENTLY_DECOMMISSIONED', 410);
              }
              if (!this.room.provisioned) {
                this.room.provisioned = true;
                await this.persist();
              }
              return jsonResponse({
                ok: true,
                roomCode: this.room.roomCode,
                roomGeneration: this.room.roomGeneration,
                status: this.room.status,
              });
            },
            { rollbackStorageFailure: true },
          );
        });
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/activation-claim') {
        return this.withMutation(() =>
          this.withStateCapacityRollback(() => this.handleInternalActivationClaim(request), {
            rollbackStorageFailure: true,
          }),
        );
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/owner-recovery-claim') {
        // Serialize issuance with suspend/decommission and other room
        // mutations. A recovery URL must reflect one stable canonical status,
        // never an in-flight pre-mutation snapshot.
        return this.withMutation(async () => {
          const accountDeletionResponse = await this.enforceOwnerAccountDeletionFence();
          if (accountDeletionResponse) return accountDeletionResponse;
          return this.handleInternalOwnerRecoveryClaim();
        });
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/owner-transfer-claim') {
        return this.withMutation(async () => {
          const accountDeletionResponse = await this.enforceOwnerAccountDeletionFence();
          if (accountDeletionResponse) return accountDeletionResponse;
          return this.withStateCapacityRollback(
            () => this.handleInternalOwnerTransferClaim(request),
            {
              rollbackStorageFailure: true,
            },
          );
        });
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/owner-transfer/commit') {
        return this.withMutation(() =>
          this.withStateCapacityRollback(() => this.handleInternalOwnerTransferCommit(request), {
            rollbackStorageFailure: true,
          }),
        );
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/internal/admin/owner-transfer/reconcile'
      ) {
        return this.withMutation(() =>
          this.withStateCapacityRollback(
            () => this.handleInternalOwnerTransferCommit(request, { reconcile: true }),
            {
              rollbackStorageFailure: true,
            },
          ),
        );
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/suspend') {
        return this.withMutation(() =>
          this.withStateCapacityRollback(() => this.handleInternalSuspend(), {
            rollbackStorageFailure: true,
          }),
        );
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/resume') {
        return this.withMutation(() =>
          this.withStateCapacityRollback(() => this.handleInternalResume(), {
            rollbackStorageFailure: true,
          }),
        );
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/decommission') {
        return this.withMutation(() => this.handleInternalDecommission(request));
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/owner-authority/detach') {
        return this.withMutation(() =>
          this.withStateCapacityRollback(() => this.handleInternalOwnerAuthorityDetach(request), {
            rollbackStorageFailure: true,
          }),
        );
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/internal/admin/owner-authority/detach/ack'
      ) {
        return this.withMutation(() =>
          this.withStateCapacityRollback(
            () => this.handleInternalOwnerAuthorityDetachAck(request),
            { rollbackStorageFailure: true },
          ),
        );
      }
      if (request.method === 'POST' && url.pathname === '/internal/admin/account-authority/purge') {
        return this.withMutation(() =>
          this.withStateCapacityRollback(() => this.handleInternalAccountAuthorityPurge(request), {
            rollbackStorageFailure: true,
          }),
        );
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/internal/admin/account-authority/classify'
      ) {
        return this.withMutation(() => this.handleInternalAccountAuthorityClassify(request));
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/internal/admin/account-authority/purge/ack'
      ) {
        return this.withMutation(() =>
          this.withStateCapacityRollback(
            () => this.handleInternalAccountAuthorityPurgeAck(request),
            { rollbackStorageFailure: true },
          ),
        );
      }
      return errorResponse('NOT_FOUND', 404);
    }
    if (url.pathname.startsWith('/internal/developer/')) {
      if (request.method !== 'POST') {
        return errorResponse('NOT_FOUND', 404);
      }
      return this.withMutation(async () => {
        const accountDeletionResponse = await this.enforceOwnerAccountDeletionFence();
        if (accountDeletionResponse) return accountDeletionResponse;
        await this.prune(Date.now());
        // Authenticated projections are read-only. Keep them behind the
        // mutation queue for an atomic view, but do not clone the bounded
        // multi-megabyte room merely to prepare a capacity rollback that can
        // never be used by this route.
        if (url.pathname === '/internal/developer/v1/read') {
          return this.handleInternalDeveloperRead(request);
        }
        return this.withStateCapacityRollback(
          async () => {
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
          },
          {
            // Completion promotes bytes from staging into the final R2 key
            // before committing metadata. Rewinding only memory after that
            // external side effect would manufacture a second, contradictory
            // view of the upload. Its existing cleanup saga remains responsible
            // for recovery; every other route in this group is state-only.
            rollbackStorageFailure:
              url.pathname !== '/internal/developer/v1/media/uploads/complete',
          },
        );
      });
    }
    const prefix = `/v1/rooms/${this.room.roomCode}`;
    if (!url.pathname.startsWith(`${prefix}/`)) return errorResponse('ROOM_NOT_FOUND', 404);
    if (!this.room.provisioned) return errorResponse('ROOM_NOT_FOUND', 404);
    if (request.method === 'GET' && url.pathname === `${prefix}/bootstrap`) {
      return this.withMutation(async () => {
        const accountDeletionResponse = await this.enforceOwnerAccountDeletionFence();
        // If this read discovered a terminal owner deletion, the room is
        // already durably suspended. Expose that canonical bootstrap state so
        // the browser renders the inactive-room UX instead of a one-off link
        // or transport error. An unverifiable Auth D1 verdict stays closed.
        if (accountDeletionResponse && accountDeletionResponse.status !== 423) {
          return accountDeletionResponse;
        }
        return this.handleBootstrap();
      });
    }
    return this.withMutation(async () => {
      const accountDeletionResponse = await this.enforceOwnerAccountDeletionFence();
      if (accountDeletionResponse) return accountDeletionResponse;
      await this.prune(Date.now());
      if (request.method === 'GET') {
        if (url.pathname === `${prefix}/snapshot`) return this.handleGetSnapshot(request);
        if (url.pathname === `${prefix}/administrators`)
          return this.handleGetAdministrators(request);
        if (url.pathname === `${prefix}/effects`) return this.handleGetEffects(request);
        if (url.pathname === `${prefix}/settings-sync`) return this.handleGetSettingsSync(request);
        if (url.pathname === `${prefix}/queue-mode`) return this.handleGetQueueMode(request);
        if (url.pathname === `${prefix}/system-audio`) return this.handleGetSystemAudio(request);
        const readDownload = url.pathname.match(
          new RegExp(`^${prefix}/media/([A-Za-z0-9_-]{16,128})/download$`),
        );
        if (readDownload) return this.handleDownloadMedia(request, readDownload[1]);
      }
      const completeMediaMatch = url.pathname.match(
        new RegExp(`^${prefix}/media/([A-Za-z0-9_-]{16,128})/complete$`),
      );
      const deleteMediaMatch = url.pathname.match(
        new RegExp(`^${prefix}/media/([A-Za-z0-9_-]{16,128})$`),
      );
      // Completion may leave a verified immutable final object in R2 before
      // the room-state commit. Its retry path now treats that object as the
      // recovery source, so rewinding the in-memory reservation on a storage
      // commit failure is both safe and required. Deletion is different: once
      // an R2 object is removed there is no recovery source, therefore only
      // that route keeps its post-side-effect state on commit failure.
      const hasIrreversibleMediaDelete = request.method === 'DELETE' && deleteMediaMatch !== null;
      return this.withStateCapacityRollback(
        async () => {
          const administratorMatch = url.pathname.match(
            new RegExp(`^${prefix}/administrators/([A-Za-z0-9][A-Za-z0-9_-]{15,127})$`),
          );
          if (request.method === 'POST' && url.pathname === `${prefix}/activation`)
            return this.handleActivation(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/owner-recovery`)
            return this.handleOwnerRecovery(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/owner-transfer/prepare`)
            return this.handleOwnerTransferPrepare(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/sessions`)
            return this.handleCreateSession(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/sessions/current/account`)
            return this.handleAttachCurrentAccount(request);
          if (
            request.method === 'POST' &&
            url.pathname === `${prefix}/sessions/current/account/lease`
          )
            return this.handleRenewCurrentAccountLease(request);
          if (request.method === 'DELETE' && url.pathname === `${prefix}/sessions/current/account`)
            return this.handleDetachCurrentAccount(request);
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
          if (request.method === 'POST' && url.pathname === `${prefix}/presence/kick-device`)
            return this.handleKickPhysicalPresence(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/presence/kick`)
            return this.handleKickPresence(request);
          if (request.method === 'PUT' && administratorMatch)
            return this.handlePutAdministrator(request, administratorMatch[1]);
          if (request.method === 'DELETE' && administratorMatch)
            return this.handleDeleteAdministrator(request, administratorMatch[1]);
          if (request.method === 'DELETE' && url.pathname === `${prefix}/presence/current`)
            return this.handleLeavePresence(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/signaling-tickets`)
            return this.handleSignalingTicket(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/playback/commands`)
            return this.handlePlaybackCommand(request);
          const playbackReady = url.pathname.match(
            new RegExp(`^${prefix}/playback/transitions/(transition_[A-Za-z0-9_-]{22})/ready$`),
          );
          if (request.method === 'POST' && playbackReady) {
            return this.handlePlaybackTransitionReady(request, playbackReady[1]);
          }
          const developerCommandAck = url.pathname.match(
            new RegExp(`^${prefix}/developer-commands/(cmd_[A-Za-z0-9_-]{22})/ack$`),
          );
          if (request.method === 'POST' && developerCommandAck) {
            return this.handleDeveloperCommandAck(request, developerCommandAck[1]);
          }
          if (request.method === 'PUT' && url.pathname === `${prefix}/effects`)
            return this.handleUpdateEffects(request);
          if (request.method === 'PUT' && url.pathname === `${prefix}/settings-sync`)
            return this.handleUpdateSettingsSync(request);
          if (request.method === 'PUT' && url.pathname === `${prefix}/queue-mode`)
            return this.handleUpdateQueueMode(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/system-audio/acquire`)
            return this.handleAcquireSystemAudio(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/system-audio/commit`)
            return this.handleCommitSystemAudio(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/system-audio/heartbeat`)
            return this.handleHeartbeatSystemAudio(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/system-audio/release`)
            return this.handleReleaseSystemAudio(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/snapshot/compact`)
            return this.handleCompactSnapshotMutation(request);
          if (request.method === 'POST' && url.pathname === `${prefix}/media/reservations`)
            return this.handleCreateReservation(request);
          if (request.method === 'POST' && completeMediaMatch)
            return this.handleCompleteMedia(request, completeMediaMatch[1]);
          if (request.method === 'DELETE' && deleteMediaMatch)
            return this.handleDeleteMedia(request, deleteMediaMatch[1]);
          return errorResponse('NOT_FOUND', 404);
        },
        { rollbackStorageFailure: !hasIrreversibleMediaDelete },
      );
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
    const current = this.room.botRateLimits[key];
    if (!current || current.resetAtMs <= nowMs || current.count < limit) return null;
    return errorResponse('RATE_LIMITED', 429, {
      'retry-after': String(Math.max(1, Math.ceil((current.resetAtMs - nowMs) / 1000))),
    });
  }

  pruneRateLimitLedger(records, nowMs) {
    let changed = false;
    for (const [key, record] of Object.entries(records)) {
      if (record.resetAtMs > nowMs) continue;
      delete records[key];
      changed = true;
    }
    return changed;
  }

  rateLimitCapacityResponse(records, keys, maxItems, nowMs) {
    this.pruneRateLimitLedger(records, nowMs);
    const missing = new Set(keys.filter((key) => records[key] === undefined));
    if (Object.keys(records).length + missing.size <= maxItems) return null;
    const retryAtMs = Math.min(
      ...Object.values(records)
        .map((record) => record.resetAtMs)
        .filter((value) => Number.isSafeInteger(value) && value > nowMs),
    );
    return errorResponse('RATE_LIMITED', 429, {
      'retry-after': String(
        Number.isFinite(retryAtMs) ? Math.max(1, Math.ceil((retryAtMs - nowMs) / 1000)) : 60,
      ),
    });
  }

  recordBotRateLimit(key, windowMs, nowMs) {
    const current = this.room.botRateLimits[key];
    if (!current || current.resetAtMs <= nowMs) {
      this.room.botRateLimits[key] = { count: 1, resetAtMs: nowMs + windowMs };
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
        effects: structuredClone(this.room.effects.effects),
        playlist,
      },
    };
  }

  async handleInternalBotContext(request) {
    if (!this.room.provisioned || this.room.status !== 'active') {
      return errorResponse('BOT_ROOM_ONLY', 400);
    }
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    if (auth.session.role === 'member') {
      return errorResponse('ADMINISTRATOR_REQUIRED', 403);
    }
    const parsed = await this.parseBody(request, 2 * 1024);
    if (
      parsed.response ||
      !hasExactKeys(parsed.value, ['roomCode', 'roomGeneration', 'requestId', 'prompt']) ||
      parsed.value.roomCode !== this.room.roomCode ||
      exactInternalRoomGeneration(request, parsed.value) !== this.room.roomGeneration ||
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
      const capacityError = this.rateLimitCapacityResponse(
        this.room.botRateLimits,
        [minuteKey, hourKey],
        BOT_RATE_LIMIT_MAX_ITEMS,
        nowMs,
      );
      if (capacityError) return capacityError;
      this.recordBotRateLimit(minuteKey, BOT_MEMBER_MINUTE_MS, nowMs);
      this.recordBotRateLimit(hourKey, BOT_ROOM_HOUR_MS, nowMs);
      // The former daily policy used a different key. Remove its inert room
      // state as soon as the new policy records a request.
      delete this.room.botRateLimits[`bot-day:${this.room.roomCode}`];
      this.storeIdempotency(
        scope,
        parsed.value.requestId,
        fingerprint,
        {
          leaseToken,
          leaseExpiresAtMs: nowMs + BOT_REQUEST_LEASE_MS,
          playlistRevision: this.room.playlistRevision,
        },
        200,
        nowMs + IDEMPOTENCY_TTL_MS,
      );
      await this.persist();
    }
    return jsonResponse({ leaseToken, ...this.publicBotContext(auth) });
  }

  async runBotDeveloperCommand(requestId, command) {
    const idempotencyKey = await botDerivedIdempotencyKey(requestId, 'command');
    const response = await this.handleInternalDeveloperCommandCreate(
      new Request('https://pro-room.internal/internal/developer/v1/commands/create', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...proRoomGenerationWireHeaders(this.room.roomGeneration),
        },
        body: JSON.stringify({
          roomCode: this.room.roomCode,
          ...proRoomGenerationWireFields(this.room.roomGeneration),
          keyId: BOT_DEVELOPER_KEY_ID,
          developerAuthorityEpoch: this.room.developerAuthorityEpoch,
          idempotencyKey,
          command,
        }),
      }),
    );
    if (!response.ok) return false;
    const result = await response
      .clone()
      .json()
      .catch(() => null);
    // Command creation intentionally stays HTTP 202 for the public async API,
    // even when the Durable Object can already determine a terminal result.
    // BOT is an in-process caller, so it must inspect that terminal body rather
    // than treating every 202 as a successful action. The same check applies to
    // idempotent replays of a previously rejected command.
    return (
      result?.status === 'pending' ||
      result?.status === 'dispatched' ||
      result?.status === 'applied'
    );
  }

  async handleInternalBotExecute(request) {
    if (!this.room.provisioned || this.room.status !== 'active') {
      return errorResponse('BOT_ROOM_ONLY', 400);
    }
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    if (auth.session.role === 'member') {
      return errorResponse('ADMINISTRATOR_REQUIRED', 403);
    }
    const parsed = await this.parseBody(request, 64 * 1024);
    if (
      parsed.response ||
      !hasExactKeys(parsed.value, [
        'roomCode',
        'roomGeneration',
        'requestId',
        'leaseToken',
        'plan',
        'tracks',
      ]) ||
      parsed.value.roomCode !== this.room.roomCode ||
      exactInternalRoomGeneration(request, parsed.value) !== this.room.roomGeneration ||
      !BOT_REQUEST_ID_RE.test(parsed.value.requestId || '') ||
      !BOT_LEASE_TOKEN_RE.test(parsed.value.leaseToken || '') ||
      !Array.isArray(parsed.value.tracks)
    ) {
      return parsed.response || errorResponse('INVALID_REQUEST', 400);
    }
    const plan = parseBotPlan(parsed.value.plan);
    if (!plan) return errorResponse('INVALID_REQUEST', 400);
    if (plan.intent === 'add_youtube' && !this.sessionHasPermission(auth.session, 'media.add')) {
      return errorResponse('PERMISSION_REQUIRED', 403);
    }
    // BOT is only an alternate command surface; it never widens the calling
    // room member's authority. In particular, a delegated administrator whose
    // playback toggle was revoked may still converse with BOT or add media,
    // but cannot smuggle a play/pause/next/item-selection action through the
    // internal Developer-command executor.
    if (
      (plan.intent === 'playback' ||
        plan.intent === 'play_existing' ||
        (plan.intent === 'add_youtube' && plan.playAddedIndex >= 0)) &&
      !this.sessionHasPermission(auth.session, 'playback.control')
    ) {
      return errorResponse('PERMISSION_REQUIRED', 403);
    }
    if (
      (plan.intent === 'remove_items' ||
        plan.intent === 'clear_queue' ||
        plan.intent === 'queue_mode') &&
      !this.sessionHasPermission(auth.session, 'media.add')
    ) {
      return errorResponse('PERMISSION_REQUIRED', 403);
    }
    if (plan.intent === 'virtual_treble' && auth.session.role !== 'owner') {
      return errorResponse('OWNER_REQUIRED', 403);
    }
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
      plan.intent === 'clear_queue' &&
      (contextReceipt.body?.playlistRevision !== plan.basePlaylistRevision ||
        this.room.playlistRevision !== plan.basePlaylistRevision)
    ) {
      return errorResponse('BOT_CONTEXT_STALE', 409);
    }
    if (
      !Number.isSafeInteger(contextReceipt.body?.leaseExpiresAtMs) ||
      contextReceipt.body.leaseExpiresAtMs <= Date.now()
    ) {
      return errorResponse('BOT_CONTEXT_REQUIRED', 409);
    }

    let addedCount = 0;
    let playbackChanged = false;
    let destructiveResponseBody = null;
    if (plan.intent === 'add_youtube') {
      const queueIdempotencyKey = await botDerivedIdempotencyKey(parsed.value.requestId, 'queue');
      const queueResponse = await this.handleInternalDeveloperQueueMutation(
        new Request('https://pro-room.internal/internal/developer/v1/queue/mutate', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...proRoomGenerationWireHeaders(this.room.roomGeneration),
          },
          body: JSON.stringify({
            roomCode: this.room.roomCode,
            ...proRoomGenerationWireFields(this.room.roomGeneration),
            keyId: BOT_DEVELOPER_KEY_ID,
            developerAuthorityEpoch: this.room.developerAuthorityEpoch,
            idempotencyKey: queueIdempotencyKey,
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
    } else if (plan.intent === 'remove_items' || plan.intent === 'clear_queue') {
      const queueIdempotencyKey = await botDerivedIdempotencyKey(parsed.value.requestId, 'queue');
      const queueResponse = await this.handleInternalDeveloperQueueMutation(
        new Request('https://pro-room.internal/internal/developer/v1/queue/mutate', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...proRoomGenerationWireHeaders(this.room.roomGeneration),
          },
          body: JSON.stringify({
            roomCode: this.room.roomCode,
            ...proRoomGenerationWireFields(this.room.roomGeneration),
            keyId: BOT_DEVELOPER_KEY_ID,
            developerAuthorityEpoch: this.room.developerAuthorityEpoch,
            idempotencyKey: queueIdempotencyKey,
            mutation:
              plan.intent === 'remove_items'
                ? { type: 'remove_many', queueItemIds: plan.queueItemIds }
                : { type: 'clear' },
          }),
        }),
        {
          action: plan.intent,
          languageHint: plan.answer || '',
          expectedPlaylistRevision:
            plan.intent === 'clear_queue' ? plan.basePlaylistRevision : undefined,
          terminalScope: scope,
          terminalKey: parsed.value.requestId,
          terminalFingerprint: fingerprint,
        },
      );
      if (!queueResponse.ok) {
        const queueError = await queueResponse
          .clone()
          .json()
          .catch(() => null);
        if (queueError?.error === 'BOT_CONTEXT_STALE') return queueResponse;
        return errorResponse('BOT_ACTION_FAILED', 409);
      }
      destructiveResponseBody =
        this.room.idempotency[`${scope}:${parsed.value.requestId}`]?.body || null;
      if (!destructiveResponseBody) return errorResponse('BOT_ACTION_FAILED', 409);
    } else if (plan.intent === 'playback') {
      playbackChanged = await this.runBotDeveloperCommand(parsed.value.requestId, {
        type: plan.playbackCommand,
      });
      if (!playbackChanged) return errorResponse('BOT_ACTION_FAILED', 409);
    } else if (plan.intent === 'queue_mode') {
      const modeIdempotencyKey = await botDerivedIdempotencyKey(parsed.value.requestId, 'mode');
      const queueModeResponse = await this.handleInternalDeveloperQueueModeUpdate(
        new Request('https://pro-room.internal/internal/developer/v1/queue-mode/update', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...proRoomGenerationWireHeaders(this.room.roomGeneration),
          },
          body: JSON.stringify({
            roomCode: this.room.roomCode,
            ...proRoomGenerationWireFields(this.room.roomGeneration),
            keyId: BOT_DEVELOPER_KEY_ID,
            developerAuthorityEpoch: this.room.developerAuthorityEpoch,
            idempotencyKey: modeIdempotencyKey,
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
    } else if (plan.intent === 'virtual_treble') {
      const effectsChanged = await this.runBotDeveloperCommand(parsed.value.requestId, {
        type: 'set_effects',
        effects: { virtualTreble: { enabled: plan.virtualTrebleEnabled } },
      });
      if (!effectsChanged) return errorResponse('BOT_ACTION_FAILED', 409);
    }

    if (destructiveResponseBody) return jsonResponse(destructiveResponseBody);

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

  developerAuthorityEpochError(value) {
    if (value === undefined) {
      return this.room.developerAuthorityEpoch === 0
        ? null
        : errorResponse('DEVELOPER_API_AUTHORITY_STALE', 409);
    }
    if (!isSafeNonNegativeInteger(value)) return errorResponse('INVALID_REQUEST', 400);
    return value === this.room.developerAuthorityEpoch
      ? null
      : errorResponse('DEVELOPER_API_AUTHORITY_STALE', 409);
  }

  async handleInternalDeveloperRead(request) {
    if (!this.room.provisioned || this.room.status !== 'active') {
      return errorResponse('ROOM_NOT_FOUND', 404);
    }
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(
        parsed.value,
        ['projection'],
        ['keyId', 'effectsVersion', 'roomGeneration', 'developerAuthorityEpoch'],
      ) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.room.roomGeneration ||
      (parsed.value.keyId !== undefined &&
        !DEVELOPER_API_KEY_ID_RE.test(parsed.value.keyId || '')) ||
      (parsed.value.projection === 'effects'
        ? parsed.value.effectsVersion !== 2
        : parsed.value.effectsVersion !== undefined) ||
      !['room', 'playback', 'queue', 'effects', 'queue-mode'].includes(parsed.value.projection)
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const authorityError = this.developerAuthorityEpochError(parsed.value.developerAuthorityEpoch);
    if (authorityError) return authorityError;
    const projection = developerProjection(
      this.room,
      parsed.value.projection,
      Date.now(),
      parsed.value.keyId,
      parsed.value.projection === 'effects' ? 2 : 1,
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
      !hasExactKeys(
        parsed.value,
        ['roomCode', 'keyId', 'idempotencyKey', 'command'],
        ['roomGeneration', 'developerAuthorityEpoch'],
      ) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.room.roomGeneration ||
      parsed.value.roomCode !== this.room.roomCode ||
      !DEVELOPER_API_KEY_ID_RE.test(parsed.value.keyId || '') ||
      !IDEMPOTENCY_KEY_RE.test(parsed.value.idempotencyKey || '')
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const authorityError = this.developerAuthorityEpochError(parsed.value.developerAuthorityEpoch);
    if (authorityError) return authorityError;
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

    const requiredControlVersion = requiredDeveloperControlVersion(command);
    if (command.type === 'play_item') {
      if (!this.room.playlist.some((item) => item.queueItemId === command.queueItemId)) {
        return errorResponse('QUEUE_ITEM_NOT_FOUND', 404);
      }
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
      developerControlVersion: requiredControlVersion,
      expected: {
        queueItemId: this.room.currentQueueItemId,
        playlistRevision: this.room.playlistRevision,
        playbackRevision: this.room.playback.revision,
      },
      status: 'pending',
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

    let authorityResult = null;
    if (command.type === 'set_effects') {
      if (this.room.effects.revision >= Number.MAX_SAFE_INTEGER) {
        this.completeDeveloperCommand(record, 'rejected', 'execution_failed', nowMs);
      } else {
        const effects = mergeRoomEffectsPatch(this.room.effects.effects, command.effects);
        if (JSON.stringify(effects) !== JSON.stringify(this.room.effects.effects)) {
          this.room.effects = {
            revision: this.room.effects.revision + 1,
            updatedAtMs: nowMs,
            masterVolume: this.room.effects.masterVolume ?? 1,
            effects,
          };
          this.room.revision += 1;
        }
        this.completeDeveloperCommand(record, 'applied', 'applied', nowMs);
      }
    } else {
      const authorityCommand =
        command.type === 'play_item'
          ? {
              type: 'select',
              baseRevision: this.room.playback.revision,
              queueItemId: command.queueItemId,
              state: 'playing',
              positionSeconds: 0,
            }
          : { ...command, baseRevision: this.room.playback.revision };
      authorityResult = this.applyPlaybackAuthorityCommand(authorityCommand, nowMs, commandId);
      if (authorityResult.error) {
        this.completeDeveloperCommand(
          record,
          'rejected',
          authorityResult.error === 'NO_MEDIA'
            ? 'no_media'
            : authorityResult.error === 'PLAYBACK_REVISION_CONFLICT'
              ? 'stale_queue'
              : 'execution_failed',
          nowMs,
        );
      } else if (authorityResult.status === 'unchanged') {
        this.completeDeveloperCommand(record, 'applied', 'already_applied', nowMs);
      }
    }
    this.syncDeveloperCommandIdempotency(record);
    this.enqueuePlaybackOutcome(authorityResult, nowMs);
    await this.persist();
    if (command.type === 'set_effects' && record.status === 'applied') {
      await this.broadcastServerEvent(
        this.invalidationEvent({ effectsRevision: this.room.effects.revision }),
      );
    }
    return jsonResponse(publicDeveloperCommand(record), 202);
  }

  async handleInternalDeveloperCommandStatus(request) {
    if (!this.room.provisioned || this.room.status !== 'active') {
      return errorResponse('ROOM_NOT_FOUND', 404);
    }
    const parsed = await this.parseBody(request, 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(
        parsed.value,
        ['roomCode', 'keyId', 'commandId'],
        ['roomGeneration', 'developerAuthorityEpoch'],
      ) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.room.roomGeneration ||
      parsed.value.roomCode !== this.room.roomCode ||
      !DEVELOPER_API_KEY_ID_RE.test(parsed.value.keyId || '') ||
      !DEVELOPER_COMMAND_ID_RE.test(parsed.value.commandId || '')
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const authorityError = this.developerAuthorityEpochError(parsed.value.developerAuthorityEpoch);
    if (authorityError) return authorityError;
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

  async handleInternalDeveloperQueueMutation(request, botTerminal = null) {
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
        ['actorName', 'roomGeneration', 'developerAuthorityEpoch'],
      ) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.room.roomGeneration ||
      parsed.value.roomCode !== this.room.roomCode ||
      !DEVELOPER_API_KEY_ID_RE.test(parsed.value.keyId || '') ||
      !IDEMPOTENCY_KEY_RE.test(parsed.value.idempotencyKey || '') ||
      (parsed.value.actorName !== undefined && !validDeveloperActorName(parsed.value.actorName))
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const authorityError = this.developerAuthorityEpochError(parsed.value.developerAuthorityEpoch);
    if (authorityError) return authorityError;
    const mutation = parseDeveloperQueueMutation(parsed.value.mutation);
    if (!mutation) return errorResponse('INVALID_REQUEST', 400);
    const botTerminalAction =
      mutation.type === 'remove_many'
        ? 'remove_items'
        : mutation.type === 'clear'
          ? 'clear_queue'
          : null;
    if (
      botTerminal !== null &&
      (botTerminalAction === null ||
        botTerminal.action !== botTerminalAction ||
        !/^bot-execute:[A-Za-z0-9_-]{43}$/u.test(botTerminal.terminalScope || '') ||
        !BOT_REQUEST_ID_RE.test(botTerminal.terminalKey || '') ||
        !SHA256_RE.test(botTerminal.terminalFingerprint || '') ||
        (botTerminalAction === 'clear_queue' &&
          !isSafeNonNegativeInteger(botTerminal.expectedPlaylistRevision)) ||
        (botTerminalAction === 'remove_items' &&
          botTerminal.expectedPlaylistRevision !== undefined) ||
        (botTerminal.languageHint !== undefined &&
          boundedString(botTerminal.languageHint, 240, true) === null))
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
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
    let removedCount = null;
    let destructivePlaybackChanged = false;
    // The public developer clear remains intentionally unfenced. BOT clear is
    // destructive and is therefore bound to the exact queue revision shown to
    // the model. Recheck here, after every parser/fingerprint await and directly
    // before mutation, so a stale plan cannot clear newly-added tracks.
    if (
      botTerminal !== null &&
      botTerminalAction === 'clear_queue' &&
      this.room.playlistRevision !== botTerminal.expectedPlaylistRevision
    ) {
      return errorResponse('BOT_CONTEXT_STALE', 409);
    }
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
          ...(mutation.videoIds === undefined ? {} : { videoIds: [...mutation.videoIds] }),
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
          ...(candidate.videoIds === undefined ? {} : { videoIds: [...candidate.videoIds] }),
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
        destructivePlaybackChanged = true;
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
    } else if (mutation.type === 'remove_many') {
      const queueItemIds = new Set(mutation.queueItemIds);
      if (
        mutation.queueItemIds.some(
          (queueItemId) => !this.room.playlist.some((item) => item.queueItemId === queueItemId),
        )
      ) {
        return errorResponse('QUEUE_ITEM_NOT_FOUND', 404);
      }
      if (
        this.room.playlistRevision >= Number.MAX_SAFE_INTEGER ||
        this.room.revision >= Number.MAX_SAFE_INTEGER
      ) {
        return errorResponse('ROOM_STATE_CAPACITY_EXCEEDED', 409);
      }
      const clearCurrentPlayback =
        (this.room.currentQueueItemId !== null && queueItemIds.has(this.room.currentQueueItemId)) ||
        (this.room.playback.queueItemId !== null &&
          queueItemIds.has(this.room.playback.queueItemId));
      if (clearCurrentPlayback && this.room.playback.revision >= Number.MAX_SAFE_INTEGER) {
        return errorResponse('PLAYBACK_REVISION_EXHAUSTED', 409);
      }
      removedCount = queueItemIds.size;
      this.room.playlist = this.room.playlist.filter((item) => !queueItemIds.has(item.queueItemId));
      playlistChanged = true;
      if (clearCurrentPlayback) {
        destructivePlaybackChanged = true;
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
      removedCount = this.room.playlist.length;
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
          destructivePlaybackChanged = true;
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
          destructivePlaybackChanged = true;
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
    let playbackCancelEvent = null;
    if (
      destructivePlaybackChanged ||
      (this.room.pendingPlaybackTransition?.target.queueItemId != null &&
        !this.room.playlist.some(
          (item) => item.queueItemId === this.room.pendingPlaybackTransition.target.queueItemId,
        ))
    ) {
      playbackCancelEvent = this.cancelPendingPlayback('queue-item-removed', nowMs);
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
    if (botTerminal !== null) {
      this.storeIdempotency(
        botTerminal.terminalScope,
        botTerminal.terminalKey,
        botTerminal.terminalFingerprint,
        botDestructiveResult(
          botTerminalAction,
          removedCount,
          destructivePlaybackChanged,
          botTerminal.languageHint,
        ),
      );
    }
    if (playbackCancelEvent) this.enqueuePlaybackBroadcast(playbackCancelEvent);
    if (destructivePlaybackChanged) {
      this.enqueuePlaybackBroadcast(
        this.playbackCommitEvent(null, this.room.playback.updatedAtMs, nowMs),
      );
    }
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
          ? {
              actorName: parsed.value.actorName,
              fallback: 'API',
              count: addedCount,
              firstTitle:
                mutation.type === 'add_youtube'
                  ? mutation.title || mutation.name
                  : mutation.items[0]?.title || mutation.items[0]?.name,
            }
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
      !hasExactKeys(
        parsed.value,
        ['roomCode', 'keyId', 'idempotencyKey', 'queueMode'],
        ['roomGeneration', 'developerAuthorityEpoch'],
      ) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.room.roomGeneration ||
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
    const authorityError = this.developerAuthorityEpochError(parsed.value.developerAuthorityEpoch);
    if (authorityError) return authorityError;

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
    if (changed) {
      this.scheduleServerEvent(
        this.invalidationEvent({ queueModeRevision: this.room.queueMode.revision }),
      );
    }
    return jsonResponse(responseBody);
  }

  async handleInternalDeveloperMediaUploadCreate(request) {
    if (!this.room.provisioned || this.room.status !== 'active') {
      return errorResponse('ROOM_NOT_FOUND', 404);
    }
    const parsed = await this.parseBody(request, 16 * 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(
        parsed.value,
        ['roomCode', 'keyId', 'idempotencyKey', 'media'],
        ['roomGeneration', 'developerAuthorityEpoch'],
      ) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.room.roomGeneration ||
      parsed.value.roomCode !== this.room.roomCode ||
      !DEVELOPER_API_KEY_ID_RE.test(parsed.value.keyId || '') ||
      !IDEMPOTENCY_KEY_RE.test(parsed.value.idempotencyKey || '')
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const authorityError = this.developerAuthorityEpochError(parsed.value.developerAuthorityEpoch);
    if (authorityError) return authorityError;
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
    const objectPrefix = `${proRoomMediaPrefix(
      this.room.roomCode,
      this.room.roomGeneration,
    )}/assets/${assetId}/v${version}`;
    const stagingObjectKey = `${objectPrefix}/staging_${randomToken(18)}`;
    const objectKey = `${objectPrefix}/object_${randomToken(24)}`;
    const uploadHeaders = {
      'content-length': String(media.byteLength),
      'content-type': media.mime,
      'x-amz-meta-mxqr-room': this.room.roomCode,
      ...proRoomGenerationUploadMetadataHeaders(this.room.roomGeneration),
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
      roomGeneration: this.room.roomGeneration,
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
        ['actorName', 'roomGeneration', 'developerAuthorityEpoch'],
      ) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.room.roomGeneration ||
      parsed.value.roomCode !== this.room.roomCode ||
      !DEVELOPER_API_KEY_ID_RE.test(parsed.value.keyId || '') ||
      !IDEMPOTENCY_KEY_RE.test(parsed.value.idempotencyKey || '') ||
      !OPAQUE_ID_RE.test(parsed.value.assetId || '') ||
      (parsed.value.actorName !== undefined && !validDeveloperActorName(parsed.value.actorName))
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const authorityError = this.developerAuthorityEpochError(parsed.value.developerAuthorityEpoch);
    if (authorityError) return authorityError;
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
    const assetRoomGeneration = asset.roomGeneration;
    if (assetRoomGeneration !== this.room.roomGeneration) {
      return errorResponse('ROOM_STATE_INVALID', 503);
    }
    const expectedObjectMetadata = {
      'mxqr-room': this.room.roomCode,
      'mxqr-generation': String(assetRoomGeneration),
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
      firstTitle: queueItem.title || queueItem.name,
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
    if (
      this.room.status !== 'active' ||
      !Number.isSafeInteger(this.room.revision) ||
      this.room.revision < 0 ||
      !Number.isSafeInteger(this.room.playlistRevision) ||
      this.room.playlistRevision < 0
    ) {
      return;
    }
    const firstTitle = queueAdditionTrackTitle(addition?.firstTitle);
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
            ...(firstTitle ? { firstTitle } : {}),
          }
        : null;
    this.scheduleServerEvent(
      this.invalidationEvent({
        playlistRevision: this.room.playlistRevision,
        ...(normalizedAddition ? { addition: normalizedAddition } : {}),
      }),
    );
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
        if (this.room.pendingPlaybackTransition?.developerCommandId === record.commandId) {
          const cancelEvent = this.cancelPendingPlayback('command-expired', nowMs);
          if (cancelEvent) this.scheduleServerEvent(cancelEvent);
        }
        changed = true;
      }
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
    if (!this.room.developerCommands[commandId]) return errorResponse('COMMAND_NOT_FOUND', 404);
    // Browser ACKs belonged to the removed coordinator relay. Commands are
    // now applied by this Durable Object and observed through status polling.
    return errorResponse('COMMAND_ACK_NOT_REQUIRED', 410);
  }

  async handleInternalActivationClaim(request) {
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
    let targetAccountId = null;
    if (
      String(request.headers.get('content-type') || '')
        .toLowerCase()
        .startsWith('application/json')
    ) {
      const parsed = await this.parseBody(request, 1024);
      if (parsed.response) return parsed.response;
      if (
        !hasExactKeys(parsed.value, ['roomGeneration', 'targetAccountId']) ||
        parsed.value.roomGeneration !== this.room.roomGeneration ||
        !ACCOUNT_ID_RE.test(parsed.value.targetAccountId || '')
      ) {
        return errorResponse('INVALID_REQUEST', 400);
      }
      targetAccountId = parsed.value.targetAccountId;
    }
    this.room.activationClaimGeneration += 1;
    // Persist the new generation before returning the credential. A lost
    // response may require the operator to issue again, but can never leave a
    // returned link valid without its generation being authoritative.
    await this.persist();
    const claim = await issueProRoomActivationClaim(this.room.roomCode, secret, {
      nowMs,
      expiresAtMs: expiresAt,
      generation: this.room.activationClaimGeneration,
      roomGeneration: this.room.roomGeneration,
      ...(targetAccountId === null ? {} : { targetAccountId }),
    });
    return jsonResponse({
      roomCode: this.room.roomCode,
      roomGeneration: this.room.roomGeneration,
      activationUrl: `https://musixquare.com/${this.room.roomCode}#pro-claim=${encodeURIComponent(claim)}`,
      expiresAt,
    });
  }

  async handleInternalOwnerRecoveryClaim() {
    if (!this.room.provisioned) return errorResponse('PRO_ROOM_NOT_FOUND', 404);
    if (this.room.status !== 'active' || !ACCOUNT_ID_RE.test(this.room.ownerAccountId || '')) {
      return jsonResponse(
        {
          error: 'PRO_ROOM_OWNER_RECOVERY_UNAVAILABLE',
          status: this.room.status,
          reason: this.room.status === 'active' ? 'owner_account_not_linked' : 'room_not_active',
        },
        409,
        { 'cache-control': 'no-store, max-age=0' },
      );
    }
    const secret = String(this.env.PRO_ROOM_ACTIVATION_SECRET || '');
    if (secret.length < 32) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    const nowMs = Date.now();
    const expiresAt = nowMs + 10 * 60 * 1000;
    const claim = await issueProRoomOwnerRecoveryClaim(this.room.roomCode, secret, {
      nowMs,
      expiresAtMs: expiresAt,
      roomGeneration: this.room.roomGeneration,
      ownerAuthorityEpoch: this.room.ownerAuthorityEpoch,
    });
    return jsonResponse(
      {
        roomCode: this.room.roomCode,
        roomGeneration: this.room.roomGeneration,
        recoveryUrl: `https://musixquare.com/${this.room.roomCode}#pro-recovery=${encodeURIComponent(claim)}`,
        expiresAt,
        ownerAccountLinked: true,
      },
      200,
      { 'cache-control': 'no-store, max-age=0' },
    );
  }

  async handleInternalOwnerTransferClaim(request) {
    if (!this.room.provisioned) return errorResponse('PRO_ROOM_NOT_FOUND', 404);
    const nowMs = Date.now();
    if (
      (this.room.pendingOwnershipTransfer?.expiresAtMs || 0) > nowMs ||
      (this.room.completedOwnershipTransfer?.replayUntilMs || 0) > nowMs
    ) {
      return errorResponse('OWNER_TRANSFER_RECONCILIATION_REQUIRED', 409);
    }
    if (
      this.room.status !== 'active' &&
      !(
        this.room.status === 'suspended' &&
        (this.room.suspensionReason === 'operator_suspended' ||
          this.room.suspensionReason === 'owner_account_deleted' ||
          this.room.suspensionReason === 'ownership_transfer_pending')
      )
    ) {
      return jsonResponse(
        {
          error: 'PRO_ROOM_OWNER_TRANSFER_UNAVAILABLE',
          status: this.room.status,
          suspensionReason: this.room.suspensionReason,
        },
        409,
        { 'cache-control': 'no-store, max-age=0' },
      );
    }
    const parsed = await this.parseBody(request, 1024);
    if (
      parsed.response ||
      !hasExactKeys(parsed.value, ['targetAccountId'], ['roomGeneration']) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.room.roomGeneration ||
      !ACCOUNT_ID_RE.test(parsed.value.targetAccountId || '')
    ) {
      return parsed.response || errorResponse('INVALID_REQUEST', 400);
    }
    if (this.room.ownerAuthorityRemoval?.projectionAcked === false) {
      return errorResponse('OWNER_AUTHORITY_PROJECTION_PENDING', 409);
    }
    if (
      this.room.status === 'active' &&
      this.room.ownerAccountId === parsed.value.targetAccountId
    ) {
      return errorResponse('OWNER_TRANSFER_TARGET_UNCHANGED', 409);
    }
    const secret = String(this.env.PRO_ROOM_ACTIVATION_SECRET || '');
    if (secret.length < 32) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    if (this.room.ownershipTransferClaimGeneration >= Number.MAX_SAFE_INTEGER) {
      return errorResponse('OWNER_TRANSFER_CLAIM_CAPACITY_EXCEEDED', 409);
    }
    if (
      this.room.pendingOwnershipTransfer &&
      (this.room.authEpoch >= Number.MAX_SAFE_INTEGER ||
        this.room.ownerAuthorityEpoch >= Number.MAX_SAFE_INTEGER ||
        this.room.revision >= Number.MAX_SAFE_INTEGER)
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }
    const expiresAt = nowMs + OWNER_TRANSFER_CLAIM_DEFAULT_LIFETIME_MS;
    if (this.room.pendingOwnershipTransfer) {
      // The old transaction has expired, but preserve its previous-owner edge
      // until the replacement PREPARE copies it. Advancing both authority
      // fences makes every captured credential/proof unambiguously obsolete.
      this.room.authEpoch += 1;
      this.room.ownerAuthorityEpoch += 1;
      this.room.revision += 1;
    }
    this.room.ownershipTransferClaimGeneration += 1;
    await this.persist();
    const claim = await issueProRoomOwnerTransferClaim(this.room.roomCode, secret, {
      nowMs,
      expiresAtMs: expiresAt,
      roomGeneration: this.room.roomGeneration,
      targetAccountId: parsed.value.targetAccountId,
      claimGeneration: this.room.ownershipTransferClaimGeneration,
      ownerAuthorityEpoch: this.room.ownerAuthorityEpoch,
    });
    return jsonResponse(
      {
        ok: true,
        roomCode: this.room.roomCode,
        roomGeneration: this.room.roomGeneration,
        status: this.room.status,
        suspensionReason: this.room.suspensionReason,
        targetAccountId: parsed.value.targetAccountId,
        claimGeneration: this.room.ownershipTransferClaimGeneration,
        transferUrl: `https://musixquare.com/${this.room.roomCode}#pro-transfer=${encodeURIComponent(claim)}`,
        expiresAt,
      },
      200,
      { 'cache-control': 'no-store, max-age=0' },
    );
  }

  markRegistryActivationActive() {
    const db = this.env?.MUSIXQUARE_ADMIN_DB || this.env?.ADMIN_METRICS_DB || null;
    if (!db?.prepare) return;
    const update = (async () => {
      if ((await readServiceMaintenance(this.env)).enabled) return;
      await db
        .prepare(
          `UPDATE mxqr_pro_room_registry
           SET activation_state = 'active', updated_at = ?3
           WHERE room_code = ?1 AND room_generation = ?2 AND status = 'registered'`,
        )
        .bind(this.room.roomCode, this.room.roomGeneration, Date.now())
        .run();
    })().catch((error) => {
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
    const capacityError = this.rateLimitCapacityResponse(
      this.room.rateLimits,
      [key],
      RATE_LIMIT_MAX_ITEMS,
      now,
    );
    if (capacityError) return capacityError;
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

  pruneAccountDeletionTombstones(nowMs) {
    let changed = false;
    for (const [accountId, expiresAtMs] of Object.entries(
      this.room.accountDeletionTombstones || {},
    )) {
      if (expiresAtMs > nowMs) continue;
      delete this.room.accountDeletionTombstones[accountId];
      changed = true;
    }
    return changed;
  }

  retainAccountDeletionTombstone(accountId, nowMs) {
    const pruned = this.pruneAccountDeletionTombstones(nowMs);
    const tombstones = this.room.accountDeletionTombstones;
    if (
      tombstones[accountId] === undefined &&
      Object.keys(tombstones).length >= ACCOUNT_DELETION_TOMBSTONE_MAX_ITEMS
    ) {
      // Do not evict a live deletion fence: doing so could admit an assertion
      // that was issued before account deletion but arrived afterward.
      throw new RoomStateCapacityError();
    }
    // A target deleted after transfer PREPARE must remain fenced for the
    // entire transaction lifetime. The ordinary assertion tombstone can be
    // shorter than an owner-transfer claim, and allowing it to expire first
    // would let a later internal reconciliation install a deleted account.
    const pendingTransferExpiry =
      this.room.pendingOwnershipTransfer?.targetAccountId === accountId
        ? this.room.pendingOwnershipTransfer.expiresAtMs
        : 0;
    const expiresAtMs = Math.max(
      nowMs + ACCOUNT_DELETION_TOMBSTONE_TTL_MS,
      Number.isSafeInteger(pendingTransferExpiry) ? pendingTransferExpiry : 0,
    );
    const changed = tombstones[accountId] !== expiresAtMs;
    tombstones[accountId] = expiresAtMs;
    return pruned || changed;
  }

  isAccountDeletionTombstoned(accountId, nowMs = Date.now()) {
    return (this.room.accountDeletionTombstones?.[accountId] || 0) > nowMs;
  }

  async accountAssertion(request) {
    const token = request.headers.get(ACCOUNT_ASSERTION_HEADER);
    if (!token) return { account: null };
    const secret = String(this.env.MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET || '');
    if (secret.length < 32) {
      return { response: errorResponse('ACCOUNT_IDENTITY_NOT_CONFIGURED', 503) };
    }
    const account = await verifyAccountAssertion(token, secret, {
      audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
      roomCode: this.room.roomCode,
      roomGeneration: this.room.roomGeneration,
    });
    return account && !this.isAccountDeletionTombstoned(account.accountId)
      ? { account }
      : { response: errorResponse('ACCOUNT_ASSERTION_INVALID', 401) };
  }

  usedMemberDisplayNumbers() {
    const used = new Set();
    for (const member of Object.values(this.room.accountMembers || {})) {
      if (Number.isSafeInteger(member.displayNumber) && member.displayNumber > 0) {
        used.add(member.displayNumber);
      }
    }
    for (const administrator of Object.values(this.room.anonymousAdministrators || {})) {
      if (Number.isSafeInteger(administrator.displayNumber) && administrator.displayNumber > 0) {
        used.add(administrator.displayNumber);
      }
    }
    for (const session of Object.values(this.room.sessions || {})) {
      if (Number.isSafeInteger(session.memberDisplayNumber) && session.memberDisplayNumber > 0) {
        used.add(session.memberDisplayNumber);
      }
      if (Number.isSafeInteger(session.peerOrdinal) && session.peerOrdinal > 0) {
        used.add(session.peerOrdinal);
      }
    }
    return used;
  }

  physicalSlotGroupKey(session) {
    return typeof session.accountId === 'string'
      ? `account:${session.accountId}`
      : `member:${session.memberId}`;
  }

  memberDisplayNumberReservations() {
    const reservations = new Map();
    const reserve = (displayNumber, groupKey) => {
      if (
        Number.isSafeInteger(displayNumber) &&
        displayNumber > 0 &&
        displayNumber <= SESSION_MAX_ITEMS &&
        !reservations.has(displayNumber)
      ) {
        reservations.set(displayNumber, groupKey);
      }
    };
    const liveSessionHashes = new Set(
      Object.values(this.room.presence.participants || {}).map(
        (participant) => participant.sessionHash,
      ),
    );
    const sessions = Object.entries(this.room.sessions || {}).sort(
      ([leftHash, left], [rightHash, right]) =>
        Number(liveSessionHashes.has(rightHash)) - Number(liveSessionHashes.has(leftHash)) ||
        (left.createdAtMs || 0) - (right.createdAtMs || 0) ||
        String(left.participantId || '').localeCompare(String(right.participantId || '')) ||
        leftHash.localeCompare(rightHash),
    );
    // A live presence epoch owns the visible numbering. Persistent authority
    // records and dormant resume cookies may retain older numbers, but they
    // cannot displace a participant that is currently shown as #1.
    for (const [tokenHash, session] of sessions) {
      if (session.role === 'owner' || !liveSessionHashes.has(tokenHash)) continue;
      reserve(session.memberDisplayNumber, this.physicalSlotGroupKey(session));
    }
    for (const [accountId, member] of Object.entries(this.room.accountMembers || {})) {
      reserve(member.displayNumber, `account:${accountId}`);
    }
    for (const [memberId, administrator] of Object.entries(
      this.room.anonymousAdministrators || {},
    )) {
      reserve(administrator.displayNumber, `member:${memberId}`);
    }
    for (const [, session] of sessions) {
      if (session.role === 'owner') continue;
      reserve(session.memberDisplayNumber, this.physicalSlotGroupKey(session));
    }
    return reservations;
  }

  normalizeLoadedPhysicalSlotAssignments(canMigrateAnonymousIdentity = true) {
    let anonymousIdentityChanged = false;
    const liveSessionHashes = new Set(
      Object.values(this.room.presence.participants || {}).map(
        (participant) => participant.sessionHash,
      ),
    );
    const sessions = Object.entries(this.room.sessions || {})
      .filter(([, session]) => session.role !== 'owner')
      .sort(
        ([leftHash, left], [rightHash, right]) =>
          Number(liveSessionHashes.has(rightHash)) - Number(liveSessionHashes.has(leftHash)) ||
          (left.createdAtMs || 0) - (right.createdAtMs || 0) ||
          String(left.participantId || '').localeCompare(String(right.participantId || '')) ||
          leftHash.localeCompare(rightHash),
      );
    const reservations = this.memberDisplayNumberReservations();
    const assigned = new Map();
    const used = new Set();

    // Preserve durable unique assignments when they do not steal another
    // member's canonical number. This keeps ordinary restarts byte-stable.
    for (const [, session] of sessions) {
      const preferred = session.peerOrdinal;
      const groupKey = this.physicalSlotGroupKey(session);
      const reservationOwner = reservations.get(preferred);
      if (
        !Number.isSafeInteger(preferred) ||
        preferred < 1 ||
        preferred > SESSION_MAX_ITEMS ||
        used.has(preferred) ||
        (reservationOwner !== undefined && reservationOwner !== groupKey)
      ) {
        continue;
      }
      assigned.set(session, preferred);
      used.add(preferred);
    }

    for (const [, session] of sessions) {
      if (assigned.has(session)) continue;
      const groupKey = this.physicalSlotGroupKey(session);
      const preferred = session.memberDisplayNumber;
      const preferredOwner = reservations.get(preferred);
      let ordinal =
        Number.isSafeInteger(preferred) &&
        preferred >= 1 &&
        preferred <= SESSION_MAX_ITEMS &&
        !used.has(preferred) &&
        (preferredOwner === undefined || preferredOwner === groupKey)
          ? preferred
          : 1;
      while (
        ordinal <= SESSION_MAX_ITEMS &&
        (used.has(ordinal) || (reservations.has(ordinal) && reservations.get(ordinal) !== groupKey))
      ) {
        ordinal += 1;
      }
      // A fully occupied legacy reservation table must not make an otherwise
      // valid stored room unloadable. Physical uniqueness still takes priority.
      if (ordinal > SESSION_MAX_ITEMS) {
        ordinal = 1;
        while (ordinal <= SESSION_MAX_ITEMS && used.has(ordinal)) ordinal += 1;
      }
      if (ordinal > SESSION_MAX_ITEMS) continue;
      assigned.set(session, ordinal);
      used.add(ordinal);
    }

    let highestOrdinal = 0;
    for (const [, session] of sessions) {
      const ordinal = assigned.get(session);
      if (!Number.isSafeInteger(ordinal)) continue;
      highestOrdinal = Math.max(highestOrdinal, ordinal);
      if (!session.accountId) {
        if (!canMigrateAnonymousIdentity) continue;
        if (session.peerOrdinal !== ordinal) anonymousIdentityChanged = true;
        session.peerOrdinal = ordinal;
        if (session.memberDisplayNumber !== ordinal) anonymousIdentityChanged = true;
        session.memberDisplayNumber = ordinal;
        const canonicalDisplayName = `${DEFAULT_PEER_DISPLAY_NAME} ${ordinal}`;
        if (session.displayName !== canonicalDisplayName) anonymousIdentityChanged = true;
        session.displayName = canonicalDisplayName;
        const administrator = this.room.anonymousAdministrators?.[session.memberId];
        if (administrator) {
          if (administrator.displayNumber !== ordinal) anonymousIdentityChanged = true;
          administrator.displayNumber = ordinal;
          if (administrator.displayName !== canonicalDisplayName) {
            anonymousIdentityChanged = true;
          }
          administrator.displayName = canonicalDisplayName;
        }
      } else {
        session.peerOrdinal = ordinal;
      }
    }
    if (highestOrdinal > 0) {
      this.room.nextMemberDisplayNumber = Math.min(
        SESSION_MAX_ITEMS + 1,
        Math.max(this.room.nextMemberDisplayNumber || 1, highestOrdinal + 1),
      );
    }
    return anonymousIdentityChanged;
  }

  nextAccountMemberDisplayNumber() {
    // Display numbers describe the current presence epoch, not the lifetime
    // of a resumable room cookie. A sleeping room can retain old sessions and
    // persistent account authority for hours; those dormant records must not
    // make the first returning listener appear as #12.
    return this.nextLivePhysicalDeviceOrdinal();
  }

  livePhysicalDeviceOrdinals(excludedSession = null) {
    const used = new Set();
    for (const participant of Object.values(this.room.presence.participants || {})) {
      const session = this.room.sessions?.[participant.sessionHash];
      if (!session || session === excludedSession || session.role === 'owner') continue;
      if (
        Number.isSafeInteger(session.peerOrdinal) &&
        session.peerOrdinal >= 1 &&
        session.peerOrdinal <= SESSION_MAX_ITEMS
      ) {
        used.add(session.peerOrdinal);
      }
    }
    return used;
  }

  nextLivePhysicalDeviceOrdinal(excludedSession = null) {
    const used = this.livePhysicalDeviceOrdinals(excludedSession);
    for (let ordinal = 1; ordinal <= SESSION_MAX_ITEMS; ordinal += 1) {
      if (!used.has(ordinal)) return ordinal;
    }
    return null;
  }

  reclaimLiveAccountRepresentativeOrdinal(departed) {
    const representativeOrdinal = departed.memberDisplayNumber;
    if (
      !departed.accountId ||
      !Number.isSafeInteger(representativeOrdinal) ||
      representativeOrdinal < 1 ||
      representativeOrdinal > SESSION_MAX_ITEMS
    ) {
      return false;
    }

    const remaining = Object.values(this.room.presence.participants || {})
      .filter((participant) => participant.memberId === departed.memberId)
      .map((participant) => ({
        participant,
        session: this.room.sessions?.[participant.sessionHash],
      }))
      .filter(({ session }) => session && session.role !== 'owner')
      .sort(
        (left, right) =>
          (left.session.peerOrdinal || SESSION_MAX_ITEMS + 1) -
            (right.session.peerOrdinal || SESSION_MAX_ITEMS + 1) ||
          left.participant.joinedAtMs - right.participant.joinedAtMs ||
          left.participant.participantId.localeCompare(right.participant.participantId),
      );
    if (remaining.length === 0) return false;
    if (remaining.some(({ session }) => session.peerOrdinal === representativeOrdinal)) {
      return false;
    }

    // Keep the account row's visible number stable without reserving an extra
    // physical slot. When its representative device leaves, one remaining
    // device atomically inherits that ordinal before another member can join.
    // This avoids duplicate visible rows and still preserves the full 100
    // physical-device capacity.
    if (this.livePhysicalDeviceOrdinals().has(representativeOrdinal)) return false;
    remaining[0].session.peerOrdinal = representativeOrdinal;
    return true;
  }

  assignSessionPresenceIdentity(session) {
    if (session.role === 'owner') {
      session.memberDisplayNumber = 0;
      delete session.peerOrdinal;
      return true;
    }

    // A physical slot is scoped to live presence. Re-entering after a room
    // sleeps (or after another device leaves) is a new ordering event even if
    // the long-lived session cookie is reused.
    const peerOrdinal = this.nextLivePhysicalDeviceOrdinal(session);
    if (peerOrdinal === null) return false;
    session.peerOrdinal = peerOrdinal;

    const sameMember = Object.values(this.room.presence.participants || {}).find(
      (participant) => participant.memberId === session.memberId,
    );
    const groupDisplayNumber =
      sameMember &&
      Number.isSafeInteger(sameMember.memberDisplayNumber) &&
      sameMember.memberDisplayNumber > 0
        ? sameMember.memberDisplayNumber
        : peerOrdinal;
    session.memberDisplayNumber = groupDisplayNumber;

    if (session.accountId) {
      const member = this.room.accountMembers?.[session.accountId];
      if (member && member.memberId === session.memberId) {
        member.displayNumber = groupDisplayNumber;
        this.syncAccountMemberSessions(session.accountId, member);
      }
    } else {
      const administrator = this.room.anonymousAdministrators?.[session.memberId];
      if (administrator) {
        administrator.displayNumber = groupDisplayNumber;
        administrator.displayName = `${DEFAULT_PEER_DISPLAY_NAME} ${peerOrdinal}`;
      }
    }

    if (!session.accountId) {
      session.displayName = `${DEFAULT_PEER_DISPLAY_NAME} ${peerOrdinal}`;
    }
    this.room.nextMemberDisplayNumber = Math.min(
      SESSION_MAX_ITEMS + 1,
      Math.max(this.room.nextMemberDisplayNumber || 1, peerOrdinal + 1),
    );
    return true;
  }

  syncAccountMemberSessions(accountId, member) {
    for (const session of Object.values(this.room.sessions)) {
      if (session.accountId !== accountId) continue;
      session.memberId = member.memberId;
      session.memberDisplayNumber = member.displayNumber;
      session.displayName = member.displayName;
      session.role = member.role;
      const participant = this.room.presence.participants[session.participantId];
      if (!participant) continue;
      participant.accountId = accountId;
      participant.memberId = member.memberId;
      participant.memberDisplayNumber = member.displayNumber;
      participant.displayName = member.displayName;
      participant.role = member.role;
    }
  }

  detachAccountSession(session, nowMs, options = {}) {
    if (!session?.accountId) return null;
    const participant = this.room.presence.participants[session.participantId] || null;
    let memberDisplayNumber = this.nextAccountMemberDisplayNumber();
    if (memberDisplayNumber === null) {
      if (options.requireUniqueDisplayNumber === true) return null;
      // Revocation must never fail open merely because every display slot is
      // reserved. `peerOrdinal` is a physical-device label rather than an
      // authority key, so a temporary duplicate visual number is safer than
      // retaining owner/controller capabilities. The next normal slot repair
      // can choose a unique number after another session departs.
      memberDisplayNumber =
        Number.isSafeInteger(session.peerOrdinal) && session.peerOrdinal > 0
          ? session.peerOrdinal
          : Number.isSafeInteger(session.memberDisplayNumber) && session.memberDisplayNumber > 0
            ? session.memberDisplayNumber
            : 1;
    }

    delete session.accountId;
    delete session.accountLeaseExpiresAtMs;
    session.memberId = `member_${randomToken(18)}`;
    session.memberDisplayNumber = memberDisplayNumber;
    session.peerOrdinal = memberDisplayNumber;
    session.displayName = `${DEFAULT_PEER_DISPLAY_NAME} ${memberDisplayNumber}`;
    session.role = 'member';
    this.room.nextMemberDisplayNumber = Math.min(
      SESSION_MAX_ITEMS + 1,
      Math.max(this.room.nextMemberDisplayNumber || 1, memberDisplayNumber + 1),
    );

    if (participant) {
      delete participant.accountId;
      participant.memberId = session.memberId;
      participant.memberDisplayNumber = memberDisplayNumber;
      participant.displayName = session.displayName;
      participant.role = 'member';
      if (options.touchPresence === true) participant.lastSeenAtMs = nowMs;
      if (this.room.presence.revision < Number.MAX_SAFE_INTEGER) {
        this.room.presence.revision += 1;
      }
    }
    if (this.room.revision < Number.MAX_SAFE_INTEGER) this.room.revision += 1;
    return { participant, memberDisplayNumber };
  }

  resolveAccountMember(account, role, nowMs) {
    if (!account) return null;
    let member = this.room.accountMembers[account.accountId] || null;
    const linkingOwner = role === 'owner' && this.room.ownerAccountId === null;
    const linkedOwner = this.room.ownerAccountId === account.accountId;

    // A browser owner credential proves the existing owner, but must not
    // silently transfer a previously linked room to whichever Google account
    // happens to be signed in on that browser today.
    if (role === 'owner' && this.room.ownerAccountId && !linkedOwner) return null;

    if (!member) {
      if (Object.keys(this.room.accountMembers).length >= ACCOUNT_MEMBER_MAX_ITEMS) return null;
      const displayNumber = linkingOwner || linkedOwner ? 0 : this.nextAccountMemberDisplayNumber();
      if (displayNumber === null) return null;
      member = {
        memberId:
          linkingOwner || linkedOwner ? this.room.ownerMemberId : `member_${randomToken(18)}`,
        displayName: account.nickname,
        displayNumber,
        role: linkingOwner || linkedOwner ? 'owner' : 'member',
        permissions:
          linkingOwner || linkedOwner
            ? clonePermissionSet(OWNER_PERMISSIONS)
            : clonePermissionSet(MEMBER_PERMISSIONS),
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      this.room.accountMembers[account.accountId] = member;
      if (displayNumber > 0) {
        this.room.nextMemberDisplayNumber = Math.min(SESSION_MAX_ITEMS + 1, displayNumber + 1);
      }
    } else {
      member.displayName = account.nickname;
      member.updatedAtMs = nowMs;
    }

    if (linkingOwner || linkedOwner) {
      this.room.ownerAccountId = account.accountId;
      member.memberId = this.room.ownerMemberId;
      member.displayNumber = 0;
      member.role = 'owner';
      member.permissions = clonePermissionSet(OWNER_PERMISSIONS);
      this.room.ownerDisplayName = member.displayName;
    }
    this.syncAccountMemberSessions(account.accountId, member);
    return { accountId: account.accountId, ...member };
  }

  prepareOwnerAccountMember(account, nowMs) {
    if (!account) return null;
    const linkedOwner = this.room.ownerAccountId === account.accountId;
    if (this.room.ownerAccountId && !linkedOwner) return null;
    const existing = this.room.accountMembers[account.accountId] || null;
    if (!existing && Object.keys(this.room.accountMembers).length >= ACCOUNT_MEMBER_MAX_ITEMS) {
      return null;
    }
    return {
      accountId: account.accountId,
      ...(existing || {
        memberId: this.room.ownerMemberId,
        createdAtMs: nowMs,
      }),
      memberId: this.room.ownerMemberId,
      displayName: account.nickname,
      displayNumber: 0,
      role: 'owner',
      permissions: clonePermissionSet(OWNER_PERMISSIONS),
      updatedAtMs: nowMs,
    };
  }

  commitOwnerAccountMember(accountMember) {
    const { accountId, ...member } = accountMember;
    this.room.accountMembers[accountId] = member;
    this.room.ownerAccountId = accountId;
    this.room.ownerDisplayName = member.displayName;
    this.syncAccountMemberSessions(accountId, member);
  }

  findAccountMemberByMemberId(memberId) {
    return (
      Object.entries(this.room.accountMembers || {}).find(
        ([, member]) => member.memberId === memberId,
      ) || null
    );
  }

  syncAnonymousMemberSessions(memberId, role, administrator = null) {
    for (const session of Object.values(this.room.sessions || {})) {
      if (session.accountId || session.memberId !== memberId || session.role === 'owner') continue;
      session.role = role;
      if (administrator) {
        session.displayName = administrator.displayName;
        session.memberDisplayNumber = administrator.displayNumber;
      }
      const participant = this.room.presence.participants[session.participantId];
      if (!participant) continue;
      participant.role = role;
      participant.displayName = session.displayName;
      participant.memberDisplayNumber = session.memberDisplayNumber;
    }
  }

  removeAnonymousAdministrator(memberId) {
    if (!this.room.anonymousAdministrators?.[memberId]) return false;
    delete this.room.anonymousAdministrators[memberId];
    this.syncAnonymousMemberSessions(memberId, 'member');
    return true;
  }

  cleanupMemberAfterSessionRemoval(session) {
    if (!session) return false;
    const hasAnotherSession = Object.values(this.room.sessions || {}).some(
      (candidate) => candidate.memberId === session.memberId,
    );
    if (hasAnotherSession) return false;
    if (!session.accountId) return this.removeAnonymousAdministrator(session.memberId);
    const member = this.room.accountMembers?.[session.accountId];
    if (!member || member.role !== 'member') return false;
    delete this.room.accountMembers[session.accountId];
    return true;
  }

  removeSessionRecord(tokenHash) {
    const session = this.room.sessions[tokenHash];
    if (!session) return false;
    delete this.room.sessions[tokenHash];
    this.cleanupMemberAfterSessionRemoval(session);
    return true;
  }

  discardTransientMemberAuthority() {
    this.room.anonymousAdministrators = {};
    for (const [accountId, member] of Object.entries(this.room.accountMembers || {})) {
      if (member.role === 'member') delete this.room.accountMembers[accountId];
    }
  }

  memberSessionRecords(memberId) {
    return Object.entries(this.room.sessions || {}).filter(
      ([, session]) => session.memberId === memberId,
    );
  }

  administratorResponse() {
    return jsonResponse({
      authorityVersion: 1,
      administrators: publicAdministrators(this.room),
    });
  }

  async handleGetAdministrators(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    return this.administratorResponse();
  }

  async handlePutAdministrator(request, memberId) {
    const auth = await this.requireSession(request, { owner: true, activePresence: true });
    if (auth.response) return auth.response;
    if (!OPAQUE_ID_RE.test(memberId || '') || memberId === this.room.ownerMemberId) {
      return errorResponse('ADMINISTRATOR_TARGET_INVALID', 409);
    }
    const parsed = await this.parseBody(request, 2 * 1024);
    if (parsed.response) return parsed.response;
    if (!hasExactKeys(parsed.value, ['permissions'])) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const permissions = normalizePermissionSet(parsed.value.permissions);
    if (!permissions) return errorResponse('INVALID_REQUEST', 400);
    const nowMs = Date.now();
    const accountEntry = this.findAccountMemberByMemberId(memberId);
    if (accountEntry) {
      const [accountId, member] = accountEntry;
      if (member.role === 'owner' || accountId === this.room.ownerAccountId) {
        return errorResponse('OWNER_AUTHORITY_IMMUTABLE', 409);
      }
      member.role = 'controller';
      member.permissions = permissions;
      member.updatedAtMs = nowMs;
      this.syncAccountMemberSessions(accountId, member);
    } else {
      const sessions = this.memberSessionRecords(memberId).filter(
        ([, session]) => !session.accountId,
      );
      const session = sessions[0]?.[1];
      if (!session) return errorResponse('MEMBER_NOT_FOUND', 404);
      const existing = this.room.anonymousAdministrators[memberId];
      if (
        !existing &&
        Object.keys(this.room.anonymousAdministrators).length >= ANONYMOUS_ADMIN_MAX_ITEMS
      ) {
        return errorResponse('ADMINISTRATOR_CAPACITY_EXCEEDED', 409);
      }
      const administrator = {
        memberId,
        displayName: session.displayName,
        displayNumber: session.memberDisplayNumber,
        permissions,
        createdAtMs: existing?.createdAtMs || nowMs,
        updatedAtMs: nowMs,
      };
      this.room.anonymousAdministrators[memberId] = administrator;
      this.syncAnonymousMemberSessions(memberId, 'controller', administrator);
    }
    this.room.presence.revision += 1;
    this.room.revision += 1;
    await this.persist();
    this.scheduleServerEvent(this.presenceEvent());
    return this.administratorResponse();
  }

  async handleDeleteAdministrator(request, memberId) {
    const auth = await this.requireSession(request, { owner: true, activePresence: true });
    if (auth.response) return auth.response;
    if (!OPAQUE_ID_RE.test(memberId || '') || memberId === this.room.ownerMemberId) {
      return errorResponse('OWNER_AUTHORITY_IMMUTABLE', 409);
    }
    if (request.body && (request.headers.get('content-length') || '') !== '0') {
      return errorResponse('INVALID_REQUEST', 400);
    }
    let changed = false;
    const accountEntry = this.findAccountMemberByMemberId(memberId);
    if (accountEntry) {
      const [accountId, member] = accountEntry;
      if (member.role !== 'controller') return errorResponse('ADMINISTRATOR_NOT_FOUND', 404);
      member.role = 'member';
      member.permissions = clonePermissionSet(MEMBER_PERMISSIONS);
      member.updatedAtMs = Date.now();
      this.syncAccountMemberSessions(accountId, member);
      if (this.memberSessionRecords(memberId).length === 0) {
        delete this.room.accountMembers[accountId];
      }
      changed = true;
    } else {
      changed = this.removeAnonymousAdministrator(memberId);
    }
    if (!changed) return errorResponse('ADMINISTRATOR_NOT_FOUND', 404);
    this.room.presence.revision += 1;
    this.room.revision += 1;
    await this.persist();
    this.scheduleServerEvent(this.presenceEvent());
    return this.administratorResponse();
  }

  async handleInternalAuthorityCheck(request) {
    const parsed = await this.parseBody(request, 2 * 1024);
    const permission = parsed.value?.permission;
    const expectedKeys =
      permission === 'bot.result'
        ? ['participantId', 'presenceIncarnationId', 'permission', 'requestId', 'result']
        : permission === 'system.broadcast'
          ? ['participantId', 'presenceIncarnationId', 'permission', 'i18nKey']
          : ['participantId', 'presenceIncarnationId', 'permission'];
    if (
      parsed.response ||
      !hasExactKeys(parsed.value, [...expectedKeys, 'roomGeneration']) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.room.roomGeneration ||
      !OPAQUE_ID_RE.test(parsed.value.participantId || '') ||
      !OPAQUE_ID_RE.test(parsed.value.presenceIncarnationId || '') ||
      !isProInternalAuthorityPermission(permission)
    ) {
      return parsed.response || errorResponse('INVALID_REQUEST', 400);
    }
    const participant = this.room.presence.participants[parsed.value.participantId];
    const session = participant ? this.room.sessions[participant.sessionHash] : null;
    const hasCurrentPresence =
      !!participant &&
      !!session &&
      participant.presenceIncarnationId === parsed.value.presenceIncarnationId;
    let allowed = false;
    if (hasCurrentPresence) {
      if (PRO_ROOM_PERMISSION_KEYS.includes(permission)) {
        allowed = this.sessionHasPermission(session, permission);
      } else if (permission === 'room.configure') {
        allowed = session.role === 'owner';
      } else if (permission === 'chat.manage') {
        allowed = session.role === 'owner' || session.role === 'controller';
      } else if (permission === 'system.broadcast') {
        const requiredPermission = requiredProSystemMessagePermission(parsed.value.i18nKey);
        allowed =
          requiredPermission === 'room.configure'
            ? session.role === 'owner'
            : requiredPermission === 'playback.control' &&
              this.sessionHasPermission(session, 'playback.control');
      } else if (
        permission === 'bot.result' &&
        BOT_REQUEST_ID_RE.test(parsed.value.requestId || '')
      ) {
        const receipt =
          this.room.idempotency[`bot-execute:${participant.sessionHash}:${parsed.value.requestId}`];
        const body = receipt?.body;
        let expectedResult = null;
        if (
          body?.ok === true &&
          Number.isSafeInteger(body.addedCount) &&
          body.addedCount > 0 &&
          body.addedCount <= BOT_MAX_TRACK_ITEMS &&
          typeof body.playbackChanged === 'boolean'
        ) {
          expectedResult = {
            kind: 'added',
            count: body.addedCount,
            playbackChanged: body.playbackChanged,
          };
        } else if (
          body?.ok === true &&
          typeof body.summary === 'string' &&
          body.summary.trim().length > 0 &&
          body.summary.length <= 500
        ) {
          expectedResult = { kind: 'answer', text: body.summary };
        }
        allowed =
          expectedResult !== null &&
          JSON.stringify(parsed.value.result) === JSON.stringify(expectedResult);
      }
    }
    return allowed
      ? jsonResponse({
          allowed: true,
          roomCode: this.room.roomCode,
          ...proRoomGenerationWireFields(this.room.roomGeneration),
          memberId: session.memberId,
          role: session.role,
          permission,
        })
      : errorResponse('PERMISSION_REQUIRED', 403);
  }

  async currentOwnerAccountDeletionState() {
    const accountId = this.room.ownerAccountId;
    if (!ACCOUNT_ID_RE.test(accountId || '')) return 'not-linked';
    const db = this.env.MUSIXQUARE_AUTH_DB;
    if (!db?.prepare) return 'unavailable';
    try {
      // This query always returns one row. The deletion fence is created before
      // the account/session revocation batch, but that early fence is still
      // reversible when deletion preflight fails. Therefore active+fenced may
      // block a request, but must never destructively purge room authority.
      // Only disabled/missing is terminal evidence for the self-purge below.
      const statement = db
        .prepare(
          `SELECT
             (SELECT status FROM ${ACCOUNT_TABLE}
               WHERE account_id = ?1 LIMIT 1) AS account_status,
             EXISTS(
               SELECT 1 FROM ${ACCOUNT_DELETION_TABLE}
                WHERE account_id = ?1
             ) AS deletion_pending`,
        )
        .bind(accountId);
      const row =
        typeof statement.first === 'function'
          ? await statement.first()
          : (await statement.all())?.results?.[0] || null;
      if (
        !row ||
        !hasExactKeys(row, ['account_status', 'deletion_pending']) ||
        (row.deletion_pending !== 0 && row.deletion_pending !== 1)
      ) {
        return 'unavailable';
      }
      if (row.account_status === 'active') {
        return row.deletion_pending === 1 ? 'deleting' : 'active';
      }
      if (row.account_status === 'disabled' || row.account_status === null) return 'deleted';
      return 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  async projectOwnerAccountDeletedSuspension(nowMs = Date.now()) {
    const db = this.env.MUSIXQUARE_ADMIN_DB || this.env.ADMIN_METRICS_DB || null;
    if (!db?.prepare) return false;
    try {
      const result = await db
        .prepare(
          `UPDATE mxqr_pro_room_registry
              SET status = 'suspended', suspension_reason = 'owner_account_deleted',
                  activation_state = 'active', updated_at = ?3
            WHERE room_code = ?1 AND room_generation = ?2
              AND status NOT IN ('decommissioning', 'decommissioned')`,
        )
        .bind(this.room.roomCode, this.room.roomGeneration, nowMs)
        .run();
      if (Number(result?.meta?.changes || 0) < 1) return false;
      // Keep this isolate's public front-door cache consistent with the D1
      // projection immediately. Other isolates re-read the same row on their
      // bounded registry refresh, while this DO remains the final authority.
      const cache = registryCacheFor(db);
      cache.registered.delete(this.room.roomCode);
      cache.suspended.set(this.room.roomCode, this.room.roomGeneration);
      // This is only a one-room projection, not a complete registry refresh.
      // Preserve the cache timestamp so an empty or stale cache cannot make
      // unrelated rooms look absent (or extend stale entries) for another TTL.
      return true;
    } catch {
      return false;
    }
  }

  async enforceOwnerAccountDeletionFence(nowMs = Date.now()) {
    if (
      (this.room.status !== 'active' && this.room.status !== 'suspended') ||
      !this.room.ownerAccountId
    ) {
      return null;
    }
    const deletionState = await this.currentOwnerAccountDeletionState();
    if (deletionState === 'active' || deletionState === 'not-linked') return null;
    if (deletionState === 'deleting' || deletionState === 'unavailable') {
      // Do not execute an owner/session/developer mutation while the only
      // service capable of proving that the linked account still exists is
      // unavailable. Anonymous legacy rooms have no ownerAccountId and do not
      // enter this branch. A reversible active+deletion-fence race also uses
      // this response without destroying room authority; after rollback, the
      // next request observes active+unfenced and proceeds normally.
      return errorResponse('ACCOUNT_AUTHORITY_UNAVAILABLE', 503);
    }

    const accountId = this.room.ownerAccountId;
    const purgeResponse = await this.withStateCapacityRollback(
      async () => {
        const result = this.purgeAccountAuthority(accountId, nowMs);
        if (!result?.ownerAuthorityRemoved) {
          return errorResponse('ACCOUNT_AUTHORITY_UNAVAILABLE', 503);
        }
        if (result.changed || this.accountIdentityMigrationPending) {
          if (result.authorityChanged) this.room.revision += 1;
          await this.persist();
          this.accountIdentityMigrationPending = false;
          if (result.authorityChanged) this.scheduleServerEvent(this.presenceEvent());
        }
        return null;
      },
      { rollbackStorageFailure: true },
    );
    if (purgeResponse) return purgeResponse;
    // Projection is best-effort here because the durable room has already
    // revoked every credential and is suspended. The account-deletion retry
    // job will finish Developer-key revocation, audit and the exact projection
    // ACK before an ownership transfer may reactivate the room.
    await this.projectOwnerAccountDeletedSuspension(nowMs);
    return errorResponse('ROOM_SUSPENDED', 423);
  }

  removeAccountAuthority(
    accountId,
    nowMs,
    { retainDeletionTombstone = true, suspensionReason = 'owner_account_deleted' } = {},
  ) {
    if (!ACCOUNT_ID_RE.test(accountId)) return null;
    const tombstoneChanged = retainDeletionTombstone
      ? this.retainAccountDeletionTombstone(accountId, nowMs)
      : false;
    const member = this.room.accountMembers?.[accountId] || null;
    const replayedOwnerRemoval =
      this.room.status === 'suspended' &&
      this.room.suspensionReason === suspensionReason &&
      this.room.ownerAuthorityRemoval?.accountId === accountId;
    const removingCurrentOwner = this.room.ownerAccountId === accountId || member?.role === 'owner';

    if (removingCurrentOwner) {
      const playbackRevisionSteps =
        this.room.playback.state === 'playing' && this.room.playback.updatedAtMs > 0 ? 2 : 1;
      if (
        this.room.authEpoch >= Number.MAX_SAFE_INTEGER ||
        this.room.ownerAuthorityEpoch >= Number.MAX_SAFE_INTEGER ||
        this.room.developerAuthorityEpoch >= Number.MAX_SAFE_INTEGER ||
        this.room.revision >= Number.MAX_SAFE_INTEGER ||
        this.room.presence.revision >= Number.MAX_SAFE_INTEGER ||
        this.room.presence.coordinatorEpoch >= Number.MAX_SAFE_INTEGER ||
        this.room.playback.revision > Number.MAX_SAFE_INTEGER - playbackRevisionSteps
      ) {
        throw new RoomStateCapacityError();
      }
      const removedSessions = Object.keys(this.room.sessions || {}).length;
      this.freezePlayback(nowMs);
      this.room.sessions = {};
      this.room.presence.participants = {};
      this.room.presence.coordinatorParticipantId = null;
      this.room.presence.revision += 1;
      this.room.accountMembers = {};
      this.room.anonymousAdministrators = {};
      this.room.pin = null;
      this.room.ownerCredentialHash = null;
      this.room.ownerAccountId = null;
      this.room.ownerDisplayName = null;
      this.room.pendingOwnershipTransfer = null;
      this.room.completedOwnershipTransfer = null;
      this.room.developerCommands = {};
      this.room.developerCommandIdempotency = {};
      this.room.authEpoch += 1;
      this.room.ownerAuthorityEpoch += 1;
      this.room.developerAuthorityEpoch += 1;
      this.room.runtime = 'sleeping';
      this.reconcileSystemAudio(nowMs);
      this.bumpRoomEpoch(nowMs);
      this.room.ownerAuthorityRemoval = {
        accountId,
        removalId: `removal_${randomToken(16)}`,
        removedAtMs: nowMs,
        ownerAuthorityEpoch: this.room.ownerAuthorityEpoch,
        fencedCoordinatorEpoch: this.room.presence.coordinatorEpoch,
        projectionAcked: false,
      };
      this.room.status = 'suspended';
      this.room.suspensionReason = suspensionReason;
      return {
        changed: true,
        authorityChanged: true,
        ownerAuthorityRemoved: true,
        removal: this.room.ownerAuthorityRemoval,
        removedSessions,
      };
    }

    let removedSessions = 0;
    for (const [tokenHash, session] of Object.entries(this.room.sessions || {})) {
      if (session.accountId !== accountId) continue;
      this.removePresence(session.participantId, nowMs);
      delete this.room.sessions[tokenHash];
      removedSessions += 1;
    }
    if (member) delete this.room.accountMembers[accountId];
    const authorityChanged = !!member || removedSessions > 0;
    return {
      changed: tombstoneChanged || authorityChanged,
      authorityChanged,
      ownerAuthorityRemoved: replayedOwnerRemoval,
      removal: replayedOwnerRemoval ? this.room.ownerAuthorityRemoval : null,
      removedSessions,
    };
  }

  purgeAccountAuthority(accountId, nowMs) {
    return this.removeAccountAuthority(accountId, nowMs);
  }

  ownerAuthorityDetachResponse(removal, { changed, removedSessions = 0 } = {}) {
    return jsonResponse({
      ok: true,
      roomCode: this.room.roomCode,
      roomGeneration: this.room.roomGeneration,
      status: this.room.status,
      suspensionReason: this.room.suspensionReason,
      previousOwnerAccountId: removal.accountId,
      expectedOwnerAuthorityEpoch: removal.ownerAuthorityEpoch - 1,
      ownerAuthorityEpoch: this.room.ownerAuthorityEpoch,
      ownerAuthorityRemoved: true,
      removalId: removal.removalId,
      removedOwnerAuthorityEpoch: removal.ownerAuthorityEpoch,
      fencedCoordinatorEpoch: removal.fencedCoordinatorEpoch,
      projectionAcked: removal.projectionAcked,
      changed: changed === true,
      removedSessions,
    });
  }

  async handleInternalOwnerAuthorityDetach(request) {
    const parsed = await this.parseBody(request, 1024);
    if (
      parsed.response ||
      !hasExactKeys(parsed.value, ['accountId', 'expectedOwnerAuthorityEpoch', 'roomGeneration']) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.room.roomGeneration ||
      !ACCOUNT_ID_RE.test(parsed.value.accountId || '') ||
      !isSafeNonNegativeInteger(parsed.value.expectedOwnerAuthorityEpoch) ||
      parsed.value.expectedOwnerAuthorityEpoch >= Number.MAX_SAFE_INTEGER
    ) {
      return parsed.response || errorResponse('INVALID_REQUEST', 400);
    }
    if (!this.room.provisioned) return errorResponse('PRO_ROOM_NOT_FOUND', 404);

    const expectedOwnerAuthorityEpoch = parsed.value.expectedOwnerAuthorityEpoch;
    const existingRemoval = this.room.ownerAuthorityRemoval;
    const replayedRemoval =
      this.room.status === 'suspended' &&
      this.room.suspensionReason === 'ownership_transfer_pending' &&
      this.room.ownerAccountId === null &&
      existingRemoval?.accountId === parsed.value.accountId &&
      existingRemoval.ownerAuthorityEpoch === expectedOwnerAuthorityEpoch + 1 &&
      this.room.ownerAuthorityEpoch === existingRemoval.ownerAuthorityEpoch;
    if (replayedRemoval) {
      return this.ownerAuthorityDetachResponse(existingRemoval, {
        changed: false,
        removedSessions: 0,
      });
    }

    const nowMs = Date.now();
    if (
      (this.room.pendingOwnershipTransfer?.expiresAtMs || 0) > nowMs ||
      (this.room.completedOwnershipTransfer?.replayUntilMs || 0) > nowMs
    ) {
      return errorResponse('OWNER_TRANSFER_RECONCILIATION_REQUIRED', 409);
    }
    if (
      !(
        this.room.status === 'active' ||
        (this.room.status === 'suspended' && this.room.suspensionReason === 'operator_suspended')
      ) ||
      this.room.ownerAccountId !== parsed.value.accountId ||
      !OPAQUE_ID_RE.test(this.room.ownerMemberId || '') ||
      existingRemoval !== null
    ) {
      return errorResponse('PRO_ROOM_OWNER_DETACH_UNAVAILABLE', 409);
    }
    if (this.room.ownerAuthorityEpoch !== expectedOwnerAuthorityEpoch) {
      return errorResponse('OWNER_AUTHORITY_EPOCH_MISMATCH', 409);
    }

    const result = this.removeAccountAuthority(parsed.value.accountId, nowMs, {
      retainDeletionTombstone: false,
      suspensionReason: 'ownership_transfer_pending',
    });
    if (!result?.ownerAuthorityRemoved || !result.removal) {
      return errorResponse('PRO_ROOM_OWNER_DETACH_UNAVAILABLE', 409);
    }
    if (result.changed || this.accountIdentityMigrationPending) {
      if (result.authorityChanged) this.room.revision += 1;
      await this.persist();
      this.accountIdentityMigrationPending = false;
      if (result.authorityChanged) this.scheduleServerEvent(this.presenceEvent());
    }
    return this.ownerAuthorityDetachResponse(result.removal, {
      changed: true,
      removedSessions: result.removedSessions,
    });
  }

  async handleInternalOwnerAuthorityDetachAck(request) {
    const parsed = await this.parseBody(request, 1024);
    if (
      parsed.response ||
      !hasExactKeys(parsed.value, [
        'accountId',
        'expectedOwnerAuthorityEpoch',
        'removalId',
        'removedOwnerAuthorityEpoch',
        'fencedCoordinatorEpoch',
        'roomGeneration',
      ]) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.room.roomGeneration ||
      !ACCOUNT_ID_RE.test(parsed.value.accountId || '') ||
      !isSafeNonNegativeInteger(parsed.value.expectedOwnerAuthorityEpoch) ||
      parsed.value.expectedOwnerAuthorityEpoch >= Number.MAX_SAFE_INTEGER ||
      !OWNER_AUTHORITY_REMOVAL_ID_RE.test(parsed.value.removalId || '') ||
      !isSafeNonNegativeInteger(parsed.value.removedOwnerAuthorityEpoch) ||
      !isSafeNonNegativeInteger(parsed.value.fencedCoordinatorEpoch)
    ) {
      return parsed.response || errorResponse('INVALID_REQUEST', 400);
    }
    const removal = this.room.ownerAuthorityRemoval;
    if (
      this.room.status !== 'suspended' ||
      this.room.suspensionReason !== 'ownership_transfer_pending' ||
      this.room.ownerAccountId !== null ||
      !removal ||
      removal.accountId !== parsed.value.accountId ||
      removal.removalId !== parsed.value.removalId ||
      removal.ownerAuthorityEpoch !== parsed.value.removedOwnerAuthorityEpoch ||
      removal.ownerAuthorityEpoch !== parsed.value.expectedOwnerAuthorityEpoch + 1 ||
      removal.fencedCoordinatorEpoch !== parsed.value.fencedCoordinatorEpoch ||
      this.room.ownerAuthorityEpoch !== removal.ownerAuthorityEpoch
    ) {
      return errorResponse('OWNER_AUTHORITY_REMOVAL_MISMATCH', 409);
    }
    const changed = removal.projectionAcked !== true;
    if (changed) {
      removal.projectionAcked = true;
      await this.persist();
    }
    return jsonResponse({
      ok: true,
      roomCode: this.room.roomCode,
      roomGeneration: this.room.roomGeneration,
      status: this.room.status,
      suspensionReason: this.room.suspensionReason,
      previousOwnerAccountId: removal.accountId,
      expectedOwnerAuthorityEpoch: parsed.value.expectedOwnerAuthorityEpoch,
      ownerAuthorityEpoch: this.room.ownerAuthorityEpoch,
      ownerAuthorityRemoved: true,
      removalId: removal.removalId,
      removedOwnerAuthorityEpoch: removal.ownerAuthorityEpoch,
      fencedCoordinatorEpoch: removal.fencedCoordinatorEpoch,
      projectionAcked: true,
      changed,
    });
  }

  async handleInternalAccountAuthorityPurge(request) {
    const parsed = await this.parseBody(request, 1024);
    if (
      parsed.response ||
      !hasExactKeys(parsed.value, ['accountId'], ['roomGeneration']) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.room.roomGeneration ||
      !ACCOUNT_ID_RE.test(parsed.value.accountId || '')
    ) {
      return parsed.response || errorResponse('INVALID_REQUEST', 400);
    }
    const result = this.purgeAccountAuthority(parsed.value.accountId, Date.now());
    if (result?.changed || this.accountIdentityMigrationPending) {
      if (result.authorityChanged) this.room.revision += 1;
      await this.persist();
      this.accountIdentityMigrationPending = false;
      if (result.authorityChanged) this.scheduleServerEvent(this.presenceEvent());
    }
    const removal = result?.ownerAuthorityRemoved ? result.removal : null;
    return jsonResponse({
      ok: true,
      roomCode: this.room.roomCode,
      roomGeneration: this.room.roomGeneration,
      status: this.room.status,
      suspensionReason: this.room.suspensionReason,
      ownerAuthorityRemoved: result?.ownerAuthorityRemoved === true,
      removalId: removal?.removalId || null,
      removedOwnerAuthorityEpoch: removal?.ownerAuthorityEpoch ?? null,
      fencedCoordinatorEpoch: removal?.fencedCoordinatorEpoch ?? null,
      projectionAcked: removal?.projectionAcked ?? true,
      removedSessions: result?.removedSessions || 0,
    });
  }

  async handleInternalAccountAuthorityClassify(request) {
    const parsed = await this.parseBody(request, 1024);
    if (
      parsed.response ||
      !hasExactKeys(parsed.value, ['accountId'], ['roomGeneration']) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.room.roomGeneration ||
      !ACCOUNT_ID_RE.test(parsed.value.accountId || '')
    ) {
      return parsed.response || errorResponse('INVALID_REQUEST', 400);
    }
    const ownerAuthority =
      this.room.ownerAccountId === parsed.value.accountId ||
      (this.room.status === 'suspended' &&
        this.room.suspensionReason === 'owner_account_deleted' &&
        this.room.ownerAuthorityRemoval?.accountId === parsed.value.accountId);
    return jsonResponse({
      ok: true,
      roomCode: this.room.roomCode,
      roomGeneration: this.room.roomGeneration,
      ownerAuthority,
    });
  }

  async handleInternalAccountAuthorityPurgeAck(request) {
    const parsed = await this.parseBody(request, 1024);
    if (
      parsed.response ||
      !hasExactKeys(
        parsed.value,
        ['accountId', 'removalId', 'removedOwnerAuthorityEpoch', 'fencedCoordinatorEpoch'],
        ['roomGeneration'],
      ) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.room.roomGeneration ||
      !ACCOUNT_ID_RE.test(parsed.value.accountId || '') ||
      !OWNER_AUTHORITY_REMOVAL_ID_RE.test(parsed.value.removalId || '') ||
      !isSafeNonNegativeInteger(parsed.value.removedOwnerAuthorityEpoch) ||
      !isSafeNonNegativeInteger(parsed.value.fencedCoordinatorEpoch)
    ) {
      return parsed.response || errorResponse('INVALID_REQUEST', 400);
    }
    const removal = this.room.ownerAuthorityRemoval;
    if (
      this.room.status !== 'suspended' ||
      this.room.suspensionReason !== 'owner_account_deleted' ||
      !removal ||
      removal.accountId !== parsed.value.accountId ||
      removal.removalId !== parsed.value.removalId ||
      removal.ownerAuthorityEpoch !== parsed.value.removedOwnerAuthorityEpoch ||
      removal.fencedCoordinatorEpoch !== parsed.value.fencedCoordinatorEpoch
    ) {
      return errorResponse('OWNER_AUTHORITY_REMOVAL_MISMATCH', 409);
    }
    const changed = removal.projectionAcked !== true;
    if (changed) {
      removal.projectionAcked = true;
      await this.persist();
    }
    return jsonResponse({
      ok: true,
      roomCode: this.room.roomCode,
      roomGeneration: this.room.roomGeneration,
      status: this.room.status,
      suspensionReason: this.room.suspensionReason,
      ownerAuthorityRemoved: true,
      removalId: removal.removalId,
      removedOwnerAuthorityEpoch: removal.ownerAuthorityEpoch,
      fencedCoordinatorEpoch: removal.fencedCoordinatorEpoch,
      projectionAcked: true,
      changed,
    });
  }

  async createSessionRecord(
    role,
    displayName,
    nowMs,
    memberId = null,
    accountMember = null,
    credentialContext = null,
  ) {
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
      this.removeSessionRecord(evictable[0]);
    }
    // Anonymous non-owner identities are always allocated by the server.
    // Account nicknames and the persisted owner identity remain authoritative
    // for their respective sessions.
    const peerOrdinal =
      role === 'owner'
        ? null
        : this.nextPhysicalDeviceOrdinal(accountMember?.displayNumber ?? null);
    if (role !== 'owner' && peerOrdinal === null) return null;
    const resolvedDisplayName =
      !accountMember && role !== 'owner' && peerOrdinal !== null
        ? `${DEFAULT_PEER_DISPLAY_NAME} ${peerOrdinal}`
        : displayName;
    const memberDisplayNumber =
      accountMember?.displayNumber ?? (role === 'owner' ? 0 : peerOrdinal);
    if (!Number.isSafeInteger(memberDisplayNumber)) return null;
    const highestAssignedNumber = Math.max(memberDisplayNumber, peerOrdinal || 0);
    if (highestAssignedNumber > 0) {
      this.room.nextMemberDisplayNumber = Math.min(
        SESSION_MAX_ITEMS + 1,
        Math.max(this.room.nextMemberDisplayNumber || 1, highestAssignedNumber + 1),
      );
    }
    const token = credentialContext
      ? await createDeterministicOpaqueCredential(secret, credentialContext)
      : await createOpaqueCredential(secret);
    const tokenHash = await sha256Base64Url(token);
    const session = {
      roomGeneration: this.room.roomGeneration,
      memberId:
        memberId || (role === 'owner' ? `owner_${randomToken(18)}` : `member_${randomToken(18)}`),
      participantId: `participant_${randomToken(18)}`,
      presenceIncarnationId: null,
      signalingTicketSequence: 0,
      displayName: resolvedDisplayName,
      ...(peerOrdinal === null ? {} : { peerOrdinal }),
      memberDisplayNumber,
      ...(accountMember ? { accountId: accountMember.accountId } : {}),
      ...(accountMember
        ? { accountLeaseExpiresAtMs: this.accountIdentityLeaseExpiresAt(nowMs) }
        : {}),
      role,
      authEpoch: this.room.authEpoch,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.sessionTtlSeconds() * 1000,
    };
    this.room.sessions[tokenHash] = session;
    return { token, tokenHash, session };
  }

  peerOrdinalAssignments() {
    const candidates = Object.entries(this.room.sessions)
      .filter(([, session]) => {
        return (
          isGeneratedPeerNamespaceDisplayName(session.displayName) ||
          (Number.isSafeInteger(session.peerOrdinal) &&
            session.peerOrdinal >= 1 &&
            session.peerOrdinal <= SESSION_MAX_ITEMS)
        );
      })
      .sort(
        ([leftHash, left], [rightHash, right]) =>
          left.createdAtMs - right.createdAtMs ||
          left.participantId.localeCompare(right.participantId) ||
          leftHash.localeCompare(rightHash),
      );
    const assigned = new Map();
    const used = new Set();

    // Preserve every valid durable assignment first. Exact legacy `Peer N`
    // labels are also treated as reservations so a rolling deploy cannot hand
    // the same visible identity to a new session.
    for (const [, session] of candidates) {
      const preferred =
        Number.isSafeInteger(session.peerOrdinal) &&
        session.peerOrdinal >= 1 &&
        session.peerOrdinal <= SESSION_MAX_ITEMS
          ? session.peerOrdinal
          : generatedPeerOrdinal(session.displayName);
      if (preferred === null || used.has(preferred)) continue;
      assigned.set(session, preferred);
      used.add(preferred);
    }

    // Old sessions only stored the generic `Peer` placeholder. Give those
    // sessions deterministic slots without making a browser the allocator.
    for (const [, session] of candidates) {
      if (assigned.has(session)) continue;
      let ordinal = 1;
      while (ordinal <= SESSION_MAX_ITEMS && used.has(ordinal)) ordinal += 1;
      if (ordinal > SESSION_MAX_ITEMS) continue;
      assigned.set(session, ordinal);
      used.add(ordinal);
    }
    return assigned;
  }

  nextPhysicalDeviceOrdinal(preferred = null) {
    const used = new Set(this.peerOrdinalAssignments().values());
    if (
      Number.isSafeInteger(preferred) &&
      preferred >= 1 &&
      preferred <= SESSION_MAX_ITEMS &&
      !used.has(preferred)
    ) {
      return preferred;
    }
    const reserved = this.usedMemberDisplayNumbers();
    for (let ordinal = 1; ordinal <= SESSION_MAX_ITEMS; ordinal += 1) {
      if (!used.has(ordinal) && !reserved.has(ordinal)) return ordinal;
    }
    return null;
  }

  ensureSessionPeerIdentity(session) {
    const participant = this.room.presence.participants[session.participantId];
    if (!participant) {
      return { ordinal: null, stateChanged: false, publicChanged: false };
    }
    if (session.role === 'owner') {
      return { ordinal: null, stateChanged: false, publicChanged: false };
    }

    const liveUsed = this.livePhysicalDeviceOrdinals(session);
    const preferred = session.peerOrdinal;
    const ordinal =
      Number.isSafeInteger(preferred) &&
      preferred >= 1 &&
      preferred <= SESSION_MAX_ITEMS &&
      !liveUsed.has(preferred)
        ? preferred
        : this.nextLivePhysicalDeviceOrdinal(session);
    if (ordinal === null) {
      return { ordinal: null, stateChanged: false, publicChanged: false };
    }

    let stateChanged = session.peerOrdinal !== ordinal;
    session.peerOrdinal = ordinal;
    const sameMember = Object.values(this.room.presence.participants || {}).find(
      (candidate) =>
        candidate.participantId !== session.participantId &&
        candidate.memberId === session.memberId,
    );
    const groupDisplayNumber =
      sameMember &&
      Number.isSafeInteger(sameMember.memberDisplayNumber) &&
      sameMember.memberDisplayNumber > 0
        ? sameMember.memberDisplayNumber
        : ordinal;
    if (session.memberDisplayNumber !== groupDisplayNumber) stateChanged = true;
    session.memberDisplayNumber = groupDisplayNumber;
    if (session.accountId) {
      const member = this.room.accountMembers?.[session.accountId];
      if (member && member.memberId === session.memberId) {
        if (member.displayNumber !== groupDisplayNumber) stateChanged = true;
        member.displayNumber = groupDisplayNumber;
      }
    } else {
      const administrator = this.room.anonymousAdministrators?.[session.memberId];
      if (administrator) {
        if (administrator.displayNumber !== groupDisplayNumber) stateChanged = true;
        administrator.displayNumber = groupDisplayNumber;
      }
    }
    const canonicalDisplayName = `${DEFAULT_PEER_DISPLAY_NAME} ${ordinal}`;
    if (!session.accountId) {
      if (session.displayName !== canonicalDisplayName) stateChanged = true;
      session.displayName = canonicalDisplayName;
      const administrator = this.room.anonymousAdministrators?.[session.memberId];
      if (administrator && administrator.displayName !== canonicalDisplayName) {
        administrator.displayName = canonicalDisplayName;
        stateChanged = true;
      }
    }

    const publicChanged =
      !!participant &&
      (participant.displayName !== session.displayName ||
        participant.memberDisplayNumber !== groupDisplayNumber);
    if (publicChanged) {
      participant.displayName = session.displayName;
      participant.memberDisplayNumber = groupDisplayNumber;
    }
    return { ordinal, stateChanged, publicChanged };
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
      session.authEpoch !== this.room.authEpoch ||
      session.roomGeneration !== this.room.roomGeneration
    ) {
      if (session) this.removeSessionRecord(tokenHash);
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
    const requiredCapabilities = Array.isArray(options.capabilities)
      ? options.capabilities
      : options.capability
        ? [options.capability]
        : [];
    if (
      requiredCapabilities.some(
        (capability) => !sessionCapabilities(this.room, auth.session).includes(capability),
      )
    ) {
      return { response: errorResponse('CAPABILITY_REQUIRED', 403) };
    }
    if (options.permission && !this.sessionHasPermission(auth.session, options.permission)) {
      return { response: errorResponse('PERMISSION_REQUIRED', 403) };
    }
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

  sessionHasPermission(session, permission) {
    if (!PRO_ROOM_PERMISSION_KEYS.includes(permission)) return false;
    if (session.role === 'owner') return true;
    return sessionPermissionSet(this.room, session)[permission] === true;
  }

  async handleGetEffects(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    if (request.body && (request.headers.get('content-length') || '') !== '0') {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const contractVersion = effectsContractVersion(request);
    return contractVersion === null
      ? errorResponse('INVALID_REQUEST', 400)
      : jsonResponse(publicEffects(this.room));
  }

  async handleUpdateEffects(request) {
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'playback.control',
    });
    if (auth.response) return auth.response;
    if (auth.session.role !== 'owner') {
      return errorResponse('OWNER_REQUIRED', 403);
    }
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (!hasExactKeys(parsed.value, ['coordinatorEpoch', 'baseRevision', 'effects'])) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const contractVersion = effectsContractVersion(request);
    const effects = contractVersion === 2 ? parseRoomEffects(parsed.value.effects) : null;
    if (
      !isSafeNonNegativeInteger(parsed.value.coordinatorEpoch) ||
      !isSafeNonNegativeInteger(parsed.value.baseRevision) ||
      !effects
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (this.room.presence.coordinatorEpoch !== parsed.value.coordinatorEpoch) {
      return errorResponse('ROOM_EPOCH_MISMATCH', 409);
    }
    if (parsed.value.baseRevision !== this.room.effects.revision) {
      return jsonResponse(
        {
          error: 'EFFECTS_REVISION_CONFLICT',
          effects: publicEffects(this.room),
        },
        409,
      );
    }
    if (JSON.stringify(effects) === JSON.stringify(this.room.effects.effects)) {
      return jsonResponse(publicEffects(this.room));
    }
    if (
      this.room.effects.revision >= Number.MAX_SAFE_INTEGER ||
      this.room.revision >= Number.MAX_SAFE_INTEGER
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }
    this.room.effects = {
      revision: this.room.effects.revision + 1,
      updatedAtMs: Date.now(),
      masterVolume: this.room.effects.masterVolume ?? 1,
      effects,
    };
    // room.revision is the heartbeat's aggregate change detector. Keep it in
    // the same persisted mutation as the dedicated effects revision so a peer
    // that misses the invalidation event cannot receive a false notModified.
    this.room.revision += 1;
    await this.persist();
    await this.broadcastServerEvent(
      this.invalidationEvent({ effectsRevision: this.room.effects.revision }),
    );
    return jsonResponse(publicEffects(this.room));
  }

  async handleGetSettingsSync(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    if (request.body && (request.headers.get('content-length') || '') !== '0') {
      return errorResponse('INVALID_REQUEST', 400);
    }
    return jsonResponse(publicSettingsSync(this.room));
  }

  async handleUpdateSettingsSync(request) {
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'effects.control',
    });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request);
    if (
      parsed.response ||
      !hasExactKeys(parsed.value, ['coordinatorEpoch', 'baseRevision', 'masterVolume', 'effects'])
    ) {
      return parsed.response || errorResponse('INVALID_REQUEST', 400);
    }
    const effects = parseRoomEffects(parsed.value.effects);
    if (
      !isSafeNonNegativeInteger(parsed.value.coordinatorEpoch) ||
      !isSafeNonNegativeInteger(parsed.value.baseRevision) ||
      typeof parsed.value.masterVolume !== 'number' ||
      !Number.isFinite(parsed.value.masterVolume) ||
      parsed.value.masterVolume < 0 ||
      parsed.value.masterVolume > 1 ||
      !effects
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    if (this.room.presence.coordinatorEpoch !== parsed.value.coordinatorEpoch) {
      return errorResponse('ROOM_EPOCH_MISMATCH', 409);
    }
    if (parsed.value.baseRevision !== this.room.effects.revision) {
      return jsonResponse(
        {
          error: 'SETTINGS_SYNC_REVISION_CONFLICT',
          settings: publicSettingsSync(this.room),
        },
        409,
      );
    }
    if (
      parsed.value.masterVolume === (this.room.effects.masterVolume ?? 1) &&
      JSON.stringify(effects) === JSON.stringify(this.room.effects.effects)
    ) {
      return jsonResponse(publicSettingsSync(this.room));
    }
    if (
      this.room.effects.revision >= Number.MAX_SAFE_INTEGER ||
      this.room.revision >= Number.MAX_SAFE_INTEGER
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }
    this.room.effects = {
      revision: this.room.effects.revision + 1,
      updatedAtMs: Date.now(),
      masterVolume: parsed.value.masterVolume,
      effects,
    };
    this.room.revision += 1;
    await this.persist();
    await this.broadcastServerEvent(
      this.invalidationEvent({ effectsRevision: this.room.effects.revision }),
    );
    return jsonResponse(publicSettingsSync(this.room));
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
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'queue.mutate',
    });
    if (auth.response) return auth.response;
    // Repeat and shuffle are queue policy, so they follow media management
    // rather than playback control. queue.mutate is server-projected only for
    // the owner or a controller with the stable `media.add` permission.
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
    if (this.room.presence.coordinatorEpoch !== parsed.value.coordinatorEpoch) {
      return errorResponse('ROOM_EPOCH_MISMATCH', 409);
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
    if (
      this.room.queueMode.revision >= Number.MAX_SAFE_INTEGER ||
      this.room.revision >= Number.MAX_SAFE_INTEGER
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }
    this.room.queueMode = {
      revision: this.room.queueMode.revision + 1,
      updatedAtMs: Date.now(),
      ...queueMode,
    };
    // See handleUpdateEffects(): queue-mode invalidation is best-effort, while
    // the aggregate room revision is the durable heartbeat recovery fence.
    this.room.revision += 1;
    await this.persist();
    await this.broadcastServerEvent(
      this.invalidationEvent({ queueModeRevision: this.room.queueMode.revision }),
    );
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
    // Live capture is deliberately outside the four delegated administrator
    // toggles, so the cost-bearing publisher lease stays with the room owner.
    if (auth.session.role !== 'owner') {
      return errorResponse('OWNER_REQUIRED', 403);
    }
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
    await this.broadcastServerEvent(
      this.invalidationEvent({ systemAudioGeneration: this.room.systemAudio.generation }),
    );
    return this.systemAudioResponse({ leaseId: this.room.systemAudio.leaseId });
  }

  async handleCommitSystemAudio(request) {
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'playback.control',
    });
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
    await this.broadcastServerEvent(
      this.invalidationEvent({ systemAudioGeneration: this.room.systemAudio.generation }),
    );
    return this.systemAudioResponse();
  }

  async handleHeartbeatSystemAudio(request) {
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'playback.control',
    });
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
    await this.broadcastServerEvent(
      this.invalidationEvent({ systemAudioGeneration: this.room.systemAudio.generation }),
    );
    return this.systemAudioResponse();
  }

  joinPresence(session, tokenHash, nowMs, devicePlatform = 'other') {
    const existing = this.room.presence.participants[session.participantId];
    if (existing) {
      existing.lastSeenAtMs = nowMs;
      existing.devicePlatform = devicePlatform;
      session.presenceIncarnationId = existing.presenceIncarnationId;
      return false;
    }
    if (Object.keys(this.room.presence.participants).length >= PRESENCE_MAX_ITEMS) return null;
    if (!this.assignSessionPresenceIdentity(session)) return null;
    const wasSleeping = this.room.runtime === 'sleeping';
    const presenceIncarnationId = `presence_${randomToken(18)}`;
    session.presenceIncarnationId = presenceIncarnationId;
    this.room.presence.participants[session.participantId] = {
      participantId: session.participantId,
      presenceIncarnationId,
      memberId: session.memberId,
      ...(session.accountId ? { accountId: session.accountId } : {}),
      ...(Number.isSafeInteger(session.memberDisplayNumber)
        ? { memberDisplayNumber: session.memberDisplayNumber }
        : {}),
      sessionHash: tokenHash,
      displayName: session.displayName,
      devicePlatform,
      role: session.role,
      joinedAtMs: nowMs,
      lastSeenAtMs: nowMs,
      developerControlVersion: 0,
    };
    this.room.runtime = 'awake';
    this.room.presence.revision += 1;
    this.room.presence.coordinatorParticipantId = null;
    if (wasSleeping) {
      this.bumpRoomEpoch(nowMs);
      if (this.room.playback.state === 'playing' && this.room.playback.queueItemId) {
        // Sleeping rooms retain the intent to resume but their timeline is
        // frozen. Anchor the old checkpoint at wake and rendezvous the first
        // participant from that exact position; never charge the time spent
        // asleep (or preparing) as audible playback.
        this.room.playback.updatedAtMs = nowMs;
        const mediaIdentity =
          this.room.playback.youtubeVideoId === null
            ? null
            : {
                youtubeVideoId: this.room.playback.youtubeVideoId,
                youtubeSubIndex: this.room.playback.youtubeSubIndex,
              };
        const target = this.targetPlayback(
          this.room.playback.queueItemId,
          'playing',
          this.room.playback.positionSeconds,
          nowMs,
          mediaIdentity,
        );
        if (target) {
          const wakeTransition = this.preparePlaybackTransition(target, nowMs, null, {
            resumeFromSleep: true,
            timingMode: 'scheduled-control',
          });
          if (wakeTransition.cancelEvent) this.scheduleServerEvent(wakeTransition.cancelEvent);
          if (wakeTransition.event) {
            this.scheduleServerEvent(wakeTransition.event, wakeTransition.targets);
          }
        }
      }
    }
    // A member arriving during an existing PREPARE receives it in the
    // signaling ticket and can arm locally, but the gate's cohort is immutable.
    // Only takeover rotates an existing cohort identity; leave can shrink it.
    this.reconcileSystemAudio(nowMs);
    this.room.revision += 1;
    this.scheduleServerEvent(this.presenceEvent());
    return true;
  }

  enterPresence(session, tokenHash, nowMs, takeover = false, devicePlatform = 'other') {
    const existing = this.room.presence.participants[session.participantId];
    if (!existing) {
      return this.joinPresence(session, tokenHash, nowMs, devicePlatform) === null
        ? 'room-full'
        : 'entered';
    }
    if (existing.sessionHash !== tokenHash) return 'identity-mismatch';

    // A room cookie is shared by every tab in the same browser profile. Do
    // not let an ordinary resume silently rotate the live tab's incarnation:
    // doing so repeatedly replaces the authenticated signaling socket and can
    // make control-channel recovery unstable. A takeover is therefore an
    // explicit, user-confirmed operation.
    if (!takeover) return 'active-elsewhere';

    // A resumed tab is a new presence incarnation even though its long-lived
    // HttpOnly session and participant identity are intentionally reused.
    // Rotating this nonce fences every request and WebSocket captured by the
    // prior tab without changing room-wide authority for every other peer.
    const previousPresenceIncarnationId = existing.presenceIncarnationId;
    const presenceIncarnationId = `presence_${randomToken(18)}`;
    session.presenceIncarnationId = presenceIncarnationId;
    existing.presenceIncarnationId = presenceIncarnationId;
    existing.developerControlVersion = 0;
    existing.joinedAtMs = nowMs;
    existing.lastSeenAtMs = nowMs;
    existing.devicePlatform = devicePlatform;
    const pending = this.room.pendingPlaybackTransition;
    if (pending?.cohort.includes(previousPresenceIncarnationId)) {
      pending.cohort = pending.cohort.map((candidate) =>
        candidate === previousPresenceIncarnationId ? presenceIncarnationId : candidate,
      );
      pending.cohort.sort();
      delete pending.ready[previousPresenceIncarnationId];
    }
    this.reconcileSystemAudio(nowMs);
    this.room.presence.revision += 1;
    this.room.revision += 1;
    this.scheduleServerEvent(this.presenceEvent());
    return 'entered';
  }

  bumpRoomEpoch(nowMs) {
    this.cancelPendingPlayback('room-epoch-changed', nowMs);
    // Signaling closes old-epoch sockets when the authoritative presence fence
    // advances. Neither their CANCEL nor any older playback event may cross the
    // new epoch.
    this.room.pendingPlaybackBroadcasts = [];
    this.room.presence.coordinatorEpoch += 1;
    this.room.playback.coordinatorEpoch = this.room.presence.coordinatorEpoch;
    this.room.playback.revision += 1;
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

  realtimePresenceTargets() {
    return Object.values(this.room.presence.participants)
      .map((participant) => participant.presenceIncarnationId)
      .filter((incarnationId) => OPAQUE_ID_RE.test(incarnationId || ''))
      .sort();
  }

  async broadcastServerEvent(
    event,
    targets = this.realtimePresenceTargets(),
    coordinatorEpoch = this.room.presence.coordinatorEpoch,
  ) {
    const namespace = this.env.PRO_SIGNALING_ROOMS;
    if (!namespace || typeof namespace.idFromName !== 'function') return false;
    try {
      const stub = namespace.get(
        namespace.idFromName(proRoomObjectName(this.room.roomCode, this.room.roomGeneration)),
      );
      const { response, bytes } = await fetchWithDeadline(
        (boundedRequest) => stub.fetch(boundedRequest),
        new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': this.room.roomCode,
            ...proRoomGenerationWireHeaders(this.room.roomGeneration),
          },
          body: JSON.stringify({
            roomCode: this.room.roomCode,
            ...proRoomGenerationWireFields(this.room.roomGeneration),
            coordinatorEpoch,
            targets,
            event,
          }),
        }),
        DEVELOPER_COMMAND_DISPATCH_TIMEOUT_MS,
      );
      return response.status === 200 && parseInternalJsonResponse(bytes) !== null;
    } catch {
      return false;
    }
  }

  playbackBroadcastRetryDelayMs(attempts) {
    return Math.min(
      PLAYBACK_BROADCAST_RETRY_MAX_MS,
      PLAYBACK_BROADCAST_RETRY_BASE_MS * 2 ** Math.min(attempts, 6),
    );
  }

  playbackBroadcastRecord(event, targets, nowMs = Date.now(), options = {}) {
    const normalizedTargets = [...new Set(targets || [])]
      .filter((target) => OPAQUE_ID_RE.test(target || ''))
      .sort();
    if (normalizedTargets.length === 0 || normalizedTargets.length > PRESENCE_MAX_ITEMS)
      return null;

    let kind;
    let coordinatorEpoch;
    let transitionId;
    let basePlaybackRevision;
    let playbackRevision;
    if (event?.type === 'pro-playback-prepare') {
      kind = 'prepare';
      coordinatorEpoch = event.target?.coordinatorEpoch;
      transitionId = event.transitionId;
      basePlaybackRevision = event.basePlaybackRevision;
      playbackRevision = event.target?.revision;
    } else if (event?.type === 'pro-playback-cancel') {
      kind = 'cancel';
      coordinatorEpoch = this.room.presence.coordinatorEpoch;
      transitionId = event.transitionId;
      basePlaybackRevision =
        options.basePlaybackRevision === undefined
          ? this.room.playback.revision
          : options.basePlaybackRevision;
      playbackRevision = basePlaybackRevision + 1;
    } else if (event?.type === 'pro-playback-commit') {
      kind = 'commit';
      coordinatorEpoch = event.playback?.coordinatorEpoch;
      transitionId = event.transitionId;
      playbackRevision = event.playback?.revision;
      basePlaybackRevision = playbackRevision - 1;
    } else {
      return null;
    }
    const candidate = {
      kind,
      coordinatorEpoch,
      transitionId,
      basePlaybackRevision,
      playbackRevision,
      targets: normalizedTargets,
      event: structuredClone(event),
      createdAtMs: nowMs,
      attempts: 0,
      retryAtMs: nowMs,
    };
    return normalizeStoredPlaybackBroadcastRecord(candidate, this.room);
  }

  enqueuePlaybackBroadcast(
    event,
    targets = this.realtimePresenceTargets(),
    nowMs = Date.now(),
    options = {},
  ) {
    const record = this.playbackBroadcastRecord(event, targets, nowMs, options);
    if (!record) return false;
    const current = (this.room.pendingPlaybackBroadcasts || []).filter(
      (candidate) => candidate.coordinatorEpoch === record.coordinatorEpoch,
    );
    if (record.kind === 'commit') {
      const matchingCancel = [...current]
        .reverse()
        .find(
          (candidate) =>
            candidate.kind === 'cancel' &&
            candidate.basePlaybackRevision === record.basePlaybackRevision &&
            candidate.playbackRevision === record.playbackRevision,
        );
      // Preserve the product's existing immediate cancellation feedback before
      // a superseding direct COMMIT. The pair remains bounded and idempotent.
      this.room.pendingPlaybackBroadcasts = matchingCancel ? [matchingCancel, record] : [record];
      return true;
    }
    const baseCommit = [...current]
      .reverse()
      .find(
        (candidate) =>
          candidate.kind === 'commit' && candidate.playbackRevision === record.basePlaybackRevision,
      );
    const matchingCancel = [...current]
      .reverse()
      .find(
        (candidate) =>
          candidate.kind === 'cancel' &&
          candidate.basePlaybackRevision === record.basePlaybackRevision &&
          candidate.playbackRevision === record.playbackRevision,
      );
    this.room.pendingPlaybackBroadcasts = baseCommit
      ? [baseCommit, record]
      : record.kind === 'prepare' && matchingCancel
        ? [matchingCancel, record]
        : [record];
    return true;
  }

  enqueuePlaybackOutcome(outcome, nowMs = Date.now()) {
    if (!outcome) return false;
    let changed = false;
    if (outcome.cancelEvent) {
      const successorBasePlaybackRevision =
        outcome.event?.type === 'pro-playback-prepare'
          ? outcome.event.basePlaybackRevision
          : outcome.event?.type === 'pro-playback-commit'
            ? outcome.event.playback.revision - 1
            : undefined;
      changed = this.enqueuePlaybackBroadcast(
        outcome.cancelEvent,
        this.realtimePresenceTargets(),
        nowMs,
        { basePlaybackRevision: successorBasePlaybackRevision },
      );
    }
    if (outcome.event) {
      changed =
        this.enqueuePlaybackBroadcast(
          outcome.event,
          outcome.targets || this.realtimePresenceTargets(),
          nowMs,
        ) || changed;
    }
    return changed;
  }

  async dispatchPlaybackBroadcast(record) {
    const namespace = this.env.PRO_SIGNALING_ROOMS;
    if (!namespace || typeof namespace.idFromName !== 'function') return false;
    try {
      const stub = namespace.get(
        namespace.idFromName(proRoomObjectName(this.room.roomCode, this.room.roomGeneration)),
      );
      const { response, bytes } = await fetchWithDeadline(
        (boundedRequest) => stub.fetch(boundedRequest),
        new Request('https://signaling.internal/internal/realtime/v1/broadcast', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': this.room.roomCode,
            ...proRoomGenerationWireHeaders(this.room.roomGeneration),
          },
          body: JSON.stringify({
            roomCode: this.room.roomCode,
            ...proRoomGenerationWireFields(this.room.roomGeneration),
            coordinatorEpoch: record.coordinatorEpoch,
            targets: record.targets,
            event: record.event,
          }),
        }),
        DEVELOPER_COMMAND_DISPATCH_TIMEOUT_MS,
      );
      if (response.status !== 200) return false;
      const body = parseInternalJsonResponse(bytes);
      return !!(
        hasExactKeys(body, ['broadcast', 'eligible', 'sent']) &&
        body.broadcast === true &&
        isSafeNonNegativeInteger(body.eligible) &&
        isSafeNonNegativeInteger(body.sent) &&
        body.sent <= body.eligible &&
        body.sent === body.eligible
      );
    } catch {
      return false;
    }
  }

  async flushPendingPlaybackBroadcasts(nowMs = Date.now()) {
    while (this.room?.pendingPlaybackBroadcasts?.length > 0) {
      const record = this.room.pendingPlaybackBroadcasts[0];
      if (record.coordinatorEpoch !== this.room.presence.coordinatorEpoch) {
        const previous = structuredClone(this.room.pendingPlaybackBroadcasts);
        this.room.pendingPlaybackBroadcasts.shift();
        try {
          await this.persist({
            flushPlaybackOutbox: false,
          });
        } catch {
          this.room.pendingPlaybackBroadcasts = previous;
          await this.maintainAlarm();
          return false;
        }
        continue;
      }
      if (record.retryAtMs > nowMs) return false;

      const previous = structuredClone(this.room.pendingPlaybackBroadcasts);
      const delivered = await this.dispatchPlaybackBroadcast(record);
      if (delivered) {
        this.room.pendingPlaybackBroadcasts.shift();
      } else {
        const attempts = Math.min(PLAYBACK_BROADCAST_RETRY_MAX_ATTEMPTS, record.attempts + 1);
        record.attempts = attempts;
        record.retryAtMs = nowMs + this.playbackBroadcastRetryDelayMs(record.attempts - 1);
      }
      try {
        await this.persist({
          flushPlaybackOutbox: false,
        });
      } catch {
        // The previous durable record is still authoritative. Restore the same
        // in-memory queue and let its already-maintained alarm redeliver it.
        this.room.pendingPlaybackBroadcasts = previous;
        await this.maintainAlarm();
        return false;
      }
      if (!delivered) return false;
      nowMs = Date.now();
    }
    return true;
  }

  presenceBroadcastRetryDelayMs(attempts) {
    return Math.min(
      PRESENCE_BROADCAST_RETRY_MAX_MS,
      PRESENCE_BROADCAST_RETRY_BASE_MS * 2 ** Math.min(attempts, 6),
    );
  }

  comparePresenceBroadcastRevision(left, right) {
    if (left.coordinatorEpoch !== right.coordinatorEpoch) {
      return left.coordinatorEpoch - right.coordinatorEpoch;
    }
    return left.presenceRevision - right.presenceRevision;
  }

  currentPresenceBroadcastRecord(nowMs, attempts = 0) {
    return {
      coordinatorEpoch: this.room.presence.coordinatorEpoch,
      presenceRevision: this.room.presence.revision,
      roomRevision: this.room.revision,
      retryAtMs: nowMs + this.presenceBroadcastRetryDelayMs(attempts),
      attempts,
    };
  }

  async rememberFailedPresenceBroadcast(event, coordinatorEpoch) {
    if ((await readServiceMaintenance(this.env)).enabled) return;
    await this.withMutation(async () => {
      if ((await readServiceMaintenance(this.env)).enabled) return;
      if (!this.room || event?.type !== 'pro-presence-snapshot') return;
      const deliveredRevision = {
        coordinatorEpoch,
        presenceRevision: event.presenceRevision,
      };
      const currentRevision = {
        coordinatorEpoch: this.room.presence.coordinatorEpoch,
        presenceRevision: this.room.presence.revision,
      };
      // A later full snapshot supersedes this failed attempt. Its own delivery
      // path is responsible for installing a retry marker if it also fails.
      if (this.comparePresenceBroadcastRevision(deliveredRevision, currentRevision) !== 0) return;

      const existing = this.room.pendingPresenceBroadcast;
      const attempts =
        existing && this.comparePresenceBroadcastRevision(existing, currentRevision) === 0
          ? existing.attempts
          : 0;
      const next = this.currentPresenceBroadcastRecord(Date.now(), attempts);
      if (existing && this.comparePresenceBroadcastRevision(existing, next) > 0) return;
      if (existing && this.comparePresenceBroadcastRevision(existing, next) === 0) {
        next.retryAtMs = Math.min(existing.retryAtMs, next.retryAtMs);
      }
      this.room.pendingPresenceBroadcast = next;
      // The retry marker and its alarm must survive isolate eviction. It is an
      // internal delivery concern, so avoid rewriting the legacy shadow.
      await this.persist({ retainEarlierAlarm: true });
    });
  }

  async clearDeliveredPresenceBroadcast(event, coordinatorEpoch) {
    if ((await readServiceMaintenance(this.env)).enabled) return;
    await this.withMutation(async () => {
      if ((await readServiceMaintenance(this.env)).enabled) return;
      const pending = this.room?.pendingPresenceBroadcast;
      if (!pending || event?.type !== 'pro-presence-snapshot') return;
      const deliveredRevision = {
        coordinatorEpoch,
        presenceRevision: event.presenceRevision,
      };
      if (this.comparePresenceBroadcastRevision(deliveredRevision, pending) < 0) return;
      this.room.pendingPresenceBroadcast = null;
      await this.persist({ retainEarlierAlarm: true });
    });
  }

  async deliverPresenceBroadcast(event, targets, coordinatorEpoch) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await this.broadcastServerEvent(event, targets, coordinatorEpoch)) {
        await this.clearDeliveredPresenceBroadcast(event, coordinatorEpoch);
        return true;
      }
    }
    await this.rememberFailedPresenceBroadcast(event, coordinatorEpoch);
    return false;
  }

  async retryPendingPresenceBroadcast(nowMs) {
    const pending = this.room.pendingPresenceBroadcast;
    if (!pending || pending.retryAtMs > nowMs) return false;

    const currentRevision = {
      coordinatorEpoch: this.room.presence.coordinatorEpoch,
      presenceRevision: this.room.presence.revision,
    };
    const attempts =
      this.comparePresenceBroadcastRevision(pending, currentRevision) === 0 ? pending.attempts : 0;
    const delivered = await this.broadcastServerEvent(
      this.presenceEvent(),
      this.realtimePresenceTargets(),
      currentRevision.coordinatorEpoch,
    );
    if (delivered) {
      this.room.pendingPresenceBroadcast = null;
    } else {
      const nextAttempts = Math.min(PRESENCE_BROADCAST_RETRY_MAX_ATTEMPTS, attempts + 1);
      this.room.pendingPresenceBroadcast = this.currentPresenceBroadcastRecord(nowMs, nextAttempts);
    }
    await this.persist();
    return delivered;
  }

  scheduleServerEvent(event, targets = this.realtimePresenceTargets()) {
    if (
      event?.type === 'pro-playback-prepare' ||
      event?.type === 'pro-playback-cancel' ||
      event?.type === 'pro-playback-commit'
    ) {
      // Playback events must be included in the caller's next canonical room
      // persist. Never start cross-Worker delivery from this pre-persist seam.
      return Promise.resolve(this.enqueuePlaybackBroadcast(event, targets));
    }
    const coordinatorEpoch = this.room.presence.coordinatorEpoch;
    const hasSignalingNamespace =
      this.env.PRO_SIGNALING_ROOMS && typeof this.env.PRO_SIGNALING_ROOMS.idFromName === 'function';
    const delivery =
      event?.type === 'pro-presence-snapshot' && hasSignalingNamespace
        ? this.deliverPresenceBroadcast(event, targets, coordinatorEpoch)
        : this.broadcastServerEvent(event, targets, coordinatorEpoch);
    if (typeof this.state.waitUntil === 'function') this.state.waitUntil(delivery);
    return delivery;
  }

  presenceEvent() {
    return {
      type: 'pro-presence-snapshot',
      presenceRevision: this.room.presence.revision,
      roomRevision: this.room.revision,
    };
  }

  invalidationEvent(extra = {}) {
    return {
      type: 'pro-room-invalidated',
      roomRevision: this.room.revision,
      ...extra,
    };
  }

  playbackCommitEvent(transitionId, executeAtMs, nowMs) {
    return {
      type: 'pro-playback-commit',
      transitionId,
      serverTimeMs: nowMs,
      executeAtMs,
      playback: structuredClone(this.room.playback),
    };
  }

  playbackPrepareEvent(pending, nowMs = Date.now()) {
    return {
      type: 'pro-playback-prepare',
      transitionId: pending.transitionId,
      serverTimeMs: nowMs,
      deadlineAtMs: pending.deadlineAtMs,
      basePlaybackRevision: pending.basePlaybackRevision,
      target: structuredClone(pending.target),
    };
  }

  cancelPendingPlayback(reason, nowMs = Date.now()) {
    const pending = this.room.pendingPlaybackTransition;
    if (!pending) return null;
    this.room.pendingPlaybackTransition = null;
    if (pending.developerCommandId) {
      const record = this.room.developerCommands[pending.developerCommandId];
      if (record && (record.status === 'pending' || record.status === 'dispatched')) {
        this.completeDeveloperCommand(record, 'rejected', 'busy', nowMs);
      }
    }
    return {
      type: 'pro-playback-cancel',
      transitionId: pending.transitionId,
      serverTimeMs: nowMs,
      reason,
    };
  }

  targetPlayback(queueItemId, state, positionSeconds, nowMs, mediaIdentity = null) {
    if (this.room.playback.revision >= Number.MAX_SAFE_INTEGER) return null;
    if (queueItemId === null) {
      return {
        coordinatorEpoch: this.room.presence.coordinatorEpoch,
        revision: this.room.playback.revision + 1,
        state: 'idle',
        queueItemId: null,
        positionSeconds: 0,
        updatedAtMs: nowMs,
        youtubeVideoId: null,
        youtubeSubIndex: null,
      };
    }
    const item = this.room.playlist.find((candidate) => candidate.queueItemId === queueItemId);
    if (!item || (state !== 'playing' && state !== 'paused')) return null;
    const boundedPosition = Math.min(PLAYBACK_MAX_POSITION_SECONDS, Math.max(0, positionSeconds));
    if (item.source.kind === 'youtube') {
      let youtubeVideoId;
      let youtubeSubIndex;
      if (item.source.videoIds !== undefined) {
        youtubeSubIndex =
          mediaIdentity?.youtubeSubIndex ?? item.source.videoIds.indexOf(item.source.videoId);
        if (
          !isSafeNonNegativeInteger(youtubeSubIndex) ||
          youtubeSubIndex >= item.source.videoIds.length
        ) {
          return null;
        }
        youtubeVideoId = item.source.videoIds[youtubeSubIndex];
        // Once a manifest exists, the client-reported video ID is an assertion,
        // never authority. The immutable server list derives the actual target.
        if (
          mediaIdentity?.youtubeVideoId !== undefined &&
          mediaIdentity.youtubeVideoId !== youtubeVideoId
        ) {
          return null;
        }
      } else if (item.source.playlistId === undefined) {
        youtubeVideoId = item.source.videoId;
        youtubeSubIndex = 0;
        if (
          mediaIdentity !== null &&
          (mediaIdentity.youtubeVideoId !== youtubeVideoId ||
            mediaIdentity.youtubeSubIndex !== youtubeSubIndex)
        ) {
          return null;
        }
      } else {
        // Legacy playlist rows have no canonical ordered manifest. Preserve
        // explicit select/resume compatibility, but never invent traversal.
        youtubeVideoId = mediaIdentity?.youtubeVideoId || item.source.videoId;
        youtubeSubIndex = mediaIdentity?.youtubeSubIndex ?? 0;
      }
      if (
        !YOUTUBE_VIDEO_ID_RE.test(youtubeVideoId || '') ||
        !isSafeNonNegativeInteger(youtubeSubIndex) ||
        youtubeSubIndex > 100_000
      ) {
        return null;
      }
      return {
        coordinatorEpoch: this.room.presence.coordinatorEpoch,
        revision: this.room.playback.revision + 1,
        state,
        queueItemId,
        positionSeconds: boundedPosition,
        updatedAtMs: nowMs,
        youtubeVideoId,
        youtubeSubIndex,
      };
    }
    if (
      mediaIdentity?.youtubeVideoId !== undefined ||
      mediaIdentity?.youtubeSubIndex !== undefined
    ) {
      return null;
    }
    return {
      coordinatorEpoch: this.room.presence.coordinatorEpoch,
      revision: this.room.playback.revision + 1,
      state,
      queueItemId,
      positionSeconds: boundedPosition,
      updatedAtMs: nowMs,
      youtubeVideoId: null,
      youtubeSubIndex: null,
    };
  }

  directPlaybackCommit(target, nowMs, developerCommandId = null) {
    const cancelEvent = this.cancelPendingPlayback('superseded', nowMs);
    const executeAtMs = nowMs + PLAYBACK_COMMIT_LEAD_MS;
    target.updatedAtMs = executeAtMs;
    this.room.currentQueueItemId = target.queueItemId;
    this.room.playback = target;
    this.room.pendingPlaybackTransition = null;
    this.room.revision += 1;
    if (developerCommandId) {
      const record = this.room.developerCommands[developerCommandId];
      if (record) this.completeDeveloperCommand(record, 'applied', 'applied', nowMs);
    }
    return {
      status: 'committed',
      cancelEvent,
      event: this.playbackCommitEvent(null, executeAtMs, nowMs),
    };
  }

  preparePlaybackTransition(target, nowMs, developerCommandId = null, options = {}) {
    const timingMode = options.timingMode === 'zero-start' ? 'zero-start' : 'scheduled-control';
    const existing = this.room.pendingPlaybackTransition;
    if (
      existing &&
      existing.coordinatorEpoch === this.room.presence.coordinatorEpoch &&
      existing.basePlaybackRevision === this.room.playback.revision &&
      (existing.resumeFromSleep !== true &&
      existing.deadlineAtMs - existing.createdAtMs === PLAYBACK_ZERO_START_TRANSITION_DEADLINE_MS
        ? 'zero-start'
        : 'scheduled-control') === timingMode &&
      playbackSemanticallyEqual(existing.target, target)
    ) {
      // Several devices commonly report the same YouTube ENDED observation.
      // Coalesce those observations instead of repeatedly cancelling the same
      // three-second rendezvous and postponing the canonical transition.
      if (developerCommandId) {
        return { error: 'PLAYBACK_TRANSITION_PENDING', status: 409 };
      }
      return {
        status: 'preparing',
        transitionId: existing.transitionId,
        targets: [],
        event: null,
      };
    }
    const cancelEvent = this.cancelPendingPlayback('superseded', nowMs);
    const cohort = this.realtimePresenceTargets();
    if (cohort.length === 0) {
      const committed = this.directPlaybackCommit(target, nowMs, developerCommandId);
      return { ...committed, cancelEvent: cancelEvent || committed.cancelEvent };
    }
    const transitionId = `transition_${randomToken(16)}`;
    const deadlineAtMs =
      nowMs +
      (timingMode === 'zero-start'
        ? PLAYBACK_ZERO_START_TRANSITION_DEADLINE_MS
        : PLAYBACK_TRANSITION_DEADLINE_MS);
    const pending = {
      transitionId,
      coordinatorEpoch: this.room.presence.coordinatorEpoch,
      basePlaybackRevision: this.room.playback.revision,
      createdAtMs: nowMs,
      deadlineAtMs,
      target,
      cohort,
      ready: {},
      developerCommandId,
      ...(options.resumeFromSleep === true ? { resumeFromSleep: true } : {}),
    };
    this.room.pendingPlaybackTransition = pending;
    return {
      status: 'preparing',
      transitionId,
      cancelEvent,
      targets: cohort,
      event: this.playbackPrepareEvent(pending, nowMs),
    };
  }

  commitPendingPlaybackTransition(nowMs = Date.now()) {
    const pending = this.room.pendingPlaybackTransition;
    if (!pending) return null;
    if (
      pending.coordinatorEpoch !== this.room.presence.coordinatorEpoch ||
      pending.basePlaybackRevision !== this.room.playback.revision
    ) {
      return { cancelEvent: this.cancelPendingPlayback('stale', nowMs), event: null };
    }
    const executeAtMs =
      nowMs +
      (pending.resumeFromSleep !== true &&
      pending.deadlineAtMs - pending.createdAtMs === PLAYBACK_ZERO_START_TRANSITION_DEADLINE_MS
        ? PLAYBACK_ZERO_START_COMMIT_LEAD_MS
        : PLAYBACK_COMMIT_LEAD_MS);
    pending.target.updatedAtMs = executeAtMs;
    this.room.currentQueueItemId = pending.target.queueItemId;
    this.room.playback = pending.target;
    this.room.pendingPlaybackTransition = null;
    this.room.revision += 1;
    if (pending.developerCommandId) {
      const record = this.room.developerCommands[pending.developerCommandId];
      if (record) this.completeDeveloperCommand(record, 'applied', 'applied', nowMs);
    }
    return {
      cancelEvent: null,
      event: this.playbackCommitEvent(pending.transitionId, executeAtMs, nowMs),
    };
  }

  applyPlaybackAuthorityCommand(command, nowMs = Date.now(), developerCommandId = null) {
    if (command.baseRevision !== this.room.playback.revision) {
      return { error: 'PLAYBACK_REVISION_CONFLICT', status: 409 };
    }
    const playback = this.room.playback;
    const currentIdentity =
      playback.youtubeVideoId === null
        ? null
        : {
            youtubeVideoId: playback.youtubeVideoId,
            youtubeSubIndex: playback.youtubeSubIndex,
          };
    const wakeTransition = this.room.pendingPlaybackTransition?.resumeFromSleep === true;
    const playbackClockRunning = this.room.runtime === 'awake' && !wakeTransition;
    const currentPosition = playbackClockRunning
      ? playbackPositionAt(playback, nowMs)
      : wakeTransition
        ? this.room.pendingPlaybackTransition.target.positionSeconds
        : playback.positionSeconds;
    let target;
    let requiresPrepare = false;
    let timingMode = 'scheduled-control';

    if (command.type === 'play') {
      if (playback.state === 'playing') return { status: 'unchanged', event: null };
      const queueItemId =
        playback.queueItemId ||
        this.room.currentQueueItemId ||
        this.room.playlist[0]?.queueItemId ||
        null;
      if (!queueItemId) return { error: 'NO_MEDIA', status: 409 };
      target = this.targetPlayback(
        queueItemId,
        'playing',
        playback.queueItemId === queueItemId ? playback.positionSeconds : 0,
        nowMs,
        playback.queueItemId === queueItemId ? currentIdentity : null,
      );
      // Resuming is a synchronized start, even when every participant already
      // has the same item resident. A direct COMMIT lets a cold/late endpoint
      // start behind the rest of the room.
      requiresPrepare = true;
      timingMode = playback.state === 'idle' ? 'zero-start' : 'scheduled-control';
    } else if (command.type === 'pause') {
      if (playback.state === 'idle') return { error: 'NO_MEDIA', status: 409 };
      if (playback.state === 'paused') return { status: 'unchanged', event: null };
      target = this.targetPlayback(
        playback.queueItemId,
        'paused',
        currentPosition + (playbackClockRunning ? PLAYBACK_COMMIT_LEAD_MS / 1_000 : 0),
        nowMs,
        currentIdentity,
      );
    } else if (command.type === 'stop') {
      if (playback.state === 'idle') return { status: 'unchanged', event: null };
      if (playback.state === 'paused' && playback.positionSeconds === 0) {
        return { status: 'unchanged', event: null };
      }
      target = this.targetPlayback(playback.queueItemId, 'paused', 0, nowMs, currentIdentity);
    } else if (command.type === 'seek') {
      if (playback.state === 'idle') return { error: 'NO_MEDIA', status: 409 };
      target = this.targetPlayback(
        playback.queueItemId,
        playback.state,
        command.positionSeconds,
        nowMs,
        currentIdentity,
      );
      requiresPrepare = playback.state === 'playing';
      timingMode = 'scheduled-control';
    } else {
      let queueItemId = null;
      let state = 'playing';
      let positionSeconds = 0;
      let mediaIdentity = null;
      const currentItem = playback.queueItemId
        ? this.room.playlist.find((candidate) => candidate.queueItemId === playback.queueItemId)
        : null;
      const currentPlaylistSource =
        currentItem?.source.kind === 'youtube' && currentItem.source.playlistId !== undefined
          ? currentItem.source
          : null;
      const currentManifestIdentity = () => {
        if (!currentPlaylistSource) return null;
        if (currentPlaylistSource.videoIds === undefined) {
          return { error: 'PLAYLIST_MANIFEST_REQUIRED', status: 409 };
        }
        const index = playback.youtubeSubIndex;
        if (
          !isSafeNonNegativeInteger(index) ||
          index >= currentPlaylistSource.videoIds.length ||
          currentPlaylistSource.videoIds[index] !== playback.youtubeVideoId
        ) {
          return { error: 'INVALID_PLAYBACK_TARGET', status: 400 };
        }
        return {
          index,
          videoIds: currentPlaylistSource.videoIds,
          mediaIdentity: {
            youtubeVideoId: currentPlaylistSource.videoIds[index],
            youtubeSubIndex: index,
          },
        };
      };
      const nextWithinCurrentPlaylist = () => {
        const manifest = currentManifestIdentity();
        if (!manifest || manifest.error) return manifest;
        const nextIndex = manifest.index + 1;
        return nextIndex < manifest.videoIds.length
          ? {
              queueItemId: playback.queueItemId,
              mediaIdentity: {
                youtubeVideoId: manifest.videoIds[nextIndex],
                youtubeSubIndex: nextIndex,
              },
            }
          : null;
      };
      if (command.type === 'select') {
        queueItemId = command.queueItemId;
        state = command.state;
        positionSeconds = command.positionSeconds;
        mediaIdentity =
          command.youtubeVideoId === undefined
            ? null
            : {
                youtubeVideoId: command.youtubeVideoId,
                youtubeSubIndex: command.youtubeSubIndex,
              };
      } else if (command.type === 'previous') {
        if (currentPlaylistSource) {
          const manifest = currentManifestIdentity();
          if (manifest?.error) return manifest;
          if (manifest.index > 0) {
            queueItemId = playback.queueItemId;
            const previousIndex = manifest.index - 1;
            mediaIdentity = {
              youtubeVideoId: manifest.videoIds[previousIndex],
              youtubeSubIndex: previousIndex,
            };
          } else {
            queueItemId = adjacentQueueItemId(this.room, 'previous');
          }
        } else {
          queueItemId = adjacentQueueItemId(this.room, 'previous');
        }
      } else if (command.type === 'ended' || command.type === 'unavailable') {
        if (command.queueItemId !== playback.queueItemId) {
          return { error: 'PLAYBACK_OBSERVATION_STALE', status: 409 };
        }
        const observedMediaKind = currentItem?.source.kind === 'youtube' ? 'youtube' : 'file';
        if (!currentItem || command.mediaKind !== observedMediaKind) {
          return { error: 'PLAYBACK_OBSERVATION_STALE', status: 409 };
        }
        if (
          command.youtubeVideoId !== undefined &&
          (command.youtubeVideoId !== playback.youtubeVideoId ||
            command.youtubeSubIndex !== playback.youtubeSubIndex)
        ) {
          return { error: 'PLAYBACK_OBSERVATION_STALE', status: 409 };
        }
        if (
          command.mediaKind === 'youtube' &&
          (command.youtubeVideoId === undefined || command.youtubeSubIndex === undefined)
        ) {
          return { error: 'PLAYBACK_OBSERVATION_STALE', status: 409 };
        }
        if (
          command.mediaKind === 'file' &&
          (command.youtubeVideoId !== undefined || command.youtubeSubIndex !== undefined)
        ) {
          return { error: 'PLAYBACK_OBSERVATION_STALE', status: 409 };
        }
        if (command.type === 'ended') {
          if (playback.state !== 'playing' || !playbackClockRunning) {
            return { error: 'PLAYBACK_OBSERVATION_STALE', status: 409 };
          }
          if (command.durationSeconds !== null) {
            const nearEndTolerance = Math.min(
              PLAYBACK_ENDED_NEAR_END_TOLERANCE_SECONDS,
              Math.max(0.25, command.durationSeconds * 0.01),
            );
            const nearEndThreshold = Math.max(0, command.durationSeconds - nearEndTolerance);
            if (
              command.observedPositionSeconds < nearEndThreshold ||
              currentPosition < nearEndThreshold
            ) {
              return { error: 'PLAYBACK_OBSERVATION_NOT_AT_END', status: 409 };
            }
          } else {
            // Live/unknown-duration YouTube media can still emit a legitimate
            // ENDED event. Accept it only after the canonical revision has
            // actually been playing and while the observer remains close to
            // the server clock; this avoids both a blanket rejection and an
            // immediate/spurious auto-advance.
            const playingForMs = nowMs - playback.updatedAtMs;
            if (
              playingForMs < PLAYBACK_UNKNOWN_DURATION_MIN_PLAYING_MS ||
              Math.abs(command.observedPositionSeconds - currentPosition) >
                PLAYBACK_UNKNOWN_DURATION_POSITION_TOLERANCE_SECONDS
            ) {
              return { error: 'PLAYBACK_OBSERVATION_NOT_AT_END', status: 409 };
            }
          }
        }
        if (command.type === 'ended' && this.room.queueMode.repeatMode === 2) {
          queueItemId = playback.queueItemId;
          mediaIdentity = currentIdentity;
        } else if (currentPlaylistSource) {
          const internal = nextWithinCurrentPlaylist();
          if (internal?.error) return internal;
          if (internal) {
            queueItemId = internal.queueItemId;
            mediaIdentity = internal.mediaIdentity;
          } else {
            queueItemId = adjacentQueueItemId(this.room, 'next');
          }
        } else {
          queueItemId = adjacentQueueItemId(this.room, 'next');
        }
      } else {
        if (currentPlaylistSource) {
          const internal = nextWithinCurrentPlaylist();
          if (internal?.error) return internal;
          if (internal) {
            queueItemId = internal.queueItemId;
            mediaIdentity = internal.mediaIdentity;
          } else {
            queueItemId = adjacentQueueItemId(this.room, 'next');
          }
        } else {
          queueItemId = adjacentQueueItemId(this.room, 'next');
        }
      }
      target = this.targetPlayback(
        queueItemId,
        queueItemId ? state : 'idle',
        positionSeconds,
        nowMs,
        mediaIdentity,
      );
      requiresPrepare = queueItemId !== null;
      timingMode = 'zero-start';
    }

    if (!target) return { error: 'INVALID_PLAYBACK_TARGET', status: 400 };
    return requiresPrepare
      ? this.preparePlaybackTransition(target, nowMs, developerCommandId, { timingMode })
      : this.directPlaybackCommit(target, nowMs, developerCommandId);
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
    if ((await readServiceMaintenance(this.env)).enabled) return { ok: false, deletedAny: false };
    const bucket = this.env.PRO_MEDIA_BUCKET;
    if (!bucket || typeof bucket.list !== 'function' || typeof bucket.delete !== 'function') {
      return { ok: false, deletedAny: false };
    }
    const prefix = `${proRoomMediaPrefix(this.room.roomCode, this.room.roomGeneration)}/`;
    let deletedAny = false;
    try {
      // Re-read the first page after every batch. Deleting while following an
      // old cursor can skip keys when the listing contracts underneath it.
      for (let round = 0; round < 32; round += 1) {
        if ((await readServiceMaintenance(this.env)).enabled) {
          return { ok: false, deletedAny };
        }
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
    if ((await readServiceMaintenance(this.env)).enabled) return false;
    const namespace = this.env.PRO_SIGNALING_ROOMS;
    if (!namespace || typeof namespace.idFromName !== 'function') return false;
    try {
      const stub = namespace.get(
        namespace.idFromName(proRoomObjectName(this.room.roomCode, this.room.roomGeneration)),
      );
      const { response, bytes } = await fetchWithDeadline(
        (boundedRequest) => stub.fetch(boundedRequest),
        new Request('https://signaling.internal/internal/admin/v1/decommission', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': this.room.roomCode,
            ...proRoomGenerationWireHeaders(this.room.roomGeneration),
          },
          body: JSON.stringify({
            roomCode: this.room.roomCode,
            ...proRoomGenerationWireFields(this.room.roomGeneration),
            requestId,
          }),
        }),
        INTERNAL_SERVICE_RESPONSE_TIMEOUT_MS,
      );
      const payload = parseInternalJsonResponse(bytes);
      return (
        response.ok &&
        payload?.ok === true &&
        payload.roomCode === this.room.roomCode &&
        responseRoomGenerationMatches(payload, this.room.roomGeneration) &&
        payload.status === 'decommissioned'
      );
    } catch {
      return false;
    }
  }

  async deleteDeveloperRoomData(requestId, nowMs = Date.now()) {
    if ((await readServiceMaintenance(this.env)).enabled) return false;
    const db = this.env.DEVELOPER_API_DB;
    if (!db?.prepare) return false;
    try {
      // Generation-scoped authorization fences allow a public room number to
      // be reused without ever reviving credentials from this incarnation.
      await db
        .prepare(
          `INSERT INTO mxqr_developer_api_room_generation_tombstones
            (room_code, room_generation, request_id, decommissioned_at)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(room_code, room_generation) DO UPDATE SET
             request_id = excluded.request_id,
             decommissioned_at = MIN(
               mxqr_developer_api_room_generation_tombstones.decommissioned_at,
               excluded.decommissioned_at
             )`,
        )
        .bind(this.room.roomCode, this.room.roomGeneration, requestId, nowMs)
        .run();
      for (const table of [
        'mxqr_developer_api_keys',
        'mxqr_developer_api_audit',
        'mxqr_developer_api_admin_audit',
        'mxqr_developer_api_room_authority_fences',
      ]) {
        await db
          .prepare(
            `DELETE FROM ${table}
             WHERE room_code = ?1 AND room_generation = ?2`,
          )
          .bind(this.room.roomCode, this.room.roomGeneration)
          .run();
      }
      const remainingFence = await db
        .prepare(
          `SELECT 1 AS present
             FROM mxqr_developer_api_room_authority_fences
            WHERE room_code = ?1 AND room_generation = ?2
            LIMIT 1`,
        )
        .bind(this.room.roomCode, this.room.roomGeneration)
        .all();
      if ((remainingFence?.results || []).length > 0) return false;
      return true;
    } catch {
      return false;
    }
  }

  async clearDeveloperRoomLimiter(requestId) {
    if ((await readServiceMaintenance(this.env)).enabled) return false;
    const namespace = this.env.DEVELOPER_API_LIMITERS;
    if (!namespace || typeof namespace.idFromName !== 'function') return false;
    try {
      const limiterName = `room:${proRoomObjectName(this.room.roomCode, this.room.roomGeneration)}`;
      const stub = namespace.get(namespace.idFromName(limiterName));
      const { response, bytes } = await fetchWithDeadline(
        (boundedRequest) => stub.fetch(boundedRequest),
        new Request('https://developer-api.internal/internal/admin/v1/decommission', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': this.room.roomCode,
            ...proRoomGenerationWireHeaders(this.room.roomGeneration),
          },
          body: JSON.stringify({
            roomCode: this.room.roomCode,
            ...proRoomGenerationWireFields(this.room.roomGeneration),
            requestId,
          }),
        }),
        INTERNAL_SERVICE_RESPONSE_TIMEOUT_MS,
      );
      const payload = parseInternalJsonResponse(bytes);
      return (
        response.ok &&
        payload?.ok === true &&
        payload.roomCode === this.room.roomCode &&
        responseRoomGenerationMatches(payload, this.room.roomGeneration)
      );
    } catch {
      return false;
    }
  }

  async markRegistryDecommissioned(nowMs) {
    if ((await readServiceMaintenance(this.env)).enabled) return false;
    const db = this.env.MUSIXQUARE_ADMIN_DB || this.env.ADMIN_METRICS_DB || null;
    if (!db?.prepare) return false;
    try {
      await db
        .prepare(
          `INSERT OR IGNORE INTO mxqr_pro_room_generation_history
            (room_code, room_generation, status, decommissioned_at, request_id)
           VALUES (?1, ?2, 'decommissioned', ?3, ?4)`,
        )
        .bind(
          this.room.roomCode,
          this.room.roomGeneration,
          nowMs,
          this.room.decommission?.requestId || null,
        )
        .run();
      await db
        .prepare(
          `UPDATE mxqr_pro_room_registry
           SET label = 'Decommissioned PRO room',
               status = 'decommissioned',
               activation_state = 'unactivated',
               updated_at = ?3
           WHERE room_code = ?1 AND room_generation = ?2`,
        )
        .bind(this.room.roomCode, this.room.roomGeneration, nowMs)
        .run();
      const statement = db
        .prepare(
          `SELECT status, room_generation FROM mxqr_pro_room_registry
           WHERE room_code = ?1 LIMIT 1`,
        )
        .bind(this.room.roomCode);
      const row =
        typeof statement.first === 'function'
          ? await statement.first()
          : (await statement.all())?.results?.[0] || null;
      const currentGeneration = Number(row?.room_generation);
      return (
        (currentGeneration === this.room.roomGeneration && row?.status === 'decommissioned') ||
        (isProRoomGeneration(currentGeneration) && currentGeneration > this.room.roomGeneration)
      );
    } catch {
      return false;
    }
  }

  async retireAccountReverseEdge() {
    if ((await readServiceMaintenance(this.env)).enabled) return false;
    const db = this.env.MUSIXQUARE_AUTH_DB;
    // Decommission admission requires this production binding. Keep the guard
    // here as a fail-closed defense for rolling or malformed deployments.
    if (!db?.prepare) return false;
    const roomCode = this.room.roomCode;
    const roomGeneration = this.room.roomGeneration;
    try {
      await db
        .prepare(
          `DELETE FROM mxqr_account_pro_room_generations
            WHERE room_code = ?1 AND room_generation = ?2`,
        )
        .bind(roomCode, roomGeneration)
        .run();
      return true;
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
    // Marking the registry first closes new account-link preflights. The
    // idempotent exact-edge deletion then drains every request that passed its
    // preflight just before the status transition.
    const accountReverseEdge = await this.retireAccountReverseEdge();
    const repaired =
      media.ok && signaling && developerData && developerLimiter && accountReverseEdge && registry;
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
    if (!(await this.retireAccountReverseEdge())) {
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
      !hasExactKeys(parsed.value, ['roomCode', 'roomGeneration', 'requestId']) ||
      parsed.value.roomCode !== this.room.roomCode ||
      exactInternalRoomGeneration(request, parsed.value) !== this.room.roomGeneration ||
      !ADMIN_REQUEST_ID_RE.test(parsed.value.requestId)
    ) {
      return errorResponse(parsed.error || 'INVALID_REQUEST', parsed.status || 400);
    }
    if (this.room.status === 'decommissioned') {
      return jsonResponse({
        ok: true,
        roomCode: this.room.roomCode,
        roomGeneration: this.room.roomGeneration,
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
          roomGeneration: this.room.roomGeneration,
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
      !(this.env.MUSIXQUARE_ADMIN_DB || this.env.ADMIN_METRICS_DB)?.prepare ||
      !this.env.MUSIXQUARE_AUTH_DB?.prepare
    ) {
      return errorResponse('PRO_ROOM_DECOMMISSION_NOT_CONFIGURED', 503);
    }

    const nowMs = Date.now();
    const purgeAfterMs = this.decommissionPurgeAfterMs(nowMs);
    const previousActivationGeneration = Number.isSafeInteger(this.room.activationClaimGeneration)
      ? this.room.activationClaimGeneration
      : 0;
    const previousAuthEpoch = Number.isSafeInteger(this.room.authEpoch) ? this.room.authEpoch : 0;
    const tombstone = initialRoomState(this.room.roomCode, false, this.room.roomGeneration);
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
    // The first tombstone commit is the irreversible admission fence. If that
    // atomic storage transaction fails, no external cleanup has started yet;
    // restore the exact active in-memory state so a following request cannot
    // continue a decommission job that durable storage never recorded.
    const checkpoint = this.captureInMemoryState();
    this.room = tombstone;
    try {
      await this.persist();
    } catch (error) {
      if (error instanceof RoomStateStorageCommitError) {
        this.restoreInMemoryState(checkpoint);
      }
      throw error;
    }
    await this.continueDecommission(nowMs);
    return jsonResponse(
      {
        ok: true,
        roomCode: this.room.roomCode,
        roomGeneration: this.room.roomGeneration,
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
      roomGeneration: this.room.roomGeneration,
      status: this.room.status,
      suspensionReason: this.room.suspensionReason,
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
      this.room.ownerAuthorityEpoch >= Number.MAX_SAFE_INTEGER ||
      this.room.revision >= Number.MAX_SAFE_INTEGER ||
      this.room.presence.revision >= Number.MAX_SAFE_INTEGER ||
      this.room.presence.coordinatorEpoch >= Number.MAX_SAFE_INTEGER ||
      this.room.playback.revision > Number.MAX_SAFE_INTEGER - playbackRevisionSteps
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }

    const nowMs = Date.now();
    this.freezePlayback(nowMs);

    // Suspension is an authorization and control-incarnation fence, not data deletion.
    // Playlist, media assets, PIN, and the owner recovery credential remain in
    // the room while every transient browser/session identity is discarded.
    this.discardTransientMemberAuthority();
    this.room.sessions = {};
    this.room.presence.participants = {};
    this.room.presence.coordinatorParticipantId = null;
    this.room.presence.revision += 1;
    this.room.authEpoch += 1;
    this.room.ownerAuthorityEpoch += 1;
    this.room.runtime = 'sleeping';
    this.reconcileSystemAudio(nowMs);
    this.bumpRoomEpoch(nowMs);
    this.room.status = 'suspended';
    this.room.suspensionReason = 'operator_suspended';
    this.room.revision += 1;
    await this.persist();
    this.scheduleServerEvent(this.presenceEvent(), []);
    return this.internalAdminStateResponse(true);
  }

  async handleInternalResume() {
    if (!this.room.provisioned) return errorResponse('ROOM_NOT_FOUND', 404);
    if (this.room.status === 'active') return this.internalAdminStateResponse(false);
    if (this.room.status !== 'suspended') return errorResponse('ROOM_NOT_SUSPENDED', 409);
    if (this.room.suspensionReason !== 'operator_suspended') {
      return errorResponse('ROOM_OWNER_TRANSFER_REQUIRED', 409);
    }
    if (!this.room.pin) return errorResponse('ROOM_OWNER_TRANSFER_REQUIRED', 409);
    if (this.room.revision >= Number.MAX_SAFE_INTEGER) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }

    // A resumed room is available for fresh PIN authentication only. No old
    // presence, cookie session, control channel, or system-audio lease is revived.
    this.discardTransientMemberAuthority();
    this.room.sessions = {};
    this.room.presence.participants = {};
    this.room.presence.coordinatorParticipantId = null;
    this.room.runtime = 'sleeping';
    this.reconcileSystemAudio(Date.now());
    this.room.status = 'active';
    this.room.suspensionReason = null;
    this.room.revision += 1;
    await this.persist();
    return this.internalAdminStateResponse(true);
  }

  removePresence(participantId, nowMs) {
    const departed = this.room.presence.participants[participantId];
    if (!departed) return false;
    const departedIncarnationId = departed.presenceIncarnationId;
    delete this.room.presence.participants[participantId];
    this.reclaimLiveAccountRepresentativeOrdinal(departed);
    if (
      !departed.accountId &&
      this.room.anonymousAdministrators?.[departed.memberId] &&
      !Object.values(this.room.presence.participants).some(
        (participant) => participant.memberId === departed.memberId,
      )
    ) {
      // Anonymous delegation is presence-scoped. Session cookies deliberately
      // outlive a backgrounded tab for resume, but they must not keep an
      // offline administrator visible (or privileged) after the member's last
      // authoritative presence expires/leaves. Authenticated grants remain in
      // accountMembers and are intentionally unaffected.
      this.removeAnonymousAdministrator(departed.memberId);
    }
    this.reconcileSystemAudio(nowMs);
    const remaining = Object.values(this.room.presence.participants).sort(
      (left, right) =>
        left.joinedAtMs - right.joinedAtMs || left.participantId.localeCompare(right.participantId),
    );
    this.room.presence.revision += 1;
    if (remaining.length === 0) {
      if (this.room.pendingPlaybackTransition?.resumeFromSleep === true) {
        this.room.playback.positionSeconds =
          this.room.pendingPlaybackTransition.target.positionSeconds;
        this.room.playback.updatedAtMs = nowMs;
      } else {
        this.freezePlayback(nowMs);
      }
      this.room.runtime = 'sleeping';
      this.room.presence.coordinatorParticipantId = null;
      this.bumpRoomEpoch(nowMs);
    } else {
      this.room.presence.coordinatorParticipantId = null;
      const pending = this.room.pendingPlaybackTransition;
      if (pending?.cohort.includes(departedIncarnationId)) {
        pending.cohort = pending.cohort.filter((value) => value !== departedIncarnationId);
        delete pending.ready[departedIncarnationId];
        if (playbackTransitionCohortIsTerminal(pending)) {
          const committed = this.commitPendingPlaybackTransition(nowMs);
          if (committed?.event) this.scheduleServerEvent(committed.event);
          if (committed?.cancelEvent) this.scheduleServerEvent(committed.cancelEvent);
        }
      }
    }
    this.room.revision += 1;
    this.scheduleServerEvent(this.presenceEvent());
    return true;
  }

  async ownerTransferPrepareResponse(record, replayed) {
    const secret = String(this.env.PRO_ROOM_ACTIVATION_SECRET || '');
    const commitProof = await ownerTransferCommitProof(this.room, record, secret);
    if (!constantTimeEqual(await sha256Base64Url(commitProof), record.commitProofHash)) {
      return errorResponse('OWNER_TRANSFER_STATE_INVALID', 409);
    }
    return jsonResponse(
      {
        ok: true,
        roomCode: this.room.roomCode,
        roomGeneration: this.room.roomGeneration,
        status: this.room.status,
        suspensionReason: this.room.suspensionReason,
        transferId: record.transferId,
        claimGeneration: record.claimGeneration ?? null,
        commitProof,
        requestId: record.requestId,
        targetAccountId: record.targetAccountId,
        // The App Worker consumes this field for exact reverse-edge cleanup
        // and must remove it before returning the public facade response.
        previousOwnerAccountId: record.previousOwnerAccountId,
        preparedAtMs: record.preparedAtMs,
        expiresAtMs: record.expiresAtMs,
        committedAtMs: record.committedAtMs || null,
        replayUntilMs: record.replayUntilMs || record.expiresAtMs,
        replayed,
      },
      200,
      { 'cache-control': 'no-store, max-age=0' },
    );
  }

  async restoreCompletedOwnerTransferReplayAuthority(record, account, request, nowMs) {
    const session = this.room.sessions[record.sessionTokenHash] || null;
    if (
      this.room.status !== 'active' ||
      this.room.suspensionReason !== null ||
      this.room.ownerAccountId !== record.targetAccountId ||
      this.room.ownerMemberId !== record.preservedOwnerMemberId ||
      this.room.authEpoch !== record.authEpoch ||
      this.room.ownerAuthorityEpoch !== record.ownerAuthorityEpoch ||
      !constantTimeEqual(this.room.ownerCredentialHash || '', record.ownerCredentialHash) ||
      !session ||
      session.roomGeneration !== this.room.roomGeneration ||
      session.authEpoch !== this.room.authEpoch
    ) {
      return errorResponse('OWNER_TRANSFER_COMMIT_SUPERSEDED', 409);
    }
    const participant = this.room.presence.participants[session.participantId] || null;
    const authorityCurrent =
      session.role === 'owner' &&
      session.accountId === record.targetAccountId &&
      Number.isSafeInteger(session.accountLeaseExpiresAtMs) &&
      session.accountLeaseExpiresAtMs > nowMs;
    const presenceCurrent =
      participant &&
      participant.sessionHash === record.sessionTokenHash &&
      participant.presenceIncarnationId === session.presenceIncarnationId &&
      participant.memberId === record.preservedOwnerMemberId &&
      participant.accountId === record.targetAccountId &&
      participant.role === 'owner';
    if (authorityCurrent && presenceCurrent) return null;
    if (
      this.room.revision >= Number.MAX_SAFE_INTEGER ||
      this.room.presence.revision >= Number.MAX_SAFE_INTEGER ||
      this.room.presence.coordinatorEpoch >= Number.MAX_SAFE_INTEGER ||
      this.room.playback.revision >= Number.MAX_SAFE_INTEGER
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }
    if (participant && participant.sessionHash !== record.sessionTokenHash) {
      return errorResponse('OWNER_TRANSFER_COMMIT_SUPERSEDED', 409);
    }
    if (!participant && Object.keys(this.room.presence.participants).length >= PRESENCE_MAX_ITEMS) {
      return errorResponse('ROOM_FULL', 409);
    }
    const accountMember = this.prepareOwnerAccountMember(account, nowMs);
    if (!accountMember) return errorResponse('ACCOUNT_MEMBER_CAPACITY_EXCEEDED', 409);
    session.accountId = record.targetAccountId;
    session.accountLeaseExpiresAtMs = this.accountIdentityLeaseExpiresAt(nowMs);
    session.memberId = record.preservedOwnerMemberId;
    session.memberDisplayNumber = 0;
    session.displayName = account.nickname;
    session.role = 'owner';
    this.commitOwnerAccountMember(accountMember);
    if (participant) {
      participant.lastSeenAtMs = nowMs;
      participant.devicePlatform = devicePlatformFromRequest(request);
      this.room.presence.revision += 1;
      this.room.revision += 1;
      this.reconcileSystemAudio(nowMs);
      this.scheduleServerEvent(this.presenceEvent());
    } else {
      session.presenceIncarnationId = null;
      if (
        this.joinPresence(
          session,
          record.sessionTokenHash,
          nowMs,
          devicePlatformFromRequest(request),
        ) === null
      ) {
        throw new RoomStateCapacityError();
      }
    }
    await this.persist();
    return null;
  }

  async handleOwnerTransferPrepare(request) {
    const parsed = await this.parseBody(request);
    if (
      parsed.response ||
      !hasExactKeys(parsed.value, ['claimToken', 'newPin', 'requestId']) ||
      typeof parsed.value.claimToken !== 'string' ||
      !PIN_RE.test(parsed.value.newPin || '') ||
      !OWNER_TRANSFER_REQUEST_ID_RE.test(parsed.value.requestId || '')
    ) {
      return parsed.response || errorResponse('INVALID_REQUEST', 400);
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
    const rateError = await this.applyRateLimit(request, 'owner-transfer', 10, 60 * 60 * 1000);
    if (rateError) return rateError;
    const nowMs = Date.now();
    const inspected = await inspectOwnerTransferClaim(
      parsed.value.claimToken,
      this.room.roomCode,
      activationSecret,
      nowMs,
    );
    if (!inspected.claim) return errorResponse(inspected.error, 401);
    const claim = inspected.claim;
    if (claim.roomGeneration !== this.room.roomGeneration) {
      return errorResponse('OWNER_TRANSFER_CLAIM_INVALID', 401);
    }
    if (this.room.ownerAuthorityRemoval?.projectionAcked === false) {
      return errorResponse('OWNER_AUTHORITY_PROJECTION_PENDING', 409);
    }
    const nonceHash = await sha256Base64Url(`owner-transfer:${claim.nonce}`);
    const pending = this.room.pendingOwnershipTransfer;
    const completed = this.room.completedOwnershipTransfer;
    const matchingRecord =
      pending?.claimNonceHash === nonceHash
        ? pending
        : completed?.claimNonceHash === nonceHash
          ? completed
          : null;
    const consumedClaim = this.room.consumedOwnershipTransferClaims[nonceHash] || null;
    if (consumedClaim && consumedClaim.requestId !== parsed.value.requestId) {
      return errorResponse('OWNER_TRANSFER_CLAIM_USED', 409);
    }
    if (matchingRecord && matchingRecord.requestId !== parsed.value.requestId) {
      return errorResponse('OWNER_TRANSFER_CLAIM_USED', 409);
    }

    // A completed exact transaction owns a separate short replay receipt.
    // This is the sole exception to claim expiry: it lets the App finish D1
    // reconciliation and return the already-committed deterministic cookies
    // after response loss near the claim deadline. No different request,
    // account, PIN, epoch, session, or nonce can enter this branch.
    if (completed && matchingRecord === completed) {
      if (completed.replayUntilMs <= nowMs) {
        return errorResponse('OWNER_TRANSFER_CLAIM_EXPIRED', 410);
      }
      const asserted = await this.accountAssertion(request);
      if (asserted.response) return asserted.response;
      if (!asserted.account) return errorResponse('ACCOUNT_SESSION_REQUIRED', 401);
      if (claim.targetAccountId !== asserted.account.accountId) {
        return errorResponse('OWNER_TRANSFER_TARGET_ACCOUNT_MISMATCH', 409);
      }
      if (
        matchingRecord.targetAccountId !== asserted.account.accountId ||
        matchingRecord.claimNonceHash !== nonceHash
      ) {
        return errorResponse('OWNER_TRANSFER_CLAIM_USED', 409);
      }
      if (!(await verifyPin(parsed.value.newPin, this.room.pin, pepper))) {
        return errorResponse('OWNER_TRANSFER_REPLAY_MISMATCH', 409);
      }
      const restoreError = await this.restoreCompletedOwnerTransferReplayAuthority(
        completed,
        asserted.account,
        request,
        nowMs,
      );
      if (restoreError) return restoreError;
      return this.ownerTransferPrepareResponse(matchingRecord, true);
    }

    // Every non-completed claim keeps one canonical terminal expiry result,
    // before target-account or stale-generation classification.
    if (inspected.expired) return errorResponse('OWNER_TRANSFER_CLAIM_EXPIRED', 410);
    const asserted = await this.accountAssertion(request);
    if (asserted.response) return asserted.response;
    if (!asserted.account) return errorResponse('ACCOUNT_SESSION_REQUIRED', 401);
    if (claim.targetAccountId !== asserted.account.accountId) {
      return errorResponse('OWNER_TRANSFER_TARGET_ACCOUNT_MISMATCH', 409);
    }
    if (matchingRecord) {
      if (
        matchingRecord.targetAccountId !== asserted.account.accountId ||
        matchingRecord.claimNonceHash !== nonceHash
      ) {
        return errorResponse('OWNER_TRANSFER_CLAIM_USED', 409);
      }
      if (!(await verifyPin(parsed.value.newPin, pending.pin, pepper))) {
        return errorResponse('OWNER_TRANSFER_REPLAY_MISMATCH', 409);
      }
      return this.ownerTransferPrepareResponse(matchingRecord, true);
    }
    if (this.room.status === 'active' && this.room.ownerAccountId === asserted.account.accountId) {
      return errorResponse('OWNER_TRANSFER_TARGET_UNCHANGED', 409);
    }
    if (consumedClaim) return errorResponse('OWNER_TRANSFER_CLAIM_USED', 409);

    if (
      claim.claimGeneration !== this.room.ownershipTransferClaimGeneration ||
      claim.ownerAuthorityEpoch !== this.room.ownerAuthorityEpoch
    ) {
      return errorResponse('OWNER_TRANSFER_CLAIM_STALE', 409);
    }
    if (
      this.room.status !== 'active' &&
      !(
        this.room.status === 'suspended' &&
        (this.room.suspensionReason === 'operator_suspended' ||
          this.room.suspensionReason === 'owner_account_deleted' ||
          this.room.suspensionReason === 'ownership_transfer_pending')
      )
    ) {
      return errorResponse('OWNER_TRANSFER_UNAVAILABLE', 409);
    }
    if (this.room.pin && (await verifyPin(parsed.value.newPin, this.room.pin, pepper))) {
      return errorResponse('OWNER_TRANSFER_PIN_REUSE', 409);
    }
    if (
      Object.keys(this.room.consumedOwnershipTransferClaims).length >=
      OWNER_TRANSFER_NONCE_MAX_ITEMS
    ) {
      return errorResponse('OWNER_TRANSFER_CLAIM_CAPACITY_EXCEEDED', 409);
    }
    const playbackRevisionSteps =
      this.room.playback.state === 'playing' && this.room.playback.updatedAtMs > 0 ? 2 : 1;
    if (
      this.room.authEpoch >= Number.MAX_SAFE_INTEGER ||
      this.room.ownerAuthorityEpoch >= Number.MAX_SAFE_INTEGER ||
      this.room.developerAuthorityEpoch >= Number.MAX_SAFE_INTEGER ||
      this.room.revision >= Number.MAX_SAFE_INTEGER ||
      this.room.presence.revision >= Number.MAX_SAFE_INTEGER ||
      this.room.presence.coordinatorEpoch >= Number.MAX_SAFE_INTEGER ||
      this.room.playback.revision > Number.MAX_SAFE_INTEGER - playbackRevisionSteps
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }

    if (!OPAQUE_ID_RE.test(this.room.ownerMemberId || '')) {
      return errorResponse('OWNER_TRANSFER_OWNER_IDENTITY_INVALID', 409);
    }
    const nextPin = await createPinRecord(parsed.value.newPin, pepper);
    if (
      !(await reserveProRoomOwnershipTransferEntitlement(this.env, {
        targetAccountId: asserted.account.accountId,
        roomCode: this.room.roomCode,
        roomGeneration: this.room.roomGeneration,
        requestId: parsed.value.requestId,
        nowMs,
      }))
    ) {
      return errorResponse('ACCOUNT_PRO_ROOM_LIMIT_REACHED', 409);
    }
    const previousOwnerAccountId =
      this.room.pendingOwnershipTransfer?.previousOwnerAccountId ||
      this.room.ownerAccountId ||
      null;
    this.freezePlayback(nowMs);
    this.room.sessions = {};
    this.room.presence.participants = {};
    this.room.presence.coordinatorParticipantId = null;
    this.room.presence.revision += 1;
    this.room.accountMembers = {};
    this.room.anonymousAdministrators = {};
    this.room.pin = null;
    this.room.ownerCredentialHash = null;
    this.room.ownerAccountId = null;
    this.room.ownerDisplayName = null;
    this.room.developerCommands = {};
    this.room.developerCommandIdempotency = {};
    this.room.authEpoch += 1;
    this.room.ownerAuthorityEpoch += 1;
    this.room.developerAuthorityEpoch += 1;
    this.room.runtime = 'sleeping';
    this.reconcileSystemAudio(nowMs);
    this.bumpRoomEpoch(nowMs);
    this.room.status = 'suspended';
    this.room.suspensionReason = 'ownership_transfer_pending';
    this.room.completedOwnershipTransfer = null;
    const prepared = {
      transferId: `transfer_${randomToken(16)}`,
      requestId: parsed.value.requestId,
      targetAccountId: asserted.account.accountId,
      targetDisplayName: asserted.account.nickname,
      previousOwnerAccountId,
      preservedOwnerMemberId: this.room.ownerMemberId,
      pin: nextPin,
      claimNonceHash: nonceHash,
      claimGeneration: claim.claimGeneration,
      ownerAuthorityEpoch: this.room.ownerAuthorityEpoch,
      preparedAtMs: nowMs,
      expiresAtMs: claim.exp,
      devicePlatform: devicePlatformFromRequest(request),
      commitProofHash: '',
    };
    const commitProof = await ownerTransferCommitProof(this.room, prepared, activationSecret);
    prepared.commitProofHash = await sha256Base64Url(commitProof);
    this.room.pendingOwnershipTransfer = prepared;
    this.room.consumedOwnershipTransferClaims[nonceHash] = {
      requestId: parsed.value.requestId,
      expiresAtMs: claim.exp,
    };
    this.room.revision += 1;
    await this.persist();
    this.scheduleServerEvent(this.presenceEvent(), []);
    return this.ownerTransferPrepareResponse(prepared, false);
  }

  async ownerTransferCommitResponse(receipt, session, sessionToken, ownerToken, replayed) {
    const response = jsonResponse(
      {
        ok: true,
        roomCode: this.room.roomCode,
        roomGeneration: this.room.roomGeneration,
        status: this.room.status,
        suspensionReason: this.room.suspensionReason,
        transferId: receipt.transferId,
        requestId: receipt.requestId,
        targetAccountId: receipt.targetAccountId,
        previousOwnerAccountId: receipt.previousOwnerAccountId,
        replayed,
        snapshot: publicSnapshot(this.room, session),
        session: { expiresAtMs: session.expiresAtMs },
      },
      200,
      {
        'cache-control': 'no-store, max-age=0',
        'set-cookie': sessionCookie(this.room.roomCode, sessionToken, this.sessionTtlSeconds()),
      },
    );
    response.headers.append('set-cookie', ownerCookie(this.room.roomCode, ownerToken));
    return response;
  }

  ownerTransferReconcileResponse(receipt, replayed) {
    return jsonResponse(
      {
        ok: true,
        roomCode: this.room.roomCode,
        roomGeneration: this.room.roomGeneration,
        status: this.room.status,
        suspensionReason: this.room.suspensionReason,
        transferId: receipt.transferId,
        requestId: receipt.requestId,
        targetAccountId: receipt.targetAccountId,
        previousOwnerAccountId: receipt.previousOwnerAccountId,
        replayed,
      },
      200,
      { 'cache-control': 'no-store, max-age=0' },
    );
  }

  async handleInternalOwnerTransferCommit(request, options = {}) {
    const reconcile = options.reconcile === true;
    const parsed = await this.parseBody(request, 16 * 1024);
    const requiredKeys = reconcile
      ? ['transferId', 'targetAccountId', 'requestId', 'revocationReceipt']
      : ['transferId', 'commitProof', 'targetAccountId', 'requestId', 'revocationReceipt'];
    if (
      parsed.response ||
      !hasExactKeys(parsed.value, requiredKeys, ['roomGeneration']) ||
      exactInternalRoomGeneration(request, parsed.value) !== this.room.roomGeneration ||
      !OWNER_TRANSFER_ID_RE.test(parsed.value.transferId || '') ||
      (!reconcile && typeof parsed.value.commitProof !== 'string') ||
      !ACCOUNT_ID_RE.test(parsed.value.targetAccountId || '') ||
      !OWNER_TRANSFER_REQUEST_ID_RE.test(parsed.value.requestId || '') ||
      typeof parsed.value.revocationReceipt !== 'string'
    ) {
      return parsed.response || errorResponse('INVALID_REQUEST', 400);
    }
    const nowMs = Date.now();
    const activationSecret = String(this.env.PRO_ROOM_ACTIVATION_SECRET || '');
    const sessionSecret = String(this.env.PRO_ROOM_SESSION_SECRET || '');
    const assertionSecret = String(this.env.MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET || '');
    if (activationSecret.length < 32 || sessionSecret.length < 32 || assertionSecret.length < 32) {
      return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    }
    const expected = {
      roomCode: this.room.roomCode,
      roomGeneration: this.room.roomGeneration,
      transferId: parsed.value.transferId,
      targetAccountId: parsed.value.targetAccountId,
      requestId: parsed.value.requestId,
    };
    const revocation = await verifyOwnerTransferRevocationReceipt(
      parsed.value.revocationReceipt,
      expected,
      assertionSecret,
      nowMs,
    );
    if (!revocation) return errorResponse('OWNER_TRANSFER_REVOCATION_PROOF_INVALID', 401);
    const matchingRevocationBoundary =
      this.room.pendingOwnershipTransfer?.transferId === parsed.value.transferId
        ? this.room.pendingOwnershipTransfer.preparedAtMs
        : this.room.completedOwnershipTransfer?.transferId === parsed.value.transferId
          ? this.room.completedOwnershipTransfer.preparedAtMs
          : null;
    if (
      Number.isSafeInteger(matchingRevocationBoundary) &&
      revocation.revokedAtMs < matchingRevocationBoundary
    ) {
      return errorResponse('OWNER_TRANSFER_REVOCATION_PROOF_INVALID', 401);
    }
    const proofHash = reconcile ? null : await sha256Base64Url(parsed.value.commitProof);
    const completed = this.room.completedOwnershipTransfer;
    if (completed?.transferId === parsed.value.transferId) {
      if (
        completed.requestId !== parsed.value.requestId ||
        completed.targetAccountId !== parsed.value.targetAccountId ||
        (!reconcile && !constantTimeEqual(completed.commitProofHash, proofHash))
      ) {
        return errorResponse('OWNER_TRANSFER_COMMIT_MISMATCH', 409);
      }
      if (reconcile) {
        const expectedProof = await ownerTransferCommitProof(
          this.room,
          completed,
          activationSecret,
        );
        if (!constantTimeEqual(completed.commitProofHash, await sha256Base64Url(expectedProof))) {
          return errorResponse('OWNER_TRANSFER_COMMIT_MISMATCH', 409);
        }
      }
      if (completed.replayUntilMs <= nowMs) {
        return errorResponse('OWNER_TRANSFER_CLAIM_EXPIRED', 410);
      }
      const sessionToken = await createDeterministicOpaqueCredential(
        sessionSecret,
        `owner-transfer-session:${this.room.roomCode}:${this.room.roomGeneration}:${completed.transferId}:${completed.requestId}`,
      );
      const ownerToken = await createDeterministicOpaqueCredential(
        sessionSecret,
        `owner-transfer-owner:${this.room.roomCode}:${this.room.roomGeneration}:${completed.transferId}:${completed.requestId}`,
      );
      const [sessionTokenHash, ownerCredentialHash] = await Promise.all([
        sha256Base64Url(sessionToken),
        sha256Base64Url(ownerToken),
      ]);
      const session = this.room.sessions[sessionTokenHash];
      const participant = session
        ? this.room.presence.participants[session.participantId] || null
        : null;
      if (
        this.room.status !== 'active' ||
        this.room.suspensionReason !== null ||
        this.room.ownerAccountId !== completed.targetAccountId ||
        this.room.ownerMemberId !== completed.preservedOwnerMemberId ||
        this.room.authEpoch !== completed.authEpoch ||
        this.room.ownerAuthorityEpoch !== completed.ownerAuthorityEpoch ||
        !constantTimeEqual(sessionTokenHash, completed.sessionTokenHash) ||
        !constantTimeEqual(ownerCredentialHash, completed.ownerCredentialHash) ||
        !constantTimeEqual(ownerCredentialHash, this.room.ownerCredentialHash || '') ||
        !session ||
        session.roomGeneration !== this.room.roomGeneration ||
        session.authEpoch !== this.room.authEpoch ||
        session.memberId !== completed.preservedOwnerMemberId ||
        session.accountId !== completed.targetAccountId ||
        session.role !== 'owner' ||
        !Number.isSafeInteger(session.accountLeaseExpiresAtMs) ||
        session.accountLeaseExpiresAtMs <= nowMs ||
        !participant ||
        participant.sessionHash !== sessionTokenHash ||
        participant.presenceIncarnationId !== session.presenceIncarnationId ||
        participant.memberId !== completed.preservedOwnerMemberId ||
        participant.accountId !== completed.targetAccountId ||
        participant.role !== 'owner'
      ) {
        return errorResponse('OWNER_TRANSFER_COMMIT_SUPERSEDED', 409);
      }
      return reconcile
        ? this.ownerTransferReconcileResponse(completed, true)
        : this.ownerTransferCommitResponse(completed, session, sessionToken, ownerToken, true);
    }

    const pending = this.room.pendingOwnershipTransfer;
    if (
      !pending ||
      this.room.status !== 'suspended' ||
      this.room.suspensionReason !== 'ownership_transfer_pending'
    ) {
      return errorResponse('OWNER_TRANSFER_NOT_PENDING', 409);
    }
    if (
      pending.transferId !== parsed.value.transferId ||
      pending.requestId !== parsed.value.requestId ||
      pending.targetAccountId !== parsed.value.targetAccountId ||
      (!reconcile && !constantTimeEqual(pending.commitProofHash, proofHash))
    ) {
      return errorResponse('OWNER_TRANSFER_COMMIT_MISMATCH', 409);
    }
    if (pending.expiresAtMs <= nowMs) return errorResponse('OWNER_TRANSFER_CLAIM_EXPIRED', 410);
    if (this.isAccountDeletionTombstoned(pending.targetAccountId, nowMs)) {
      return errorResponse('OWNER_TRANSFER_TARGET_ACCOUNT_DELETED', 409);
    }
    const expectedProof = await ownerTransferCommitProof(this.room, pending, activationSecret);
    const proofMatches = reconcile
      ? constantTimeEqual(pending.commitProofHash, await sha256Base64Url(expectedProof))
      : constantTimeEqual(expectedProof, parsed.value.commitProof);
    if (!proofMatches) {
      return errorResponse('OWNER_TRANSFER_COMMIT_MISMATCH', 409);
    }
    if (
      this.room.revision >= Number.MAX_SAFE_INTEGER ||
      this.room.presence.revision >= Number.MAX_SAFE_INTEGER ||
      this.room.presence.coordinatorEpoch >= Number.MAX_SAFE_INTEGER ||
      this.room.playback.revision >= Number.MAX_SAFE_INTEGER
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }

    const sessionToken = await createDeterministicOpaqueCredential(
      sessionSecret,
      `owner-transfer-session:${this.room.roomCode}:${this.room.roomGeneration}:${pending.transferId}:${pending.requestId}`,
    );
    const ownerToken = await createDeterministicOpaqueCredential(
      sessionSecret,
      `owner-transfer-owner:${this.room.roomCode}:${this.room.roomGeneration}:${pending.transferId}:${pending.requestId}`,
    );
    const [sessionTokenHash, ownerCredentialHash, revocationReceiptHash] = await Promise.all([
      sha256Base64Url(sessionToken),
      sha256Base64Url(ownerToken),
      sha256Base64Url(parsed.value.revocationReceipt),
    ]);
    const session = {
      roomGeneration: this.room.roomGeneration,
      memberId: pending.preservedOwnerMemberId,
      participantId: `participant_${randomToken(18)}`,
      presenceIncarnationId: null,
      signalingTicketSequence: 0,
      displayName: pending.targetDisplayName,
      memberDisplayNumber: 0,
      accountId: pending.targetAccountId,
      accountLeaseExpiresAtMs: this.accountIdentityLeaseExpiresAt(nowMs),
      role: 'owner',
      authEpoch: this.room.authEpoch,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.sessionTtlSeconds() * 1000,
    };
    this.room.pin = pending.pin;
    this.room.ownerMemberId = pending.preservedOwnerMemberId;
    this.room.ownerAccountId = pending.targetAccountId;
    this.room.ownerDisplayName = pending.targetDisplayName;
    this.room.accountMembers = {
      [pending.targetAccountId]: {
        memberId: pending.preservedOwnerMemberId,
        displayName: pending.targetDisplayName,
        displayNumber: 0,
        role: 'owner',
        permissions: clonePermissionSet(OWNER_PERMISSIONS),
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      },
    };
    this.room.anonymousAdministrators = {};
    this.room.sessions = { [sessionTokenHash]: session };
    this.room.presence.participants = {};
    this.room.presence.coordinatorParticipantId = null;
    this.room.ownerCredentialHash = ownerCredentialHash;
    this.room.status = 'active';
    this.room.suspensionReason = null;
    this.room.runtime = 'sleeping';
    if (this.joinPresence(session, sessionTokenHash, nowMs, pending.devicePlatform) === null) {
      return errorResponse('ROOM_FULL', 409);
    }
    const receipt = {
      transferId: pending.transferId,
      requestId: pending.requestId,
      targetAccountId: pending.targetAccountId,
      previousOwnerAccountId: pending.previousOwnerAccountId,
      preservedOwnerMemberId: pending.preservedOwnerMemberId,
      claimNonceHash: pending.claimNonceHash,
      commitProofHash: pending.commitProofHash,
      revocationReceiptHash,
      ownerAuthorityEpoch: this.room.ownerAuthorityEpoch,
      authEpoch: this.room.authEpoch,
      preparedAtMs: pending.preparedAtMs,
      expiresAtMs: pending.expiresAtMs,
      committedAtMs: nowMs,
      replayUntilMs: nowMs + OWNER_TRANSFER_COMPLETED_REPLAY_TTL_MS,
      sessionTokenHash,
      ownerCredentialHash,
    };
    this.room.completedOwnershipTransfer = receipt;
    this.room.pendingOwnershipTransfer = null;
    this.room.ownerAuthorityRemoval = null;
    await this.persist();
    // A non-empty authoritative snapshot at the transfer's newer compatibility
    // epoch releases the signaling-side owner-deletion admission fence. The
    // existing durable retry path keeps signaling closed if delivery fails.
    this.scheduleServerEvent(this.presenceEvent());
    return reconcile
      ? this.ownerTransferReconcileResponse(receipt, false)
      : this.ownerTransferCommitResponse(receipt, session, sessionToken, ownerToken, false);
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
    if (
      !ownerName ||
      !isSafeVisibleDisplayName(ownerName) ||
      !PIN_RE.test(body.newPin) ||
      body.newPin === body.temporaryPin
    ) {
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
      claimValid.roomGeneration !== this.room.roomGeneration ||
      !temporaryPinValid
    ) {
      return errorResponse('ACTIVATION_INVALID', 401);
    }

    const asserted = await this.accountAssertion(request);
    if (asserted.response) return asserted.response;
    if (!asserted.account) return errorResponse('ACCOUNT_SESSION_REQUIRED', 401);
    if (
      claimValid.targetAccountId !== undefined &&
      claimValid.targetAccountId !== asserted.account.accountId
    ) {
      return errorResponse('OWNER_ACCOUNT_LINK_CONFLICT', 409);
    }
    const pin = await createPinRecord(body.newPin, pepper);
    if (
      !(await reserveProRoomActivationEntitlement(this.env, {
        accountId: asserted.account.accountId,
        roomCode: this.room.roomCode,
        roomGeneration: this.room.roomGeneration,
        nowMs,
      }))
    ) {
      return errorResponse('ACCOUNT_PRO_ROOM_LIMIT_REACHED', 409);
    }
    this.room.status = 'active';
    this.room.suspensionReason = null;
    this.room.authEpoch = 1;
    this.room.ownerAuthorityEpoch = 1;
    this.room.pin = pin;
    const ownerCredential = await this.createOwnerCredential();
    this.room.ownerMemberId = this.room.ownerMemberId || `owner_${randomToken(18)}`;
    const accountMember = this.resolveAccountMember(asserted.account, 'owner', nowMs);
    const created = await this.createSessionRecord(
      'owner',
      accountMember?.displayName || ownerName,
      nowMs,
      this.room.ownerMemberId,
      accountMember,
    );
    if (!created || !ownerCredential) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    this.room.ownerCredentialHash = ownerCredential.hash;
    this.room.ownerDisplayName = created.session.displayName;
    this.joinPresence(
      created.session,
      created.tokenHash,
      nowMs,
      devicePlatformFromRequest(request),
    );
    await this.persist();
    this.markRegistryActivationActive();
    await finalizeProRoomActivationEntitlement(this.env, {
      accountId: asserted.account.accountId,
      roomCode: this.room.roomCode,
      roomGeneration: this.room.roomGeneration,
      nowMs,
    }).catch(() => false);
    const response = jsonResponse(
      {
        snapshot: publicSnapshot(this.room, created.session),
      },
      200,
      {
        'set-cookie': sessionCookie(this.room.roomCode, created.token, this.sessionTtlSeconds()),
      },
    );
    response.headers.append('set-cookie', ownerCookie(this.room.roomCode, ownerCredential.token));
    return response;
  }

  async handleOwnerRecovery(request) {
    if (this.room.status !== 'active') return errorResponse('RECOVERY_UNAVAILABLE', 409);
    const rateError = await this.applyRateLimit(request, 'owner-recovery', 10, 60 * 60 * 1000);
    if (rateError) return rateError;
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    if (!hasExactKeys(parsed.value, ['claimToken'])) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const activationSecret = String(this.env.PRO_ROOM_ACTIVATION_SECRET || '');
    if (
      activationSecret.length < 32 ||
      String(this.env.PRO_ROOM_SESSION_SECRET || '').length < 32
    ) {
      return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    }
    const nowMs = Date.now();
    const asserted = await this.accountAssertion(request);
    if (asserted.response) return asserted.response;
    // Ownership recovery is an account-binding operation, not an anonymous
    // bearer-login escape hatch. A missing assertion must fail before the
    // claim or any existing owner state can be consumed.
    if (!asserted.account) return errorResponse('ACCOUNT_SESSION_REQUIRED', 401);
    const claim = await verifyOwnerRecoveryClaim(
      parsed.value.claimToken,
      this.room.roomCode,
      activationSecret,
      nowMs,
    );
    if (
      !claim ||
      claim.roomGeneration !== this.room.roomGeneration ||
      claim.ownerAuthorityEpoch !== this.room.ownerAuthorityEpoch
    ) {
      return errorResponse('RECOVERY_INVALID', 401);
    }
    const nonceHash = await sha256Base64Url(`owner-recovery:${claim.nonce}`);
    if (this.room.consumedRecoveryNonces[nonceHash]) {
      return errorResponse('RECOVERY_CLAIM_USED', 409);
    }
    if (Object.keys(this.room.consumedRecoveryNonces).length >= RECOVERY_NONCE_MAX_ITEMS) {
      return errorResponse('RECOVERY_CAPACITY_EXCEEDED', 409);
    }

    // Validate the recovery claim before exposing whether this room is linked
    // to another account. A valid claim still cannot transfer a linked room,
    // and every account-capacity check remains non-mutating so the same claim
    // can be retried after the operator resolves the account condition.
    if (
      !ACCOUNT_ID_RE.test(this.room.ownerAccountId || '') ||
      this.room.ownerAccountId !== asserted.account.accountId
    ) {
      return errorResponse('OWNER_ACCOUNT_LINK_CONFLICT', 409);
    }
    const accountMember = this.prepareOwnerAccountMember(asserted.account, nowMs);
    if (!accountMember) return errorResponse('ACCOUNT_MEMBER_CAPACITY_EXCEEDED', 409);
    const ownerCredential = await this.createOwnerCredential();
    if (!ownerCredential) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    if (this.room.ownerAuthorityEpoch >= Number.MAX_SAFE_INTEGER) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }

    // The recovery page can be opened from a browser that is already present
    // as an ordinary room member. Its response replaces that browser's
    // session cookie, so retire the superseded physical session now instead
    // of leaving an unreachable owner presence behind until TTL expiry. Other
    // devices of the same proven account remain live and are upgraded below.
    const recoveringSession = await this.authenticate(request);
    if (recoveringSession) {
      this.removePresence(recoveringSession.session.participantId, nowMs);
      this.removeSessionRecord(recoveringSession.tokenHash);
    }
    for (const [tokenHash, session] of Object.entries(this.room.sessions)) {
      if (session.role !== 'owner') continue;
      this.removePresence(session.participantId, nowMs);
      this.removeSessionRecord(tokenHash);
    }
    const created = await this.createSessionRecord(
      'owner',
      accountMember.displayName,
      nowMs,
      this.room.ownerMemberId,
      accountMember,
    );
    if (!created) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    this.commitOwnerAccountMember(accountMember);
    this.room.ownerAuthorityEpoch += 1;
    this.room.ownerCredentialHash = ownerCredential.hash;
    this.room.ownerDisplayName = created.session.displayName;
    this.room.consumedRecoveryNonces[nonceHash] = claim.exp;
    this.joinPresence(
      created.session,
      created.tokenHash,
      nowMs,
      devicePlatformFromRequest(request),
    );
    await this.persist();
    const response = jsonResponse(
      {
        snapshot: publicSnapshot(this.room, created.session),
      },
      200,
      {
        'set-cookie': sessionCookie(this.room.roomCode, created.token, this.sessionTtlSeconds()),
      },
    );
    response.headers.append('set-cookie', ownerCookie(this.room.roomCode, ownerCredential.token));
    return response;
  }

  async handleCreateSession(request) {
    if (this.room.status === 'unactivated') return errorResponse('ACTIVATION_REQUIRED', 409);
    if (this.room.status === 'suspended') return errorResponse('ROOM_SUSPENDED', 423);
    const parsed = await this.parseBody(request);
    if (parsed.response) return parsed.response;
    const body = parsed.value;
    const legacyBody = hasExactKeys(body, ['pin']);
    const idempotentBody = hasExactKeys(body, ['pin', 'requestId']);
    if (
      (!legacyBody && !idempotentBody) ||
      !PIN_RE.test(body.pin) ||
      (idempotentBody && !IDEMPOTENCY_KEY_RE.test(body.requestId || ''))
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const pepper = String(this.env.PRO_ROOM_PIN_PEPPER || '');
    const sessionSecret = String(this.env.PRO_ROOM_SESSION_SECRET || '');
    if (pepper.length < 32 || sessionSecret.length < 32) {
      return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    }
    const nowMs = Date.now();
    const asserted = await this.accountAssertion(request);
    if (asserted.response) return asserted.response;
    const ownerCredential = await this.hasOwnerCredential(request);
    let scope = null;
    let fingerprint = null;
    let credentialContext = null;
    let idempotencyRecords = null;
    if (idempotentBody) {
      const actorHint = request.headers.get(PRO_ROOM_SESSION_ACTOR_HEADER) || '';
      // The App facade derives this stable, authority-free actor from the
      // room-scoped 192-bit client requestId before optional account lookup.
      // A newly issued session cookie or recovered account assertion must
      // never change idempotency scope after an outcome-unknown response.
      const actorIdentity = PRO_ROOM_SESSION_ACTOR_RE.test(actorHint)
        ? `facade:${actorHint}`
        : `network:${request.headers.get('x-mxqr-pro-ip-hash') || 'internal-test'}`;
      const actorHash = await sha256Base64Url(actorIdentity);
      scope = `session-create:${actorHash}`;
      fingerprint = await hmacBase64Url(
        sessionSecret,
        `session-create-fingerprint:v1\u0000${scope}\u0000${JSON.stringify({
          pin: body.pin,
          requestId: body.requestId,
        })}`,
      );
      credentialContext = [
        'session-create:v1',
        this.room.roomCode,
        String(this.room.roomGeneration),
        scope,
        body.requestId,
        fingerprint,
      ].join('\u0000');
      const deterministicToken = await createDeterministicOpaqueCredential(
        sessionSecret,
        credentialContext,
      );
      const deterministicTokenHash = await sha256Base64Url(deterministicToken);
      const existingReceipt = this.idempotencyRecord(scope, body.requestId);
      if (existingReceipt) {
        if (!constantTimeEqual(existingReceipt.fingerprint || '', fingerprint)) {
          return errorResponse('IDEMPOTENCY_CONFLICT', 409);
        }
        if (
          existingReceipt.kind !== 'session-create' ||
          existingReceipt.status !== 200 ||
          !SHA256_RE.test(existingReceipt.tokenHash || '') ||
          !OPAQUE_ID_RE.test(existingReceipt.participantId || '')
        ) {
          return errorResponse('ROOM_STATE_INVALID', 503);
        }
        const replaySession = this.room.sessions[existingReceipt.tokenHash];
        if (
          !constantTimeEqual(deterministicTokenHash, existingReceipt.tokenHash) ||
          !replaySession ||
          replaySession.participantId !== existingReceipt.participantId ||
          replaySession.expiresAtMs <= nowMs ||
          replaySession.authEpoch !== this.room.authEpoch ||
          replaySession.roomGeneration !== this.room.roomGeneration
        ) {
          // The receipt remains an exactly-once fence until its short TTL ends.
          // Never turn an explicitly closed or capacity-evicted session into a
          // second admission under the same logical request.
          return errorResponse('SESSION_REPLAY_UNAVAILABLE', 409);
        }
        if (!this.room.presence.participants[replaySession.participantId]) {
          if (
            this.joinPresence(
              replaySession,
              deterministicTokenHash,
              nowMs,
              devicePlatformFromRequest(request),
            ) === null
          ) {
            return errorResponse('ROOM_FULL', 409);
          }
        }
        // A prior storage failure can leave a receipt/session visible in this
        // isolate even though the durable transaction did not commit (for
        // example, a compatibility storage implementation without the outer
        // rollback seam). Converge durability before returning any replayed
        // credential, even when its presence was already resident in memory.
        await this.persist();
        const remainingTtlSeconds = Math.max(
          1,
          Math.ceil((replaySession.expiresAtMs - nowMs) / 1000),
        );
        return jsonResponse(
          {
            snapshot: publicSnapshot(this.room, replaySession),
            session: { expiresAtMs: replaySession.expiresAtMs },
          },
          200,
          {
            'set-cookie': sessionCookie(
              this.room.roomCode,
              deterministicToken,
              remainingTtlSeconds,
            ),
            ...(replaySession.accountId ? { 'x-mxqr-account-linked': '1' } : {}),
          },
        );
      }

      // The compact receipt intentionally expires before the session. An
      // outcome-unknown retry can therefore arrive after its receipt was
      // pruned while the deterministic credential is still authoritative.
      // Reuse that exact live session and recreate the receipt; overwriting
      // the same tokenHash with a new participant would orphan the prior
      // presence and turn one logical admission into two identities.
      const recoveredSession = this.room.sessions[deterministicTokenHash];
      if (recoveredSession) {
        if (
          !OPAQUE_ID_RE.test(recoveredSession.participantId || '') ||
          recoveredSession.expiresAtMs <= nowMs ||
          recoveredSession.authEpoch !== this.room.authEpoch ||
          recoveredSession.roomGeneration !== this.room.roomGeneration
        ) {
          return errorResponse('ROOM_STATE_INVALID', 503);
        }
        if (!this.room.presence.participants[recoveredSession.participantId]) {
          if (
            this.joinPresence(
              recoveredSession,
              deterministicTokenHash,
              nowMs,
              devicePlatformFromRequest(request),
            ) === null
          ) {
            return errorResponse('ROOM_FULL', 409);
          }
        }
        const recoveredRecords = this.reserveIdempotencySlot(scope, body.requestId, nowMs);
        recoveredRecords[`${scope}:${body.requestId}`] = {
          kind: 'session-create',
          fingerprint,
          status: 200,
          tokenHash: deterministicTokenHash,
          participantId: recoveredSession.participantId,
          expiresAtMs: Math.min(
            recoveredSession.expiresAtMs,
            nowMs + SESSION_CREATE_IDEMPOTENCY_TTL_MS,
          ),
        };
        await this.persist();
        const remainingTtlSeconds = Math.max(
          1,
          Math.ceil((recoveredSession.expiresAtMs - nowMs) / 1000),
        );
        return jsonResponse(
          {
            snapshot: publicSnapshot(this.room, recoveredSession),
            session: { expiresAtMs: recoveredSession.expiresAtMs },
          },
          200,
          {
            'set-cookie': sessionCookie(
              this.room.roomCode,
              deterministicToken,
              remainingTtlSeconds,
            ),
            ...(recoveredSession.accountId ? { 'x-mxqr-account-linked': '1' } : {}),
          },
        );
      }
    }
    // The one-field legacy body remains accepted during the cached-client
    // rollout. It cannot be safely collapsed by IP/PIN/User-Agent without
    // merging distinct devices behind the same NAT, so only v1 clients that
    // supply an opaque requestId receive exactly-once replay semantics.
    const rateError = this.readRateLimit(request, 'pin-failure', 10);
    if (rateError) return rateError;
    if (!(await verifyPin(body.pin, this.room.pin, pepper))) {
      this.recordRateLimitHit(request, 'pin-failure', 60 * 60 * 1000);
      await this.persist();
      return errorResponse('PIN_INVALID', 401);
    }
    if (idempotentBody && scope) {
      // Capacity is reserved before account/session state is touched, so a
      // full receipt ledger fails closed without a partially admitted identity.
      idempotencyRecords = this.reserveIdempotencySlot(scope, body.requestId, nowMs);
    }
    const role =
      (ownerCredential && this.room.ownerAccountId === null) ||
      (asserted.account && this.room.ownerAccountId === asserted.account.accountId)
        ? 'owner'
        : 'member';
    const accountMember = this.resolveAccountMember(asserted.account, role, nowMs);
    if (
      asserted.account &&
      !accountMember &&
      !(role === 'owner' && this.room.ownerAccountId !== null)
    ) {
      return errorResponse('ACCOUNT_MEMBER_CAPACITY_EXCEEDED', 409);
    }
    const created = await this.createSessionRecord(
      accountMember?.role || role,
      accountMember?.displayName ||
        (role === 'owner' ? this.room.ownerDisplayName || 'Owner' : DEFAULT_PEER_DISPLAY_NAME),
      nowMs,
      accountMember?.memberId || (role === 'owner' ? this.room.ownerMemberId : null),
      accountMember,
      credentialContext,
    );
    if (!created) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    if (
      this.joinPresence(
        created.session,
        created.tokenHash,
        nowMs,
        devicePlatformFromRequest(request),
      ) === null
    ) {
      this.removeSessionRecord(created.tokenHash);
      return errorResponse('ROOM_FULL', 409);
    }
    if (idempotencyRecords && scope && fingerprint) {
      idempotencyRecords[`${scope}:${body.requestId}`] = {
        kind: 'session-create',
        fingerprint,
        status: 200,
        tokenHash: created.tokenHash,
        participantId: created.session.participantId,
        expiresAtMs: Math.min(
          created.session.expiresAtMs,
          nowMs + SESSION_CREATE_IDEMPOTENCY_TTL_MS,
        ),
      };
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
        ...(accountMember ? { 'x-mxqr-account-linked': '1' } : {}),
      },
    );
  }

  async handleGetSnapshot(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    return jsonResponse({
      snapshot: publicSnapshot(this.room, auth.session),
    });
  }

  async handleAttachCurrentAccount(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, SMALL_REQUEST_MAX_BYTES, false, true);
    if (parsed.response) return parsed.response;
    if (!parsed.empty) return errorResponse('INVALID_REQUEST', 400);
    const asserted = await this.accountAssertion(request);
    if (asserted.response) return asserted.response;
    if (!asserted.account) return errorResponse('ACCOUNT_SESSION_REQUIRED', 401);
    if (auth.session.accountId && auth.session.accountId !== asserted.account.accountId) {
      return errorResponse('SESSION_ACCOUNT_CONFLICT', 409);
    }
    if (
      auth.session.role === 'owner' &&
      this.room.ownerAccountId &&
      this.room.ownerAccountId !== asserted.account.accountId
    ) {
      return errorResponse('OWNER_ACCOUNT_LINK_CONFLICT', 409);
    }
    const nowMs = Date.now();
    const existingMember = this.room.accountMembers?.[asserted.account.accountId] || null;
    const existingParticipant = this.room.presence.participants[auth.session.participantId] || null;
    if (
      auth.session.accountId === asserted.account.accountId &&
      existingMember &&
      existingMember.displayName === asserted.account.nickname &&
      auth.session.memberId === existingMember.memberId &&
      auth.session.memberDisplayNumber === existingMember.displayNumber &&
      auth.session.displayName === existingMember.displayName &&
      auth.session.role === existingMember.role &&
      (!existingParticipant ||
        (existingParticipant.accountId === asserted.account.accountId &&
          existingParticipant.memberId === existingMember.memberId &&
          existingParticipant.memberDisplayNumber === existingMember.displayNumber &&
          existingParticipant.displayName === existingMember.displayName &&
          existingParticipant.role === existingMember.role))
    ) {
      // Account refresh/focus reconciliation may prove the same HttpOnly
      // identity repeatedly. Keep that path revision-idempotent so safety does
      // not turn into a periodic presence broadcast.
      if (
        !Number.isSafeInteger(auth.session.accountLeaseExpiresAtMs) ||
        auth.session.accountLeaseExpiresAtMs <= nowMs + ACCOUNT_IDENTITY_LEASE_RENEW_THRESHOLD_MS
      ) {
        auth.session.accountLeaseExpiresAtMs = this.accountIdentityLeaseExpiresAt(nowMs);
        await this.persist({ retainEarlierAlarm: true });
      }
      return jsonResponse(
        {
          snapshot: publicSnapshot(this.room, auth.session),
        },
        200,
        {
          'x-mxqr-account-linked': '1',
        },
      );
    }
    const role =
      auth.session.role === 'owner' || this.room.ownerAccountId === asserted.account.accountId
        ? 'owner'
        : 'member';
    const accountMember = this.resolveAccountMember(asserted.account, role, nowMs);
    if (!accountMember) return errorResponse('ACCOUNT_MEMBER_CAPACITY_EXCEEDED', 409);
    const previousAnonymousMemberId = auth.session.accountId ? null : auth.session.memberId;
    if (previousAnonymousMemberId) {
      // An ephemeral anonymous grant must never become a persistent account
      // grant merely because the same tab signs in. The owner can delegate to
      // the newly proven account explicitly after attachment.
      this.removeAnonymousAdministrator(previousAnonymousMemberId);
    }
    auth.session.accountId = accountMember.accountId;
    auth.session.memberId = accountMember.memberId;
    auth.session.memberDisplayNumber = accountMember.displayNumber;
    auth.session.displayName = accountMember.displayName;
    auth.session.role = accountMember.role;
    auth.session.accountLeaseExpiresAtMs = this.accountIdentityLeaseExpiresAt(nowMs);
    this.syncAccountMemberSessions(accountMember.accountId, accountMember);
    this.room.presence.revision += 1;
    this.room.revision += 1;
    await this.persist();
    this.scheduleServerEvent(this.presenceEvent());
    return jsonResponse(
      {
        snapshot: publicSnapshot(this.room, auth.session),
      },
      200,
      {
        'x-mxqr-account-linked': '1',
      },
    );
  }

  async handleRenewCurrentAccountLease(request) {
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, SMALL_REQUEST_MAX_BYTES, false, true);
    if (parsed.response) return parsed.response;
    if (!parsed.empty) return errorResponse('INVALID_REQUEST', 400);
    const asserted = await this.accountAssertion(request);
    if (asserted.response) return asserted.response;
    if (!asserted.account) return errorResponse('ACCOUNT_SESSION_REQUIRED', 401);
    if (!auth.session.accountId) return errorResponse('ACCOUNT_REATTACH_REQUIRED', 409);
    if (auth.session.accountId !== asserted.account.accountId) {
      return errorResponse('SESSION_ACCOUNT_CONFLICT', 409);
    }
    const member = this.room.accountMembers?.[auth.session.accountId] || null;
    if (!member || member.memberId !== auth.session.memberId) {
      return errorResponse('ACCOUNT_REATTACH_REQUIRED', 409);
    }

    const nowMs = Date.now();
    if (
      !Number.isSafeInteger(auth.session.accountLeaseExpiresAtMs) ||
      auth.session.accountLeaseExpiresAtMs <= nowMs + ACCOUNT_IDENTITY_LEASE_RENEW_THRESHOLD_MS
    ) {
      auth.session.accountLeaseExpiresAtMs = this.accountIdentityLeaseExpiresAt(nowMs);
      // This endpoint cannot create an account-room relationship and changes no
      // public revision. Keep the durable proof, but avoid rewriting the v1
      // rollback shadow or moving an already-earlier alarm on every renewal.
      await this.persist({ retainEarlierAlarm: true });
    }
    return jsonResponse({
      ok: true,
      leaseExpiresAtMs: auth.session.accountLeaseExpiresAtMs,
    });
  }

  async handleDetachCurrentAccount(request) {
    // Account logout is independent from transport presence. In particular,
    // a backgrounded tab may have lost its live presence while its resumable
    // room session cookie is still valid. Authenticate that exact cookie, but
    // do not require or revive presence merely to drop account authority.
    const auth = await this.requireSession(request);
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, SMALL_REQUEST_MAX_BYTES, false, true);
    if (parsed.response) return parsed.response;
    if (!parsed.empty) return errorResponse('INVALID_REQUEST', 400);
    const detachResponse = (session, participant) => {
      const snapshot = participant ? publicSnapshot(this.room, session) : null;
      return jsonResponse({ ok: true, detached: true, snapshot });
    };

    // Repeated logout/cross-tab reconciliation is deliberately idempotent.
    if (!auth.session.accountId) {
      const participant = this.room.presence.participants[auth.session.participantId] || null;
      return detachResponse(auth.session, participant);
    }

    const participant = this.room.presence.participants[auth.session.participantId] || null;
    if (
      this.room.revision >= Number.MAX_SAFE_INTEGER ||
      (participant && this.room.presence.revision >= Number.MAX_SAFE_INTEGER)
    ) {
      return errorResponse('REVISION_EXHAUSTED', 409);
    }
    const nowMs = Date.now();
    const detached = this.detachAccountSession(auth.session, nowMs, {
      requireUniqueDisplayNumber: true,
      touchPresence: true,
    });
    if (!detached) return errorResponse('ACCOUNT_DETACH_CAPACITY_EXCEEDED', 409);
    // The account member record (including any persistent delegation) and
    // ownerAccountId intentionally remain untouched. Other devices linked to
    // the same account therefore keep their identity and authority.
    await this.persist();
    if (participant) this.scheduleServerEvent(this.presenceEvent());
    return detachResponse(auth.session, participant);
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
    const entered = this.enterPresence(
      auth.session,
      auth.tokenHash,
      Date.now(),
      takeover,
      devicePlatformFromRequest(request),
    );
    if (entered === 'room-full') return errorResponse('ROOM_FULL', 409);
    if (entered === 'active-elsewhere') {
      return errorResponse('PRESENCE_ACTIVE_ELSEWHERE', 409);
    }
    if (entered === 'identity-mismatch') {
      return errorResponse('PRESENCE_IDENTITY_MISMATCH', 409);
    }
    await this.persist();
    return jsonResponse({
      snapshot: publicSnapshot(this.room, auth.session),
    });
  }

  async handleCloseSession(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    this.removePresence(auth.session.participantId, Date.now());
    this.removeSessionRecord(auth.tokenHash);
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
    this.removeSessionRecord(auth.tokenHash);
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
      this.removeSessionRecord(tokenHash);
    }
    // Revoke every other participant atomically. A PIN rotation advances the
    // room-incarnation fence exactly once; no browser gains server authority.
    const ownerParticipant = auth.participant;
    ownerParticipant.lastSeenAtMs = nowMs;
    this.room.presence.participants = {
      [ownerSession.participantId]: ownerParticipant,
    };
    this.reconcileSystemAudio(nowMs);
    this.room.presence.coordinatorParticipantId = null;
    this.room.presence.revision += 1;
    this.room.runtime = 'awake';
    this.bumpRoomEpoch(nowMs);
    this.room.revision += 1;
    await this.persist();
    this.scheduleServerEvent(this.presenceEvent());
    return jsonResponse({ ok: true });
  }

  async handleHeartbeat(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, SMALL_REQUEST_MAX_BYTES, false, true);
    if (parsed.response) return parsed.response;
    const known = parsed.empty ? null : parsed.value;
    if (
      known !== null &&
      (!hasExactKeys(known, [
        'revision',
        'playlistRevision',
        'presenceRevision',
        'playbackRevision',
        'coordinatorEpoch',
      ]) ||
        !isSafeNonNegativeInteger(known.revision) ||
        !isSafeNonNegativeInteger(known.playlistRevision) ||
        !isSafeNonNegativeInteger(known.presenceRevision) ||
        !isSafeNonNegativeInteger(known.playbackRevision) ||
        !isSafeNonNegativeInteger(known.coordinatorEpoch))
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const nowMs = Date.now();
    const hadPeerOrdinal = Object.prototype.hasOwnProperty.call(auth.session, 'peerOrdinal');
    const previousPeerOrdinal = auth.session.peerOrdinal;
    const previousSessionDisplayName = auth.session.displayName;
    const previousSessionMemberDisplayNumber = auth.session.memberDisplayNumber;
    const previousParticipantDisplayName = auth.participant.displayName;
    const previousParticipantMemberDisplayNumber = auth.participant.memberDisplayNumber;
    const accountMember = auth.session.accountId
      ? this.room.accountMembers?.[auth.session.accountId]
      : null;
    const previousAccountDisplayNumber = accountMember?.displayNumber;
    const anonymousAdministrator = !auth.session.accountId
      ? this.room.anonymousAdministrators?.[auth.session.memberId]
      : null;
    const previousAdministratorDisplayName = anonymousAdministrator?.displayName;
    const previousAdministratorDisplayNumber = anonymousAdministrator?.displayNumber;
    const canonicalPeerIdentity = this.ensureSessionPeerIdentity(auth.session);
    const displayIdentityChanged =
      canonicalPeerIdentity.stateChanged || canonicalPeerIdentity.publicChanged;
    if (
      displayIdentityChanged &&
      (this.room.revision >= Number.MAX_SAFE_INTEGER ||
        this.room.presence.revision >= Number.MAX_SAFE_INTEGER)
    ) {
      if (hadPeerOrdinal) auth.session.peerOrdinal = previousPeerOrdinal;
      else delete auth.session.peerOrdinal;
      auth.session.displayName = previousSessionDisplayName;
      auth.session.memberDisplayNumber = previousSessionMemberDisplayNumber;
      auth.participant.displayName = previousParticipantDisplayName;
      auth.participant.memberDisplayNumber = previousParticipantMemberDisplayNumber;
      if (accountMember) accountMember.displayNumber = previousAccountDisplayNumber;
      if (anonymousAdministrator) {
        anonymousAdministrator.displayName = previousAdministratorDisplayName;
        anonymousAdministrator.displayNumber = previousAdministratorDisplayNumber;
      }
      return errorResponse('REVISION_EXHAUSTED', 409);
    }
    if (displayIdentityChanged) {
      this.room.presence.revision += 1;
      this.room.revision += 1;
    }
    const previousLastSeenAtMs = this.persistedPresenceLastSeenAtMs.get(
      auth.participant.participantId,
    );
    const nearPersistedExpiry =
      !Number.isSafeInteger(previousLastSeenAtMs) ||
      previousLastSeenAtMs + this.presenceTtlMs() <=
        nowMs + PRESENCE_HEARTBEAT_PERSIST_EXPIRY_GUARD_MS;
    const recoveringUnscheduledHeartbeat =
      this.heartbeatDurabilityDirty && this.pendingHeartbeatFlushGeneration === null;
    auth.participant.lastSeenAtMs = nowMs;
    this.heartbeatDurabilityDirty = true;
    const developerCommandsChanged = await this.processDeveloperCommands(nowMs);
    if (
      displayIdentityChanged ||
      canonicalPeerIdentity.stateChanged ||
      developerCommandsChanged ||
      nearPersistedExpiry ||
      recoveringUnscheduledHeartbeat ||
      !this.scheduleHeartbeatDurability(nowMs)
    ) {
      await this.persist({ retainEarlierAlarm: true });
    }
    if (displayIdentityChanged) this.scheduleServerEvent(this.presenceEvent());
    if (
      known !== null &&
      known.revision === this.room.revision &&
      known.playlistRevision === this.room.playlistRevision &&
      known.presenceRevision === this.room.presence.revision &&
      known.playbackRevision === this.room.playback.revision &&
      known.coordinatorEpoch === this.room.presence.coordinatorEpoch
    ) {
      return jsonResponse({
        notModified: true,
        revision: this.room.revision,
        playlistRevision: this.room.playlistRevision,
        presenceRevision: this.room.presence.revision,
        playbackRevision: this.room.playback.revision,
        coordinatorEpoch: this.room.presence.coordinatorEpoch,
      });
    }
    return jsonResponse({
      snapshot: publicSnapshot(this.room, auth.session),
    });
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
    const replay = this.replayIdempotency(scope, key, fingerprint, auth.session, null);
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

    // Playback is server-authoritative. Pagehide may carry the last locally
    // observed checkpoint for request-shape continuity, but it is never
    // allowed to overwrite the canonical server clock.
    if (body.currentQueueItemId !== null && !QUEUE_ITEM_ID_RE.test(body.currentQueueItemId || '')) {
      return errorResponse('INVALID_PLAYBACK', 400);
    }
    if (body.playback !== null && typeof body.playback !== 'object') {
      return errorResponse('INVALID_PLAYBACK', 400);
    }
    this.removePresence(body.expectedParticipantId, Date.now());
    const responseBody = { ok: true };
    this.storeIdempotency(scope, key, fingerprint, responseBody);
    await this.persist();
    return jsonResponse(responseBody);
  }

  async handleKickPresence(request) {
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'members.manage',
    });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, 1024);
    if (parsed.response) return parsed.response;
    const targetsParticipant = hasExactKeys(parsed.value, ['targetParticipantId']);
    const targetsMember = hasExactKeys(parsed.value, ['targetMemberId']);
    if (
      targetsParticipant === targetsMember ||
      (targetsParticipant && !OPAQUE_ID_RE.test(parsed.value.targetParticipantId || '')) ||
      (targetsMember && !OPAQUE_ID_RE.test(parsed.value.targetMemberId || ''))
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const target = targetsParticipant
      ? this.room.presence.participants[parsed.value.targetParticipantId]
      : Object.values(this.room.presence.participants).find(
          (participant) => participant.memberId === parsed.value.targetMemberId,
        );
    if (!target) return errorResponse('PARTICIPANT_NOT_FOUND', 404);
    const targetParticipantId = target.participantId;
    const targetSession = this.room.sessions[target.sessionHash];
    if (!targetSession) return errorResponse('PARTICIPANT_NOT_FOUND', 404);
    if (
      targetParticipantId === auth.session.participantId ||
      targetSession.memberId === auth.session.memberId
    ) {
      return errorResponse('CANNOT_KICK_SELF', 409);
    }
    if (targetSession.role === 'owner') return errorResponse('OWNER_AUTHORITY_IMMUTABLE', 409);
    if (auth.session.role !== 'owner' && targetSession.role === 'controller') {
      return errorResponse('ADMINISTRATOR_TARGET_FORBIDDEN', 403);
    }
    // Member kick revokes delegated authority and removes every live session
    // for that room member. Exact transport removal is `/presence/kick-device`.
    if (targetSession.accountId) {
      const member = this.room.accountMembers?.[targetSession.accountId];
      if (member?.role === 'controller') {
        member.role = 'member';
        member.permissions = clonePermissionSet(MEMBER_PERMISSIONS);
        member.updatedAtMs = Date.now();
        this.syncAccountMemberSessions(targetSession.accountId, member);
      }
    } else {
      this.removeAnonymousAdministrator(targetSession.memberId);
    }
    const memberSessions = this.memberSessionRecords(targetSession.memberId);
    const nowMs = Date.now();
    for (const [tokenHash, session] of memberSessions) {
      this.removePresence(session.participantId, nowMs);
      this.removeSessionRecord(tokenHash);
    }
    await this.persist();
    return jsonResponse({
      snapshot: publicSnapshot(this.room, auth.session),
    });
  }

  async handleKickPhysicalPresence(request) {
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'members.manage',
    });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, 1024);
    if (parsed.response) return parsed.response;
    if (
      !hasExactKeys(parsed.value, ['targetParticipantId']) ||
      !OPAQUE_ID_RE.test(parsed.value.targetParticipantId || '')
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const target = this.room.presence.participants[parsed.value.targetParticipantId];
    if (!target) return errorResponse('PARTICIPANT_NOT_FOUND', 404);
    const targetSession = this.room.sessions[target.sessionHash];
    if (!targetSession) return errorResponse('PARTICIPANT_NOT_FOUND', 404);
    if (
      target.participantId === auth.session.participantId ||
      target.sessionHash === auth.tokenHash
    ) {
      return errorResponse('CANNOT_KICK_SELF', 409);
    }
    const isVerifiedAccountSibling =
      typeof auth.session.accountId === 'string' &&
      auth.session.accountId.length > 0 &&
      targetSession.accountId === auth.session.accountId &&
      auth.participant.accountId === auth.session.accountId &&
      target.accountId === targetSession.accountId &&
      auth.participant.memberId === auth.session.memberId &&
      target.memberId === targetSession.memberId &&
      targetSession.memberId === auth.session.memberId &&
      target.sessionHash !== auth.tokenHash;
    if (!isVerifiedAccountSibling && targetSession.role === 'owner') {
      return errorResponse('OWNER_AUTHORITY_IMMUTABLE', 409);
    }
    if (
      !isVerifiedAccountSibling &&
      auth.session.role !== 'owner' &&
      targetSession.role === 'controller'
    ) {
      return errorResponse('ADMINISTRATOR_TARGET_FORBIDDEN', 403);
    }

    // This endpoint is intentionally exact and transport-scoped. Sibling
    // sessions, the member directory, and delegated authority stay intact.
    this.removeSessionRecord(target.sessionHash);
    this.removePresence(target.participantId, Date.now());
    await this.persist();
    return jsonResponse({
      snapshot: publicSnapshot(this.room, auth.session),
    });
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
    auth.participant.developerControlVersion = developerControlVersion;
    const secret = String(this.env.PRO_SIGNALING_SECRET || '');
    if (secret.length < 32) return errorResponse('SERVICE_NOT_CONFIGURED', 503);
    const nowMs = Date.now();
    const role = 'member';
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
        ...proRoomGenerationWireFields(this.room.roomGeneration),
        participantId: auth.session.participantId,
        memberId: auth.session.memberId,
        displayName: signalingDisplayName(auth.session.displayName),
        role,
        coordinatorEpoch: this.room.presence.coordinatorEpoch,
        presenceIncarnationId,
        // The signaling Durable Object uses this signed revision together
        // with its latest authoritative presence snapshot to reject a ticket
        // issued before this participant was kicked, left, or superseded.
        presenceRevision: this.room.presence.revision,
        ticketSequence,
        jti: randomToken(18),
        iat: issuedAtSeconds,
        exp: expiresAtSeconds,
      },
      secret,
    );
    await this.persist();
    const pendingPlaybackTransition = this.room.pendingPlaybackTransition
      ? this.playbackPrepareEvent(this.room.pendingPlaybackTransition, nowMs)
      : null;
    return jsonResponse({
      ticket,
      expiresAtMs,
      role,
      coordinatorEpoch: this.room.presence.coordinatorEpoch,
      presenceIncarnationId,
      ticketSequence,
      pendingPlaybackTransition,
    });
  }

  async handlePlaybackCommand(request) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const key = this.readIdempotencyKey(request);
    if (!key) return errorResponse('IDEMPOTENCY_KEY_REQUIRED', 400);
    const parsed = await this.parseBody(request, 4 * 1024);
    if (parsed.response) return parsed.response;
    const command = parsePlaybackAuthorityCommand(parsed.value);
    if (!command) return errorResponse('INVALID_REQUEST', 400);
    // Every room-wide playback mutation, including media observations that
    // can advance or skip the queue, requires explicit playback authority.
    // Revision/media/clock fences make an authorized observation idempotent;
    // they are not proof that an ordinary member is entitled to mutate the
    // canonical timeline.
    if (!this.sessionHasPermission(auth.session, 'playback.control')) {
      return errorResponse('PERMISSION_REQUIRED', 403);
    }
    const scope = `participant:${auth.session.participantId}:playback-authority`;
    const fingerprint = await this.idempotencyFingerprint(scope, command);
    const replay = this.replayIdempotency(scope, key, fingerprint, auth.session, null);
    if (replay) return replay;

    const nowMs = Date.now();
    const result = this.applyPlaybackAuthorityCommand(command, nowMs);
    if (result.error) {
      return errorResponse(result.error, result.status, {
        'x-mxqr-playback-revision': String(this.room.playback.revision),
      });
    }
    const responseBody = {
      schemaVersion: 1,
      roomCode: this.room.roomCode,
      status: result.status,
      ...(result.status === 'preparing'
        ? {
            transition: this.playbackPrepareEvent(this.room.pendingPlaybackTransition, nowMs),
          }
        : {}),
      playback: structuredClone(this.room.playback),
      serverTimeMs: nowMs,
    };
    this.storeIdempotency(
      scope,
      key,
      fingerprint,
      responseBody,
      result.status === 'preparing' ? 202 : 200,
    );
    this.enqueuePlaybackOutcome(result, nowMs);
    await this.persist();
    return jsonResponse(responseBody, result.status === 'preparing' ? 202 : 200);
  }

  async handlePlaybackTransitionReady(request, transitionId) {
    const auth = await this.requireSession(request, { activePresence: true });
    if (auth.response) return auth.response;
    const parsed = await this.parseBody(request, 1024);
    if (parsed.response) return parsed.response;
    if (
      !PLAYBACK_TRANSITION_ID_RE.test(transitionId || '') ||
      !hasExactKeys(parsed.value, ['basePlaybackRevision', 'status']) ||
      !isSafeNonNegativeInteger(parsed.value.basePlaybackRevision) ||
      (parsed.value.status !== 'ready' && parsed.value.status !== 'failed')
    ) {
      return errorResponse('INVALID_REQUEST', 400);
    }
    const pending = this.room.pendingPlaybackTransition;
    if (!pending || pending.transitionId !== transitionId) {
      return errorResponse('PLAYBACK_TRANSITION_NOT_FOUND', 404);
    }
    if (
      pending.coordinatorEpoch !== this.room.presence.coordinatorEpoch ||
      pending.basePlaybackRevision !== parsed.value.basePlaybackRevision ||
      pending.basePlaybackRevision !== this.room.playback.revision
    ) {
      return errorResponse('PLAYBACK_TRANSITION_STALE', 409);
    }
    const incarnationId = auth.participant.presenceIncarnationId;
    if (!pending.cohort.includes(incarnationId)) {
      return errorResponse('PLAYBACK_TRANSITION_NOT_IN_COHORT', 409);
    }
    const previous = pending.ready[incarnationId];
    if (previous && previous !== parsed.value.status) {
      return errorResponse('PLAYBACK_READY_CONFLICT', 409);
    }
    pending.ready[incarnationId] = parsed.value.status;
    auth.participant.lastSeenAtMs = Date.now();
    // A readiness report is final for this immutable cohort: conflicting
    // replacements are rejected above. Once every participant has answered,
    // waiting out the remainder of the fixed deadline cannot make a failed
    // endpoint ready; it only stalls the endpoints that did prepare. Commit
    // immediately and let failed endpoints catch up from the canonical
    // checkpoint. A participant that has not reported still keeps the bounded
    // deadline behavior unchanged.
    const allReported = playbackTransitionCohortIsTerminal(pending);
    let committed = null;
    if (allReported) committed = this.commitPendingPlaybackTransition(Date.now());
    this.enqueuePlaybackOutcome(committed);
    await this.persist();
    return jsonResponse({
      ok: true,
      transitionId,
      status: committed?.event ? 'committed' : 'waiting',
      playbackRevision: this.room.playback.revision,
    });
  }

  readIdempotencyKey(request) {
    const key = request.headers.get('idempotency-key') || '';
    return IDEMPOTENCY_KEY_RE.test(key) ? key : null;
  }

  async idempotencyFingerprint(scope, body) {
    return sha256Base64Url(`${scope}\n${JSON.stringify(body)}`);
  }

  idempotencyLedger(scope) {
    return scope.startsWith('developer:')
      ? {
          records: this.room.developerMutationIdempotency,
          maxItems: DEVELOPER_MUTATION_IDEMPOTENCY_MAX_ITEMS,
        }
      : { records: this.room.idempotency, maxItems: IDEMPOTENCY_MAX_ITEMS };
  }

  idempotencyExpiresAt(storageKey, record) {
    if (!storageKey.includes(PLAYBACK_IDEMPOTENCY_SCOPE_SEGMENT)) {
      return record.expiresAtMs;
    }
    if (record.kind === 'playback-authority') return record.expiresAtMs;
    // Legacy playback receipts have no kind marker and were written with the
    // former 24-hour TTL. Derive their original creation time so this rollout
    // immediately releases already-saturated rooms instead of waiting up to a
    // day for the old absolute expiry.
    return Math.min(
      record.expiresAtMs,
      record.expiresAtMs - IDEMPOTENCY_TTL_MS + PLAYBACK_IDEMPOTENCY_TTL_MS,
    );
  }

  idempotencyRecordIsExpired(storageKey, record, nowMs = Date.now()) {
    return this.idempotencyExpiresAt(storageKey, record) <= nowMs;
  }

  idempotencyRecord(scope, key) {
    const storageKey = `${scope}:${key}`;
    const { records } = this.idempotencyLedger(scope);
    // During the additive ledger migration, a receipt written by the previous
    // Worker may still live in the shared map. Read it until its ordinary TTL
    // expires so a retry spanning deployment cannot duplicate a mutation.
    const primary = records[storageKey];
    if (primary) {
      if (!this.idempotencyRecordIsExpired(storageKey, primary)) return primary;
      delete records[storageKey];
    }
    const legacyDeveloper = scope.startsWith('developer:')
      ? this.room.idempotency[storageKey]
      : undefined;
    if (!legacyDeveloper) return undefined;
    if (!this.idempotencyRecordIsExpired(storageKey, legacyDeveloper)) return legacyDeveloper;
    delete this.room.idempotency[storageKey];
    return undefined;
  }

  reserveIdempotencySlot(scope, key, nowMs = Date.now()) {
    const storageKey = `${scope}:${key}`;
    const { records, maxItems } = this.idempotencyLedger(scope);
    for (const [recordKey, record] of Object.entries(records)) {
      if (this.idempotencyRecordIsExpired(recordKey, record, nowMs)) delete records[recordKey];
    }
    if (records[storageKey] !== undefined) return records;
    if (Object.keys(records).length >= maxItems) {
      // An unexpired receipt is a durable exactly-once fence. Never trade it
      // for availability: the outer mutation checkpoint rolls back the new
      // action and returns a bounded capacity response.
      throw new RoomStateCapacityError();
    }
    return records;
  }

  replayIdempotency(scope, key, fingerprint, session = null, developerRequesterKeyId = null) {
    const record = this.idempotencyRecord(scope, key);
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
    const records = this.reserveIdempotencySlot(scope, key);
    const playbackAuthority = scope.endsWith(':playback-authority');
    records[`${scope}:${key}`] = {
      fingerprint,
      body: structuredClone(body),
      status,
      ...(playbackAuthority ? { kind: 'playback-authority' } : {}),
      expiresAtMs: playbackAuthority
        ? Math.min(expiresAtMs, Date.now() + PLAYBACK_IDEMPOTENCY_TTL_MS)
        : expiresAtMs,
    };
  }

  storeSnapshotIdempotency(scope, key, fingerprint, committedRevision) {
    const records = this.reserveIdempotencySlot(scope, key);
    records[`${scope}:${key}`] = {
      fingerprint,
      kind: 'snapshot',
      committedRevision,
      status: 200,
      expiresAtMs: Date.now() + IDEMPOTENCY_TTL_MS,
    };
  }

  storeDeveloperQueueIdempotency(scope, key, fingerprint, status) {
    const records = this.reserveIdempotencySlot(scope, key);
    records[`${scope}:${key}`] = {
      fingerprint,
      kind: 'developer-queue',
      status,
      expiresAtMs: Date.now() + IDEMPOTENCY_TTL_MS,
    };
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

  async handleCompactSnapshotMutation(request) {
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'queue.mutate',
    });
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
    const replay = this.replayIdempotency(scope, key, fingerprint, auth.session, null);
    if (replay) return replay;
    if (!isSafeNonNegativeInteger(body.baseRevision)) return errorResponse('INVALID_REVISION', 400);
    if (body.baseRevision !== this.room.revision) {
      // Keep the CAS error envelope bounded. The following explicit GET is
      // authoritative and can carry a multi-megabyte playlist safely.
      return errorResponse('REVISION_CONFLICT', 409);
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
    for (const item of parsedPlaylist) {
      const previous = previousPlaylistById.get(item.queueItemId);
      if (previous && !preservesImmutableYouTubeManifest(previous, item)) {
        return errorResponse('PLAYLIST_MANIFEST_IMMUTABLE', 409);
      }
    }
    const playlist = parsedPlaylist.map((item) => {
      const existingOwnerKeyId = previousPlaylistById.get(item.queueItemId)?.developerOwnerKeyId;
      return DEVELOPER_API_KEY_ID_RE.test(existingOwnerKeyId || '')
        ? { ...item, developerOwnerKeyId: existingOwnerKeyId }
        : item;
    });
    const addedItems = playlist.filter((item) => !previousPlaylistById.has(item.queueItemId));
    const addedCount = addedItems.length;
    if (addedCount > 0 && !this.sessionHasPermission(auth.session, 'media.add')) {
      return errorResponse('PERMISSION_REQUIRED', 403);
    }
    if (auth.session.role !== 'owner') {
      const changesExistingItem = playlist.some((item) => {
        const previous = previousPlaylistById.get(item.queueItemId);
        return (
          previous !== undefined &&
          JSON.stringify(publicPlaylistItem(previous)) !== JSON.stringify(publicPlaylistItem(item))
        );
      });
      // Media managers may add, remove, and reorder queue entries. Mutating an
      // existing item's canonical metadata/source remains owner-only because
      // it is outside the four-permission UI contract.
      if (changesExistingItem) {
        return errorResponse('OWNER_REQUIRED', 403);
      }
    }
    const playlistById = new Map(playlist.map((item) => [item.queueItemId, item]));
    const playbackItem =
      this.room.playback.queueItemId === null
        ? null
        : playlistById.get(this.room.playback.queueItemId) || null;
    if (playbackItem && !playbackMatchesYouTubeManifest(this.room.playback, playbackItem)) {
      return errorResponse('PLAYLIST_MANIFEST_PLAYBACK_CONFLICT', 409);
    }
    const pendingTarget = this.room.pendingPlaybackTransition?.target;
    const pendingItem =
      pendingTarget?.queueItemId == null
        ? null
        : playlistById.get(pendingTarget.queueItemId) || null;
    if (
      pendingTarget &&
      pendingItem &&
      !playbackMatchesYouTubeManifest(pendingTarget, pendingItem)
    ) {
      return errorResponse('PLAYLIST_MANIFEST_PLAYBACK_CONFLICT', 409);
    }
    if (
      currentQueueItemId !== null &&
      (!QUEUE_ITEM_ID_RE.test(currentQueueItemId) || !playlistById.has(currentQueueItemId))
    ) {
      return errorResponse('INVALID_QUEUE_ITEM_ID', 400);
    }
    const nowMs = Date.now();
    const canonicalQueueItemId = this.room.currentQueueItemId;
    const canonicalSurvives =
      canonicalQueueItemId !== null && playlistById.has(canonicalQueueItemId);
    if (
      (canonicalSurvives && currentQueueItemId !== canonicalQueueItemId) ||
      (!canonicalSurvives && currentQueueItemId !== null)
    ) {
      return errorResponse('PLAYBACK_COMMAND_REQUIRED', 409);
    }
    // The field stays in the queue-mutation request during the cutover, but
    // it is observation-only. Only /playback/commands may change playback.
    if (playbackInput !== null && typeof playbackInput !== 'object') {
      return errorResponse('INVALID_PLAYBACK', 400);
    }
    if (!this.validatePlaylistAssets(playlist)) return errorResponse('ASSET_NOT_READY', 409);
    let playback = this.room.playback;
    let playbackCleared = false;
    let pendingCancelEvent = null;
    if (!canonicalSurvives && canonicalQueueItemId !== null) {
      const target = this.targetPlayback(null, 'idle', 0, nowMs);
      if (!target) return errorResponse('PLAYBACK_REVISION_EXHAUSTED', 409);
      pendingCancelEvent = this.cancelPendingPlayback('queue-item-removed', nowMs);
      playback = target;
      playbackCleared = true;
    }

    const playlistChanged = JSON.stringify(playlist) !== JSON.stringify(this.room.playlist);
    this.room.playlist = playlist;
    this.room.currentQueueItemId = canonicalSurvives ? canonicalQueueItemId : null;
    this.room.playback = playback;
    if (
      this.room.pendingPlaybackTransition?.target.queueItemId != null &&
      !playlistById.has(this.room.pendingPlaybackTransition.target.queueItemId)
    ) {
      pendingCancelEvent = this.cancelPendingPlayback('queue-item-removed', nowMs);
    }
    this.reconcileAssetGarbageCollection(nowMs);
    if (playlistChanged) {
      reconcileQueueModePlaylist(this.room, nowMs);
      this.room.playlistRevision += 1;
    }
    this.room.revision += 1;
    const responseBody = {
      snapshot: publicSnapshot(this.room, auth.session),
    };
    this.storeSnapshotIdempotency(scope, key, fingerprint, this.room.revision);
    if (pendingCancelEvent) this.enqueuePlaybackBroadcast(pendingCancelEvent);
    if (playbackCleared) {
      this.enqueuePlaybackBroadcast(
        this.playbackCommitEvent(null, this.room.playback.updatedAtMs, nowMs),
      );
    }
    await this.persist();
    await this.broadcastServerEvent(
      this.invalidationEvent({
        playlistRevision: this.room.playlistRevision,
        ...(playbackCleared ? { playbackRevision: this.room.playback.revision } : {}),
      }),
    );
    if (addedCount > 0) {
      this.scheduleDeveloperInvalidationHint({
        actorName: auth.session.displayName,
        fallback: 'Peer',
        count: addedCount,
        firstTitle: addedItems[0]?.title || addedItems[0]?.name,
      });
    }
    return jsonResponse(responseBody);
  }

  async handleCreateReservation(request) {
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'asset.upload',
    });
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
    const objectPrefix = `${proRoomMediaPrefix(
      this.room.roomCode,
      this.room.roomGeneration,
    )}/assets/${assetId}/v${version}`;
    const stagingObjectKey = `${objectPrefix}/staging_${randomToken(18)}`;
    const objectKey = `${objectPrefix}/object_${randomToken(24)}`;
    const expiresAtMs = nowMs + this.reservationTtlSeconds() * 1000;
    const uploadHeaders = {
      'content-type': body.mime,
      'x-amz-meta-mxqr-room': this.room.roomCode,
      ...proRoomGenerationUploadMetadataHeaders(this.room.roomGeneration),
      'x-amz-meta-mxqr-asset': assetId,
      'x-amz-meta-mxqr-version': String(version),
      'x-amz-meta-mxqr-bytes': String(body.byteLength),
      ...(body.sha256 === undefined ? {} : { 'x-amz-meta-mxqr-sha256': body.sha256 }),
    };
    // Content-Length is a forbidden browser request header: XHR supplies it
    // from the Blob body and application code cannot set it. Bind that
    // browser-generated value into SigV4 without returning it in the header
    // list that the client applies manually.
    const signedUploadHeaders = {
      'content-length': String(body.byteLength),
      ...uploadHeaders,
    };
    const presignTtl = Math.min(
      this.reservationTtlSeconds(),
      configuredNumber(this.env.PRESIGN_TTL_SECONDS, PRESIGN_TTL_SECONDS, 60, 3600),
    );
    const uploadUrl = await createR2PresignedUrl({
      env: this.env,
      method: 'PUT',
      objectKey: stagingObjectKey,
      headers: signedUploadHeaders,
      expiresInSeconds: presignTtl,
      now: new Date(nowMs),
    });
    if (!uploadUrl) return errorResponse('MEDIA_NOT_CONFIGURED', 503);

    this.room.assets[assetId] = {
      status: 'reserved',
      assetId,
      roomGeneration: this.room.roomGeneration,
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
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'asset.upload',
    });
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
    const assetRoomGeneration = asset.roomGeneration;
    if (assetRoomGeneration !== this.room.roomGeneration) {
      return errorResponse('ROOM_STATE_INVALID', 503);
    }
    const finalMetadata = {
      'mxqr-room': this.room.roomCode,
      'mxqr-generation': String(assetRoomGeneration),
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
        Object.entries(finalMetadata).every(
          ([metadataKey, metadataValue]) => metadata[metadataKey] === metadataValue,
        ) &&
        (asset.sha256 !== undefined || metadata['mxqr-sha256'] === undefined)
      );
    };

    let stagingObject;
    let finalObject;
    try {
      [stagingObject, finalObject] = await Promise.all([
        this.env.PRO_MEDIA_BUCKET.head(asset.stagingObjectKey),
        this.env.PRO_MEDIA_BUCKET.head(asset.objectKey),
      ]);
    } catch {
      return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
    }

    // A prior completion may have created and verified the immutable final
    // object, then lost the Durable Object commit or response. Treat that exact
    // object as the recovery source instead of requiring staging to survive.
    if (!objectMatchesReservation(finalObject) && !stagingObject) {
      return errorResponse('UPLOAD_INCOMPLETE', 409);
    }
    if (!objectMatchesReservation(finalObject) && !objectMatchesReservation(stagingObject)) {
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
          customMetadata: finalMetadata,
        });
        finalObject = await this.env.PRO_MEDIA_BUCKET.head(asset.objectKey);
      } catch {
        // Keep both keys. R2 PUT is atomic and a retry can verify/recover an
        // already-created final object even when the post-PUT HEAD failed.
        return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
      }
      if (!objectMatchesReservation(finalObject)) {
        await this.env.PRO_MEDIA_BUCKET.delete(asset.objectKey).catch(() => {});
        return errorResponse('MEDIA_STORAGE_UNAVAILABLE', 503);
      }
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
    // Commit metadata and idempotency before deleting the only client-uploaded
    // copy. If cleanup is interrupted, alarm GC retries via
    // stagingCleanupAfterMs; if persistence failed, the next completion can
    // recover from the verified final object above.
    const cleanup = this.env.PRO_MEDIA_BUCKET.delete(asset.stagingObjectKey).catch(() => {});
    if (typeof this.state.waitUntil === 'function') this.state.waitUntil(cleanup);
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
    const auth = await this.requireSession(request, {
      activePresence: true,
      capability: 'asset.upload',
    });
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
    let playbackTransitionOutcome = null;
    let changed =
      this.systemAudioMigrationPending ||
      this.effectsMigrationPending ||
      this.queueModeMigrationPending ||
      this.accountIdentityMigrationPending ||
      this.developerCommandMigrationPending ||
      this.playbackAuthorityMigrationPending ||
      this.reconcileSystemAudio(nowMs);
    if (
      this.room.pendingPlaybackTransition &&
      this.room.pendingPlaybackTransition.deadlineAtMs <= nowMs
    ) {
      playbackTransitionOutcome = this.commitPendingPlaybackTransition(nowMs);
      changed = true;
    }
    // YouTube-only rooms have no ready R2 assets and therefore need no
    // playlist reference scan. Rooms with ready media compute the set once and
    // reuse it for both marker repair and the due-GC safety check below.
    const hasReadyAssets = Object.values(this.room.assets).some(
      (asset) => asset.status === 'ready',
    );
    const referencedAssets = hasReadyAssets ? this.referencedAssetIds() : new Set();
    changed = this.reconcileAssetGarbageCollection(nowMs, referencedAssets) || changed;
    let accountLeasePresenceChanged = false;
    for (const [tokenHash, session] of Object.entries(this.room.sessions)) {
      if (
        session.expiresAtMs <= nowMs ||
        session.authEpoch !== this.room.authEpoch ||
        session.roomGeneration !== this.room.roomGeneration
      ) {
        changed = this.removePresence(session.participantId, nowMs) || changed;
        changed = this.removeSessionRecord(tokenHash) || changed;
        changed = true;
        continue;
      }
      if (
        session.accountId &&
        (!Number.isSafeInteger(session.accountLeaseExpiresAtMs) ||
          session.accountLeaseExpiresAtMs <= nowMs)
      ) {
        const detached = this.detachAccountSession(session, nowMs);
        if (detached) {
          changed = true;
          accountLeasePresenceChanged =
            accountLeasePresenceChanged || detached.participant !== null;
        }
      }
    }
    for (const participant of Object.values(this.room.presence.participants)) {
      if (participant.lastSeenAtMs + this.presenceTtlMs() <= nowMs) {
        changed = this.removePresence(participant.participantId, nowMs) || changed;
      }
    }
    if (accountLeasePresenceChanged) this.scheduleServerEvent(this.presenceEvent());
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
      if (this.idempotencyRecordIsExpired(key, record, nowMs)) {
        delete this.room.idempotency[key];
        changed = true;
      }
    }
    for (const [key, record] of Object.entries(this.room.developerMutationIdempotency)) {
      if (record.expiresAtMs <= nowMs) {
        delete this.room.developerMutationIdempotency[key];
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
        const quietWindowComplete = await this.advanceStagingObjectCleanup(
          tombstone,
          tombstone.objectKey,
          nowMs,
        );
        if (quietWindowComplete) delete this.room.stagingTombstones[assetId];
        changed = true;
      } catch {
        delete tombstone.emptySinceMs;
        tombstone.cleanupAfterMs = nowMs + ASSET_GC_RETRY_SECONDS * 1000;
        changed = true;
      }
    }
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
            const quietWindowComplete = await this.advanceStagingObjectCleanup(
              asset,
              asset.stagingObjectKey,
              nowMs,
              'stagingCleanupAfterMs',
              'stagingEmptySinceMs',
            );
            if (quietWindowComplete) {
              delete asset.stagingObjectKey;
              delete asset.stagingCleanupAfterMs;
              delete asset.stagingEmptySinceMs;
              delete asset.uploadExpiresAtMs;
            }
            changed = true;
          } catch {
            delete asset.stagingEmptySinceMs;
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
    for (const [key, value] of Object.entries(this.room.botRateLimits)) {
      if (value.resetAtMs <= nowMs) {
        delete this.room.botRateLimits[key];
        changed = true;
      }
    }
    for (const [nonceHash, expiresAtMs] of Object.entries(this.room.consumedRecoveryNonces)) {
      if (expiresAtMs <= nowMs) {
        delete this.room.consumedRecoveryNonces[nonceHash];
        changed = true;
      }
    }
    for (const [nonceHash, record] of Object.entries(
      this.room.consumedOwnershipTransferClaims || {},
    )) {
      if (record.expiresAtMs <= nowMs) {
        delete this.room.consumedOwnershipTransferClaims[nonceHash];
        changed = true;
      }
    }
    changed = this.pruneAccountDeletionTombstones(nowMs) || changed;
    this.enqueuePlaybackOutcome(playbackTransitionOutcome, nowMs);
    if (changed) {
      await this.persist();
      this.systemAudioMigrationPending = false;
      this.effectsMigrationPending = false;
      this.queueModeMigrationPending = false;
      this.accountIdentityMigrationPending = false;
      this.developerCommandMigrationPending = false;
      this.playbackAuthorityMigrationPending = false;
    }
    return changed;
  }

  async alarm() {
    if ((await readServiceMaintenance(this.env)).enabled) {
      if (typeof this.storage.setAlarm === 'function') {
        const retryAtMs = Date.now() + 60_000;
        try {
          await this.storage.setAlarm(retryAtMs);
          this.scheduledAlarmMs = retryAtMs;
        } catch {
          // A later request or control-plane recovery can install the next
          // ordinary alarm. Maintenance still fails closed for room mutation.
        }
      }
      return;
    }
    await this.withMutation(async () => {
      // Cloudflare removes the due alarm before invoking this callback. Clear
      // the in-memory hint so scheduleAlarm() can install the next deadline.
      this.scheduledAlarmMs = null;
      if (this.ready) await this.ready;
      if (!this.room) await this.loadRoomFromStorage();
      if (!this.room) return;
      this.normalizeLoadedSystemAudio();
      this.normalizeLoadedEffects();
      this.normalizeLoadedQueueMode();
      this.normalizeLoadedOwnershipTransfer();
      this.normalizeLoadedDeveloperCommands();
      this.normalizeLoadedSecurityLedgers();
      this.normalizeLoadedPlaybackAuthority();
      this.normalizeLoadedPlaybackBroadcasts();
      this.normalizeLoadedPresenceBroadcast();
      const nowMs = Date.now();
      await this.prune(nowMs);
      if (this.heartbeatDurabilityDirty) {
        try {
          await this.persist();
        } catch {
          await this.scheduleHeartbeatPersistRetryAlarm();
          return;
        }
      }
      await this.retryPendingPresenceBroadcast(nowMs);
      await this.flushPendingPlaybackBroadcasts(nowMs);
      await this.maintainAlarm();
    });
  }
}
