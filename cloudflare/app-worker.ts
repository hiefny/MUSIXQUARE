// MUSIXQUARE-authored file: AGPLv3 section 7 terms are in ADDITIONAL_TERMS.md; trademark use is addressed separately in TRADEMARKS.md.
import { handleProBotRequest } from './pro-bot.ts';
import {
  cleanupPendingAccountDeletions,
  cleanupExpiredAccountSessions,
  handleAccountAuthRequest,
  isAccountAuthConfigured,
  recordAccountProRoomLink,
  retireAccountProRoomLinkForAccount,
  retireAccountProRoomLinkBatch,
  retireAccountProRoomLinks,
  resolveAccountSession,
} from './account-auth.ts';
import {
  ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
  ACCOUNT_ASSERTION_HEADER,
  createAccountAssertion,
} from './account-assertion.ts';
import {
  INITIAL_PRO_ROOM_GENERATION,
  MAX_PRO_ROOM_GENERATION,
  isProRoomGeneration,
  proRoomGenerationHeaderValue,
  proRoomObjectName,
} from './pro-room-generation.ts';
import { issueProRoomOwnerTransferRevocationReceipt } from './pro-room-claims.ts';
import {
  consumeAbuseRateLimit,
  consumeAbuseRateLimitPair,
  readAdminAnnouncementControl,
  readCachedServiceMaintenance,
  readServiceMaintenance,
  serviceMaintenancePreviewResponse,
  serviceMaintenanceResponse,
  ServiceMaintenanceState,
  updateAdminAnnouncementControl,
  updateServiceMaintenance,
} from './service-maintenance.ts';
import { accountNicknameKey, normalizeAccountNickname } from './account-nickname.ts';
import {
  abortProRoomOwnershipTransferEntitlement,
  authorizeProGrantActivation,
  canAccountReceiveProRoomEntitlement,
  finalizeProGrantActivation,
  finalizeProRoomOwnershipTransferEntitlement,
  handleProGrantAdminRequest,
  handleProGrantPublicRequest,
  hasReservedProGrantAllocation,
  markProRoomOwnerEntitlementBackfillComplete,
  canOrphanProRoomOwnerEntitlement,
  orphanProRoomOwnerEntitlement,
  orphanAccountProGrants,
  reconcileProGrantLifecycle,
  reserveProRoomOwnershipTransferEntitlement,
  revokeProRoomEntitlement,
  upsertProRoomOwnerEntitlement,
} from './pro-room-grants.ts';

interface AppExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface AppKvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface AppR2HttpMetadata {
  contentType?: string;
  cacheControl?: string;
}

interface AppR2Object {
  readonly customMetadata?: Record<string, string>;
  readonly httpMetadata?: AppR2HttpMetadata;
  readonly httpEtag?: string;
}

interface AppR2ObjectBody extends AppR2Object {
  readonly body: ReadableStream<Uint8Array>;
}

interface AppR2Bucket {
  head(key: string): Promise<AppR2Object | null>;
  get(key: string): Promise<AppR2ObjectBody | null>;
  put(
    key: string,
    value: Uint8Array,
    options?: {
      httpMetadata?: AppR2HttpMetadata;
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
}

interface AppAssetFetcher {
  fetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch>;
}

interface AppD1ResultMeta {
  changes?: number | null;
  [key: string]: unknown;
}

interface AppD1Result<T = Record<string, unknown>> {
  results: T[];
  success?: boolean;
  meta?: AppD1ResultMeta;
  error?: string;
}

interface AppD1PreparedStatement {
  bind(...values: unknown[]): AppD1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<AppD1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<AppD1Result<T>>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}

interface AppD1Database {
  prepare(query: string): AppD1PreparedStatement;
  batch<T = Record<string, unknown>>(
    statements: AppD1PreparedStatement[],
  ): Promise<AppD1Result<T>[]>;
}

type D1Database = AppD1Database;
type D1PreparedStatement = AppD1PreparedStatement;
type D1Result<T = Record<string, unknown>> = AppD1Result<T>;

interface AppDurableObjectId {
  equals?(other: AppDurableObjectId): boolean;
}

interface AppDurableObjectStub {
  fetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch>;
}

interface AppDurableObjectNamespace {
  idFromName(name: string): AppDurableObjectId;
  get(id: AppDurableObjectId): AppDurableObjectStub;
}

interface AppServiceFetcher {
  fetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch>;
}

interface AppRateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface AppConfiguredBindings {
  SORO_RSS_BACKUP: AppKvNamespace;
  SORO_IMAGE_BUCKET: AppR2Bucket;
  MUSIXQUARE_ADMIN_DB: D1Database;
  DEVELOPER_API_DB: D1Database;
  MUSIXQUARE_AUTH_DB: D1Database;
  MXQR_CAPABILITY_POW_ROOM_PRESSURE: AppRateLimitBinding;
  MXQR_CAPABILITY_POW_GENERAL_PRESSURE: AppRateLimitBinding;
  ASSETS: AppAssetFetcher;
  YOUTUBE_SEARCH_MAX_RESULTS: string;
  YOUTUBE_SAFE_SEARCH: string;
  GEMINI_BOT_MODEL: string;
  CLOUDFLARE_TURN_TTL: string;
  MXQR_TURNSTILE_DISABLED: string;
  MXQR_CAPABILITY_POW_ADAPTIVE_ENABLED: string;
  MXQR_CAPABILITY_POW_ADAPTIVE_MAX_DIFFICULTY: string;
  PRO_ROOM_ADMIN_ROOMS: AppDurableObjectNamespace;
  MUSIXQUARE_SERVICE_CONTROL: AppDurableObjectNamespace;
  PRO_SIGNALING_ROOMS: AppDurableObjectNamespace;
  PRO_ROOM_PUBLIC_API: AppServiceFetcher;
}

interface AppEnv extends Partial<AppConfiguredBindings> {
  ADMIN_METRICS_DB?: D1Database;
  MUSIXQUARE_ADMIN_CONFIG?: AppKvNamespace;
  ADMIN_PASSWORD?: string;
  ADMIN_SESSION_SECRET?: string;
  ALLOW_UNGUARDED_PAID_APIS?: string;
  CAPABILITY_HMAC_SECRET?: string;
  CAPABILITY_POW_DIFFICULTY?: string;
  CAPABILITY_POW_TTL?: string;
  CAPABILITY_SECRET?: string;
  CAPABILITY_TTL?: string;
  CF_TURN_API_TOKEN?: string;
  CF_TURN_KEY_ID?: string;
  CF_TURN_TTL?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_CALLS_API_TOKEN?: string;
  CLOUDFLARE_CALLS_APP_ID?: string;
  CLOUDFLARE_CALLS_APP_SECRET?: string;
  CLOUDFLARE_REALTIME_API_TOKEN?: string;
  CLOUDFLARE_REALTIME_APP_ID?: string;
  CLOUDFLARE_REALTIME_APP_SECRET?: string;
  CLOUDFLARE_SFU_API_TOKEN?: string;
  CLOUDFLARE_SFU_APP_ID?: string;
  CLOUDFLARE_SFU_APP_SECRET?: string;
  CLOUDFLARE_TURNSTILE_SECRET_KEY?: string;
  CLOUDFLARE_TURNSTILE_SITE_KEY?: string;
  CLOUDFLARE_TURN_API_TOKEN?: string;
  CLOUDFLARE_TURN_KEY_ID?: string;
  CORS_ALLOWED_ORIGINS?: string;
  DISABLE_TURNSTILE?: string;
  MXQR_ADMIN_PASSWORD?: string;
  MXQR_ADMIN_SESSION_SECRET?: string;
  MXQR_ALLOW_UNGUARDED_PAID_APIS?: string;
  MXQR_CAPABILITY_POW_DIFFICULTY?: string;
  MXQR_CAPABILITY_POW_TTL?: string;
  MXQR_CAPABILITY_SECRET?: string;
  MXQR_CAPABILITY_TTL?: string;
  MXQR_DEVELOPER_API_KEY_PEPPER?: string;
  MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET?: string;
  MXQR_TURNSTILE_ALLOWED_HOSTNAMES?: string;
  SORO_RSS_URL?: string;
  TRUSTED_CORS_ORIGINS?: string;
  TURNSTILE_ALLOWED_HOSTNAMES?: string;
  TURNSTILE_DISABLED?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  YOUTUBE_API_KEY?: string;
  YOUTUBE_DATA_API_KEY?: string;
  YOUTUBE_REGION_CODE?: string;
  YOUTUBE_RELEVANCE_LANGUAGE?: string;
}
type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAppEnv(value: unknown): value is AppEnv {
  return isJsonObject(value);
}

function isAppD1Database(value: unknown): value is AppD1Database {
  return isJsonObject(value) && typeof value.prepare === 'function';
}

type BodyReadError = 'invalid' | 'too-large' | 'timeout' | 'aborted';
type BodyReadResult =
  | { body: Uint8Array | null; error?: undefined }
  | { error: BodyReadError; body?: undefined };
type JsonBodyReadResult =
  | { value: unknown; error?: undefined }
  | { error: BodyReadError; value?: undefined };

const YOUTUBE_SEARCH_API = 'https://www.googleapis.com/youtube/v3/search';
const YOUTUBE_PLAYLIST_ITEMS_API = 'https://www.googleapis.com/youtube/v3/playlistItems';
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS = 5_000;
const YOUTUBE_PLAYLIST_MANIFEST_PAGE_SIZE = 50;
const YOUTUBE_PLAYLIST_MANIFEST_TIMEOUT_MS = 45_000;
const UPSTREAM_JSON_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const UPSTREAM_JSON_TIMEOUT_MS = 10_000;
const TURNSTILE_RESPONSE_MAX_BYTES = 64 * 1024;
const REALTIME_API_BASE = 'https://rtc.live.cloudflare.com/v1';
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_LIMIT = 12;
const QUERY_MAX_LENGTH = 120;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const CLOUDFLARE_TURN_TTL_DEFAULT = 48 * MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
const CLOUDFLARE_TURN_TTL_MIN = 60;
const CLOUDFLARE_TURN_TTL_MAX = CLOUDFLARE_TURN_TTL_DEFAULT;
const CAPABILITY_POW_DIFFICULTY_DEFAULT = 12;
const CAPABILITY_TOKEN_TTL_DEFAULT = 10 * SECONDS_PER_MINUTE;
const CAPABILITY_TOKEN_TTL_MIN = 3 * SECONDS_PER_MINUTE;
const CAPABILITY_TOKEN_TTL_MAX = 30 * SECONDS_PER_MINUTE;
const CAPABILITY_SCOPES = new Set(['turn', 'realtime', 'youtube-search', 'remote-share']);
const CAPABILITY_TOKEN_MAX_LENGTH = 512;
const CAPABILITY_TOKEN_PAYLOAD_RE = /^[A-Za-z0-9_-]+$/;
const CAPABILITY_TOKEN_SIGNATURE_RE = /^[A-Za-z0-9_-]{43}$/;
const CAPABILITY_POW_DIFFICULTY_MIN = 8;
const CAPABILITY_POW_DIFFICULTY_MAX = 24;
const CAPABILITY_POW_TTL_DEFAULT = 2 * SECONDS_PER_MINUTE;
const CAPABILITY_POW_TTL_MIN = 30;
const CAPABILITY_POW_TTL_MAX = 5 * SECONDS_PER_MINUTE;
const CAPABILITY_POW_ADAPTIVE_MAX_DELTA_DEFAULT = 4;
const CAPABILITY_POW_ROOM_PRESSURE_BINDING = 'MXQR_CAPABILITY_POW_ROOM_PRESSURE';
const CAPABILITY_POW_GENERAL_PRESSURE_BINDING = 'MXQR_CAPABILITY_POW_GENERAL_PRESSURE';
const CAPABILITY_JSON_BODY_MAX_BYTES = 8 * 1024;
const ADMIN_JSON_BODY_MAX_BYTES = 8 * 1024;
const REALTIME_JSON_BODY_MAX_BYTES = 128 * 1024;
const PUBLIC_JSON_BODY_TIMEOUT_MS = 10_000;
const HMAC_SECRET_MIN_LENGTH = 32;
// One venue can legitimately place 100 browsers behind one public IP. Keep
// paid-resource room bursts separate from the default API limits and retain a
// per-capability/session limiter below so one browser cannot consume the burst.
const ROOM_BURST_CAPABILITY_LIMIT = 300;
const ROOM_BURST_TURN_LIMIT = 150;
const ROOM_BURST_REALTIME_NEW_SESSION_LIMIT = 250;
const ROOM_BURST_REALTIME_MUTATION_LIMIT = 650;
const REALTIME_NEW_SESSION_PER_CAPABILITY_LIMIT = 4;
const REALTIME_MUTATION_PER_CAPABILITY_LIMIT = 12;
const REALTIME_MUTATION_PER_SESSION_LIMIT = 8;
// Realtime session ownership is a separate, least-privilege capability. The
// general `realtime` capability only permits creating an SFU session; it must
// never be enough to mutate an arbitrary session ID learned from a peer.
const REALTIME_SESSION_CAPABILITY_TTL = 24 * MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
const REALTIME_SESSION_ID_MAX_LENGTH = 256;
const REALTIME_SESSION_CAPABILITY_MAX_LENGTH = 2048;
const TURNSTILE_VERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SORO_RSS_DEFAULT_URL = 'https://app.trysoro.com/api/rss/a07c133f-e3b9-401e-a076-ee36124598a7';
const SORO_RSS_BACKUP_KEY = 'soro-rss-latest-good.xml';
const SORO_RSS_BACKUP_META_KEY = 'soro-rss-latest-good.meta.json';
const SORO_HIDDEN_SLUGS_KEY = 'soro-hidden-slugs.json';
const SORO_BLOG_CACHE_VERSION_KEY = 'soro-blog-cache-version.json';
const ADMIN_ANNOUNCEMENT_KEY = 'admin-announcement.json';
const ADMIN_ANNOUNCEMENT_HISTORY_KEY = 'admin-announcement-history.json';
const ADMIN_ANNOUNCEMENT_HISTORY_LIMIT = 100;
const ADMIN_ANNOUNCEMENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ADMIN_MAINTENANCE_PREVIEW_PATH = '/admin/maintenance-preview';
const ADMIN_ASSET_VERSION = '8.4.7';
const SORO_RSS_MAX_BYTES = 20 * 1024 * 1024;
const SORO_RSS_FETCH_TIMEOUT_MS = 2500;
const SORO_BACKGROUND_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;
const SORO_BLOG_HTML_CACHE = 'no-store, max-age=0, must-revalidate';
const APP_SHELL_FRESH_CACHE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
});
const EVENT_CAMPAIGN_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const EVENT_PAGE_ASSET_PATH = '/events/index.html';
const SORO_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const SORO_IMAGE_FETCH_TIMEOUT_MS = 5000;
const SORO_IMAGE_ROUTE_PREFIX = '/soro-images/';
const SORO_IMAGE_R2_PREFIX = 'featured/';
const SORO_IMAGE_CACHE = 'public, max-age=31536000, immutable';
const ADMIN_SESSION_COOKIE = '__Host-mxqr_admin';
const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;
const ADMIN_PASSWORD_MIN_BYTES = 16;
const ADMIN_PASSWORD_MAX_BYTES = 256;
const ADMIN_SESSION_NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const ADMIN_SESSION_SIGNATURE_DOMAIN = 'mxqr-admin-session:v1\0';
const ADMIN_PRO_ROOM_PATH_RE = /^\/api\/admin\/pro-rooms(?:\/(0\d{5})\/activation-claim)?$/;
const ADMIN_PRO_ROOM_OWNER_RECOVERY_PATH_RE =
  /^\/api\/admin\/pro-rooms\/(0\d{5})\/owner-recovery-claim$/;
const ADMIN_PRO_ROOM_OWNER_TRANSFER_PATH_RE =
  /^\/api\/admin\/pro-rooms\/(0\d{5})\/owner-transfer-claim$/;
const ADMIN_PRO_ROOM_LEGACY_OWNER_DETACH_PATH_RE =
  /^\/api\/admin\/pro-rooms\/(0\d{5})\/legacy-owner-detach$/;
const ADMIN_PRO_ROOM_STATE_PATH_RE = /^\/api\/admin\/pro-rooms\/(0\d{5})\/state$/;
const ADMIN_PRO_ROOM_LABEL_PATH_RE = /^\/api\/admin\/pro-rooms\/(0\d{5})\/label$/;
const ADMIN_PRO_ROOM_DELETE_PATH_RE = /^\/api\/admin\/pro-rooms\/(0\d{5})$/;
const ADMIN_DEVELOPER_API_KEY_PATH_RE =
  /^\/api\/admin\/pro-rooms\/(0\d{5})\/api-keys(?:\/([A-Za-z0-9_-]{16}))?$/;
const ADMIN_PRO_ROOM_CODE_RE = /^0\d{5}$/;
const ADMIN_PRO_ROOM_REGISTRY_TABLE = 'mxqr_pro_room_registry';
const ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE = 'mxqr_pro_room_generation_history';
const ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE = 'mxqr_pro_room_generation_allocations';
const ADMIN_PRO_ROOM_GENERATION_CUTOVER_TABLE = 'mxqr_pro_room_generation_cutover';
const ADMIN_PRO_ROOM_AUDIT_TABLE = 'mxqr_pro_room_admin_audit';
const ADMIN_LEGACY_OWNER_DETACH_INTENT_ACTION = 'legacy_duplicate_owner.detach.intent';
const ADMIN_LEGACY_OWNER_DETACH_INTENT_BOOTSTRAP_ACTION =
  'legacy_duplicate_owner.detach.intent.bootstrap';
const ADMIN_LEGACY_OWNER_DETACH_INTENT_SUPERSEDE_ACTION =
  'legacy_duplicate_owner.detach.intent.supersede';
const ADMIN_LEGACY_OWNER_DETACH_COMPLETE_ACTION = 'legacy_duplicate_owner.detach';
const ADMIN_PRO_ROOM_OWNER_TRANSFER_SAGA_TABLE = 'mxqr_pro_room_owner_transfer_sagas';
const ADMIN_PRO_ROOM_OWNER_TRANSFER_ISSUANCE_TABLE = 'mxqr_pro_room_owner_transfer_issuances';
const ADMIN_PRO_ROOM_GENERATION_CONTRACT_VERSION = 1;
const RELEASE_SHA_RE = /^[0-9a-f]{40}$/;
const ADMIN_PRO_ROOM_REGISTRY_LIMIT = 1000;
const ADMIN_PRO_ROOM_LABEL_MAX_LENGTH = 64;
const ADMIN_PRO_ROOM_ACTIVATION_CLAIM_MAX_TTL_MS = 15 * 60 * 1000;
const ADMIN_PRO_ROOM_OWNER_RECOVERY_CLAIM_MAX_TTL_MS = 10 * 60 * 1000;
const ADMIN_PRO_ROOM_OWNER_TRANSFER_CLAIM_MAX_TTL_MS = 10 * 60 * 1000;
const ADMIN_PRO_ROOM_OWNER_TRANSFER_INTENT_TTL_MS = 15 * 60 * 1000;
const PRO_ROOM_OWNER_TRANSFER_RECEIPT_TTL_MS = 15 * 60 * 1000;
const ACCOUNT_ID_RE = /^acct_[A-Za-z0-9_-]{22}$/;
const OWNER_TRANSFER_ID_RE = /^transfer_[A-Za-z0-9_-]{22}$/;
const OWNER_TRANSFER_REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const OWNER_TRANSFER_COMMIT_PROOF_RE = /^[A-Za-z0-9._-]{32,2048}$/;
const OWNER_AUTHORITY_REMOVAL_ID_RE = /^removal_[A-Za-z0-9_-]{22}$/;
const ADMIN_PRO_ROOM_ACTIVATION_RECONCILE_MIN_AGE_MS = 60 * 1000;
const ADMIN_PRO_ROOM_ACTIVATION_RECONCILE_BATCH_SIZE = 25;
const ADMIN_PRO_ROOM_OWNER_STATE_BATCH_SIZE = 25;
const ADMIN_DEVELOPER_API_KEY_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const ADMIN_DEVELOPER_API_KEY_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const ADMIN_DEVELOPER_API_KEY_DEFAULT_DAYS = 90;
const ADMIN_DEVELOPER_API_KEY_MAX_DAYS = 365;
const ADMIN_DEVELOPER_API_DAY_MS = 86_400_000;
const ADMIN_DEVELOPER_API_KEY_MAX_ACTIVE = 3;
const ADMIN_DEVELOPER_API_KEY_LIST_LIMIT = 200;
const ADMIN_DEVELOPER_API_REQUEST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ADMIN_DEVELOPER_API_KEY_SCOPES = Object.freeze({
  'room:read': 1,
  'playback:read': 2,
  'playback:control': 4,
  'queue:read': 8,
  'queue:write': 16,
  'media:upload': 32,
  'effects:read': 64,
  'effects:control': 128,
});
const ADMIN_DEVELOPER_API_KEY_ALL_SCOPE_BITS = Object.values(ADMIN_DEVELOPER_API_KEY_SCOPES).reduce(
  (mask, bit) => mask | bit,
  0,
);
const PRO_ROOM_FACADE_PREFIX = '/api/pro-room';
const PRO_ROOM_FACADE_HEALTH_PATH = `${PRO_ROOM_FACADE_PREFIX}/health`;
const PRO_ROOM_FACADE_PATH_RE = /^\/api\/pro-room(\/v1\/rooms\/(0\d{5})(?:\/|$).*)$/;
const PRO_ROOM_UPSTREAM_ORIGIN = 'https://pro-room.internal';
const PRO_ROOM_SESSION_ACTOR_HEADER = 'X-MXQR-Pro-Session-Actor';
const PRO_ROOM_SESSION_CREATE_REQUEST_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{14,126})[A-Za-z0-9]$/;
// Buffer every public PRO mutation at the stateless facade before invoking
// the room Durable Object. Otherwise a client that opens a chunked request and
// never finishes it can leave the downstream body parser waiting while it owns
// the room's serialized mutation queue.
const PRO_ROOM_FACADE_BODY_MAX_BYTES = 4 * 1024 * 1024;
const PRO_ROOM_FACADE_BODY_TIMEOUT_MS = 10_000;
const PRO_ROOM_SERVICE_RESPONSE_TIMEOUT_MS = 5_000;
const PRO_ROOM_SERVICE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const PRO_ROOM_SERVICE_CONTROL_RESPONSE_MAX_BYTES = 64 * 1024;
const INITIAL_ADMIN_PRO_ROOMS = Object.freeze([
  Object.freeze({ roomCode: '000000', label: 'MUSIXQUARE Developer' }),
]);
const ADMIN_METRICS_TABLE = 'mxqr_metric_buckets';
const LIFETIME_METRICS_TABLE = 'mxqr_lifetime_metric_totals';
const ADMIN_METRICS_RETENTION_DAYS = 90;
const ADMIN_PRO_ROOM_AUDIT_RETENTION_DAYS = 365;
const MINUTES_PER_DAY = 24 * 60;
const ADMIN_METRIC_EVENTS = [
  { key: 'room_opened', label: 'Rooms opened' },
  { key: 'guest_joined', label: 'Guest joins' },
  { key: 'host_reconnected', label: 'Host reconnects' },
  { key: 'guest_host_unavailable', label: 'Guest host-missing errors' },
  { key: 'guest_auth_pending', label: 'Password prompts' },
  { key: 'guest_auth_failed', label: 'Password failures' },
  { key: 'guest_auth_timeout', label: 'Password timeouts' },
  { key: 'guest_reconnect_denied', label: 'Guest reconnect denials' },
  { key: 'guest_reconnect_conflict', label: 'Guest reconnect conflicts' },
  { key: 'guest_room_full', label: 'Room-full rejections' },
  { key: 'guest_pending_capacity', label: 'Pending guest handshake rejections' },
  { key: 'guest_identity_capacity', label: 'Guest identity limit rejections' },
  {
    key: 'remote_share_upload_assertion_verified',
    label: 'New sessions with verified host assertions',
  },
  {
    key: 'remote_share_upload_assertion_legacy',
    label: 'Assertion-free Remote Share sessions (must remain zero)',
  },
  {
    key: 'remote_share_upload_assertion_rejected',
    label: 'Bounded rejected assertion signals',
  },
  { key: 'ws_message_oversized', label: 'Oversized signaling messages' },
  { key: 'ws_message_rate_limited', label: 'Rate-limited signaling messages' },
];

let soroBackgroundRefreshPromise: Promise<void> | null = null;
let soroBackgroundRefreshStartedAt = 0;

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy':
    'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://www.youtube.com https://s.ytimg.com https://challenges.cloudflare.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://img.youtube.com https://i.ytimg.com https://app.trysoro.com https://*.trysoro.com https://*.supabase.co; media-src 'self' blob: https://demo.musixquare.com; connect-src 'self' blob: https://www.youtube.com https://musixquare.com https://demo.musixquare.com https://*.musixquare.com wss://*.musixquare.com https://*.workers.dev wss://*.workers.dev https://*.r2.cloudflarestorage.com https://challenges.cloudflare.com https://cloudflareinsights.com https://app.trysoro.com https://*.trysoro.com; frame-src https://www.youtube.com https://challenges.cloudflare.com; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return withSecurityHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        ...headers,
      },
    }),
  );
}

function proRoomCookieNames(roomCode: string) {
  return {
    upstreamSession: `__Host-mxqr_pro_session_${roomCode}`,
    upstreamOwner: `__Host-mxqr_pro_owner_${roomCode}`,
    facadeSession: `__Secure-mxqr_pro_session_${roomCode}`,
    facadeOwner: `__Secure-mxqr_pro_owner_${roomCode}`,
  };
}

function proRoomFacadeCookiePath(roomCode: string) {
  return `${PRO_ROOM_FACADE_PREFIX}/v1/rooms/${roomCode}`;
}

function forwardedProRoomCookies(rawCookie: string | null, roomCode: string) {
  if (!rawCookie) return '';
  const names = proRoomCookieNames(roomCode);
  const forwarded = [];
  for (const part of rawCookie.split(';')) {
    const cookie = part.trim();
    const separator = cookie.indexOf('=');
    if (separator <= 0) continue;
    const name = cookie.slice(0, separator);
    const value = cookie.slice(separator + 1);
    if (name === names.facadeSession) {
      forwarded.push(`${names.upstreamSession}=${value}`);
    } else if (name === names.facadeOwner) {
      forwarded.push(`${names.upstreamOwner}=${value}`);
    }
  }
  return forwarded.join('; ');
}

function parseProRoomSessionCreateBody(
  bodyBytes: Uint8Array | null | undefined,
): JsonObject | null {
  if (!(bodyBytes instanceof Uint8Array)) return null;
  try {
    const body: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bodyBytes),
    );
    return isJsonObject(body) ? body : null;
  } catch {
    return null;
  }
}

async function proRoomSessionActorHint(env: AppEnv, roomCode: string, body: JsonObject | null) {
  if (
    !body ||
    Object.keys(body).length !== 2 ||
    typeof body.pin !== 'string' ||
    typeof body.requestId !== 'string' ||
    !PRO_ROOM_SESSION_CREATE_REQUEST_ID_RE.test(body.requestId)
  ) {
    return '';
  }
  const assertionSecret = String(env.MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET || '');
  const secret =
    assertionSecret.length >= HMAC_SECRET_MIN_LENGTH ? assertionSecret : getCapabilitySecret(env);
  if (!secret) return '';
  // requestId is the sole browser value guaranteed not to change across an
  // outcome-unknown retry: the first committed response may create a session
  // cookie before its body reaches the client. Scope the opaque actor to this
  // room/DO so that adding that cookie cannot fork one logical admission.
  // PIN remains outside this identity and inside the PRO receipt fingerprint,
  // preserving same-requestId/different-PIN conflict detection.
  return hmacSha256(secret, `pro-room-session-actor:v2\u0000${roomCode}\u0000${body.requestId}`);
}

function splitSetCookieHeader(headers: {
  get(name: string): string | null;
  getAll?(name: string): string[];
  getSetCookie?(): string[];
}): string[] {
  if (typeof headers.getAll === 'function') return headers.getAll('Set-Cookie');
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const combined = headers.get('Set-Cookie');
  return combined ? combined.split(/,(?=\s*__Host-mxqr_pro_(?:session|owner)_)/) : [];
}

function facadeProRoomSetCookie(value: string, roomCode: string) {
  const names = proRoomCookieNames(roomCode);
  let rewritten = value;
  if (rewritten.startsWith(`${names.upstreamSession}=`)) {
    rewritten = `${names.facadeSession}=${rewritten.slice(names.upstreamSession.length + 1)}`;
  } else if (rewritten.startsWith(`${names.upstreamOwner}=`)) {
    rewritten = `${names.facadeOwner}=${rewritten.slice(names.upstreamOwner.length + 1)}`;
  } else {
    return null;
  }
  return rewritten.replace(/;\s*Path=\/(?=;|$)/i, `; Path=${proRoomFacadeCookiePath(roomCode)}`);
}

function withFacadeProRoomCookies(response: Response, roomCode: string) {
  const headers = new Headers(response.headers);
  // This is an App↔PRO Worker bookkeeping signal, never public API surface.
  headers.delete('x-mxqr-account-linked');
  const setCookies = splitSetCookieHeader(response.headers);
  headers.delete('Set-Cookie');
  for (const value of setCookies) {
    const rewritten = facadeProRoomSetCookie(value.trim(), roomCode);
    if (rewritten) headers.append('Set-Cookie', rewritten);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function preflightRegisteredProBotRoom(env: AppEnv, roomCode: string) {
  const db = getAdminDb(env);
  if (!db?.prepare) return 'BOT_UNAVAILABLE';
  try {
    const statement = db
      .prepare(
        `SELECT status, room_generation FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         WHERE room_code = ?1 LIMIT 1`,
      )
      .bind(roomCode);
    const row =
      typeof statement.first === 'function'
        ? await statement.first()
        : (await statement.all())?.results?.[0] || null;
    if (row?.status !== 'registered') return 'BOT_ROOM_ONLY';
    const roomGeneration = Number(row.room_generation);
    return isProRoomGeneration(roomGeneration) ? { roomGeneration } : 'BOT_UNAVAILABLE';
  } catch {
    return 'BOT_UNAVAILABLE';
  }
}

async function preflightRegisteredProRoomAccountLink(env: AppEnv, roomCode: string) {
  const db = getAdminDb(env);
  if (!db?.prepare) return null;
  const statement = db
    .prepare(
      `SELECT status, room_generation FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
       WHERE room_code = ?1 LIMIT 1`,
    )
    .bind(roomCode);
  const row =
    typeof statement.first === 'function'
      ? await statement.first<{ status: string; room_generation: number | string }>()
      : (await statement.all<{ status: string; room_generation: number | string }>()).results[0] ||
        null;
  // `registered` includes an unactivated room: activation is precisely where
  // its first owner/account cleanup edge can be created. Provisioning,
  // suspended and permanently decommissioned rooms must never grow the
  // account reverse index.
  if (row?.status !== 'registered') return null;
  const roomGeneration = Number(row.room_generation);
  return isProRoomGeneration(roomGeneration) ? { roomGeneration } : null;
}

async function preflightOwnershipTransferAccountLink(env: AppEnv, roomCode: string) {
  const db = getAdminDb(env);
  if (!db?.prepare) return null;
  const statement = db
    .prepare(
      `SELECT status, suspension_reason, room_generation
         FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
        WHERE room_code = ?1 LIMIT 1`,
    )
    .bind(roomCode);
  const row =
    typeof statement.first === 'function'
      ? await statement.first<{
          status: string;
          suspension_reason: string | null;
          room_generation: number | string;
        }>()
      : (
          await statement.all<{
            status: string;
            suspension_reason: string | null;
            room_generation: number | string;
          }>()
        ).results[0] || null;
  const allowed =
    row?.status === 'registered' ||
    (row?.status === 'suspended' &&
      typeof row.suspension_reason === 'string' &&
      ['owner_account_deleted', 'ownership_transfer_pending'].includes(row.suspension_reason));
  if (!allowed) return null;
  const roomGeneration = Number(row.room_generation);
  return isProRoomGeneration(roomGeneration) ? { roomGeneration } : null;
}

async function repairUnforwardedAccountProRoomLink(
  env: AppEnv,
  roomCode: string,
  roomGeneration: number,
) {
  try {
    const current = await preflightRegisteredProRoomAccountLink(env, roomCode);
    if (current?.roomGeneration === roomGeneration) {
      // The room is still a valid incarnation. Keeping its conservative
      // reverse edge is intentional even though this particular assertion was
      // not forwarded; a later successful link must retain an account-deletion
      // cleanup path.
      return false;
    }
    // A missing, terminal, or recycled registry pointer proves that no account
    // authority can be created in this exact incarnation. Retire all of that
    // incarnation's now-orphaned cleanup edges, never the successor's.
    await retireAccountProRoomLinks(env, roomCode, roomGeneration);
    return true;
  } catch {
    // A registry outage is not proof that an edge is orphaned. Leave the
    // conservative edge for the scheduled decommission repair sweep.
    return false;
  }
}

async function repairUnforwardedOwnerTransferAccountLink(
  env: AppEnv,
  accountId: string,
  roomCode: string,
  roomGeneration: number,
) {
  try {
    const db = getAdminDb(env);
    if (!db?.prepare) return false;
    const statement = db
      .prepare(
        `SELECT status, room_generation
           FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
          WHERE room_code = ?1 LIMIT 1`,
      )
      .bind(roomCode);
    const row =
      typeof statement.first === 'function'
        ? await statement.first<{ status: string; room_generation: number | string }>()
        : (await statement.all<{ status: string; room_generation: number | string }>())
            .results[0] || null;
    if (
      Number(row?.room_generation) === roomGeneration &&
      (typeof row?.status !== 'string' ||
        !['decommissioning', 'decommissioned'].includes(row.status))
    ) {
      // The exact live incarnation may still complete the same transaction;
      // retain only this target account's conservative deletion edge.
      return false;
    }
    return await retireAccountProRoomLinkForAccount(env, accountId, roomCode, roomGeneration);
  } catch {
    return false;
  }
}

async function handleProRoomFacade(request: Request, env: AppEnv, url: URL) {
  const isHealth = url.pathname === PRO_ROOM_FACADE_HEALTH_PATH;
  const route = url.pathname.match(PRO_ROOM_FACADE_PATH_RE);
  if (!isHealth && !route) {
    return json({ error: 'PRO_ROOM_ROUTE_NOT_FOUND' }, 404, { 'Cache-Control': 'no-store' });
  }

  if (route) {
    const [, upstreamPath, roomCode] = route;
    if (upstreamPath && roomCode && upstreamPath === `/v1/rooms/${roomCode}/bot/commands`) {
      return handleProBotRequest(request, env, {
        roomCode,
        forwardedCookies: forwardedProRoomCookies(request.headers.get('Cookie'), roomCode),
        preflightRoom: () => preflightRegisteredProBotRoom(env, roomCode),
      });
    }
  }

  if (isHealth) {
    if (url.search) {
      return json({ error: 'INVALID_REQUEST' }, 400, { 'Cache-Control': 'no-store' });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'METHOD_NOT_ALLOWED' }, 405, {
        Allow: 'GET, HEAD',
        'Cache-Control': 'no-store',
      });
    }
    const proRoomPublicApi = env.PRO_ROOM_PUBLIC_API;
    if (!proRoomPublicApi || typeof proRoomPublicApi.fetch !== 'function') {
      return json({ error: 'PRO_ROOM_API_UNAVAILABLE' }, 503, { 'Cache-Control': 'no-store' });
    }
    const headers = new Headers({ Accept: 'application/json' });
    let upstream;
    try {
      upstream = await fetchServiceBindingResponse(
        (boundedRequest) => proRoomPublicApi.fetch(boundedRequest),
        new Request(new URL('/health', PRO_ROOM_UPSTREAM_ORIGIN), {
          method: 'GET',
          headers,
          redirect: 'manual',
        }),
        PRO_ROOM_SERVICE_CONTROL_RESPONSE_MAX_BYTES,
      );
    } catch {
      return json({ error: 'PRO_ROOM_API_UNAVAILABLE' }, 502, { 'Cache-Control': 'no-store' });
    }
    if (!upstream || !isValidUtf8(upstream.bytes)) {
      return json({ error: 'PRO_ROOM_API_UNAVAILABLE' }, 502, { 'Cache-Control': 'no-store' });
    }
    const response = upstream.response;
    return withSecurityHeaders(
      new Response(
        request.method === 'HEAD' ||
          [101, 204, 205, 304].includes(response.status) ||
          upstream.bytes.byteLength === 0
          ? null
          : upstream.bytes,
        {
          status: response.status,
          statusText: response.statusText,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, max-age=0',
            'X-Robots-Tag': 'noindex, nofollow',
          },
        },
      ),
    );
  }

  if (!route) {
    return json({ error: 'PRO_ROOM_ROUTE_NOT_FOUND' }, 404, { 'Cache-Control': 'no-store' });
  }

  const proRoomPublicApi = env.PRO_ROOM_PUBLIC_API;
  if (!proRoomPublicApi || typeof proRoomPublicApi.fetch !== 'function') {
    return json({ error: 'PRO_ROOM_API_UNAVAILABLE' }, 503, { 'Cache-Control': 'no-store' });
  }

  let bufferedMutationBody: Uint8Array | null = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const buffered = await readBodyBytesLimited(
      request,
      PRO_ROOM_FACADE_BODY_MAX_BYTES,
      PRO_ROOM_FACADE_BODY_TIMEOUT_MS,
    );
    if (buffered.error === 'too-large') {
      return json({ error: 'PRO_ROOM_REQUEST_BODY_TOO_LARGE' }, 413, {
        'Cache-Control': 'no-store',
      });
    }
    if (buffered.error === 'timeout' || buffered.error === 'aborted') {
      return json({ error: 'PRO_ROOM_REQUEST_BODY_TIMEOUT' }, 408, {
        'Cache-Control': 'no-store',
      });
    }
    if (buffered.error) {
      return json({ error: 'INVALID_REQUEST' }, 400, { 'Cache-Control': 'no-store' });
    }
    bufferedMutationBody = buffered.body;
  }

  const [, upstreamPath, roomCode] = route;
  if (!upstreamPath || !roomCode) {
    return json({ error: 'PRO_ROOM_ROUTE_NOT_FOUND' }, 404, { 'Cache-Control': 'no-store' });
  }
  const sessionCreatePath =
    request.method === 'POST' && upstreamPath === `/v1/rooms/${roomCode}/sessions`;
  const sessionCreateBody = sessionCreatePath
    ? parseProRoomSessionCreateBody(bufferedMutationBody)
    : null;
  const headers = new Headers(request.headers);
  // Preserve a browser-supplied Origin so the PRO Worker remains the single
  // CSRF/CORS authority. Same-origin GET/HEAD requests commonly omit it, so
  // synthesize only for those safe methods. A mutation without Origin must
  // still fail closed in the PRO Worker.
  if (!headers.has('Origin') && (request.method === 'GET' || request.method === 'HEAD')) {
    headers.set('Origin', url.origin);
  }
  headers.delete('X-MXQR-Pro-Room-Code');
  headers.delete('X-MXQR-Pro-Room-Generation');
  headers.delete('X-MXQR-Pro-IP-Hash');
  // This header is service-internal. Always discard a browser value, then
  // derive the stable request-scoped actor before replacing any Cookie header.
  headers.delete(PRO_ROOM_SESSION_ACTOR_HEADER);
  if (sessionCreatePath) {
    const actorHint = await proRoomSessionActorHint(env, roomCode, sessionCreateBody);
    if (actorHint) headers.set(PRO_ROOM_SESSION_ACTOR_HEADER, actorHint);
  }
  // A browser can name this header but can never supply its value. Account
  // identity is resolved from the App Worker's host-only session cookie and
  // replaced with a short-lived room/audience-bound service assertion.
  headers.delete(ACCOUNT_ASSERTION_HEADER);
  const accountRequiredAssertionPaths = new Set([
    `/v1/rooms/${roomCode}/activation`,
    `/v1/rooms/${roomCode}/owner-recovery`,
    `/v1/rooms/${roomCode}/owner-transfer`,
  ]);
  const accountLinkAssertionPaths = new Set([
    ...accountRequiredAssertionPaths,
    `/v1/rooms/${roomCode}/sessions`,
    `/v1/rooms/${roomCode}/sessions/current/account`,
  ]);
  const accountLeaseAssertionPath = `/v1/rooms/${roomCode}/sessions/current/account/lease`;
  const accountRequired = accountRequiredAssertionPaths.has(upstreamPath);
  const ownershipTransferPath = upstreamPath === `/v1/rooms/${roomCode}/owner-transfer`;
  let accountAssertionContext: { accountId: string; roomGeneration: number } | null = null;
  if (accountLinkAssertionPaths.has(upstreamPath) || upstreamPath === accountLeaseAssertionPath) {
    let recordedRoomGeneration = null;
    let assertedAccountId = null;
    const assertionSecret = String(env.MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET || '');
    if (
      accountRequired &&
      (!isAccountAuthConfigured(env) || assertionSecret.length < 32 || !getAdminDb(env)?.prepare)
    ) {
      return json({ error: 'PRO_ROOM_ACCOUNT_ASSERTION_UNAVAILABLE' }, 503);
    }
    try {
      const account = await resolveAccountSession(request, env);
      assertedAccountId = account?.accountId || null;
      if (accountRequired && (!account?.profileComplete || !account.nickname)) {
        return json({ error: 'ACCOUNT_SESSION_REQUIRED' }, 401);
      }
      if (account?.profileComplete && account.nickname && assertionSecret.length >= 32) {
        // A lease renewal skips the reverse-index write because the exact
        // physical session is already linked downstream, but it still resolves
        // the current immutable room generation so a recycled public code can
        // never turn an old account assertion into authority in its successor.
        const roomLink = ownershipTransferPath
          ? await preflightOwnershipTransferAccountLink(env, roomCode)
          : await preflightRegisteredProRoomAccountLink(env, roomCode);
        if (roomLink) {
          if (upstreamPath === `/v1/rooms/${roomCode}/activation`) {
            const grantAuthorized = await authorizeProGrantActivation(env, {
              accountId: account.accountId,
              roomCode,
              roomGeneration: roomLink.roomGeneration,
            });
            if (!grantAuthorized) {
              return json({ error: 'ACCOUNT_PRO_ROOM_LIMIT_REACHED' }, 409);
            }
          }
          const assertion = await createAccountAssertion(
            {
              accountId: account.accountId,
              nickname: account.nickname,
              roomCode,
              roomGeneration: roomLink.roomGeneration,
              audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
            },
            assertionSecret,
          );
          if (!assertion) throw new Error('PRO_ACCOUNT_ASSERTION_UNAVAILABLE');
          if (assertion && upstreamPath !== accountLeaseAssertionPath) {
            const confirmedRoomLink = ownershipTransferPath
              ? await preflightOwnershipTransferAccountLink(env, roomCode)
              : await preflightRegisteredProRoomAccountLink(env, roomCode);
            if (confirmedRoomLink?.roomGeneration !== roomLink.roomGeneration) {
              throw new Error('PRO_ACCOUNT_LINK_CHANGED');
            }
            if (!ownershipTransferPath) {
              // Ordinary activation/session routes can persist account
              // authority in their first downstream call, so record the
              // conservative cleanup edge before forwarding. Owner transfer
              // is different: PREPARE verifies a bearer claim but grants no
              // active target authority, so its edge is deferred until a
              // successful validated PREPARE to prevent invalid claims from
              // exhausting an account's 1,000-edge budget.
              const linked = await recordAccountProRoomLink(
                env,
                account.accountId,
                roomCode,
                Date.now(),
                roomLink.roomGeneration,
              );
              if (!linked) throw new Error('PRO_ACCOUNT_LINK_UNAVAILABLE');
              recordedRoomGeneration = roomLink.roomGeneration;
              const confirmedAfterWrite = await preflightRegisteredProRoomAccountLink(
                env,
                roomCode,
              );
              if (confirmedAfterWrite?.roomGeneration !== roomLink.roomGeneration) {
                await retireAccountProRoomLinks(env, roomCode, roomLink.roomGeneration);
                throw new Error('PRO_ACCOUNT_LINK_CHANGED');
              }
            }
          }
          headers.set(ACCOUNT_ASSERTION_HEADER, assertion);
          accountAssertionContext = {
            accountId: account.accountId,
            roomGeneration: roomLink.roomGeneration,
          };
        } else if (accountRequired) {
          return json({ error: 'PRO_ROOM_ACCOUNT_ASSERTION_UNAVAILABLE' }, 503);
        }
      }
    } catch (error) {
      if (isProRoomGeneration(recordedRoomGeneration)) {
        if (ownershipTransferPath && assertedAccountId && ACCOUNT_ID_RE.test(assertedAccountId)) {
          await repairUnforwardedOwnerTransferAccountLink(
            env,
            assertedAccountId,
            roomCode,
            recordedRoomGeneration,
          );
        } else {
          await repairUnforwardedAccountProRoomLink(env, roomCode, recordedRoomGeneration);
        }
      }
      if (accountRequired) {
        return json({ error: 'PRO_ROOM_ACCOUNT_ASSERTION_UNAVAILABLE' }, 503);
      }
      // PIN sessions keep optional account linking. An identity-store outage
      // must not turn an otherwise valid PIN into a playback outage.
      console.warn('[AccountAuth] PRO assertion unavailable', error);
    }
    if (accountRequired && !accountAssertionContext) {
      return json({ error: 'PRO_ROOM_ACCOUNT_ASSERTION_UNAVAILABLE' }, 503);
    }
  }
  const cookies = forwardedProRoomCookies(headers.get('Cookie'), roomCode);
  if (cookies) headers.set('Cookie', cookies);
  else headers.delete('Cookie');

  if (ownershipTransferPath) {
    if (!accountAssertionContext) {
      return json({ error: 'PRO_ROOM_ACCOUNT_ASSERTION_UNAVAILABLE' }, 503);
    }
    return handleProRoomOwnershipTransferSaga({
      request,
      env,
      roomCode,
      roomGeneration: accountAssertionContext.roomGeneration,
      targetAccountId: accountAssertionContext.accountId,
      headers,
      body: bufferedMutationBody,
    });
  }

  const upstreamUrl = new URL(upstreamPath, PRO_ROOM_UPSTREAM_ORIGIN);
  upstreamUrl.search = url.search;
  const upstreamInit: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (bufferedMutationBody !== null) {
      upstreamInit.body = new Uint8Array(bufferedMutationBody).buffer;
    }
  }
  const legacySessionCreate = (() => {
    if (!sessionCreatePath || !sessionCreateBody) return false;
    return (
      Object.keys(sessionCreateBody).length === 1 &&
      typeof sessionCreateBody.pin === 'string' &&
      /^\d{8}$/.test(sessionCreateBody.pin)
    );
  })();
  if (legacySessionCreate) {
    // Cached pre-v1 clients cannot safely synthesize an exactly-once key: an
    // IP/PIN/User-Agent surrogate would merge independent devices behind one
    // NAT. Preserve their former platform/request lifetime until the cached
    // client rollout drains, while every requestId-bearing admission below is
    // protected by the short App deadline and the PRO durable receipt.
    try {
      const response = await proRoomPublicApi.fetch(
        new Request(upstreamUrl, { ...upstreamInit, signal: request.signal }),
      );
      return withFacadeProRoomCookies(response, roomCode);
    } catch {
      return json({ error: 'PRO_ROOM_API_UNAVAILABLE' }, 502, { 'Cache-Control': 'no-store' });
    }
  }
  let upstream;
  try {
    upstream = await fetchServiceBindingResponse(
      (boundedRequest) => proRoomPublicApi.fetch(boundedRequest),
      new Request(upstreamUrl, upstreamInit),
      PRO_ROOM_SERVICE_RESPONSE_MAX_BYTES,
    );
  } catch {
    return json({ error: 'PRO_ROOM_API_UNAVAILABLE' }, 502, { 'Cache-Control': 'no-store' });
  }
  if (!upstream || !isValidUtf8(upstream.bytes)) {
    return json({ error: 'PRO_ROOM_API_UNAVAILABLE' }, 502, { 'Cache-Control': 'no-store' });
  }
  const response = bufferedServiceResponse(
    upstream.response,
    upstream.bytes,
    request.method === 'HEAD',
  );
  if (
    response.ok &&
    upstreamPath === `/v1/rooms/${roomCode}/activation` &&
    accountAssertionContext
  ) {
    await finalizeProGrantActivation(env, {
      accountId: accountAssertionContext.accountId,
      roomCode,
      roomGeneration: accountAssertionContext.roomGeneration,
    }).catch(() => false);
  }
  return withFacadeProRoomCookies(response, roomCode);
}

function cancelBodyReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason: unknown) {
  try {
    Promise.resolve(reader?.cancel(reason)).catch(() => {});
  } catch {
    // Cancellation is best-effort and must never delay the bounded response.
  }
}

type BodyReadStopOutcome = { kind: 'timeout' | 'aborted' };
type BodyReadOutcome =
  | { kind: 'read'; value: ReadableStreamReadResult<Uint8Array> }
  | { kind: 'invalid' }
  | BodyReadStopOutcome;

async function readBodyBytesLimited(
  request: Request,
  maxBytes: number,
  timeoutMs: number,
): Promise<BodyReadResult> {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null) {
    const normalized = contentLength.trim();
    if (!/^\d+$/.test(normalized)) return { error: 'invalid' };
    if (Number(normalized) > maxBytes) return { error: 'too-large' };
  }
  if (!request.body) return { body: null };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let stop: (outcome: BodyReadStopOutcome) => void = () => undefined;
  const stopped = new Promise<BodyReadStopOutcome>((resolve) => {
    stop = resolve;
  });
  const timeout = setTimeout(() => {
    stop({ kind: 'timeout' });
    cancelBodyReader(reader, 'REQUEST_BODY_TIMEOUT');
  }, timeoutMs);
  const abort = () => {
    stop({ kind: 'aborted' });
    cancelBodyReader(reader, request.signal.reason);
  };
  if (request.signal.aborted) abort();
  else request.signal.addEventListener('abort', abort, { once: true });

  try {
    while (true) {
      const outcome: BodyReadOutcome = await Promise.race([
        reader.read().then(
          (value): BodyReadOutcome => ({ kind: 'read', value }),
          (): BodyReadOutcome => ({ kind: 'invalid' }),
        ),
        stopped,
      ]);
      if (outcome.kind !== 'read') return { error: outcome.kind };
      if (outcome.value.done) break;
      const bytes = outcome.value.value;
      if (!(bytes instanceof Uint8Array)) return { error: 'invalid' };
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        cancelBodyReader(reader, 'REQUEST_BODY_TOO_LARGE');
        return { error: 'too-large' };
      }
      chunks.push(bytes);
    }
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', abort);
    // A deliberately stalled stream may still own an unsettled read when the
    // deadline wins. Cancellation is best-effort for custom/host streams, and
    // releaseLock() is allowed to throw while that read remains pending. The
    // facade response must still deterministically be the bounded 408.
    try {
      reader.releaseLock();
    } catch {
      /* pending non-cooperative stream read */
    }
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body };
}

async function readJsonBodyLimited(
  request: Request,
  maxBytes: number,
): Promise<JsonBodyReadResult> {
  const result = await readBodyBytesLimited(request, maxBytes, PUBLIC_JSON_BODY_TIMEOUT_MS);
  if (result.error) return result;
  const bodyBytes = result.body;
  if (!(bodyBytes instanceof Uint8Array) || bodyBytes.byteLength === 0) {
    return { error: 'invalid' };
  }
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bodyBytes),
    );
    return { value };
  } catch {
    return { error: 'invalid' };
  }
}

function jsonBodyError(result: JsonBodyReadResult, headers: HeadersInit = {}) {
  if (result.error === 'too-large') {
    return json({ error: 'Request body too large' }, 413, headers);
  }
  if (result.error === 'timeout') {
    return json({ error: 'Request body timed out' }, 408, headers);
  }
  return json({ error: 'Invalid JSON body' }, 400, headers);
}

function withSecurityHeaders(
  response: Response,
  extraHeaders: Headers | Record<string, string | null> = {},
) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  // Object.entries(new Headers()) is empty in the original JavaScript runtime.
  // Keep that behavior for callers that redundantly pass the response Headers.
  const extraEntries = extraHeaders instanceof Headers ? [] : Object.entries(extraHeaders);
  for (const [name, value] of extraEntries) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  const contentType = headers.get('Content-Type') || '';
  if (/^text\/html(?:\s*;|$)/i.test(contentType) && !/;\s*charset=/i.test(contentType)) {
    headers.set('Content-Type', `${contentType.trim().replace(/;\s*$/, '')}; charset=utf-8`);
  }
  headers.delete('Content-Length');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function normalizeCorsOrigin(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

function configuredTrustedOrigins(env: AppEnv) {
  const raw = env.TRUSTED_CORS_ORIGINS || env.CORS_ALLOWED_ORIGINS || '';
  if (typeof raw !== 'string' || !raw.trim()) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map(normalizeCorsOrigin)
      .filter(Boolean),
  );
}

function isConfiguredTrustedOrigin(origin: string, env: AppEnv) {
  const normalizedOrigin = normalizeCorsOrigin(origin);
  if (!normalizedOrigin) return false;
  return configuredTrustedOrigins(env).has(normalizedOrigin);
}

function trustedCors(
  request: Request,
  methods: string,
  env: AppEnv,
  options: { allowInferred?: boolean } = {},
): { isTrusted: boolean; sameOriginInferred: boolean; headers: Record<string, string> } {
  const origin = request.headers.get('Origin') || '';
  const host = request.headers.get('Host') || '';
  const fetchSite = (request.headers.get('Sec-Fetch-Site') || '').toLowerCase();
  const trustedPatterns = [
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i,
    /^https:\/\/(?:[^/]+\.)?toss\.im$/i,
    /^https:\/\/(?:[^/]+\.)?toss-internal\.com$/i,
    /^https:\/\/(?:[^/]+\.)?tossmini\.com$/i,
    /^https:\/\/musixquare\.com$/i,
    /^https:\/\/[^/]*\.musixquare\.com$/i,
  ];

  const sameOrigin = Boolean(
    origin && (origin === `https://${host}` || origin === `http://${host}`),
  );
  const browserSameOrigin = fetchSite === 'same-origin';
  const sameOriginInferred =
    !origin &&
    !fetchSite &&
    (host === 'musixquare.com' || host.endsWith('.musixquare.com') || host.startsWith('localhost'));
  // Host-only inference is not authentication. Capability endpoints accept it
  // only as a WebView routing/CORS signal; Turnstile or the signed proof-of-work
  // challenge remains mandatory for minting a token.
  const isTrusted =
    sameOrigin ||
    browserSameOrigin ||
    (options.allowInferred && sameOriginInferred) ||
    trustedPatterns.some((pattern) => pattern.test(origin)) ||
    isConfiguredTrustedOrigin(origin, env);
  const allowOrigin = isTrusted ? origin : '';
  const headers: Record<string, string> = allowOrigin
    ? {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': methods,
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-MXQR-Capability',
        Vary: 'Origin',
      }
    : {};

  return {
    isTrusted: Boolean(isTrusted),
    sameOriginInferred,
    headers,
  };
}

function getClientIp(request: Request) {
  return (
    request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'
  );
}

// Best-effort per-IP limiter for local/authentication endpoints. Paid
// Cloudflare and YouTube resources use the atomic service-control limiter
// below; this Cache API path is not a hard quota.
async function checkRateLimit(
  request: Request,
  endpoint: string,
  limit: number = 60,
  windowSec: number = 60,
  identityOverride = '',
) {
  // Graceful bypass if the runtime doesn't expose Cache API (e.g. jsdom unit
  // tests that invoke the worker directly). Production Cloudflare workers
  // always have `caches.default`.
  const cache = getAppDefaultCache();
  if (!cache) return true;

  const identity = identityOverride || getClientIp(request);
  const window = Math.floor(Date.now() / (windowSec * 1000));
  // Use a synthetic cache URL so the key is opaque to upstream caches.
  const cacheKey = new Request(
    `https://ratelimit.internal/${encodeURIComponent(endpoint)}/${encodeURIComponent(identity)}/${window}`,
    { method: 'GET' },
  );
  let count = 0;
  try {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const txt = await cached.text();
      const n = Number.parseInt(txt, 10);
      if (Number.isFinite(n) && n >= 0) count = n;
    }
  } catch {
    /* cache miss treated as 0 */
  }

  if (count >= limit) return false;

  const nextCount = count + 1;
  try {
    await cache.put(
      cacheKey,
      new Response(String(nextCount), {
        headers: { 'Cache-Control': `public, max-age=${windowSec * 2}` },
      }),
    );
  } catch {
    /* best-effort */
  }
  return true;
}

async function checkPaidRateLimit(
  request: Request,
  env: AppEnv,
  endpoint: string,
  limit: number = 60,
  windowSec: number = 60,
  identityOverride = '',
  options: { identityIsPseudonymous?: boolean } = {},
) {
  // Direct unit/local runtimes intentionally omit every production binding.
  // Production Workers expose Cache API, so a missing atomic binding there is
  // fail-closed instead of silently falling back to the stale Cache counter.
  if (!env?.MUSIXQUARE_SERVICE_CONTROL) {
    if (!getAppDefaultCache()) {
      return {
        status: 'ok',
        allowed: await checkRateLimit(request, endpoint, limit, windowSec, identityOverride),
        retryAfterSeconds: 0,
      };
    }
    return { status: 'unavailable' };
  }

  const identity = identityOverride || getClientIp(request);
  const secret = getCapabilitySecret(env);
  const digest = options.identityIsPseudonymous
    ? identity
    : secret
      ? await hmacSha256(secret, `paid-rate:${identity}`)
      : bytesToBase64Url(await sha256Bytes(`paid-rate:${identity}`));
  return consumeAbuseRateLimit(env, {
    scope: `app-${endpoint}`,
    identity: digest,
    limit,
    windowMs: windowSec * 1_000,
  });
}

async function checkPaidRateLimitPair(
  request: Request,
  env: AppEnv,
  endpoint: string,
  limit: number,
  windowSec: number,
  secondary: { identity: string; limit: number; cost?: number } | null,
) {
  // Local/unit runtimes intentionally omit the production binding. Preserve
  // the same primary-before-secondary semantics there with the Cache helper;
  // production always uses one strongly ordered Durable Object request.
  if (!env?.MUSIXQUARE_SERVICE_CONTROL) {
    if (getAppDefaultCache()) return { status: 'unavailable' };
    const primaryAllowed = await checkRateLimit(request, endpoint, limit, windowSec);
    if (!primaryAllowed) {
      return { status: 'ok', allowed: false, deniedBy: 'primary', retryAfterSeconds: 0 };
    }
    if (!secondary) {
      return { status: 'ok', allowed: true, deniedBy: null, retryAfterSeconds: 0 };
    }
    const secondaryAllowed = await checkRateLimit(
      request,
      `${endpoint}-capability`,
      secondary.limit,
      windowSec,
      secondary.identity,
    );
    return {
      status: 'ok',
      allowed: secondaryAllowed,
      deniedBy: secondaryAllowed ? null : 'secondary',
      retryAfterSeconds: 0,
    };
  }

  const identity = getClientIp(request);
  const secret = getCapabilitySecret(env);
  const digest = secret
    ? await hmacSha256(secret, `paid-rate:${identity}`)
    : bytesToBase64Url(await sha256Bytes(`paid-rate:${identity}`));
  return consumeAbuseRateLimitPair(env, {
    scope: `app-${endpoint}`,
    identity: digest,
    limit,
    windowMs: windowSec * 1_000,
    secondary,
  });
}

function rateLimitResponse(headers: HeadersInit = {}, retryAfterSeconds: number = 60) {
  const responseHeaders: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => {
    responseHeaders[name] = value;
  });
  responseHeaders['Retry-After'] = String(Math.max(1, retryAfterSeconds));
  return json({ error: 'Too Many Requests' }, 429, responseHeaders);
}

function rateLimitUnavailableResponse(headers: HeadersInit = {}) {
  return json({ error: 'RATE_LIMIT_UNAVAILABLE' }, 503, headers);
}

function getTurnstileSiteKey(env: AppEnv) {
  return env.TURNSTILE_SITE_KEY || env.CLOUDFLARE_TURNSTILE_SITE_KEY || '';
}

function getTurnstileSecret(env: AppEnv) {
  return env.TURNSTILE_SECRET_KEY || env.CLOUDFLARE_TURNSTILE_SECRET_KEY || '';
}

function isTurnstileDisabled(env: AppEnv) {
  const raw = String(
    env.MXQR_TURNSTILE_DISABLED ?? env.TURNSTILE_DISABLED ?? env.DISABLE_TURNSTILE ?? 'false',
  )
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function isTurnstileConfigured(env: AppEnv) {
  if (isTurnstileDisabled(env)) return false;
  return !!(getTurnstileSiteKey(env) && getTurnstileSecret(env));
}

function normalizeHostname(value: string) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const trimmed = value.trim().toLowerCase();
  try {
    const parsed = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return parsed.hostname.replace(/^\*\./, '');
  } catch {
    return trimmed.replace(/^\*\./, '').replace(/[^a-z0-9.-]/g, '');
  }
}

function configuredTurnstileHostnames(env: AppEnv) {
  const raw = env.MXQR_TURNSTILE_ALLOWED_HOSTNAMES || env.TURNSTILE_ALLOWED_HOSTNAMES || '';
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function hostnameMatchesRule(hostname: string, rule: string) {
  const normalizedHostname = normalizeHostname(hostname);
  const normalizedRule = normalizeHostname(rule);
  if (!normalizedHostname || !normalizedRule) return false;
  if (normalizedHostname === normalizedRule) return true;
  return rule.trim().startsWith('*.') && normalizedHostname.endsWith(`.${normalizedRule}`);
}

function isAllowedTurnstileHostname(hostname: string, env: AppEnv) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;

  const configured = configuredTurnstileHostnames(env);
  if (configured.length > 0) {
    return configured.some((rule) => hostnameMatchesRule(normalized, rule));
  }

  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === 'musixquare.com' ||
    normalized === 'www.musixquare.com' ||
    normalized.endsWith('.musixquare.com') ||
    normalized === 'toss.im' ||
    normalized.endsWith('.toss.im') ||
    normalized === 'toss-internal.com' ||
    normalized.endsWith('.toss-internal.com') ||
    normalized === 'tossmini.com' ||
    normalized.endsWith('.tossmini.com')
  );
}

function allowUnguardedPaidApis(env: AppEnv) {
  const raw = String(env.MXQR_ALLOW_UNGUARDED_PAID_APIS ?? env.ALLOW_UNGUARDED_PAID_APIS ?? 'false')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function boundedCapabilityInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function isTruthyConfigValue(value: string) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function getCapabilitySecret(env: AppEnv) {
  const secret = String(
    env.MXQR_CAPABILITY_SECRET || env.CAPABILITY_HMAC_SECRET || env.CAPABILITY_SECRET || '',
  );
  return secret.length >= HMAC_SECRET_MIN_LENGTH ? secret : '';
}

function hasInvalidCapabilitySecret(env: AppEnv) {
  const secret = String(
    env.MXQR_CAPABILITY_SECRET || env.CAPABILITY_HMAC_SECRET || env.CAPABILITY_SECRET || '',
  );
  return secret.length > 0 && secret.length < HMAC_SECRET_MIN_LENGTH;
}

function isCapabilityAuthEnabled(env: AppEnv) {
  return !!getCapabilitySecret(env);
}

function parseCapabilityTtl(env: AppEnv) {
  return boundedCapabilityInteger(
    env.MXQR_CAPABILITY_TTL || env.CAPABILITY_TTL,
    CAPABILITY_TOKEN_TTL_DEFAULT,
    CAPABILITY_TOKEN_TTL_MIN,
    CAPABILITY_TOKEN_TTL_MAX,
  );
}

function parseCapabilityPowDifficulty(env: AppEnv, fallback = CAPABILITY_POW_DIFFICULTY_DEFAULT) {
  return boundedCapabilityInteger(
    env.MXQR_CAPABILITY_POW_DIFFICULTY || env.CAPABILITY_POW_DIFFICULTY,
    fallback,
    CAPABILITY_POW_DIFFICULTY_MIN,
    CAPABILITY_POW_DIFFICULTY_MAX,
  );
}

function parseCapabilityPowTtl(env: AppEnv) {
  return boundedCapabilityInteger(
    env.MXQR_CAPABILITY_POW_TTL || env.CAPABILITY_POW_TTL,
    CAPABILITY_POW_TTL_DEFAULT,
    CAPABILITY_POW_TTL_MIN,
    CAPABILITY_POW_TTL_MAX,
  );
}

function isCapabilityPowAdaptiveEnabled(env: AppEnv) {
  return isTruthyConfigValue(env.MXQR_CAPABILITY_POW_ADAPTIVE_ENABLED || '');
}

function parseCapabilityPowMaxDifficulty(env: AppEnv, baselineDifficulty: number) {
  if (!isCapabilityPowAdaptiveEnabled(env)) return baselineDifficulty;
  const fallback = Math.min(
    CAPABILITY_POW_DIFFICULTY_MAX,
    baselineDifficulty + CAPABILITY_POW_ADAPTIVE_MAX_DELTA_DEFAULT,
  );
  return boundedCapabilityInteger(
    env.MXQR_CAPABILITY_POW_ADAPTIVE_MAX_DIFFICULTY,
    fallback,
    baselineDifficulty,
    CAPABILITY_POW_DIFFICULTY_MAX,
  );
}

function parseRequestedScopes(value: unknown) {
  if (!Array.isArray(value)) return [];
  const scopes: string[] = [];
  for (const scope of value) {
    if (typeof scope === 'string' && CAPABILITY_SCOPES.has(scope) && !scopes.includes(scope)) {
      scopes.push(scope);
    }
  }
  return scopes.sort();
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function stringToBase64Url(value: string) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlToString(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
}

function constantTimeEqual(a: string, b: string) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function hmacSha256(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function sha256Bytes(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function randomNonce(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function hasLeadingZeroBits(bytes: Uint8Array, difficulty: number) {
  let remaining = difficulty;
  for (const byte of bytes) {
    if (remaining <= 0) return true;
    const bits = Math.min(8, remaining);
    if ((byte & (0xff << (8 - bits))) !== 0) return false;
    remaining -= bits;
  }
  return remaining <= 0;
}

async function capabilityIpHash(secret: string, request: Request) {
  return hmacSha256(secret, `ip:${getClientIp(request)}`);
}

/**
 * Consume one location-local Cloudflare Rate Limiting binding event. The room
 * and general bindings have independent namespaces and fixed 150/60s and
 * 15/60s limits in wrangler.app.toml. Cloudflare updates these eventually
 * consistent counters asynchronously in the serving location, so awaiting
 * limit() does not wait on a network request. The signal is friction only: a
 * missing/malformed/throwing binding falls back to the reviewed baseline while
 * paid endpoints retain their independent fail-closed atomic cost caps.
 */
async function consumeCapabilityPowPressure(
  request: Request,
  env: AppEnv,
  { roomBurst = false, baselineDifficulty = CAPABILITY_POW_DIFFICULTY_DEFAULT } = {},
) {
  const runtimeEnv = env || {};
  const maximumDifficulty = parseCapabilityPowMaxDifficulty(runtimeEnv, baselineDifficulty);
  if (!isCapabilityPowAdaptiveEnabled(runtimeEnv) || maximumDifficulty <= baselineDifficulty) {
    return {
      status: 'disabled',
      exceeded: false,
      difficulty: baselineDifficulty,
    };
  }
  const bindingName = roomBurst
    ? CAPABILITY_POW_ROOM_PRESSURE_BINDING
    : CAPABILITY_POW_GENERAL_PRESSURE_BINDING;
  const binding = runtimeEnv[bindingName];
  const secret = getCapabilitySecret(runtimeEnv);
  if (!secret || !binding || typeof binding.limit !== 'function') {
    return {
      status: 'fallback',
      exceeded: false,
      difficulty: baselineDifficulty,
    };
  }
  try {
    const result = await binding.limit({ key: await capabilityIpHash(secret, request) });
    if (!result || typeof result.success !== 'boolean') {
      return {
        status: 'fallback',
        exceeded: false,
        difficulty: baselineDifficulty,
      };
    }
    return {
      status: 'ok',
      exceeded: !result.success,
      difficulty: result.success ? baselineDifficulty : maximumDifficulty,
    };
  } catch {
    return {
      status: 'fallback',
      exceeded: false,
      difficulty: baselineDifficulty,
    };
  }
}

async function createCapabilityPowChallenge(
  scopes: string[],
  request: Request,
  env: AppEnv,
  difficulty: number = parseCapabilityPowDifficulty(env),
) {
  const secret = getCapabilitySecret(env);
  const now = Math.floor(Date.now() / 1000);
  const baselineDifficulty = parseCapabilityPowDifficulty(env);
  const maximumDifficulty = parseCapabilityPowMaxDifficulty(env, baselineDifficulty);
  const resolvedDifficulty =
    Number.isSafeInteger(difficulty) &&
    difficulty >= baselineDifficulty &&
    difficulty <= maximumDifficulty
      ? difficulty
      : baselineDifficulty;
  const payload = {
    v: 1,
    scopes,
    iat: now,
    exp: now + parseCapabilityPowTtl(env),
    ip: await capabilityIpHash(secret, request),
    difficulty: resolvedDifficulty,
    capabilityTtl: parseCapabilityTtl(env),
    nonce: randomNonce(),
  };
  const payloadPart = stringToBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256(secret, `capability-pow:${payloadPart}`);
  return {
    challenge: `${payloadPart}.${signature}`,
    difficulty: payload.difficulty,
    expiresAt: payload.exp,
    algorithm: 'sha256-leading-zero-bits',
  };
}

async function verifyCapabilityPowProof(
  proof: unknown,
  scopes: string[],
  request: Request,
  env: AppEnv,
  baselineDifficulty = parseCapabilityPowDifficulty(env),
) {
  if (!isJsonObject(proof)) return null;
  const challenge = typeof proof.challenge === 'string' ? proof.challenge : '';
  const solution = typeof proof.solution === 'string' ? proof.solution : '';
  if (!challenge || !/^\d{1,20}$/.test(solution)) return null;

  const parts = challenge.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const secret = getCapabilitySecret(env);
  const expectedSignature = await hmacSha256(secret, `capability-pow:${parts[0]}`);
  if (!constantTimeEqual(expectedSignature, parts[1])) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlToString(parts[0]));
  } catch {
    return null;
  }

  if (!isJsonObject(payload)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload?.v !== 1) return null;
  if (!Array.isArray(payload.scopes) || JSON.stringify(payload.scopes) !== JSON.stringify(scopes)) {
    return null;
  }
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (payload.exp - payload.iat !== parseCapabilityPowTtl(env)) return null;
  const maximumDifficulty = parseCapabilityPowMaxDifficulty(env, baselineDifficulty);
  if (
    typeof payload.difficulty !== 'number' ||
    !Number.isSafeInteger(payload.difficulty) ||
    payload.difficulty < baselineDifficulty ||
    payload.difficulty > maximumDifficulty
  ) {
    return null;
  }
  if (payload.capabilityTtl !== parseCapabilityTtl(env)) return null;
  if (typeof payload.nonce !== 'string' || !payload.nonce) return null;

  const expectedIp = await capabilityIpHash(secret, request);
  if (!constantTimeEqual(String(payload.ip || ''), expectedIp)) return null;

  const digest = await sha256Bytes(`mxqr-pow-v1:${challenge}:${solution}`);
  if (!hasLeadingZeroBits(digest, payload.difficulty)) return null;
  return payload;
}

function readCapabilityToken(request: Request) {
  const headerToken = request.headers.get('X-MXQR-Capability') || '';
  if (headerToken) return headerToken.trim();
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

async function createCapabilityToken(
  scopes: string[],
  request: Request,
  env: AppEnv,
  method: string,
  anchor: { iat: number; jti?: string } | null = null,
) {
  const secret = getCapabilitySecret(env);
  const ttl = parseCapabilityTtl(env);
  const now = Math.floor(Date.now() / 1000);
  // Tokens are base64url-encoded, not encrypted. Do not embed the minting
  // method because it would disclose the active verification path.
  void method;
  const payload = {
    v: 1,
    scopes,
    iat: anchor?.iat ?? now,
    exp: (anchor?.iat ?? now) + ttl,
    ip: await capabilityIpHash(secret, request),
    ...(anchor?.jti ? { jti: anchor.jti } : {}),
  };
  const payloadPart = stringToBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256(secret, payloadPart);
  return {
    token: `${payloadPart}.${signature}`,
    expiresAt: payload.exp,
    scopes,
  };
}

async function verifyCapabilityToken(
  token: string,
  request: Request,
  env: AppEnv,
  requiredScope: string,
) {
  const secret = getCapabilitySecret(env);
  if (
    !secret ||
    typeof token !== 'string' ||
    !token ||
    token.length > CAPABILITY_TOKEN_MAX_LENGTH
  ) {
    return false;
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  if (
    !CAPABILITY_TOKEN_PAYLOAD_RE.test(parts[0]) ||
    !CAPABILITY_TOKEN_SIGNATURE_RE.test(parts[1])
  ) {
    return false;
  }

  const expectedSignature = await hmacSha256(secret, parts[0]);
  if (!constantTimeEqual(expectedSignature, parts[1])) return false;

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlToString(parts[0]));
  } catch {
    return false;
  }

  if (!isJsonObject(payload)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (payload?.v !== 1) return false;
  if (!Array.isArray(payload.scopes) || !payload.scopes.includes(requiredScope)) return false;
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) return false;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return false;

  const expectedIp = await capabilityIpHash(secret, request);
  return constantTimeEqual(String(payload.ip || ''), expectedIp);
}

function isValidRealtimeSessionId(value: unknown) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= REALTIME_SESSION_ID_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

async function createRealtimeSessionCapability(
  sessionId: string,
  appId: string,
  appSecret: string,
) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    sid: sessionId,
    app: appId,
    iat: now,
    exp: now + REALTIME_SESSION_CAPABILITY_TTL,
    nonce: randomNonce(),
  };
  const payloadPart = stringToBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256(appSecret, `realtime-session:${payloadPart}`);
  return `${payloadPart}.${signature}`;
}

async function verifyRealtimeSessionCapability(
  token: string,
  sessionId: string,
  appId: string,
  appSecret: string,
) {
  if (
    typeof token !== 'string' ||
    !token ||
    token.length > REALTIME_SESSION_CAPABILITY_MAX_LENGTH
  ) {
    return false;
  }

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const expectedSignature = await hmacSha256(appSecret, `realtime-session:${parts[0]}`);
  if (!constantTimeEqual(expectedSignature, parts[1])) return false;

  let payload;
  try {
    payload = JSON.parse(base64UrlToString(parts[0]));
  } catch {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  return (
    payload?.v === 1 &&
    constantTimeEqual(String(payload.sid || ''), sessionId) &&
    constantTimeEqual(String(payload.app || ''), appId) &&
    typeof payload.iat === 'number' &&
    payload.iat <= now + 60 &&
    typeof payload.exp === 'number' &&
    payload.exp > now &&
    payload.exp - payload.iat === REALTIME_SESSION_CAPABILITY_TTL &&
    typeof payload.nonce === 'string' &&
    payload.nonce.length > 0
  );
}

function getAdminPassword(env: AppEnv) {
  // Secrets are opaque bytes-as-text. Leading/trailing whitespace is part of
  // the configured credential and must never be normalized into a different
  // password accepted by the login endpoint.
  return String(env.MXQR_ADMIN_PASSWORD || env.ADMIN_PASSWORD || '');
}

function getAdminSessionSecret(env: AppEnv) {
  return String(env.MXQR_ADMIN_SESSION_SECRET || env.ADMIN_SESSION_SECRET || '');
}

async function adminLoginRateIdentity(request: Request, env: AppEnv) {
  return hmacSha256(getAdminSessionSecret(env), `admin-login-rate:${getClientIp(request)}`);
}

function validAdminPassword(password: string) {
  if (typeof password !== 'string' || password.length === 0) return false;
  const byteLength = new TextEncoder().encode(password).byteLength;
  return byteLength >= ADMIN_PASSWORD_MIN_BYTES && byteLength <= ADMIN_PASSWORD_MAX_BYTES;
}

function isAdminConfigured(env: AppEnv) {
  return (
    validAdminPassword(getAdminPassword(env)) &&
    getAdminSessionSecret(env).length >= HMAC_SECRET_MIN_LENGTH
  );
}

function getAdminDb(env: AppEnv) {
  return env.MUSIXQUARE_ADMIN_DB || env.ADMIN_METRICS_DB || null;
}

async function verifyAdminPassword(password: string, env: AppEnv) {
  if (!validAdminPassword(password)) return false;
  const storedPassword = getAdminPassword(env);
  return validAdminPassword(storedPassword) && constantTimeEqual(password, storedPassword);
}

function readCookies(request: Request) {
  const header = request.headers.get('Cookie') || '';
  const cookies = new Map();
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function adminCookieHeader(token: string, request: Request, maxAge = ADMIN_SESSION_TTL_SECONDS) {
  void request;
  return `${ADMIN_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${maxAge}`;
}

function clearAdminCookieHeader(request: Request) {
  return adminCookieHeader('', request, 0);
}

async function createAdminSessionToken(env: AppEnv) {
  const now = Math.floor(Date.now() / 1000);
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  const payload = {
    v: 1,
    iat: now,
    exp: now + ADMIN_SESSION_TTL_SECONDS,
    nonce: bytesToBase64Url(random),
  };
  const payloadPart = stringToBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256(
    getAdminSessionSecret(env),
    `${ADMIN_SESSION_SIGNATURE_DOMAIN}${payloadPart}`,
  );
  return `${payloadPart}.${signature}`;
}

async function verifyAdminSession(request: Request, env: AppEnv) {
  if (!isAdminConfigured(env)) return false;
  const token = readCookies(request).get(ADMIN_SESSION_COOKIE) || '';
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const expectedSignature = await hmacSha256(
    getAdminSessionSecret(env),
    `${ADMIN_SESSION_SIGNATURE_DOMAIN}${parts[0]}`,
  );
  if (!constantTimeEqual(expectedSignature, parts[1])) return false;

  let payload;
  try {
    payload = JSON.parse(base64UrlToString(parts[0]));
  } catch {
    return false;
  }

  if (!isJsonObject(payload)) return false;
  const now = Math.floor(Date.now() / 1000);
  const keys = Object.keys(payload);
  return (
    keys.length === 4 &&
    keys.includes('v') &&
    keys.includes('iat') &&
    keys.includes('exp') &&
    keys.includes('nonce') &&
    payload.v === 1 &&
    typeof payload.iat === 'number' &&
    Number.isSafeInteger(payload.iat) &&
    typeof payload.exp === 'number' &&
    Number.isSafeInteger(payload.exp) &&
    payload.iat <= now + 60 &&
    payload.exp > now &&
    payload.exp - payload.iat === ADMIN_SESSION_TTL_SECONDS &&
    typeof payload.nonce === 'string' &&
    ADMIN_SESSION_NONCE_RE.test(payload.nonce)
  );
}

function adminApiMethodAllowed(request: Request, methods: string[]) {
  if (methods.includes(request.method)) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const contentType = String(request.headers.get('Content-Type') || '').toLowerCase();
      if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
        return json({ error: 'ADMIN_JSON_REQUIRED' }, 415);
      }
      const requestOrigin = new URL(request.url).origin;
      const origin = request.headers.get('Origin') || '';
      const fetchSite = String(request.headers.get('Sec-Fetch-Site') || '').toLowerCase();
      const sameOrigin = origin === requestOrigin || (!origin && fetchSite === 'same-origin');
      if (!sameOrigin || request.headers.get('X-MXQR-Admin-CSRF') !== '1') {
        return json({ error: 'ADMIN_CSRF_REJECTED' }, 403);
      }
    }
    return null;
  }
  return json({ error: 'METHOD_NOT_ALLOWED' }, 405, {
    Allow: methods.join(', '),
  });
}

async function handleAdminLogin(request: Request, env: AppEnv) {
  const methodError = adminApiMethodAllowed(request, ['POST', 'OPTIONS']);
  if (methodError) return methodError;
  if (request.method === 'OPTIONS') return withSecurityHeaders(new Response(null, { status: 204 }));
  if (!isAdminConfigured(env)) return json({ error: 'ADMIN_NOT_CONFIGURED' }, 503);
  const rate = await checkPaidRateLimit(
    request,
    env,
    'admin-login',
    10,
    60,
    await adminLoginRateIdentity(request, env),
    { identityIsPseudonymous: true },
  );
  if (rate.status !== 'ok') return rateLimitUnavailableResponse({});
  if (!rate.allowed) return rateLimitResponse({}, rate.retryAfterSeconds);

  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody);
  const body = parsedBody.value;
  const password = isJsonObject(body) && typeof body.password === 'string' ? body.password : '';
  if (!(await verifyAdminPassword(password, env))) {
    return json({ error: 'INVALID_PASSWORD' }, 401);
  }

  const token = await createAdminSessionToken(env);
  return json(
    {
      ok: true,
      expiresIn: ADMIN_SESSION_TTL_SECONDS,
    },
    200,
    {
      'Set-Cookie': adminCookieHeader(token, request),
    },
  );
}

async function handleAdminLogout(request: Request, env: AppEnv) {
  const methodError = adminApiMethodAllowed(request, ['POST']);
  if (methodError) return methodError;
  void env;
  return json({ ok: true }, 200, {
    'Set-Cookie': clearAdminCookieHeader(request),
  });
}

async function handleAdminSession(request: Request, env: AppEnv) {
  const methodError = adminApiMethodAllowed(request, ['GET', 'HEAD']);
  if (methodError) return methodError;
  const authenticated = await verifyAdminSession(request, env);
  return json({
    authenticated,
    configured: isAdminConfigured(env),
    databaseConfigured: !!getAdminDb(env),
  });
}

const adminProRoomRegistryReadyByDb = new WeakMap<D1Database, Promise<boolean>>();

type AdminRegistryStatementKind = 'read' | 'write' | 'ddl' | 'other';

interface AdminRegistryObservation {
  statementCount: number;
  statementKinds: Record<AdminRegistryStatementKind, number>;
}

function adminRegistryStatementKind(sql: string): AdminRegistryStatementKind {
  const operation = String(sql || '')
    .trimStart()
    .split(/\s+/u, 1)[0]
    ?.toUpperCase();
  if (operation === 'SELECT' || operation === 'PRAGMA') return 'read';
  if (operation === 'CREATE' || operation === 'ALTER' || operation === 'DROP') return 'ddl';
  if (operation === 'INSERT' || operation === 'UPDATE' || operation === 'DELETE') return 'write';
  return 'other';
}

function observeAdminRegistryDb(db: D1Database, observation: AdminRegistryObservation) {
  const recordStatement = (kind: AdminRegistryStatementKind) => {
    observation.statementCount += 1;
    observation.statementKinds[kind] += 1;
  };
  const observeStatement = (
    statement: D1PreparedStatement,
    kind: AdminRegistryStatementKind,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver);
        if (property === 'bind') {
          return typeof method === 'function'
            ? (...values: unknown[]) =>
                observeStatement(Reflect.apply(method, target, values), kind)
            : method;
        }
        if (
          (property === 'run' ||
            property === 'all' ||
            property === 'first' ||
            property === 'raw') &&
          typeof method === 'function'
        ) {
          return (...args: unknown[]) => {
            recordStatement(kind);
            return Reflect.apply(method, target, args);
          };
        }
        return method;
      },
    });
  return {
    prepare(sql: string) {
      return observeStatement(db.prepare(sql), adminRegistryStatementKind(sql));
    },
  };
}

function getProRoomAdminNamespace(env: AppEnv) {
  const namespace = env.PRO_ROOM_ADMIN_ROOMS;
  return namespace &&
    typeof namespace.idFromName === 'function' &&
    typeof namespace.get === 'function'
    ? namespace
    : null;
}

async function ensureAdminProRoomRegistry(db: D1Database) {
  if (!db?.prepare) return false;
  const existing = adminProRoomRegistryReadyByDb.get(db);
  if (existing) return existing;
  const sourceDb = db;
  const startedAtMs = Date.now();
  const observation = {
    statementCount: 0,
    statementKinds: { read: 0, write: 0, ddl: 0, other: 0 },
  };
  const observeCompletion = (outcome: string) => {
    console.info('[PRO registry] schema ensure', {
      event: 'admin_pro_room_registry_schema_ensure',
      outcome,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      statementCount: observation.statementCount,
      statementKinds: observation.statementKinds,
    });
  };
  const initialize = (async () => {
    const db = observeAdminRegistryDb(sourceDb, observation);
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${ADMIN_PRO_ROOM_REGISTRY_TABLE} (
          room_code TEXT PRIMARY KEY NOT NULL,
          label TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'registered',
          suspension_reason TEXT,
          activation_state TEXT NOT NULL DEFAULT 'unactivated',
          room_generation INTEGER NOT NULL DEFAULT 0 CHECK (room_generation >= 0),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`,
      )
      .run();
    const registryColumnStatement = db.prepare(
      `PRAGMA table_info(${ADMIN_PRO_ROOM_REGISTRY_TABLE})`,
    );
    const registryColumns =
      typeof registryColumnStatement.all === 'function'
        ? await registryColumnStatement.all<{ name: unknown }>()
        : { results: [] as { name: unknown }[] };
    if (
      !(registryColumns?.results || []).some(
        (column: { name: unknown }) => String(column?.name || '') === 'room_generation',
      )
    ) {
      try {
        await db
          .prepare(
            `ALTER TABLE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
             ADD COLUMN room_generation INTEGER NOT NULL DEFAULT 0
               CHECK (room_generation >= 0)`,
          )
          .run();
      } catch (error) {
        // Two freshly deployed isolates can observe the old schema before
        // either migration commits. The second ALTER is safe only when the
        // exact additive column already won that race.
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate column name:\s*room_generation/i.test(message)) {
          throw error;
        }
      }
    }
    if (
      !(registryColumns?.results || []).some(
        (column: { name: unknown }) => String(column?.name || '') === 'suspension_reason',
      )
    ) {
      try {
        await db
          .prepare(
            `ALTER TABLE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
             ADD COLUMN suspension_reason TEXT`,
          )
          .run();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate column name:\s*suspension_reason/i.test(message)) {
          throw error;
        }
      }
    }
    // Every pre-reason suspended row was created by the operator endpoint.
    // Backfill before installing the strict transition triggers below.
    await db
      .prepare(
        `UPDATE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         SET suspension_reason = 'operator_suspended'
         WHERE status = 'suspended' AND suspension_reason IS NULL`,
      )
      .run();
    await db
      .prepare(
        `UPDATE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         SET suspension_reason = NULL
         WHERE status <> 'suspended' AND suspension_reason IS NOT NULL`,
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE} (
          room_code TEXT NOT NULL,
          room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
          status TEXT NOT NULL CHECK (status = 'decommissioned'),
          decommissioned_at INTEGER NOT NULL,
          request_id TEXT,
          PRIMARY KEY (room_code, room_generation)
        )`,
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE} (
          room_code TEXT NOT NULL,
          room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
          allocated_at INTEGER NOT NULL CHECK (allocated_at >= 0),
          PRIMARY KEY (room_code, room_generation)
        )`,
      )
      .run();
    await db
      .prepare(
        `INSERT OR IGNORE INTO ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
          (room_code, room_generation, allocated_at)
         SELECT room_code, room_generation, created_at
         FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}`,
      )
      .run();
    await db
      .prepare(
        `INSERT OR IGNORE INTO ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
          (room_code, room_generation, allocated_at)
         SELECT room_code, room_generation, decommissioned_at
         FROM ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_allocations_no_update
         BEFORE UPDATE ON ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
         BEGIN
           SELECT RAISE(ABORT, 'PRO room generation allocation is immutable');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_allocations_no_delete
         BEFORE DELETE ON ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
         BEGIN
           SELECT RAISE(ABORT, 'PRO room generation allocation is immutable');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_history_no_update
         BEFORE UPDATE ON ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
         BEGIN
           SELECT RAISE(ABORT, 'PRO room generation history is immutable');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_history_requires_allocation
         BEFORE INSERT ON ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
         WHEN NOT EXISTS (
           SELECT 1
           FROM ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
           WHERE room_code = NEW.room_code
             AND room_generation = NEW.room_generation
         )
         BEGIN
           SELECT RAISE(ABORT, 'PRO room generation allocation is missing');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_no_delete
         BEFORE DELETE ON ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         BEGIN
           SELECT RAISE(ABORT, 'PRO room registry pointers are immutable');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_room_code_immutable
         BEFORE UPDATE OF room_code ON ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         WHEN NEW.room_code <> OLD.room_code
         BEGIN
           SELECT RAISE(ABORT, 'PRO room registry code is immutable');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_status_insert_guard
         BEFORE INSERT ON ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         WHEN NEW.status NOT IN (
           'registered',
           'provisioning',
           'suspended',
           'decommissioning',
           'decommissioned'
         )
         BEGIN
           SELECT RAISE(ABORT, 'Invalid PRO room registry status');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_status_transition_guard
         BEFORE UPDATE OF status, room_generation ON ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         WHEN NEW.status NOT IN (
             'registered',
             'provisioning',
             'suspended',
             'decommissioning',
             'decommissioned'
           )
           OR (
             NEW.room_generation = OLD.room_generation
             AND (
               (
                 OLD.status = 'decommissioning'
                 AND NEW.status NOT IN ('decommissioning', 'decommissioned')
               )
               OR (
                 OLD.status = 'decommissioned'
                 AND NEW.status <> 'decommissioned'
               )
             )
           )
           OR (
             NEW.room_generation = OLD.room_generation
             AND OLD.status <> 'decommissioned'
             AND NEW.status = 'decommissioned'
             AND (
               NOT EXISTS (
                 SELECT 1
                 FROM ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
                 WHERE room_code = NEW.room_code
                   AND room_generation = NEW.room_generation
               )
               OR NOT EXISTS (
                 SELECT 1
                 FROM ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
                 WHERE room_code = NEW.room_code
                   AND room_generation = NEW.room_generation
                   AND status = 'decommissioned'
               )
             )
           )
         BEGIN
           SELECT RAISE(
             ABORT,
             'Invalid PRO room registry status or terminal evidence transition'
           );
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_suspension_reason_insert_guard
         BEFORE INSERT ON ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         WHEN (
           NEW.status = 'suspended'
           AND (
             NEW.suspension_reason IS NULL
             OR NEW.suspension_reason NOT IN (
               'operator_suspended',
               'owner_account_deleted',
               'ownership_transfer_pending'
             )
           )
         ) OR (NEW.status <> 'suspended' AND NEW.suspension_reason IS NOT NULL)
         BEGIN
           SELECT RAISE(ABORT, 'Invalid PRO room suspension reason');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_suspension_reason_update_guard
         BEFORE UPDATE OF status, suspension_reason ON ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         WHEN (
           NEW.status = 'suspended'
           AND (
             NEW.suspension_reason IS NULL
             OR NEW.suspension_reason NOT IN (
               'operator_suspended',
               'owner_account_deleted',
               'ownership_transfer_pending'
             )
           )
         ) OR (NEW.status <> 'suspended' AND NEW.suspension_reason IS NOT NULL)
         BEGIN
           SELECT RAISE(ABORT, 'Invalid PRO room suspension reason');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_initial_generation_guard
         BEFORE INSERT ON ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         WHEN NOT EXISTS (
             SELECT 1
             FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
             WHERE room_code = NEW.room_code
           )
           AND (
             NEW.room_generation <> ${INITIAL_PRO_ROOM_GENERATION}
             OR EXISTS (
               SELECT 1
               FROM ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
               WHERE room_code = NEW.room_code
             )
             OR EXISTS (
               SELECT 1
               FROM ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
               WHERE room_code = NEW.room_code
             )
           )
         BEGIN
           SELECT RAISE(ABORT, 'PRO room registry repair required');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_allocate_initial_generation
         AFTER INSERT ON ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         BEGIN
           INSERT INTO ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
             (room_code, room_generation, allocated_at)
           VALUES (NEW.room_code, NEW.room_generation, NEW.created_at);
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${ADMIN_PRO_ROOM_GENERATION_CUTOVER_TABLE} (
          contract_version INTEGER PRIMARY KEY CHECK (contract_version = 1),
          status TEXT NOT NULL CHECK (status IN ('disabled', 'ready')),
          release_sha TEXT,
          ever_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ever_enabled IN (0, 1)),
          floor_release_sha TEXT,
          updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
          CHECK (
            (status = 'disabled' AND release_sha IS NULL)
            OR (
              status = 'ready'
              AND ever_enabled = 1
              AND length(release_sha) = 40
              AND release_sha NOT GLOB '*[^0-9a-f]*'
            )
          ),
          CHECK (
            (ever_enabled = 0 AND floor_release_sha IS NULL)
            OR (
              ever_enabled = 1
              AND length(floor_release_sha) = 40
              AND floor_release_sha NOT GLOB '*[^0-9a-f]*'
            )
          )
        )`,
      )
      .run();
    await db
      .prepare(
        `INSERT OR IGNORE INTO ${ADMIN_PRO_ROOM_GENERATION_CUTOVER_TABLE}
          (
            contract_version,
            status,
            release_sha,
            ever_enabled,
            floor_release_sha,
            updated_at
          )
         VALUES (
           ${ADMIN_PRO_ROOM_GENERATION_CONTRACT_VERSION},
           'disabled',
           NULL,
           0,
           NULL,
           0
         )`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_cutover_floor_immutable
         BEFORE UPDATE OF status, release_sha, ever_enabled, floor_release_sha
         ON ${ADMIN_PRO_ROOM_GENERATION_CUTOVER_TABLE}
         WHEN (
             OLD.ever_enabled = 1
             AND (
               NEW.ever_enabled <> 1
               OR NEW.floor_release_sha IS NOT OLD.floor_release_sha
             )
           )
           OR (
             OLD.ever_enabled = 0
             AND NEW.ever_enabled = 1
             AND (
               NEW.status <> 'ready'
               OR NEW.release_sha IS NULL
               OR NEW.floor_release_sha IS NOT NEW.release_sha
               OR length(NEW.release_sha) <> 40
               OR NEW.release_sha GLOB '*[^0-9a-f]*'
             )
           )
         BEGIN
           SELECT RAISE(ABORT, 'PRO room generation rollback floor is immutable');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_cutover_no_delete
         BEFORE DELETE ON ${ADMIN_PRO_ROOM_GENERATION_CUTOVER_TABLE}
         BEGIN
           SELECT RAISE(ABORT, 'PRO room generation cutover is permanent');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_allocate_next_generation
         BEFORE UPDATE OF room_generation ON ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         WHEN NEW.room_generation <> OLD.room_generation
         BEGIN
           SELECT CASE
             WHEN OLD.status <> 'decommissioned'
               OR NEW.status <> 'provisioning'
               OR NEW.room_generation <> OLD.room_generation + 1
               OR NEW.room_generation > ${MAX_PRO_ROOM_GENERATION}
             THEN RAISE(ABORT, 'Invalid PRO room generation transition')
           END;
           SELECT CASE
             WHEN NOT EXISTS (
               SELECT 1
               FROM ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
               WHERE room_code = OLD.room_code
                 AND room_generation = OLD.room_generation
             )
             THEN RAISE(ABORT, 'PRO room current generation allocation is missing')
           END;
           SELECT CASE
             WHEN NOT EXISTS (
               SELECT 1
               FROM ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
               WHERE room_code = OLD.room_code
                 AND room_generation = OLD.room_generation
                 AND status = 'decommissioned'
             )
             THEN RAISE(ABORT, 'PRO room generation history is missing')
           END;
           SELECT CASE
             WHEN NOT EXISTS (
               SELECT 1
               FROM ${ADMIN_PRO_ROOM_GENERATION_CUTOVER_TABLE}
               WHERE contract_version = ${ADMIN_PRO_ROOM_GENERATION_CONTRACT_VERSION}
                 AND status = 'ready'
                 AND ever_enabled = 1
                 AND length(release_sha) = 40
                 AND release_sha NOT GLOB '*[^0-9a-f]*'
                 AND length(floor_release_sha) = 40
                 AND floor_release_sha NOT GLOB '*[^0-9a-f]*'
             )
             THEN RAISE(ABORT, 'PRO room generation cutover is not ready')
           END;
           INSERT INTO ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
             (room_code, room_generation, allocated_at)
           VALUES (NEW.room_code, NEW.room_generation, NEW.created_at);
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_history_no_delete
         BEFORE DELETE ON ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
         BEGIN
           SELECT RAISE(ABORT, 'PRO room generation history is immutable');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${ADMIN_PRO_ROOM_AUDIT_TABLE} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_id TEXT NOT NULL,
          action TEXT NOT NULL,
          result TEXT NOT NULL,
          room_code TEXT NOT NULL,
          room_generation INTEGER NOT NULL DEFAULT 0 CHECK (room_generation >= 0),
          created_at INTEGER NOT NULL
        )`,
      )
      .run();
    const auditColumnStatement = db.prepare(`PRAGMA table_info(${ADMIN_PRO_ROOM_AUDIT_TABLE})`);
    const auditColumns =
      typeof auditColumnStatement.all === 'function'
        ? await auditColumnStatement.all<{ name: unknown }>()
        : { results: [] as { name: unknown }[] };
    if (
      !(auditColumns?.results || []).some(
        (column: { name: unknown }) => String(column?.name || '') === 'room_generation',
      )
    ) {
      try {
        await db
          .prepare(
            `ALTER TABLE ${ADMIN_PRO_ROOM_AUDIT_TABLE}
             ADD COLUMN room_generation INTEGER NOT NULL DEFAULT 0
               CHECK (room_generation >= 0)`,
          )
          .run();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate column name:\s*room_generation/i.test(message)) {
          throw error;
        }
      }
    }
    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_mxqr_pro_room_admin_audit_incarnation_created
         ON ${ADMIN_PRO_ROOM_AUDIT_TABLE}(room_code, room_generation, created_at)`,
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${ADMIN_PRO_ROOM_OWNER_TRANSFER_SAGA_TABLE} (
          room_code TEXT NOT NULL
            CHECK (length(room_code) = 6 AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'),
          room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
          claim_generation INTEGER CHECK (claim_generation IS NULL OR claim_generation >= 0),
          transfer_id TEXT CHECK (
            transfer_id IS NULL OR (
            length(transfer_id) = 31
            AND substr(transfer_id, 1, 9) = 'transfer_'
            AND transfer_id NOT GLOB '*[^A-Za-z0-9_-]*'
            )
          ),
          request_id TEXT NOT NULL CHECK (
            length(request_id) BETWEEN 16 AND 64
            AND request_id NOT GLOB '*[^A-Za-z0-9_-]*'
          ),
          target_account_id TEXT NOT NULL CHECK (
            length(target_account_id) = 27
            AND substr(target_account_id, 1, 5) = 'acct_'
            AND target_account_id NOT GLOB '*[^A-Za-z0-9_-]*'
          ),
          previous_owner_account_id TEXT CHECK (
            previous_owner_account_id IS NULL
            OR (
              length(previous_owner_account_id) = 27
              AND substr(previous_owner_account_id, 1, 5) = 'acct_'
              AND previous_owner_account_id NOT GLOB '*[^A-Za-z0-9_-]*'
              AND previous_owner_account_id <> target_account_id
            )
          ),
          fence_digest TEXT CHECK (
            fence_digest IS NULL OR (
            length(fence_digest) = 43
            AND fence_digest NOT GLOB '*[^A-Za-z0-9_-]*'
            )
          ),
          state TEXT NOT NULL CHECK (state IN (
            'intent', 'prepared', 'committed', 'registry_active',
            'old_owner_edge_retired', 'verified', 'complete',
            'target_deleted', 'expired', 'superseded'
          )),
          intent_at INTEGER NOT NULL CHECK (intent_at >= 0),
          prepared_at INTEGER CHECK (prepared_at IS NULL OR prepared_at >= 0),
          expires_at INTEGER NOT NULL CHECK (
            expires_at > 0 AND (prepared_at IS NULL OR expires_at > prepared_at)
          ),
          updated_at INTEGER NOT NULL CHECK (updated_at >= intent_at),
          CHECK (
            (transfer_id IS NULL AND claim_generation IS NULL
             AND previous_owner_account_id IS NULL
             AND fence_digest IS NULL AND prepared_at IS NULL
             AND state IN ('intent', 'expired', 'superseded'))
            OR
            (transfer_id IS NOT NULL AND claim_generation IS NOT NULL
             AND fence_digest IS NOT NULL AND prepared_at IS NOT NULL
             AND state <> 'intent')
          ),
          PRIMARY KEY (room_code, room_generation, request_id)
        )`,
      )
      .run();
    await db
      .prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_mxqr_pro_room_owner_transfer_sagas_txn
         ON ${ADMIN_PRO_ROOM_OWNER_TRANSFER_SAGA_TABLE}
           (room_code, room_generation, transfer_id)
         WHERE transfer_id IS NOT NULL`,
      )
      .run();
    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_mxqr_pro_room_owner_transfer_sagas_state_updated
         ON ${ADMIN_PRO_ROOM_OWNER_TRANSFER_SAGA_TABLE}
           (state, updated_at, room_code, room_generation)`,
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${ADMIN_PRO_ROOM_OWNER_TRANSFER_ISSUANCE_TABLE} (
          room_code TEXT NOT NULL
            CHECK (length(room_code) = 6 AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'),
          room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
          claim_generation INTEGER NOT NULL CHECK (claim_generation >= 0),
          target_account_id TEXT NOT NULL CHECK (
            length(target_account_id) = 27
            AND substr(target_account_id, 1, 5) = 'acct_'
            AND target_account_id NOT GLOB '*[^A-Za-z0-9_-]*'
          ),
          transfer_id TEXT CHECK (
            transfer_id IS NULL
            OR (
              length(transfer_id) = 31
              AND substr(transfer_id, 1, 9) = 'transfer_'
              AND transfer_id NOT GLOB '*[^A-Za-z0-9_-]*'
            )
          ),
          request_id TEXT CHECK (
            request_id IS NULL
            OR (
              length(request_id) BETWEEN 16 AND 64
              AND request_id NOT GLOB '*[^A-Za-z0-9_-]*'
            )
          ),
          state TEXT NOT NULL CHECK (state IN ('issued', 'prepared', 'expired', 'superseded')),
          issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
          expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
          updated_at INTEGER NOT NULL CHECK (updated_at >= issued_at),
          CHECK ((transfer_id IS NULL) = (request_id IS NULL)),
          CHECK (state <> 'prepared' OR transfer_id IS NOT NULL),
          PRIMARY KEY (room_code, room_generation, claim_generation)
        )`,
      )
      .run();
    await db
      .prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_mxqr_pro_room_owner_transfer_issuances_txn
         ON ${ADMIN_PRO_ROOM_OWNER_TRANSFER_ISSUANCE_TABLE}
           (room_code, room_generation, transfer_id, request_id)
         WHERE transfer_id IS NOT NULL`,
      )
      .run();
    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_mxqr_pro_room_owner_transfer_issuances_state_expiry
         ON ${ADMIN_PRO_ROOM_OWNER_TRANSFER_ISSUANCE_TABLE}
           (state, expires_at, room_code, room_generation)`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS trg_mxqr_pro_room_owner_transfer_issuance_expiry_audit
         AFTER UPDATE OF state ON ${ADMIN_PRO_ROOM_OWNER_TRANSFER_ISSUANCE_TABLE}
         WHEN OLD.state = 'issued' AND NEW.state = 'expired'
         BEGIN
           INSERT INTO ${ADMIN_PRO_ROOM_AUDIT_TABLE}
             (actor_id, action, result, room_code, room_generation, created_at)
           VALUES
             ('system:owner-transfer', 'owner_transfer_claim.expire', 'expired',
              NEW.room_code, NEW.room_generation, NEW.updated_at);
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS trg_mxqr_pro_room_owner_transfer_saga_expiry_audit
         AFTER UPDATE OF state ON ${ADMIN_PRO_ROOM_OWNER_TRANSFER_SAGA_TABLE}
         WHEN OLD.state IN ('intent', 'prepared') AND NEW.state = 'expired'
         BEGIN
           INSERT INTO ${ADMIN_PRO_ROOM_AUDIT_TABLE}
             (actor_id, action, result, room_code, room_generation, created_at)
           VALUES
             ('system:owner-transfer', 'owner_transfer.prepare', 'expired',
              NEW.room_code, NEW.room_generation, NEW.updated_at);
         END`,
      )
      .run();
    const nowMs = Date.now();
    for (const room of INITIAL_ADMIN_PRO_ROOMS) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
            (room_code, label, status, activation_state, room_generation, created_at, updated_at)
           VALUES (?1, ?2, 'registered', 'unactivated', ${INITIAL_PRO_ROOM_GENERATION}, ?3, ?3)`,
        )
        .bind(room.roomCode, room.label, nowMs)
        .run();
    }
    return true;
  })().then(
    (value) => {
      observeCompletion('ready');
      return value;
    },
    (error) => {
      observeCompletion('error');
      throw error;
    },
  );
  adminProRoomRegistryReadyByDb.set(db, initialize);
  try {
    return await initialize;
  } catch (error) {
    adminProRoomRegistryReadyByDb.delete(db);
    throw error;
  }
}

export async function ensureAdminProRoomRegistryForTests(db: unknown) {
  if (!isAppD1Database(db)) throw new TypeError('Admin registry database unavailable');
  return ensureAdminProRoomRegistry(db);
}

interface AdminProRoomRecord {
  roomCode: string;
  roomGeneration: number;
  label: string;
  status: string;
  suspensionReason: string | null;
  activationState: 'active' | 'unactivated';
  createdAt: number;
  updatedAt: number;
}

type AdminProRoomWithOwnerState = AdminProRoomRecord & {
  ownerAccountLinked?: boolean | null;
  ownerTransferPrepared?: boolean | null;
};

function normalizeAdminProRoomRow(row: Record<string, unknown> | null): AdminProRoomRecord | null {
  if (!row || typeof row.room_code !== 'string' || !ADMIN_PRO_ROOM_CODE_RE.test(row.room_code)) {
    return null;
  }
  const label = String(row.label || '').trim();
  const roomGeneration = Number(row.room_generation);
  const status = String(row.status || '');
  const suspensionReason = typeof row.suspension_reason === 'string' ? row.suspension_reason : null;
  if (!label || label.length > ADMIN_PRO_ROOM_LABEL_MAX_LENGTH) return null;
  if (!isProRoomGeneration(roomGeneration)) return null;
  if (
    !['registered', 'provisioning', 'suspended', 'decommissioning', 'decommissioned'].includes(
      status,
    )
  ) {
    return null;
  }
  if (
    (status === 'suspended' &&
      (suspensionReason === null ||
        !['operator_suspended', 'owner_account_deleted', 'ownership_transfer_pending'].includes(
          suspensionReason,
        ))) ||
    (status !== 'suspended' && suspensionReason !== null)
  ) {
    return null;
  }
  return {
    roomCode: row.room_code,
    roomGeneration,
    label,
    status,
    suspensionReason,
    // Display-only index. Every privileged decision is re-authorized against
    // the cross-script Durable Object, which owns the canonical room status.
    activationState: row.activation_state === 'active' ? 'active' : 'unactivated',
    createdAt: Number.isSafeInteger(Number(row.created_at)) ? Number(row.created_at) : 0,
    updatedAt: Number.isSafeInteger(Number(row.updated_at)) ? Number(row.updated_at) : 0,
  };
}

function normalizeAdminProRoomLabel(value: unknown) {
  const label = typeof value === 'string' ? value.trim() : '';
  return label &&
    label.length <= ADMIN_PRO_ROOM_LABEL_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(label)
    ? label
    : null;
}

async function readAdminProRoom(db: D1Database | null, roomCode: string) {
  if (!db?.prepare) return null;
  await ensureAdminProRoomRegistry(db);
  const statement = db
    .prepare(
      `SELECT room_code, label, status, suspension_reason, activation_state, created_at, updated_at
              , room_generation
       FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
       WHERE room_code = ?1 LIMIT 1`,
    )
    .bind(roomCode);
  const row =
    typeof statement.first === 'function'
      ? await statement.first()
      : (await statement.all())?.results?.[0] || null;
  return normalizeAdminProRoomRow(row);
}

async function isAdminProRoomGenerationReuseReady(db: D1Database) {
  if (!db?.prepare) return false;
  try {
    const statement = db
      .prepare(
        `SELECT status, release_sha, ever_enabled, floor_release_sha
         FROM ${ADMIN_PRO_ROOM_GENERATION_CUTOVER_TABLE}
         WHERE contract_version = ?1
         LIMIT 1`,
      )
      .bind(ADMIN_PRO_ROOM_GENERATION_CONTRACT_VERSION);
    const row =
      typeof statement.first === 'function'
        ? await statement.first()
        : (await statement.all())?.results?.[0] || null;
    return (
      row?.status === 'ready' &&
      Number(row.ever_enabled) === 1 &&
      RELEASE_SHA_RE.test(String(row.release_sha || '')) &&
      RELEASE_SHA_RE.test(String(row.floor_release_sha || ''))
    );
  } catch {
    // This row is written only after all three D1 migrations and every
    // generation-aware dependency Worker have been verified. Missing schema,
    // an unavailable database, or malformed evidence must never permit reuse.
    return false;
  }
}

async function readAdminProRoomAllocationEvidence(
  db: D1Database,
  roomCode: string,
  roomGeneration: number | null = null,
) {
  if (!db?.prepare || !ADMIN_PRO_ROOM_CODE_RE.test(roomCode || '')) {
    throw new Error('INVALID_PRO_ROOM_ALLOCATION_LOOKUP');
  }
  const generationPredicate = roomGeneration === null ? '' : ' AND room_generation = ?2';
  const statement = db
    .prepare(
      `SELECT
         EXISTS (
           SELECT 1
           FROM ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
           WHERE room_code = ?1${generationPredicate}
         ) AS has_allocation,
         EXISTS (
           SELECT 1
           FROM ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
           WHERE room_code = ?1${generationPredicate}
         ) AS has_history`,
    )
    .bind(...(roomGeneration === null ? [roomCode] : [roomCode, roomGeneration]));
  const row =
    typeof statement.first === 'function'
      ? await statement.first()
      : (await statement.all())?.results?.[0] || null;
  return {
    hasAllocation: Number(row?.has_allocation) === 1,
    hasHistory: Number(row?.has_history) === 1,
  };
}

async function listAdminProRooms(db: D1Database): Promise<AdminProRoomRecord[]> {
  await ensureAdminProRoomRegistry(db);
  const result = await db
    .prepare(
      `SELECT room_code, label, status, suspension_reason, activation_state, created_at, updated_at
              , room_generation
       FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
       ORDER BY CASE WHEN status = 'decommissioned' THEN 1 ELSE 0 END ASC,
                room_code ASC
       LIMIT ?1`,
    )
    .bind(ADMIN_PRO_ROOM_REGISTRY_LIMIT)
    .all<Record<string, unknown>>();
  return (result?.results || [])
    .map(normalizeAdminProRoomRow)
    .filter((room): room is AdminProRoomRecord => room !== null);
}

async function attachCanonicalAdminProRoomOwnerState(
  env: AppEnv,
  db: D1Database,
  rooms: AdminProRoomRecord[],
) {
  const needsOwnerState = (room: AdminProRoomRecord) =>
    room?.activationState === 'active' &&
    (room.status === 'registered' || room.status === 'suspended');
  const enriched: AdminProRoomWithOwnerState[] = rooms.map((room) =>
    needsOwnerState(room)
      ? { ...room, ownerAccountLinked: null, ownerTransferPrepared: null }
      : room,
  );
  const activeIndexes = enriched
    .map((room, index) => (needsOwnerState(room) ? index : -1))
    .filter((index) => index >= 0);

  for (
    let offset = 0;
    offset < activeIndexes.length;
    offset += ADMIN_PRO_ROOM_OWNER_STATE_BATCH_SIZE
  ) {
    const batch = activeIndexes.slice(offset, offset + ADMIN_PRO_ROOM_OWNER_STATE_BATCH_SIZE);
    await Promise.all(
      batch.map(async (index) => {
        const room = enriched[index];
        if (!room) return;
        const result = await callProRoomAdminObject(
          env,
          room.roomCode,
          room.roomGeneration,
          '/internal/admin/status',
          'GET',
        );
        const payload = result.payload;
        if (
          result.response?.ok !== true ||
          !isProRoomAdminStatusPayload(payload, room.roomCode, room.roomGeneration) ||
          payload.provisioned !== true ||
          typeof payload.ownerAccountLinked !== 'boolean'
        ) {
          return;
        }
        if (
          (payload.status === 'active' || payload.status === 'suspended') &&
          typeof payload.ownerAccountId === 'string' &&
          ACCOUNT_ID_RE.test(payload.ownerAccountId)
        ) {
          const backfilled = await upsertProRoomOwnerEntitlement(env, {
            accountId: payload.ownerAccountId,
            roomCode: room.roomCode,
            roomGeneration: room.roomGeneration,
            status: payload.status,
            sourceRef: `legacy-backfill:${room.roomCode}:${room.roomGeneration}`,
            nowMs: Date.now(),
          }).catch(() => false);
          if (!backfilled) {
            console.warn('[PRO entitlement] canonical owner backfill unavailable', {
              roomCode: room.roomCode,
              roomGeneration: room.roomGeneration,
            });
          }
        }
        if (payload.status === 'active' && payload.suspensionReason == null) {
          enriched[index] = {
            ...room,
            ownerAccountLinked: payload.ownerAccountLinked,
            ownerTransferPrepared: payload.ownerTransferReconciliation != null,
          };
          return;
        }
        if (
          payload.status === 'suspended' &&
          typeof payload.suspensionReason === 'string' &&
          ['operator_suspended', 'owner_account_deleted', 'ownership_transfer_pending'].includes(
            payload.suspensionReason,
          )
        ) {
          enriched[index] = {
            ...room,
            status: 'suspended',
            suspensionReason: payload.suspensionReason,
            activationState: 'active',
            ownerAccountLinked: payload.ownerAccountLinked,
            ownerTransferPrepared: payload.ownerTransferReconciliation != null,
          };
          // The canonical status response can itself discover a deleted owner
          // and durably suspend the room. Preserve that state in this response
          // even if the best-effort D1 projection repair is temporarily down.
          await markAdminProRoomOperationalState(
            db,
            room.roomCode,
            room.roomGeneration,
            'suspended',
            payload.suspensionReason,
          ).catch(() => {});
        }
      }),
    );
  }
  return enriched;
}

async function verifyCanonicalOwnerEntitlementBackfill(env: AppEnv, db: D1Database | null) {
  if (!db?.prepare) return false;
  if (!db?.prepare || !getProRoomAdminNamespace(env)) return false;
  let rooms;
  try {
    rooms = await listAdminProRooms(db);
  } catch {
    return false;
  }
  const candidates = rooms.filter(
    (room) =>
      room?.activationState === 'active' &&
      (room.status === 'registered' || room.status === 'suspended'),
  );
  for (
    let offset = 0;
    offset < candidates.length;
    offset += ADMIN_PRO_ROOM_OWNER_STATE_BATCH_SIZE
  ) {
    const batch = candidates.slice(offset, offset + ADMIN_PRO_ROOM_OWNER_STATE_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (room) => {
        const status = await callProRoomAdminObject(
          env,
          room.roomCode,
          room.roomGeneration,
          '/internal/admin/status',
          'GET',
        );
        const payload = status.payload;
        if (
          status.response?.ok !== true ||
          !isProRoomAdminStatusPayload(payload, room.roomCode, room.roomGeneration) ||
          payload.provisioned !== true ||
          (payload.status !== 'active' && payload.status !== 'suspended') ||
          typeof payload.ownerAccountLinked !== 'boolean'
        ) {
          return false;
        }
        if (!payload.ownerAccountLinked) return true;
        if (
          typeof payload.ownerAccountId !== 'string' ||
          !ACCOUNT_ID_RE.test(payload.ownerAccountId)
        ) {
          return false;
        }
        return upsertProRoomOwnerEntitlement(env, {
          accountId: payload.ownerAccountId,
          roomCode: room.roomCode,
          roomGeneration: room.roomGeneration,
          status: payload.status,
          sourceRef: `legacy-backfill:${room.roomCode}:${room.roomGeneration}`,
          nowMs: Date.now(),
        });
      }),
    );
    if (results.some((result) => result !== true)) return false;
  }
  return markProRoomOwnerEntitlementBackfillComplete(env, Date.now());
}

async function registerAdminProRoom(
  db: D1Database,
  roomCode: string,
  label: unknown,
  nowMs: number = Date.now(),
) {
  await ensureAdminProRoomRegistry(db);
  const before = await readAdminProRoom(db, roomCode);
  let created = false;
  let reused = false;
  let generationExhausted = false;
  let generationCutoverNotReady = false;
  let repairRequired = false;

  if (!before) {
    const inserted = await db
      .prepare(
        `INSERT OR IGNORE INTO ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
          (room_code, label, status, activation_state, room_generation, created_at, updated_at)
         SELECT ?1, ?2, 'provisioning', 'unactivated',
                ${INITIAL_PRO_ROOM_GENERATION}, ?3, ?3
         WHERE (
           SELECT COUNT(*)
           FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
           WHERE status <> 'decommissioned'
         ) < ?4
           AND NOT EXISTS (
             SELECT 1
             FROM ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
             WHERE room_code = ?1
           )
           AND NOT EXISTS (
             SELECT 1
             FROM ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
             WHERE room_code = ?1
           )`,
      )
      .bind(roomCode, label, nowMs, ADMIN_PRO_ROOM_REGISTRY_LIMIT)
      .run();
    created = Number(inserted?.meta?.changes || 0) === 1;
  } else if (before.status === 'decommissioned') {
    if (!(await isAdminProRoomGenerationReuseReady(db))) {
      generationCutoverNotReady = true;
    } else if (before.roomGeneration >= MAX_PRO_ROOM_GENERATION) {
      generationExhausted = true;
    } else {
      // Older deployments only kept the terminal row in the registry. Copy
      // that already-completed incarnation into the immutable history before
      // replacing the public room-code pointer. Newer room workers insert the
      // same row (including request_id) when their deletion saga completes.
      await db
        .prepare(
          `INSERT OR IGNORE INTO ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
            (room_code, room_generation, status, decommissioned_at, request_id)
           SELECT room_code, room_generation, 'decommissioned', updated_at, NULL
           FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
           WHERE room_code = ?1
             AND room_generation = ?2
             AND status = 'decommissioned'`,
        )
        .bind(roomCode, before.roomGeneration)
        .run();
      const replaced = await db
        .prepare(
          `UPDATE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
           SET label = ?2,
               status = 'provisioning',
               suspension_reason = NULL,
               activation_state = 'unactivated',
               room_generation = room_generation + 1,
               created_at = ?3,
               updated_at = ?3
           WHERE room_code = ?1
             AND room_generation = ?4
             AND status = 'decommissioned'
             AND room_generation < ?5
             AND (
               SELECT COUNT(*)
               FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
               WHERE status <> 'decommissioned'
             ) < ?6
             AND EXISTS (
                SELECT 1
                FROM ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE} AS history
                WHERE history.room_code = ?1
                  AND history.room_generation = ?4
                  AND history.status = 'decommissioned'
              )
              AND EXISTS (
                SELECT 1
                FROM ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE} AS current_allocation
                WHERE current_allocation.room_code = ?1
                  AND current_allocation.room_generation = ?4
              )
              AND NOT EXISTS (
                SELECT 1
                FROM ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE} AS next_allocation
                WHERE next_allocation.room_code = ?1
                  AND next_allocation.room_generation = ?4 + 1
              )
              AND EXISTS (
                SELECT 1
                FROM ${ADMIN_PRO_ROOM_GENERATION_CUTOVER_TABLE} AS cutover
                WHERE cutover.contract_version = ${ADMIN_PRO_ROOM_GENERATION_CONTRACT_VERSION}
                  AND cutover.status = 'ready'
                  AND cutover.ever_enabled = 1
                  AND length(cutover.release_sha) = 40
                  AND cutover.release_sha NOT GLOB '*[^0-9a-f]*'
                  AND length(cutover.floor_release_sha) = 40
                  AND cutover.floor_release_sha NOT GLOB '*[^0-9a-f]*'
              )`,
        )
        .bind(
          roomCode,
          label,
          nowMs,
          before.roomGeneration,
          MAX_PRO_ROOM_GENERATION,
          ADMIN_PRO_ROOM_REGISTRY_LIMIT,
        )
        .run();
      reused = Number(replaced?.meta?.changes || 0) === 1;
      if (!reused && !(await isAdminProRoomGenerationReuseReady(db))) {
        generationCutoverNotReady = true;
      }
      created = reused;
    }
  }
  const room = await readAdminProRoom(db, roomCode);
  if (!room) {
    const evidence = await readAdminProRoomAllocationEvidence(db, roomCode);
    repairRequired = evidence.hasAllocation || evidence.hasHistory;
  } else if (
    before?.status === 'decommissioned' &&
    !reused &&
    !generationCutoverNotReady &&
    !generationExhausted &&
    room.roomGeneration === before.roomGeneration
  ) {
    const currentEvidence = await readAdminProRoomAllocationEvidence(
      db,
      roomCode,
      before.roomGeneration,
    );
    const nextEvidence = await readAdminProRoomAllocationEvidence(
      db,
      roomCode,
      before.roomGeneration + 1,
    );
    repairRequired =
      !currentEvidence.hasAllocation ||
      !currentEvidence.hasHistory ||
      nextEvidence.hasAllocation ||
      nextEvidence.hasHistory;
  }
  return {
    created,
    reused,
    generationExhausted,
    generationCutoverNotReady,
    repairRequired,
    capacityExceeded:
      (!room && !repairRequired) ||
      (before?.status === 'decommissioned' &&
        !reused &&
        !generationCutoverNotReady &&
        !generationExhausted &&
        !repairRequired &&
        room?.status === 'decommissioned' &&
        room?.roomGeneration === before.roomGeneration),
    room,
  };
}

async function markAdminProRoomRegistered(
  db: D1Database,
  roomCode: string,
  roomGeneration: number,
  activationState: string,
  nowMs: number = Date.now(),
) {
  await ensureAdminProRoomRegistry(db);
  const result = await db
    .prepare(
      `UPDATE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
       SET status = 'registered', suspension_reason = NULL,
           activation_state = ?3, updated_at = ?4
       WHERE room_code = ?1
         AND room_generation = ?2
         AND status NOT IN ('suspended', 'decommissioning', 'decommissioned')`,
    )
    .bind(roomCode, roomGeneration, activationState === 'active' ? 'active' : 'unactivated', nowMs)
    .run();
  return Number(result?.meta?.changes || 0) === 1;
}

async function markAdminProRoomOperationalState(
  db: D1Database,
  roomCode: string,
  roomGeneration: number,
  status: string,
  suspensionReason: string | null = status === 'suspended' ? 'operator_suspended' : null,
  nowMs: number = Date.now(),
) {
  if (
    status === 'suspended' &&
    (suspensionReason === null ||
      !['operator_suspended', 'owner_account_deleted', 'ownership_transfer_pending'].includes(
        suspensionReason,
      ))
  ) {
    throw new Error('Invalid PRO room suspension reason');
  }
  await ensureAdminProRoomRegistry(db);
  const result = await db
    .prepare(
      `UPDATE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
       SET status = ?3, suspension_reason = ?4,
           activation_state = 'active', updated_at = ?5
       WHERE room_code = ?1
         AND room_generation = ?2
         AND status NOT IN ('decommissioning', 'decommissioned')`,
    )
    .bind(
      roomCode,
      roomGeneration,
      status === 'suspended' ? 'suspended' : 'registered',
      status === 'suspended' ? suspensionReason : null,
      nowMs,
    )
    .run();
  return Number(result?.meta?.changes || 0) === 1;
}

async function reconcileAdminProRoomStatus(
  env: AppEnv,
  db: D1Database,
  roomOrCode: string | { roomCode: string; roomGeneration: number; status: string },
) {
  const room = typeof roomOrCode === 'string' ? await readAdminProRoom(db, roomOrCode) : roomOrCode;
  if (!room) return null;
  const { roomCode, roomGeneration } = room;
  const statusResult = await callProRoomAdminObject(
    env,
    roomCode,
    roomGeneration,
    '/internal/admin/status',
    'GET',
  );
  const payload = statusResult.payload;
  if (
    !statusResult.response?.ok ||
    !proRoomAdminResponseIdentityMatches(payload, roomCode, roomGeneration) ||
    payload.provisioned !== true ||
    typeof payload.status !== 'string' ||
    !['unactivated', 'active', 'suspended'].includes(payload.status)
  ) {
    return null;
  }
  const suspensionReason =
    payload.status === 'suspended' &&
    typeof payload.suspensionReason === 'string' &&
    payload.suspensionReason !== null &&
    ['operator_suspended', 'owner_account_deleted', 'ownership_transfer_pending'].includes(
      payload.suspensionReason,
    )
      ? payload.suspensionReason
      : null;
  if (
    (payload.status === 'suspended' && !suspensionReason) ||
    (payload.status !== 'suspended' && payload.suspensionReason != null)
  ) {
    return null;
  }
  if (payload.status === 'suspended') {
    await ensureAdminProRoomRegistry(db);
    await db
      .prepare(
        `UPDATE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         SET status = 'suspended', suspension_reason = ?3,
             activation_state = 'active', updated_at = ?4
         WHERE room_code = ?1
           AND room_generation = ?2
           AND status NOT IN ('decommissioning', 'decommissioned')`,
      )
      .bind(roomCode, roomGeneration, suspensionReason, Date.now())
      .run();
  } else {
    if (room.status === 'suspended' && payload.status === 'active') {
      await markAdminProRoomOperationalState(db, roomCode, roomGeneration, 'active');
    } else {
      await markAdminProRoomRegistered(db, roomCode, roomGeneration, payload.status);
    }
  }
  return payload.status;
}

async function reconcileStaleAdminProRoomActivations(
  env: AppEnv,
  db: D1Database,
  rooms: Array<{
    roomCode: string;
    roomGeneration: number;
    status: string;
    activationState: string;
    updatedAt: number;
  }>,
  nowMs: number = Date.now(),
) {
  if (!getProRoomAdminNamespace(env)) return false;
  const candidates = rooms
    .filter(
      (room) =>
        room?.status === 'registered' &&
        room.activationState === 'unactivated' &&
        Number.isSafeInteger(room.updatedAt) &&
        room.updatedAt > 0 &&
        room.updatedAt <= nowMs - ADMIN_PRO_ROOM_ACTIVATION_RECONCILE_MIN_AGE_MS,
    )
    .sort(
      (left, right) =>
        left.updatedAt - right.updatedAt ||
        String(left.roomCode).localeCompare(String(right.roomCode)),
    )
    .slice(0, ADMIN_PRO_ROOM_ACTIVATION_RECONCILE_BATCH_SIZE);
  if (candidates.length === 0) return false;
  const results = await Promise.allSettled(
    candidates.map((room) => reconcileAdminProRoomStatus(env, db, room)),
  );
  return results.some(
    (result) =>
      result.status === 'fulfilled' && (result.value === 'active' || result.value === 'suspended'),
  );
}

export async function reconcileStaleAdminProRoomActivationsForTests(
  env: unknown,
  db: unknown,
  rooms: unknown,
  nowMs: number = Date.now(),
) {
  if (!isAppEnv(env) || !isAppD1Database(db) || !Array.isArray(rooms)) {
    throw new TypeError('PRO room activation reconciliation input unavailable');
  }
  const candidates = rooms.filter(
    (
      room,
    ): room is {
      roomCode: string;
      roomGeneration: number;
      status: string;
      activationState: string;
      updatedAt: number;
    } =>
      isJsonObject(room) &&
      typeof room.roomCode === 'string' &&
      typeof room.roomGeneration === 'number' &&
      typeof room.status === 'string' &&
      typeof room.activationState === 'string' &&
      typeof room.updatedAt === 'number',
  );
  return reconcileStaleAdminProRoomActivations(env, db, candidates, nowMs);
}

async function adminProRoomAuditActor(request: Request, env: AppEnv) {
  const sessionToken = readCookies(request).get(ADMIN_SESSION_COOKIE) || '';
  const accessIdentity =
    request.headers.get('cf-access-authenticated-user-email') ||
    request.headers.get('cf-access-jwt-assertion') ||
    '';
  return `admin_${(
    await hmacSha256(
      getAdminSessionSecret(env),
      `pro-room-audit\u0000${sessionToken}\u0000${accessIdentity}`,
    )
  ).slice(0, 32)}`;
}

async function appendAdminProRoomAudit(
  db: D1Database,
  request: Request,
  env: AppEnv,
  action: unknown,
  result: unknown,
  roomCode: string,
  roomGeneration: number,
) {
  if (!isProRoomGeneration(roomGeneration)) {
    throw new Error('Invalid PRO room generation for admin audit');
  }
  await ensureAdminProRoomRegistry(db);
  const actorId = await adminProRoomAuditActor(request, env);
  await db
    .prepare(
      `INSERT INTO ${ADMIN_PRO_ROOM_AUDIT_TABLE}
        (actor_id, action, result, room_code, room_generation, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(actorId, action, result, roomCode, roomGeneration, Date.now())
    .run();
}

async function writeAdminProRoomAuditOrFail(
  db: D1Database,
  request: Request,
  env: AppEnv,
  action: string,
  result: string,
  roomCode: string,
  roomGeneration: number,
) {
  try {
    await appendAdminProRoomAudit(db, request, env, action, result, roomCode, roomGeneration);
    return null;
  } catch {
    return json({ error: 'PRO_ROOM_AUDIT_UNAVAILABLE' }, 503);
  }
}

function legacyOwnerDetachIntentResult(
  retainedRoomCode: string,
  retainedRoomGeneration: number,
  expectedOwnerAuthorityEpoch: number,
) {
  if (
    !ADMIN_PRO_ROOM_CODE_RE.test(retainedRoomCode || '') ||
    !isProRoomGeneration(retainedRoomGeneration) ||
    !Number.isSafeInteger(expectedOwnerAuthorityEpoch) ||
    expectedOwnerAuthorityEpoch < 0
  ) {
    throw new Error('Invalid legacy-owner detach intent');
  }
  return `authority:${expectedOwnerAuthorityEpoch}:retained:${retainedRoomCode}:${retainedRoomGeneration}`;
}

function parseLegacyOwnerDetachIntentResult(value: unknown) {
  const match = String(value || '').match(/^authority:(\d+):retained:(0\d{5}):(\d+)$/);
  if (!match) return null;
  const expectedOwnerAuthorityEpoch = Number(match[1]);
  const retainedRoomGeneration = Number(match[3]);
  const retainedRoomCode = match[2];
  if (
    !retainedRoomCode ||
    !Number.isSafeInteger(expectedOwnerAuthorityEpoch) ||
    expectedOwnerAuthorityEpoch < 0 ||
    !isProRoomGeneration(retainedRoomGeneration)
  ) {
    return null;
  }
  return {
    retainedRoomCode,
    retainedRoomGeneration,
    expectedOwnerAuthorityEpoch,
  };
}

function legacyOwnerDetachIntentBootstrapResult(
  retainedRoomCode: string,
  retainedRoomGeneration: number,
  expectedOwnerAuthorityEpoch: number,
) {
  if (
    !ADMIN_PRO_ROOM_CODE_RE.test(retainedRoomCode || '') ||
    !isProRoomGeneration(retainedRoomGeneration) ||
    !Number.isSafeInteger(expectedOwnerAuthorityEpoch) ||
    expectedOwnerAuthorityEpoch < 0
  ) {
    throw new Error('Invalid legacy-owner detach upgrade bootstrap intent');
  }
  return `authority:${expectedOwnerAuthorityEpoch}:upgrade-bootstrap:retained:${retainedRoomCode}:${retainedRoomGeneration}`;
}

function parseLegacyOwnerDetachIntentBootstrapResult(value: unknown) {
  const match = String(value || '').match(
    /^authority:(\d+):upgrade-bootstrap:retained:(0\d{5}):(\d+)$/,
  );
  if (!match) return null;
  const expectedOwnerAuthorityEpoch = Number(match[1]);
  const retainedRoomGeneration = Number(match[3]);
  const retainedRoomCode = match[2];
  if (
    !retainedRoomCode ||
    !Number.isSafeInteger(expectedOwnerAuthorityEpoch) ||
    expectedOwnerAuthorityEpoch < 0 ||
    !isProRoomGeneration(retainedRoomGeneration)
  ) {
    return null;
  }
  return {
    retainedRoomCode,
    retainedRoomGeneration,
    expectedOwnerAuthorityEpoch,
  };
}

interface LegacyOwnerDetachIntent {
  retainedRoomCode: string;
  retainedRoomGeneration: number;
  expectedOwnerAuthorityEpoch: number;
  auditId: number;
  auditAction: string;
  auditResult: string;
}

function legacyOwnerDetachIntentSupersedeResult(
  previousIntent: LegacyOwnerDetachIntent,
  retainedRoomCode: string,
  roomGeneration: number,
) {
  if (
    !Number.isSafeInteger(previousIntent?.auditId) ||
    previousIntent.auditId < 1 ||
    !ADMIN_PRO_ROOM_CODE_RE.test(previousIntent?.retainedRoomCode || '') ||
    !isProRoomGeneration(previousIntent?.retainedRoomGeneration) ||
    !Number.isSafeInteger(previousIntent?.expectedOwnerAuthorityEpoch) ||
    previousIntent.expectedOwnerAuthorityEpoch < 0 ||
    !ADMIN_PRO_ROOM_CODE_RE.test(retainedRoomCode || '') ||
    !isProRoomGeneration(roomGeneration)
  ) {
    throw new Error('Invalid legacy-owner detach intent supersede transition');
  }
  return `authority:${previousIntent.expectedOwnerAuthorityEpoch}:supersede:${previousIntent.auditId}:from:${previousIntent.retainedRoomCode}:${previousIntent.retainedRoomGeneration}:to:${retainedRoomCode}:${roomGeneration}`;
}

function parseLegacyOwnerDetachIntentSupersedeResult(value: unknown) {
  const match = String(value || '').match(
    /^authority:(\d+):supersede:(\d+):from:(0\d{5}):(\d+):to:(0\d{5}):(\d+)$/,
  );
  if (!match) return null;
  const expectedOwnerAuthorityEpoch = Number(match[1]);
  const previousIntentAuditId = Number(match[2]);
  const previousRetainedRoomGeneration = Number(match[4]);
  const retainedRoomGeneration = Number(match[6]);
  const previousRetainedRoomCode = match[3];
  const retainedRoomCode = match[5];
  if (
    !previousRetainedRoomCode ||
    !retainedRoomCode ||
    !Number.isSafeInteger(expectedOwnerAuthorityEpoch) ||
    expectedOwnerAuthorityEpoch < 0 ||
    !Number.isSafeInteger(previousIntentAuditId) ||
    previousIntentAuditId < 1 ||
    !isProRoomGeneration(previousRetainedRoomGeneration) ||
    !isProRoomGeneration(retainedRoomGeneration)
  ) {
    return null;
  }
  return {
    expectedOwnerAuthorityEpoch,
    previousIntentAuditId,
    previousRetainedRoomCode,
    previousRetainedRoomGeneration,
    retainedRoomCode,
    retainedRoomGeneration,
  };
}

async function readLegacyOwnerDetachIntent(
  db: D1Database,
  roomCode: string,
  roomGeneration: number,
  expectedOwnerAuthorityEpoch: number,
) {
  await ensureAdminProRoomRegistry(db);
  if (!Number.isSafeInteger(expectedOwnerAuthorityEpoch) || expectedOwnerAuthorityEpoch < 0) {
    throw new Error('Invalid legacy-owner detach authority epoch');
  }
  const statement = db
    .prepare(
      `SELECT id, action, result FROM ${ADMIN_PRO_ROOM_AUDIT_TABLE}
        WHERE room_code = ?1 AND room_generation = ?2
          AND ((action = ?3 AND result LIKE ?6)
            OR (action = ?4 AND result LIKE ?7)
            OR (action = ?5 AND result LIKE ?8))
        ORDER BY id ASC`,
    )
    .bind(
      roomCode,
      roomGeneration,
      ADMIN_LEGACY_OWNER_DETACH_INTENT_ACTION,
      ADMIN_LEGACY_OWNER_DETACH_INTENT_BOOTSTRAP_ACTION,
      ADMIN_LEGACY_OWNER_DETACH_INTENT_SUPERSEDE_ACTION,
      `authority:${expectedOwnerAuthorityEpoch}:retained:%`,
      `authority:${expectedOwnerAuthorityEpoch}:upgrade-bootstrap:retained:%`,
      `authority:${expectedOwnerAuthorityEpoch}:supersede:%`,
    );
  let rows: { id: unknown; action: unknown; result: unknown }[];
  if (typeof statement.all === 'function') {
    rows = (await statement.all<{ id: unknown; action: unknown; result: unknown }>()).results || [];
  } else {
    const row = await statement.first<{ id: unknown; action: unknown; result: unknown }>();
    rows = row ? [row] : [];
  }
  let effectiveIntent: LegacyOwnerDetachIntent | null = null;
  for (const row of rows) {
    const auditId = Number(row?.id);
    if (
      !Number.isSafeInteger(auditId) ||
      auditId < 1 ||
      typeof row.action !== 'string' ||
      typeof row.result !== 'string'
    ) {
      throw new Error('Malformed legacy-owner detach intent audit id');
    }
    if (
      row.action === ADMIN_LEGACY_OWNER_DETACH_INTENT_ACTION ||
      row.action === ADMIN_LEGACY_OWNER_DETACH_INTENT_BOOTSTRAP_ACTION
    ) {
      const intent =
        row.action === ADMIN_LEGACY_OWNER_DETACH_INTENT_ACTION
          ? parseLegacyOwnerDetachIntentResult(row.result)
          : parseLegacyOwnerDetachIntentBootstrapResult(row.result);
      if (
        !intent ||
        intent.expectedOwnerAuthorityEpoch !== expectedOwnerAuthorityEpoch ||
        effectiveIntent
      ) {
        throw new Error('Malformed legacy-owner detach intent chain');
      }
      effectiveIntent = {
        ...intent,
        auditId,
        auditAction: row.action,
        auditResult: row.result,
      };
      continue;
    }
    const transition = parseLegacyOwnerDetachIntentSupersedeResult(row.result);
    if (
      !transition ||
      transition.expectedOwnerAuthorityEpoch !== expectedOwnerAuthorityEpoch ||
      !effectiveIntent ||
      transition.previousIntentAuditId !== effectiveIntent.auditId ||
      transition.previousRetainedRoomCode !== effectiveIntent.retainedRoomCode ||
      transition.previousRetainedRoomGeneration !== effectiveIntent.retainedRoomGeneration
    ) {
      throw new Error('Malformed legacy-owner detach intent supersede chain');
    }
    effectiveIntent = {
      retainedRoomCode: transition.retainedRoomCode,
      retainedRoomGeneration: transition.retainedRoomGeneration,
      expectedOwnerAuthorityEpoch,
      auditId,
      auditAction: row.action,
      auditResult: row.result,
    };
  }
  return effectiveIntent;
}

async function ensureLegacyOwnerDetachIntent(
  db: D1Database,
  request: Request,
  env: AppEnv,
  roomCode: string,
  roomGeneration: number,
  retainedRoomCode: string,
  retainedRoomGeneration: number,
  expectedOwnerAuthorityEpoch: number,
) {
  await ensureAdminProRoomRegistry(db);
  const actorId = await adminProRoomAuditActor(request, env);
  const result = legacyOwnerDetachIntentResult(
    retainedRoomCode,
    retainedRoomGeneration,
    expectedOwnerAuthorityEpoch,
  );
  const operationPattern = `authority:${expectedOwnerAuthorityEpoch}:%`;
  await db
    .prepare(
      `INSERT INTO ${ADMIN_PRO_ROOM_AUDIT_TABLE}
        (actor_id, action, result, room_code, room_generation, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE NOT EXISTS (
          SELECT 1 FROM ${ADMIN_PRO_ROOM_AUDIT_TABLE}
           WHERE action IN (?2, ?8, ?9) AND room_code = ?4 AND room_generation = ?5
             AND result LIKE ?7
        )`,
    )
    .bind(
      actorId,
      ADMIN_LEGACY_OWNER_DETACH_INTENT_ACTION,
      result,
      roomCode,
      roomGeneration,
      Date.now(),
      operationPattern,
      ADMIN_LEGACY_OWNER_DETACH_INTENT_SUPERSEDE_ACTION,
      ADMIN_LEGACY_OWNER_DETACH_INTENT_BOOTSTRAP_ACTION,
    )
    .run();
  return readLegacyOwnerDetachIntent(db, roomCode, roomGeneration, expectedOwnerAuthorityEpoch);
}

async function bootstrapLegacyOwnerDetachIntent(
  db: D1Database,
  request: Request,
  env: AppEnv,
  roomCode: string,
  roomGeneration: number,
  retainedRoomCode: string,
  retainedRoomGeneration: number,
  expectedOwnerAuthorityEpoch: number,
) {
  await ensureAdminProRoomRegistry(db);
  const actorId = await adminProRoomAuditActor(request, env);
  const result = legacyOwnerDetachIntentBootstrapResult(
    retainedRoomCode,
    retainedRoomGeneration,
    expectedOwnerAuthorityEpoch,
  );
  const operationPattern = `authority:${expectedOwnerAuthorityEpoch}:%`;
  await db
    .prepare(
      `INSERT INTO ${ADMIN_PRO_ROOM_AUDIT_TABLE}
        (actor_id, action, result, room_code, room_generation, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE NOT EXISTS (
          SELECT 1 FROM ${ADMIN_PRO_ROOM_AUDIT_TABLE}
           WHERE action IN (?7, ?2, ?8) AND room_code = ?4 AND room_generation = ?5
             AND result LIKE ?9
        )`,
    )
    .bind(
      actorId,
      ADMIN_LEGACY_OWNER_DETACH_INTENT_BOOTSTRAP_ACTION,
      result,
      roomCode,
      roomGeneration,
      Date.now(),
      ADMIN_LEGACY_OWNER_DETACH_INTENT_ACTION,
      ADMIN_LEGACY_OWNER_DETACH_INTENT_SUPERSEDE_ACTION,
      operationPattern,
    )
    .run();
  return readLegacyOwnerDetachIntent(db, roomCode, roomGeneration, expectedOwnerAuthorityEpoch);
}

async function supersedeLegacyOwnerDetachIntent(
  db: D1Database,
  request: Request,
  env: AppEnv,
  roomCode: string,
  roomGeneration: number,
  previousIntent: LegacyOwnerDetachIntent,
  retainedRoomCode: string,
  retainedRoomGeneration: number,
) {
  await ensureAdminProRoomRegistry(db);
  const actorId = await adminProRoomAuditActor(request, env);
  const result = legacyOwnerDetachIntentSupersedeResult(
    previousIntent,
    retainedRoomCode,
    retainedRoomGeneration,
  );
  const operationPattern = `authority:${previousIntent.expectedOwnerAuthorityEpoch}:%`;
  await db
    .prepare(
      `INSERT INTO ${ADMIN_PRO_ROOM_AUDIT_TABLE}
        (actor_id, action, result, room_code, room_generation, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE ?7 = (
          SELECT id FROM ${ADMIN_PRO_ROOM_AUDIT_TABLE}
           WHERE room_code = ?4 AND room_generation = ?5
             AND action IN (?8, ?2, ?10) AND result LIKE ?9
           ORDER BY id DESC
           LIMIT 1
        )`,
    )
    .bind(
      actorId,
      ADMIN_LEGACY_OWNER_DETACH_INTENT_SUPERSEDE_ACTION,
      result,
      roomCode,
      roomGeneration,
      Date.now(),
      previousIntent.auditId,
      ADMIN_LEGACY_OWNER_DETACH_INTENT_ACTION,
      operationPattern,
      ADMIN_LEGACY_OWNER_DETACH_INTENT_BOOTSTRAP_ACTION,
    )
    .run();
  return readLegacyOwnerDetachIntent(
    db,
    roomCode,
    roomGeneration,
    previousIntent.expectedOwnerAuthorityEpoch,
  );
}

async function completeLegacyOwnerDetachAudit(
  db: D1Database,
  request: Request,
  env: AppEnv,
  roomCode: string,
  roomGeneration: number,
  intent: LegacyOwnerDetachIntent,
  result: string,
) {
  await ensureAdminProRoomRegistry(db);
  const actorId = await adminProRoomAuditActor(request, env);
  const intentResult = intent?.auditResult;
  if (
    !Number.isSafeInteger(intent?.auditId) ||
    intent.auditId < 1 ||
    ![
      ADMIN_LEGACY_OWNER_DETACH_INTENT_ACTION,
      ADMIN_LEGACY_OWNER_DETACH_INTENT_BOOTSTRAP_ACTION,
      ADMIN_LEGACY_OWNER_DETACH_INTENT_SUPERSEDE_ACTION,
    ].includes(intent?.auditAction) ||
    typeof intentResult !== 'string'
  ) {
    throw new Error('Invalid legacy-owner detach completion intent');
  }
  const completionResult = `${intentResult}:${result}`;
  const completionPattern = `${intentResult}:%`;
  await db
    .prepare(
      `INSERT INTO ${ADMIN_PRO_ROOM_AUDIT_TABLE}
        (actor_id, action, result, room_code, room_generation, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE EXISTS (
          SELECT 1 FROM ${ADMIN_PRO_ROOM_AUDIT_TABLE}
           WHERE action = ?7 AND result = ?8 AND id = ?10
             AND room_code = ?4 AND room_generation = ?5
        )
          AND ?10 = (
            SELECT id FROM ${ADMIN_PRO_ROOM_AUDIT_TABLE}
             WHERE room_code = ?4 AND room_generation = ?5
               AND action IN (?11, ?12, ?13) AND result LIKE ?14
             ORDER BY id DESC
             LIMIT 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${ADMIN_PRO_ROOM_AUDIT_TABLE}
             WHERE action = ?2 AND room_code = ?4 AND room_generation = ?5
               AND result LIKE ?9
          )`,
    )
    .bind(
      actorId,
      ADMIN_LEGACY_OWNER_DETACH_COMPLETE_ACTION,
      completionResult,
      roomCode,
      roomGeneration,
      Date.now(),
      intent.auditAction,
      intentResult,
      completionPattern,
      intent.auditId,
      ADMIN_LEGACY_OWNER_DETACH_INTENT_ACTION,
      ADMIN_LEGACY_OWNER_DETACH_INTENT_BOOTSTRAP_ACTION,
      ADMIN_LEGACY_OWNER_DETACH_INTENT_SUPERSEDE_ACTION,
      `authority:${intent.expectedOwnerAuthorityEpoch}:%`,
    )
    .run();
  const statement = db
    .prepare(
      `SELECT 1 AS completed FROM ${ADMIN_PRO_ROOM_AUDIT_TABLE}
        WHERE action = ?1 AND room_code = ?2 AND room_generation = ?3
          AND result LIKE ?4
        LIMIT 1`,
    )
    .bind(ADMIN_LEGACY_OWNER_DETACH_COMPLETE_ACTION, roomCode, roomGeneration, completionPattern);
  const row =
    typeof statement.first === 'function'
      ? await statement.first()
      : (await statement.all())?.results?.[0] || null;
  if (Number(row?.completed) !== 1) {
    throw new Error('Legacy-owner detach completion audit unavailable');
  }
}

async function appendSystemAdminProRoomAudit(
  db: D1Database,
  actorId: string,
  action: unknown,
  result: unknown,
  roomCode: string,
  roomGeneration: number,
  { once = false } = {},
) {
  if (!/^system:[a-z0-9-]{1,64}$/.test(actorId || '') || !isProRoomGeneration(roomGeneration)) {
    throw new Error('Invalid system PRO room audit identity');
  }
  await ensureAdminProRoomRegistry(db);
  const createdAt = Date.now();
  const statement = once
    ? db.prepare(
        `INSERT INTO ${ADMIN_PRO_ROOM_AUDIT_TABLE}
          (actor_id, action, result, room_code, room_generation, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
          WHERE NOT EXISTS (
            SELECT 1 FROM ${ADMIN_PRO_ROOM_AUDIT_TABLE}
             WHERE actor_id = ?1 AND action = ?2 AND result = ?3
               AND room_code = ?4 AND room_generation = ?5
          )`,
      )
    : db.prepare(
        `INSERT INTO ${ADMIN_PRO_ROOM_AUDIT_TABLE}
          (actor_id, action, result, room_code, room_generation, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      );
  await statement.bind(actorId, action, result, roomCode, roomGeneration, createdAt).run();
}

async function callProRoomAdminObject(
  env: AppEnv,
  roomCode: string,
  roomGeneration: number,
  pathname: string,
  method: string = 'POST',
  body: JsonObject | undefined = undefined,
): Promise<{ response: Response | null; payload: unknown }> {
  const namespace = getProRoomAdminNamespace(env);
  if (!namespace || !isProRoomGeneration(roomGeneration)) {
    return { response: null, payload: null };
  }
  const stub = namespace.get(namespace.idFromName(proRoomObjectName(roomCode, roomGeneration)));
  const wireBody = body ? { ...body, roomGeneration } : body;
  let result: Awaited<ReturnType<typeof fetchServiceBindingResponse>> | null;
  try {
    result = await fetchServiceBindingResponse(
      (boundedRequest) => stub.fetch(boundedRequest),
      new Request(`https://pro-room.internal${pathname}`, {
        method,
        headers: {
          'x-mxqr-pro-room-code': roomCode,
          'x-mxqr-pro-room-generation': proRoomGenerationHeaderValue(roomGeneration),
          ...(wireBody === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(wireBody === undefined ? {} : { body: JSON.stringify(wireBody) }),
      }),
      PRO_ROOM_SERVICE_CONTROL_RESPONSE_MAX_BYTES,
    );
  } catch {
    return { response: null, payload: null };
  }
  if (!result) return { response: null, payload: null };
  return { response: result.response, payload: parseServiceJsonBytes(result.bytes) };
}

async function inspectProGrantRoom(env: AppEnv, roomCode: string, roomGeneration: number) {
  if (!ADMIN_PRO_ROOM_CODE_RE.test(roomCode || '') || !isProRoomGeneration(roomGeneration)) {
    return null;
  }
  const room = await readAdminProRoom(getAdminDb(env), roomCode).catch(() => null);
  if (
    !room ||
    room.roomGeneration !== roomGeneration ||
    ['decommissioning', 'decommissioned'].includes(room.status)
  ) {
    return null;
  }
  const canonical = await callProRoomAdminObject(
    env,
    roomCode,
    roomGeneration,
    '/internal/admin/status',
    'GET',
  );
  return canonical.response?.ok &&
    proRoomAdminResponseIdentityMatches(canonical.payload, roomCode, roomGeneration)
    ? canonical.payload
    : null;
}

async function preflightProGrantVoucherRoom(env: AppEnv, roomCode: string) {
  const room = await readAdminProRoom(getAdminDb(env), roomCode).catch(() => null);
  if (
    !room ||
    room.status !== 'registered' ||
    room.activationState !== 'unactivated' ||
    !isProRoomGeneration(room.roomGeneration)
  ) {
    return null;
  }
  const canonical = await inspectProGrantRoom(env, roomCode, room.roomGeneration);
  return canonical?.status === 'unactivated'
    ? {
        roomCode,
        roomGeneration: room.roomGeneration,
        status: room.status,
        activationState: room.activationState,
      }
    : null;
}

async function issueProGrantActivationHandoff(env: AppEnv, input: unknown) {
  if (
    !isJsonObject(input) ||
    typeof input.roomCode !== 'string' ||
    typeof input.roomGeneration !== 'number' ||
    typeof input.accountId !== 'string'
  ) {
    return null;
  }
  const room = await readAdminProRoom(getAdminDb(env), input.roomCode).catch(() => null);
  if (
    !room ||
    room.status !== 'registered' ||
    room.activationState !== 'unactivated' ||
    room.roomGeneration !== input.roomGeneration ||
    !ACCOUNT_ID_RE.test(input.accountId)
  ) {
    return null;
  }
  const issued = await callProRoomAdminObject(
    env,
    input.roomCode,
    input.roomGeneration,
    '/internal/admin/activation-claim',
    'POST',
    { targetAccountId: input.accountId },
  );
  return issued.response?.ok &&
    isValidAdminActivationLink(issued.payload, input.roomCode, input.roomGeneration)
    ? issued.payload
    : null;
}

async function isActiveProGrantAccount(env: AppEnv, accountId: string) {
  if (!ACCOUNT_ID_RE.test(accountId || '') || !env.MUSIXQUARE_AUTH_DB?.prepare) {
    throw new Error('ACCOUNT_STORE_UNAVAILABLE');
  }
  const statement = env.MUSIXQUARE_AUTH_DB.prepare(
    `SELECT 1 AS active FROM mxqr_accounts account
      WHERE account.account_id = ?1 AND account.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM mxqr_account_deletions deletion
           WHERE deletion.account_id = account.account_id
        )
      LIMIT 1`,
  ).bind(accountId);
  const row =
    typeof statement.first === 'function'
      ? await statement.first()
      : (await statement.all())?.results?.[0] || null;
  return Number(row?.active) === 1;
}

function proGrantDependencies(env: AppEnv) {
  return {
    resolveAccountSession,
    inspectRoom: (roomCode: string, roomGeneration: number) =>
      inspectProGrantRoom(env, roomCode, roomGeneration),
    preflightVoucherRoom: (roomCode: string) => preflightProGrantVoucherRoom(env, roomCode),
    issueActivationHandoff: (input: unknown) => issueProGrantActivationHandoff(env, input),
    isAccountActive: (accountId: string) => isActiveProGrantAccount(env, accountId),
    verifyOwnerEntitlementBackfill: () =>
      verifyCanonicalOwnerEntitlementBackfill(env, getAdminDb(env)),
  };
}

function proRoomAdminResponseIdentityMatches(
  payload: unknown,
  roomCode: string,
  roomGeneration: number,
): payload is JsonObject & { roomCode: string; roomGeneration: number } {
  if (!isJsonObject(payload) || !isProRoomGeneration(roomGeneration)) {
    return false;
  }
  return payload.roomCode === roomCode && payload.roomGeneration === roomGeneration;
}

interface ProRoomAdminStatusPayload extends JsonObject {
  roomCode: string;
  roomGeneration: number;
  provisioned: boolean;
  status: string;
}

function isProRoomAdminStatusPayload(
  payload: unknown,
  roomCode: string,
  roomGeneration: number,
): payload is ProRoomAdminStatusPayload {
  return (
    proRoomAdminResponseIdentityMatches(payload, roomCode, roomGeneration) &&
    typeof payload.provisioned === 'boolean' &&
    typeof payload.status === 'string'
  );
}

interface OwnerAuthorityRemoval {
  accountId: string;
  removalId: string;
  ownerAuthorityEpoch: number;
  fencedCoordinatorEpoch: number;
  projectionAcked: boolean;
}

function normalizeOwnerAuthorityRemoval(value: unknown): OwnerAuthorityRemoval | null {
  if (
    !isJsonObject(value) ||
    typeof value.accountId !== 'string' ||
    !ACCOUNT_ID_RE.test(value.accountId) ||
    typeof value.removalId !== 'string' ||
    !OWNER_AUTHORITY_REMOVAL_ID_RE.test(value.removalId) ||
    typeof value.ownerAuthorityEpoch !== 'number' ||
    !Number.isSafeInteger(value.ownerAuthorityEpoch) ||
    value.ownerAuthorityEpoch < 1 ||
    typeof value.fencedCoordinatorEpoch !== 'number' ||
    !Number.isSafeInteger(value.fencedCoordinatorEpoch) ||
    value.fencedCoordinatorEpoch < 1 ||
    typeof value.projectionAcked !== 'boolean'
  ) {
    return null;
  }
  return {
    accountId: value.accountId,
    removalId: value.removalId,
    ownerAuthorityEpoch: value.ownerAuthorityEpoch,
    fencedCoordinatorEpoch: value.fencedCoordinatorEpoch,
    projectionAcked: value.projectionAcked,
  };
}

async function fenceProRoomSignalingForOwnerAccountDeletion(
  {
    roomCode,
    roomGeneration,
    removalId,
    removedOwnerAuthorityEpoch,
    fencedCoordinatorEpoch,
  }: {
    roomCode: string;
    roomGeneration: number;
    removalId: string;
    removedOwnerAuthorityEpoch: number;
    fencedCoordinatorEpoch: number;
  },
  env: AppEnv,
) {
  const namespace = env?.PRO_SIGNALING_ROOMS;
  if (
    !namespace ||
    typeof namespace.idFromName !== 'function' ||
    typeof namespace.get !== 'function' ||
    !isProRoomGeneration(roomGeneration) ||
    !OWNER_AUTHORITY_REMOVAL_ID_RE.test(removalId || '') ||
    !Number.isSafeInteger(removedOwnerAuthorityEpoch) ||
    removedOwnerAuthorityEpoch < 0 ||
    !Number.isSafeInteger(fencedCoordinatorEpoch) ||
    fencedCoordinatorEpoch < 1
  ) {
    return false;
  }
  let result;
  try {
    const stub = namespace.get(namespace.idFromName(proRoomObjectName(roomCode, roomGeneration)));
    result = await fetchServiceBindingResponse(
      (boundedRequest) => stub.fetch(boundedRequest),
      new Request('https://signaling.internal/internal/admin/v1/owner-account-deleted', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': roomCode,
          'x-mxqr-pro-room-generation': proRoomGenerationHeaderValue(roomGeneration),
        },
        body: JSON.stringify({
          roomCode,
          roomGeneration,
          removalId,
          removedOwnerAuthorityEpoch,
          fencedCoordinatorEpoch,
        }),
      }),
      PRO_ROOM_SERVICE_CONTROL_RESPONSE_MAX_BYTES,
    );
  } catch {
    return false;
  }
  if (!result) return false;
  const response = result.response;
  if (!response.ok) return false;
  const payload = parseServiceJsonBytes(result.bytes);
  if (
    !proRoomAdminResponseIdentityMatches(payload, roomCode, roomGeneration) ||
    payload.ok !== true ||
    payload.status !== 'suspended' ||
    payload.reason !== 'owner_account_deleted' ||
    typeof payload.changed !== 'boolean' ||
    payload.removalId !== removalId ||
    payload.removedOwnerAuthorityEpoch !== removedOwnerAuthorityEpoch ||
    payload.fencedCoordinatorEpoch !== fencedCoordinatorEpoch ||
    typeof payload.effectiveCoordinatorEpoch !== 'number' ||
    !Number.isSafeInteger(payload.effectiveCoordinatorEpoch)
  ) {
    return false;
  }
  const effectiveCoordinatorEpoch = payload.effectiveCoordinatorEpoch;
  if (payload.fenceStatus === 'installed') {
    return effectiveCoordinatorEpoch === fencedCoordinatorEpoch;
  }
  if (payload.fenceStatus === 'stale') {
    return payload.changed === false && effectiveCoordinatorEpoch > fencedCoordinatorEpoch;
  }
  return false;
}

interface ProRoomAuthorityPurgePayload extends JsonObject {
  roomCode: string;
  roomGeneration: number;
  ok: true;
  ownerAuthorityRemoved: boolean;
  removalId: string | null;
  removedOwnerAuthorityEpoch: number | null;
  fencedCoordinatorEpoch: number | null;
  projectionAcked: boolean;
  removedSessions: number;
  status: 'unactivated' | 'active' | 'suspended';
  suspensionReason?: string | null;
}

function isProRoomAuthorityPurgePayload(
  payload: unknown,
  roomCode: string,
  roomGeneration: number,
): payload is ProRoomAuthorityPurgePayload {
  if (
    !proRoomAdminResponseIdentityMatches(payload, roomCode, roomGeneration) ||
    payload.ok !== true ||
    typeof payload.ownerAuthorityRemoved !== 'boolean' ||
    (payload.removalId !== null &&
      (typeof payload.removalId !== 'string' ||
        !OWNER_AUTHORITY_REMOVAL_ID_RE.test(payload.removalId))) ||
    (payload.removedOwnerAuthorityEpoch !== null &&
      (typeof payload.removedOwnerAuthorityEpoch !== 'number' ||
        !Number.isSafeInteger(payload.removedOwnerAuthorityEpoch) ||
        payload.removedOwnerAuthorityEpoch < 0)) ||
    (payload.fencedCoordinatorEpoch !== null &&
      (typeof payload.fencedCoordinatorEpoch !== 'number' ||
        !Number.isSafeInteger(payload.fencedCoordinatorEpoch) ||
        payload.fencedCoordinatorEpoch < 1)) ||
    typeof payload.projectionAcked !== 'boolean' ||
    typeof payload.removedSessions !== 'number' ||
    !Number.isSafeInteger(payload.removedSessions) ||
    payload.removedSessions < 0 ||
    (payload.status !== 'unactivated' &&
      payload.status !== 'active' &&
      payload.status !== 'suspended') ||
    (payload.status === 'suspended'
      ? typeof payload.suspensionReason !== 'string' ||
        !['operator_suspended', 'owner_account_deleted', 'ownership_transfer_pending'].includes(
          payload.suspensionReason,
        )
      : payload.suspensionReason != null)
  ) {
    return false;
  }
  return true;
}

async function purgeProRoomAccountAuthority(
  {
    accountId,
    roomCode,
    roomGeneration,
  }: {
    accountId: string;
    roomCode: string;
    roomGeneration: number;
  },
  env: AppEnv,
) {
  if (!isProRoomGeneration(roomGeneration)) return false;
  // The PRO Durable Object is the only authority that may decide whether this
  // account is still the owner. Purge there first, in the same serialized
  // mutation that revokes owner authority and leaves projectionAcked=false.
  // This removes the classify -> transfer -> fence TOCTOU window: a transfer
  // cannot commit between the decision and the purge, and cannot reactivate
  // the room until the exact removal projection is acknowledged below.
  const result = await callProRoomAdminObject(
    env,
    roomCode,
    roomGeneration,
    '/internal/admin/account-authority/purge',
    'POST',
    { accountId },
  );
  const payload = result.payload;
  if (
    result.response?.ok !== true ||
    !isProRoomAuthorityPurgePayload(payload, roomCode, roomGeneration)
  ) {
    return false;
  }
  if (!payload.ownerAuthorityRemoved) {
    return (
      payload.removalId === null &&
      payload.removedOwnerAuthorityEpoch === null &&
      payload.fencedCoordinatorEpoch === null &&
      payload.projectionAcked === true
    );
  }
  if (
    payload.status !== 'suspended' ||
    payload.suspensionReason !== 'owner_account_deleted' ||
    typeof payload.removalId !== 'string' ||
    !OWNER_AUTHORITY_REMOVAL_ID_RE.test(payload.removalId) ||
    typeof payload.removedOwnerAuthorityEpoch !== 'number' ||
    !Number.isSafeInteger(payload.removedOwnerAuthorityEpoch) ||
    typeof payload.fencedCoordinatorEpoch !== 'number' ||
    !Number.isSafeInteger(payload.fencedCoordinatorEpoch) ||
    payload.fencedCoordinatorEpoch < 1
  ) {
    return false;
  }
  // Only an exact owner-removal result may fence signaling. Participant
  // deletion and a stale retry after a completed transfer remain no-ops. If
  // signaling is temporarily unavailable, the unacknowledged durable removal
  // keeps the room suspended and blocks transfer until the minute retry
  // installs this fence and completes the projection.
  const removalId = payload.removalId;
  const removedOwnerAuthorityEpoch = payload.removedOwnerAuthorityEpoch;
  const fencedCoordinatorEpoch = payload.fencedCoordinatorEpoch;
  if (
    !(await fenceProRoomSignalingForOwnerAccountDeletion(
      {
        roomCode,
        roomGeneration,
        removalId,
        removedOwnerAuthorityEpoch,
        fencedCoordinatorEpoch,
      },
      env,
    ))
  ) {
    return false;
  }

  const adminDb = getAdminDb(env);
  if (!adminDb?.prepare) return false;
  let room;
  try {
    room = await readAdminProRoom(adminDb, roomCode);
  } catch {
    return false;
  }
  if (
    !room ||
    room.roomGeneration !== roomGeneration ||
    ['decommissioning', 'decommissioned'].includes(room.status)
  ) {
    return false;
  }

  try {
    const fenceDigest = await developerApiAuthorityFenceDigest(
      env,
      'owner-account-deleted',
      `${roomCode}\u0000${roomGeneration}\u0000${accountId}\u0000${removalId}\u0000${removedOwnerAuthorityEpoch}\u0000${fencedCoordinatorEpoch}`,
    );
    await revokeDeveloperApiKeysForAuthorityChange(
      env,
      roomCode,
      roomGeneration,
      'system:account-delete',
      'owner_account_deleted',
      'owner_account_deleted',
      fenceDigest,
    );
    const projected = await markAdminProRoomOperationalState(
      adminDb,
      roomCode,
      roomGeneration,
      'suspended',
      'owner_account_deleted',
    );
    if (!projected) return false;
    await appendSystemAdminProRoomAudit(
      adminDb,
      'system:account-delete',
      'room.suspend',
      'owner_account_deleted',
      roomCode,
      roomGeneration,
    );
    const acknowledged = await callProRoomAdminObject(
      env,
      roomCode,
      roomGeneration,
      '/internal/admin/account-authority/purge/ack',
      'POST',
      { accountId, removalId, removedOwnerAuthorityEpoch, fencedCoordinatorEpoch },
    );
    const ackPayload = acknowledged.payload;
    return (
      acknowledged.response?.ok === true &&
      proRoomAdminResponseIdentityMatches(ackPayload, roomCode, roomGeneration) &&
      ackPayload.ok === true &&
      ackPayload.status === 'suspended' &&
      ackPayload.suspensionReason === 'owner_account_deleted' &&
      ackPayload.ownerAuthorityRemoved === true &&
      ackPayload.removalId === removalId &&
      ackPayload.removedOwnerAuthorityEpoch === removedOwnerAuthorityEpoch &&
      ackPayload.fencedCoordinatorEpoch === fencedCoordinatorEpoch &&
      ackPayload.projectionAcked === true &&
      typeof ackPayload.changed === 'boolean'
    );
  } catch {
    // Account deletion remains fenced and is retried by the minute cleanup
    // job. The DO is already suspended, so failure cannot restore authority.
    return false;
  }
}

export async function purgeProRoomAccountAuthorityForTests(
  input: { accountId: string; roomCode: string; roomGeneration: number },
  env: unknown,
) {
  if (!isAppEnv(env)) throw new TypeError('App Worker environment unavailable');
  return purgeProRoomAccountAuthority(input, env);
}

function proRoomObjectError(result: { response: Response | null; payload: unknown }) {
  if (!result.response) return json({ error: 'PRO_ROOM_ADMIN_UNAVAILABLE' }, 502);
  if (!result.payload || typeof result.payload !== 'object' || Array.isArray(result.payload)) {
    return json({ error: 'PRO_ROOM_ADMIN_INVALID_RESPONSE' }, 502);
  }
  return json(result.payload, result.response.status);
}

async function markAdminProRoomDecommissioning(
  db: D1Database,
  roomCode: string,
  roomGeneration: number,
  nowMs: number = Date.now(),
) {
  await ensureAdminProRoomRegistry(db);
  const result = await db
    .prepare(
      `UPDATE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
       SET status = 'decommissioning', suspension_reason = NULL,
           activation_state = 'unactivated', updated_at = ?3
       WHERE room_code = ?1
         AND room_generation = ?2
         AND status NOT IN ('decommissioning', 'decommissioned')`,
    )
    .bind(roomCode, roomGeneration, nowMs)
    .run();
  return Number(result?.meta?.changes || 0) === 1;
}

async function markAdminProRoomDecommissioned(
  db: D1Database,
  roomCode: string,
  roomGeneration: number,
  requestId: string,
  nowMs: number = Date.now(),
) {
  await ensureAdminProRoomRegistry(db);
  await db
    .prepare(
      `INSERT OR IGNORE INTO ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
        (room_code, room_generation, status, decommissioned_at, request_id)
       VALUES (?1, ?2, 'decommissioned', ?4, ?3)`,
    )
    .bind(roomCode, roomGeneration, requestId || null, nowMs)
    .run();
  const result = await db
    .prepare(
      `UPDATE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
       SET label = 'Decommissioned PRO room', status = 'decommissioned',
           suspension_reason = NULL, activation_state = 'unactivated', updated_at = ?3
       WHERE room_code = ?1 AND room_generation = ?2`,
    )
    .bind(roomCode, roomGeneration, nowMs)
    .run();
  return Number(result?.meta?.changes || 0) === 1;
}

async function retireDecommissionedAccountProRoomEdges(
  env: AppEnv,
  { sinceMs = null }: { sinceMs?: number | null } = {},
) {
  const adminDb = getAdminDb(env);
  if (!adminDb?.prepare || !env.MUSIXQUARE_AUTH_DB?.prepare) {
    return { configured: false, retired: false };
  }
  const normalizedSince =
    typeof sinceMs === 'number' && Number.isSafeInteger(sinceMs) && sinceMs > 0 ? sinceMs : null;
  const statement = adminDb.prepare(
    `SELECT room_code, room_generation
         FROM (
           SELECT room_code, room_generation, decommissioned_at AS completed_at
             FROM ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
            WHERE status = 'decommissioned'
           UNION
           SELECT room_code, room_generation, updated_at AS completed_at
             FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
            WHERE status = 'decommissioned'
         )
        ${normalizedSince !== null ? 'WHERE completed_at >= ?1' : ''}
        ORDER BY completed_at DESC, room_code ASC, room_generation ASC
        LIMIT 5000`,
  );
  const bound = normalizedSince === null ? statement : statement.bind(normalizedSince);
  const result = await bound.all();
  const incarnations = (result?.results || [])
    .map((row) => ({
      roomCode: typeof row?.room_code === 'string' ? row.room_code : '',
      roomGeneration: Number(row?.room_generation),
    }))
    .filter(
      ({ roomCode, roomGeneration }) =>
        /^0\d{5}$/.test(roomCode) && isProRoomGeneration(roomGeneration),
    );
  let entitlementsRevoked = true;
  for (let offset = 0; offset < incarnations.length; offset += 20) {
    const chunk = incarnations.slice(offset, offset + 20);
    const revoked = await Promise.all(
      chunk.map(({ roomCode, roomGeneration }) =>
        revokeProRoomEntitlement(env, { roomCode, roomGeneration }).catch(() => false),
      ),
    );
    if (revoked.some((value) => value !== true)) entitlementsRevoked = false;
  }
  if (!entitlementsRevoked) {
    console.warn('[PRO entitlement] decommission reconciliation remains pending');
  }
  const retired = await retireAccountProRoomLinkBatch(env, incarnations);
  return { ...retired, entitlementsRevoked };
}

export async function retireDecommissionedAccountProRoomEdgesForTests(
  env: unknown,
  options: { sinceMs?: number | null } = {},
) {
  if (!isAppEnv(env)) throw new TypeError('App Worker environment unavailable');
  return retireDecommissionedAccountProRoomEdges(env, options);
}

interface AdminActivationLink extends JsonObject {
  activationUrl: string;
  expiresAt: number;
}

function isValidAdminActivationLink(
  payload: unknown,
  roomCode: string,
  roomGeneration: number,
): payload is AdminActivationLink & { roomCode: string; roomGeneration: number } {
  const nowMs = Date.now();
  if (
    !proRoomAdminResponseIdentityMatches(payload, roomCode, roomGeneration) ||
    typeof payload.activationUrl !== 'string' ||
    typeof payload.expiresAt !== 'number' ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= nowMs ||
    payload.expiresAt > nowMs + ADMIN_PRO_ROOM_ACTIVATION_CLAIM_MAX_TTL_MS + 5_000
  ) {
    return false;
  }
  try {
    const url = new URL(payload.activationUrl);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'musixquare.com' &&
      url.port === '' &&
      url.pathname === `/${roomCode}` &&
      url.search === '' &&
      url.hash.startsWith('#pro-claim=') &&
      url.hash.length > '#pro-claim='.length
    );
  } catch {
    return false;
  }
}

interface AdminOwnerRecoveryLink extends JsonObject {
  recoveryUrl: string;
  ownerAccountLinked: true;
  expiresAt: number;
}

function isValidAdminOwnerRecoveryLink(
  payload: unknown,
  roomCode: string,
  roomGeneration: number,
): payload is AdminOwnerRecoveryLink & { roomCode: string; roomGeneration: number } {
  const nowMs = Date.now();
  if (
    !proRoomAdminResponseIdentityMatches(payload, roomCode, roomGeneration) ||
    typeof payload.recoveryUrl !== 'string' ||
    payload.ownerAccountLinked !== true ||
    typeof payload.expiresAt !== 'number' ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= nowMs ||
    payload.expiresAt > nowMs + ADMIN_PRO_ROOM_OWNER_RECOVERY_CLAIM_MAX_TTL_MS + 5_000
  ) {
    return false;
  }
  try {
    const url = new URL(payload.recoveryUrl);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hostname === 'musixquare.com' &&
      url.port === '' &&
      url.pathname === `/${roomCode}` &&
      url.search === '' &&
      /^#pro-recovery=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(url.hash)
    );
  } catch {
    return false;
  }
}

function isValidAdminOwnerTransferLink(
  payload: unknown,
  roomCode: string,
  roomGeneration: number,
  targetAccountId: string,
): payload is JsonObject & {
  roomCode: string;
  roomGeneration: number;
  targetAccountId: string;
  claimGeneration: number;
  transferUrl: string;
  expiresAt: number;
} {
  const nowMs = Date.now();
  if (
    !proRoomAdminResponseIdentityMatches(payload, roomCode, roomGeneration) ||
    payload.targetAccountId !== targetAccountId ||
    typeof payload.claimGeneration !== 'number' ||
    !Number.isSafeInteger(payload.claimGeneration) ||
    payload.claimGeneration < 0 ||
    typeof payload.transferUrl !== 'string' ||
    typeof payload.expiresAt !== 'number' ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= nowMs ||
    payload.expiresAt > nowMs + ADMIN_PRO_ROOM_OWNER_TRANSFER_CLAIM_MAX_TTL_MS + 5_000
  ) {
    return false;
  }
  try {
    const url = new URL(payload.transferUrl);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hostname === 'musixquare.com' &&
      url.port === '' &&
      url.pathname === `/${roomCode}` &&
      url.search === '' &&
      /^#pro-transfer=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(url.hash)
    );
  } catch {
    return false;
  }
}

async function readActiveOwnerTransferTarget(env: AppEnv, targetAccountId: string) {
  if (!ACCOUNT_ID_RE.test(targetAccountId || '')) return null;
  const db = env.MUSIXQUARE_AUTH_DB;
  if (!db?.prepare) throw new Error('Account store unavailable');
  const statement = db
    .prepare(
      `SELECT account.account_id, account.nickname
         FROM mxqr_accounts AS account
        WHERE account.account_id = ?1
          AND account.status = 'active'
          AND account.profile_complete = 1
          AND account.nickname IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM mxqr_account_deletions AS deletion
             WHERE deletion.account_id = account.account_id
          )
        LIMIT 1`,
    )
    .bind(targetAccountId);
  const row =
    typeof statement.first === 'function'
      ? await statement.first()
      : (await statement.all())?.results?.[0] || null;
  if (
    row?.account_id !== targetAccountId ||
    typeof row.nickname !== 'string' ||
    !row.nickname.trim()
  ) {
    return null;
  }
  return { accountId: targetAccountId, nickname: row.nickname.trim() };
}

async function resolveActiveOwnerTransferTarget(env: AppEnv, targetReference: unknown) {
  if (typeof targetReference === 'string' && ACCOUNT_ID_RE.test(targetReference)) {
    return readActiveOwnerTransferTarget(env, targetReference);
  }
  if (typeof targetReference !== 'string' || targetReference !== targetReference.trim()) {
    return null;
  }
  const normalizedNickname = normalizeAccountNickname(targetReference);
  const nicknameKey = normalizedNickname ? accountNicknameKey(normalizedNickname) : null;
  if (!normalizedNickname || !nicknameKey) return null;
  const db = env.MUSIXQUARE_AUTH_DB;
  if (!db?.prepare) throw new Error('Account store unavailable');
  const statement = db
    .prepare(
      `SELECT account.account_id, account.nickname, account.nickname_key
         FROM mxqr_accounts AS account
        WHERE account.nickname_key = ?1
          AND account.status = 'active'
          AND account.profile_complete = 1
          AND account.nickname IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM mxqr_account_deletions AS deletion
             WHERE deletion.account_id = account.account_id
          )
        LIMIT 1`,
    )
    .bind(nicknameKey);
  const row =
    typeof statement.first === 'function'
      ? await statement.first<{
          account_id: unknown;
          nickname: unknown;
          nickname_key: unknown;
        }>()
      : (
          await statement.all<{
            account_id: unknown;
            nickname: unknown;
            nickname_key: unknown;
          }>()
        ).results[0] || null;
  const storedNickname = normalizeAccountNickname(row?.nickname);
  if (
    typeof row?.account_id !== 'string' ||
    !ACCOUNT_ID_RE.test(row.account_id) ||
    !storedNickname ||
    row?.nickname_key !== nicknameKey ||
    accountNicknameKey(storedNickname) !== nicknameKey
  ) {
    return null;
  }
  return { accountId: row.account_id, nickname: storedNickname };
}

function getDeveloperApiAdminDb(env: AppEnv): D1Database | undefined {
  return env.DEVELOPER_API_DB;
}

function developerApiAdminPepper(env: AppEnv) {
  const pepper = String(env.MXQR_DEVELOPER_API_KEY_PEPPER || '');
  return pepper.length >= 32 ? pepper : '';
}

function developerApiScopeNames(scopeMask: unknown) {
  if (
    typeof scopeMask !== 'number' ||
    !Number.isSafeInteger(scopeMask) ||
    scopeMask <= 0 ||
    scopeMask > ADMIN_DEVELOPER_API_KEY_ALL_SCOPE_BITS ||
    (scopeMask & ~ADMIN_DEVELOPER_API_KEY_ALL_SCOPE_BITS) !== 0
  ) {
    return null;
  }
  return Object.entries(ADMIN_DEVELOPER_API_KEY_SCOPES)
    .filter(([, bit]) => (scopeMask & bit) !== 0)
    .map(([scope]) => scope);
}

function developerApiKeyStatus(
  row: { status: 'active' | 'revoked'; expires_at: number; revoked_at: number | null },
  nowMs: number,
) {
  if (row.status === 'active') return row.expires_at <= nowMs ? 'expired' : 'active';
  return row.revoked_at === row.expires_at ? 'expired' : 'revoked';
}

interface AdminDeveloperApiKeyRecord {
  keyId: string;
  roomGeneration: number;
  label: string;
  scopes: string[];
  status: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

function normalizeAdminDeveloperApiKeyRow(
  row: Record<string, unknown>,
  nowMs: number = Date.now(),
  expectedRoomGeneration: number | null = null,
): AdminDeveloperApiKeyRecord | null {
  const scopes = developerApiScopeNames(row?.scope_mask);
  const label = typeof row?.label === 'string' ? row.label : '';
  const roomGeneration = Number(row?.room_generation);
  const authorityEpoch = Number(row?.authority_epoch);
  const keyId = typeof row.key_id === 'string' ? row.key_id : '';
  const roomCode = typeof row.room_code === 'string' ? row.room_code : '';
  const status = row.status;
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;
  const expiresAt = row.expires_at;
  const revokedAt = row.revoked_at;
  const lastUsedAt = row.last_used_hour;
  if (
    !ADMIN_DEVELOPER_API_KEY_ID_RE.test(keyId) ||
    !ADMIN_PRO_ROOM_CODE_RE.test(roomCode) ||
    !isProRoomGeneration(roomGeneration) ||
    !Number.isSafeInteger(authorityEpoch) ||
    authorityEpoch < 0 ||
    (expectedRoomGeneration !== null && roomGeneration !== expectedRoomGeneration) ||
    !label ||
    label.length > 64 ||
    !scopes ||
    (status !== 'active' && status !== 'revoked') ||
    typeof createdAt !== 'number' ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    typeof updatedAt !== 'number' ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < createdAt ||
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= createdAt ||
    (status === 'active' && revokedAt !== null) ||
    (status === 'revoked' &&
      (typeof revokedAt !== 'number' ||
        !Number.isSafeInteger(revokedAt) ||
        revokedAt < createdAt)) ||
    (lastUsedAt !== null &&
      (typeof lastUsedAt !== 'number' || !Number.isSafeInteger(lastUsedAt) || lastUsedAt < 0))
  ) {
    return null;
  }
  const normalizedRevokedAt = typeof revokedAt === 'number' ? revokedAt : null;
  const normalizedLastUsedAt = typeof lastUsedAt === 'number' ? lastUsedAt : null;
  return {
    keyId,
    roomGeneration,
    label,
    scopes,
    status: developerApiKeyStatus(
      { status, expires_at: expiresAt, revoked_at: normalizedRevokedAt },
      nowMs,
    ),
    createdAt,
    updatedAt,
    expiresAt,
    revokedAt: normalizedRevokedAt,
    lastUsedAt: normalizedLastUsedAt,
  };
}

async function cleanupExpiredAdminDeveloperApiKeys(
  db: D1Database,
  roomCode: string,
  roomGeneration: number,
  nowMs: number,
) {
  await db
    .prepare(
      `UPDATE mxqr_developer_api_keys
       SET status = 'revoked',
           revoked_at = expires_at,
           updated_at = CASE
             WHEN updated_at > expires_at THEN updated_at
             ELSE expires_at
           END
       WHERE room_code = ?1 AND room_generation = ?2
         AND status = 'active' AND expires_at <= ?3`,
    )
    .bind(roomCode, roomGeneration, nowMs)
    .run();
}

async function listAdminDeveloperApiKeys(
  db: D1Database,
  roomCode: string,
  roomGeneration: number,
  nowMs: number,
) {
  const result = await db
    .prepare(
      `SELECT key_id, room_code, room_generation, authority_epoch, label, scope_mask, status,
              created_at, updated_at,
              expires_at, revoked_at, last_used_hour
       FROM mxqr_developer_api_keys
       WHERE room_code = ?1 AND room_generation = ?2
       ORDER BY created_at DESC
       LIMIT ?3`,
    )
    .bind(roomCode, roomGeneration, ADMIN_DEVELOPER_API_KEY_LIST_LIMIT)
    .all<Record<string, unknown>>();
  return (result?.results || [])
    .map((row) => normalizeAdminDeveloperApiKeyRow(row, nowMs, roomGeneration))
    .filter((key): key is AdminDeveloperApiKeyRecord => key !== null);
}

function adminDeveloperApiKeyListPayload(
  roomCode: string,
  roomGeneration: number,
  keys: AdminDeveloperApiKeyRecord[],
) {
  return {
    roomCode,
    roomGeneration,
    maxActiveKeys: ADMIN_DEVELOPER_API_KEY_MAX_ACTIVE,
    keys,
  };
}

type AdminDeveloperApiScopeName = keyof typeof ADMIN_DEVELOPER_API_KEY_SCOPES;

interface AdminDeveloperApiKeyIssue {
  label: string;
  days: number;
  scopes: AdminDeveloperApiScopeName[];
  requestId: string;
  roomGeneration: number;
  scopeMask: number;
}

function isAdminDeveloperApiScopeName(value: unknown): value is AdminDeveloperApiScopeName {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(ADMIN_DEVELOPER_API_KEY_SCOPES, value)
  );
}

function parseAdminDeveloperApiKeyIssueBody(body: unknown): AdminDeveloperApiKeyIssue | null {
  if (!isJsonObject(body)) return null;
  const keys = Object.keys(body);
  if (
    !keys.includes('label') ||
    !keys.includes('scopes') ||
    !keys.includes('requestId') ||
    !keys.includes('roomGeneration') ||
    keys.some(
      (key: string) => !['label', 'days', 'scopes', 'requestId', 'roomGeneration'].includes(key),
    )
  ) {
    return null;
  }
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const days = body.days === undefined ? ADMIN_DEVELOPER_API_KEY_DEFAULT_DAYS : body.days;
  const rawScopes = body.scopes;
  const requestId = typeof body.requestId === 'string' ? body.requestId.toLowerCase() : '';
  if (
    !label ||
    label.length > 64 ||
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(label) ||
    typeof days !== 'number' ||
    !Number.isSafeInteger(days) ||
    days < 1 ||
    days > ADMIN_DEVELOPER_API_KEY_MAX_DAYS ||
    !Array.isArray(rawScopes) ||
    rawScopes.length < 1 ||
    rawScopes.length > Object.keys(ADMIN_DEVELOPER_API_KEY_SCOPES).length ||
    new Set(rawScopes).size !== rawScopes.length ||
    !rawScopes.every(isAdminDeveloperApiScopeName) ||
    !ADMIN_DEVELOPER_API_REQUEST_ID_RE.test(requestId) ||
    typeof body.roomGeneration !== 'number' ||
    !isProRoomGeneration(body.roomGeneration)
  ) {
    return null;
  }
  const scopes = rawScopes;
  return {
    label,
    days,
    scopes,
    requestId,
    roomGeneration: body.roomGeneration,
    scopeMask: scopes.reduce((mask, scope) => mask | ADMIN_DEVELOPER_API_KEY_SCOPES[scope], 0),
  };
}

async function deriveAdminDeveloperApiKeyMaterial(
  env: AppEnv,
  roomCode: string,
  roomGeneration: number,
  requestId: string,
) {
  const pepper = developerApiAdminPepper(env);
  const generationDomain = `${roomCode}\u0000${roomGeneration}`;
  const keyIdMaterial = await hmacSha256(
    pepper,
    `mxqr-developer-api-admin-issue-id:v2\u0000${generationDomain}\u0000${requestId}`,
  );
  const secret = await hmacSha256(
    pepper,
    `mxqr-developer-api-admin-issue-secret:v2\u0000${generationDomain}\u0000${requestId}`,
  );
  return { keyId: keyIdMaterial.slice(0, 16), secret };
}

async function readAdminDeveloperApiKey(
  db: D1Database,
  roomCode: string,
  roomGeneration: number,
  keyId: unknown,
) {
  const statement = db
    .prepare(
      `SELECT key_id, room_code, room_generation, authority_epoch, label, secret_digest,
              digest_version, scope_mask, status,
              created_at, updated_at, expires_at, revoked_at, last_used_hour
       FROM mxqr_developer_api_keys
       WHERE room_code = ?1 AND room_generation = ?2 AND key_id = ?3
       LIMIT 1`,
    )
    .bind(roomCode, roomGeneration, keyId);
  return typeof statement.first === 'function'
    ? await statement.first()
    : (await statement.all())?.results?.[0] || null;
}

function recoverAdminDeveloperApiKeyReplay(
  row: Record<string, unknown>,
  issue: AdminDeveloperApiKeyIssue,
  digest: string,
  nowMs: number,
  roomGeneration: number,
) {
  const key = normalizeAdminDeveloperApiKeyRow(row, nowMs, roomGeneration);
  const createdAt = typeof row.created_at === 'number' ? row.created_at : Number.NaN;
  const expiresAt = typeof row.expires_at === 'number' ? row.expires_at : Number.NaN;
  if (
    !key ||
    key.status !== 'active' ||
    !constantTimeEqual(String(row?.secret_digest || ''), digest) ||
    row?.digest_version !== 1 ||
    row?.label !== issue.label ||
    row?.scope_mask !== issue.scopeMask ||
    expiresAt - createdAt !== issue.days * ADMIN_DEVELOPER_API_DAY_MS
  ) {
    return null;
  }
  return key;
}

type ProRoomDeveloperAuthority =
  | { state: 'active' | 'inactive'; epoch: number }
  | { state: 'invalid' | 'unavailable'; epoch: null };

async function readActiveProRoomDeveloperAuthority(
  env: AppEnv,
  roomCode: string,
  roomGeneration: number,
): Promise<ProRoomDeveloperAuthority> {
  const status = await callProRoomAdminObject(
    env,
    roomCode,
    roomGeneration,
    '/internal/admin/status',
    'GET',
  );
  if (!status.response) return { state: 'unavailable', epoch: null };
  const payload = status.payload;
  if (
    !status.response.ok ||
    !isProRoomAdminStatusPayload(payload, roomCode, roomGeneration) ||
    payload.provisioned !== true ||
    (payload.status !== 'unactivated' &&
      payload.status !== 'active' &&
      payload.status !== 'suspended') ||
    typeof payload.developerAuthorityEpoch !== 'number' ||
    !Number.isSafeInteger(payload.developerAuthorityEpoch) ||
    payload.developerAuthorityEpoch < 0 ||
    (payload.status === 'suspended'
      ? typeof payload.suspensionReason !== 'string' ||
        !['operator_suspended', 'owner_account_deleted', 'ownership_transfer_pending'].includes(
          payload.suspensionReason,
        )
      : payload.suspensionReason !== null)
  ) {
    return { state: 'invalid', epoch: null };
  }
  return payload.status === 'active'
    ? { state: 'active', epoch: payload.developerAuthorityEpoch }
    : { state: 'inactive', epoch: payload.developerAuthorityEpoch };
}

async function developerApiAuthorityFenceIsActive(
  db: D1Database,
  roomCode: string,
  roomGeneration: number,
) {
  const statement = db
    .prepare(
      `SELECT status
         FROM mxqr_developer_api_room_authority_fences
        WHERE room_code = ?1 AND room_generation = ?2
        LIMIT 1`,
    )
    .bind(roomCode, roomGeneration);
  const row =
    typeof statement.first === 'function'
      ? await statement.first()
      : (await statement.all())?.results?.[0] || null;
  return row?.status === 'active';
}

async function removeDeveloperApiKeyAfterAuthorityChange(
  db: D1Database,
  {
    actorId,
    keyId,
    roomCode,
    roomGeneration,
    authorityEpoch,
    digest,
    result,
  }: {
    actorId: string;
    keyId: string;
    roomCode: string;
    roomGeneration: number;
    authorityEpoch: unknown;
    digest: string;
    result: string;
  },
) {
  const nowMs = Date.now();
  const removal = db
    .prepare(
      `DELETE FROM mxqr_developer_api_keys
        WHERE key_id = ?1 AND room_code = ?2 AND room_generation = ?3
          AND secret_digest = ?4 AND authority_epoch = ?5`,
    )
    .bind(keyId, roomCode, roomGeneration, digest, authorityEpoch);
  const audit = developerApiAdminAuditStatement(
    db,
    actorId,
    'key.issue',
    result,
    keyId,
    roomCode,
    roomGeneration,
    nowMs,
  );
  await runDeveloperApiAdminMutation(db, removal, audit, async () => {});
}

async function verifyAdminDeveloperApiKeyAuthority(
  env: AppEnv,
  db: D1Database,
  row: Record<string, unknown>,
  roomCode: string,
  roomGeneration: number,
) {
  const canonical = await readActiveProRoomDeveloperAuthority(env, roomCode, roomGeneration).catch(
    () => ({ state: 'unavailable', epoch: null }),
  );
  if (canonical.state === 'unavailable' || canonical.state === 'invalid') {
    return 'unavailable';
  }
  if (canonical.state !== 'active') return 'inactive';
  if (
    typeof row.authority_epoch !== 'number' ||
    !Number.isSafeInteger(row?.authority_epoch) ||
    row.authority_epoch < 0 ||
    row.authority_epoch !== canonical.epoch
  ) {
    return 'changed';
  }
  try {
    return (await developerApiAuthorityFenceIsActive(db, roomCode, roomGeneration))
      ? 'changed'
      : 'valid';
  } catch {
    return 'unavailable';
  }
}

async function adminDeveloperApiAuditActor(request: Request, env: AppEnv) {
  const sessionToken = readCookies(request).get(ADMIN_SESSION_COOKIE) || '';
  const accessIdentity =
    request.headers.get('cf-access-authenticated-user-email') ||
    request.headers.get('cf-access-jwt-assertion') ||
    '';
  return `admin_${(
    await hmacSha256(
      getAdminSessionSecret(env),
      `developer-api-admin-audit\u0000${sessionToken}\u0000${accessIdentity}`,
    )
  ).slice(0, 32)}`;
}

function developerApiAdminAuditStatement(
  db: D1Database,
  actorId: string,
  action: unknown,
  result: unknown,
  keyId: unknown,
  roomCode: string,
  roomGeneration: number,
  nowMs: number,
  { ignoreDuplicate = false } = {},
) {
  return db
    .prepare(
      `INSERT${ignoreDuplicate ? ' OR IGNORE' : ''} INTO mxqr_developer_api_admin_audit
        (actor_id, action, result, key_id, room_code, room_generation, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(actorId, action, result, keyId, roomCode, roomGeneration, nowMs);
}

function d1MutationChanged(result: D1Result<unknown> | undefined) {
  return Number(result?.meta?.changes || 0) === 1;
}

function developerApiAdminErrorChainIncludes(error: unknown, needle: string) {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const message =
      current instanceof Error
        ? current.message
        : isJsonObject(current) && typeof current.message === 'string'
          ? current.message
          : String(current);
    if (message.toLowerCase().includes(needle)) return true;
    current = current instanceof Error || isJsonObject(current) ? current.cause : undefined;
  }
  return false;
}

function isDeveloperApiActiveKeyLimitError(error: unknown) {
  return developerApiAdminErrorChainIncludes(error, 'developer_api_active_key_limit');
}

function isDeveloperApiAuditError(error: unknown) {
  return (
    (isJsonObject(error) && error.developerApiAuditFailure === true) ||
    developerApiAdminErrorChainIncludes(error, 'admin audit') ||
    developerApiAdminErrorChainIncludes(error, 'admin_audit') ||
    developerApiAdminErrorChainIncludes(error, 'audit unavailable')
  );
}

async function runDeveloperApiAdminMutation(
  db: D1Database,
  mutation: D1PreparedStatement,
  audit: D1PreparedStatement,
  cleanupOnAuditFailure: () => Promise<unknown>,
) {
  if (typeof db.batch === 'function') {
    const results = await db.batch([mutation, audit]);
    if (!Array.isArray(results) || results.length !== 2 || !d1MutationChanged(results[0])) {
      throw new Error('Developer API key mutation was not confirmed');
    }
    if (!d1MutationChanged(results[1])) {
      throw new Error('Developer API admin audit was not confirmed');
    }
    return;
  }

  const mutationResult = await mutation.run();
  if (!d1MutationChanged(mutationResult)) {
    throw new Error('Developer API key mutation was not confirmed');
  }
  try {
    const auditResult = await audit.run();
    if (!d1MutationChanged(auditResult)) {
      throw new Error('Developer API admin audit was not confirmed');
    }
  } catch (error) {
    await cleanupOnAuditFailure?.().catch(() => {});
    const wrapped = Object.assign(new Error('Developer API admin audit unavailable'), {
      cause: error,
      developerApiAuditFailure: true,
    });
    throw wrapped;
  }
}

async function revokeDeveloperApiKeysForAuthorityChange(
  env: AppEnv,
  roomCode: string,
  roomGeneration: number,
  actorId: string,
  result: string,
  suspensionReason: string,
  fenceDigest: string,
) {
  const db = getDeveloperApiAdminDb(env);
  if (!db?.prepare || typeof db.batch !== 'function') {
    throw new Error('Developer API admin database unavailable');
  }
  if (
    !['owner_account_deleted', 'ownership_transfer_pending'].includes(suspensionReason) ||
    !/^[A-Za-z0-9_-]{43}$/.test(fenceDigest)
  ) {
    throw new Error('Invalid Developer API authority fence');
  }
  const revokedAtMs = Date.now();
  const statements = [
    db
      .prepare(
        `INSERT INTO mxqr_developer_api_room_authority_fences
          (room_code, room_generation, status, reason, fence_digest, fenced_at, updated_at)
         VALUES (?1, ?2, 'active', ?3, ?4, ?5, ?5)
         ON CONFLICT(room_code, room_generation) DO UPDATE SET
           status = CASE
             WHEN mxqr_developer_api_room_authority_fences.fence_digest = excluded.fence_digest
              AND mxqr_developer_api_room_authority_fences.status = 'cleared'
             THEN 'cleared'
             ELSE 'active'
           END,
           reason = CASE
             WHEN mxqr_developer_api_room_authority_fences.fence_digest = excluded.fence_digest
              AND mxqr_developer_api_room_authority_fences.status = 'cleared'
             THEN mxqr_developer_api_room_authority_fences.reason
             ELSE excluded.reason
           END,
           fence_digest = excluded.fence_digest,
           fenced_at = CASE
             WHEN mxqr_developer_api_room_authority_fences.fence_digest = excluded.fence_digest
             THEN mxqr_developer_api_room_authority_fences.fenced_at
             ELSE excluded.fenced_at
           END,
           updated_at = excluded.updated_at`,
      )
      .bind(roomCode, roomGeneration, suspensionReason, fenceDigest, revokedAtMs),
    db
      .prepare(
        `UPDATE mxqr_developer_api_keys
            SET status = 'revoked', revoked_at = ?3, updated_at = ?3
          WHERE room_code = ?1 AND room_generation = ?2 AND status = 'active'
            AND EXISTS (
              SELECT 1 FROM mxqr_developer_api_room_authority_fences AS fence
               WHERE fence.room_code = ?1 AND fence.room_generation = ?2
                 AND fence.status = 'active' AND fence.fence_digest = ?4
            )`,
      )
      .bind(roomCode, roomGeneration, revokedAtMs, fenceDigest),
    db
      .prepare(
        `INSERT OR IGNORE INTO mxqr_developer_api_admin_audit
          (actor_id, action, result, key_id, room_code, room_generation, created_at)
         SELECT ?1, 'key.revoke', ?2, key.key_id, key.room_code,
                key.room_generation, ?5
           FROM mxqr_developer_api_keys AS key
          WHERE key.room_code = ?3 AND key.room_generation = ?4
            AND key.status = 'revoked' AND key.revoked_at = ?5`,
      )
      .bind(actorId, result, roomCode, roomGeneration, revokedAtMs),
  ];
  const results = await db.batch(statements);
  if (!Array.isArray(results) || results.length !== statements.length) {
    throw new Error('Developer API authority revocation was not confirmed');
  }

  const fenceStatement = db
    .prepare(
      `SELECT status, reason, fence_digest, fenced_at, updated_at
         FROM mxqr_developer_api_room_authority_fences
        WHERE room_code = ?1 AND room_generation = ?2
        LIMIT 1`,
    )
    .bind(roomCode, roomGeneration);
  const fence =
    typeof fenceStatement.first === 'function'
      ? await fenceStatement.first<{ fence_digest: unknown; status: unknown }>()
      : (await fenceStatement.all<{ fence_digest: unknown; status: unknown }>()).results[0] || null;
  if (
    !fence ||
    fence.fence_digest !== fenceDigest ||
    typeof fence.status !== 'string' ||
    !['active', 'cleared'].includes(fence.status)
  ) {
    throw new Error('Developer API authority fence was not confirmed');
  }
  const remaining = await db
    .prepare(
      `SELECT key_id FROM mxqr_developer_api_keys
        WHERE room_code = ?1 AND room_generation = ?2 AND status = 'active'
          AND EXISTS (
            SELECT 1 FROM mxqr_developer_api_room_authority_fences AS fence
             WHERE fence.room_code = ?1 AND fence.room_generation = ?2
               AND fence.status = 'active' AND fence.fence_digest = ?3
          )
        LIMIT 1`,
    )
    .bind(roomCode, roomGeneration, fenceDigest)
    .all();
  if ((remaining?.results || []).length > 0) {
    throw new Error('Developer API authority revocation is incomplete');
  }
  return {
    revokedAtMs,
    revokedKeyCount: Number(results[1]?.meta?.changes || 0),
    fenceDigest,
    fenceStatus: fence.status,
  };
}

async function developerApiAuthorityFenceDigest(env: AppEnv, purpose: string, material: string) {
  const secret = String(env.MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET || '');
  if (secret.length < 32) throw new Error('PRO account assertion secret unavailable');
  return hmacSha256(secret, `developer-api-authority-fence:v1\u0000${purpose}\u0000${material}`);
}

async function clearDeveloperApiAuthorityFence(
  env: AppEnv,
  roomCode: string,
  roomGeneration: number,
  fenceDigest: unknown,
) {
  const db = getDeveloperApiAdminDb(env);
  if (!db?.prepare || typeof fenceDigest !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(fenceDigest)) {
    return false;
  }
  await db
    .prepare(
      `UPDATE mxqr_developer_api_room_authority_fences
          SET status = 'cleared', updated_at = ?4
        WHERE room_code = ?1 AND room_generation = ?2
          AND fence_digest = ?3 AND status = 'active'`,
    )
    .bind(roomCode, roomGeneration, fenceDigest, Date.now())
    .run();
  const statement = db
    .prepare(
      `SELECT status, fence_digest
         FROM mxqr_developer_api_room_authority_fences
        WHERE room_code = ?1 AND room_generation = ?2
        LIMIT 1`,
    )
    .bind(roomCode, roomGeneration);
  const row =
    typeof statement.first === 'function'
      ? await statement.first()
      : (await statement.all())?.results?.[0] || null;
  return row?.status === 'cleared' && row?.fence_digest === fenceDigest;
}

function ownerTransferRequestIdFromBodyBytes(bytes: Uint8Array | null) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
  if (
    !isJsonObject(body) ||
    Object.keys(body).length !== 3 ||
    !Object.hasOwn(body, 'claimToken') ||
    !Object.hasOwn(body, 'newPin') ||
    !Object.hasOwn(body, 'requestId') ||
    typeof body.claimToken !== 'string' ||
    body.claimToken.length < 32 ||
    body.claimToken.length > 4096 ||
    typeof body.newPin !== 'string' ||
    !/^\d{8}$/.test(body.newPin) ||
    typeof body.requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(body.requestId)
  ) {
    return null;
  }
  return body.requestId;
}

interface OwnerTransferPreparePayload extends JsonObject {
  roomCode: string;
  roomGeneration: number;
  previousOwnerAccountId: string | null;
  status: 'active' | 'suspended';
  suspensionReason: string | null;
  replayed: boolean;
  preparedAtMs: number;
  expiresAtMs: number;
  claimGeneration: number | null;
  committedAtMs: number | null;
  replayUntilMs: number;
  ok: true;
  transferId: string;
  commitProof: string;
  targetAccountId: string;
}

function validOwnerTransferPreparePayload(
  payload: unknown,
  roomCode: string,
  roomGeneration: number,
  targetAccountId: string,
): payload is OwnerTransferPreparePayload {
  if (
    !proRoomAdminResponseIdentityMatches(payload, roomCode, roomGeneration) ||
    payload.ok !== true ||
    typeof payload.status !== 'string' ||
    (payload.suspensionReason !== null && typeof payload.suspensionReason !== 'string') ||
    typeof payload.replayed !== 'boolean' ||
    typeof payload.preparedAtMs !== 'number' ||
    typeof payload.expiresAtMs !== 'number' ||
    (payload.claimGeneration !== null && typeof payload.claimGeneration !== 'number') ||
    (payload.committedAtMs !== null && typeof payload.committedAtMs !== 'number') ||
    typeof payload.replayUntilMs !== 'number' ||
    typeof payload.transferId !== 'string' ||
    typeof payload.commitProof !== 'string' ||
    typeof payload.targetAccountId !== 'string' ||
    (payload.previousOwnerAccountId !== null && typeof payload.previousOwnerAccountId !== 'string')
  ) {
    return false;
  }
  const nowMs = Date.now();
  const previousOwnerAccountId = payload.previousOwnerAccountId;
  const pending =
    payload?.status === 'suspended' && payload.suspensionReason === 'ownership_transfer_pending';
  const completedReplay =
    payload?.status === 'active' && payload.suspensionReason === null && payload.replayed === true;
  const validCommonTiming =
    Number.isSafeInteger(payload.preparedAtMs) &&
    payload.preparedAtMs > 0 &&
    payload.preparedAtMs <= nowMs + 5_000 &&
    Number.isSafeInteger(payload.expiresAtMs) &&
    payload.expiresAtMs > payload.preparedAtMs &&
    payload.expiresAtMs <=
      payload.preparedAtMs + ADMIN_PRO_ROOM_OWNER_TRANSFER_CLAIM_MAX_TTL_MS + 5_000;
  const validPendingTiming =
    pending &&
    typeof payload.claimGeneration === 'number' &&
    Number.isSafeInteger(payload.claimGeneration) &&
    payload.claimGeneration >= 0 &&
    payload.committedAtMs === null &&
    Number.isSafeInteger(payload.replayUntilMs) &&
    payload.replayUntilMs === payload.expiresAtMs &&
    payload.expiresAtMs > nowMs;
  const validCompletedReplayTiming =
    completedReplay &&
    payload.claimGeneration === null &&
    typeof payload.committedAtMs === 'number' &&
    Number.isSafeInteger(payload.committedAtMs) &&
    payload.committedAtMs >= payload.preparedAtMs &&
    payload.committedAtMs <= nowMs + 5_000 &&
    Number.isSafeInteger(payload.replayUntilMs) &&
    payload.replayUntilMs > nowMs &&
    payload.replayUntilMs > payload.committedAtMs &&
    payload.replayUntilMs <= payload.committedAtMs + PRO_ROOM_OWNER_TRANSFER_RECEIPT_TTL_MS + 5_000;
  return (
    (pending || completedReplay) &&
    OWNER_TRANSFER_ID_RE.test(payload.transferId) &&
    OWNER_TRANSFER_COMMIT_PROOF_RE.test(payload.commitProof) &&
    payload.targetAccountId === targetAccountId &&
    (previousOwnerAccountId === null ||
      (ACCOUNT_ID_RE.test(previousOwnerAccountId) && previousOwnerAccountId !== targetAccountId)) &&
    typeof payload.replayed === 'boolean' &&
    validCommonTiming &&
    (validPendingTiming || validCompletedReplayTiming)
  );
}

interface OwnerTransferCommitPayload extends JsonObject {
  ok: true;
  status: 'active';
  suspensionReason: null;
  transferId: string;
  replayed: boolean;
  snapshot: JsonObject & { roomCode: string };
  session: JsonObject & { expiresAtMs: number };
}

function validOwnerTransferCommitPayload(
  payload: unknown,
  prepared: OwnerTransferPreparePayload,
): payload is OwnerTransferCommitPayload {
  if (
    !proRoomAdminResponseIdentityMatches(payload, prepared.roomCode, prepared.roomGeneration) ||
    !isJsonObject(payload.snapshot) ||
    !isJsonObject(payload.session)
  ) {
    return false;
  }
  return (
    payload.ok === true &&
    payload.status === 'active' &&
    payload.suspensionReason === null &&
    payload.transferId === prepared.transferId &&
    typeof payload.replayed === 'boolean' &&
    payload.snapshot.roomCode === prepared.roomCode &&
    typeof payload.session.expiresAtMs === 'number' &&
    Number.isSafeInteger(payload.session.expiresAtMs) &&
    payload.session.expiresAtMs > Date.now()
  );
}

function validOwnerTransferReconcilePayload(payload: unknown, saga: OwnerTransferSaga) {
  if (!proRoomAdminResponseIdentityMatches(payload, saga.roomCode, saga.roomGeneration)) {
    return false;
  }
  return (
    payload.ok === true &&
    payload.status === 'active' &&
    payload.suspensionReason === null &&
    payload.transferId === saga.transferId &&
    payload.requestId === saga.requestId &&
    payload.targetAccountId === saga.targetAccountId &&
    payload.previousOwnerAccountId === saga.previousOwnerAccountId &&
    typeof payload.replayed === 'boolean' &&
    !Object.hasOwn(payload, 'snapshot') &&
    !Object.hasOwn(payload, 'session')
  );
}

async function createOwnerTransferRevocationReceipt(
  env: AppEnv,
  prepared: { roomCode: string; roomGeneration: number; transferId: string },
  targetAccountId: string,
  requestId: string,
  revokedAtMs: number,
) {
  const secret = String(env.MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET || '');
  if (secret.length < 32) throw new Error('PRO account assertion secret unavailable');
  return issueProRoomOwnerTransferRevocationReceipt(
    {
      roomCode: prepared.roomCode,
      roomGeneration: prepared.roomGeneration,
      transferId: prepared.transferId,
      targetAccountId,
      requestId,
    },
    secret,
    {
      revokedAtMs,
      expiresAtMs: revokedAtMs + PRO_ROOM_OWNER_TRANSFER_RECEIPT_TTL_MS,
    },
  );
}

function ownerTransferPrepareAuditResult(response: Response, payload: unknown) {
  const code = isJsonObject(payload) && typeof payload.error === 'string' ? payload.error : '';
  if (code === 'OWNER_TRANSFER_CLAIM_EXPIRED') return 'expired';
  if (code === 'OWNER_TRANSFER_TARGET_ACCOUNT_MISMATCH') return 'denied_target_mismatch';
  if (code === 'OWNER_TRANSFER_CLAIM_STALE') return 'denied_stale';
  if (code === 'OWNER_TRANSFER_CLAIM_USED') return 'denied_replay';
  if (code === 'OWNER_TRANSFER_CLAIM_INVALID') return 'denied_invalid';
  if (response && response.status >= 400 && response.status < 500) return 'denied';
  return response ? 'service_rejected' : 'service_unavailable';
}

async function auditSystemOwnerTransfer(
  env: AppEnv,
  action: string,
  result: string,
  roomCode: string,
  roomGeneration: number,
) {
  const db = getAdminDb(env);
  if (!db?.prepare) throw new Error('PRO room registry unavailable');
  await appendSystemAdminProRoomAudit(
    db,
    'system:owner-transfer',
    action,
    result,
    roomCode,
    roomGeneration,
  );
}

const OWNER_TRANSFER_SAGA_STATE_RANK = Object.freeze({
  prepared: 0,
  committed: 1,
  registry_active: 2,
  old_owner_edge_retired: 3,
  verified: 4,
  complete: 5,
});

type OwnerTransferSagaState =
  | 'intent'
  | 'prepared'
  | 'committed'
  | 'registry_active'
  | 'old_owner_edge_retired'
  | 'verified'
  | 'complete'
  | 'target_deleted'
  | 'expired'
  | 'superseded';

interface OwnerTransferSaga {
  roomCode: string;
  roomGeneration: number;
  claimGeneration: number | null;
  transferId: string | null;
  requestId: string;
  targetAccountId: string;
  previousOwnerAccountId: string | null;
  fenceDigest: string | null;
  state: OwnerTransferSagaState;
  intentAtMs: number;
  preparedAtMs: number | null;
  expiresAtMs: number;
  updatedAtMs: number;
}

function isOwnerTransferSagaState(value: unknown): value is OwnerTransferSagaState {
  return (
    typeof value === 'string' &&
    [
      'intent',
      'prepared',
      'committed',
      'registry_active',
      'old_owner_edge_retired',
      'verified',
      'complete',
      'target_deleted',
      'expired',
      'superseded',
    ].some((state) => state === value)
  );
}

function normalizeOwnerTransferSagaRow(
  row: Record<string, unknown> | null,
): OwnerTransferSaga | null {
  if (!row) return null;
  const roomGeneration = Number(row?.room_generation);
  const claimGeneration = row?.claim_generation === null ? null : Number(row?.claim_generation);
  const preparedAtMs = row?.prepared_at === null ? null : Number(row?.prepared_at);
  const intentAtMs = Number(row?.intent_at);
  const expiresAtMs = Number(row?.expires_at);
  const updatedAtMs = Number(row?.updated_at);
  const roomCode = typeof row.room_code === 'string' ? row.room_code : '';
  const requestId = typeof row.request_id === 'string' ? row.request_id : '';
  const targetAccountId = typeof row.target_account_id === 'string' ? row.target_account_id : '';
  const previousOwnerAccountId =
    typeof row.previous_owner_account_id === 'string' ? row.previous_owner_account_id : null;
  const transferId = typeof row.transfer_id === 'string' ? row.transfer_id : null;
  const fenceDigest = typeof row.fence_digest === 'string' ? row.fence_digest : null;
  const state = row.state;
  const unfilled = transferId === null;
  const terminalUnfilled =
    unfilled &&
    claimGeneration === null &&
    previousOwnerAccountId === null &&
    fenceDigest === null &&
    preparedAtMs === null &&
    (state === 'intent' || state === 'expired' || state === 'superseded');
  const filled =
    !unfilled &&
    typeof claimGeneration === 'number' &&
    Number.isSafeInteger(claimGeneration) &&
    claimGeneration >= 0 &&
    OWNER_TRANSFER_ID_RE.test(transferId || '') &&
    /^[A-Za-z0-9_-]{43}$/.test(fenceDigest || '') &&
    typeof preparedAtMs === 'number' &&
    Number.isSafeInteger(preparedAtMs) &&
    preparedAtMs >= 0 &&
    expiresAtMs > preparedAtMs;
  if (
    !ADMIN_PRO_ROOM_CODE_RE.test(roomCode) ||
    !isProRoomGeneration(roomGeneration) ||
    !OWNER_TRANSFER_REQUEST_ID_RE.test(requestId) ||
    !ACCOUNT_ID_RE.test(targetAccountId) ||
    (previousOwnerAccountId !== null &&
      (!ACCOUNT_ID_RE.test(previousOwnerAccountId || '') ||
        previousOwnerAccountId === targetAccountId)) ||
    !isOwnerTransferSagaState(state) ||
    (!terminalUnfilled && !filled) ||
    !Number.isSafeInteger(intentAtMs) ||
    intentAtMs < 0 ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= 0 ||
    !Number.isSafeInteger(updatedAtMs) ||
    updatedAtMs < intentAtMs
  ) {
    return null;
  }
  return {
    roomCode,
    roomGeneration,
    claimGeneration,
    transferId,
    requestId,
    targetAccountId,
    previousOwnerAccountId,
    fenceDigest,
    state,
    intentAtMs,
    preparedAtMs,
    expiresAtMs,
    updatedAtMs,
  };
}

async function readOwnerTransferSaga(
  db: D1Database,
  roomCode: string,
  roomGeneration: number,
  requestId: string,
  transferId: string | null = null,
) {
  await ensureAdminProRoomRegistry(db);
  const statement = transferId
    ? db
        .prepare(
          `SELECT room_code, room_generation, claim_generation, transfer_id, request_id,
                  target_account_id, previous_owner_account_id, fence_digest, state,
                  intent_at, prepared_at, expires_at, updated_at
             FROM ${ADMIN_PRO_ROOM_OWNER_TRANSFER_SAGA_TABLE}
            WHERE room_code = ?1 AND room_generation = ?2
              AND request_id = ?3 AND transfer_id = ?4
            LIMIT 1`,
        )
        .bind(roomCode, roomGeneration, requestId, transferId)
    : db
        .prepare(
          `SELECT room_code, room_generation, claim_generation, transfer_id, request_id,
                  target_account_id, previous_owner_account_id, fence_digest, state,
                  intent_at, prepared_at, expires_at, updated_at
             FROM ${ADMIN_PRO_ROOM_OWNER_TRANSFER_SAGA_TABLE}
            WHERE room_code = ?1 AND room_generation = ?2 AND request_id = ?3
            LIMIT 1`,
        )
        .bind(roomCode, roomGeneration, requestId);
  const row =
    typeof statement.first === 'function'
      ? await statement.first()
      : (await statement.all())?.results?.[0] || null;
  return normalizeOwnerTransferSagaRow(row);
}

async function recordOwnerTransferIntent(
  db: D1Database,
  {
    roomCode,
    roomGeneration,
    requestId,
    targetAccountId,
  }: {
    roomCode: string;
    roomGeneration: number;
    requestId: string;
    targetAccountId: string;
  },
  nowMs: number = Date.now(),
) {
  await ensureAdminProRoomRegistry(db);
  if (
    !ADMIN_PRO_ROOM_CODE_RE.test(roomCode || '') ||
    !isProRoomGeneration(roomGeneration) ||
    !OWNER_TRANSFER_REQUEST_ID_RE.test(requestId || '') ||
    !ACCOUNT_ID_RE.test(targetAccountId || '') ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0
  ) {
    return null;
  }
  const expiresAtMs = nowMs + ADMIN_PRO_ROOM_OWNER_TRANSFER_INTENT_TTL_MS;
  await db
    .prepare(
      `INSERT OR IGNORE INTO ${ADMIN_PRO_ROOM_OWNER_TRANSFER_SAGA_TABLE}
        (room_code, room_generation, claim_generation, transfer_id, request_id,
         target_account_id, previous_owner_account_id, fence_digest, state,
         intent_at, prepared_at, expires_at, updated_at)
       VALUES (?1, ?2, NULL, NULL, ?3, ?4, NULL, NULL, 'intent', ?5, NULL, ?6, ?5)`,
    )
    .bind(roomCode, roomGeneration, requestId, targetAccountId, nowMs, expiresAtMs)
    .run();
  const intent = await readOwnerTransferSaga(db, roomCode, roomGeneration, requestId);
  return intent &&
    intent.targetAccountId === targetAccountId &&
    !['expired', 'superseded', 'target_deleted'].includes(intent.state)
    ? intent
    : null;
}

async function recordOwnerTransferIssuance(
  db: D1Database,
  {
    roomCode,
    roomGeneration,
    claimGeneration,
    targetAccountId,
    expiresAtMs,
  }: {
    roomCode: string;
    roomGeneration: number;
    claimGeneration: number;
    targetAccountId: string;
    expiresAtMs: number;
  },
  nowMs: number = Date.now(),
) {
  await ensureAdminProRoomRegistry(db);
  if (
    !Number.isSafeInteger(claimGeneration) ||
    claimGeneration < 0 ||
    !ACCOUNT_ID_RE.test(targetAccountId || '') ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= nowMs
  ) {
    return false;
  }
  await db
    .prepare(
      `UPDATE ${ADMIN_PRO_ROOM_OWNER_TRANSFER_ISSUANCE_TABLE}
          SET state = 'superseded', updated_at = ?4
        WHERE room_code = ?1 AND room_generation = ?2
          AND claim_generation <> ?3 AND state = 'issued'`,
    )
    .bind(roomCode, roomGeneration, claimGeneration, nowMs)
    .run();
  await db
    .prepare(
      `INSERT OR IGNORE INTO ${ADMIN_PRO_ROOM_OWNER_TRANSFER_ISSUANCE_TABLE}
        (room_code, room_generation, claim_generation, target_account_id,
         transfer_id, request_id, state, issued_at, expires_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, NULL, NULL, 'issued', ?5, ?6, ?5)`,
    )
    .bind(roomCode, roomGeneration, claimGeneration, targetAccountId, nowMs, expiresAtMs)
    .run();
  const statement = db
    .prepare(
      `SELECT target_account_id, state, expires_at
         FROM ${ADMIN_PRO_ROOM_OWNER_TRANSFER_ISSUANCE_TABLE}
        WHERE room_code = ?1 AND room_generation = ?2 AND claim_generation = ?3
        LIMIT 1`,
    )
    .bind(roomCode, roomGeneration, claimGeneration);
  const row =
    typeof statement.first === 'function'
      ? await statement.first()
      : (await statement.all())?.results?.[0] || null;
  return (
    row?.target_account_id === targetAccountId &&
    row?.state === 'issued' &&
    Number(row?.expires_at) === expiresAtMs
  );
}

async function recordPreparedOwnerTransferSaga(
  db: D1Database,
  {
    roomCode,
    roomGeneration,
    claimGeneration,
    transferId,
    requestId,
    targetAccountId,
    previousOwnerAccountId,
    fenceDigest,
    preparedAtMs,
    expiresAtMs,
  }: {
    roomCode: string;
    roomGeneration: number;
    claimGeneration: number | null;
    transferId: string;
    requestId: string;
    targetAccountId: string;
    previousOwnerAccountId: string | null;
    fenceDigest: string;
    preparedAtMs: number;
    expiresAtMs: number;
  },
  nowMs: number = Date.now(),
) {
  await ensureAdminProRoomRegistry(db);
  const existing = await readOwnerTransferSaga(db, roomCode, roomGeneration, requestId);
  if (!existing || existing.targetAccountId !== targetAccountId) return null;
  if (claimGeneration === null) {
    return existing.transferId === transferId &&
      existing.previousOwnerAccountId === previousOwnerAccountId &&
      existing.fenceDigest === fenceDigest &&
      existing.preparedAtMs === preparedAtMs &&
      existing.expiresAtMs === expiresAtMs
      ? existing
      : null;
  }
  await db
    .prepare(
      `UPDATE ${ADMIN_PRO_ROOM_OWNER_TRANSFER_SAGA_TABLE}
          SET claim_generation = ?4, transfer_id = ?5,
              previous_owner_account_id = ?7, fence_digest = ?8,
              state = CASE WHEN state = 'intent' THEN 'prepared' ELSE state END,
              prepared_at = ?9, expires_at = ?10,
              updated_at = ?11
        WHERE room_code = ?1 AND room_generation = ?2 AND request_id = ?3
          AND target_account_id = ?6
          AND (
            (state = 'intent' AND claim_generation IS NULL AND transfer_id IS NULL
              AND fence_digest IS NULL AND prepared_at IS NULL)
            OR
            (claim_generation = ?4 AND transfer_id = ?5
              AND previous_owner_account_id IS ?7 AND fence_digest = ?8
              AND prepared_at = ?9 AND expires_at = ?10
              AND state IN ('prepared', 'committed', 'registry_active',
                            'old_owner_edge_retired', 'verified', 'complete'))
          )`,
    )
    .bind(
      roomCode,
      roomGeneration,
      requestId,
      claimGeneration,
      transferId,
      targetAccountId,
      previousOwnerAccountId,
      fenceDigest,
      preparedAtMs,
      expiresAtMs,
      Math.max(nowMs, existing.intentAtMs, preparedAtMs),
    )
    .run();
  // Rollout-safe inference: claims exposed by a previous matched App Worker
  // can still be correlated without storing the bearer or nonce.
  await db
    .prepare(
      `INSERT OR IGNORE INTO ${ADMIN_PRO_ROOM_OWNER_TRANSFER_ISSUANCE_TABLE}
        (room_code, room_generation, claim_generation, target_account_id,
         transfer_id, request_id, state, issued_at, expires_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'prepared', ?7, ?8, ?9)`,
    )
    .bind(
      roomCode,
      roomGeneration,
      claimGeneration,
      targetAccountId,
      transferId,
      requestId,
      preparedAtMs,
      expiresAtMs,
      Math.max(nowMs, preparedAtMs),
    )
    .run();
  await db
    .prepare(
      `UPDATE ${ADMIN_PRO_ROOM_OWNER_TRANSFER_ISSUANCE_TABLE}
          SET transfer_id = ?5, request_id = ?6, state = 'prepared', updated_at = ?9
        WHERE room_code = ?1 AND room_generation = ?2 AND claim_generation = ?3
          AND target_account_id = ?4 AND expires_at = ?8
          AND state IN ('issued', 'prepared')
          AND (transfer_id IS NULL OR (transfer_id = ?5 AND request_id = ?6))`,
    )
    .bind(
      roomCode,
      roomGeneration,
      claimGeneration,
      targetAccountId,
      transferId,
      requestId,
      preparedAtMs,
      expiresAtMs,
      Math.max(nowMs, preparedAtMs),
    )
    .run();
  const saga = await readOwnerTransferSaga(db, roomCode, roomGeneration, requestId, transferId);
  return saga?.claimGeneration === claimGeneration &&
    saga.targetAccountId === targetAccountId &&
    saga.previousOwnerAccountId === previousOwnerAccountId &&
    saga.fenceDigest === fenceDigest
    ? saga
    : null;
}

type RankedOwnerTransferSagaState = keyof typeof OWNER_TRANSFER_SAGA_STATE_RANK;

function isRankedOwnerTransferSagaState(
  state: OwnerTransferSagaState,
): state is RankedOwnerTransferSagaState {
  return Object.hasOwn(OWNER_TRANSFER_SAGA_STATE_RANK, state);
}

async function advanceOwnerTransferSagaState(
  db: D1Database,
  saga: OwnerTransferSaga,
  nextState: OwnerTransferSagaState,
  nowMs: number = Date.now(),
) {
  if (
    !isRankedOwnerTransferSagaState(nextState) &&
    !['target_deleted', 'expired', 'superseded'].includes(nextState)
  ) {
    return false;
  }
  if (saga.state === 'intent') {
    if (nextState !== 'expired' && nextState !== 'superseded') return false;
    await db
      .prepare(
        `UPDATE ${ADMIN_PRO_ROOM_OWNER_TRANSFER_SAGA_TABLE}
            SET state = ?4, updated_at = ?5
          WHERE room_code = ?1 AND room_generation = ?2 AND request_id = ?3
            AND state = 'intent' AND transfer_id IS NULL`,
      )
      .bind(
        saga.roomCode,
        saga.roomGeneration,
        saga.requestId,
        nextState,
        Math.max(nowMs, saga.intentAtMs),
      )
      .run();
    const current = await readOwnerTransferSaga(
      db,
      saga.roomCode,
      saga.roomGeneration,
      saga.requestId,
    );
    return current?.state === nextState;
  }
  const nextRank = isRankedOwnerTransferSagaState(nextState)
    ? OWNER_TRANSFER_SAGA_STATE_RANK[nextState]
    : undefined;
  const allowedStates =
    typeof nextRank === 'number'
      ? Object.entries(OWNER_TRANSFER_SAGA_STATE_RANK)
          .filter(([, rank]) => rank <= nextRank)
          .map(([state]) => `'${state}'`)
          .join(', ')
      : Object.keys(OWNER_TRANSFER_SAGA_STATE_RANK)
          .map((state) => `'${state}'`)
          .join(', ');
  await db
    .prepare(
      `UPDATE ${ADMIN_PRO_ROOM_OWNER_TRANSFER_SAGA_TABLE}
          SET state = ?5, updated_at = ?6
        WHERE room_code = ?1 AND room_generation = ?2
          AND transfer_id = ?3 AND request_id = ?4
          AND state IN (${allowedStates})`,
    )
    .bind(
      saga.roomCode,
      saga.roomGeneration,
      saga.transferId,
      saga.requestId,
      nextState,
      Math.max(nowMs, saga.preparedAtMs ?? saga.intentAtMs),
    )
    .run();
  const current = await readOwnerTransferSaga(
    db,
    saga.roomCode,
    saga.roomGeneration,
    saga.requestId,
    saga.transferId,
  );
  if (!current) return false;
  if (current.state === nextState) return true;
  const currentRank = isRankedOwnerTransferSagaState(current.state)
    ? OWNER_TRANSFER_SAGA_STATE_RANK[current.state]
    : undefined;
  return typeof currentRank === 'number' && typeof nextRank === 'number' && currentRank >= nextRank;
}

interface OwnerTransferReconciliationMeta extends JsonObject {
  phase: 'pending' | 'completed';
  transferId: string;
  requestId: string;
  targetAccountId: string;
  previousOwnerAccountId: string | null;
  preparedAtMs: number;
  expiresAtMs: number;
  claimGeneration: number | null;
  committedAtMs: number | null;
  replayUntilMs: number;
}

function isOwnerTransferReconciliationMeta(meta: unknown): meta is OwnerTransferReconciliationMeta {
  return (
    isJsonObject(meta) &&
    (meta.phase === 'pending' || meta.phase === 'completed') &&
    typeof meta.transferId === 'string' &&
    typeof meta.requestId === 'string' &&
    typeof meta.targetAccountId === 'string' &&
    (meta.previousOwnerAccountId === null || typeof meta.previousOwnerAccountId === 'string') &&
    typeof meta.preparedAtMs === 'number' &&
    typeof meta.expiresAtMs === 'number' &&
    (meta.claimGeneration === null || typeof meta.claimGeneration === 'number') &&
    (meta.committedAtMs === null || typeof meta.committedAtMs === 'number') &&
    typeof meta.replayUntilMs === 'number'
  );
}

function ownerTransferReconciliationMatchesSaga(
  meta: unknown,
  saga: OwnerTransferSaga,
): meta is OwnerTransferReconciliationMeta {
  if (!isOwnerTransferReconciliationMeta(meta) || typeof saga.preparedAtMs !== 'number') {
    return false;
  }
  const completed = meta.phase === 'completed';
  const pending = meta.phase === 'pending';
  return (
    (completed || pending) &&
    meta.transferId === saga.transferId &&
    meta.requestId === saga.requestId &&
    meta.targetAccountId === saga.targetAccountId &&
    meta.previousOwnerAccountId === saga.previousOwnerAccountId &&
    Number(meta.preparedAtMs) === saga.preparedAtMs &&
    Number(meta.expiresAtMs) === saga.expiresAtMs &&
    (completed
      ? meta.claimGeneration === null &&
        typeof meta.committedAtMs === 'number' &&
        Number.isSafeInteger(meta.committedAtMs) &&
        meta.committedAtMs >= saga.preparedAtMs &&
        Number.isSafeInteger(meta.replayUntilMs) &&
        meta.replayUntilMs > meta.committedAtMs
      : meta.claimGeneration === saga.claimGeneration &&
        meta.committedAtMs === null &&
        Number(meta.replayUntilMs) === saga.expiresAtMs)
  );
}

function ownerTransferReconciliationMatchesIntent(
  meta: unknown,
  intent: OwnerTransferSaga,
): meta is OwnerTransferReconciliationMeta {
  return (
    intent.state === 'intent' &&
    isOwnerTransferReconciliationMeta(meta) &&
    meta.phase === 'pending' &&
    OWNER_TRANSFER_ID_RE.test(meta.transferId) &&
    meta.requestId === intent.requestId &&
    meta.targetAccountId === intent.targetAccountId &&
    typeof meta.claimGeneration === 'number' &&
    Number.isSafeInteger(meta.claimGeneration) &&
    meta.claimGeneration >= 0 &&
    (meta.previousOwnerAccountId === null ||
      (ACCOUNT_ID_RE.test(meta.previousOwnerAccountId) &&
        meta.previousOwnerAccountId !== intent.targetAccountId)) &&
    Number.isSafeInteger(meta.preparedAtMs) &&
    meta.preparedAtMs >= 0 &&
    Number.isSafeInteger(meta.expiresAtMs) &&
    meta.expiresAtMs > meta.preparedAtMs &&
    meta.committedAtMs === null &&
    meta.replayUntilMs === meta.expiresAtMs
  );
}

async function adoptOwnerTransferIntent(
  env: AppEnv,
  db: D1Database,
  intent: OwnerTransferSaga,
  meta: unknown,
  nowMs: number = Date.now(),
) {
  if (!ownerTransferReconciliationMatchesIntent(meta, intent)) return null;
  const fenceDigest = await developerApiAuthorityFenceDigest(
    env,
    'ownership-transfer',
    `${intent.roomCode}\u0000${intent.roomGeneration}\u0000${meta.transferId}\u0000${intent.targetAccountId}\u0000${intent.requestId}`,
  );
  return recordPreparedOwnerTransferSaga(
    db,
    {
      roomCode: intent.roomCode,
      roomGeneration: intent.roomGeneration,
      claimGeneration: meta.claimGeneration,
      transferId: meta.transferId,
      requestId: intent.requestId,
      targetAccountId: intent.targetAccountId,
      previousOwnerAccountId: meta.previousOwnerAccountId,
      fenceDigest,
      preparedAtMs: meta.preparedAtMs,
      expiresAtMs: meta.expiresAtMs,
    },
    nowMs,
  );
}

async function markOwnerTransferIssuanceState(
  db: D1Database,
  saga: OwnerTransferSaga,
  state: 'expired' | 'superseded',
  nowMs: number = Date.now(),
) {
  const result = await db
    .prepare(
      `UPDATE ${ADMIN_PRO_ROOM_OWNER_TRANSFER_ISSUANCE_TABLE}
          SET state = ?4, updated_at = ?5
        WHERE room_code = ?1 AND room_generation = ?2 AND claim_generation = ?3
          AND state IN ('issued', 'prepared')`,
    )
    .bind(
      saga.roomCode,
      saga.roomGeneration,
      saga.claimGeneration,
      state,
      Math.max(nowMs, saga.preparedAtMs ?? saga.intentAtMs),
    )
    .run();
  return Number(result?.meta?.changes || 0) <= 1;
}

function decommissionedOwnerTransferTombstoneMatches(payload: unknown, saga: OwnerTransferSaga) {
  return (
    proRoomAdminResponseIdentityMatches(payload, saga.roomCode, saga.roomGeneration) &&
    payload.provisioned === false &&
    (payload.status === 'decommissioning' || payload.status === 'decommissioned') &&
    payload.suspensionReason === null &&
    payload.ownerAccountLinked === false &&
    payload.ownerAccountId === null &&
    payload.ownerTransferReconciliation === null
  );
}

async function terminalizeDecommissionedOwnerTransferSagaRecords(
  db: D1Database,
  saga: OwnerTransferSaga,
  nowMs: number = Date.now(),
) {
  if (!db?.prepare || !db?.batch) return false;
  const updatedAtMs = Math.max(nowMs, saga.intentAtMs, saga.preparedAtMs ?? 0);
  await db.batch([
    db
      .prepare(
        `UPDATE ${ADMIN_PRO_ROOM_OWNER_TRANSFER_ISSUANCE_TABLE}
            SET state = 'superseded', updated_at = MAX(updated_at, ?3)
          WHERE room_code = ?1 AND room_generation = ?2
            AND state IN ('issued', 'prepared')`,
      )
      .bind(saga.roomCode, saga.roomGeneration, updatedAtMs),
    db
      .prepare(
        `UPDATE ${ADMIN_PRO_ROOM_OWNER_TRANSFER_SAGA_TABLE}
            SET state = 'superseded', updated_at = MAX(updated_at, ?6)
          WHERE room_code = ?1 AND room_generation = ?2 AND request_id = ?3
            AND target_account_id = ?4 AND transfer_id IS ?5
            AND state IN (
              'intent', 'prepared', 'committed', 'registry_active',
              'old_owner_edge_retired', 'verified'
            )`,
      )
      .bind(
        saga.roomCode,
        saga.roomGeneration,
        saga.requestId,
        saga.targetAccountId,
        saga.transferId,
        updatedAtMs,
      ),
  ]);
  const current = await readOwnerTransferSaga(
    db,
    saga.roomCode,
    saga.roomGeneration,
    saga.requestId,
    saga.transferId,
  );
  if (current?.state !== 'superseded') return false;
  const statement = db
    .prepare(
      `SELECT 1 AS pending
         FROM ${ADMIN_PRO_ROOM_OWNER_TRANSFER_ISSUANCE_TABLE}
        WHERE room_code = ?1 AND room_generation = ?2
          AND state IN ('issued', 'prepared')
        LIMIT 1`,
    )
    .bind(saga.roomCode, saga.roomGeneration);
  const pending =
    typeof statement.first === 'function'
      ? await statement.first()
      : (await statement.all())?.results?.[0] || null;
  return !pending;
}

async function hasExactOwnerTransferDecommissionEvidence(db: D1Database, saga: OwnerTransferSaga) {
  const room = await readAdminProRoom(db, saga.roomCode);
  if (room?.roomGeneration === saga.roomGeneration) {
    return (
      ['decommissioning', 'decommissioned'].includes(room.status) &&
      room.suspensionReason === null &&
      room.activationState === 'unactivated'
    );
  }
  if (room && room.roomGeneration < saga.roomGeneration) return false;
  const statement = db
    .prepare(
      `SELECT room_code, room_generation, status, decommissioned_at
         FROM ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
        WHERE room_code = ?1 AND room_generation = ?2
          AND status = 'decommissioned'
        LIMIT 1`,
    )
    .bind(saga.roomCode, saga.roomGeneration);
  const history =
    typeof statement.first === 'function'
      ? await statement.first()
      : (await statement.all())?.results?.[0] || null;
  const decommissionedAtMs = Number(history?.decommissioned_at);
  return (
    history?.room_code === saga.roomCode &&
    Number(history?.room_generation) === saga.roomGeneration &&
    history?.status === 'decommissioned' &&
    Number.isSafeInteger(decommissionedAtMs) &&
    decommissionedAtMs >= 0
  );
}

async function reconcileDecommissionedOwnerTransferSaga(
  env: AppEnv,
  db: D1Database,
  saga: OwnerTransferSaga,
  payload: unknown,
  nowMs: number,
) {
  if (!decommissionedOwnerTransferTombstoneMatches(payload, saga)) return false;
  try {
    if (!(await hasExactOwnerTransferDecommissionEvidence(db, saga))) return false;
  } catch {
    return false;
  }

  // An uncommitted transfer may still have a source/target reservation. Undo
  // it when possible, then use the exact-incarnation revoke as the canonical
  // cleanup barrier for committed, uncommitted, and source-less transfers.
  await abortProRoomOwnershipTransferEntitlement(env, {
    targetAccountId: saga.targetAccountId,
    roomCode: saga.roomCode,
    roomGeneration: saga.roomGeneration,
    requestId: saga.requestId,
    nowMs,
  }).catch(() => false);
  if (
    !(await revokeProRoomEntitlement(env, {
      roomCode: saga.roomCode,
      roomGeneration: saga.roomGeneration,
      nowMs,
    }).catch(() => false))
  ) {
    return false;
  }
  try {
    return await terminalizeDecommissionedOwnerTransferSagaRecords(db, saga, nowMs);
  } catch {
    return false;
  }
}

async function expireOwnerTransferIssuances(
  env: AppEnv,
  db: D1Database,
  nowMs: number = Date.now(),
) {
  void env;
  await ensureAdminProRoomRegistry(db);
  const result = await db
    .prepare(
      `SELECT room_code, room_generation, claim_generation
         FROM ${ADMIN_PRO_ROOM_OWNER_TRANSFER_ISSUANCE_TABLE}
        WHERE state = 'issued' AND expires_at <= ?1
        ORDER BY expires_at ASC, room_code ASC, room_generation ASC
        LIMIT 50`,
    )
    .bind(nowMs)
    .all<Record<string, unknown>>();
  let expired = 0;
  for (const row of result?.results || []) {
    const roomCode = typeof row?.room_code === 'string' ? row.room_code : '';
    const roomGeneration = Number(row?.room_generation);
    const claimGeneration = Number(row?.claim_generation);
    if (
      !ADMIN_PRO_ROOM_CODE_RE.test(roomCode) ||
      !isProRoomGeneration(roomGeneration) ||
      !Number.isSafeInteger(claimGeneration) ||
      claimGeneration < 0
    ) {
      continue;
    }
    const updated = await db
      .prepare(
        `UPDATE ${ADMIN_PRO_ROOM_OWNER_TRANSFER_ISSUANCE_TABLE}
            SET state = 'expired', updated_at = ?4
          WHERE room_code = ?1 AND room_generation = ?2 AND claim_generation = ?3
            AND state = 'issued' AND expires_at <= ?4`,
      )
      .bind(roomCode, roomGeneration, claimGeneration, nowMs)
      .run();
    if (Number(updated?.meta?.changes || 0) !== 1) continue;
    expired += 1;
  }
  return expired;
}

async function listIncompleteOwnerTransferSagas(db: D1Database) {
  await ensureAdminProRoomRegistry(db);
  const result = await db
    .prepare(
      `SELECT room_code, room_generation, claim_generation, transfer_id, request_id,
              target_account_id, previous_owner_account_id, fence_digest, state,
              intent_at, prepared_at, expires_at, updated_at
         FROM ${ADMIN_PRO_ROOM_OWNER_TRANSFER_SAGA_TABLE}
        WHERE state NOT IN ('complete', 'target_deleted', 'expired', 'superseded')
          AND state IN (
                'intent', 'prepared', 'committed', 'registry_active',
                'old_owner_edge_retired', 'verified'
              )
          AND typeof(room_generation) = 'integer'
          AND room_generation BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
          AND (claim_generation IS NULL OR (
                typeof(claim_generation) = 'integer'
                AND claim_generation BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
              ))
          AND typeof(intent_at) = 'integer'
          AND intent_at BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
          AND (prepared_at IS NULL OR (
                typeof(prepared_at) = 'integer'
                AND prepared_at BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
              ))
          AND typeof(expires_at) = 'integer'
          AND expires_at BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
          AND (prepared_at IS NULL OR expires_at > prepared_at)
          AND typeof(updated_at) = 'integer'
          AND updated_at BETWEEN intent_at AND ${Number.MAX_SAFE_INTEGER}
          AND length(room_code) = 6
          AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'
          AND length(request_id) BETWEEN 16 AND 64
          AND request_id NOT GLOB '*[^A-Za-z0-9_-]*'
          AND length(target_account_id) = 27
          AND substr(target_account_id, 1, 5) = 'acct_'
          AND target_account_id NOT GLOB '*[^A-Za-z0-9_-]*'
          AND (previous_owner_account_id IS NULL OR (
                length(previous_owner_account_id) = 27
                AND substr(previous_owner_account_id, 1, 5) = 'acct_'
                AND previous_owner_account_id NOT GLOB '*[^A-Za-z0-9_-]*'
                AND previous_owner_account_id <> target_account_id
              ))
          AND (
                (transfer_id IS NULL
                  AND claim_generation IS NULL
                  AND previous_owner_account_id IS NULL
                  AND fence_digest IS NULL
                  AND prepared_at IS NULL
                  AND state = 'intent')
                OR
                (transfer_id IS NOT NULL
                  AND length(transfer_id) = 31
                  AND substr(transfer_id, 1, 9) = 'transfer_'
                  AND transfer_id NOT GLOB '*[^A-Za-z0-9_-]*'
                  AND claim_generation IS NOT NULL
                  AND fence_digest IS NOT NULL
                  AND length(fence_digest) = 43
                  AND fence_digest NOT GLOB '*[^A-Za-z0-9_-]*'
                  AND prepared_at IS NOT NULL
                  AND state <> 'intent')
              )
        ORDER BY updated_at ASC, room_code ASC, room_generation ASC
        LIMIT 50`,
    )
    .all<Record<string, unknown>>();
  return (result?.results || [])
    .map(normalizeOwnerTransferSagaRow)
    .filter((saga): saga is OwnerTransferSaga => saga !== null);
}

async function rotateIncompleteOwnerTransferSaga(
  db: D1Database,
  saga: OwnerTransferSaga,
  nowMs: number = Date.now(),
) {
  const nextUpdatedAt = Math.max(nowMs, saga.updatedAtMs + 1);
  if (!Number.isSafeInteger(nextUpdatedAt)) return false;
  const result = await db
    .prepare(
      `UPDATE ${ADMIN_PRO_ROOM_OWNER_TRANSFER_SAGA_TABLE}
          SET updated_at = ?8
        WHERE room_code = ?1 AND room_generation = ?2 AND request_id = ?3
          AND target_account_id = ?4 AND transfer_id IS ?5
          AND state = ?6 AND updated_at = ?7
          AND state NOT IN ('complete', 'target_deleted', 'expired', 'superseded')`,
    )
    .bind(
      saga.roomCode,
      saga.roomGeneration,
      saga.requestId,
      saga.targetAccountId,
      saga.transferId,
      saga.state,
      saga.updatedAtMs,
      nextUpdatedAt,
    )
    .run();
  return Number(result?.meta?.changes || 0) === 1;
}

async function commitAdoptedOwnerTransferSaga(
  env: AppEnv,
  saga: OwnerTransferSaga,
  nowMs: number = Date.now(),
) {
  if (!saga.fenceDigest || !saga.transferId) return false;
  let target;
  try {
    target = await readActiveOwnerTransferTarget(env, saga.targetAccountId);
  } catch {
    return false;
  }
  if (!target) return false;
  try {
    if (
      !(await recordAccountProRoomLink(
        env,
        saga.targetAccountId,
        saga.roomCode,
        nowMs,
        saga.roomGeneration,
      ))
    ) {
      return false;
    }
  } catch {
    return false;
  }

  let revocation;
  try {
    revocation = await revokeDeveloperApiKeysForAuthorityChange(
      env,
      saga.roomCode,
      saga.roomGeneration,
      'system:owner-transfer',
      'ownership_transfer',
      'ownership_transfer_pending',
      saga.fenceDigest,
    );
  } catch {
    return false;
  }
  let revocationReceipt;
  try {
    revocationReceipt = await createOwnerTransferRevocationReceipt(
      env,
      {
        roomCode: saga.roomCode,
        roomGeneration: saga.roomGeneration,
        transferId: saga.transferId,
      },
      saga.targetAccountId,
      saga.requestId,
      revocation.revokedAtMs,
    );
  } catch {
    return false;
  }
  const committed = await callProRoomAdminObject(
    env,
    saga.roomCode,
    saga.roomGeneration,
    '/internal/admin/owner-transfer/reconcile',
    'POST',
    {
      transferId: saga.transferId,
      targetAccountId: saga.targetAccountId,
      requestId: saga.requestId,
      revocationReceipt,
    },
  );
  return (
    committed.response?.ok === true && validOwnerTransferReconcilePayload(committed.payload, saga)
  );
}

async function reconcileOneOwnerTransferSaga(
  env: AppEnv,
  db: D1Database,
  saga: OwnerTransferSaga,
  nowMs: number = Date.now(),
) {
  const entitlementInput = () => ({
    targetAccountId: saga.targetAccountId,
    roomCode: saga.roomCode,
    roomGeneration: saga.roomGeneration,
    requestId: saga.requestId,
    nowMs,
  });
  const abortPendingEntitlement = () =>
    abortProRoomOwnershipTransferEntitlement(env, entitlementInput()).catch(() => false);
  const status = await callProRoomAdminObject(
    env,
    saga.roomCode,
    saga.roomGeneration,
    '/internal/admin/status',
    'GET',
  );
  if (
    !status.response?.ok ||
    !proRoomAdminResponseIdentityMatches(status.payload, saga.roomCode, saga.roomGeneration)
  ) {
    return false;
  }
  if (status.payload?.provisioned === false) {
    return reconcileDecommissionedOwnerTransferSaga(env, db, saga, status.payload, nowMs);
  }
  if (status.payload?.provisioned !== true) return false;
  let meta = status.payload.ownerTransferReconciliation;
  if (saga.state === 'intent') {
    if (ownerTransferReconciliationMatchesIntent(meta, saga)) {
      try {
        const adopted = await adoptOwnerTransferIntent(env, db, saga, meta, nowMs);
        if (!adopted) return false;
        saga = adopted;
      } catch {
        return false;
      }
    } else if (meta && typeof meta === 'object') {
      if (!(await abortPendingEntitlement())) return false;
      return advanceOwnerTransferSagaState(db, saga, 'superseded', nowMs);
    } else if (saga.expiresAtMs <= nowMs) {
      if (!(await abortPendingEntitlement())) return false;
      return advanceOwnerTransferSagaState(db, saga, 'expired', nowMs);
    } else {
      return false;
    }
  }
  if (!ownerTransferReconciliationMatchesSaga(meta, saga)) {
    const committedOrLater =
      isRankedOwnerTransferSagaState(saga.state) &&
      OWNER_TRANSFER_SAGA_STATE_RANK[saga.state] >= OWNER_TRANSFER_SAGA_STATE_RANK.committed;
    if (
      committedOrLater &&
      status.payload.status === 'suspended' &&
      status.payload.suspensionReason === 'owner_account_deleted'
    ) {
      let target;
      try {
        target = await readActiveOwnerTransferTarget(env, saga.targetAccountId);
      } catch {
        return false;
      }
      if (!target) {
        await auditSystemOwnerTransfer(
          env,
          'owner_transfer.commit',
          'target_deleted_during_reconcile',
          saga.roomCode,
          saga.roomGeneration,
        );
        if (
          !(await finalizeProRoomOwnershipTransferEntitlement(env, entitlementInput()).catch(
            () => false,
          ))
        ) {
          return false;
        }
        return advanceOwnerTransferSagaState(db, saga, 'target_deleted', nowMs);
      }
    }
    if (meta && typeof meta === 'object') {
      await markOwnerTransferIssuanceState(db, saga, 'superseded', nowMs);
      if (!committedOrLater && !(await abortPendingEntitlement())) return false;
      return advanceOwnerTransferSagaState(db, saga, 'superseded', nowMs);
    }
    if (saga.expiresAtMs <= nowMs) {
      await markOwnerTransferIssuanceState(db, saga, 'expired', nowMs);
      if (!committedOrLater && !(await abortPendingEntitlement())) return false;
      const advanced = await advanceOwnerTransferSagaState(db, saga, 'expired', nowMs);
      return advanced;
    }
    return false;
  }
  if (
    !(await reserveProRoomOwnershipTransferEntitlement(env, entitlementInput()).catch(() => false))
  ) {
    return false;
  }
  if (meta.phase === 'pending') {
    if (saga.expiresAtMs <= nowMs) {
      await markOwnerTransferIssuanceState(db, saga, 'expired', nowMs);
      if (!(await abortPendingEntitlement())) return false;
      return advanceOwnerTransferSagaState(db, saga, 'expired', nowMs);
    }
    if (!(await commitAdoptedOwnerTransferSaga(env, saga, nowMs))) return false;
    if (!(await advanceOwnerTransferSagaState(db, saga, 'committed', nowMs))) return false;
    const refreshed = await callProRoomAdminObject(
      env,
      saga.roomCode,
      saga.roomGeneration,
      '/internal/admin/status',
      'GET',
    );
    if (
      !refreshed.response?.ok ||
      !proRoomAdminResponseIdentityMatches(refreshed.payload, saga.roomCode, saga.roomGeneration)
    ) {
      return false;
    }
    meta = refreshed.payload.ownerTransferReconciliation;
    if (
      !ownerTransferReconciliationMatchesSaga(meta, {
        ...saga,
        state: 'committed',
      }) ||
      meta.phase !== 'completed'
    ) {
      return false;
    }
  }

  if (!(await advanceOwnerTransferSagaState(db, saga, 'committed', nowMs))) return false;
  let target;
  try {
    target = await readActiveOwnerTransferTarget(env, saga.targetAccountId);
  } catch {
    return false;
  }
  if (!target) {
    const suspended = await purgeProRoomAccountAuthority(
      {
        accountId: saga.targetAccountId,
        roomCode: saga.roomCode,
        roomGeneration: saga.roomGeneration,
      },
      env,
    ).catch(() => false);
    if (!suspended) return false;
    await auditSystemOwnerTransfer(
      env,
      'owner_transfer.commit',
      'target_deleted_during_reconcile',
      saga.roomCode,
      saga.roomGeneration,
    );
    if (
      !(await finalizeProRoomOwnershipTransferEntitlement(env, entitlementInput()).catch(
        () => false,
      ))
    ) {
      return false;
    }
    return advanceOwnerTransferSagaState(db, saga, 'target_deleted', nowMs);
  }

  if (
    !(await markAdminProRoomOperationalState(
      db,
      saga.roomCode,
      saga.roomGeneration,
      'active',
      null,
      nowMs,
    )) ||
    !(await advanceOwnerTransferSagaState(db, saga, 'registry_active', nowMs))
  ) {
    return false;
  }
  if (
    saga.previousOwnerAccountId &&
    !(await retireAccountProRoomLinkForAccount(
      env,
      saga.previousOwnerAccountId,
      saga.roomCode,
      saga.roomGeneration,
    ))
  ) {
    return false;
  }
  if (!(await advanceOwnerTransferSagaState(db, saga, 'old_owner_edge_retired', nowMs))) {
    return false;
  }

  try {
    target = await readActiveOwnerTransferTarget(env, saga.targetAccountId);
  } catch {
    return false;
  }
  if (!target) {
    const suspended = await purgeProRoomAccountAuthority(
      {
        accountId: saga.targetAccountId,
        roomCode: saga.roomCode,
        roomGeneration: saga.roomGeneration,
      },
      env,
    ).catch(() => false);
    if (!suspended) return false;
    if (
      !(await finalizeProRoomOwnershipTransferEntitlement(env, entitlementInput()).catch(
        () => false,
      ))
    ) {
      return false;
    }
    return advanceOwnerTransferSagaState(db, saga, 'target_deleted', nowMs);
  }
  let room = await readAdminProRoom(db, saga.roomCode);
  if (!room || room.roomGeneration !== saga.roomGeneration) return false;
  const canonicalStatus = await reconcileAdminProRoomStatus(env, db, room);
  room = await readAdminProRoom(db, saga.roomCode);
  if (
    canonicalStatus !== 'active' ||
    !room ||
    room.roomGeneration !== saga.roomGeneration ||
    room.status !== 'registered' ||
    room.suspensionReason !== null ||
    room.activationState !== 'active'
  ) {
    return false;
  }
  if (!(await advanceOwnerTransferSagaState(db, saga, 'verified', nowMs))) return false;
  if (
    !(await finalizeProRoomOwnershipTransferEntitlement(env, entitlementInput()).catch(() => false))
  ) {
    return false;
  }
  if (
    !(await clearDeveloperApiAuthorityFence(
      env,
      saga.roomCode,
      saga.roomGeneration,
      saga.fenceDigest,
    ))
  ) {
    return false;
  }
  await auditSystemOwnerTransfer(
    env,
    'owner_transfer.commit',
    'success',
    saga.roomCode,
    saga.roomGeneration,
  );
  return advanceOwnerTransferSagaState(db, saga, 'complete', nowMs);
}

async function reconcileOwnerTransferSagas(
  env: AppEnv,
  db: D1Database,
  nowMs: number = Date.now(),
) {
  await expireOwnerTransferIssuances(env, db, nowMs);
  const sagas = await listIncompleteOwnerTransferSagas(db);
  const results = await Promise.allSettled(
    sagas.map(async (saga) => {
      let changed = false;
      try {
        changed = await reconcileOneOwnerTransferSaga(env, db, saga, nowMs);
        return changed;
      } finally {
        // A permanently mismatched or temporarily unavailable dependency must
        // not monopolize the oldest LIMIT window forever. Rotate only the exact
        // nonterminal row selected by this sweep; any concurrent progress,
        // terminalization, or replacement makes the CAS a harmless no-op.
        if (!changed) {
          await rotateIncompleteOwnerTransferSaga(db, saga, nowMs).catch(() => false);
        }
      }
    }),
  );
  return results.filter((result) => result.status === 'fulfilled' && result.value === true).length;
}

export async function reconcileOwnerTransferSagasForTests(
  env: unknown,
  db: unknown,
  nowMs: number = Date.now(),
) {
  if (!isAppEnv(env) || !isAppD1Database(db)) {
    throw new TypeError('Owner transfer reconciliation input unavailable');
  }
  return reconcileOwnerTransferSagas(env, db, nowMs);
}

async function handleProRoomOwnershipTransferSaga({
  request,
  env,
  roomCode,
  roomGeneration,
  targetAccountId,
  headers,
  body,
}: {
  request: Request;
  env: AppEnv;
  roomCode: string;
  roomGeneration: number;
  targetAccountId: string;
  headers: Headers;
  body: Uint8Array | null;
}) {
  const proRoomPublicApi = env.PRO_ROOM_PUBLIC_API;
  const failAudit = async (result: string) => {
    try {
      await auditSystemOwnerTransfer(
        env,
        'owner_transfer.prepare',
        result,
        roomCode,
        roomGeneration,
      );
      return null;
    } catch {
      return json({ error: 'PRO_ROOM_AUDIT_UNAVAILABLE' }, 503);
    }
  };

  if (request.method !== 'POST' || new URL(request.url).search) {
    const auditError = await failAudit('denied_invalid_request');
    return (
      auditError ||
      json(
        { error: request.method === 'POST' ? 'INVALID_REQUEST' : 'METHOD_NOT_ALLOWED' },
        request.method === 'POST' ? 400 : 405,
        request.method === 'POST' ? {} : { Allow: 'POST' },
      )
    );
  }
  const requestId = ownerTransferRequestIdFromBodyBytes(body);
  if (!requestId) {
    const auditError = await failAudit('denied_invalid_request');
    return auditError || json({ error: 'INVALID_REQUEST' }, 400);
  }

  const adminDb = getAdminDb(env);
  if (!adminDb?.prepare) {
    const auditError = await failAudit('intent_unavailable');
    return auditError || json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  let transferSaga;
  try {
    transferSaga = await recordOwnerTransferIntent(adminDb, {
      roomCode,
      roomGeneration,
      requestId,
      targetAccountId,
    });
  } catch {
    const auditError = await failAudit('intent_unavailable');
    return auditError || json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (!transferSaga) {
    const auditError = await failAudit('intent_conflict');
    return auditError || json({ error: 'PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED' }, 503);
  }

  const prepareUrl = new URL(
    `/v1/rooms/${roomCode}/owner-transfer/prepare`,
    PRO_ROOM_UPSTREAM_ORIGIN,
  );
  let prepareResult;
  try {
    if (!proRoomPublicApi) throw new Error('PRO_ROOM_API_UNAVAILABLE');
    prepareResult = await fetchServiceBindingResponse(
      (boundedRequest) => proRoomPublicApi.fetch(boundedRequest),
      new Request(prepareUrl, {
        method: 'POST',
        headers,
        redirect: 'manual',
        body: body === null ? null : new Uint8Array(body).buffer,
      }),
      PRO_ROOM_SERVICE_CONTROL_RESPONSE_MAX_BYTES,
    );
  } catch {
    const auditError = await failAudit('service_unavailable');
    return auditError || json({ error: 'PRO_ROOM_API_UNAVAILABLE' }, 502);
  }
  if (!prepareResult) {
    const auditError = await failAudit('service_unavailable');
    return auditError || json({ error: 'PRO_ROOM_API_UNAVAILABLE' }, 502);
  }
  const prepareResponse = bufferedServiceResponse(prepareResult.response, prepareResult.bytes);
  const preparePayload = parseServiceJsonBytes(prepareResult.bytes);
  if (!prepareResponse.ok) {
    const auditError = await failAudit(
      ownerTransferPrepareAuditResult(prepareResponse, preparePayload),
    );
    return auditError || withFacadeProRoomCookies(prepareResponse, roomCode);
  }
  if (
    !validOwnerTransferPreparePayload(preparePayload, roomCode, roomGeneration, targetAccountId)
  ) {
    const auditError = await failAudit('invalid_service_response');
    return auditError || json({ error: 'PRO_ROOM_ADMIN_INVALID_RESPONSE' }, 502);
  }
  if (
    !(await reserveProRoomOwnershipTransferEntitlement(env, {
      targetAccountId,
      roomCode,
      roomGeneration,
      requestId,
    }).catch(() => false))
  ) {
    const auditError = await failAudit('target_entitlement_conflict');
    return auditError || json({ error: 'PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED' }, 503);
  }
  let fenceDigest;
  try {
    fenceDigest = await developerApiAuthorityFenceDigest(
      env,
      'ownership-transfer',
      `${roomCode}\u0000${roomGeneration}\u0000${preparePayload.transferId}\u0000${targetAccountId}\u0000${requestId}`,
    );
    transferSaga = await recordPreparedOwnerTransferSaga(adminDb, {
      roomCode,
      roomGeneration,
      claimGeneration: preparePayload.claimGeneration,
      transferId: preparePayload.transferId,
      requestId,
      targetAccountId,
      previousOwnerAccountId: preparePayload.previousOwnerAccountId,
      fenceDigest,
      preparedAtMs: preparePayload.preparedAtMs,
      expiresAtMs: preparePayload.expiresAtMs,
    });
  } catch {
    const auditError = await failAudit('reconcile_required');
    return auditError || json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (!transferSaga) {
    const auditError = await failAudit('reconcile_required');
    return auditError || json({ error: 'PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED' }, 503);
  }
  try {
    const linked = await recordAccountProRoomLink(
      env,
      targetAccountId,
      roomCode,
      Date.now(),
      roomGeneration,
    );
    if (!linked) {
      const auditError = await failAudit('target_link_unavailable');
      return auditError || json({ error: 'OWNER_TRANSFER_TARGET_UNAVAILABLE' }, 409);
    }
  } catch {
    const auditError = await failAudit('target_link_unavailable');
    return auditError || json({ error: 'ACCOUNT_STORE_UNAVAILABLE' }, 503);
  }
  try {
    await auditSystemOwnerTransfer(
      env,
      'owner_transfer.prepare',
      'success',
      roomCode,
      roomGeneration,
    );
  } catch {
    return json({ error: 'PRO_ROOM_AUDIT_UNAVAILABLE' }, 503);
  }

  let room;
  let canonicalStatus;
  try {
    room = await readAdminProRoom(adminDb, roomCode);
    if (!room || room.roomGeneration !== roomGeneration) {
      return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
    }
    canonicalStatus = await reconcileAdminProRoomStatus(env, adminDb, room);
    room = await readAdminProRoom(adminDb, roomCode);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  const expectedSuspended = preparePayload.status === 'suspended';
  if (
    !room ||
    room.roomGeneration !== roomGeneration ||
    (expectedSuspended &&
      (canonicalStatus !== 'suspended' ||
        room.status !== 'suspended' ||
        room.suspensionReason !== 'ownership_transfer_pending')) ||
    (!expectedSuspended &&
      (canonicalStatus !== 'active' ||
        room.status !== 'registered' ||
        room.suspensionReason !== null))
  ) {
    return json({ error: 'PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED' }, 503);
  }

  // Close the target-account deletion race after the DO has fenced old
  // authority but before App D1 authorizes the commit.
  let currentTarget;
  try {
    currentTarget = await readActiveOwnerTransferTarget(env, targetAccountId);
  } catch {
    return json({ error: 'ACCOUNT_STORE_UNAVAILABLE' }, 503);
  }
  if (!currentTarget) {
    await abortProRoomOwnershipTransferEntitlement(env, {
      targetAccountId,
      roomCode,
      roomGeneration,
      requestId,
    }).catch(() => false);
    try {
      await auditSystemOwnerTransfer(
        env,
        'owner_transfer.commit',
        'denied_target_unavailable',
        roomCode,
        roomGeneration,
      );
    } catch {
      return json({ error: 'PRO_ROOM_AUDIT_UNAVAILABLE' }, 503);
    }
    return json({ error: 'OWNER_TRANSFER_TARGET_UNAVAILABLE' }, 409);
  }

  let revocation;
  try {
    revocation = await revokeDeveloperApiKeysForAuthorityChange(
      env,
      roomCode,
      roomGeneration,
      'system:owner-transfer',
      'ownership_transfer',
      'ownership_transfer_pending',
      fenceDigest,
    );
  } catch {
    try {
      await auditSystemOwnerTransfer(
        env,
        'owner_transfer.commit',
        'revocation_unavailable',
        roomCode,
        roomGeneration,
      );
    } catch {
      return json({ error: 'PRO_ROOM_AUDIT_UNAVAILABLE' }, 503);
    }
    return json({ error: 'DEVELOPER_API_ADMIN_UNAVAILABLE' }, 503);
  }

  let revocationReceipt;
  try {
    revocationReceipt = await createOwnerTransferRevocationReceipt(
      env,
      preparePayload,
      targetAccountId,
      requestId,
      revocation.revokedAtMs,
    );
  } catch {
    return json({ error: 'PRO_ROOM_ACCOUNT_ASSERTION_UNAVAILABLE' }, 503);
  }
  const committed = await callProRoomAdminObject(
    env,
    roomCode,
    roomGeneration,
    '/internal/admin/owner-transfer/commit',
    'POST',
    {
      transferId: preparePayload.transferId,
      commitProof: preparePayload.commitProof,
      targetAccountId,
      requestId,
      revocationReceipt,
    },
  );
  if (!committed.response?.ok) {
    try {
      await auditSystemOwnerTransfer(
        env,
        'owner_transfer.commit',
        committed.response ? 'denied' : 'service_unavailable',
        roomCode,
        roomGeneration,
      );
    } catch {
      return json({ error: 'PRO_ROOM_AUDIT_UNAVAILABLE' }, 503);
    }
    return proRoomObjectError(committed);
  }
  if (!validOwnerTransferCommitPayload(committed.payload, preparePayload)) {
    try {
      await auditSystemOwnerTransfer(
        env,
        'owner_transfer.commit',
        'invalid_service_response',
        roomCode,
        roomGeneration,
      );
    } catch {
      return json({ error: 'PRO_ROOM_AUDIT_UNAVAILABLE' }, 503);
    }
    return json({ error: 'PRO_ROOM_ADMIN_INVALID_RESPONSE' }, 502);
  }
  try {
    if (!(await advanceOwnerTransferSagaState(adminDb, transferSaga, 'committed'))) {
      return json({ error: 'PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED' }, 503);
    }
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }

  const abortCommittedTransferForMissingTarget = async (result: string) => {
    let suspended = false;
    try {
      suspended = await purgeProRoomAccountAuthority(
        { accountId: targetAccountId, roomCode, roomGeneration },
        env,
      );
    } catch {
      suspended = false;
    }
    if (suspended) {
      try {
        if (
          !(await finalizeProRoomOwnershipTransferEntitlement(env, {
            targetAccountId,
            roomCode,
            roomGeneration,
            requestId,
          }).catch(() => false)) ||
          !(await advanceOwnerTransferSagaState(adminDb, transferSaga, 'target_deleted'))
        ) {
          suspended = false;
        }
      } catch {
        suspended = false;
      }
    }
    try {
      await auditSystemOwnerTransfer(
        env,
        'owner_transfer.commit',
        suspended ? result : 'reconcile_required',
        roomCode,
        roomGeneration,
      );
    } catch {
      return json({ error: 'PRO_ROOM_AUDIT_UNAVAILABLE' }, 503);
    }
    return suspended
      ? json({ error: 'OWNER_TRANSFER_TARGET_UNAVAILABLE' }, 409)
      : json({ error: 'PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED' }, 503);
  };

  // The target can start deletion while the commit is crossing the Worker
  // boundary. If the DO already accepted ownership, immediately project the
  // exact incarnation back to owner-deleted suspension before any active
  // registry write can make it look usable.
  let postCommitTarget;
  try {
    postCommitTarget = await readActiveOwnerTransferTarget(env, targetAccountId);
  } catch {
    await auditSystemOwnerTransfer(
      env,
      'owner_transfer.commit',
      'reconcile_required',
      roomCode,
      roomGeneration,
    ).catch(() => {});
    return json({ error: 'ACCOUNT_STORE_UNAVAILABLE' }, 503);
  }
  if (!postCommitTarget) {
    return abortCommittedTransferForMissingTarget('target_deleted_after_commit');
  }

  // Do not release the deterministic owner/session cookies until every D1
  // projection, cleanup edge, authority fence and final audit confirms the
  // completed ownership boundary.
  try {
    const updated = await markAdminProRoomOperationalState(
      adminDb,
      roomCode,
      roomGeneration,
      'active',
      null,
    );
    if (!updated) return json({ error: 'PRO_ROOM_STATE_CONFLICT' }, 409);
    if (!(await advanceOwnerTransferSagaState(adminDb, transferSaga, 'registry_active'))) {
      return json({ error: 'PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED' }, 503);
    }
  } catch {
    await auditSystemOwnerTransfer(
      env,
      'owner_transfer.commit',
      'reconcile_required',
      roomCode,
      roomGeneration,
    ).catch(() => {});
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }

  const previousOwnerAccountId = preparePayload.previousOwnerAccountId;
  if (previousOwnerAccountId && previousOwnerAccountId !== targetAccountId) {
    try {
      if (
        !(await retireAccountProRoomLinkForAccount(
          env,
          previousOwnerAccountId,
          roomCode,
          roomGeneration,
        ))
      ) {
        await auditSystemOwnerTransfer(
          env,
          'owner_transfer.commit',
          'reconcile_required',
          roomCode,
          roomGeneration,
        ).catch(() => {});
        return json({ error: 'ACCOUNT_STORE_UNAVAILABLE' }, 503);
      }
    } catch {
      await auditSystemOwnerTransfer(
        env,
        'owner_transfer.commit',
        'reconcile_required',
        roomCode,
        roomGeneration,
      ).catch(() => {});
      return json({ error: 'ACCOUNT_STORE_UNAVAILABLE' }, 503);
    }
  }
  try {
    if (!(await advanceOwnerTransferSagaState(adminDb, transferSaga, 'old_owner_edge_retired'))) {
      return json({ error: 'PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED' }, 503);
    }
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }

  // This is the last point at which the transfer saga may project the room as
  // active. Recheck both account authority and the canonical DO after that
  // write. A deletion purge that won before the write is repaired here; one
  // that begins later has no subsequent transfer write that can overwrite it.
  let finalTarget;
  try {
    finalTarget = await readActiveOwnerTransferTarget(env, targetAccountId);
  } catch {
    await auditSystemOwnerTransfer(
      env,
      'owner_transfer.commit',
      'reconcile_required',
      roomCode,
      roomGeneration,
    ).catch(() => {});
    return json({ error: 'ACCOUNT_STORE_UNAVAILABLE' }, 503);
  }
  if (!finalTarget) {
    return abortCommittedTransferForMissingTarget('target_deleted_during_finalize');
  }

  let finalRoom;
  let finalCanonicalStatus;
  try {
    finalRoom = await readAdminProRoom(adminDb, roomCode);
    if (!finalRoom || finalRoom.roomGeneration !== roomGeneration) {
      return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
    }
    finalCanonicalStatus = await reconcileAdminProRoomStatus(env, adminDb, finalRoom);
    finalRoom = await readAdminProRoom(adminDb, roomCode);
  } catch {
    await auditSystemOwnerTransfer(
      env,
      'owner_transfer.commit',
      'reconcile_required',
      roomCode,
      roomGeneration,
    ).catch(() => {});
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (
    finalCanonicalStatus !== 'active' ||
    !finalRoom ||
    finalRoom.roomGeneration !== roomGeneration ||
    finalRoom.status !== 'registered' ||
    finalRoom.suspensionReason !== null ||
    finalRoom.activationState !== 'active'
  ) {
    await auditSystemOwnerTransfer(
      env,
      'owner_transfer.commit',
      'reconcile_required',
      roomCode,
      roomGeneration,
    ).catch(() => {});
    return json({ error: 'PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED' }, 503);
  }
  if (
    !(await finalizeProRoomOwnershipTransferEntitlement(env, {
      targetAccountId,
      roomCode,
      roomGeneration,
      requestId,
    }).catch(() => false))
  ) {
    await auditSystemOwnerTransfer(
      env,
      'owner_transfer.commit',
      'entitlement_reconcile_required',
      roomCode,
      roomGeneration,
    ).catch(() => {});
    return json({ error: 'PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED' }, 503);
  }
  try {
    if (!(await advanceOwnerTransferSagaState(adminDb, transferSaga, 'verified'))) {
      return json({ error: 'PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED' }, 503);
    }
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  try {
    if (!(await clearDeveloperApiAuthorityFence(env, roomCode, roomGeneration, fenceDigest))) {
      await auditSystemOwnerTransfer(
        env,
        'owner_transfer.commit',
        'reconcile_required',
        roomCode,
        roomGeneration,
      ).catch(() => {});
      return json({ error: 'DEVELOPER_API_ADMIN_UNAVAILABLE' }, 503);
    }
  } catch {
    await auditSystemOwnerTransfer(
      env,
      'owner_transfer.commit',
      'reconcile_required',
      roomCode,
      roomGeneration,
    ).catch(() => {});
    return json({ error: 'DEVELOPER_API_ADMIN_UNAVAILABLE' }, 503);
  }
  try {
    await auditSystemOwnerTransfer(
      env,
      'owner_transfer.commit',
      'success',
      roomCode,
      roomGeneration,
    );
  } catch {
    return json({ error: 'PRO_ROOM_AUDIT_UNAVAILABLE' }, 503);
  }
  try {
    if (!(await advanceOwnerTransferSagaState(adminDb, transferSaga, 'complete'))) {
      return json({ error: 'PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED' }, 503);
    }
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }

  const publicResponse = json({ snapshot: committed.payload.snapshot });
  const publicHeaders = new Headers(publicResponse.headers);
  for (const cookie of splitSetCookieHeader(committed.response.headers)) {
    publicHeaders.append('Set-Cookie', cookie);
  }
  return withFacadeProRoomCookies(
    new Response(publicResponse.body, { status: 200, headers: publicHeaders }),
    roomCode,
  );
}

async function handleAdminDeveloperApiKeys(request: Request, env: AppEnv, pathname: string) {
  const route = pathname.match(ADMIN_DEVELOPER_API_KEY_PATH_RE);
  if (!route) return json({ error: 'NOT_FOUND' }, 404);
  const roomCode = route[1];
  if (!roomCode) return json({ error: 'NOT_FOUND' }, 404);
  const keyId = route[2] || '';
  const methodError = adminApiMethodAllowed(request, keyId ? ['DELETE'] : ['GET', 'HEAD', 'POST']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const adminDb = getAdminDb(env);
  const developerDb = getDeveloperApiAdminDb(env);
  if (!adminDb?.prepare || !developerDb) {
    return json({ error: 'DEVELOPER_API_ADMIN_NOT_CONFIGURED' }, 503);
  }

  let room;
  try {
    room = await readAdminProRoom(adminDb, roomCode);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (!room) return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
  if (room.status === 'decommissioning' || room.status === 'decommissioned') {
    return json({ error: 'PRO_ROOM_PERMANENTLY_DECOMMISSIONED' }, 410);
  }

  const nowMs = Date.now();
  try {
    await cleanupExpiredAdminDeveloperApiKeys(developerDb, roomCode, room.roomGeneration, nowMs);
  } catch {
    return json({ error: 'DEVELOPER_API_ADMIN_UNAVAILABLE' }, 503);
  }

  if (!keyId && (request.method === 'GET' || request.method === 'HEAD')) {
    try {
      if (request.method === 'HEAD') {
        return withSecurityHeaders(new Response(null, { status: 200 }), {
          'Cache-Control': 'no-store, max-age=0',
        });
      }
      const keys = await listAdminDeveloperApiKeys(
        developerDb,
        roomCode,
        room.roomGeneration,
        nowMs,
      );
      return json(adminDeveloperApiKeyListPayload(roomCode, room.roomGeneration, keys));
    } catch {
      return json({ error: 'DEVELOPER_API_ADMIN_UNAVAILABLE' }, 503);
    }
  }

  if (!keyId) {
    if (!developerApiAdminPepper(env)) {
      return json({ error: 'DEVELOPER_API_ADMIN_NOT_CONFIGURED' }, 503);
    }
    const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
    if (parsedBody.error) return jsonBodyError(parsedBody);
    const issue = parseAdminDeveloperApiKeyIssueBody(parsedBody.value);
    if (!issue) return json({ error: 'INVALID_REQUEST' }, 400);
    if (issue.roomGeneration !== room.roomGeneration) {
      return json({ error: 'PRO_ROOM_GENERATION_CONFLICT' }, 409);
    }

    const { keyId: newKeyId, secret } = await deriveAdminDeveloperApiKeyMaterial(
      env,
      roomCode,
      room.roomGeneration,
      issue.requestId,
    );
    if (
      !ADMIN_DEVELOPER_API_KEY_ID_RE.test(newKeyId) ||
      !ADMIN_DEVELOPER_API_KEY_SECRET_RE.test(secret)
    ) {
      return json({ error: 'DEVELOPER_API_KEY_GENERATION_FAILED' }, 503);
    }
    const digest = await hmacSha256(
      developerApiAdminPepper(env),
      `mxqr-developer-api-key:v1\u0000${newKeyId}\u0000${secret}`,
    );
    const actorId = await adminDeveloperApiAuditActor(request, env);
    let replayed;
    try {
      replayed = await readAdminDeveloperApiKey(
        developerDb,
        roomCode,
        room.roomGeneration,
        newKeyId,
      );
    } catch {
      return json({ error: 'DEVELOPER_API_ADMIN_UNAVAILABLE' }, 503);
    }
    if (replayed) {
      const replayedKey = recoverAdminDeveloperApiKeyReplay(
        replayed,
        issue,
        digest,
        nowMs,
        room.roomGeneration,
      );
      if (!replayedKey) {
        return json({ error: 'DEVELOPER_API_IDEMPOTENCY_CONFLICT' }, 409);
      }
      const replayAuthority = await verifyAdminDeveloperApiKeyAuthority(
        env,
        developerDb,
        replayed,
        roomCode,
        room.roomGeneration,
      );
      if (replayAuthority !== 'valid') {
        if (replayAuthority === 'changed') {
          try {
            await removeDeveloperApiKeyAfterAuthorityChange(developerDb, {
              actorId,
              keyId: newKeyId,
              roomCode,
              roomGeneration: room.roomGeneration,
              authorityEpoch: replayed.authority_epoch,
              digest,
              result: 'authority_changed',
            });
          } catch {
            return json({ error: 'DEVELOPER_API_ADMIN_UNAVAILABLE' }, 503);
          }
        }
        return replayAuthority === 'unavailable'
          ? json({ error: 'PRO_ROOM_ADMIN_UNAVAILABLE' }, 502)
          : json(
              {
                error:
                  replayAuthority === 'inactive'
                    ? 'PRO_ROOM_NOT_READY'
                    : 'DEVELOPER_API_AUTHORITY_CHANGED',
              },
              409,
            );
      }
      return json({
        roomCode,
        roomGeneration: room.roomGeneration,
        apiKey: `mxqr_live_${newKeyId}.${secret}`,
        key: replayedKey,
      });
    }

    const canonicalStatus = await reconcileAdminProRoomStatus(env, adminDb, room).catch(() => null);
    if (!canonicalStatus) {
      return json({ error: 'PRO_ROOM_ADMIN_UNAVAILABLE' }, 502);
    }
    if (canonicalStatus !== 'active') {
      return json(
        {
          error: canonicalStatus === 'suspended' ? 'PRO_ROOM_SUSPENDED' : 'PRO_ROOM_NOT_READY',
        },
        409,
      );
    }

    const canonicalAuthority = await readActiveProRoomDeveloperAuthority(
      env,
      roomCode,
      room.roomGeneration,
    ).catch(() => ({ state: 'unavailable', epoch: null }));
    if (canonicalAuthority.state === 'unavailable' || canonicalAuthority.state === 'invalid') {
      return json({ error: 'PRO_ROOM_ADMIN_UNAVAILABLE' }, 502);
    }
    if (canonicalAuthority.state !== 'active') {
      return json({ error: 'PRO_ROOM_NOT_READY' }, 409);
    }
    const authorityEpoch = canonicalAuthority.epoch;

    const expiresAt = nowMs + issue.days * ADMIN_DEVELOPER_API_DAY_MS;
    const mutation = developerDb
      .prepare(
        `INSERT INTO mxqr_developer_api_keys
          (key_id, room_code, room_generation, authority_epoch, label, secret_digest,
           digest_version, scope_mask, status, created_at, updated_at,
           expires_at, revoked_at, last_used_hour)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, 'active', ?8, ?8, ?9, NULL, NULL
          WHERE NOT EXISTS (
            SELECT 1 FROM mxqr_developer_api_room_authority_fences AS fence
             WHERE fence.room_code = ?2 AND fence.room_generation = ?3
               AND fence.status = 'active'
          )`,
      )
      .bind(
        newKeyId,
        roomCode,
        room.roomGeneration,
        authorityEpoch,
        issue.label,
        digest,
        issue.scopeMask,
        nowMs,
        expiresAt,
      );
    const audit = developerDb
      .prepare(
        `INSERT INTO mxqr_developer_api_admin_audit
          (actor_id, action, result, key_id, room_code, room_generation, created_at)
         SELECT ?1, 'key.issue', 'issued', key.key_id, key.room_code,
                key.room_generation, ?7
           FROM mxqr_developer_api_keys AS key
          WHERE key.key_id = ?2 AND key.room_code = ?3 AND key.room_generation = ?4
            AND key.secret_digest = ?5 AND key.status = 'active'
            AND key.created_at = ?6 AND key.authority_epoch = ?8`,
      )
      .bind(actorId, newKeyId, roomCode, room.roomGeneration, digest, nowMs, nowMs, authorityEpoch);
    try {
      await runDeveloperApiAdminMutation(developerDb, mutation, audit, async () => {
        await developerDb
          .prepare(
            `DELETE FROM mxqr_developer_api_keys
             WHERE key_id = ?1 AND room_code = ?2 AND room_generation = ?3
               AND secret_digest = ?4`,
          )
          .bind(newKeyId, roomCode, room.roomGeneration, digest)
          .run();
      });

      const postIssueAuthority = await verifyAdminDeveloperApiKeyAuthority(
        env,
        developerDb,
        { authority_epoch: authorityEpoch },
        roomCode,
        room.roomGeneration,
      );
      if (postIssueAuthority !== 'valid') {
        await removeDeveloperApiKeyAfterAuthorityChange(developerDb, {
          actorId,
          keyId: newKeyId,
          roomCode,
          roomGeneration: room.roomGeneration,
          authorityEpoch,
          digest,
          result:
            postIssueAuthority === 'unavailable'
              ? 'authority_recheck_unavailable'
              : 'authority_changed',
        });
        return postIssueAuthority === 'unavailable'
          ? json({ error: 'PRO_ROOM_ADMIN_UNAVAILABLE' }, 502)
          : json({ error: 'DEVELOPER_API_AUTHORITY_CHANGED' }, 409);
      }
    } catch (error) {
      try {
        const concurrent = await readAdminDeveloperApiKey(
          developerDb,
          roomCode,
          room.roomGeneration,
          newKeyId,
        );
        if (concurrent) {
          const concurrentKey = recoverAdminDeveloperApiKeyReplay(
            concurrent,
            issue,
            digest,
            Date.now(),
            room.roomGeneration,
          );
          if (!concurrentKey) {
            return json({ error: 'DEVELOPER_API_IDEMPOTENCY_CONFLICT' }, 409);
          }
          const concurrentAuthority = await verifyAdminDeveloperApiKeyAuthority(
            env,
            developerDb,
            concurrent,
            roomCode,
            room.roomGeneration,
          );
          if (concurrentAuthority !== 'valid') {
            if (concurrentAuthority === 'changed') {
              await removeDeveloperApiKeyAfterAuthorityChange(developerDb, {
                actorId,
                keyId: newKeyId,
                roomCode,
                roomGeneration: room.roomGeneration,
                authorityEpoch: concurrent.authority_epoch,
                digest,
                result: 'authority_changed',
              });
            }
            return concurrentAuthority === 'unavailable'
              ? json({ error: 'PRO_ROOM_ADMIN_UNAVAILABLE' }, 502)
              : json(
                  {
                    error:
                      concurrentAuthority === 'inactive'
                        ? 'PRO_ROOM_NOT_READY'
                        : 'DEVELOPER_API_AUTHORITY_CHANGED',
                  },
                  409,
                );
          }
          return json({
            roomCode,
            roomGeneration: room.roomGeneration,
            apiKey: `mxqr_live_${newKeyId}.${secret}`,
            key: concurrentKey,
          });
        }
      } catch {
        // Fall through to the original mutation failure classification.
      }
      if (isDeveloperApiActiveKeyLimitError(error)) {
        return json({ error: 'DEVELOPER_API_ACTIVE_KEY_LIMIT' }, 409);
      }
      try {
        const fenceStatement = developerDb
          .prepare(
            `SELECT status
               FROM mxqr_developer_api_room_authority_fences
              WHERE room_code = ?1 AND room_generation = ?2
              LIMIT 1`,
          )
          .bind(roomCode, room.roomGeneration);
        const fence =
          typeof fenceStatement.first === 'function'
            ? await fenceStatement.first()
            : (await fenceStatement.all())?.results?.[0] || null;
        if (fence?.status === 'active') {
          return json({ error: 'DEVELOPER_API_AUTHORITY_FENCED' }, 409);
        }
      } catch {
        // Preserve the original fail-closed availability classification.
      }
      return json(
        {
          error: isDeveloperApiAuditError(error)
            ? 'DEVELOPER_API_AUDIT_UNAVAILABLE'
            : 'DEVELOPER_API_ADMIN_UNAVAILABLE',
        },
        503,
      );
    }

    const key = normalizeAdminDeveloperApiKeyRow(
      {
        key_id: newKeyId,
        room_code: roomCode,
        room_generation: room.roomGeneration,
        authority_epoch: authorityEpoch,
        label: issue.label,
        scope_mask: issue.scopeMask,
        status: 'active',
        created_at: nowMs,
        updated_at: nowMs,
        expires_at: expiresAt,
        revoked_at: null,
        last_used_hour: null,
      },
      nowMs,
      room.roomGeneration,
    );
    return json(
      {
        roomCode,
        roomGeneration: room.roomGeneration,
        apiKey: `mxqr_live_${newKeyId}.${secret}`,
        key,
      },
      201,
    );
  }

  const parsedDeleteBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedDeleteBody.error) return jsonBodyError(parsedDeleteBody);
  if (
    !isJsonObject(parsedDeleteBody.value) ||
    Object.keys(parsedDeleteBody.value).length !== 1 ||
    !isProRoomGeneration(parsedDeleteBody.value.roomGeneration)
  ) {
    return json({ error: 'INVALID_REQUEST' }, 400);
  }
  if (parsedDeleteBody.value.roomGeneration !== room.roomGeneration) {
    return json({ error: 'PRO_ROOM_GENERATION_CONFLICT' }, 409);
  }

  let existing;
  try {
    existing = await readAdminDeveloperApiKey(developerDb, roomCode, room.roomGeneration, keyId);
  } catch {
    return json({ error: 'DEVELOPER_API_ADMIN_UNAVAILABLE' }, 503);
  }
  if (!existing) return json({ error: 'DEVELOPER_API_KEY_NOT_FOUND' }, 404);
  if (existing.status !== 'active' || Number(existing.expires_at) <= nowMs) {
    return json({
      ok: true,
      roomCode,
      roomGeneration: room.roomGeneration,
      keyId,
    });
  }

  const mutation = developerDb
    .prepare(
      `UPDATE mxqr_developer_api_keys
       SET status = 'revoked', revoked_at = ?4, updated_at = ?4
       WHERE room_code = ?1 AND room_generation = ?2 AND key_id = ?3
         AND status = 'active' AND expires_at > ?4`,
    )
    .bind(roomCode, room.roomGeneration, keyId, nowMs);
  const actorId = await adminDeveloperApiAuditActor(request, env);
  const audit = developerApiAdminAuditStatement(
    developerDb,
    actorId,
    'key.revoke',
    'revoked',
    keyId,
    roomCode,
    room.roomGeneration,
    nowMs,
    { ignoreDuplicate: true },
  );
  try {
    await runDeveloperApiAdminMutation(developerDb, mutation, audit, async () => {
      await developerDb
        .prepare(
          `UPDATE mxqr_developer_api_keys
           SET status = 'active', revoked_at = NULL, updated_at = ?4
           WHERE room_code = ?1 AND room_generation = ?2 AND key_id = ?3
             AND status = 'revoked' AND revoked_at = ?4`,
        )
        .bind(roomCode, room.roomGeneration, keyId, nowMs)
        .run();
    });
  } catch (error) {
    try {
      const current = await readAdminDeveloperApiKey(
        developerDb,
        roomCode,
        room.roomGeneration,
        keyId,
      );
      if (current && (current.status !== 'active' || Number(current.expires_at) <= nowMs)) {
        return json({
          ok: true,
          roomCode,
          roomGeneration: room.roomGeneration,
          keyId,
        });
      }
    } catch {
      // Preserve the original failure below when reconciliation is unavailable.
    }
    return json(
      {
        error: isDeveloperApiAuditError(error)
          ? 'DEVELOPER_API_AUDIT_UNAVAILABLE'
          : 'DEVELOPER_API_ADMIN_UNAVAILABLE',
      },
      503,
    );
  }
  return json({
    ok: true,
    roomCode,
    roomGeneration: room.roomGeneration,
    keyId,
  });
}

async function handleAdminProRooms(request: Request, env: AppEnv, pathname: string) {
  const route = pathname.match(ADMIN_PRO_ROOM_PATH_RE);
  if (!route) return json({ error: 'NOT_FOUND' }, 404);
  const activationClaimRoomCode = route[1] || '';
  const allowedMethods = activationClaimRoomCode ? ['POST'] : ['GET', 'HEAD', 'POST'];
  const methodError = adminApiMethodAllowed(request, allowedMethods);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const db = getAdminDb(env);
  if (!db?.prepare || !getProRoomAdminNamespace(env)) {
    return json({ error: 'PRO_ROOM_ADMIN_NOT_CONFIGURED' }, 503);
  }

  if (!activationClaimRoomCode && (request.method === 'GET' || request.method === 'HEAD')) {
    try {
      if (request.method === 'GET') {
        await reconcileOwnerTransferSagas(env, db).catch((error) => {
          console.warn('[PRO owner transfer] admin-list reconciliation failed', error);
        });
      }
      let rooms = await listAdminProRooms(db);
      // HEAD is a non-mutating availability probe. Only an operator's full
      // list read may repair the D1 projection from canonical room state.
      if (
        request.method === 'GET' &&
        (await reconcileStaleAdminProRoomActivations(env, db, rooms))
      ) {
        rooms = await listAdminProRooms(db);
      }
      if (request.method === 'HEAD') {
        return withSecurityHeaders(new Response(null, { status: 200 }), {
          'Cache-Control': 'no-store, max-age=0',
        });
      }
      rooms = await attachCanonicalAdminProRoomOwnerState(env, db, rooms);
      return json({ generatedAt: new Date().toISOString(), rooms });
    } catch {
      return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
    }
  }

  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody);
  const body = parsedBody.value;

  if (activationClaimRoomCode && !(await verifyCanonicalOwnerEntitlementBackfill(env, db))) {
    return json({ error: 'PRO_GRANT_OWNER_BACKFILL_REQUIRED' }, 503);
  }

  if (!activationClaimRoomCode) {
    const keys = isJsonObject(body) ? Object.keys(body) : [];
    if (
      !isJsonObject(body) ||
      !keys.includes('roomCode') ||
      keys.some((key: string) => key !== 'roomCode' && key !== 'label')
    ) {
      return json({ error: 'INVALID_REQUEST' }, 400);
    }
    const roomCode = typeof body.roomCode === 'string' ? body.roomCode : '';
    const rawLabel = body.label === undefined ? `PRO Room ${roomCode}` : body.label;
    const label = normalizeAdminProRoomLabel(rawLabel);
    if (!ADMIN_PRO_ROOM_CODE_RE.test(roomCode) || !label) {
      return json({ error: 'INVALID_PRO_ROOM' }, 400);
    }

    try {
      const registered = await registerAdminProRoom(db, roomCode, label);
      if (registered.generationCutoverNotReady) {
        const auditError = await writeAdminProRoomAuditOrFail(
          db,
          request,
          env,
          'room.register',
          'generation_cutover_not_ready',
          roomCode,
          registered.room?.roomGeneration ?? INITIAL_PRO_ROOM_GENERATION,
        );
        if (auditError) return auditError;
        return json({ error: 'PRO_ROOM_GENERATION_CUTOVER_NOT_READY' }, 503);
      }
      if (registered.repairRequired) {
        const auditError = await writeAdminProRoomAuditOrFail(
          db,
          request,
          env,
          'room.register',
          'registry_repair_required',
          roomCode,
          registered.room?.roomGeneration ?? INITIAL_PRO_ROOM_GENERATION,
        );
        if (auditError) return auditError;
        return json({ error: 'PRO_ROOM_REGISTRY_REPAIR_REQUIRED' }, 409);
      }
      if (registered.capacityExceeded) {
        const auditError = await writeAdminProRoomAuditOrFail(
          db,
          request,
          env,
          'room.register',
          'registry_capacity_reached',
          roomCode,
          registered.room?.roomGeneration ?? INITIAL_PRO_ROOM_GENERATION,
        );
        if (auditError) return auditError;
        return json({ error: 'PRO_ROOM_REGISTRY_CAPACITY_REACHED' }, 409);
      }
      if (registered.generationExhausted) {
        return json({ error: 'PRO_ROOM_GENERATION_EXHAUSTED' }, 409);
      }
      if (registered.room?.status === 'decommissioning') {
        return json({ error: 'PRO_ROOM_DECOMMISSION_IN_PROGRESS' }, 409);
      }
      if (!registered.room || registered.room.status === 'decommissioned') {
        return json({ error: 'PRO_ROOM_REGISTRATION_CONFLICT' }, 409);
      }
      const previousStatus = registered.room?.status || 'provisioning';
      const roomGeneration = registered.room.roomGeneration;
      const provisioned = await callProRoomAdminObject(
        env,
        roomCode,
        roomGeneration,
        '/internal/admin/provision',
      );
      const provisionPayload = provisioned.payload;
      if (
        !provisioned.response?.ok ||
        !proRoomAdminResponseIdentityMatches(provisionPayload, roomCode, roomGeneration) ||
        provisionPayload.ok !== true ||
        typeof provisionPayload.status !== 'string' ||
        !['unactivated', 'active', 'suspended'].includes(provisionPayload.status)
      ) {
        const auditError = await writeAdminProRoomAuditOrFail(
          db,
          request,
          env,
          'room.register',
          'provision_failed',
          roomCode,
          roomGeneration,
        );
        if (auditError) return auditError;
        return provisioned.response?.ok
          ? json({ error: 'PRO_ROOM_ADMIN_INVALID_RESPONSE' }, 502)
          : proRoomObjectError(provisioned);
      }
      await markAdminProRoomRegistered(db, roomCode, roomGeneration, provisionPayload.status);
      const room = (await readAdminProRoom(db, roomCode)) || registered.room;
      if (
        room.roomGeneration !== roomGeneration ||
        room.status === 'decommissioning' ||
        room.status === 'decommissioned'
      ) {
        return json({ error: 'PRO_ROOM_REGISTRATION_CONFLICT' }, 409);
      }
      const auditError = await writeAdminProRoomAuditOrFail(
        db,
        request,
        env,
        'room.register',
        registered.created
          ? registered.reused
            ? 'recreated'
            : 'created'
          : previousStatus === 'provisioning'
            ? 'provisioning_recovered'
            : 'already_registered',
        roomCode,
        roomGeneration,
      );
      if (auditError) return auditError;
      return json({ room }, registered.created ? 201 : 200);
    } catch {
      return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
    }
  }

  if (
    !isJsonObject(body) ||
    Object.keys(body).length !== 1 ||
    !isProRoomGeneration(body.roomGeneration)
  ) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'activation_claim.issue',
      'invalid_request',
      activationClaimRoomCode,
      isJsonObject(body) && isProRoomGeneration(body.roomGeneration)
        ? body.roomGeneration
        : INITIAL_PRO_ROOM_GENERATION,
    );
    if (auditError) return auditError;
    return json({ error: 'INVALID_REQUEST' }, 400);
  }
  let room;
  try {
    room = await readAdminProRoom(db, activationClaimRoomCode);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (!room) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'activation_claim.issue',
      'room_not_found',
      activationClaimRoomCode,
      body.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
  }
  if (room.roomGeneration !== body.roomGeneration) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'activation_claim.issue',
      'generation_mismatch',
      activationClaimRoomCode,
      body.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
  }
  if (room.status === 'decommissioning' || room.status === 'decommissioned') {
    return json({ error: 'PRO_ROOM_PERMANENTLY_DECOMMISSIONED' }, 410);
  }
  if (room.status === 'provisioning') {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'activation_claim.issue',
      'provisioning_incomplete',
      activationClaimRoomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_PROVISIONING_INCOMPLETE' }, 409);
  }
  if (room.status !== 'registered') {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'activation_claim.issue',
      'room_suspended',
      activationClaimRoomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
  }
  if (await hasReservedProGrantAllocation(env, activationClaimRoomCode, room.roomGeneration)) {
    return json({ error: 'PRO_GRANT_ALLOCATION_RESERVED' }, 409);
  }

  const issued = await callProRoomAdminObject(
    env,
    activationClaimRoomCode,
    room.roomGeneration,
    '/internal/admin/activation-claim',
  );
  if (!issued.response?.ok) {
    await reconcileAdminProRoomStatus(env, db, room).catch(() => {});
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'activation_claim.issue',
      issued.response ? 'service_rejected' : 'service_unavailable',
      activationClaimRoomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return proRoomObjectError(issued);
  }
  if (!isValidAdminActivationLink(issued.payload, activationClaimRoomCode, room.roomGeneration)) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'activation_claim.issue',
      'invalid_service_response',
      activationClaimRoomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_ADMIN_INVALID_RESPONSE' }, 502);
  }
  const auditError = await writeAdminProRoomAuditOrFail(
    db,
    request,
    env,
    'activation_claim.issue',
    'issued',
    activationClaimRoomCode,
    room.roomGeneration,
  );
  // The DO has already rotated and persisted the claim generation. If D1
  // auditing fails, discard this credential; the next retry rotates again so
  // no unaudited link can subsequently be used.
  if (auditError) return auditError;
  return json({
    ...issued.payload,
    roomCode: activationClaimRoomCode,
    roomGeneration: room.roomGeneration,
  });
}

async function handleAdminProRoomOwnerRecoveryClaim(
  request: Request,
  env: AppEnv,
  pathname: string,
) {
  const route = pathname.match(ADMIN_PRO_ROOM_OWNER_RECOVERY_PATH_RE);
  if (!route) return json({ error: 'NOT_FOUND' }, 404);
  const roomCode = route[1];
  if (!roomCode) return json({ error: 'NOT_FOUND' }, 404);
  const methodError = adminApiMethodAllowed(request, ['POST']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const db = getAdminDb(env);
  if (!db?.prepare || !getProRoomAdminNamespace(env)) {
    return json({ error: 'PRO_ROOM_ADMIN_NOT_CONFIGURED' }, 503);
  }

  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody);
  const body = parsedBody.value;
  if (
    !isJsonObject(body) ||
    Object.keys(body).length !== 1 ||
    !isProRoomGeneration(body.roomGeneration)
  ) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_recovery_claim.issue',
      'invalid_request',
      roomCode,
      isJsonObject(body) && isProRoomGeneration(body.roomGeneration)
        ? body.roomGeneration
        : INITIAL_PRO_ROOM_GENERATION,
    );
    if (auditError) return auditError;
    return json({ error: 'INVALID_REQUEST' }, 400);
  }

  let room;
  try {
    room = await readAdminProRoom(db, roomCode);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (!room) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_recovery_claim.issue',
      'room_not_found',
      roomCode,
      body.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
  }
  if (room.roomGeneration !== body.roomGeneration) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_recovery_claim.issue',
      'generation_mismatch',
      roomCode,
      body.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
  }
  if (room.status === 'decommissioning' || room.status === 'decommissioned') {
    return json({ error: 'PRO_ROOM_PERMANENTLY_DECOMMISSIONED' }, 410);
  }
  if (
    room.status === 'registered' &&
    room.activationState !== 'active' &&
    (await reconcileAdminProRoomStatus(env, db, room).catch(() => null)) === 'active'
  ) {
    room = (await readAdminProRoom(db, roomCode).catch(() => null)) || room;
  }
  if (room.status !== 'registered' || room.activationState !== 'active') {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_recovery_claim.issue',
      room.status === 'suspended' ? 'room_suspended' : 'room_not_active',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_OWNER_RECOVERY_UNAVAILABLE' }, 409);
  }

  const issued = await callProRoomAdminObject(
    env,
    roomCode,
    room.roomGeneration,
    '/internal/admin/owner-recovery-claim',
  );
  if (!issued.response?.ok) {
    await reconcileAdminProRoomStatus(env, db, room).catch(() => {});
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_recovery_claim.issue',
      issued.response ? 'service_rejected' : 'service_unavailable',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return proRoomObjectError(issued);
  }
  if (!isValidAdminOwnerRecoveryLink(issued.payload, roomCode, room.roomGeneration)) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_recovery_claim.issue',
      'invalid_service_response',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_ADMIN_INVALID_RESPONSE' }, 502);
  }
  const currentRoom = await readAdminProRoom(db, roomCode).catch(() => null);
  if (
    !currentRoom ||
    currentRoom.roomGeneration !== room.roomGeneration ||
    currentRoom.status !== 'registered' ||
    currentRoom.activationState !== 'active'
  ) {
    const staleAuditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_recovery_claim.issue',
      'registry_changed',
      roomCode,
      room.roomGeneration,
    );
    if (staleAuditError) return staleAuditError;
    return json({ error: 'PRO_ROOM_OWNER_RECOVERY_UNAVAILABLE' }, 409);
  }
  const auditError = await writeAdminProRoomAuditOrFail(
    db,
    request,
    env,
    'owner_recovery_claim.issue',
    'issued',
    roomCode,
    room.roomGeneration,
  );
  // Recovery URLs are bearer credentials. If the audit write cannot be
  // confirmed, discard the response and never expose the URL to the browser.
  if (auditError) return auditError;
  return json({
    roomCode,
    roomGeneration: room.roomGeneration,
    recoveryUrl: issued.payload.recoveryUrl,
    expiresAt: issued.payload.expiresAt,
    ownerAccountLinked: issued.payload.ownerAccountLinked,
  });
}

async function handleAdminProRoomOwnerTransferClaim(
  request: Request,
  env: AppEnv,
  pathname: string,
) {
  const route = pathname.match(ADMIN_PRO_ROOM_OWNER_TRANSFER_PATH_RE);
  if (!route) return json({ error: 'NOT_FOUND' }, 404);
  const roomCode = route[1];
  if (!roomCode) return json({ error: 'NOT_FOUND' }, 404);
  const methodError = adminApiMethodAllowed(request, ['POST']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const db = getAdminDb(env);
  if (!db?.prepare || !getProRoomAdminNamespace(env) || !env.MUSIXQUARE_AUTH_DB?.prepare) {
    return json({ error: 'PRO_ROOM_OWNER_TRANSFER_NOT_CONFIGURED' }, 503);
  }
  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_transfer_claim.issue',
      'invalid_json',
      roomCode,
      INITIAL_PRO_ROOM_GENERATION,
    );
    if (auditError) return auditError;
    return jsonBodyError(parsedBody);
  }
  const body = parsedBody.value;
  const auditGeneration =
    isJsonObject(body) && isProRoomGeneration(body.roomGeneration)
      ? body.roomGeneration
      : INITIAL_PRO_ROOM_GENERATION;
  if (
    !isJsonObject(body) ||
    Object.keys(body).length !== 2 ||
    !Object.hasOwn(body, 'roomGeneration') ||
    !Object.hasOwn(body, 'targetAccount') ||
    !isProRoomGeneration(body.roomGeneration) ||
    typeof body.targetAccount !== 'string' ||
    body.targetAccount !== body.targetAccount.trim() ||
    body.targetAccount.length < 1 ||
    body.targetAccount.length > 128
  ) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_transfer_claim.issue',
      'invalid_request',
      roomCode,
      auditGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'INVALID_REQUEST' }, 400);
  }
  if (!(await verifyCanonicalOwnerEntitlementBackfill(env, db))) {
    return json({ error: 'PRO_GRANT_OWNER_BACKFILL_REQUIRED' }, 503);
  }

  let room;
  try {
    room = await readAdminProRoom(db, roomCode);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (!room) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_transfer_claim.issue',
      'room_not_found',
      roomCode,
      body.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
  }
  if (room.roomGeneration !== body.roomGeneration) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_transfer_claim.issue',
      'generation_mismatch',
      roomCode,
      body.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
  }
  if (room.status === 'decommissioning' || room.status === 'decommissioned') {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_transfer_claim.issue',
      'permanently_decommissioned',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_PERMANENTLY_DECOMMISSIONED' }, 410);
  }
  if (
    ((room.status === 'registered' && room.activationState !== 'active') ||
      room.status === 'suspended') &&
    (await reconcileAdminProRoomStatus(env, db, room).catch(() => null))
  ) {
    room = (await readAdminProRoom(db, roomCode).catch(() => null)) || room;
  }
  const transferIssuable =
    room.activationState === 'active' &&
    (room.status === 'registered' ||
      (room.status === 'suspended' &&
        room.suspensionReason !== null &&
        ['owner_account_deleted', 'ownership_transfer_pending'].includes(room.suspensionReason)));
  if (!transferIssuable) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_transfer_claim.issue',
      room.status === 'suspended' && room.suspensionReason === 'operator_suspended'
        ? 'operator_suspended'
        : 'room_not_active',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json(
      {
        error: 'PRO_ROOM_OWNER_TRANSFER_UNAVAILABLE',
      },
      409,
    );
  }
  let target;
  try {
    target = await resolveActiveOwnerTransferTarget(env, body.targetAccount);
  } catch {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_transfer_claim.issue',
      'target_store_unavailable',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'ACCOUNT_STORE_UNAVAILABLE' }, 503);
  }
  if (!target) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_transfer_claim.issue',
      'target_unavailable',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'OWNER_TRANSFER_TARGET_UNAVAILABLE' }, 409);
  }

  // The Admin-D1 entitlement ledger is the sole one-current-PRO policy
  // authority. Auth-D1 room links are conservative account-deletion cleanup
  // edges and include ordinary signed-in guests, so they must never be used
  // as evidence that the account owns a PRO room.
  const targetGrantAuthorized = await canAccountReceiveProRoomEntitlement(env, {
    accountId: target.accountId,
  });
  if (!targetGrantAuthorized) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_transfer_claim.issue',
      'target_pro_room_limit_reached',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'ACCOUNT_PRO_ROOM_LIMIT_REACHED' }, 409);
  }

  const issued = await callProRoomAdminObject(
    env,
    roomCode,
    room.roomGeneration,
    '/internal/admin/owner-transfer-claim',
    'POST',
    { targetAccountId: target.accountId },
  );
  if (!issued.response?.ok) {
    await reconcileAdminProRoomStatus(env, db, room).catch(() => {});
    const reconciliationRequired =
      issued.response?.status === 409 &&
      isJsonObject(issued.payload) &&
      issued.payload.error === 'OWNER_TRANSFER_RECONCILIATION_REQUIRED';
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_transfer_claim.issue',
      reconciliationRequired
        ? 'reconcile_required'
        : issued.response
          ? 'service_rejected'
          : 'service_unavailable',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    if (reconciliationRequired) {
      return json({ error: 'PRO_ROOM_OWNER_TRANSFER_RECONCILIATION_REQUIRED' }, 409);
    }
    return proRoomObjectError(issued);
  }
  if (
    !isValidAdminOwnerTransferLink(issued.payload, roomCode, room.roomGeneration, target.accountId)
  ) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_transfer_claim.issue',
      'invalid_service_response',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_ADMIN_INVALID_RESPONSE' }, 502);
  }

  let currentRoom;
  try {
    currentRoom = await readAdminProRoom(db, roomCode);
  } catch {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_transfer_claim.issue',
      'registry_unavailable',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  let currentTarget;
  try {
    currentTarget = await readActiveOwnerTransferTarget(env, target.accountId);
  } catch {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_transfer_claim.issue',
      'target_store_unavailable',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'ACCOUNT_STORE_UNAVAILABLE' }, 503);
  }
  if (
    !currentRoom ||
    currentRoom.roomGeneration !== room.roomGeneration ||
    currentRoom.activationState !== 'active' ||
    !(
      currentRoom.status === 'registered' ||
      (currentRoom.status === 'suspended' &&
        currentRoom.suspensionReason !== null &&
        ['owner_account_deleted', 'ownership_transfer_pending'].includes(
          currentRoom.suspensionReason,
        ))
    ) ||
    !currentTarget
  ) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_transfer_claim.issue',
      'state_changed',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_OWNER_TRANSFER_UNAVAILABLE' }, 409);
  }

  try {
    if (
      !(await recordOwnerTransferIssuance(db, {
        roomCode,
        roomGeneration: room.roomGeneration,
        claimGeneration: issued.payload.claimGeneration,
        targetAccountId: target.accountId,
        expiresAtMs: issued.payload.expiresAt,
      }))
    ) {
      const auditError = await writeAdminProRoomAuditOrFail(
        db,
        request,
        env,
        'owner_transfer_claim.issue',
        'issuance_ledger_conflict',
        roomCode,
        room.roomGeneration,
      );
      if (auditError) return auditError;
      return json({ error: 'PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED' }, 503);
    }
  } catch {
    // The URL remains only in this function's memory and is deliberately not
    // exposed when its non-secret expiry ledger cannot be confirmed.
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_transfer_claim.issue',
      'issuance_ledger_unavailable',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }

  const auditError = await writeAdminProRoomAuditOrFail(
    db,
    request,
    env,
    'owner_transfer_claim.issue',
    'issued',
    roomCode,
    room.roomGeneration,
  );
  // The URL is a one-time bearer credential. Never expose it unless the
  // operator action was durably audited; the next issue rotates the claim.
  if (auditError) return auditError;
  return json({
    roomCode,
    roomGeneration: room.roomGeneration,
    targetAccountId: target.accountId,
    targetNickname: target.nickname,
    claimGeneration: issued.payload.claimGeneration,
    transferUrl: issued.payload.transferUrl,
    expiresAt: issued.payload.expiresAt,
  });
}

function legacyOwnerDetachRetainedOwnerMatches(
  payload: unknown,
  retainedRoom: AdminProRoomRecord,
  ownerAccountId: string,
) {
  if (!isProRoomAdminStatusPayload(payload, retainedRoom.roomCode, retainedRoom.roomGeneration)) {
    return false;
  }
  return (
    payload.provisioned === true &&
    payload.status === 'active' &&
    payload.suspensionReason == null &&
    payload.ownerAccountLinked === true &&
    payload.ownerAccountId === ownerAccountId &&
    typeof payload.ownerAuthorityEpoch === 'number' &&
    Number.isSafeInteger(payload.ownerAuthorityEpoch) &&
    payload.ownerAuthorityEpoch >= 0 &&
    payload.ownerAuthorityRemoval === null &&
    payload.ownerTransferReconciliation === null
  );
}

async function inspectLegacyOwnerDetachIntentRetainedState(
  db: D1Database,
  env: AppEnv,
  intent: LegacyOwnerDetachIntent,
  previousOwnerAccountId: string,
) {
  let retainedRoom;
  try {
    retainedRoom = await readAdminProRoom(db, intent.retainedRoomCode);
  } catch {
    return 'unavailable';
  }
  if (
    !retainedRoom ||
    retainedRoom.roomGeneration !== intent.retainedRoomGeneration ||
    retainedRoom.activationState !== 'active' ||
    retainedRoom.status !== 'registered'
  ) {
    return 'stale';
  }
  const retainedStatus = await callProRoomAdminObject(
    env,
    retainedRoom.roomCode,
    retainedRoom.roomGeneration,
    '/internal/admin/status',
    'GET',
  );
  if (
    retainedStatus.response?.ok !== true ||
    !proRoomAdminResponseIdentityMatches(
      retainedStatus.payload,
      retainedRoom.roomCode,
      retainedRoom.roomGeneration,
    )
  ) {
    return 'unavailable';
  }
  return legacyOwnerDetachRetainedOwnerMatches(
    retainedStatus.payload,
    retainedRoom,
    previousOwnerAccountId,
  )
    ? 'current'
    : 'stale';
}

async function handleAdminProRoomLegacyOwnerDetach(
  request: Request,
  env: AppEnv,
  pathname: string,
) {
  const route = pathname.match(ADMIN_PRO_ROOM_LEGACY_OWNER_DETACH_PATH_RE);
  if (!route) return json({ error: 'NOT_FOUND' }, 404);
  const methodError = adminApiMethodAllowed(request, ['POST']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const db = getAdminDb(env);
  if (!db?.prepare || !getProRoomAdminNamespace(env)) {
    return json({ error: 'PRO_ROOM_ADMIN_NOT_CONFIGURED' }, 503);
  }

  const roomCode = route[1];
  if (!roomCode) return json({ error: 'NOT_FOUND' }, 404);
  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody);
  if (!isJsonObject(parsedBody.value)) return json({ error: 'INVALID_REQUEST' }, 400);
  const body = parsedBody.value;
  const keys = Object.keys(body);
  if (
    keys.length !== 3 ||
    !keys.includes('roomGeneration') ||
    !keys.includes('retainRoomCode') ||
    !keys.includes('confirmRoomCode') ||
    !isProRoomGeneration(body.roomGeneration) ||
    typeof body.retainRoomCode !== 'string' ||
    !ADMIN_PRO_ROOM_CODE_RE.test(body.retainRoomCode) ||
    body.retainRoomCode === roomCode ||
    body.confirmRoomCode !== roomCode
  ) {
    return json({ error: 'INVALID_REQUEST' }, 400);
  }

  let room;
  let retainedRoom;
  try {
    [room, retainedRoom] = await Promise.all([
      readAdminProRoom(db, roomCode),
      readAdminProRoom(db, body.retainRoomCode),
    ]);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (!room) return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
  if (room.roomGeneration !== body.roomGeneration) {
    return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
  }
  if (room.activationState !== 'active' || !['registered', 'suspended'].includes(room.status)) {
    return json({ error: 'PRO_ROOM_LEGACY_OWNER_DETACH_UNAVAILABLE' }, 409);
  }

  const targetStatus = await callProRoomAdminObject(
    env,
    roomCode,
    room.roomGeneration,
    '/internal/admin/status',
    'GET',
  );
  const target = targetStatus.payload;
  if (
    targetStatus.response?.ok !== true ||
    !isProRoomAdminStatusPayload(target, roomCode, room.roomGeneration) ||
    target.provisioned !== true
  ) {
    return json({ error: 'PRO_ROOM_ADMIN_UNAVAILABLE' }, 503);
  }

  const targetRemoval = normalizeOwnerAuthorityRemoval(target.ownerAuthorityRemoval);
  const targetOwnerAuthorityEpoch =
    typeof target.ownerAuthorityEpoch === 'number' &&
    Number.isSafeInteger(target.ownerAuthorityEpoch) &&
    target.ownerAuthorityEpoch >= 0
      ? target.ownerAuthorityEpoch
      : null;
  const firstDetach =
    (target.status === 'active' ||
      (target.status === 'suspended' && target.suspensionReason === 'operator_suspended')) &&
    target.ownerAccountLinked === true &&
    typeof target.ownerAccountId === 'string' &&
    ACCOUNT_ID_RE.test(target.ownerAccountId) &&
    targetOwnerAuthorityEpoch !== null &&
    target.ownerAuthorityRemoval === null &&
    target.ownerTransferReconciliation === null;
  const detachedReplay =
    target.status === 'suspended' &&
    target.suspensionReason === 'ownership_transfer_pending' &&
    target.ownerAccountLinked === false &&
    target.ownerAccountId === null &&
    targetRemoval !== null &&
    target.ownerAuthorityEpoch === targetRemoval.ownerAuthorityEpoch &&
    target.ownerTransferReconciliation === null;
  if (!firstDetach && !detachedReplay) {
    return json({ error: 'PRO_ROOM_LEGACY_OWNER_DETACH_UNAVAILABLE' }, 409);
  }

  let previousOwnerAccountId: string;
  let expectedOwnerAuthorityEpoch: number;
  if (
    firstDetach &&
    typeof target.ownerAccountId === 'string' &&
    targetOwnerAuthorityEpoch !== null
  ) {
    previousOwnerAccountId = target.ownerAccountId;
    expectedOwnerAuthorityEpoch = targetOwnerAuthorityEpoch;
  } else if (detachedReplay && targetRemoval) {
    previousOwnerAccountId = targetRemoval.accountId;
    expectedOwnerAuthorityEpoch = targetRemoval.ownerAuthorityEpoch - 1;
  } else {
    return json({ error: 'PRO_ROOM_LEGACY_OWNER_DETACH_UNAVAILABLE' }, 409);
  }
  let detachIntent;
  try {
    detachIntent = await readLegacyOwnerDetachIntent(
      db,
      roomCode,
      room.roomGeneration,
      expectedOwnerAuthorityEpoch,
    );
  } catch {
    return json({ error: 'PRO_ROOM_AUDIT_UNAVAILABLE' }, 503);
  }
  if (detachedReplay && detachIntent && detachIntent.retainedRoomCode !== body.retainRoomCode) {
    return json({ error: 'PRO_ROOM_LEGACY_OWNER_DETACH_INTENT_MISMATCH' }, 409);
  }
  // An intent proves the retained-owner precondition only after the target DO
  // has actually crossed into detachedReplay. If the detach call failed before
  // applying, target remains firstDetach and the retained owner may have moved;
  // revalidate before removing what could now be the account's last owner.
  const shouldBootstrapIntent = detachedReplay && !detachIntent;
  let shouldSupersedeIntent = false;
  if (firstDetach || shouldBootstrapIntent) {
    if (!retainedRoom) return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
    if (retainedRoom.activationState !== 'active' || retainedRoom.status !== 'registered') {
      return json({ error: 'PRO_ROOM_LEGACY_DUPLICATE_OWNER_NOT_CONFIRMED' }, 409);
    }
    const retainedStatus = await callProRoomAdminObject(
      env,
      retainedRoom.roomCode,
      retainedRoom.roomGeneration,
      '/internal/admin/status',
      'GET',
    );
    const retained = retainedStatus.payload;
    if (
      retainedStatus.response?.ok !== true ||
      !legacyOwnerDetachRetainedOwnerMatches(retained, retainedRoom, previousOwnerAccountId)
    ) {
      return json({ error: 'PRO_ROOM_LEGACY_DUPLICATE_OWNER_NOT_CONFIRMED' }, 409);
    }
    shouldSupersedeIntent =
      firstDetach &&
      !!detachIntent &&
      (detachIntent.retainedRoomCode !== retainedRoom.roomCode ||
        detachIntent.retainedRoomGeneration !== retainedRoom.roomGeneration);
    if (shouldSupersedeIntent) {
      if (!detachIntent) {
        return json({ error: 'PRO_ROOM_LEGACY_OWNER_DETACH_INTENT_MISMATCH' }, 409);
      }
      const previousIntentState = await inspectLegacyOwnerDetachIntentRetainedState(
        db,
        env,
        detachIntent,
        previousOwnerAccountId,
      );
      if (previousIntentState === 'unavailable') {
        return json({ error: 'PRO_ROOM_ADMIN_UNAVAILABLE' }, 503);
      }
      if (previousIntentState !== 'stale') {
        return json({ error: 'PRO_ROOM_LEGACY_OWNER_DETACH_INTENT_MISMATCH' }, 409);
      }
    }
  }

  const entitlementInput = {
    accountId: previousOwnerAccountId,
    roomCode,
    roomGeneration: room.roomGeneration,
    nowMs: Date.now(),
  };
  if (!(await canOrphanProRoomOwnerEntitlement(env, entitlementInput))) {
    return detachedReplay
      ? json({ error: 'PRO_ROOM_OWNER_DETACH_RECONCILIATION_REQUIRED' }, 503)
      : json({ error: 'PRO_ROOM_OWNER_ENTITLEMENT_CONFLICT' }, 409);
  }

  if (shouldBootstrapIntent) {
    if (!retainedRoom || !targetRemoval) {
      return json({ error: 'PRO_ROOM_OWNER_DETACH_RECONCILIATION_REQUIRED' }, 503);
    }
    // Upgrade-only liveness repair: an older release could cross the target DO
    // authority boundary before it durably wrote an epoch-scoped intent. The
    // target is already ownerless, so bootstrap cannot remove more authority;
    // nevertheless re-confirm the exact removal immediately before recording
    // the append-only recovery root.
    const targetRecheck = await callProRoomAdminObject(
      env,
      roomCode,
      room.roomGeneration,
      '/internal/admin/status',
      'GET',
    );
    const recheckedTarget = targetRecheck.payload;
    const recheckedRemoval = normalizeOwnerAuthorityRemoval(
      isJsonObject(recheckedTarget) ? recheckedTarget.ownerAuthorityRemoval : null,
    );
    const recheckedDetachedReplay =
      targetRecheck.response?.ok === true &&
      proRoomAdminResponseIdentityMatches(recheckedTarget, roomCode, room.roomGeneration) &&
      recheckedTarget.provisioned === true &&
      recheckedTarget.status === 'suspended' &&
      recheckedTarget.suspensionReason === 'ownership_transfer_pending' &&
      recheckedTarget.ownerAccountLinked === false &&
      recheckedTarget.ownerAccountId === null &&
      recheckedRemoval !== null &&
      recheckedTarget.ownerAuthorityEpoch === recheckedRemoval.ownerAuthorityEpoch &&
      recheckedRemoval.accountId === targetRemoval.accountId &&
      recheckedRemoval.removalId === targetRemoval.removalId &&
      recheckedRemoval.ownerAuthorityEpoch === targetRemoval.ownerAuthorityEpoch &&
      recheckedRemoval.fencedCoordinatorEpoch === targetRemoval.fencedCoordinatorEpoch &&
      recheckedTarget.ownerTransferReconciliation === null;
    if (!recheckedDetachedReplay) {
      return json({ error: 'PRO_ROOM_OWNER_DETACH_RECONCILIATION_REQUIRED' }, 503);
    }
    try {
      detachIntent = await bootstrapLegacyOwnerDetachIntent(
        db,
        request,
        env,
        roomCode,
        room.roomGeneration,
        retainedRoom.roomCode,
        retainedRoom.roomGeneration,
        expectedOwnerAuthorityEpoch,
      );
    } catch {
      return json({ error: 'PRO_ROOM_AUDIT_UNAVAILABLE' }, 503);
    }
    if (
      !detachIntent ||
      detachIntent.auditAction !== ADMIN_LEGACY_OWNER_DETACH_INTENT_BOOTSTRAP_ACTION ||
      detachIntent.retainedRoomCode !== retainedRoom.roomCode ||
      detachIntent.retainedRoomGeneration !== retainedRoom.roomGeneration
    ) {
      // A competing recovery root is authoritative. Existing normal epoch
      // intents are never converted or superseded from detachedReplay.
      return json({ error: 'PRO_ROOM_LEGACY_OWNER_DETACH_INTENT_MISMATCH' }, 409);
    }
  } else if (!detachIntent) {
    if (!retainedRoom) return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
    try {
      detachIntent = await ensureLegacyOwnerDetachIntent(
        db,
        request,
        env,
        roomCode,
        room.roomGeneration,
        retainedRoom.roomCode,
        retainedRoom.roomGeneration,
        expectedOwnerAuthorityEpoch,
      );
    } catch {
      return json({ error: 'PRO_ROOM_AUDIT_UNAVAILABLE' }, 503);
    }
    if (
      !detachIntent ||
      detachIntent.retainedRoomCode !== retainedRoom.roomCode ||
      detachIntent.retainedRoomGeneration !== retainedRoom.roomGeneration
    ) {
      return json({ error: 'PRO_ROOM_LEGACY_OWNER_DETACH_INTENT_MISMATCH' }, 409);
    }
  } else if (shouldSupersedeIntent) {
    if (!retainedRoom) return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
    // Re-read the target immediately before the durable transition. A target
    // already observed in detachedReplay may use only its existing exact
    // intent; it must never acquire a post-detach supersede transition.
    const targetRecheck = await callProRoomAdminObject(
      env,
      roomCode,
      room.roomGeneration,
      '/internal/admin/status',
      'GET',
    );
    const recheckedTarget = targetRecheck.payload;
    const recheckedFirstDetach =
      targetRecheck.response?.ok === true &&
      proRoomAdminResponseIdentityMatches(recheckedTarget, roomCode, room.roomGeneration) &&
      recheckedTarget.provisioned === true &&
      (recheckedTarget.status === 'active' ||
        (recheckedTarget.status === 'suspended' &&
          recheckedTarget.suspensionReason === 'operator_suspended')) &&
      recheckedTarget.ownerAccountLinked === true &&
      recheckedTarget.ownerAccountId === previousOwnerAccountId &&
      recheckedTarget.ownerAuthorityEpoch === expectedOwnerAuthorityEpoch &&
      recheckedTarget.ownerAuthorityRemoval === null &&
      recheckedTarget.ownerTransferReconciliation === null;
    if (!recheckedFirstDetach) {
      return json({ error: 'PRO_ROOM_OWNER_DETACH_RECONCILIATION_REQUIRED' }, 503);
    }
    try {
      detachIntent = await supersedeLegacyOwnerDetachIntent(
        db,
        request,
        env,
        roomCode,
        room.roomGeneration,
        detachIntent,
        retainedRoom.roomCode,
        retainedRoom.roomGeneration,
      );
    } catch {
      return json({ error: 'PRO_ROOM_AUDIT_UNAVAILABLE' }, 503);
    }
    if (
      !detachIntent ||
      detachIntent.retainedRoomCode !== retainedRoom.roomCode ||
      detachIntent.retainedRoomGeneration !== retainedRoom.roomGeneration
    ) {
      // Another validated recovery won the audit-id CAS. The caller must retry
      // with that effective retained room; never append a competing branch.
      return json({ error: 'PRO_ROOM_LEGACY_OWNER_DETACH_INTENT_MISMATCH' }, 409);
    }
  }

  const detached = await callProRoomAdminObject(
    env,
    roomCode,
    room.roomGeneration,
    '/internal/admin/owner-authority/detach',
    'POST',
    { accountId: previousOwnerAccountId, expectedOwnerAuthorityEpoch },
  );
  const result = detached.payload;
  if (!detached.response || detached.response.status >= 500) {
    return json({ error: 'PRO_ROOM_OWNER_DETACH_RECONCILIATION_REQUIRED' }, 503);
  }
  if (!detached.response.ok) return proRoomObjectError(detached);
  if (
    !proRoomAdminResponseIdentityMatches(result, roomCode, room.roomGeneration) ||
    result.ok !== true ||
    result.status !== 'suspended' ||
    result.suspensionReason !== 'ownership_transfer_pending' ||
    result.previousOwnerAccountId !== previousOwnerAccountId ||
    result.expectedOwnerAuthorityEpoch !== expectedOwnerAuthorityEpoch ||
    result.ownerAuthorityRemoved !== true ||
    typeof result.removalId !== 'string' ||
    !OWNER_AUTHORITY_REMOVAL_ID_RE.test(result.removalId) ||
    typeof result.removedOwnerAuthorityEpoch !== 'number' ||
    result.removedOwnerAuthorityEpoch !== expectedOwnerAuthorityEpoch + 1 ||
    result.ownerAuthorityEpoch !== result.removedOwnerAuthorityEpoch ||
    typeof result.fencedCoordinatorEpoch !== 'number' ||
    !Number.isSafeInteger(result.fencedCoordinatorEpoch) ||
    result.fencedCoordinatorEpoch < 1 ||
    typeof result.projectionAcked !== 'boolean' ||
    typeof result.changed !== 'boolean'
  ) {
    return json({ error: 'PRO_ROOM_OWNER_DETACH_RECONCILIATION_REQUIRED' }, 503);
  }

  const removal = {
    roomCode,
    roomGeneration: room.roomGeneration,
    removalId: result.removalId,
    removedOwnerAuthorityEpoch: result.removedOwnerAuthorityEpoch,
    fencedCoordinatorEpoch: result.fencedCoordinatorEpoch,
  };
  try {
    // This endpoint is legacy-named for account deletion, but its contract is
    // an exact removal-id/authority-epoch fence and is safe for this operator
    // authority removal as well.
    if (!(await fenceProRoomSignalingForOwnerAccountDeletion(removal, env))) {
      throw new Error('PRO signaling owner-authority fence unavailable');
    }
    const fenceDigest = await developerApiAuthorityFenceDigest(
      env,
      'legacy-owner-detach',
      `${roomCode}\u0000${room.roomGeneration}\u0000${previousOwnerAccountId}\u0000${result.removalId}\u0000${result.removedOwnerAuthorityEpoch}\u0000${result.fencedCoordinatorEpoch}`,
    );
    await revokeDeveloperApiKeysForAuthorityChange(
      env,
      roomCode,
      room.roomGeneration,
      'system:legacy-owner-detach',
      'legacy_duplicate_owner_detach',
      'ownership_transfer_pending',
      fenceDigest,
    );
    if (!(await orphanProRoomOwnerEntitlement(env, entitlementInput))) {
      throw new Error('PRO owner entitlement orphaning unavailable');
    }
    if (
      !(await markAdminProRoomOperationalState(
        db,
        roomCode,
        room.roomGeneration,
        'suspended',
        'ownership_transfer_pending',
      ))
    ) {
      throw new Error('PRO room ownerless projection unavailable');
    }
    if (
      !(await retireAccountProRoomLinkForAccount(
        env,
        previousOwnerAccountId,
        roomCode,
        room.roomGeneration,
      ))
    ) {
      throw new Error('PRO account reverse edge retirement unavailable');
    }
  } catch {
    return json({ error: 'PRO_ROOM_OWNER_DETACH_RECONCILIATION_REQUIRED' }, 503);
  }

  try {
    await completeLegacyOwnerDetachAudit(
      db,
      request,
      env,
      roomCode,
      room.roomGeneration,
      detachIntent,
      result.changed ? 'changed' : 'reconciled',
    );
  } catch {
    // Do not open the target for a new owner until the completed projection is
    // durably audited. The epoch intent is retained without an age limit, so
    // an ack failure can always reconcile after the retained room moves.
    return json({ error: 'PRO_ROOM_OWNER_DETACH_AUDIT_PENDING' }, 503);
  }

  const acknowledged = await callProRoomAdminObject(
    env,
    roomCode,
    room.roomGeneration,
    '/internal/admin/owner-authority/detach/ack',
    'POST',
    {
      accountId: previousOwnerAccountId,
      expectedOwnerAuthorityEpoch,
      removalId: result.removalId,
      removedOwnerAuthorityEpoch: result.removedOwnerAuthorityEpoch,
      fencedCoordinatorEpoch: result.fencedCoordinatorEpoch,
    },
  );
  const ack = acknowledged.payload;
  if (
    acknowledged.response?.ok !== true ||
    !proRoomAdminResponseIdentityMatches(ack, roomCode, room.roomGeneration) ||
    ack.ok !== true ||
    ack.status !== 'suspended' ||
    ack.suspensionReason !== 'ownership_transfer_pending' ||
    ack.previousOwnerAccountId !== previousOwnerAccountId ||
    ack.expectedOwnerAuthorityEpoch !== expectedOwnerAuthorityEpoch ||
    ack.ownerAuthorityRemoved !== true ||
    ack.removalId !== result.removalId ||
    ack.removedOwnerAuthorityEpoch !== result.removedOwnerAuthorityEpoch ||
    ack.fencedCoordinatorEpoch !== result.fencedCoordinatorEpoch ||
    ack.projectionAcked !== true
  ) {
    return json({ error: 'PRO_ROOM_OWNER_DETACH_RECONCILIATION_REQUIRED' }, 503);
  }

  return json({
    ok: true,
    roomCode,
    roomGeneration: room.roomGeneration,
    status: 'suspended',
    suspensionReason: 'ownership_transfer_pending',
    ownerAccountLinked: false,
    retainedRoomCode: detachIntent.retainedRoomCode,
    changed: result.changed,
  });
}

async function handleAdminProRoomState(request: Request, env: AppEnv, pathname: string) {
  const route = pathname.match(ADMIN_PRO_ROOM_STATE_PATH_RE);
  if (!route) return json({ error: 'NOT_FOUND' }, 404);
  const methodError = adminApiMethodAllowed(request, ['POST']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const db = getAdminDb(env);
  if (!db?.prepare || !getProRoomAdminNamespace(env)) {
    return json({ error: 'PRO_ROOM_ADMIN_NOT_CONFIGURED' }, 503);
  }

  const roomCode = route[1];
  if (!roomCode) return json({ error: 'NOT_FOUND' }, 404);
  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody);
  if (!isJsonObject(parsedBody.value)) return json({ error: 'INVALID_REQUEST' }, 400);
  const body = parsedBody.value;
  const keys = Object.keys(body);
  const targetStatus = body?.status;
  if (
    keys.length !== 2 ||
    !keys.includes('roomGeneration') ||
    !keys.includes('status') ||
    !isProRoomGeneration(body.roomGeneration) ||
    (targetStatus !== 'active' && targetStatus !== 'suspended')
  ) {
    return json({ error: 'INVALID_REQUEST' }, 400);
  }

  let room;
  try {
    room = await readAdminProRoom(db, roomCode);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (!room) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      targetStatus === 'suspended' ? 'room.suspend' : 'room.resume',
      'room_not_found',
      roomCode,
      body.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
  }
  if (room.roomGeneration !== body.roomGeneration) {
    const action = targetStatus === 'suspended' ? 'room.suspend' : 'room.resume';
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      action,
      'generation_mismatch',
      roomCode,
      body.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
  }
  if (room.status === 'decommissioning' || room.status === 'decommissioned') {
    return json({ error: 'PRO_ROOM_PERMANENTLY_DECOMMISSIONED' }, 410);
  }
  if (room.status === 'provisioning') {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      targetStatus === 'suspended' ? 'room.suspend' : 'room.resume',
      'provisioning_incomplete',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_PROVISIONING_INCOMPLETE' }, 409);
  }
  if (
    targetStatus === 'active' &&
    room.status === 'suspended' &&
    room.suspensionReason !== 'operator_suspended'
  ) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'room.resume',
      'ownership_recovery_required',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_OWNERSHIP_RECOVERY_REQUIRED' }, 409);
  }

  const action = targetStatus === 'suspended' ? 'room.suspend' : 'room.resume';
  const internalPath =
    targetStatus === 'suspended' ? '/internal/admin/suspend' : '/internal/admin/resume';
  const changed = await callProRoomAdminObject(env, roomCode, room.roomGeneration, internalPath);
  const payload = changed.payload;
  if (!changed.response?.ok) {
    await reconcileAdminProRoomStatus(env, db, room).catch(() => {});
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      action,
      changed.response ? 'service_rejected' : 'service_unavailable',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return proRoomObjectError(changed);
  }
  if (
    !proRoomAdminResponseIdentityMatches(payload, roomCode, room.roomGeneration) ||
    payload.ok !== true ||
    payload.status !== targetStatus ||
    (targetStatus === 'suspended' && payload.suspensionReason !== 'operator_suspended') ||
    (targetStatus === 'active' && payload.suspensionReason != null) ||
    typeof payload.changed !== 'boolean'
  ) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      action,
      'invalid_service_response',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_ADMIN_INVALID_RESPONSE' }, 502);
  }

  try {
    const updated = await markAdminProRoomOperationalState(
      db,
      roomCode,
      room.roomGeneration,
      targetStatus,
      targetStatus === 'suspended' ? 'operator_suspended' : null,
    );
    if (!updated) return json({ error: 'PRO_ROOM_STATE_CONFLICT' }, 409);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  const auditError = await writeAdminProRoomAuditOrFail(
    db,
    request,
    env,
    action,
    payload.changed ? 'changed' : 'already_applied',
    roomCode,
    room.roomGeneration,
  );
  if (auditError) return auditError;
  return json({
    ok: true,
    roomCode,
    roomGeneration: room.roomGeneration,
    status: targetStatus,
    suspensionReason: targetStatus === 'suspended' ? 'operator_suspended' : null,
    changed: payload.changed,
  });
}

async function handleAdminProRoomLabel(request: Request, env: AppEnv, pathname: string) {
  const route = pathname.match(ADMIN_PRO_ROOM_LABEL_PATH_RE);
  if (!route) return json({ error: 'NOT_FOUND' }, 404);
  const methodError = adminApiMethodAllowed(request, ['POST']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const db = getAdminDb(env);
  if (!db?.prepare || typeof db.batch !== 'function') {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }

  const roomCode = route[1];
  if (!roomCode) return json({ error: 'NOT_FOUND' }, 404);
  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody);
  const body = parsedBody.value;
  const label = normalizeAdminProRoomLabel(isJsonObject(body) ? body.label : undefined);
  if (
    !isJsonObject(body) ||
    Object.keys(body).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(body, 'roomGeneration') ||
    !Object.prototype.hasOwnProperty.call(body, 'label') ||
    !isProRoomGeneration(body.roomGeneration) ||
    !label
  ) {
    return json({ error: 'INVALID_REQUEST' }, 400);
  }

  let room;
  try {
    room = await readAdminProRoom(db, roomCode);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (!room) return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
  if (room.roomGeneration !== body.roomGeneration) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'room.label.update',
      'generation_mismatch',
      roomCode,
      body.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
  }
  if (room.status === 'decommissioning' || room.status === 'decommissioned') {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'room.label.update',
      'room_closed',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_PERMANENTLY_DECOMMISSIONED' }, 410);
  }
  if (room.status === 'provisioning') {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'room.label.update',
      'provisioning_incomplete',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_PROVISIONING_INCOMPLETE' }, 409);
  }
  if (room.label === label) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'room.label.update',
      'already_applied',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({
      ok: true,
      roomCode,
      roomGeneration: room.roomGeneration,
      label,
      changed: false,
    });
  }

  const nowMs = Date.now();
  let actorId;
  try {
    actorId = await adminProRoomAuditActor(request, env);
    const audit = db
      .prepare(
        `INSERT INTO ${ADMIN_PRO_ROOM_AUDIT_TABLE}
          (actor_id, action, result, room_code, room_generation, created_at)
         VALUES (?1, 'room.label.update', 'authorized', ?2, ?3, ?4)`,
      )
      .bind(actorId, roomCode, room.roomGeneration, nowMs);
    const mutation = db
      .prepare(
        `UPDATE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         SET label = ?4, updated_at = ?5
         WHERE room_code = ?1
           AND room_generation = ?2
           AND label = ?3
           AND status IN ('registered', 'suspended')`,
      )
      .bind(roomCode, room.roomGeneration, room.label, label, nowMs);
    const results = await db.batch([audit, mutation]);
    if (!Array.isArray(results) || !d1MutationChanged(results[0])) {
      throw new Error('PRO room label audit was not confirmed');
    }
    if (d1MutationChanged(results[1])) {
      return json({
        ok: true,
        roomCode,
        roomGeneration: room.roomGeneration,
        label,
        changed: true,
      });
    }
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }

  let current;
  try {
    current = await readAdminProRoom(db, roomCode);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (!current) return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
  if (current.roomGeneration !== room.roomGeneration) {
    return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
  }
  if (current.status === 'decommissioning' || current.status === 'decommissioned') {
    return json({ error: 'PRO_ROOM_PERMANENTLY_DECOMMISSIONED' }, 410);
  }
  if (current.status === 'provisioning') {
    return json({ error: 'PRO_ROOM_PROVISIONING_INCOMPLETE' }, 409);
  }
  if (current.label === label) {
    return json({
      ok: true,
      roomCode,
      roomGeneration: current.roomGeneration,
      label,
      changed: false,
    });
  }
  return json({ error: 'PRO_ROOM_LABEL_CONFLICT' }, 409);
}

async function handleAdminProRoomDelete(request: Request, env: AppEnv, pathname: string) {
  const route = pathname.match(ADMIN_PRO_ROOM_DELETE_PATH_RE);
  if (!route) return json({ error: 'NOT_FOUND' }, 404);
  const methodError = adminApiMethodAllowed(request, ['DELETE']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const db = getAdminDb(env);
  if (!db?.prepare || !getProRoomAdminNamespace(env)) {
    return json({ error: 'PRO_ROOM_DECOMMISSION_NOT_CONFIGURED' }, 503);
  }

  const roomCode = route[1];
  if (!roomCode) return json({ error: 'NOT_FOUND' }, 404);
  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody);
  const body = parsedBody.value;
  if (
    !isJsonObject(body) ||
    Object.keys(body).length !== 3 ||
    body.confirmRoomCode !== roomCode ||
    !isProRoomGeneration(body.roomGeneration) ||
    typeof body.requestId !== 'string' ||
    !ADMIN_DEVELOPER_API_REQUEST_ID_RE.test(body.requestId)
  ) {
    return json({ error: 'PRO_ROOM_DELETE_CONFIRMATION_MISMATCH' }, 400);
  }

  let room;
  try {
    room = await readAdminProRoom(db, roomCode);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (!room) return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
  if (room.roomGeneration !== body.roomGeneration) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'room.delete',
      'generation_mismatch',
      roomCode,
      body.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
  }

  if (room.status !== 'decommissioning' && room.status !== 'decommissioned') {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'room.delete',
      'authorized',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
  }
  const decommissioned = await callProRoomAdminObject(
    env,
    roomCode,
    room.roomGeneration,
    '/internal/admin/decommission',
    'POST',
    { roomCode, roomGeneration: room.roomGeneration, requestId: body.requestId },
  );
  const payload = decommissioned.payload;
  if (
    !decommissioned.response?.ok ||
    !proRoomAdminResponseIdentityMatches(payload, roomCode, room.roomGeneration) ||
    payload.ok !== true ||
    typeof payload.status !== 'string' ||
    !['decommissioning', 'decommissioned'].includes(payload.status)
  ) {
    return proRoomObjectError(decommissioned);
  }

  try {
    if (payload.status === 'decommissioned') {
      await markAdminProRoomDecommissioned(db, roomCode, room.roomGeneration, body.requestId);
      if (
        !(await revokeProRoomEntitlement(env, {
          roomCode,
          roomGeneration: room.roomGeneration,
        }))
      ) {
        throw new Error('PRO_ROOM_ENTITLEMENT_RECONCILIATION_REQUIRED');
      }
      // A completed incarnation has no persistent account authority left to
      // revoke. Retire only this exact generation's reverse edges so terminal
      // history cannot consume account deletion capacity forever. A later room
      // reusing the public code remains isolated in its own generation rows.
      await retireAccountProRoomLinks(env, roomCode, room.roomGeneration);
    } else {
      // The room Durable Object owns the retry alarm. Move the display index
      // only after that durable saga exists; otherwise a lost cross-script
      // call could leave an inert D1 fence with no worker scheduled to purge.
      await markAdminProRoomDecommissioning(db, roomCode, room.roomGeneration);
    }
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  return json(
    {
      ok: true,
      roomCode,
      roomGeneration: room.roomGeneration,
      status: payload.status,
      purgeAfterMs: Number.isSafeInteger(payload.purgeAfterMs) ? payload.purgeAfterMs : null,
      completedAtMs: Number.isSafeInteger(payload.completedAtMs) ? payload.completedAtMs : null,
    },
    payload.status === 'decommissioned' ? 200 : 202,
  );
}

function emptyAdminCounters(): Record<string, number> {
  return Object.fromEntries(ADMIN_METRIC_EVENTS.map((event) => [event.key, 0]));
}

function addMetricCount(target: Record<string, number>, event: string, count: number) {
  if (!Object.prototype.hasOwnProperty.call(target, event)) return;
  target[event] = (target[event] || 0) + count;
}

function buildAdminMetricBuckets(rows: Record<string, unknown>[], nowMs: number) {
  const last24 = emptyAdminCounters();
  const previous24 = emptyAdminCounters();
  const last7 = emptyAdminCounters();
  const hourStartMs = Math.floor(nowMs / 3600000) * 3600000;
  const dayStartMs = Math.floor(nowMs / 86400000) * 86400000;
  const hourly = [];
  const daily = [];
  const daily30 = [];

  for (let i = 23; i >= 0; i -= 1) {
    const startMs = hourStartMs - i * 3600000;
    hourly.push({
      start: new Date(startMs).toISOString(),
      events: emptyAdminCounters(),
    });
  }

  for (let i = 6; i >= 0; i -= 1) {
    const startMs = dayStartMs - i * 86400000;
    daily.push({
      start: new Date(startMs).toISOString(),
      events: emptyAdminCounters(),
    });
  }

  for (let i = 29; i >= 0; i -= 1) {
    const startMs = dayStartMs - i * 86400000;
    daily30.push({
      start: new Date(startMs).toISOString(),
      events: emptyAdminCounters(),
    });
  }

  const last24Start = nowMs - 24 * 3600000;
  const previous24Start = nowMs - 48 * 3600000;
  const last7Start = nowMs - 7 * 86400000;

  for (const row of rows) {
    const event = String(row.event || '');
    const count = Number(row.count || 0);
    const bucketMs = Number(row.bucket_minute || 0) * 60000;
    if (!event || !Number.isFinite(count) || !Number.isFinite(bucketMs)) continue;
    if (bucketMs >= last7Start && bucketMs <= nowMs) addMetricCount(last7, event, count);
    if (bucketMs >= last24Start && bucketMs <= nowMs) addMetricCount(last24, event, count);
    else if (bucketMs >= previous24Start && bucketMs < last24Start) {
      addMetricCount(previous24, event, count);
    }
  }

  for (const row of rows) {
    const event = String(row.event || '');
    const count = Number(row.count || 0);
    const bucketMs = Number(row.bucket_minute || 0) * 60000;
    if (!event || !Number.isFinite(count) || !Number.isFinite(bucketMs)) continue;

    for (const bucket of hourly) {
      const startMs = Date.parse(bucket.start);
      if (bucketMs >= startMs && bucketMs < startMs + 3600000) {
        addMetricCount(bucket.events, event, count);
        break;
      }
    }

    for (const bucket of daily) {
      const startMs = Date.parse(bucket.start);
      if (bucketMs >= startMs && bucketMs < startMs + 86400000) {
        addMetricCount(bucket.events, event, count);
        break;
      }
    }

    for (const bucket of daily30) {
      const startMs = Date.parse(bucket.start);
      if (bucketMs >= startMs && bucketMs < startMs + 86400000) {
        addMetricCount(bucket.events, event, count);
        break;
      }
    }
  }

  return { last24, previous24, last7, hourly, daily, daily30 };
}

function metricDelta(current: number, previous: number) {
  if (!previous) return current ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

async function cleanupExpiredAdminMetrics(env: AppEnv, nowMs: number = Date.now()) {
  const db = getAdminDb(env);
  if (!db?.prepare) return 'unconfigured';

  const cutoffMinute = Math.floor(nowMs / 60000) - ADMIN_METRICS_RETENTION_DAYS * MINUTES_PER_DAY;
  try {
    await db
      .prepare(`DELETE FROM ${ADMIN_METRICS_TABLE} WHERE bucket_minute < ?1`)
      .bind(cutoffMinute)
      .run();
    return 'cleaned';
  } catch (error) {
    // Retention is maintenance, not a prerequisite for serving the dashboard
    // or refreshing Soro. Keep the scheduled task best-effort and observable.
    console.warn(
      '[AdminMetrics] retention cleanup failed:',
      error instanceof Error ? error.message : error,
    );
    return 'failed';
  }
}

async function cleanupExpiredProRoomAdminAudit(env: AppEnv, nowMs: number = Date.now()) {
  const db = getAdminDb(env);
  if (!db?.prepare) return 'unconfigured';
  const cutoffMs = nowMs - ADMIN_PRO_ROOM_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    // Epoch-scoped detach intents, upgrade bootstrap roots and their
    // append-only supersede chain are sparse durable saga records, not
    // ordinary audit history. Preserve them indefinitely even after a
    // completion row: an acknowledgement can fail after completion, and
    // repair must still resolve the exact effective retained-room proof.
    await db
      .prepare(
        `DELETE FROM ${ADMIN_PRO_ROOM_AUDIT_TABLE}
          WHERE created_at < ?1
            AND NOT (
              (action = ?2 AND result LIKE ?5)
              OR (action = ?3 AND result LIKE ?6)
              OR (action = ?4 AND result LIKE ?7)
            )`,
      )
      .bind(
        cutoffMs,
        ADMIN_LEGACY_OWNER_DETACH_INTENT_ACTION,
        ADMIN_LEGACY_OWNER_DETACH_INTENT_BOOTSTRAP_ACTION,
        ADMIN_LEGACY_OWNER_DETACH_INTENT_SUPERSEDE_ACTION,
        'authority:%:retained:%',
        'authority:%:upgrade-bootstrap:retained:%',
        'authority:%:supersede:%',
      )
      .run();
    return 'cleaned';
  } catch (error) {
    console.warn(
      '[PRO Admin Audit] retention cleanup failed:',
      error instanceof Error ? error.message : error,
    );
    return 'failed';
  }
}

export async function cleanupExpiredProRoomAdminAuditForTests(
  env: unknown,
  nowMs: number = Date.now(),
) {
  if (!isAppEnv(env)) throw new TypeError('App Worker environment unavailable');
  return cleanupExpiredProRoomAdminAudit(env, nowMs);
}

async function readAdminMetrics(env: AppEnv) {
  const db = getAdminDb(env);
  if (!db?.prepare) return { error: 'ADMIN_DB_NOT_CONFIGURED', status: 503 };

  const nowMs = Date.now();
  const nowMinute = Math.floor(nowMs / 60000);
  const sinceMinute = nowMinute - 30 * 24 * 60;
  let result;
  try {
    result = await db
      .prepare(
        `SELECT bucket_minute, event, count
         FROM ${ADMIN_METRICS_TABLE}
         WHERE bucket_minute >= ?1
         ORDER BY bucket_minute ASC`,
      )
      .bind(sinceMinute)
      .all();
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error || '');
    if (/no such table/i.test(message)) {
      return { error: 'ADMIN_METRICS_SCHEMA_MISSING', status: 503 };
    }
    return { error: 'ADMIN_METRICS_QUERY_FAILED', status: 500 };
  }

  const rows = Array.isArray(result?.results) ? result.results : [];
  const buckets = buildAdminMetricBuckets(rows, nowMs);
  const roomCount = buckets.last24.room_opened || 0;
  const guestCount = buckets.last24.guest_joined || 0;
  const authFailures =
    (buckets.last24.guest_auth_failed || 0) + (buckets.last24.guest_auth_timeout || 0);

  return {
    generatedAt: new Date(nowMs).toISOString(),
    events: ADMIN_METRIC_EVENTS,
    cards: [
      {
        key: 'room_opened',
        label: 'Rooms opened',
        value: roomCount,
        previous: buckets.previous24.room_opened || 0,
        delta: metricDelta(roomCount, buckets.previous24.room_opened || 0),
      },
      {
        key: 'guest_joined',
        label: 'Guest joins',
        value: guestCount,
        previous: buckets.previous24.guest_joined || 0,
        delta: metricDelta(guestCount, buckets.previous24.guest_joined || 0),
      },
      {
        key: 'guest_per_room',
        label: 'Guests per room',
        value: roomCount ? Number((guestCount / roomCount).toFixed(2)) : 0,
        previous: buckets.previous24.room_opened
          ? Number(
              ((buckets.previous24.guest_joined || 0) / buckets.previous24.room_opened).toFixed(2),
            )
          : 0,
      },
      {
        key: 'auth_issues',
        label: 'Password issues',
        value: authFailures,
        previous:
          (buckets.previous24.guest_auth_failed || 0) +
          (buckets.previous24.guest_auth_timeout || 0),
      },
    ],
    summary: buckets,
  };
}

async function handleAdminMetrics(request: Request, env: AppEnv) {
  const methodError = adminApiMethodAllowed(request, ['GET', 'HEAD']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);
  const metrics = await readAdminMetrics(env);
  if (metrics.error) return json({ error: metrics.error }, metrics.status || 500);
  return json(metrics);
}

function buildAdminArticleRows(feeds: SoroFeeds, hiddenSlugs: Set<string>) {
  const bySlug = new Map();
  const addArticle = (article: SoroArticle, source: string) => {
    if (!article?.slug || !isValidSoroSlug(article.slug)) return;
    const existing = bySlug.get(article.slug);
    if (!existing || source === 'live') {
      bySlug.set(article.slug, {
        title: article.title || article.slug,
        slug: article.slug,
        pubDate: article.pubDate || '',
        description: article.description || '',
        image: article.image || '',
        href: soroArticlePath(article.slug),
        source,
        hidden: hiddenSlugs.has(article.slug),
      });
      return;
    }
    existing.source = existing.source === source ? source : 'live+backup';
  };

  for (const article of feeds.backup.articles) addArticle(article, 'backup');
  for (const article of feeds.live.articles) addArticle(article, 'live');

  return sortedSoroArticles([...bySlug.values()]);
}

async function handleAdminArticles(request: Request, env: AppEnv) {
  const methodError = adminApiMethodAllowed(request, ['GET', 'HEAD']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);
  const [feeds, hiddenSlugs] = await Promise.all([loadSoroFeeds(env), readSoroHiddenSlugs(env)]);
  const articles = buildAdminArticleRows(feeds, hiddenSlugs);
  return json({
    generatedAt: new Date().toISOString(),
    source: feeds.source,
    backupStatus: feeds.backupStatus || 'unknown',
    hiddenCount: articles.filter((article) => article.hidden).length,
    articles,
  });
}

async function handleAdminArticleVisibility(request: Request, env: AppEnv) {
  const methodError = adminApiMethodAllowed(request, ['POST']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody);
  const body = parsedBody.value;
  if (!isJsonObject(body)) return json({ error: 'INVALID_SLUG' }, 400);
  const slug = String(body.slug || '').trim();
  if (!isValidSoroSlug(slug)) return json({ error: 'INVALID_SLUG' }, 400);

  const hiddenSlugs = await readSoroHiddenSlugs(env);
  const wasHidden = hiddenSlugs.has(slug);
  if (body.hidden === false) hiddenSlugs.delete(slug);
  else hiddenSlugs.add(slug);
  const isHidden = hiddenSlugs.has(slug);

  const status = await writeSoroHiddenSlugs(env, hiddenSlugs);
  if (status === 'unbound') return json({ error: 'SORO_BACKUP_NOT_CONFIGURED' }, 503);
  const cacheVersion =
    wasHidden === isHidden
      ? await readSoroBlogCacheVersion(env)
      : await touchSoroBlogCacheVersion(env, 'visibility');
  return json({
    ok: true,
    slug,
    hidden: isHidden,
    cacheVersion,
  });
}

function getAdminConfigStore(env: AppEnv) {
  return env.MUSIXQUARE_ADMIN_CONFIG || env.SORO_RSS_BACKUP || null;
}

interface AnnouncementRecord extends JsonObject {
  id: string;
  message: string;
  enabled: boolean;
  expiresAt: string | null;
  updatedAt: string;
}

type AnnouncementHistoryAction = 'published' | 'disabled' | 'cleared';

interface AnnouncementHistoryEntry extends AnnouncementRecord {
  action: AnnouncementHistoryAction;
}

function normalizeAnnouncementRecord(value: unknown): AnnouncementRecord {
  const source = isJsonObject(value) ? value : {};
  const message = String(source.message || '')
    .trim()
    .slice(0, 280);
  const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : '';
  const updatedAtMs =
    typeof source.updatedAt === 'string' || typeof source.updatedAt === 'number'
      ? new Date(source.updatedAt).getTime()
      : Number.NaN;
  const updatedAt = id && !Number.isNaN(updatedAtMs) ? new Date(updatedAtMs).toISOString() : '';
  const expiresAt =
    typeof source.expiresAt === 'string' && !Number.isNaN(new Date(source.expiresAt).getTime())
      ? new Date(source.expiresAt).toISOString()
      : null;
  return {
    id,
    message,
    enabled: Boolean(source.enabled) && Boolean(message),
    expiresAt,
    updatedAt,
  };
}

function getAnnouncementHistoryAction(announcement: AnnouncementRecord): AnnouncementHistoryAction {
  if (announcement.enabled && announcement.message) return 'published';
  if (announcement.message) return 'disabled';
  return 'cleared';
}

function normalizeAnnouncementHistoryEntry(value: unknown): AnnouncementHistoryEntry {
  const announcement = normalizeAnnouncementRecord(value);
  const source = isJsonObject(value) ? value : {};
  const action: AnnouncementHistoryAction =
    source.action === 'published' || source.action === 'disabled' || source.action === 'cleared'
      ? source.action
      : getAnnouncementHistoryAction(announcement);
  return {
    ...announcement,
    action,
  };
}

function canonicalAnnouncementWireRecordMatches(value: unknown, announcement: AnnouncementRecord) {
  return (
    isJsonObject(value) &&
    value.id === announcement.id &&
    value.message === announcement.message &&
    value.enabled === announcement.enabled &&
    value.expiresAt === announcement.expiresAt &&
    value.updatedAt === announcement.updatedAt
  );
}

async function readAdminAnnouncementHistory(env: AppEnv) {
  const store = getAdminConfigStore(env);
  if (!store) return { status: 'unbound', history: [] };
  const text = await store.get(ADMIN_ANNOUNCEMENT_HISTORY_KEY);
  if (!text) return { status: 'missing', history: [] };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return { status: 'invalid', history: [] };
    return {
      status: 'ok',
      history: parsed
        .map(normalizeAnnouncementHistoryEntry)
        .slice(0, ADMIN_ANNOUNCEMENT_HISTORY_LIMIT),
    };
  } catch {
    return { status: 'invalid', history: [] };
  }
}

function isAnnouncementActive(announcement: AnnouncementRecord, now = Date.now()) {
  if (!announcement.enabled || !announcement.message) return false;
  if (!announcement.expiresAt) return true;
  return new Date(announcement.expiresAt).getTime() > now;
}

function isServiceMaintenanceAdminBypass(request: Request, url: URL) {
  const pathname = url.pathname;
  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    (pathname === '/admin' ||
      pathname === '/admin/' ||
      pathname === '/admin.js' ||
      pathname === '/clearable-editors.js' ||
      pathname === '/admin.css' ||
      pathname === '/designsystem/assets/favicon.svg' ||
      pathname === '/designsystem/assets/logo-wordmark.svg' ||
      pathname === '/designsystem/fonts/PretendardVariable.woff2')
  ) {
    return true;
  }
  if (
    pathname === '/api/admin/login' ||
    pathname === '/api/admin/logout' ||
    pathname === '/api/admin/session' ||
    pathname === '/api/admin/service-status' ||
    pathname === ADMIN_MAINTENANCE_PREVIEW_PATH
  ) {
    return true;
  }
  return false;
}

async function handleAdminMaintenancePreview(request: Request, env: AppEnv) {
  const methodError = adminApiMethodAllowed(request, ['GET', 'HEAD']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);
  return withSecurityHeaders(serviceMaintenancePreviewResponse(request));
}

function serviceStatusAdminPayload(state: ServiceMaintenanceState) {
  const timestamp = (value: unknown) => {
    if (typeof value === 'string' && !Number.isNaN(new Date(value).getTime())) {
      return new Date(value).toISOString();
    }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      return new Date(value).toISOString();
    }
    return null;
  };
  return {
    enabled: state.enabled === true,
    revision: Number.isSafeInteger(state.revision) && state.revision >= 0 ? state.revision : 0,
    updatedAt: timestamp(state.updatedAt),
    activatedAt: timestamp(state.activatedAt),
    settlesAt: timestamp(state.settlesAt),
  };
}

async function handleAdminServiceStatus(request: Request, env: AppEnv) {
  const methodError = adminApiMethodAllowed(request, ['GET', 'HEAD', 'POST']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  if (request.method === 'GET' || request.method === 'HEAD') {
    const state = await readServiceMaintenance(env, { fresh: true });
    if (state.controlUnavailable) {
      return json({ error: 'SERVICE_CONTROL_UNAVAILABLE' }, 503);
    }
    return json({
      generatedAt: new Date().toISOString(),
      serviceStatus: serviceStatusAdminPayload(state),
    });
  }

  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody);
  const body = parsedBody.value;
  const keys = isJsonObject(body) ? Object.keys(body) : [];
  if (
    !isJsonObject(body) ||
    keys.length !== 3 ||
    !keys.includes('enabled') ||
    !keys.includes('expectedRevision') ||
    !keys.includes('requestId') ||
    typeof body.enabled !== 'boolean' ||
    typeof body.expectedRevision !== 'number' ||
    !Number.isSafeInteger(body.expectedRevision) ||
    body.expectedRevision < 0 ||
    typeof body.requestId !== 'string' ||
    !ADMIN_DEVELOPER_API_REQUEST_ID_RE.test(body.requestId)
  ) {
    return json({ error: 'INVALID_REQUEST' }, 400);
  }

  const result = await updateServiceMaintenance(env, {
    enabled: body.enabled,
    expectedRevision: body.expectedRevision,
    requestId: body.requestId,
  });
  if (result.status === 'unavailable') {
    return json({ error: 'SERVICE_CONTROL_UNAVAILABLE' }, 503);
  }
  if (result.status === 'conflict') {
    return json(
      {
        error: 'SERVICE_STATUS_CONFLICT',
        serviceStatus: serviceStatusAdminPayload(result.state),
      },
      409,
    );
  }
  return json({
    ok: true,
    generatedAt: new Date().toISOString(),
    serviceStatus: serviceStatusAdminPayload(result.state),
  });
}

async function readAdminAnnouncement(env: AppEnv) {
  const store = getAdminConfigStore(env);
  if (!store) return { status: 'unbound', announcement: normalizeAnnouncementRecord({}) };
  const text = await store.get(ADMIN_ANNOUNCEMENT_KEY);
  if (!text) return { status: 'missing', announcement: normalizeAnnouncementRecord({}) };
  try {
    return {
      status: 'ok',
      announcement: normalizeAnnouncementRecord(JSON.parse(text)),
    };
  } catch {
    return { status: 'invalid', announcement: normalizeAnnouncementRecord({}) };
  }
}

function normalizeAnnouncementControlState(payload: unknown) {
  const source = isJsonObject(payload) ? payload.announcementState : null;
  if (
    !isJsonObject(source) ||
    typeof source.revision !== 'number' ||
    !Number.isSafeInteger(source.revision) ||
    source.revision < 0 ||
    !Array.isArray(source.history) ||
    source.history.length > ADMIN_ANNOUNCEMENT_HISTORY_LIMIT
  ) {
    return null;
  }
  const rawHistory = source.history;
  const announcement = normalizeAnnouncementRecord(source.announcement);
  const history = rawHistory.map(normalizeAnnouncementHistoryEntry);
  if (!canonicalAnnouncementWireRecordMatches(source.announcement, announcement)) return null;
  const invalidHistory = history.some((entry, index) => {
    const candidate = rawHistory[index];
    return (
      !ADMIN_ANNOUNCEMENT_ID_RE.test(entry.id) ||
      !entry.updatedAt ||
      !canonicalAnnouncementWireRecordMatches(candidate, entry) ||
      !isJsonObject(candidate) ||
      candidate.action !== getAnnouncementHistoryAction(entry)
    );
  });
  if (invalidHistory) return null;
  if (source.revision === 0) {
    if (
      announcement.id ||
      announcement.message ||
      announcement.updatedAt ||
      !isJsonObject(source.announcement) ||
      source.announcement.expiresAt !== null ||
      history.length > 0
    ) {
      return null;
    }
  } else {
    const latest = history[0];
    if (
      !announcement.id ||
      !announcement.updatedAt ||
      !latest ||
      latest.id !== announcement.id ||
      latest.message !== announcement.message ||
      latest.enabled !== announcement.enabled ||
      latest.expiresAt !== announcement.expiresAt ||
      latest.updatedAt !== announcement.updatedAt ||
      latest.action !== getAnnouncementHistoryAction(announcement)
    ) {
      return null;
    }
  }
  return { revision: source.revision, announcement, history };
}

async function readLegacyAdminAnnouncementState(env: AppEnv) {
  const [{ status, announcement }, historyResult] = await Promise.all([
    readAdminAnnouncement(env),
    readAdminAnnouncementHistory(env),
  ]);
  return {
    status,
    revision: 0,
    announcement,
    history: historyResult.history,
  };
}

function legacyAnnouncementBaseHistory(state: {
  revision?: unknown;
  announcement: unknown;
  history: unknown;
}) {
  const validEntry = (entry: unknown): entry is JsonObject & { id: string; updatedAt: string } =>
    isJsonObject(entry) &&
    typeof entry.id === 'string' &&
    ADMIN_ANNOUNCEMENT_ID_RE.test(entry.id) &&
    typeof entry.updatedAt === 'string' &&
    !Number.isNaN(new Date(entry.updatedAt).getTime());
  const history = Array.isArray(state?.history)
    ? state.history.filter(validEntry).map((entry) =>
        normalizeAnnouncementHistoryEntry({
          action:
            entry.enabled && entry.message ? 'published' : entry.message ? 'disabled' : 'cleared',
          id: entry.id,
          message: typeof entry.message === 'string' ? entry.message : '',
          enabled: entry.enabled === true,
          expiresAt: typeof entry.expiresAt === 'string' ? entry.expiresAt : null,
          updatedAt: entry.updatedAt,
        }),
      )
    : [];
  const announcement = normalizeAnnouncementRecord(
    isJsonObject(state.announcement) ? state.announcement : {},
  );
  if (!validEntry(announcement)) return history;
  const currentEntry = normalizeAnnouncementHistoryEntry({
    ...announcement,
    action: getAnnouncementHistoryAction(announcement),
  });
  const seen = new Set<unknown>([currentEntry.id]);
  const withoutCurrent = history.filter((entry: { id: unknown }) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
  return [currentEntry, ...withoutCurrent].slice(0, ADMIN_ANNOUNCEMENT_HISTORY_LIMIT);
}

function adminAnnouncementPayload(state: {
  revision: unknown;
  announcement: unknown;
  history: unknown;
}) {
  const announcement = normalizeAnnouncementRecord(
    isJsonObject(state.announcement) ? state.announcement : {},
  );
  return {
    generatedAt: new Date().toISOString(),
    revision: state.revision,
    announcement,
    active: isAnnouncementActive({
      ...announcement,
      expiresAt: announcement.expiresAt ?? '',
    }),
    history: state.history,
  };
}

async function readCanonicalAdminAnnouncementState(
  env: AppEnv,
  { allowLegacyFallback = true, fresh = false } = {},
) {
  const controlled = await readAdminAnnouncementControl(env, { fresh });
  if (controlled.status === 'ok') {
    const state = normalizeAnnouncementControlState(controlled.payload);
    if (!state) return { status: 'unavailable', state: null };
    if (state.revision > 0) return { status: 'ok', state };
    const legacy = await readLegacyAdminAnnouncementState(env);
    return legacy.status === 'unbound'
      ? { status: 'ok', state }
      : { status: 'legacy', state: legacy };
  }
  if (controlled.status !== 'unbound' || !allowLegacyFallback) {
    return { status: 'unavailable', state: null };
  }
  const legacy = await readLegacyAdminAnnouncementState(env);
  return legacy.status === 'unbound'
    ? { status: 'unavailable', state: null }
    : { status: 'legacy', state: legacy };
}

function announcementPublicPayload(value: unknown) {
  const announcement = normalizeAnnouncementRecord(isJsonObject(value) ? value : {});
  if (
    !isAnnouncementActive({
      ...announcement,
      expiresAt: announcement.expiresAt ?? '',
    })
  ) {
    return { enabled: false };
  }
  return {
    enabled: true,
    id: announcement.id,
    message: announcement.message,
    expiresAt: announcement.expiresAt,
  };
}

async function handleAdminAnnouncement(request: Request, env: AppEnv) {
  const methodError = adminApiMethodAllowed(request, ['GET', 'HEAD', 'POST']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  if (request.method === 'GET' || request.method === 'HEAD') {
    const current = await readCanonicalAdminAnnouncementState(env, { fresh: true });
    if (!current.state) {
      return json(
        {
          error:
            current.status === 'unavailable'
              ? 'ADMIN_ANNOUNCEMENT_CONTROL_UNAVAILABLE'
              : 'ADMIN_CONFIG_NOT_CONFIGURED',
        },
        503,
      );
    }
    return json(adminAnnouncementPayload(current.state));
  }

  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody);
  if (!isJsonObject(parsedBody.value)) return json({ error: 'INVALID_REQUEST' }, 400);
  const body = parsedBody.value;
  const keys = Object.keys(body);
  // Tabs opened before this deployment still submit the legacy three-field
  // body. Give them a race-safe CAS transition while the versioned admin
  // shell rolls forward; newly loaded tabs supply their own replay key.
  const legacyRequest =
    keys.length === 3 &&
    keys.includes('message') &&
    keys.includes('enabled') &&
    keys.includes('expiresAt');
  const fencedRequest =
    keys.length === 5 &&
    keys.includes('message') &&
    keys.includes('enabled') &&
    keys.includes('expiresAt') &&
    keys.includes('expectedRevision') &&
    keys.includes('requestId');
  if (
    (!legacyRequest && !fencedRequest) ||
    typeof body.message !== 'string' ||
    typeof body.enabled !== 'boolean' ||
    (fencedRequest &&
      (typeof body.expectedRevision !== 'number' ||
        !Number.isSafeInteger(body.expectedRevision) ||
        body.expectedRevision < 0 ||
        typeof body.requestId !== 'string' ||
        !ADMIN_DEVELOPER_API_REQUEST_ID_RE.test(body.requestId)))
  ) {
    return json({ error: 'INVALID_REQUEST' }, 400);
  }
  const message = String(body?.message || '')
    .trim()
    .slice(0, 280);
  const enabled = Boolean(body?.enabled) && Boolean(message);
  const expiresAtRaw = String(body?.expiresAt || '').trim();
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    return json({ error: 'INVALID_EXPIRES_AT' }, 400);
  }
  const current = await readCanonicalAdminAnnouncementState(env, {
    allowLegacyFallback: false,
    fresh: true,
  });
  if (!current.state) {
    return json({ error: 'ADMIN_ANNOUNCEMENT_CONTROL_UNAVAILABLE' }, 503);
  }
  const canonicalExpiresAt = expiresAt ? expiresAt.toISOString() : null;
  if (
    legacyRequest &&
    current.state.announcement.message === message &&
    current.state.announcement.enabled === enabled &&
    current.state.announcement.expiresAt === canonicalExpiresAt
  ) {
    // A pre-deployment tab has no replay key. Treat an exact canonical retry
    // as a read-back so a lost success response cannot create another ID or
    // duplicate history entry.
    return json({ ok: true, ...adminAnnouncementPayload(current.state) });
  }
  if (legacyRequest && expiresAt && expiresAt.getTime() <= Date.now()) {
    return json({ error: 'EXPIRES_AT_IN_PAST' }, 400);
  }
  const requestId = fencedRequest
    ? typeof body.requestId === 'string'
      ? body.requestId
      : ''
    : `legacy-${Date.now().toString(36)}-${
        crypto.randomUUID() || Math.random().toString(36).slice(2, 18) || 'fallback'
      }`;
  const updated = await updateAdminAnnouncementControl(env, {
    message,
    enabled,
    expiresAt: canonicalExpiresAt,
    expectedRevision:
      fencedRequest && typeof body.expectedRevision === 'number'
        ? body.expectedRevision
        : current.state.revision,
    requestId,
    baseHistory: current.status === 'legacy' ? legacyAnnouncementBaseHistory(current.state) : [],
  });
  const state = normalizeAnnouncementControlState(updated.payload);
  if (updated.status === 'conflict' && state) {
    return json(
      {
        error: 'ADMIN_ANNOUNCEMENT_CONFLICT',
        ...adminAnnouncementPayload(state),
      },
      409,
    );
  }
  if (updated.status === 'rejected') {
    const error = String(isJsonObject(updated.payload) ? updated.payload.error || '' : '');
    const rejectedStatus: Readonly<Record<string, number>> = {
      EXPIRES_AT_IN_PAST: 400,
      INVALID_REQUEST: 400,
      INVALID_JSON: 400,
      REQUEST_TOO_LARGE: 413,
      JSON_REQUIRED: 415,
    };
    if (Object.hasOwn(rejectedStatus, error)) {
      return json({ error }, rejectedStatus[error]);
    }
  }
  if (updated.status !== 'ok' || !state) {
    return json({ error: 'ADMIN_ANNOUNCEMENT_CONTROL_UNAVAILABLE' }, 503);
  }
  return json({ ok: true, ...adminAnnouncementPayload(state) });
}

async function handlePublicAnnouncement(request: Request, env: AppEnv) {
  const methodError = adminApiMethodAllowed(request, ['GET', 'HEAD']);
  if (methodError) return methodError;
  const current = await readCanonicalAdminAnnouncementState(env);
  const announcement = current.state?.announcement || normalizeAnnouncementRecord({});
  return json(announcementPublicPayload(announcement), 200, {
    'Cache-Control': 'public, max-age=30',
  });
}

function isLifetimeRoomCount(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

interface AppDefaultCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function isAppDefaultCache(value: unknown): value is AppDefaultCache {
  return (
    isJsonObject(value) && typeof value.match === 'function' && typeof value.put === 'function'
  );
}

function getAppDefaultCache() {
  const cacheStorage: unknown = typeof caches === 'undefined' ? null : caches;
  if (!isJsonObject(cacheStorage) || !isAppDefaultCache(cacheStorage.default)) return null;
  return cacheStorage.default;
}

function lifetimeRoomCountCacheKey(request: Request, nowMs: number = Date.now()) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return new Request(new URL(`/.well-known/mxqr-cache/about-room-count/${day}`, request.url), {
    method: 'GET',
  });
}

async function readLifetimeRoomCountSnapshot(
  request: Request,
  env: AppEnv,
  ctx: AppExecutionContext | undefined,
) {
  const cache = getAppDefaultCache();
  const cacheKey = lifetimeRoomCountCacheKey(request);
  if (cache?.match) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const payload: unknown = await cached.json();
        const cachedCount = isJsonObject(payload) ? payload.roomsOpened : undefined;
        if (isLifetimeRoomCount(cachedCount)) return cachedCount;
      }
    } catch {
      // Cache corruption or an unavailable cache must not prevent the static
      // About document from rendering. Fall through to the canonical D1 row.
    }
  }

  const db = getAdminDb(env);
  if (!db?.prepare) return null;

  try {
    const statement = db
      .prepare(`SELECT count FROM ${LIFETIME_METRICS_TABLE} WHERE event = ?1 LIMIT 1`)
      .bind('room_opened');
    const row = typeof statement.first === 'function' ? await statement.first() : null;
    const roomsOpened = Number(isJsonObject(row) ? row.count : undefined);
    if (!isLifetimeRoomCount(roomsOpened)) return null;

    if (cache?.put) {
      const cacheWrite = cache.put(
        cacheKey,
        new Response(JSON.stringify({ roomsOpened }), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
          },
        }),
      );
      if (typeof ctx?.waitUntil === 'function') {
        ctx.waitUntil(cacheWrite);
      } else {
        await cacheWrite;
      }
    }
    return roomsOpened;
  } catch {
    return null;
  }
}

function renderAdminPage(request: Request, env: AppEnv) {
  const body =
    request.method === 'HEAD'
      ? null
      : `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>MUSIXQUARE Admin</title>
  <link rel="icon" href="/designsystem/assets/favicon.svg">
  <link rel="stylesheet" href="/admin.css?v=${ADMIN_ASSET_VERSION}">
  <script src="/clearable-editors.js?v=${ADMIN_ASSET_VERSION}" defer></script>
  <script src="/admin.js?v=${ADMIN_ASSET_VERSION}" defer></script>
</head>
<body>
  <main class="admin-shell" data-admin-configured="${isAdminConfigured(env) ? 'true' : 'false'}" data-admin-asset-version="${ADMIN_ASSET_VERSION}">
    <section class="login-panel" data-login-panel>
      <span class="admin-wordmark" aria-label="MUSIXQUARE"></span>
      <h1>Admin Dashboard</h1>
      <form data-login-form>
        <div class="login-row">
          <input id="admin-password" class="login-password" name="password" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password" required>
          <button class="login-submit" type="submit" aria-label="Log in">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.59 5.58L12 20l8-8-8-8z"></path>
            </svg>
          </button>
        </div>
        <p class="status" data-login-status></p>
      </form>
    </section>

    <section class="dashboard" data-dashboard hidden>
      <header class="dashboard-header">
        <div>
          <span class="admin-wordmark admin-wordmark-small" aria-label="MUSIXQUARE"></span>
          <h1 data-dashboard-title>Analytics</h1>
          <p data-updated-at>Loading metrics...</p>
        </div>
        <div class="header-actions">
          <button class="service-status-trigger is-loading" type="button" aria-haspopup="dialog" data-service-status-trigger>
            <span class="service-status-dot" aria-hidden="true" data-service-status-dot></span>
            <span data-service-status-label>Checking status</span>
          </button>
          <button type="button" data-refresh>Refresh</button>
          <button type="button" data-logout>Logout</button>
        </div>
      </header>
      <dialog class="service-status-dialog" aria-labelledby="service-status-title" data-service-status-dialog>
        <div class="service-status-dialog-card">
          <div class="service-status-dialog-head">
            <div class="service-status-heading">
              <span class="service-status-dialog-dot" aria-hidden="true"></span>
              <div>
                <span>Global service status</span>
                <h2 id="service-status-title" data-service-status-state>Checking status</h2>
              </div>
            </div>
            <button class="service-status-close" type="button" aria-label="Close service status" data-service-status-cancel>&times;</button>
          </div>
          <p class="service-status-description" data-service-status-description>
            Reading the current public service state.
          </p>
          <p data-service-status-updated></p>
          <div class="service-status-preview" aria-label="Maintenance page preview">
            <span>PUBLIC MESSAGE</span>
            <strong>MUSIXQUARE is temporarily unavailable.</strong>
            <p>Visitors receive this page in English with a second line in their system language.</p>
          </div>
          <p class="service-status-warning">
            Maintenance mode asks public App, API, realtime, and scheduled work to stop. The App refreshes this state in the background so a broken control binding cannot stall users; a cold edge isolate can briefly admit traffic before its first refresh. Direct R2 uploads authorized before activation can also finish. Use a pre-Worker edge/deployment control plus a storage drain or credential rotation for a strict traffic or write freeze. This dashboard remains available so you can safely end maintenance.
          </p>
          <p class="service-status-error" role="alert" data-service-status-error></p>
          <div class="service-status-dialog-actions">
            <button class="is-secondary" type="button" data-service-status-preview>Preview page</button>
            <button class="is-secondary" type="button" data-service-status-cancel>Cancel</button>
            <button class="service-status-confirm" type="button" data-service-status-confirm disabled>Enter maintenance mode</button>
          </div>
        </div>
      </dialog>
      <nav class="admin-tabs" aria-label="Admin sections">
        <button class="is-active" type="button" data-admin-tab="operations">Analytics</button>
        <button type="button" data-admin-tab="pro-rooms">PRO Rooms</button>
        <button type="button" data-admin-tab="articles">Articles</button>
        <button type="button" data-admin-tab="announcements">Announcements</button>
      </nav>
      <section class="admin-view is-active" data-admin-view="operations">
        <section class="metric-grid" data-metric-cards></section>
        <section class="panel">
          <div class="panel-head">
            <h2>Last 24 hours</h2>
          </div>
          <div class="chart" data-hourly-chart></div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>Seven day trend</h2>
          </div>
          <div class="trend-list" data-daily-list></div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>Thirty day trend</h2>
          </div>
          <div class="spectrum-chart" data-monthly-chart></div>
        </section>
        <section class="panel compact">
          <div class="panel-head">
            <h2>Signals</h2>
          </div>
          <div class="signal-grid" data-signal-grid></div>
        </section>
      </section>
      <section class="admin-view" data-admin-view="pro-rooms" hidden>
        <section class="pro-room-management">
          <section class="panel pro-room-register-panel">
            <div class="panel-head">
              <div>
                <h2>Register a PRO room</h2>
                <p>Register an available room number. Reusing a deleted number creates a new, isolated room.</p>
              </div>
              <span>1 GiB per room</span>
            </div>
            <form class="pro-room-form" data-pro-room-form>
              <label class="pro-room-field pro-room-code-field">
                <span>Room number</span>
                <input name="roomCode" type="text" inputmode="numeric" autocomplete="off" maxlength="6" pattern="0[0-9]{5}" placeholder="000002" aria-describedby="pro-room-code-help" data-pro-room-code required>
                <small id="pro-room-code-help">Six digits beginning with 0</small>
              </label>
              <label class="pro-room-field">
                <span>Purpose / label</span>
                <input name="label" type="text" autocomplete="off" maxlength="64" placeholder="Friends listening room" data-pro-room-label>
                <small>Optional · visible only to administrators</small>
              </label>
              <button class="pro-room-register" type="submit" data-pro-room-register>Register</button>
            </form>
            <p class="pro-room-status" role="status" aria-live="polite" data-pro-room-status></p>
          </section>

          <section class="pro-room-claim panel" aria-live="polite" data-pro-room-claim hidden>
            <div class="pro-room-claim-copy">
              <strong data-pro-room-claim-title>Owner activation link</strong>
              <span data-pro-room-claim-expiry></span>
            </div>
            <div class="pro-room-claim-row">
              <input type="text" readonly aria-label="Owner activation link" data-pro-room-claim-url>
              <button type="button" data-pro-room-claim-copy>Copy link</button>
              <button class="is-secondary" type="button" aria-label="Dismiss activation link" data-pro-room-claim-dismiss>Dismiss</button>
            </div>
            <p>This one-time ownership credential exists only in this page's memory. Copy it privately; dismissing or leaving this page clears it.</p>
          </section>

          <section class="pro-room-list-section">
            <div class="pro-room-list-head">
              <div>
                <h2>Registered rooms</h2>
                <p>Expand a room to manage access, lifecycle, and API keys.</p>
                <p data-pro-room-list-status>Loading PRO rooms...</p>
              </div>
            </div>
            <div class="pro-room-list" data-pro-room-list></div>
          </section>
        </section>
      </section>
      <section class="admin-view" data-admin-view="articles" hidden>
        <section class="article-management">
          <p class="article-status" data-article-status>Loading articles...</p>
          <div class="article-list" data-article-list></div>
        </section>
      </section>
      <section class="admin-view" data-admin-view="announcements" hidden>
        <section class="announcement-management">
          <form class="announcement-form" data-announcement-form>
            <div class="announcement-topline">
              <label class="announcement-switch">
                <input type="checkbox" name="enabled" data-announcement-enabled>
                <span class="announcement-switch-track" aria-hidden="true"></span>
                <span>Active</span>
              </label>
            </div>
            <label class="announcement-field">
              <span>Message</span>
              <textarea name="message" rows="4" maxlength="280" placeholder="Write an announcement" data-announcement-message></textarea>
            </label>
            <label class="announcement-field announcement-expires">
              <span>Expires</span>
              <input type="text" name="expiresAt" inputmode="numeric" autocomplete="off" placeholder="YYYY-MM-DD HH:MM" data-announcement-expires>
            </label>
            <div class="announcement-actions">
              <button type="submit" data-announcement-save>Save</button>
              <button type="button" data-announcement-clear>Clear</button>
            </div>
            <p class="announcement-status" data-announcement-status>Loading announcement...</p>
          </form>
          <article class="announcement-preview" data-announcement-preview hidden></article>
          <section class="announcement-history" aria-label="Announcement history">
            <div class="announcement-history-head">
              <span>History</span>
              <small data-announcement-history-status></small>
            </div>
            <div class="announcement-history-list" data-announcement-history-list></div>
          </section>
        </section>
      </section>
    </section>
  </main>
</body>
</html>`;

  return withSecurityHeaders(
    new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        ...APP_SHELL_FRESH_CACHE_HEADERS,
      },
    }),
    {
      'X-Robots-Tag': 'noindex, nofollow',
    },
  );
}

async function verifyTurnstileToken(turnstileToken: string, request: Request, env: AppEnv) {
  if (!isTurnstileConfigured(env) || typeof turnstileToken !== 'string' || !turnstileToken) {
    return false;
  }
  const secret = getTurnstileSecret(env);
  if (typeof secret !== 'string' || !secret) return false;

  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', turnstileToken);
  const ip = getClientIp(request);
  if (ip !== 'unknown') body.set('remoteip', ip);

  try {
    const { payload } = await fetchJsonWithTimeout(
      TURNSTILE_VERIFY_ENDPOINT,
      { method: 'POST', body },
      UPSTREAM_JSON_TIMEOUT_MS,
      TURNSTILE_RESPONSE_MAX_BYTES,
    );
    if (!isJsonObject(payload)) return false;
    return (
      !!payload.success &&
      payload.action === 'mxqr-capability' &&
      typeof payload.hostname === 'string' &&
      isAllowedTurnstileHostname(payload.hostname, env)
    );
  } catch {
    return false;
  }
}

interface SensitiveRequestTrust {
  isTrusted: boolean;
  sameOriginInferred?: boolean;
  headers: HeadersInit;
}

interface SensitiveRequestOptions {
  authenticatedRateLimit?: number;
  combinePerCapabilityRateLimit?: boolean;
  perCapabilityLimit?: number;
}

async function guardSensitiveRequest(
  request: Request,
  env: AppEnv,
  trust: SensitiveRequestTrust,
  capabilityScope: string,
  rateLimitKey: string,
  rateLimit: number = 60,
  options: SensitiveRequestOptions = {},
) {
  if (hasInvalidCapabilitySecret(env)) {
    return json({ error: 'CAPABILITY_SECRET_INVALID' }, 503, trust.headers);
  }
  if (!isCapabilityAuthEnabled(env)) {
    if (!trust.isTrusted) return json({ error: 'Forbidden' }, 403, trust.headers);
    if (!allowUnguardedPaidApis(env)) {
      return json({ error: 'CAPABILITY_NOT_CONFIGURED' }, 503, trust.headers);
    }
    const rate = await checkPaidRateLimit(request, env, rateLimitKey, rateLimit, 60);
    if (rate.status !== 'ok') return rateLimitUnavailableResponse(trust.headers);
    if (!rate.allowed) return rateLimitResponse(trust.headers, rate.retryAfterSeconds);
    return null;
  }

  const authenticatedRateLimit =
    typeof options.authenticatedRateLimit === 'number' &&
    Number.isSafeInteger(options.authenticatedRateLimit)
      ? options.authenticatedRateLimit
      : rateLimit;
  const perCapabilityLimit =
    typeof options.perCapabilityLimit === 'number' &&
    Number.isSafeInteger(options.perCapabilityLimit) &&
    options.perCapabilityLimit > 0
      ? options.perCapabilityLimit
      : null;
  if (options.combinePerCapabilityRateLimit === true && perCapabilityLimit !== null) {
    const token = readCapabilityToken(request);
    const capabilityVerified = await verifyCapabilityToken(token, request, env, capabilityScope);
    const tokenIdentity = capabilityVerified
      ? (await hmacSha256(getCapabilitySecret(env), `rate:${token}`)).slice(0, 32)
      : null;
    const rate = await checkPaidRateLimitPair(
      request,
      env,
      rateLimitKey,
      authenticatedRateLimit,
      60,
      tokenIdentity ? { identity: tokenIdentity, limit: perCapabilityLimit, cost: 1 } : null,
    );
    if (rate.status !== 'ok') return rateLimitUnavailableResponse(trust.headers);
    if (!rate.allowed) return rateLimitResponse(trust.headers, rate.retryAfterSeconds);
    if (!capabilityVerified) {
      return json({ error: 'CAPABILITY_REQUIRED' }, 401, trust.headers);
    }
    return null;
  }

  const rate = await checkPaidRateLimit(request, env, rateLimitKey, authenticatedRateLimit, 60);
  if (rate.status !== 'ok') return rateLimitUnavailableResponse(trust.headers);
  if (!rate.allowed) return rateLimitResponse(trust.headers, rate.retryAfterSeconds);

  const token = readCapabilityToken(request);
  if (!(await verifyCapabilityToken(token, request, env, capabilityScope))) {
    return json({ error: 'CAPABILITY_REQUIRED' }, 401, trust.headers);
  }

  if (perCapabilityLimit !== null) {
    const tokenIdentity = (await hmacSha256(getCapabilitySecret(env), `rate:${token}`)).slice(
      0,
      32,
    );
    const capabilityRate = await checkPaidRateLimit(
      request,
      env,
      `${rateLimitKey}-capability`,
      perCapabilityLimit,
      60,
      tokenIdentity,
    );
    if (capabilityRate.status !== 'ok') return rateLimitUnavailableResponse(trust.headers);
    if (!capabilityRate.allowed) {
      return rateLimitResponse(trust.headers, capabilityRate.retryAfterSeconds);
    }
  }
  return null;
}

async function handleSecurityConfig(request: Request, env: AppEnv) {
  const trust = trustedCors(request, 'GET, OPTIONS', env, { allowInferred: true });
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);
  if (!trust.isTrusted) return json({ error: 'Forbidden' }, 403, headers);
  if (hasInvalidCapabilitySecret(env)) {
    return json({ error: 'CAPABILITY_SECRET_INVALID' }, 503, headers);
  }

  const turnstileConfigured = isTurnstileConfigured(env);
  const capabilityRequired = isCapabilityAuthEnabled(env);
  const proofOfWorkRequired = capabilityRequired && !turnstileConfigured;
  const proofOfWorkDifficulty = proofOfWorkRequired ? parseCapabilityPowDifficulty(env) : 0;

  return json(
    {
      capabilityRequired,
      turnstileSiteKey: turnstileConfigured ? getTurnstileSiteKey(env) : '',
      turnstileRequired: capabilityRequired && turnstileConfigured,
      proofOfWorkRequired,
      proofOfWorkDifficulty,
      proofOfWorkAdaptive: proofOfWorkRequired && isCapabilityPowAdaptiveEnabled(env),
      proofOfWorkMaxDifficulty: proofOfWorkRequired
        ? parseCapabilityPowMaxDifficulty(env, proofOfWorkDifficulty)
        : 0,
      proofOfWorkTtl: proofOfWorkRequired ? parseCapabilityPowTtl(env) : 0,
      ttl: parseCapabilityTtl(env),
    },
    200,
    headers,
  );
}

async function handleCapabilityChallenge(request: Request, env: AppEnv) {
  const trust = trustedCors(request, 'POST, OPTIONS', env, { allowInferred: true });
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);
  if (hasInvalidCapabilitySecret(env)) {
    return json({ error: 'CAPABILITY_SECRET_INVALID' }, 503, headers);
  }
  if (!isCapabilityAuthEnabled(env)) {
    return json({ capabilityRequired: false }, 200, headers);
  }
  if (!trust.isTrusted) return json({ error: 'Forbidden' }, 403, headers);
  if (isTurnstileConfigured(env)) return json({ error: 'TURNSTILE_REQUIRED' }, 409, headers);

  const parsedBody = await readJsonBodyLimited(request, CAPABILITY_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody, headers);
  const body = isJsonObject(parsedBody.value) ? parsedBody.value : null;
  const scopes = parseRequestedScopes(body?.scopes);
  if (scopes.length === 0) return json({ error: 'Invalid scopes' }, 400, headers);
  const roomBurst = scopes.includes('realtime') || scopes.includes('turn');
  const challengeRateLimit = roomBurst ? ROOM_BURST_CAPABILITY_LIMIT : 30;
  const challengeRateKey = roomBurst ? 'capability-challenge-room' : 'capability-challenge';
  if (!(await checkRateLimit(request, challengeRateKey, challengeRateLimit, 60))) {
    return rateLimitResponse(headers);
  }
  const baselineDifficulty = parseCapabilityPowDifficulty(env);
  const pressure = await consumeCapabilityPowPressure(request, env, {
    roomBurst,
    baselineDifficulty,
  });
  return json(
    await createCapabilityPowChallenge(scopes, request, env, pressure.difficulty),
    200,
    headers,
  );
}

async function handleCapabilityToken(request: Request, env: AppEnv) {
  const trust = trustedCors(request, 'POST, OPTIONS', env, { allowInferred: true });
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);
  if (hasInvalidCapabilitySecret(env)) {
    return json({ error: 'CAPABILITY_SECRET_INVALID' }, 503, headers);
  }
  if (!isCapabilityAuthEnabled(env)) {
    return json({ capabilityRequired: false }, 200, headers);
  }
  if (!trust.isTrusted) return json({ error: 'Forbidden' }, 403, headers);

  const parsedBody = await readJsonBodyLimited(request, CAPABILITY_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody, headers);
  const body = isJsonObject(parsedBody.value) ? parsedBody.value : null;
  const scopes = parseRequestedScopes(body?.scopes);
  if (scopes.length === 0) return json({ error: 'Invalid scopes' }, 400, headers);
  const roomBurst = scopes.includes('realtime') || scopes.includes('turn');
  if (
    !(await checkRateLimit(
      request,
      roomBurst ? 'capability-token-room' : 'capability-token',
      roomBurst ? ROOM_BURST_CAPABILITY_LIMIT : 30,
      60,
    ))
  ) {
    return rateLimitResponse(headers);
  }

  if (isTurnstileConfigured(env) && typeof body?.turnstileToken === 'string') {
    if (!(await verifyTurnstileToken(body.turnstileToken, request, env))) {
      return json({ error: 'TURNSTILE_FAILED' }, 403, headers);
    }
    return json(await createCapabilityToken(scopes, request, env, 'turnstile'), 200, headers);
  }
  if (!isTurnstileConfigured(env)) {
    const baselineDifficulty = parseCapabilityPowDifficulty(env);
    const challenge = await verifyCapabilityPowProof(
      body?.proofOfWork,
      scopes,
      request,
      env,
      baselineDifficulty,
    );
    if (!challenge) {
      if (body?.proofOfWork && typeof body.proofOfWork === 'object') {
        await consumeCapabilityPowPressure(request, env, {
          roomBurst,
          baselineDifficulty,
        });
      }
      return json({ error: 'PROOF_OF_WORK_FAILED' }, 403, headers);
    }
    if (typeof challenge.iat !== 'number' || typeof challenge.nonce !== 'string') {
      return json({ error: 'PROOF_OF_WORK_FAILED' }, 403, headers);
    }
    // Reusing the same proof returns the same token and cannot extend expiry.
    return json(
      await createCapabilityToken(scopes, request, env, 'proof-of-work', {
        iat: challenge.iat,
        jti: challenge.nonce,
      }),
      200,
      headers,
    );
  }
  return json({ error: 'TURNSTILE_REQUIRED' }, 403, headers);
}

function clampMaxResults(raw: string | null, env: AppEnv) {
  const configuredMaxResults = env.YOUTUBE_SEARCH_MAX_RESULTS;
  const envDefault = Number.parseInt(
    typeof configuredMaxResults === 'string' ? configuredMaxResults : '',
    10,
  );
  const fallback = Number.isFinite(envDefault) ? envDefault : DEFAULT_MAX_RESULTS;
  const parsed = Number.parseInt(raw || String(fallback), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_RESULTS;
  return Math.min(MAX_RESULTS_LIMIT, Math.max(1, parsed));
}

function getBestThumbnail(thumbnails: unknown) {
  if (!isJsonObject(thumbnails)) return '';
  for (const key of ['high', 'medium', 'default', 'standard', 'maxres']) {
    const candidate = thumbnails[key];
    if (isJsonObject(candidate) && typeof candidate.url === 'string') return candidate.url;
  }
  return '';
}

const HTML_ENTITY_RE = /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/i;
const HTML_ENTITY_RE_G = /&(#\d+|#x[\da-f]+|[a-z][\da-z]+);/gi;
const HTML_ENTITY_FALLBACKS: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  bull: '\u2022',
  copy: '\u00a9',
  divide: '\u00f7',
  gt: '>',
  hellip: '\u2026',
  laquo: '\u00ab',
  ldquo: '\u201c',
  lsquo: '\u2018',
  lt: '<',
  mdash: '\u2014',
  middot: '\u00b7',
  nbsp: '\u00a0',
  ndash: '\u2013',
  plusmn: '\u00b1',
  quot: '"',
  raquo: '\u00bb',
  rdquo: '\u201d',
  reg: '\u00ae',
  rsquo: '\u2019',
  times: '\u00d7',
  trade: '\u2122',
};

function decodeNumericEntity(entity: string) {
  const isHex = entity.slice(0, 2).toLowerCase() === '#x';
  const raw = isHex ? entity.slice(2) : entity.slice(1);
  const codePoint = Number.parseInt(raw, isHex ? 16 : 10);
  if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return null;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return null;
  }
}

function decodeHtmlEntities(value: string | null | undefined) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!HTML_ENTITY_RE.test(text)) return text;
  return text.replace(HTML_ENTITY_RE_G, (match, entity: string) => {
    if (entity[0] === '#') return decodeNumericEntity(entity) || match;
    return HTML_ENTITY_FALLBACKS[entity.toLowerCase()] || match;
  });
}

function normalizeExternalText(value: unknown) {
  return typeof value === 'string' ? decodeHtmlEntities(value).trim() : '';
}

interface YouTubeSearchResult {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  publishedAt: string;
  url: string;
}

function normalizeResults(items: unknown): YouTubeSearchResult[] {
  if (!Array.isArray(items)) return [];
  const results: YouTubeSearchResult[] = [];
  for (const item of items) {
    if (!isJsonObject(item)) continue;
    const id = isJsonObject(item.id) ? item.id : null;
    const snippet = isJsonObject(item.snippet) ? item.snippet : null;
    const videoId = id?.videoId;
    if (typeof videoId !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) continue;
    results.push({
      videoId,
      title: normalizeExternalText(snippet?.title),
      channelTitle: normalizeExternalText(snippet?.channelTitle),
      thumbnailUrl: getBestThumbnail(snippet?.thumbnails),
      publishedAt: typeof snippet?.publishedAt === 'string' ? snippet.publishedAt : '',
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }
  return results;
}

function normalizePlaylistEntry(items: unknown, playlistId: string | undefined) {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (!isJsonObject(item)) continue;
    const contentDetails = isJsonObject(item.contentDetails) ? item.contentDetails : null;
    const snippet = isJsonObject(item.snippet) ? item.snippet : null;
    const resourceId = isJsonObject(snippet?.resourceId) ? snippet.resourceId : null;
    const status = isJsonObject(item.status) ? item.status : null;
    const videoId = contentDetails?.videoId || resourceId?.videoId;
    if (typeof videoId !== 'string' || !YOUTUBE_VIDEO_ID_RE.test(videoId)) continue;

    const privacyStatus = status?.privacyStatus;
    if (privacyStatus === 'private') continue;

    const title = normalizeExternalText(snippet?.title).slice(0, 300);
    if (!title || title === 'Deleted video' || title === 'Private video') continue;
    return { playlistId, videoId, title };
  }
  return null;
}

function normalizePlaylistManifestItem(item: unknown) {
  if (!isJsonObject(item)) return null;
  const contentDetails = isJsonObject(item.contentDetails) ? item.contentDetails : null;
  const snippet = isJsonObject(item.snippet) ? item.snippet : null;
  const resourceId = isJsonObject(snippet?.resourceId) ? snippet.resourceId : null;
  const status = isJsonObject(item.status) ? item.status : null;
  const videoId = contentDetails?.videoId || resourceId?.videoId;
  if (typeof videoId !== 'string' || !YOUTUBE_VIDEO_ID_RE.test(videoId)) return null;

  const privacyStatus = status?.privacyStatus;
  if (privacyStatus === 'private') return null;

  const title = normalizeExternalText(snippet?.title).slice(0, 300);
  if (!title || title === 'Deleted video' || title === 'Private video') return null;
  return { videoId, title };
}

function parsePlaylistManifestPage(payload: unknown) {
  if (!isJsonObject(payload)) return null;
  if (!Array.isArray(payload.items)) return null;
  const pageInfo = isJsonObject(payload.pageInfo) ? payload.pageInfo : null;
  const totalResults = pageInfo?.totalResults;
  if (typeof totalResults !== 'number' || !Number.isSafeInteger(totalResults) || totalResults < 0) {
    return null;
  }
  const nextPageToken = payload.nextPageToken;
  if (nextPageToken !== undefined && (typeof nextPageToken !== 'string' || !nextPageToken)) {
    return null;
  }
  return {
    items: payload.items,
    totalResults,
    nextPageToken: nextPageToken || null,
  };
}

function normalizeUpstreamError(payload: unknown) {
  const error = isJsonObject(payload) && isJsonObject(payload.error) ? payload.error : null;
  const errors = Array.isArray(error?.errors) ? error.errors : [];
  const firstError = isJsonObject(errors[0]) ? errors[0] : null;
  return {
    reason:
      (typeof firstError?.reason === 'string' && firstError.reason) ||
      (typeof error?.status === 'string' && error.status) ||
      'unknown',
    message:
      (typeof firstError?.message === 'string' && firstError.message) ||
      (typeof error?.message === 'string' && error.message) ||
      '',
  };
}

function getClientStatusForUpstreamError(status: number, reason: string) {
  const quotaReasons = new Set([
    'quotaExceeded',
    'dailyLimitExceeded',
    'rateLimitExceeded',
    'userRateLimitExceeded',
  ]);
  if (quotaReasons.has(reason)) return 429;
  if (status === 400 || status === 401 || status === 403) return 403;
  return 502;
}

async function handleYoutubeSearch(request: Request, env: AppEnv) {
  const trust = trustedCors(request, 'GET, OPTIONS', env);
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);
  const guard = await guardSensitiveRequest(request, env, trust, 'youtube-search', 'yt-search', 30);
  if (guard) return guard;

  const apiKey = env.YOUTUBE_API_KEY || env.YOUTUBE_DATA_API_KEY || '';
  if (!apiKey) return json({ error: 'YOUTUBE_SEARCH_UNAVAILABLE' }, 503, headers);

  const url = new URL(request.url);
  const query = String(url.searchParams.get('q') || '')
    .trim()
    .slice(0, QUERY_MAX_LENGTH);
  if (!query) return json({ error: 'Missing query' }, 400, headers);

  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    safeSearch: typeof env.YOUTUBE_SAFE_SEARCH === 'string' ? env.YOUTUBE_SAFE_SEARCH : 'moderate',
    maxResults: String(clampMaxResults(url.searchParams.get('maxResults'), env)),
    q: query,
    fields:
      'items(id/videoId,snippet/title,snippet/channelTitle,snippet/publishedAt,snippet/thumbnails)',
  });
  const regionCode = env.YOUTUBE_REGION_CODE || '';
  if (/^[A-Za-z]{2}$/.test(regionCode)) {
    params.set('regionCode', regionCode.toUpperCase());
  }
  const relevanceLanguage = env.YOUTUBE_RELEVANCE_LANGUAGE || '';
  if (/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(relevanceLanguage)) {
    params.set('relevanceLanguage', relevanceLanguage);
  }

  try {
    const { response, payload } = await fetchJsonWithTimeout(
      `${YOUTUBE_SEARCH_API}?${params.toString()}`,
      { headers: { 'x-goog-api-key': apiKey } },
    );
    if (!response.ok) {
      const upstreamError = normalizeUpstreamError(payload);
      return json(
        {
          error: 'YOUTUBE_SEARCH_FAILED',
          upstreamStatus: response.status,
          reason: upstreamError.reason,
          message: upstreamError.message,
        },
        getClientStatusForUpstreamError(response.status, upstreamError.reason),
        headers,
      );
    }
    const items = isJsonObject(payload) ? payload.items : undefined;
    return json({ query, results: normalizeResults(items) }, 200, headers);
  } catch (error) {
    return json(
      {
        error: 'YOUTUBE_SEARCH_PROXY_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
      502,
      headers,
    );
  }
}

async function handleYoutubePlaylistEntry(request: Request, env: AppEnv) {
  const trust = trustedCors(request, 'GET, OPTIONS', env);
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);
  const guard = await guardSensitiveRequest(
    request,
    env,
    trust,
    'youtube-search',
    'yt-playlist-entry',
    20,
  );
  if (guard) return guard;

  const apiKey = env.YOUTUBE_API_KEY || env.YOUTUBE_DATA_API_KEY || '';
  if (!apiKey) return json({ error: 'YOUTUBE_PLAYLIST_RESOLUTION_UNAVAILABLE' }, 503, headers);

  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  const playlistIds = url.searchParams.getAll('playlistId');
  const playlistIdCandidate = playlistIds[0];
  if (
    keys.length !== 1 ||
    keys[0] !== 'playlistId' ||
    playlistIds.length !== 1 ||
    typeof playlistIdCandidate !== 'string' ||
    !YOUTUBE_PLAYLIST_ID_RE.test(playlistIdCandidate)
  ) {
    return json({ error: 'INVALID_YOUTUBE_PLAYLIST_ID' }, 400, headers);
  }
  const playlistId = playlistIdCandidate;

  const params = new URLSearchParams({
    part: 'snippet,contentDetails,status',
    playlistId,
    // One quota unit resolves up to 50 rows. Scan the first page so a private
    // or deleted leading item does not make an otherwise usable list fail.
    maxResults: '50',
    fields:
      'items(contentDetails/videoId,snippet/resourceId/videoId,snippet/title,status/privacyStatus)',
  });

  try {
    const { response, payload } = await fetchJsonWithTimeout(
      `${YOUTUBE_PLAYLIST_ITEMS_API}?${params.toString()}`,
      { headers: { 'x-goog-api-key': apiKey } },
    );
    if (!response.ok) {
      const upstreamError = normalizeUpstreamError(payload);
      return json(
        {
          error: 'YOUTUBE_PLAYLIST_RESOLUTION_FAILED',
          upstreamStatus: response.status,
          reason: upstreamError.reason,
        },
        getClientStatusForUpstreamError(response.status, upstreamError.reason),
        headers,
      );
    }

    const items = isJsonObject(payload) ? payload.items : undefined;
    const entry = normalizePlaylistEntry(items, playlistId);
    if (!entry) {
      return json({ error: 'YOUTUBE_PLAYLIST_HAS_NO_PLAYABLE_ENTRY' }, 404, headers);
    }
    return json(entry, 200, headers);
  } catch {
    return json({ error: 'YOUTUBE_PLAYLIST_RESOLUTION_PROXY_FAILED' }, 502, headers);
  }
}

async function handleYoutubePlaylistManifest(request: Request, env: AppEnv) {
  const trust = trustedCors(request, 'GET, OPTIONS', env);
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);
  const guard = await guardSensitiveRequest(
    request,
    env,
    trust,
    'youtube-search',
    'yt-playlist-manifest',
    10,
  );
  if (guard) return guard;

  const apiKey = env.YOUTUBE_API_KEY || env.YOUTUBE_DATA_API_KEY || '';
  if (!apiKey) return json({ error: 'YOUTUBE_PLAYLIST_RESOLUTION_UNAVAILABLE' }, 503, headers);

  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  const playlistIds = url.searchParams.getAll('playlistId');
  const playlistIdCandidate = playlistIds[0];
  if (
    keys.length !== 1 ||
    keys[0] !== 'playlistId' ||
    playlistIds.length !== 1 ||
    typeof playlistIdCandidate !== 'string' ||
    !YOUTUBE_PLAYLIST_ID_RE.test(playlistIdCandidate)
  ) {
    return json({ error: 'INVALID_YOUTUBE_PLAYLIST_ID' }, 400, headers);
  }
  const playlistId = playlistIdCandidate;
  const params = new URLSearchParams({
    part: 'snippet,contentDetails,status',
    playlistId,
    maxResults: String(YOUTUBE_PLAYLIST_MANIFEST_PAGE_SIZE),
    fields:
      'nextPageToken,pageInfo/totalResults,items(contentDetails/videoId,snippet/resourceId/videoId,snippet/title,status/privacyStatus)',
  });
  const deadline = Date.now() + YOUTUBE_PLAYLIST_MANIFEST_TIMEOUT_MS;
  const seenPageTokens = new Set<string>();
  const videoIds: string[] = [];
  let firstTitle = '';
  let expectedTotal: number | null = null;
  let receivedItems = 0;
  let pageToken: string | null = null;

  try {
    while (true) {
      if (pageToken) params.set('pageToken', pageToken);
      else params.delete('pageToken');

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return json({ error: 'YOUTUBE_PLAYLIST_MANIFEST_INCOMPLETE' }, 502, headers);
      }
      const { response, payload } = await fetchJsonWithTimeout(
        `${YOUTUBE_PLAYLIST_ITEMS_API}?${params.toString()}`,
        { headers: { 'x-goog-api-key': apiKey } },
        Math.min(8_000, remainingMs),
      );
      if (!response.ok) {
        const upstreamError = normalizeUpstreamError(payload);
        return json(
          {
            error: 'YOUTUBE_PLAYLIST_RESOLUTION_FAILED',
            upstreamStatus: response.status,
            reason: upstreamError.reason,
          },
          getClientStatusForUpstreamError(response.status, upstreamError.reason),
          headers,
        );
      }

      const page = parsePlaylistManifestPage(payload);
      if (!page || (expectedTotal !== null && page.totalResults !== expectedTotal)) {
        return json({ error: 'YOUTUBE_PLAYLIST_MANIFEST_INCOMPLETE' }, 502, headers);
      }
      expectedTotal ??= page.totalResults;
      if (expectedTotal > YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS) {
        return json({ error: 'YOUTUBE_PLAYLIST_MANIFEST_TOO_LARGE' }, 413, headers);
      }

      receivedItems += page.items.length;
      if (receivedItems > YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS) {
        return json({ error: 'YOUTUBE_PLAYLIST_MANIFEST_TOO_LARGE' }, 413, headers);
      }
      for (const item of page.items) {
        const playable = normalizePlaylistManifestItem(item);
        if (!playable) continue;
        if (!firstTitle) firstTitle = playable.title;
        videoIds.push(playable.videoId);
      }

      if (!page.nextPageToken) {
        if (receivedItems !== expectedTotal) {
          return json({ error: 'YOUTUBE_PLAYLIST_MANIFEST_INCOMPLETE' }, 502, headers);
        }
        break;
      }
      if (
        page.items.length === 0 ||
        receivedItems >= expectedTotal ||
        seenPageTokens.has(page.nextPageToken)
      ) {
        return json({ error: 'YOUTUBE_PLAYLIST_MANIFEST_INCOMPLETE' }, 502, headers);
      }
      seenPageTokens.add(page.nextPageToken);
      pageToken = page.nextPageToken;
    }

    if (videoIds.length === 0 || !firstTitle) {
      return json({ error: 'YOUTUBE_PLAYLIST_HAS_NO_PLAYABLE_ENTRY' }, 404, headers);
    }
    const firstVideoId = videoIds[0];
    if (!firstVideoId) {
      return json({ error: 'YOUTUBE_PLAYLIST_HAS_NO_PLAYABLE_ENTRY' }, 404, headers);
    }
    return json({ playlistId, videoId: firstVideoId, videoIds, title: firstTitle }, 200, headers);
  } catch {
    return json({ error: 'YOUTUBE_PLAYLIST_RESOLUTION_PROXY_FAILED' }, 502, headers);
  }
}

function parseTurnTtl(env: AppEnv) {
  const configuredTtl =
    typeof env.CLOUDFLARE_TURN_TTL === 'string'
      ? env.CLOUDFLARE_TURN_TTL
      : typeof env.CF_TURN_TTL === 'string'
        ? env.CF_TURN_TTL
        : '';
  const parsed = Number.parseInt(configuredTtl, 10);
  if (!Number.isFinite(parsed)) return CLOUDFLARE_TURN_TTL_DEFAULT;
  return Math.min(CLOUDFLARE_TURN_TTL_MAX, Math.max(CLOUDFLARE_TURN_TTL_MIN, parsed));
}

function normalizeUrls(value: unknown): string[] {
  const urls = Array.isArray(value) ? value : [value];
  return urls.filter((url): url is string => {
    if (typeof url !== 'string') return false;
    if (!/^(stun|turn|turns):/i.test(url)) return false;
    return !/^turns?:turn\.cloudflare\.com:53(?:[/?]|$)/i.test(url);
  });
}

interface NormalizedIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
  credentialType?: 'password' | 'oauth';
}

function normalizeIceServers(value: unknown): NormalizedIceServer[] {
  if (!Array.isArray(value)) return [];
  const result: NormalizedIceServer[] = [];
  for (const item of value) {
    if (!isJsonObject(item)) continue;
    const urls = normalizeUrls(item.urls);
    if (urls.length === 0) continue;
    const hasTurn = urls.some((url) => /^turns?:/i.test(url));
    if (hasTurn && (!item.username || !item.credential)) continue;
    const firstUrl = urls[0];
    if (!firstUrl) continue;
    const server: NormalizedIceServer = { urls: urls.length === 1 ? firstUrl : urls };
    if (typeof item.username === 'string' && item.username) server.username = item.username;
    if (typeof item.credential === 'string' && item.credential) {
      server.credential = item.credential;
    }
    if (item.credentialType === 'password' || item.credentialType === 'oauth') {
      server.credentialType = item.credentialType;
    }
    result.push(server);
  }
  return result;
}

async function getCloudflareIceServers(env: AppEnv) {
  const keyId = env.CLOUDFLARE_TURN_KEY_ID || env.CF_TURN_KEY_ID || '';
  const apiToken =
    env.CLOUDFLARE_TURN_API_TOKEN || env.CF_TURN_API_TOKEN || env.CLOUDFLARE_API_TOKEN || '';
  if (!keyId || !apiToken) return null;

  const endpoint = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(
    keyId,
  )}/credentials/generate-ice-servers`;
  const { response, payload } = await fetchJsonWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl: parseTurnTtl(env) }),
  });
  if (!response.ok) throw new Error(`Cloudflare TURN HTTP ${response.status}`);

  const iceServers = normalizeIceServers(isJsonObject(payload) ? payload.iceServers : undefined);
  const hasTurn = iceServers.some((server) =>
    normalizeUrls(server.urls).some((url) => /^turns?:/i.test(url)),
  );
  if (!hasTurn) throw new Error('Cloudflare TURN returned no usable TURN servers');
  return { provider: 'cloudflare', ttl: parseTurnTtl(env), iceServers };
}

async function handleTurnConfig(request: Request, env: AppEnv) {
  const trust = trustedCors(request, 'GET, OPTIONS', env);
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);
  const guard = await guardSensitiveRequest(request, env, trust, 'turn', 'turn-config', 60, {
    authenticatedRateLimit: ROOM_BURST_TURN_LIMIT,
    perCapabilityLimit: 4,
    combinePerCapabilityRateLimit: true,
  });
  if (guard) return guard;

  try {
    const cloudflareConfig = await getCloudflareIceServers(env);
    if (cloudflareConfig) return json(cloudflareConfig, 200, headers);
  } catch (error) {
    console.warn(
      '[TURN] Cloudflare config failed:',
      error instanceof Error ? error.message : error,
    );
  }
  return json({ error: 'TURN_CONFIG_UNAVAILABLE' }, 503, headers);
}

function getRealtimeEnv(env: AppEnv) {
  return {
    appId: String(
      env.CLOUDFLARE_REALTIME_APP_ID ||
        env.CLOUDFLARE_CALLS_APP_ID ||
        env.CLOUDFLARE_SFU_APP_ID ||
        '',
    ).trim(),
    appSecret: String(
      env.CLOUDFLARE_REALTIME_APP_SECRET ||
        env.CLOUDFLARE_REALTIME_API_TOKEN ||
        env.CLOUDFLARE_CALLS_APP_SECRET ||
        env.CLOUDFLARE_CALLS_API_TOKEN ||
        env.CLOUDFLARE_SFU_APP_SECRET ||
        env.CLOUDFLARE_SFU_API_TOKEN ||
        '',
    ).trim(),
  };
}

function buildRealtimeRequest(
  action: unknown,
  appId: string,
  sessionId: string,
  correlationId: string,
) {
  const encodedAppId = encodeURIComponent(appId);
  const encodedSessionId = sessionId ? encodeURIComponent(sessionId) : '';
  const query =
    typeof correlationId === 'string' && correlationId
      ? `?correlationId=${encodeURIComponent(correlationId.slice(0, 128))}`
      : '';
  switch (action) {
    case 'new-session':
      return {
        method: 'POST',
        url: `${REALTIME_API_BASE}/apps/${encodedAppId}/sessions/new${query}`,
      };
    case 'tracks-new':
      return {
        method: 'POST',
        url: `${REALTIME_API_BASE}/apps/${encodedAppId}/sessions/${encodedSessionId}/tracks/new`,
      };
    case 'renegotiate':
      return {
        method: 'PUT',
        url: `${REALTIME_API_BASE}/apps/${encodedAppId}/sessions/${encodedSessionId}/renegotiate`,
      };
    case 'tracks-close':
      return {
        method: 'PUT',
        url: `${REALTIME_API_BASE}/apps/${encodedAppId}/sessions/${encodedSessionId}/tracks/close`,
      };
    default:
      return null;
  }
}

function shouldSendPayloadBody(action: string, payload: JsonObject) {
  if (action !== 'new-session') return true;
  return Object.keys(payload).length > 0;
}

async function handleRealtime(request: Request, env: AppEnv) {
  const trust = trustedCors(request, 'POST, OPTIONS', env);
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);

  const parsedBody = await readJsonBodyLimited(request, REALTIME_JSON_BODY_MAX_BYTES);
  if (!('value' in parsedBody)) return jsonBodyError(parsedBody, headers);
  const body = parsedBody.value;
  if (!isJsonObject(body)) {
    return json({ error: 'Invalid JSON body' }, 400, headers);
  }

  const action = typeof body.action === 'string' ? body.action : '';
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const isNewSession = action === 'new-session';
  const guard = await guardSensitiveRequest(
    request,
    env,
    trust,
    'realtime',
    isNewSession ? 'realtime-new-session' : 'realtime-mutation',
    30,
    {
      authenticatedRateLimit: isNewSession
        ? ROOM_BURST_REALTIME_NEW_SESSION_LIMIT
        : ROOM_BURST_REALTIME_MUTATION_LIMIT,
      perCapabilityLimit: isNewSession
        ? REALTIME_NEW_SESSION_PER_CAPABILITY_LIMIT
        : REALTIME_MUTATION_PER_CAPABILITY_LIMIT,
    },
  );
  if (guard) return guard;

  const { appId, appSecret } = getRealtimeEnv(env);
  if (!appId || appSecret.length < HMAC_SECRET_MIN_LENGTH) {
    return json({ error: 'REALTIME_SFU_UNAVAILABLE' }, 503, headers);
  }

  const correlationId = typeof body.correlationId === 'string' ? body.correlationId : '';
  const realtimeRequest = buildRealtimeRequest(action, appId, sessionId, correlationId);
  if (!realtimeRequest) return json({ error: 'Unsupported action' }, 400, headers);
  if (action !== 'new-session') {
    if (!isValidRealtimeSessionId(sessionId)) {
      return json({ error: 'Invalid sessionId' }, 400, headers);
    }
    const sessionOwnerToken =
      typeof body.sessionOwnerToken === 'string' ? body.sessionOwnerToken : '';
    const ownsSession = await verifyRealtimeSessionCapability(
      sessionOwnerToken,
      sessionId,
      appId,
      appSecret,
    );
    if (!ownsSession) {
      return json({ error: 'REALTIME_SESSION_CAPABILITY_REQUIRED' }, 403, headers);
    }
    const sessionRateIdentity = (await hmacSha256(appSecret, `rate:${sessionOwnerToken}`)).slice(
      0,
      32,
    );
    const sessionRate = await checkPaidRateLimit(
      request,
      env,
      'realtime-session-mutation',
      REALTIME_MUTATION_PER_SESSION_LIMIT,
      60,
      sessionRateIdentity,
    );
    if (sessionRate.status !== 'ok') return rateLimitUnavailableResponse(headers);
    if (!sessionRate.allowed) return rateLimitResponse(headers, sessionRate.retryAfterSeconds);
  }

  try {
    const payload = isJsonObject(body.payload) ? body.payload : {};
    const requestBody = shouldSendPayloadBody(action, payload)
      ? JSON.stringify(payload)
      : undefined;
    const requestOptions: RequestInit = {
      method: realtimeRequest.method,
      headers: {
        Authorization: `Bearer ${appSecret}`,
        'Content-Type': 'application/json',
      },
    };
    if (requestBody !== undefined) requestOptions.body = requestBody;
    const { response: cfResponse, bytes } = await fetchAndConsumeWithTimeout(
      realtimeRequest.url,
      requestOptions,
      UPSTREAM_JSON_TIMEOUT_MS,
      async (response, signal) => ({
        response,
        bytes: await readResponseBodyLimited(response, UPSTREAM_JSON_RESPONSE_MAX_BYTES, signal),
      }),
    );
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    let responseBody: unknown;
    try {
      responseBody = text ? JSON.parse(text) : {};
    } catch {
      responseBody = { raw: text };
    }
    if (action === 'new-session' && cfResponse.ok && isJsonObject(responseBody)) {
      const responseSessionId = responseBody.sessionId;
      if (typeof responseSessionId !== 'string' || !isValidRealtimeSessionId(responseSessionId)) {
        return json(responseBody, cfResponse.status, headers);
      }
      responseBody.sessionOwnerToken = await createRealtimeSessionCapability(
        responseSessionId,
        appId,
        appSecret,
      );
    }
    return json(responseBody, cfResponse.status, headers);
  } catch (error) {
    return json(
      {
        error: 'CLOUDFLARE_REALTIME_PROXY_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
      502,
      headers,
    );
  }
}

function esc(value: string) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function serializeJsonForHtmlScript(value: {
  '@context': string;
  '@type': string;
  headline: unknown;
  description: unknown;
  datePublished: string | undefined;
  image: unknown;
  url: string;
  mainEntityOfPage: string;
  publisher:
    | { '@type': string; name: string; url: string }
    | { '@type': string; name: string; url: string };
}) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function replaceMetaProperty(html: string, property: string, content: string) {
  return html.replace(
    new RegExp(`<meta\\b(?=[^>]*\\bproperty=["']${property}["'])[^>]*>`, 'i'),
    `<meta property="${property}" content="${esc(content)}" />`,
  );
}

function replaceMetaName(html: string, name: string, content: string) {
  return html.replace(
    new RegExp(`<meta\\b(?=[^>]*\\bname=["']${name}["'])[^>]*>`, 'i'),
    `<meta name="${name}" content="${esc(content)}" />`,
  );
}

function rewriteInviteMeta(html: string, code: string, origin: string) {
  const imageUrl = `${origin}/og-invite.png`;
  const pageUrl = `${origin}/${code}`;
  const title = `Session ${code} - MUSIXQUARE`;
  const description = `Join a MUSIXQUARE session with code ${code}.`;
  const alt = `MUSIXQUARE - Session ${code}`;

  let rewritten = html;
  rewritten = replaceMetaProperty(rewritten, 'og:url', pageUrl);
  rewritten = replaceMetaProperty(rewritten, 'og:title', title);
  rewritten = replaceMetaProperty(rewritten, 'og:description', description);
  rewritten = replaceMetaProperty(rewritten, 'og:image', imageUrl);
  rewritten = replaceMetaProperty(rewritten, 'og:image:alt', alt);
  rewritten = replaceMetaName(rewritten, 'twitter:title', title);
  rewritten = replaceMetaName(rewritten, 'twitter:description', description);
  rewritten = replaceMetaName(rewritten, 'twitter:image', imageUrl);
  return rewritten;
}

function stripCdata(value: unknown) {
  const text = String(value ?? '').trim();
  const match = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return match?.[1] ?? text;
}

function decodeXmlText(value: string | undefined) {
  return stripCdata(value)
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeRegExp(value: string) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readRssTag(xml: string | undefined, tagName: string) {
  const tag = escapeRegExp(tagName);
  const match = String(xml).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXmlText(match[1]) : '';
}

function readRssAttr(xml: string | undefined, tagPattern: string, attrName: string) {
  const tagMatch = String(xml).match(new RegExp(`<${tagPattern}\\b[^>]*>`, 'i'));
  if (!tagMatch) return '';
  const attr = escapeRegExp(attrName);
  const attrMatch = tagMatch[0].match(new RegExp(`\\b${attr}=["']([^"']+)["']`, 'i'));
  return attrMatch ? decodeXmlText(attrMatch[1]) : '';
}

function isValidSoroSlug(slug: string) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 120;
}

function extractSlugFromUrl(link: string | URL) {
  try {
    const url = new URL(link);
    const post = url.searchParams.get('post') || '';
    if (isValidSoroSlug(post)) return post;
    const parts = url.pathname.split('/').filter(Boolean);
    const slug = parts[parts.length - 1] || '';
    return isValidSoroSlug(slug) ? slug : '';
  } catch {
    return '';
  }
}

function soroArticlePath(slug: string) {
  return `/blog/${slug}`;
}

function sanitizeUrl(value: string | URL) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    /* invalid URL */
  }
  return '';
}

class ResponseBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Response body exceeds ${maxBytes} bytes`);
    this.name = 'ResponseBodyTooLargeError';
  }
}

function responseContentLength(response: Response) {
  const value = response.headers.get('content-length');
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

type CancelableResponseBody =
  | Response
  | ReadableStream<Uint8Array>
  | ReadableStreamDefaultReader<Uint8Array>;

function cancelResponseBody(responseOrBody: CancelableResponseBody | null, reason: unknown) {
  const body = responseOrBody instanceof Response ? responseOrBody.body : responseOrBody;
  if (!body) return;
  try {
    Promise.resolve(body.cancel(reason)).catch(() => {});
  } catch {
    // Cancellation is best-effort and must never delay the bounded response.
  }
}

async function readResponseBodyLimited(response: Response, maxBytes: number, signal: AbortSignal) {
  const declaredBytes = responseContentLength(response);
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    cancelResponseBody(response, 'RESPONSE_BODY_TOO_LARGE');
    throw new ResponseBodyTooLargeError(maxBytes);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let stop!: (outcome: { kind: 'aborted' }) => void;
  const stopped = new Promise<{ kind: 'aborted' }>((resolve) => {
    stop = resolve;
  });
  const abortReason = () =>
    signal.reason instanceof Error ? signal.reason : new Error('Response body read aborted');
  const handleAbort = () => {
    stop({ kind: 'aborted' });
    cancelResponseBody(reader, abortReason());
  };
  if (signal.aborted) handleAbort();
  else signal.addEventListener('abort', handleAbort, { once: true });

  try {
    while (true) {
      if (signal.aborted) throw abortReason();
      const outcome = await Promise.race([
        reader.read().then(
          (value) => ({ kind: 'read' as const, value }),
          () => ({ kind: 'invalid' as const }),
        ),
        stopped,
      ]);
      if (outcome.kind === 'aborted') throw abortReason();
      if (outcome.kind !== 'read') throw new Error('Response body read failed');
      const { done, value } = outcome.value;
      if (signal.aborted) throw abortReason();
      if (done) break;
      if (!value) continue;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        cancelResponseBody(reader, 'RESPONSE_BODY_TOO_LARGE');
        throw new ResponseBodyTooLargeError(maxBytes);
      }
      chunks.push(bytes);
    }
  } finally {
    signal.removeEventListener('abort', handleAbort);
    try {
      reader.releaseLock();
    } catch {
      // A non-cooperative stream may still own the timed-out read.
    }
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function fetchAndConsumeWithTimeout<T>(
  resource: string | URL | Request,
  options: RequestInit | undefined,
  timeoutMs: number,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new Error('Upstream response timed out');
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let activeResponse: Response | null = null;
  const operation = Promise.resolve()
    .then(() => fetch(resource, { ...options, signal: controller.signal }))
    .then(async (response) => {
      activeResponse = response;
      if (timedOut) {
        cancelResponseBody(response, timeoutError);
        throw timeoutError;
      }
      try {
        return await consume(response, controller.signal);
      } finally {
        if (!timedOut) activeResponse = null;
      }
    });
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
      cancelResponseBody(activeResponse, timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    // Abort is cooperative. The race is the actual wall-clock bound for a
    // fetch implementation that ignores AbortSignal while resolving headers
    // or for a consumer that stalls after headers. Promise.race also observes
    // any late rejection, while the operation branch cancels a late body.
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

async function fetchServiceBindingResponse(
  fetcher: typeof fetch,
  request: Request,
  maxBytes: number,
  timeoutMs: number = PRO_ROOM_SERVICE_RESPONSE_TIMEOUT_MS,
) {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const operation = Promise.resolve()
    .then(() => fetcher(new Request(request, { signal: controller.signal })))
    .then(async (response) => {
      if (timedOut) {
        cancelResponseBody(response, 'SERVICE_RESPONSE_TIMEOUT');
        return null;
      }
      const bytes = await readResponseBodyLimited(response, maxBytes, controller.signal);
      return timedOut ? null : { response, bytes };
    })
    // A service binding may reject only after the timeout race has completed.
    // Normalize that late settlement so cleanup never becomes an unhandled task.
    .catch(() => null);
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('SERVICE_RESPONSE_TIMEOUT'));
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

function parseServiceJsonBytes(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null;
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    return parsed;
  } catch {
    return null;
  }
}

function isValidUtf8(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return true;
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function bufferedServiceResponse(response: Response, bytes: Uint8Array, omitBody = false) {
  const statusDisallowsBody = [101, 204, 205, 304].includes(response.status);
  const body =
    omitBody || statusDisallowsBody || bytes.byteLength === 0 ? null : new Uint8Array(bytes).buffer;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function fetchJsonWithTimeout(
  resource: string,
  options: RequestInit = {},
  timeoutMs: number = UPSTREAM_JSON_TIMEOUT_MS,
  maxBytes: number = UPSTREAM_JSON_RESPONSE_MAX_BYTES,
): Promise<{ response: Response; payload: unknown }> {
  return fetchAndConsumeWithTimeout(resource, options, timeoutMs, async (response, signal) => {
    const bytes = await readResponseBodyLimited(response, maxBytes, signal);
    if (bytes.byteLength === 0) return { response, payload: {} };
    const payload: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    return { response, payload };
  });
}

export async function readResponseBodyLimitedForTests(response: Response, maxBytes: number) {
  return readResponseBodyLimited(response, maxBytes, new AbortController().signal);
}

function sanitizeSoroImageSource(value: string | URL) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return '';
    return url.href;
  } catch {
    return '';
  }
}

interface SoroArticle {
  title: string;
  slug: string;
  link: string;
  description: string;
  pubDate: string;
  guid: string;
  content: string;
  image: string;
  localImagePath?: string;
}

interface SoroImageMirrorOptions {
  fetchMissing?: boolean;
}

interface SoroFeedLoadOptions {
  mirrorImages?: boolean;
}

type SoroImageFetchResult =
  | { status: 'fetch-error' | 'invalid-type' | 'too-large' }
  | { status: 'ok'; contentType: string; bytes: Uint8Array };

function contentTypeToSoroImageExt(contentType: string) {
  const rawType = String(contentType || '').split(';')[0] || '';
  const type = rawType.trim().toLowerCase();
  switch (type) {
    case 'image/avif':
      return 'avif';
    case 'image/gif':
      return 'gif';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    default:
      return '';
  }
}

function imageExtFromUrl(value: string | URL) {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]+)$/);
    const ext = match?.[1] ?? '';
    if (['avif', 'gif', 'jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      return ext === 'jpeg' ? 'jpg' : ext;
    }
  } catch {
    /* invalid URL */
  }
  return '';
}

function isAllowedSoroImageContentType(contentType: string) {
  return Boolean(contentTypeToSoroImageExt(contentType));
}

function soroImageKey(article: Pick<SoroArticle, 'slug' | 'image'>, contentType: string = '') {
  if (!article.slug || !isValidSoroSlug(article.slug)) return '';
  const source = sanitizeSoroImageSource(article.image);
  if (!source) return '';
  const ext = imageExtFromUrl(source) || contentTypeToSoroImageExt(contentType) || 'webp';
  return `${SORO_IMAGE_R2_PREFIX}${article.slug}.${ext}`;
}

function soroImagePublicPath(key: string) {
  return `${SORO_IMAGE_ROUTE_PREFIX}${key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

function soroImageKeyFromPathname(pathname: string) {
  if (!pathname.startsWith(SORO_IMAGE_ROUTE_PREFIX)) return '';
  try {
    const key = decodeURIComponent(pathname.slice(SORO_IMAGE_ROUTE_PREFIX.length));
    if (!key.startsWith(SORO_IMAGE_R2_PREFIX)) return '';
    if (key.includes('..') || key.includes('\\')) return '';
    if (!/^featured\/[a-z0-9]+(?:-[a-z0-9]+)*\.(?:avif|gif|jpg|png|webp)$/.test(key)) {
      return '';
    }
    return key;
  } catch {
    return '';
  }
}

async function ensureSoroImageMirror(
  env: AppEnv,
  article: SoroArticle,
  options: SoroImageMirrorOptions = {},
) {
  if (!article.image) return 'none';
  const sourceUrl = sanitizeSoroImageSource(article.image);
  if (!sourceUrl) return 'invalid-source';
  if (!env.SORO_IMAGE_BUCKET) return 'unbound';

  const key = soroImageKey(article);
  if (!key) return 'invalid-key';
  const localPath = soroImagePublicPath(key);

  let existing: AppR2Object | null = null;
  try {
    existing = await env.SORO_IMAGE_BUCKET.head(key);
  } catch {
    existing = null;
  }

  if (existing?.customMetadata?.sourceUrl === sourceUrl) {
    article.localImagePath = localPath;
    return 'cached';
  }
  if (existing && !options.fetchMissing) {
    article.localImagePath = localPath;
    return 'cached';
  }
  if (!options.fetchMissing) return 'source';

  try {
    const fetched = await fetchAndConsumeWithTimeout(
      sourceUrl,
      {
        headers: {
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8,*/*;q=0.1',
        },
      },
      SORO_IMAGE_FETCH_TIMEOUT_MS,
      async (response, signal): Promise<SoroImageFetchResult> => {
        if (!response.ok) {
          cancelResponseBody(response, 'SORO_IMAGE_HTTP_ERROR');
          return { status: 'fetch-error' };
        }

        const contentType = response.headers.get('content-type') || '';
        if (!isAllowedSoroImageContentType(contentType)) {
          cancelResponseBody(response, 'SORO_IMAGE_INVALID_TYPE');
          return { status: 'invalid-type' };
        }

        try {
          return {
            status: 'ok',
            contentType,
            bytes: await readResponseBodyLimited(response, SORO_IMAGE_MAX_BYTES, signal),
          };
        } catch (error) {
          if (error instanceof ResponseBodyTooLargeError) return { status: 'too-large' };
          throw error;
        }
      },
    );
    if (fetched.status !== 'ok') return existing ? 'cached' : fetched.status;

    const mirroredContentType = fetched.contentType.split(';')[0] || '';
    await env.SORO_IMAGE_BUCKET.put(key, fetched.bytes, {
      httpMetadata: {
        contentType: mirroredContentType.trim().toLowerCase(),
        cacheControl: SORO_IMAGE_CACHE,
      },
      customMetadata: {
        sourceUrl,
        slug: article.slug,
        mirroredAt: new Date().toISOString(),
      },
    });
    article.localImagePath = localPath;
    return existing ? 'updated' : 'written';
  } catch {
    if (existing) {
      article.localImagePath = localPath;
      return 'cached';
    }
    return 'error';
  }
}

async function mirrorSoroImages(
  env: AppEnv,
  articles: SoroArticle[],
  options: SoroImageMirrorOptions = {},
) {
  if (!env.SORO_IMAGE_BUCKET) return 'unbound';
  const counts: Record<string, number> = {};
  for (const article of articles) {
    const status = await ensureSoroImageMirror(env, article, options);
    counts[status] = (counts[status] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([status, count]) => `${status}:${count}`)
    .join(',');
}

function sortedSoroArticles<T extends { pubDate: unknown }>(articles: T[]): T[] {
  return [...articles].sort((a, b) => {
    const bTime = Date.parse(typeof b.pubDate === 'string' ? b.pubDate : '') || 0;
    const aTime = Date.parse(typeof a.pubDate === 'string' ? a.pubDate : '') || 0;
    return bTime - aTime;
  });
}

function soroArticleDisplayDate(pubDate: unknown) {
  const date = new Date(typeof pubDate === 'string' || typeof pubDate === 'number' ? pubDate : '');
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function soroArticleIsoDate(pubDate: unknown) {
  const date = new Date(typeof pubDate === 'string' || typeof pubDate === 'number' ? pubDate : '');
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function soroArticleExcerpt(article: Pick<SoroArticle, 'description' | 'content'>) {
  return (
    article.description ||
    String(article.content || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180)
  );
}

function soroArticleImageUrl(
  article: Pick<SoroArticle, 'image' | 'localImagePath'>,
  origin: string,
  source: string,
) {
  if (article.localImagePath) return new URL(article.localImagePath, origin).href;
  if (source !== 'backup' && article.image) return article.image;
  return `${origin}/og-blog.png`;
}

function mapSoroListImagePaths(articles: SoroArticle[]) {
  const counts: Record<string, number> = {};
  const visibleCount = Math.min(articles.length, 12);

  for (let index = 0; index < articles.length; index += 1) {
    const article = articles[index];
    if (!article?.image) {
      counts.none = (counts.none || 0) + 1;
      continue;
    }

    const key = soroImageKey(article);
    if (!key) {
      counts.invalid = (counts.invalid || 0) + 1;
      continue;
    }

    article.localImagePath = soroImagePublicPath(key);
    const status = index < visibleCount ? 'mapped' : 'deferred';
    counts[status] = (counts[status] || 0) + 1;
  }

  return Object.entries(counts)
    .map(([status, count]) => `${status}:${count}`)
    .join(',');
}

function mapSoroArticleImagePath(article: SoroArticle) {
  if (!article.image) return 'none';
  const key = soroImageKey(article);
  if (!key) return 'invalid';
  article.localImagePath = soroImagePublicPath(key);
  return 'mapped';
}

function renderSoroBlogListHtml(articles: SoroArticle[], origin: string, source: string) {
  if (!articles.length) {
    return `<div class="soro-blog"><div class="soro-blog-content"><p class="soro-blog-card-excerpt">No articles are available yet.</p></div></div>`;
  }

  const cards = articles
    .map((article) => {
      const href = soroArticlePath(article.slug);
      const image = soroArticleImageUrl(article, origin, source);
      const displayDate = soroArticleDisplayDate(article.pubDate);
      const isoDate = soroArticleIsoDate(article.pubDate);
      const dateHtml = displayDate
        ? `<time class="soro-blog-card-date" datetime="${esc(isoDate)}">${esc(displayDate)}</time>`
        : '';
      return `<a class="soro-blog-card" href="${esc(href)}">
        <img class="soro-blog-card-image" src="${esc(image)}" alt="${esc(article.title)}" loading="lazy" decoding="async">
        <div class="soro-blog-card-content">
          <h3 class="soro-blog-card-title">${esc(article.title)}</h3>
          <p class="soro-blog-card-excerpt">${esc(soroArticleExcerpt(article))}</p>
          ${dateHtml}
        </div>
      </a>`;
    })
    .join('');

  return `<div class="soro-blog"><div class="soro-blog-content"><div class="soro-blog-list">${cards}</div></div></div>`;
}

function firstImageFromHtml(html: string) {
  const match = String(html).match(/<img\b[^>]*\bsrc=(["'])(.*?)\1/i);
  const source = match?.[2];
  return source ? sanitizeUrl(decodeXmlText(source)) : '';
}

const SORO_ARTICLE_ALLOWED_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'dd',
  'del',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
]);
const SORO_ARTICLE_VOID_TAGS = new Set(['br', 'hr', 'img']);
const SORO_ARTICLE_MAX_NESTING = 128;
const SORO_ARTICLE_MAX_ATTRIBUTES = 64;
const SORO_ARTICLE_DROP_CONTENT_TAGS = new Set([
  'applet',
  'button',
  'canvas',
  'form',
  'iframe',
  'math',
  'noembed',
  'noframes',
  'noscript',
  'object',
  'script',
  'select',
  'style',
  'svg',
  'template',
  'textarea',
  'title',
  'xmp',
]);
const SORO_ARTICLE_DROP_TAGS = new Set(['base', 'embed', 'input', 'link', 'meta']);
const SORO_ARTICLE_GLOBAL_ATTRIBUTES = new Set(['class', 'dir', 'lang', 'title']);
const SORO_ARTICLE_TAG_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(['href', 'target']),
  img: new Set(['alt', 'decoding', 'height', 'loading', 'src', 'width']),
  li: new Set(['value']),
  ol: new Set(['reversed', 'start', 'type']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
};

function decodeSoroHtmlAttribute(value: string) {
  return String(value ?? '')
    .replace(/&#(\d+);?/g, (match, code: string) => {
      const point = Number(code);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : match;
    })
    .replace(/&#x([0-9a-f]+);?/gi, (match, code: string) => {
      const point = Number.parseInt(code, 16);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : match;
    })
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function sanitizeSoroArticleUrl(value: unknown, kind: string) {
  const raw = String(value ?? '');
  if (raw.length > 4096) return '';
  const decoded = decodeSoroHtmlAttribute(raw).trim();
  if (!decoded || decoded.length > 4096) return '';
  // Unknown entities can be interpreted differently by an HTML parser. Drop
  // the URL instead of trying to maintain a partial HTML entity table here.
  if (/&(?:#x?[0-9a-f]+|[a-z][a-z0-9]+);/i.test(decoded)) return '';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(decoded)) return '';

  try {
    const url = new URL(decoded, 'https://musixquare.com/');
    if (url.protocol === 'http:' || url.protocol === 'https:') return decoded;
    if (kind === 'href' && (url.protocol === 'mailto:' || url.protocol === 'tel:')) {
      return decoded;
    }
  } catch {
    /* invalid URL */
  }
  return kind === 'href' && decoded.startsWith('#') ? decoded : '';
}

function findSoroHtmlTagEnd(html: string, start: number) {
  let quote = '';
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  return -1;
}

interface SoroHtmlAttribute {
  name: string;
  value: string;
}

function parseSoroHtmlAttributes(source: string): SoroHtmlAttribute[] {
  const attributes: SoroHtmlAttribute[] = [];
  let index = 0;
  while (index < source.length && attributes.length < SORO_ARTICLE_MAX_ATTRIBUTES) {
    while (/\s/.test(source[index] || '')) index += 1;
    if (index >= source.length || source[index] === '/') break;

    const nameMatch = source.slice(index).match(/^([a-z_:][a-z0-9:._-]*)/i);
    if (!nameMatch) {
      index += 1;
      continue;
    }
    const matchedName = nameMatch[1];
    if (!matchedName) {
      index += nameMatch[0].length;
      continue;
    }
    const name = matchedName.toLowerCase();
    index += nameMatch[0].length;
    while (/\s/.test(source[index] || '')) index += 1;

    let value = '';
    if (source[index] === '=') {
      index += 1;
      while (/\s/.test(source[index] || '')) index += 1;
      const quote = source[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const end = source.indexOf(quote, index);
        value = end < 0 ? source.slice(index) : source.slice(index, end);
        index = end < 0 ? source.length : end + 1;
      } else {
        const valueMatch = source.slice(index).match(/^[^\s>]+/);
        value = valueMatch?.[0] || '';
        index += value.length;
      }
    }
    attributes.push({ name, value });
  }
  return attributes;
}

function sanitizeSoroArticleClass(value: unknown) {
  return decodeSoroHtmlAttribute(String(value ?? '').slice(0, 2048))
    .split(/\s+/)
    .filter((token: string) => /^[-_a-z0-9]{1,64}$/i.test(token))
    .slice(0, 16)
    .join(' ');
}

function sanitizeSoroArticleAttribute(tagName: string, attribute: SoroHtmlAttribute) {
  const { name, value } = attribute;
  const tagAttributes = SORO_ARTICLE_TAG_ATTRIBUTES[tagName];
  if (!SORO_ARTICLE_GLOBAL_ATTRIBUTES.has(name) && !tagAttributes?.has(name)) return '';
  if (value.length > 4096) return '';

  if (name === 'class') {
    const safeClass = sanitizeSoroArticleClass(value);
    return safeClass ? ` class="${esc(safeClass)}"` : '';
  }
  if (name === 'dir') {
    const safeDir = decodeSoroHtmlAttribute(value).toLowerCase();
    return ['auto', 'ltr', 'rtl'].includes(safeDir) ? ` dir="${safeDir}"` : '';
  }
  if (name === 'lang') {
    const safeLang = decodeSoroHtmlAttribute(value);
    return /^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/i.test(safeLang) ? ` lang="${safeLang}"` : '';
  }
  if (name === 'href' || name === 'src') {
    const safeUrl = sanitizeSoroArticleUrl(value, name);
    return safeUrl ? ` ${name}="${esc(safeUrl)}"` : '';
  }
  if (name === 'target') {
    const target = decodeSoroHtmlAttribute(value).toLowerCase();
    return target === '_blank' || target === '_self' ? ` target="${target}"` : '';
  }
  if (name === 'loading') {
    const loading = decodeSoroHtmlAttribute(value).toLowerCase();
    return loading === 'lazy' || loading === 'eager' ? ` loading="${loading}"` : '';
  }
  if (name === 'decoding') {
    const decoding = decodeSoroHtmlAttribute(value).toLowerCase();
    return ['async', 'auto', 'sync'].includes(decoding) ? ` decoding="${decoding}"` : '';
  }
  if (['height', 'width', 'colspan', 'rowspan', 'start', 'value'].includes(name)) {
    const number = decodeSoroHtmlAttribute(value);
    return /^-?\d{1,6}$/.test(number) ? ` ${name}="${number}"` : '';
  }
  if (name === 'scope') {
    const scope = decodeSoroHtmlAttribute(value).toLowerCase();
    return ['col', 'colgroup', 'row', 'rowgroup'].includes(scope) ? ` scope="${scope}"` : '';
  }
  if (name === 'type' && tagName === 'ol') {
    const type = decodeSoroHtmlAttribute(value);
    return ['1', 'a', 'A', 'i', 'I'].includes(type) ? ` type="${type}"` : '';
  }
  if (name === 'reversed') return ' reversed';

  const safeText = decodeSoroHtmlAttribute(value.slice(0, 2048));
  return safeText ? ` ${name}="${esc(safeText)}"` : '';
}

function sanitizeSoroArticleHtml(html: string) {
  const input = String(html ?? '');
  const output: string[] = [];
  const openTags: string[] = [];
  let index = 0;

  while (index < input.length) {
    const tagStart = input.indexOf('<', index);
    if (tagStart < 0) {
      output.push(input.slice(index));
      break;
    }
    output.push(input.slice(index, tagStart));

    if (input.startsWith('<!--', tagStart)) {
      const commentEnd = input.indexOf('-->', tagStart + 4);
      index = commentEnd < 0 ? input.length : commentEnd + 3;
      continue;
    }

    const tagEnd = findSoroHtmlTagEnd(input, tagStart + 1);
    if (tagEnd < 0) {
      const fallbackEnd = input.indexOf('>', tagStart + 1);
      if (fallbackEnd >= 0 && /^<\s*\/?[a-z]/i.test(input.slice(tagStart, fallbackEnd + 1))) {
        // A quote that never closes makes the token ambiguous. Discard that
        // token through its next delimiter rather than letting attribute-like
        // text or a browser repair heuristic reinterpret it.
        index = fallbackEnd + 1;
        continue;
      }
      output.push('&lt;');
      index = tagStart + 1;
      continue;
    }

    const rawTag = input.slice(tagStart + 1, tagEnd);
    const closingMatch = rawTag.match(/^\s*\/\s*([a-z0-9:-]+)/i);
    if (closingMatch) {
      const matchedTagName = closingMatch[1];
      if (!matchedTagName) {
        index = tagEnd + 1;
        continue;
      }
      const tagName = matchedTagName.toLowerCase();
      const openIndex = openTags.lastIndexOf(tagName);
      if (SORO_ARTICLE_ALLOWED_TAGS.has(tagName) && openIndex >= 0) {
        while (openTags.length > openIndex) output.push(`</${openTags.pop()}>`);
      }
      index = tagEnd + 1;
      continue;
    }

    const openingMatch = rawTag.match(/^\s*([a-z0-9:-]+)/i);
    if (!openingMatch) {
      index = tagEnd + 1;
      continue;
    }
    const matchedTagName = openingMatch[1];
    if (!matchedTagName) {
      index = tagEnd + 1;
      continue;
    }
    const tagName = matchedTagName.toLowerCase();
    if (SORO_ARTICLE_DROP_CONTENT_TAGS.has(tagName)) {
      const closePattern = new RegExp(`<\\s*\\/\\s*${escapeRegExp(tagName)}\\b[^>]*>`, 'gi');
      closePattern.lastIndex = tagEnd + 1;
      const closeMatch = closePattern.exec(input);
      index = closeMatch ? closePattern.lastIndex : input.length;
      continue;
    }
    if (SORO_ARTICLE_DROP_TAGS.has(tagName)) {
      index = tagEnd + 1;
      continue;
    }
    if (!SORO_ARTICLE_ALLOWED_TAGS.has(tagName)) {
      index = tagEnd + 1;
      continue;
    }

    const attributesSource = rawTag.slice(openingMatch[0].length);
    const seenAttributes = new Set<string>();
    let safeAttributes = '';
    let targetBlank = false;
    for (const attribute of parseSoroHtmlAttributes(attributesSource)) {
      if (seenAttributes.has(attribute.name)) continue;
      seenAttributes.add(attribute.name);
      const safeAttribute = sanitizeSoroArticleAttribute(tagName, attribute);
      if (!safeAttribute) continue;
      safeAttributes += safeAttribute;
      if (attribute.name === 'target' && safeAttribute.includes('_blank')) targetBlank = true;
    }
    if (tagName === 'a' && targetBlank) safeAttributes += ' rel="noopener noreferrer"';

    const isVoid = SORO_ARTICLE_VOID_TAGS.has(tagName);
    if (!isVoid && openTags.length >= SORO_ARTICLE_MAX_NESTING) {
      index = tagEnd + 1;
      continue;
    }
    output.push(`<${tagName}${safeAttributes}>`);
    if (!isVoid) openTags.push(tagName);
    index = tagEnd + 1;
  }

  while (openTags.length) output.push(`</${openTags.pop()}>`);
  return output.join('');
}

export function sanitizeSoroArticleHtmlForTests(html: string) {
  return sanitizeSoroArticleHtml(html);
}

function replaceHtmlTag(html: string, pattern: RegExp, replacement: string) {
  return pattern.test(html) ? html.replace(pattern, replacement) : html;
}

function parseSoroRss(xml: string): SoroArticle[] {
  const items = [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  return items
    .map((match) => {
      const item = match[1];
      const title = readRssTag(item, 'title');
      const link = readRssTag(item, 'link');
      const slug = extractSlugFromUrl(link);
      const description = readRssTag(item, 'description');
      const pubDate = readRssTag(item, 'pubDate');
      const guid = readRssTag(item, 'guid');
      const content = readRssTag(item, 'content:encoded');
      const mediaImage =
        sanitizeUrl(readRssAttr(item, 'media:(?:content|thumbnail)', 'url')) ||
        sanitizeUrl(readRssAttr(item, 'enclosure', 'url'));
      const image = mediaImage || firstImageFromHtml(content);
      return {
        title,
        slug,
        link,
        description,
        pubDate,
        guid,
        content,
        image,
      };
    })
    .filter((article) => article.title && article.slug && article.content);
}

function isLikelyValidSoroFeed(xml: unknown, articles: unknown) {
  return (
    typeof xml === 'string' &&
    xml.length > 0 &&
    xml.length <= SORO_RSS_MAX_BYTES &&
    /<rss\b/i.test(xml) &&
    Array.isArray(articles) &&
    articles.length > 0
  );
}

async function readSoroBackup(env: AppEnv) {
  if (!env.SORO_RSS_BACKUP) return { text: '', articles: [] as SoroArticle[] };
  const text = (await env.SORO_RSS_BACKUP.get(SORO_RSS_BACKUP_KEY)) || '';
  const articles = text ? parseSoroRss(text) : [];
  return { text, articles };
}

async function readSoroHiddenSlugs(env: AppEnv) {
  if (!env.SORO_RSS_BACKUP) return new Set<string>();
  const text = (await env.SORO_RSS_BACKUP.get(SORO_HIDDEN_SLUGS_KEY)) || '[]';
  try {
    const slugs: unknown = JSON.parse(text);
    if (!Array.isArray(slugs)) return new Set<string>();
    return new Set(
      slugs.filter((slug): slug is string => typeof slug === 'string' && isValidSoroSlug(slug)),
    );
  } catch {
    return new Set<string>();
  }
}

async function writeSoroHiddenSlugs(env: AppEnv, hiddenSlugs: Set<string>) {
  if (!env.SORO_RSS_BACKUP) return 'unbound';
  const slugs = [...hiddenSlugs].filter(isValidSoroSlug).sort();
  await env.SORO_RSS_BACKUP.put(SORO_HIDDEN_SLUGS_KEY, JSON.stringify(slugs, null, 2));
  return 'written';
}

function normalizeSoroBlogCacheVersion(value: string) {
  const version = String(value || '').trim();
  if (!version || version.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(version)) return '0';
  return version;
}

async function readSoroBlogCacheVersion(env: AppEnv) {
  if (!env.SORO_RSS_BACKUP) return 'unbound';
  const text = await env.SORO_RSS_BACKUP.get(SORO_BLOG_CACHE_VERSION_KEY);
  if (!text) return '0';
  try {
    const data: unknown = JSON.parse(text);
    return normalizeSoroBlogCacheVersion(
      isJsonObject(data) && typeof data.version === 'string' ? data.version : '',
    );
  } catch {
    return normalizeSoroBlogCacheVersion(text);
  }
}

function createSoroBlogCacheVersion() {
  const suffix = crypto.randomUUID();
  return `${Date.now().toString(36)}-${suffix}`;
}

async function touchSoroBlogCacheVersion(env: AppEnv, reason: string = 'content') {
  if (!env.SORO_RSS_BACKUP) return 'unbound';
  const updatedAt = new Date().toISOString();
  const version = createSoroBlogCacheVersion();
  await env.SORO_RSS_BACKUP.put(
    SORO_BLOG_CACHE_VERSION_KEY,
    JSON.stringify({ version, updatedAt, reason }),
  );
  return version;
}

function soroBlogCacheHeaders(cacheVersion: string) {
  const version = normalizeSoroBlogCacheVersion(cacheVersion);
  return {
    'Cache-Control': SORO_BLOG_HTML_CACHE,
    'CDN-Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
    Expires: '0',
    Pragma: 'no-cache',
    'X-Soro-Blog-Cache-Version': version,
    ETag: `W/"soro-blog-${version}"`,
  };
}

function injectSoroBlogCacheVersion(html: string, cacheVersion: string) {
  const version = normalizeSoroBlogCacheVersion(cacheVersion);
  const meta = `  <meta name="soro-blog-cache-version" content="${esc(version)}">`;
  return html.includes('</head>') ? html.replace('</head>', `${meta}\n</head>`) : html;
}

function filterVisibleSoroArticles(articles: SoroArticle[], hiddenSlugs: Set<string>) {
  if (!hiddenSlugs.size) return articles;
  return articles.filter((article) => !hiddenSlugs.has(article.slug));
}

async function writeSoroBackup(
  env: AppEnv,
  text: string,
  articles: SoroArticle[],
  previousText: string,
  previousArticles: SoroArticle[],
) {
  if (!env.SORO_RSS_BACKUP) return 'unbound';
  if (text === previousText) return 'unchanged';
  if (previousArticles.length && articles.length < previousArticles.length) return 'skip-smaller';

  const metadata = {
    updatedAt: new Date().toISOString(),
    itemCount: articles.length,
    bytes: text.length,
  };
  const cacheVersion = {
    version: createSoroBlogCacheVersion(),
    updatedAt: metadata.updatedAt,
    reason: 'rss-backup',
  };
  const write = Promise.all([
    env.SORO_RSS_BACKUP.put(SORO_RSS_BACKUP_KEY, text),
    env.SORO_RSS_BACKUP.put(SORO_RSS_BACKUP_META_KEY, JSON.stringify(metadata)),
    env.SORO_RSS_BACKUP.put(SORO_BLOG_CACHE_VERSION_KEY, JSON.stringify(cacheVersion)),
  ]);
  await write;
  return 'written';
}

async function fetchLiveSoroRss(env: AppEnv) {
  const rssUrl = String(env.SORO_RSS_URL || SORO_RSS_DEFAULT_URL).trim();
  return fetchAndConsumeWithTimeout(
    rssUrl,
    {
      headers: {
        Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1',
      },
    },
    SORO_RSS_FETCH_TIMEOUT_MS,
    async (response, signal) => {
      if (!response.ok) {
        cancelResponseBody(response, 'SORO_RSS_HTTP_ERROR');
        throw new Error(`Soro RSS HTTP ${response.status}`);
      }
      let bytes: Uint8Array;
      try {
        bytes = await readResponseBodyLimited(response, SORO_RSS_MAX_BYTES, signal);
      } catch (error) {
        if (error instanceof ResponseBodyTooLargeError) throw new Error('Soro RSS too large');
        throw error;
      }
      const text = new TextDecoder().decode(bytes);
      const articles = parseSoroRss(text);
      if (!isLikelyValidSoroFeed(text, articles)) throw new Error('Soro RSS invalid');
      return { text, articles };
    },
  );
}

interface SoroFeedData {
  text: string;
  articles: SoroArticle[];
}

interface SoroFeeds {
  live: SoroFeedData;
  backup: SoroFeedData;
  source: 'live' | 'backup';
  backupStatus: string;
  imageStatus?: string;
}

async function loadSoroFeeds(env: AppEnv, options: SoroFeedLoadOptions = {}): Promise<SoroFeeds> {
  const backup = await readSoroBackup(env);
  try {
    const live = await fetchLiveSoroRss(env);
    const backupStatus = await writeSoroBackup(
      env,
      live.text,
      live.articles,
      backup.text,
      backup.articles,
    );
    const imageStatus = options.mirrorImages
      ? await mirrorSoroImages(env, live.articles, { fetchMissing: true })
      : 'skipped';
    return { live, backup, source: 'live', backupStatus, imageStatus };
  } catch (error) {
    console.warn(
      '[SoroBlog] live RSS unavailable:',
      error instanceof Error ? error.message : error,
    );
    const imageStatus = options.mirrorImages
      ? await mirrorSoroImages(env, backup.articles, { fetchMissing: false })
      : 'skipped';
    return {
      live: { text: '', articles: [] as SoroArticle[] },
      backup,
      source: 'backup',
      backupStatus: 'live-error',
      imageStatus,
    };
  }
}

function queueSoroBackgroundRefresh(env: AppEnv, ctx: AppExecutionContext | undefined) {
  if (!ctx || !env.SORO_RSS_BACKUP) return;
  const now = Date.now();
  if (
    soroBackgroundRefreshPromise &&
    now - soroBackgroundRefreshStartedAt < SORO_BACKGROUND_REFRESH_MIN_INTERVAL_MS
  ) {
    ctx.waitUntil(soroBackgroundRefreshPromise);
    return;
  }
  if (now - soroBackgroundRefreshStartedAt < SORO_BACKGROUND_REFRESH_MIN_INTERVAL_MS) return;

  soroBackgroundRefreshStartedAt = now;
  const refresh = loadSoroFeeds(env, { mirrorImages: true }).then(
    () => undefined,
    (error: unknown) => {
      console.warn(
        '[SoroBlog] background refresh unavailable:',
        error instanceof Error ? error.message : error,
      );
    },
  );
  const tracked = refresh.finally(() => {
    if (soroBackgroundRefreshPromise === tracked) soroBackgroundRefreshPromise = null;
  });
  soroBackgroundRefreshPromise = tracked;
  ctx.waitUntil(tracked);
}

async function loadSoroFeedsForPublic(
  env: AppEnv,
  ctx: AppExecutionContext | undefined,
  options: SoroFeedLoadOptions = {},
): Promise<SoroFeeds> {
  const backup = await readSoroBackup(env);
  if (backup.articles.length > 0) {
    queueSoroBackgroundRefresh(env, ctx);
    return {
      live: { text: '', articles: [] as SoroArticle[] },
      backup,
      source: 'backup',
      backupStatus: 'cached',
    };
  }

  return loadSoroFeeds(env, { mirrorImages: Boolean(options.mirrorImages) });
}

function findSoroArticle(feeds: SoroFeeds, slug: string) {
  const liveArticle = feeds.live.articles.find((article) => article.slug === slug);
  if (liveArticle) return { article: liveArticle, source: 'live' };
  const backupArticle = feeds.backup.articles.find((article) => article.slug === slug);
  if (backupArticle) return { article: backupArticle, source: 'backup' };
  return { article: null, source: '' };
}

function isPotentialSoroArticlePath(pathname: string) {
  const match = pathname.match(/^\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
  if (!match) return '';
  const slug = match[1];
  const reserved = new Set([
    'about',
    'blog',
    'privacy',
    'terms',
    'faq',
    'history',
    'designsystem',
    'landing',
    'changelog',
    'roadmap',
    'index',
    'robots',
    'sitemap',
  ]);
  return slug && !reserved.has(slug) ? slug : '';
}

function isPotentialSoroBlogArticlePath(pathname: string) {
  const match = pathname.match(/^\/blog\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
  return match?.[1] ?? '';
}

function renderSoroArticleBodyHtml(
  article: Pick<SoroArticle, 'title' | 'pubDate'>,
  image: string,
  published: string,
  blogUrl: string,
  safeContent: string,
) {
  return `<div class="soro-blog">
    <article class="soro-blog-article">
      <div class="soro-blog-header">
        <a class="soro-blog-back" href="${esc(blogUrl)}"><span class="soro-blog-back-arrow" aria-hidden="true">&larr;</span> <span class="soro-blog-back-label">All articles</span></a>
      </div>
      <header>
        <h1 class="soro-blog-article-title">${esc(article.title)}</h1>
        ${published ? `<time class="soro-blog-article-date" datetime="${esc(published)}">${esc(article.pubDate)}</time>` : ''}
      </header>
      ${image ? `<img class="soro-blog-article-image" src="${esc(image)}" alt="${esc(article.title)}">` : ''}
      <div class="soro-blog-article-content">${safeContent}</div>
    </article>
  </div>`;
}

function renderSoroArticleInBlogShell(
  templateHtml: string,
  article: SoroArticle,
  requestUrl: string | URL,
  source: string,
) {
  const url = new URL(requestUrl);
  const pageUrl = `${url.origin}${soroArticlePath(article.slug)}`;
  const blogUrl = `${url.origin}/blog`;
  const title = `${article.title} · MUSIXQUARE`;
  const description = article.description || 'MUSIXQUARE blog article.';
  const image = soroArticleImageUrl(article, url.origin, source);
  const published = article.pubDate ? new Date(article.pubDate).toISOString() : '';
  const safeContent = sanitizeSoroArticleHtml(article.content);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: article.title,
    description,
    datePublished: published || undefined,
    image,
    url: pageUrl,
    mainEntityOfPage: pageUrl,
    publisher: {
      '@type': 'Organization',
      name: 'MUSIXQUARE',
      url: url.origin,
    },
  };
  const articleHtml = renderSoroArticleBodyHtml(article, image, published, blogUrl, safeContent);

  let html = templateHtml
    .replace('<div id="soro-blog"></div>', `<div id="soro-blog">${articleHtml}</div>`)
    .replace(
      /\n?<script src="https:\/\/app\.trysoro\.com\/api\/embed\/a07c133f-e3b9-401e-a076-ee36124598a7" defer><\/script>/,
      '',
    )
    .replace(
      /<body\b([^>]*)>/i,
      (_match: string, attributes: string) =>
        `<body${attributes} data-soro-source="${esc(source)}" data-soro-view="article">`,
    )
    .replace('<h2>Latest articles</h2>', '<h2>Article</h2>');

  html = replaceHtmlTag(html, /<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`);
  html = replaceHtmlTag(
    html,
    /<link rel="canonical" href="[^"]*">/i,
    `<link rel="canonical" href="${esc(pageUrl)}">`,
  );
  html = replaceHtmlTag(
    html,
    /<meta name="description" content="[^"]*">/i,
    `<meta name="description" content="${esc(description)}">`,
  );
  html = replaceHtmlTag(
    html,
    /<meta property="og:title" content="[^"]*">/i,
    `<meta property="og:title" content="${esc(article.title)}">`,
  );
  html = replaceHtmlTag(
    html,
    /<meta property="og:description" content="[^"]*">/i,
    `<meta property="og:description" content="${esc(description)}">`,
  );
  html = replaceHtmlTag(
    html,
    /<meta property="og:type" content="[^"]*">/i,
    '<meta property="og:type" content="article">',
  );
  html = replaceHtmlTag(
    html,
    /<meta property="og:url" content="[^"]*">/i,
    `<meta property="og:url" content="${esc(pageUrl)}">`,
  );
  html = replaceHtmlTag(
    html,
    /<meta property="og:image" content="[^"]*">/i,
    `<meta property="og:image" content="${esc(image)}">`,
  );
  html = replaceHtmlTag(
    html,
    /<meta property="og:image:alt" content="[^"]*">/i,
    `<meta property="og:image:alt" content="${esc(article.title)}">`,
  );
  html = replaceHtmlTag(
    html,
    /<meta name="twitter:title" content="[^"]*">/i,
    `<meta name="twitter:title" content="${esc(article.title)}">`,
  );
  html = replaceHtmlTag(
    html,
    /<meta name="twitter:description" content="[^"]*">/i,
    `<meta name="twitter:description" content="${esc(description)}">`,
  );
  html = replaceHtmlTag(
    html,
    /<meta name="twitter:image" content="[^"]*">/i,
    `<meta name="twitter:image" content="${esc(image)}">`,
  );
  return html.replace(
    '</head>',
    `  <script type="application/ld+json">${serializeJsonForHtmlScript(jsonLd)}</script>\n</head>`,
  );
}

function renderSoroArticleHtml(
  article: SoroArticle,
  requestUrl: string | URL,
  source: string,
  templateHtml = '',
) {
  if (templateHtml) return renderSoroArticleInBlogShell(templateHtml, article, requestUrl, source);

  const url = new URL(requestUrl);
  const pageUrl = `${url.origin}${soroArticlePath(article.slug)}`;
  const blogUrl = `${url.origin}/blog`;
  const title = `${article.title} · MUSIXQUARE`;
  const description = article.description || 'MUSIXQUARE blog article.';
  const image = soroArticleImageUrl(article, url.origin, source);
  const published = article.pubDate ? new Date(article.pubDate).toISOString() : '';
  const safeContent = sanitizeSoroArticleHtml(article.content);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: article.title,
    description,
    datePublished: published || undefined,
    image,
    url: pageUrl,
    mainEntityOfPage: pageUrl,
    publisher: {
      '@type': 'Organization',
      name: 'MUSIXQUARE',
      url: url.origin,
    },
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#1a1a1a">
  <title>${esc(title)}</title>
  <link rel="canonical" href="${esc(pageUrl)}">
  <link rel="alternate" type="application/rss+xml" title="MUSIXQUARE Blog RSS" href="${esc(String(SORO_RSS_DEFAULT_URL))}">
  <meta name="description" content="${esc(description)}">
  <meta property="og:title" content="${esc(article.title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="MUSIXQUARE">
  <meta property="og:locale" content="en_US">
  <meta property="og:url" content="${esc(pageUrl)}">
  <meta property="og:image" content="${esc(image)}">
  <meta property="og:image:alt" content="${esc(article.title)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(article.title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${esc(image)}">
  <link rel="icon" href="/designsystem/assets/favicon.svg">
  <link rel="preload" href="/designsystem/fonts/PretendardVariable.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/designsystem/src_ref/pretendard.css">
  <link rel="stylesheet" href="/designsystem/colors_and_type.css">
  <link rel="stylesheet" href="/editorial-base.css">
  <style>
    .soro-article-page { max-width: 880px; padding-top: 168px; }
    .soro-article-back { display: inline-flex; gap: 8px; margin-bottom: 34px; color: #c6cbd6; font-size: 14px; font-weight: 800; text-decoration: none; }
    .soro-article-back-label { text-decoration: underline; text-underline-offset: 4px; }
    .soro-article-title { margin: 0 0 14px; color: var(--text-main); font-size: clamp(38px, 6vw, 72px); line-height: 1.02; letter-spacing: 0; }
    .soro-article-meta { margin: 0 0 32px; color: #9aa3b2; font-size: 14px; font-weight: 800; }
    .soro-article-image { width: 100%; margin: 0 0 38px; display: block; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 8px; background: var(--surface-2); }
    .soro-article-content { color: #d7dbe4; font-size: 18px; line-height: 1.78; }
    .soro-article-content p { margin: 0 0 18px; color: #d7dbe4; }
    .soro-article-content h2, .soro-article-content h3 { color: var(--text-main); letter-spacing: 0; }
    .soro-article-content h2 { margin: 44px 0 16px; font-size: 31px; line-height: 1.18; }
    .soro-article-content h3 { margin: 32px 0 14px; font-size: 23px; line-height: 1.25; }
    .soro-article-content ul, .soro-article-content ol { margin: 0 0 18px; padding-left: 24px; }
    .soro-article-content li { margin-bottom: 8px; }
    .soro-article-content a { color: #86b7ff; text-decoration: underline; text-underline-offset: 3px; }
    .soro-article-content img { max-width: 100%; height: auto; border-radius: 8px; }
    @media (max-width: 720px) {
      .soro-article-page { padding-top: 118px; }
      .soro-article-content { font-size: 16px; }
      .soro-article-content h2 { font-size: 26px; }
    }
  </style>
  <script type="application/ld+json">${serializeJsonForHtmlScript(jsonLd)}</script>
</head>
<body class="editorial-page editorial-blog" data-soro-source="${esc(source)}" data-soro-view="article">
<header class="lp-header">
  <div class="lp-header-progress" aria-hidden="true"></div>
  <a class="lp-logo" href="https://musixquare.com" aria-label="MUSIXQUARE home">
    <span class="editorial-wordmark" aria-hidden="true"></span>
  </a>
  <a class="lp-try" href="https://musixquare.com" aria-label="Try MUSIXQUARE now">
    <span class="lp-try__dot" aria-hidden="true"></span>
    <span>Try it now</span>
  </a>
</header>
<nav class="editorial-site-tabs" aria-label="MUSIXQUARE editorial pages">
  <div class="editorial-site-tabs__inner">
    <a class="editorial-site-tab" href="/about">About</a>
    <a class="editorial-site-tab is-active" href="/blog" aria-current="page">Blog</a>
    <a class="editorial-site-tab" href="/history">History</a>
    <a class="editorial-site-tab" href="/designsystem">Design</a>
  </div>
</nav>
<main class="page soro-article-page">
  <article>
    <a class="soro-article-back" href="${esc(blogUrl)}"><span class="soro-article-back-arrow" aria-hidden="true">&larr;</span> <span class="soro-article-back-label">All articles</span></a>
    <header>
      <h1 class="soro-article-title">${esc(article.title)}</h1>
      ${published ? `<time class="soro-article-meta" datetime="${esc(published)}">${esc(article.pubDate)}</time>` : ''}
    </header>
    ${image ? `<img class="soro-article-image" src="${esc(image)}" alt="${esc(article.title)}">` : ''}
    <div class="soro-article-content">${safeContent}</div>
  </article>
</main>
<footer>
  <span>
    © 2026 MUSIXQUARE
    <span aria-hidden="true">·</span>
    <a href="mailto:contact@musixquare.com">contact@musixquare.com</a>
  </span>
  <span>
    <a href="https://musixquare.com" target="_blank" rel="noopener noreferrer">App</a>
    <a href="https://github.com/hiefny/MUSIXQUARE" target="_blank" rel="noopener noreferrer">GitHub</a>
    <a href="https://discord.gg/PmmFhGTBsX" target="_blank" rel="noopener noreferrer">Discord</a>
  </span>
</footer>
</body>
</html>`;
}

async function serveSoroArticlePage(
  request: Request,
  env: AppEnv,
  slug: string,
  ctx: AppExecutionContext | undefined,
) {
  const [initialFeeds, hiddenSlugs] = await Promise.all([
    loadSoroFeedsForPublic(env, ctx),
    readSoroHiddenSlugs(env),
  ]);
  let feeds = initialFeeds;
  const cacheVersion = await readSoroBlogCacheVersion(env);
  if (hiddenSlugs.has(slug)) return null;
  let { article, source } = findSoroArticle(feeds, slug);
  if (!article && feeds.source === 'backup') {
    feeds = await loadSoroFeeds(env);
    ({ article, source } = findSoroArticle(feeds, slug));
    if (hiddenSlugs.has(slug)) return null;
  }
  if (!article) return null;
  const imageStatus = mapSoroArticleImagePath(article);

  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    ...soroBlogCacheHeaders(cacheVersion),
    'X-Soro-Article-Source': source,
    'X-Soro-Backup-Status': feeds.backupStatus || 'unknown',
    'X-Soro-Image-Status': imageStatus,
  };
  if (request.method === 'HEAD') {
    return withSecurityHeaders(new Response(null, { status: 200, headers }), headers);
  }

  const shellResponse = await fetchAsset(env, request, '/blog/index.html');
  const shellContentType = shellResponse.headers.get('content-type') || '';
  const shellHtml = shellContentType.includes('text/html') ? await shellResponse.text() : '';
  const html = injectSoroBlogCacheVersion(
    renderSoroArticleHtml(article, request.url, source, shellHtml),
    cacheVersion,
  );
  return withSecurityHeaders(
    new Response(html, {
      status: 200,
      headers,
    }),
    headers,
  );
}

async function hasSoroArticlePublic(
  env: AppEnv,
  ctx: AppExecutionContext | undefined,
  slug: string,
) {
  const [feeds, hiddenSlugs] = await Promise.all([
    loadSoroFeedsForPublic(env, ctx),
    readSoroHiddenSlugs(env),
  ]);
  if (hiddenSlugs.has(slug)) return false;
  const { article } = findSoroArticle(feeds, slug);
  return Boolean(article);
}

async function findSoroImageArticleForKey(env: AppEnv, key: string) {
  const backup = await readSoroBackup(env);
  let article = backup.articles.find((candidate) => soroImageKey(candidate) === key);
  if (article) return article;

  try {
    const feeds = await loadSoroFeeds(env);
    article = [...feeds.live.articles, ...feeds.backup.articles].find(
      (candidate) => soroImageKey(candidate) === key,
    );
    return article || null;
  } catch {
    return null;
  }
}

async function serveSoroBlogIndex(
  request: Request,
  env: AppEnv,
  ctx: AppExecutionContext | undefined,
) {
  const response = await fetchAsset(env, request, '/blog/index.html');
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return withSecurityHeaders(response);

  const [feeds, hiddenSlugs] = await Promise.all([
    loadSoroFeedsForPublic(env, ctx),
    readSoroHiddenSlugs(env),
  ]);
  const cacheVersion = await readSoroBlogCacheVersion(env);
  const source = feeds.source === 'live' ? 'live' : 'backup';
  const articles = sortedSoroArticles(
    filterVisibleSoroArticles(
      source === 'live' ? feeds.live.articles : feeds.backup.articles,
      hiddenSlugs,
    ),
  );
  const imageStatus = mapSoroListImagePaths(articles);
  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    ...soroBlogCacheHeaders(cacheVersion),
    'X-Soro-Index-Source': source,
    'X-Soro-Backup-Status': feeds.backupStatus || 'unknown',
    'X-Soro-Image-Status': imageStatus || 'none',
  };

  if (request.method === 'HEAD') {
    return withSecurityHeaders(
      new Response(null, { status: response.status, headers: response.headers }),
      headers,
    );
  }

  const origin = new URL(request.url).origin;
  const blogHtml = renderSoroBlogListHtml(articles, origin, source);
  let html = await response.text();
  html = html
    .replace('<div id="soro-blog"></div>', `<div id="soro-blog">${blogHtml}</div>`)
    .replace(
      /\n?<script src="https:\/\/app\.trysoro\.com\/api\/embed\/a07c133f-e3b9-401e-a076-ee36124598a7" defer><\/script>/,
      '',
    );
  html = injectSoroBlogCacheVersion(html, cacheVersion);

  return withSecurityHeaders(
    new Response(html, { status: response.status, headers: response.headers }),
    headers,
  );
}

async function serveSoroImage(request: Request, env: AppEnv, key: string) {
  if (!env.SORO_IMAGE_BUCKET) {
    return withSecurityHeaders(new Response('Not found', { status: 404 }));
  }

  let object = await env.SORO_IMAGE_BUCKET.get(key);
  if (!object && request.method !== 'HEAD') {
    const article = await findSoroImageArticleForKey(env, key);
    if (article) {
      await ensureSoroImageMirror(env, article, { fetchMissing: true });
      object = await env.SORO_IMAGE_BUCKET.get(key);
    }
  }
  if (!object) return withSecurityHeaders(new Response('Not found', { status: 404 }));

  const headers: Record<string, string> = {
    'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
    'Cache-Control': object.httpMetadata?.cacheControl || SORO_IMAGE_CACHE,
  };
  if (object.httpEtag) headers.ETag = object.httpEtag;

  if (request.method === 'HEAD') {
    return withSecurityHeaders(new Response(null, { status: 200, headers }), headers);
  }

  return withSecurityHeaders(new Response(object.body, { status: 200, headers }), headers);
}

async function fetchAsset(env: AppEnv, request: Request, pathname: string | null = null) {
  const assets = env.ASSETS;
  if (!assets) throw new Error('ASSETS binding unavailable');
  const assetUrl = new URL(request.url);
  if (pathname) assetUrl.pathname = pathname;
  assetUrl.search = pathname ? '' : assetUrl.search;
  return assets.fetch(new Request(assetUrl, request));
}

function injectAboutRoomCount(html: string, roomsOpened: unknown) {
  const value = isLifetimeRoomCount(roomsOpened) ? String(roomsOpened) : '';
  return html.replace(/<html\b([^>]*)>/i, (_match, attributes) => {
    const withoutExistingValue = String(attributes).replace(
      /\sdata-mxqr-rooms-opened=(?:"[^"]*"|'[^']*')/gi,
      '',
    );
    return `<html${withoutExistingValue} data-mxqr-rooms-opened="${value}">`;
  });
}

function dynamicAboutHeaders(sourceHeaders: HeadersInit | undefined) {
  const headers = new Headers(sourceHeaders);
  headers.delete('Content-Length');
  headers.delete('Content-Encoding');
  headers.delete('ETag');
  headers.delete('Last-Modified');
  return headers;
}

async function serveAboutPage(request: Request, env: AppEnv, ctx: AppExecutionContext | undefined) {
  // `/about` is a dynamic representation even though its shell comes from the
  // asset binding. Ignore validators/ranges that target the unmodified asset,
  // otherwise a static 304 or partial body could bypass the daily snapshot.
  const assetHeaders = new Headers(request.headers);
  assetHeaders.delete('If-None-Match');
  assetHeaders.delete('If-Modified-Since');
  assetHeaders.delete('If-Range');
  assetHeaders.delete('Range');
  const response = await fetchAsset(
    env,
    new Request(request, { headers: assetHeaders }),
    '/about.html',
  );
  const contentType = response.headers.get('content-type') || '';
  const pageHeaders = cacheHeadersForPath(new URL(request.url).pathname, '/about.html');
  if (!contentType.includes('text/html')) {
    return withSecurityHeaders(response, pageHeaders);
  }
  if (request.method === 'HEAD') {
    return withSecurityHeaders(
      new Response(null, {
        status: response.status,
        headers: dynamicAboutHeaders(response.headers),
      }),
      pageHeaders,
    );
  }

  const roomsOpened = await readLifetimeRoomCountSnapshot(request, env, ctx);
  const html = injectAboutRoomCount(await response.text(), roomsOpened);
  const headers = dynamicAboutHeaders(response.headers);
  return withSecurityHeaders(new Response(html, { status: response.status, headers }), pageHeaders);
}

async function serveInvitePage(request: Request, env: AppEnv, code: string) {
  const response = await fetchAsset(env, request, '/index.html');
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return withSecurityHeaders(response);
  const inviteHeaders = {
    'Content-Type': 'text/html; charset=utf-8',
    ...APP_SHELL_FRESH_CACHE_HEADERS,
    // Invite URLs can expose a live or persistent room code when shared in a
    // crawlable context. Keep rich Open Graph previews, but do not let search
    // engines turn private entry points into search results.
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Invite-Rewrite': code,
  };
  if (request.method === 'HEAD') {
    return withSecurityHeaders(
      new Response(null, { status: response.status, headers: response.headers }),
      inviteHeaders,
    );
  }
  const html = rewriteInviteMeta(await response.text(), code, new URL(request.url).origin);
  return withSecurityHeaders(
    new Response(html, { status: response.status, headers: response.headers }),
    inviteHeaders,
  );
}

function redirectTarget(pathname: string) {
  const lower = pathname.toLowerCase();
  if (['/landing', '/landing/'].includes(lower)) return '/about';
  if (['/changelog', '/changelog/', '/roadmap', '/roadmap/'].includes(lower)) return '/history';
  const canonical = new Map([
    ['/about', '/about'],
    ['/blog', '/blog'],
    ['/privacy', '/privacy'],
    ['/terms', '/terms'],
    ['/faq', '/faq'],
    ['/developers', '/developers'],
    ['/history', '/history'],
    ['/designsystem', '/designsystem'],
  ]);
  const eventSlug = eventCampaignSlugFromPath(lower);
  if (eventSlug) {
    const canonicalEventPath = eventPublicPathFromSlug(eventSlug);
    if (pathname !== lower || lower.replace(/\/$/, '') !== canonicalEventPath.replace(/\/$/, '')) {
      return canonicalEventPath;
    }
  }
  if (pathname !== lower && canonical.has(lower.replace(/\/$/, ''))) {
    return canonical.get(lower.replace(/\/$/, '')) ?? null;
  }
  return null;
}

function eventPublicPathFromSlug(slug: string) {
  const edition = /^([a-z0-9]+(?:-[a-z0-9]+)*)-(\d+)$/.exec(slug);
  const namespace = edition?.[1];
  const number = edition?.[2];
  return namespace && number ? `/events/${namespace}/${number}/` : `/events/${slug}/`;
}

function eventCampaignSlugFromPath(pathname: string) {
  const path = String(pathname || '').replace(/\/$/, '');
  const direct = /^\/events\/([^/]+)$/.exec(path);
  const directSlug = direct?.[1];
  if (directSlug && EVENT_CAMPAIGN_SLUG_RE.test(directSlug)) return directSlug;

  // Preserve the initially published /events/asamo/0 shape while allowing the
  // control plane to use the canonical campaign slug `asamo-0`. New campaigns
  // can use /events/<slug>; this compatibility form deliberately accepts only
  // a validated namespace + numeric-edition path so arbitrary nested static paths
  // can never be interpreted as campaign identifiers.
  const legacy = /^\/events\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(\d+)$/.exec(path);
  if (!legacy) return null;
  const legacyNamespace = legacy[1];
  const legacyEdition = legacy[2];
  if (!legacyNamespace || !legacyEdition) return null;
  const slug = `${legacyNamespace}-${legacyEdition}`;
  return EVENT_CAMPAIGN_SLUG_RE.test(slug) ? slug : null;
}

function routeStaticPath(pathname: string) {
  const path = pathname.toLowerCase();
  if (path === '/about' || path === '/about/') return '/about.html';
  if (path === '/blog' || path === '/blog/') return '/blog/index.html';
  if (path === '/privacy' || path === '/privacy/') return '/privacy.html';
  if (path === '/terms' || path === '/terms/') return '/terms.html';
  if (path === '/faq' || path === '/faq/') return '/faq.html';
  if (path === '/developers' || path === '/developers/') return '/developers.html';
  if (path === '/history' || path === '/history/') return '/history/index.html';
  if (path === '/designsystem' || path === '/designsystem/') return '/designsystem/index.html';
  if (eventCampaignSlugFromPath(path)) return EVENT_PAGE_ASSET_PATH;
  return null;
}

function cacheHeadersForPath(pathname: string, assetPathname = pathname): Record<string, string> {
  if (pathname.toLowerCase().startsWith('/events/')) {
    return {
      ...APP_SHELL_FRESH_CACHE_HEADERS,
      'X-Robots-Tag': 'noindex, nofollow',
    };
  }
  if (
    assetPathname === '/admin.js' ||
    assetPathname === '/admin.css' ||
    assetPathname === '/clearable-editors.js'
  ) {
    return APP_SHELL_FRESH_CACHE_HEADERS;
  }
  if (assetPathname === '/service-worker.js') return { 'Cache-Control': 'no-cache' };
  if (/^\/og-.+\.png$/.test(assetPathname)) {
    return { 'Cache-Control': 'public, max-age=86400, s-maxage=604800' };
  }
  if (
    assetPathname.startsWith('/assets/') ||
    assetPathname.startsWith('/fonts/') ||
    assetPathname.startsWith('/landing/') ||
    assetPathname.startsWith('/designsystem/fonts/') ||
    assetPathname.startsWith('/designsystem/assets/')
  ) {
    return { 'Cache-Control': 'public, max-age=31536000, immutable' };
  }
  if (
    [
      '/about',
      '/blog',
      '/privacy',
      '/terms',
      '/faq',
      '/developers',
      '/history',
      '/designsystem',
    ].includes(pathname.toLowerCase().replace(/\/$/, ''))
  ) {
    return {
      'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800',
    };
  }
  return {};
}

function isLocalHttpHost(hostname: string) {
  const normalized = String(hostname)
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/:\d+$/, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isLocalHttpRequest(request: Request, url: URL) {
  return (
    isLocalHttpHost(url.hostname) ||
    isLocalHttpHost(url.host) ||
    isLocalHttpHost(request.headers.get('host') || '')
  );
}

async function serveStatic(request: Request, env: AppEnv, ctx: AppExecutionContext | undefined) {
  const url = new URL(request.url);
  const assetPathname = routeStaticPath(url.pathname);
  const redirect = redirectTarget(url.pathname);
  if (redirect) return Response.redirect(new URL(redirect, url).href, 301);

  if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
    return withSecurityHeaders(
      await fetchAsset(env, request, '/index.html'),
      APP_SHELL_FRESH_CACHE_HEADERS,
    );
  }

  if (url.pathname === '/index.html' && (request.method === 'GET' || request.method === 'HEAD')) {
    return withSecurityHeaders(
      await fetchAsset(env, request, '/index.html'),
      APP_SHELL_FRESH_CACHE_HEADERS,
    );
  }

  const inviteMatch = url.pathname.match(/^\/(\d{6})$/);
  if (inviteMatch && (request.method === 'GET' || request.method === 'HEAD')) {
    const inviteCode = inviteMatch[1];
    if (inviteCode) return serveInvitePage(request, env, inviteCode);
  }

  if (/^\/og\/invite\/\d{6}\.png$/.test(url.pathname)) {
    const response = await fetchAsset(env, request, '/og-invite.png');
    return withSecurityHeaders(response, {
      'Cache-Control': 'public, max-age=86400, s-maxage=604800',
      'X-OG-Source': 'static',
    });
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    if (url.pathname.toLowerCase().startsWith('/designsystem/ui_kits/')) {
      return withSecurityHeaders(
        new Response(request.method === 'HEAD' ? null : 'Not found', {
          status: 404,
          headers: { 'Cache-Control': 'no-store' },
        }),
      );
    }

    if (url.pathname === '/blog' || url.pathname === '/blog/') {
      const post = url.searchParams.get('post') || '';
      if (isValidSoroSlug(post)) {
        const hiddenSlugs = await readSoroHiddenSlugs(env);
        if (!hiddenSlugs.has(post))
          return Response.redirect(new URL(soroArticlePath(post), url).href, 301);
      }
      return serveSoroBlogIndex(request, env, ctx);
    }

    const soroBlogSlug = isPotentialSoroBlogArticlePath(url.pathname);
    if (soroBlogSlug) {
      const canonicalPath = soroArticlePath(soroBlogSlug);
      if (url.pathname !== canonicalPath)
        return Response.redirect(new URL(canonicalPath, url).href, 301);
      const articleResponse = await serveSoroArticlePage(request, env, soroBlogSlug, ctx);
      return articleResponse || withSecurityHeaders(new Response('Not found', { status: 404 }));
    }

    const soroImageKey = soroImageKeyFromPathname(url.pathname);
    if (soroImageKey) return serveSoroImage(request, env, soroImageKey);

    // Canonical static documents take precedence over the legacy root-level
    // Soro slug fallback. Otherwise paths such as /developers perform a live
    // RSS request merely to prove that they are not article slugs.
    if (assetPathname) {
      if (assetPathname === '/about.html') return serveAboutPage(request, env, ctx);
      const response = await fetchAsset(env, request, assetPathname);
      return withSecurityHeaders(response, {
        ...cacheHeadersForPath(url.pathname, assetPathname),
      });
    }

    const soroSlug = isPotentialSoroArticlePath(url.pathname);
    if (soroSlug) {
      if (await hasSoroArticlePublic(env, ctx, soroSlug)) {
        return Response.redirect(new URL(soroArticlePath(soroSlug), url).href, 301);
      }
    }
  }

  const response = assetPathname
    ? await fetchAsset(env, request, assetPathname)
    : await fetchAsset(env, request);

  // Allow HEAD alongside GET so link unfurlers (Slack/Discord/iMessage) that
  // HEAD-probe before fetching don't see a broken-link 404 for SPA routes.
  // Keep this aligned with the GET+HEAD pairing at the invite path.
  if (
    response.status === 404 &&
    (request.method === 'GET' || request.method === 'HEAD') &&
    (request.headers.get('Accept') || '').includes('text/html') &&
    !url.pathname.toLowerCase().startsWith('/events/')
  ) {
    return withSecurityHeaders(
      await fetchAsset(env, request, '/index.html'),
      APP_SHELL_FRESH_CACHE_HEADERS,
    );
  }

  return withSecurityHeaders(response, {
    ...cacheHeadersForPath(url.pathname, assetPathname || url.pathname),
  });
}

export default {
  async scheduled(event: { cron?: unknown }, env: unknown, ctx: AppExecutionContext) {
    if (!isAppEnv(env)) throw new TypeError('App Worker environment unavailable');
    const serviceStatus = await readServiceMaintenance(env);
    if (serviceStatus.enabled) return;

    const cron = typeof event?.cron === 'string' ? event.cron : null;
    if (cron === null || cron === '0 */6 * * *') {
      ctx.waitUntil(loadSoroFeeds(env, { mirrorImages: true }));
      ctx.waitUntil(cleanupExpiredAdminMetrics(env));
      ctx.waitUntil(cleanupExpiredProRoomAdminAudit(env));
      if (env.MUSIXQUARE_AUTH_DB) ctx.waitUntil(cleanupExpiredAccountSessions(env));
      if (env.MUSIXQUARE_AUTH_DB && getAdminDb(env)) {
        // Repair sweep: the room Durable Object can finish decommissioning
        // through its own alarm without another admin DELETE request.
        ctx.waitUntil(retireDecommissionedAccountProRoomEdges(env));
      }
      const adminDb = getAdminDb(env);
      if (adminDb && getProRoomAdminNamespace(env)) {
        // Repair the display/index mirror after a successful canonical room
        // activation whose best-effort D1 write was interrupted. Exact
        // generation and terminal-state predicates remain enforced by the
        // reconciliation update.
        ctx.waitUntil(
          (async () => {
            try {
              const rooms = await listAdminProRooms(adminDb);
              await reconcileStaleAdminProRoomActivations(env, adminDb, rooms);
            } catch (error) {
              console.warn('[PRO registry] activation-state reconciliation failed', error);
            }
          })(),
        );
      }
    }
    if (env.MUSIXQUARE_AUTH_DB && (cron === null || cron === '* * * * *')) {
      ctx.waitUntil(
        cleanupPendingAccountDeletions(env, {
          purgeProRoomAccountAuthority: (input) => purgeProRoomAccountAuthority(input, env),
          orphanAccountProGrants: (accountId: string) => orphanAccountProGrants(env, accountId),
        }),
      );
      if (getAdminDb(env)) {
        ctx.waitUntil(
          retireDecommissionedAccountProRoomEdges(env, {
            sinceMs: Date.now() - 15 * 60 * 1000,
          }),
        );
      }
    }
    const reconciliationDb = getAdminDb(env);
    if (
      (cron === null || cron === '* * * * *') &&
      reconciliationDb &&
      getProRoomAdminNamespace(env)
    ) {
      ctx.waitUntil(
        (async () => {
          try {
            await reconcileOwnerTransferSagas(env, reconciliationDb);
          } catch (error) {
            console.warn('[PRO owner transfer] scheduled reconciliation failed', error);
          }
        })(),
      );
      ctx.waitUntil(
        reconcileProGrantLifecycle(env, proGrantDependencies(env)).catch((error) => {
          console.warn('[PRO grants] scheduled reconciliation failed', error);
        }),
      );
    }
  },

  async fetch(request: Request, env: unknown, ctx?: AppExecutionContext) {
    if (!isAppEnv(env)) throw new TypeError('App Worker environment unavailable');
    const url = new URL(request.url);
    const mustUpgradeProtocol = url.protocol === 'http:' && !isLocalHttpRequest(request, url);
    const mustUseCanonicalHost = url.hostname === 'www.musixquare.com';
    const trailingInviteMatch =
      request.method === 'GET' || request.method === 'HEAD'
        ? url.pathname.match(/^\/(\d{6})\/$/)
        : null;
    if (mustUpgradeProtocol || mustUseCanonicalHost || trailingInviteMatch) {
      if (mustUpgradeProtocol) url.protocol = 'https:';
      if (mustUseCanonicalHost) url.hostname = 'musixquare.com';
      if (trailingInviteMatch) url.pathname = `/${trailingInviteMatch[1]}`;
      return withSecurityHeaders(Response.redirect(url.href, 308));
    }

    if (!isServiceMaintenanceAdminBypass(request, url)) {
      const maintenance = readCachedServiceMaintenance(env);
      if (maintenance.refreshNeeded) {
        // Deliberately detach the control-plane refresh from the public fetch
        // promise. A wedged cross-Worker binding must never hold user traffic
        // open while the last canonical state remains usable.
        const refresh = new Promise<void>((resolve) => setTimeout(resolve, 0))
          .then(() => readServiceMaintenance(env))
          .then(() => undefined)
          .catch(() => undefined);
        if (ctx) ctx.waitUntil(refresh);
      }
      if (maintenance.state?.enabled) {
        return withSecurityHeaders(
          serviceMaintenanceResponse(request, maintenance.state, {
            format: url.pathname.startsWith('/api/') ? 'json' : 'html',
          }),
        );
      }
    }

    if (url.pathname.startsWith('/api/auth/')) {
      let rateKey = 'account-auth-mutation';
      let rateLimit = 120;
      let rateWindowSeconds = 60;
      if (url.pathname === '/api/auth/google/start') {
        rateKey = 'account-auth-start';
        // Match the advertised 100-device venue ceiling while retaining a
        // bounded per-IP OAuth initiation budget.
        rateLimit = 120;
        rateWindowSeconds = 10 * 60;
      } else if (url.pathname === '/api/auth/google/callback') {
        rateKey = 'account-auth-callback';
        rateLimit = 120;
        rateWindowSeconds = 10 * 60;
      } else if (url.pathname === '/api/auth/session') {
        // A 100-device venue can legitimately restore many tabs together.
        // This generous ceiling only bounds obviously automated D1 probing.
        rateKey = 'account-auth-session';
        rateLimit = 600;
      } else if (url.pathname === '/api/auth/stats') {
        // Aggregate-only reporting is optional and may flush concurrently for
        // many signed-in listeners behind one venue NAT. Isolate it so a
        // reporting burst cannot consume profile/logout mutation capacity.
        rateKey = 'account-auth-stats';
        rateLimit = 300;
      } else if (url.pathname === '/api/auth/room-assertion') {
        // A full 100-device room refreshes 60-second assertions every 30s:
        // roughly 200 requests/minute behind one venue NAT. Keep this separate
        // from low-frequency profile/logout mutations so a healthy room cannot
        // rate-limit its own identity leases and enter a retry storm.
        rateKey = 'account-auth-room-assertion';
        rateLimit = 600;
      }
      if (!(await checkRateLimit(request, rateKey, rateLimit, rateWindowSeconds))) {
        return json({ error: 'AUTH_RATE_LIMITED' }, 429, {
          'Retry-After': String(rateWindowSeconds),
        });
      }
      const authResponse = await handleAccountAuthRequest(request, env, url, {
        purgeProRoomAccountAuthority: (input) => purgeProRoomAccountAuthority(input, env),
        orphanAccountProGrants: (accountId: string) => orphanAccountProGrants(env, accountId),
        ...(ctx
          ? {
              deferAccountSessionTouch: (task: Promise<unknown>) => ctx.waitUntil(task),
              deferAccountDeletion: (accountId: string) =>
                ctx.waitUntil(
                  cleanupPendingAccountDeletions(
                    env,
                    {
                      purgeProRoomAccountAuthority: (input) =>
                        purgeProRoomAccountAuthority(input, env),
                      orphanAccountProGrants: (accountId: string) =>
                        orphanAccountProGrants(env, accountId),
                    },
                    { accountId },
                  ),
                ),
            }
          : {}),
      });
      return withSecurityHeaders(authResponse || json({ error: 'NOT_FOUND' }, 404));
    }

    if (url.pathname.startsWith('/api/pro-grants/')) {
      const mutation = request.method === 'POST';
      if (
        !(await checkRateLimit(
          request,
          mutation ? 'pro-grant-redeem' : 'pro-grant-session',
          mutation ? 20 : 120,
          60,
        ))
      ) {
        return json({ error: 'PRO_GRANT_RATE_LIMITED' }, 429, { 'Retry-After': '60' });
      }
      const response = await handleProGrantPublicRequest(
        request,
        env,
        url,
        proGrantDependencies(env),
      );
      return withSecurityHeaders(response || json({ error: 'NOT_FOUND' }, 404));
    }

    if (url.pathname.startsWith('/api/admin/pro-grants/')) {
      const allowedMethods = ['GET', 'HEAD'].includes(request.method) ? ['GET', 'HEAD'] : ['POST'];
      const methodError = adminApiMethodAllowed(request, allowedMethods);
      if (methodError) return methodError;
      if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);
      const response = await handleProGrantAdminRequest(
        request,
        env,
        url,
        proGrantDependencies(env),
      );
      return withSecurityHeaders(response || json({ error: 'NOT_FOUND' }, 404));
    }

    if (url.pathname.startsWith(`${PRO_ROOM_FACADE_PREFIX}/`)) {
      return handleProRoomFacade(request, env, url);
    }

    if (
      (url.pathname === '/admin' || url.pathname === '/admin/') &&
      (request.method === 'GET' || request.method === 'HEAD')
    ) {
      return renderAdminPage(request, env);
    }

    if (ADMIN_PRO_ROOM_PATH_RE.test(url.pathname)) {
      return handleAdminProRooms(request, env, url.pathname);
    }

    if (ADMIN_PRO_ROOM_OWNER_RECOVERY_PATH_RE.test(url.pathname)) {
      return handleAdminProRoomOwnerRecoveryClaim(request, env, url.pathname);
    }

    if (ADMIN_PRO_ROOM_OWNER_TRANSFER_PATH_RE.test(url.pathname)) {
      return handleAdminProRoomOwnerTransferClaim(request, env, url.pathname);
    }

    if (ADMIN_PRO_ROOM_LEGACY_OWNER_DETACH_PATH_RE.test(url.pathname)) {
      return handleAdminProRoomLegacyOwnerDetach(request, env, url.pathname);
    }

    if (ADMIN_PRO_ROOM_STATE_PATH_RE.test(url.pathname)) {
      return handleAdminProRoomState(request, env, url.pathname);
    }

    if (ADMIN_PRO_ROOM_LABEL_PATH_RE.test(url.pathname)) {
      return handleAdminProRoomLabel(request, env, url.pathname);
    }

    if (ADMIN_PRO_ROOM_DELETE_PATH_RE.test(url.pathname)) {
      return handleAdminProRoomDelete(request, env, url.pathname);
    }

    if (ADMIN_DEVELOPER_API_KEY_PATH_RE.test(url.pathname)) {
      return handleAdminDeveloperApiKeys(request, env, url.pathname);
    }

    switch (url.pathname) {
      case '/api/security-config':
        return handleSecurityConfig(request, env);
      case '/api/capability-challenge':
        return handleCapabilityChallenge(request, env);
      case '/api/capability-token':
        return handleCapabilityToken(request, env);
      case '/api/youtube-search':
        return handleYoutubeSearch(request, env);
      case '/api/youtube-playlist-entry':
        return handleYoutubePlaylistEntry(request, env);
      case '/api/youtube-playlist-manifest':
        return handleYoutubePlaylistManifest(request, env);
      case '/api/get-turn-config':
        return handleTurnConfig(request, env);
      case '/api/cloudflare-realtime':
        return handleRealtime(request, env);
      case '/api/announcement/current':
        return handlePublicAnnouncement(request, env);
      case '/api/admin/login':
        return handleAdminLogin(request, env);
      case '/api/admin/logout':
        return handleAdminLogout(request, env);
      case '/api/admin/session':
        return handleAdminSession(request, env);
      case ADMIN_MAINTENANCE_PREVIEW_PATH:
        return handleAdminMaintenancePreview(request, env);
      case '/api/admin/service-status':
        return handleAdminServiceStatus(request, env);
      case '/api/admin/metrics':
        return handleAdminMetrics(request, env);
      case '/api/admin/articles':
        return handleAdminArticles(request, env);
      case '/api/admin/articles/visibility':
        return handleAdminArticleVisibility(request, env);
      case '/api/admin/announcement':
        return handleAdminAnnouncement(request, env);
      default:
        return serveStatic(request, env, ctx);
    }
  },
};
