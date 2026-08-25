/**
 * MUSIXQUARE whole-object file-share Worker.
 *
 * Required bindings:
 * - REMOTE_SHARE_BUCKET: R2 bucket
 * - REMOTE_SHARE_QUOTA: per-room Durable Object namespace for durable session replay
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
 * - UPLOAD_TOKEN_TTL_SECONDS: presigned PUT start window, default/maximum 600
 * - RATE_LIMIT_WINDOW_SECONDS: default 3600
 * - IP_UPLOADS_PER_WINDOW: default 60
 * - ROOM_UPLOADS_PER_WINDOW: default 120
 * - ROOM_UPLOAD_ASSERTION_MODE: disabled (local/default), optional, or required
 * - MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET: signaling-shared HMAC secret,
 *     required when ROOM_UPLOAD_ASSERTION_MODE is optional or required. A
 *     plain value preserves single-key behavior; the documented prefixed JSON
 *     form enables current/previous rotation slots.
 * - ROOM_STORAGE_QUOTA_BYTES: default 0. Production uses 1 GiB and requires
 *     the durable session-replay path.
 * - ALLOWED_ORIGINS: comma-separated origins
 * - MXQR_CAPABILITY_SECRET: required for /session in production. When unset
 *     /session returns 503 CAPABILITY_NOT_CONFIGURED unless the dangerous
 *     MXQR_ALLOW_UNGUARDED_REMOTE_SHARE override is set.
 * - REMOTE_SHARE_CAPABILITY_SECRET: optional override for /session capability HMAC
 *
 * Dangerous bypass flags (asserted by scripts/assert-production-security-config.mts):
 * - MXQR_ALLOW_UNGUARDED_REMOTE_SHARE: permit /session without capability when
 *     no secret is configured. Local/emergency only.
 * - MXQR_ALLOW_STATELESS_REMOTE_SHARE_SESSION: permit /session without the
 *     quota/replay Durable Object. Local tests only; never set in production.
 */

import {
  consumeAbuseRateLimit,
  gateServiceMaintenance,
  readServiceMaintenance,
} from './service-maintenance.ts';
import {
  parseRemoteShareUploadAssertionKeyring,
  REMOTE_SHARE_UPLOAD_ASSERTION_KEYRING_VERSION,
  REMOTE_SHARE_UPLOAD_ASSERTION_VERSION,
  verifyRemoteShareUploadAssertion,
} from './remote-share-upload-assertion.ts';

type JsonRecord = Record<string, unknown>;
type HeaderRecord = Record<string, string>;
type BodyReader = ReadableStreamDefaultReader<Uint8Array>;
type CancellableBody = { cancel(reason?: unknown): Promise<void> };

interface WaitUntilContextPort {
  waitUntil?(promise: Promise<unknown>): void;
}

interface D1PreparedStatementPort {
  bind(...values: unknown[]): D1PreparedStatementPort;
  run(): Promise<unknown>;
}

interface D1DatabasePort {
  prepare(query: string): D1PreparedStatementPort;
}

interface R2BucketPort {
  delete(keys: string | string[]): Promise<void>;
  get(key: string): Promise<unknown>;
  head(key: string): Promise<unknown>;
  list(options: JsonRecord): Promise<unknown>;
  put(key: string, value: Uint8Array, options?: JsonRecord): Promise<unknown>;
}

interface FetcherPort {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespacePort {
  idFromName(name: string): unknown;
  get(id: unknown): unknown;
}

interface DurableObjectStoragePort {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
  deleteAll?(): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm?(): Promise<void>;
}

interface DurableObjectStatePort {
  readonly storage: DurableObjectStoragePort;
}

interface RemoteShareEnvPort {
  readonly ADMIN_METRICS_DB?: unknown;
  readonly ALLOWED_ORIGINS?: unknown;
  readonly ALLOW_UNGUARDED_REMOTE_SHARE?: unknown;
  readonly CAPABILITY_HMAC_SECRET?: unknown;
  readonly CAPABILITY_SECRET?: unknown;
  readonly CF_VERSION_METADATA?: unknown;
  readonly IP_UPLOADS_PER_WINDOW?: unknown;
  readonly MUSIXQUARE_ADMIN_DB?: unknown;
  readonly MUSIXQUARE_SERVICE_CONTROL?: unknown;
  readonly MXQR_ALLOW_STATELESS_REMOTE_SHARE_SESSION?: unknown;
  readonly MXQR_ALLOW_UNGUARDED_REMOTE_SHARE?: unknown;
  readonly MXQR_CAPABILITY_SECRET?: unknown;
  readonly MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET?: unknown;
  readonly OBJECT_TTL_SECONDS?: unknown;
  readonly R2_ACCESS_KEY_ID?: unknown;
  readonly R2_ACCOUNT_ID?: unknown;
  readonly R2_BUCKET_NAME?: unknown;
  readonly R2_SECRET_ACCESS_KEY?: unknown;
  readonly RATE_LIMIT_WINDOW_SECONDS?: unknown;
  readonly REMOTE_SHARE_BUCKET?: R2BucketPort;
  readonly REMOTE_SHARE_CAPABILITY_SECRET?: unknown;
  readonly REMOTE_SHARE_QUOTA?: unknown;
  readonly REMOTE_SHARE_SIGNING_SECRET?: unknown;
  readonly ROOM_STORAGE_QUOTA_BYTES?: unknown;
  readonly ROOM_UPLOAD_ASSERTION_MODE?: unknown;
  readonly ROOM_UPLOADS_PER_WINDOW?: unknown;
  readonly UPLOAD_TOKEN_TTL_SECONDS?: unknown;
}

interface PortableRemoteShareHandler {
  fetch(
    request: Request,
    env: RemoteShareEnvPort,
    context?: WaitUntilContextPort,
  ): Promise<Response>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isD1Database(value: unknown): value is D1DatabasePort {
  return isRecord(value) && typeof value.prepare === 'function';
}

function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespacePort {
  return (
    isRecord(value) && typeof value.idFromName === 'function' && typeof value.get === 'function'
  );
}

function isFetcher(value: unknown): value is FetcherPort {
  return isRecord(value) && typeof value.fetch === 'function';
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isR2Object(value: unknown): value is JsonRecord & { size: number } {
  return isRecord(value) && isSafeInteger(value.size) && value.size >= 0;
}

function r2ObjectBody(value: unknown): BodyInit | null {
  if (!isRecord(value)) return null;
  const body = value.body;
  return body instanceof ReadableStream || body instanceof Uint8Array ? body : null;
}

// Cross-layer contract: client selection, protocol descriptors, and
// stored-object validation all use this fixed 200 MiB whole-object ceiling.
const REMOTE_SHARE_MAX_BYTES = 200 * 1024 * 1024;
const DEFAULT_TTL_SECONDS = 60 * 60;
const DEFAULT_UPLOAD_TOKEN_TTL_SECONDS = 10 * 60;
const MAX_UPLOAD_TOKEN_TTL_SECONDS = 10 * 60;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const DEFAULT_IP_UPLOADS_PER_WINDOW = 60;
const DEFAULT_ROOM_UPLOADS_PER_WINDOW = 120;
const DEFAULT_ROOM_STORAGE_QUOTA_BYTES = 0;
const ROOM_STORAGE_LIST_PAGE_SIZE = 1000;
const ROOM_STORAGE_SCAN_MAX_OBJECTS = 2000;
const DEFAULT_R2_BUCKET_NAME = 'musixquare-remote-share';
const CAPABILITY_SCOPE = 'remote-share';
const CAPABILITY_TOKEN_TTL_DEFAULT = 600;
const SESSION_JSON_BODY_MAX_BYTES = 8 * 1024;
const COMPLETE_JSON_BODY_MAX_BYTES = 8 * 1024;
const QUOTA_JSON_BODY_MAX_BYTES = 16 * 1024;
const JSON_BODY_TIMEOUT_MS = 10_000;
const QUOTA_RESPONSE_TIMEOUT_MS = 5_000;
const HMAC_SECRET_MIN_LENGTH = 32;
const QUOTA_STATE_KEY = 'quota-state';
const QUOTA_STATE_VERSION = 2;
const SESSION_PROOF_STATE_KEY = 'session-proof-state';
const SESSION_PROOF_STATE_VERSION = 1;
const SESSION_PROOF_OBJECT_PREFIX = 'session-proof-v3:';
const QUOTA_STATE_MAX_ENTRIES = ROOM_STORAGE_SCAN_MAX_OBJECTS;
const QUOTA_STATE_MAX_SERIALIZED_BYTES = 1_500_000;
const QUOTA_ALARM_RETRY_MS = 60 * 1000;
const EXPIRY_TOMBSTONE_SWEEP_MS = 60 * 1000;
const EXPIRY_TOMBSTONE_QUIET_MS = 60 * 60 * 1000;
const WHOLE_OBJECT_VERSION = 1;
const WORKER_CONTRACT_VERSION = 3;
const DOWNLOAD_AUTHORIZATION_VERSION = 1;
const ROOM_UPLOAD_ASSERTION_HEADER = 'x-mxqr-room-upload-assertion';
const ROOM_UPLOAD_ASSERTION_METRICS: ReadonlySet<unknown> = new Set([
  'remote_share_upload_assertion_verified',
  'remote_share_upload_assertion_legacy',
  'remote_share_upload_assertion_rejected',
]);
const ROOM_UPLOAD_ASSERTION_REJECT_METRICS_PER_WINDOW = 10;
const METRICS_TABLE = 'mxqr_metric_buckets';
// Storage/token format name. The peer descriptor deliberately calls the same
// downloaded bytes `whole-v1`; the distinct names identify the storage and wire layers.
const WHOLE_OBJECT_STORAGE_FORMAT = 'whole-object-v1';
const UPLOAD_PLACEHOLDER_FORMAT = 'whole-object-upload-placeholder-v1';
const UPLOAD_HTTP_ETAG_RE = /^"[\x21\x23-\x7e]{1,128}"$/;
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
// `rs_` is the cached v2 client shape. v3 uses an actor-secret-derived nonce
// with a distinguishable prefix so a mixed-version rollout can be audited.
// Neither v3 value is stored directly: the Worker folds the pair together
// under its signing secret before any durable replay lookup. The capability
// still gates access, but rotating that short-lived token must not break an
// outcome-unknown retry by the same private v3 browser actor.
const V2_CLIENT_SESSION_REQUEST_ID_RE = /^rs_[A-Za-z0-9_-]{43}$/;
const V3_CLIENT_SESSION_REQUEST_ID_RE = /^rs3_[A-Za-z0-9_-]{43}$/;
const V3_CLIENT_SESSION_ACTOR_ID_RE = /^rsa_[A-Za-z0-9_-]{43}$/;
const SESSION_RECEIPT_KEY_RE = /^rs_[A-Za-z0-9_-]{43}$/;
const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://musixquare.com',
  'https://www.musixquare.com',
  // Keep Toss access app-scoped; wildcard/root ranges include unrelated mini apps.
  'https://musixquare.apps.tossmini.com',
  'https://musixquare.private-apps.tossmini.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]);
const inFlightUploadSessionRateLimits = new Map<string, Promise<Response | null>>();
const SECURITY_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function configuredAllowedOrigins(env: RemoteShareEnvPort): ReadonlySet<string> {
  const configured = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return configured.length > 0 ? new Set(configured) : DEFAULT_ALLOWED_ORIGINS;
}

function allowedRequestOrigin(request: Request, env: RemoteShareEnvPort): string | null {
  const origin = request.headers.get('origin') || '';
  if (!origin) return null;
  const allowed = configuredAllowedOrigins(env);
  return allowed.has(origin) ? origin : null;
}

function corsHeaders(request: Request, env: RemoteShareEnvPort): HeaderRecord {
  const allowOrigin = allowedRequestOrigin(request, env) || 'https://musixquare.com';
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'POST,GET,DELETE,OPTIONS',
    'access-control-allow-headers':
      'content-type,authorization,x-mxqr-capability,x-mxqr-cleanup-token,x-mxqr-room-upload-assertion',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function originError(request: Request, env: RemoteShareEnvPort): Response | null {
  if (allowedRequestOrigin(request, env)) return null;
  return json(request, env, { error: 'forbidden origin' }, 403);
}

function requiresAllowedOrigin(path: string): boolean {
  return (
    path === '/session' ||
    path === '/security-config' ||
    path === '/complete' ||
    /^\/download\/[^/]+\/[^/]+$/.test(path) ||
    /^\/object\/[^/]+\/[^/]+$/.test(path)
  );
}

function json(
  request: Request,
  env: RemoteShareEnvPort,
  body: unknown,
  status = 200,
  extraHeaders: Readonly<HeaderRecord> = {},
): Response {
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

function withRemoteShareHeaders(
  request: Request,
  env: RemoteShareEnvPort,
  response: Response,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries({
    ...SECURITY_HEADERS,
    ...corsHeaders(request, env),
  })) {
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

function cancelBodyReader(reader: CancellableBody | null, reason: unknown): void {
  try {
    Promise.resolve(reader?.cancel(reason)).catch(() => {});
  } catch {
    // Cancellation is best-effort and must not delay the bounded response.
  }
}

type JsonBodyReadResult =
  | { value: unknown; bodyBytes: Uint8Array; error?: never }
  | { error: 'invalid' | 'too-large' | 'timeout' | 'aborted'; value?: never; bodyBytes?: never };

async function readJsonBodyLimited(
  request: Request,
  maxBytes: number,
): Promise<JsonBodyReadResult> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const normalized = contentLength.trim();
    if (!/^\d+$/.test(normalized)) return { error: 'invalid' };
    if (Number(normalized) > maxBytes) return { error: 'too-large' };
  }

  if (!request.body) return { error: 'invalid' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let stop: ((outcome: { kind: 'timeout' | 'aborted' }) => void) | undefined;
  const stopped = new Promise<{ kind: 'timeout' | 'aborted' }>((resolve) => {
    stop = resolve;
  });
  const timeout = setTimeout(() => {
    stop?.({ kind: 'timeout' });
    cancelBodyReader(reader, 'JSON_BODY_TIMEOUT');
  }, JSON_BODY_TIMEOUT_MS);
  const abort = () => {
    stop?.({ kind: 'aborted' });
    cancelBodyReader(reader, request.signal.reason);
  };
  if (request.signal.aborted) abort();
  else request.signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const outcome = await Promise.race([
        reader.read().then(
          (value) => ({ kind: 'read' as const, value }),
          () => ({ kind: 'invalid' as const }),
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
    return {
      value: JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bodyBytes),
      ),
      bodyBytes,
    };
  } catch {
    return { error: 'invalid' };
  }
}

function jsonBodyError(
  request: Request,
  env: RemoteShareEnvPort,
  result: Extract<JsonBodyReadResult, { error: string }>,
): Response {
  if (result.error === 'too-large') {
    return json(request, env, { error: 'request body too large' }, 413);
  }
  if (result.error === 'timeout') {
    return json(request, env, { error: 'request body timed out' }, 408);
  }
  return json(request, env, { error: 'invalid json' }, 400);
}

async function readJsonResponseLimited(
  response: Response,
  maxBytes: number,
  registerReader: (reader: BodyReader | null) => void = () => {},
): Promise<unknown | null> {
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
  const chunks: Uint8Array[] = [];
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
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return null;
  }
}

function parseLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalLimit(value: unknown, fallback: number): number {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getSigningSecret(env: RemoteShareEnvPort): string | null {
  const secret = String(env.REMOTE_SHARE_SIGNING_SECRET || '').trim();
  return secret.length >= 32 ? secret : null;
}

type RoomUploadAssertionMode = 'disabled' | 'optional' | 'required';

function roomUploadAssertionMode(env: RemoteShareEnvPort): RoomUploadAssertionMode | null {
  const configured = String(env.ROOM_UPLOAD_ASSERTION_MODE || 'disabled')
    .trim()
    .toLowerCase();
  return configured === 'disabled' || configured === 'optional' || configured === 'required'
    ? configured
    : null;
}

function configuredRoomUploadAssertionSecret(env: RemoteShareEnvPort): string {
  return String(env.MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET || '');
}

function getRoomUploadAssertionSecret(env: RemoteShareEnvPort): string {
  const secret = configuredRoomUploadAssertionSecret(env);
  return secret.length >= HMAC_SECRET_MIN_LENGTH && parseRemoteShareUploadAssertionKeyring(secret)
    ? secret
    : '';
}

function roomUploadAssertionConfigurationError(
  request: Request,
  env: RemoteShareEnvPort,
): Response | null {
  const mode = roomUploadAssertionMode(env);
  if (!mode) {
    return json(request, env, { error: 'ROOM_UPLOAD_ASSERTION_MODE_INVALID' }, 503);
  }
  if (mode === 'disabled') return null;
  const secret = configuredRoomUploadAssertionSecret(env);
  if (!secret) {
    return json(request, env, { error: 'ROOM_UPLOAD_ASSERTION_NOT_CONFIGURED' }, 503);
  }
  if (secret.length < HMAC_SECRET_MIN_LENGTH || !parseRemoteShareUploadAssertionKeyring(secret)) {
    return json(request, env, { error: 'ROOM_UPLOAD_ASSERTION_SECRET_INVALID' }, 503);
  }
  return null;
}

type RoomUploadAssertionMetric =
  | 'remote_share_upload_assertion_verified'
  | 'remote_share_upload_assertion_legacy'
  | 'remote_share_upload_assertion_rejected';

async function recordRoomUploadAssertionMetric(
  env: RemoteShareEnvPort,
  event: RoomUploadAssertionMetric,
  now = Date.now(),
): Promise<void> {
  const candidate = env.MUSIXQUARE_ADMIN_DB ?? env.ADMIN_METRICS_DB;
  if (!ROOM_UPLOAD_ASSERTION_METRICS.has(event) || !isD1Database(candidate)) return;
  const db = candidate;
  const bucketMinute = Math.floor(now / 60_000);
  try {
    await db
      .prepare(
        `INSERT INTO ${METRICS_TABLE} (bucket_minute, event, count)
         VALUES (?1, ?2, 1)
         ON CONFLICT(bucket_minute, event)
         DO UPDATE SET count = count + 1`,
      )
      .bind(bucketMinute, event)
      .run();
  } catch (error) {
    console.warn('[Metrics] Failed to record remote share assertion metric', event, error);
  }
}

function deferRoomUploadAssertionMetric(
  context: WaitUntilContextPort,
  env: RemoteShareEnvPort,
  event: RoomUploadAssertionMetric,
  now = Date.now(),
): void {
  const task = recordRoomUploadAssertionMetric(env, event, now);
  try {
    if (typeof context?.waitUntil === 'function') {
      context.waitUntil(task);
      return;
    }
  } catch {
    // The metric write catches its own failures. A local runtime without a
    // usable ExecutionContext still receives best-effort delivery below.
  }
  task.catch(() => undefined);
}

async function deferRejectedRoomUploadAssertionMetric(
  request: Request,
  env: RemoteShareEnvPort,
  context: WaitUntilContextPort,
  rateSecret: string,
): Promise<void> {
  try {
    const rateWindowSeconds = parseLimit(
      env.RATE_LIMIT_WINDOW_SECONDS,
      DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
    );
    const ipKey = await rateLimitIpKey(rateSecret, request);
    const metricRate = await consumeLimit(
      env,
      `${ipKey}:assertion-rejected-metric`,
      ROOM_UPLOAD_ASSERTION_REJECT_METRICS_PER_WINDOW,
      rateWindowSeconds,
      undefined,
    );
    if (metricRate === 'allowed') {
      deferRoomUploadAssertionMetric(context, env, 'remote_share_upload_assertion_rejected');
    }
  } catch {
    // Telemetry is never an authorization dependency. A missing or unhealthy
    // metric limiter suppresses the D1 write while the request still fails.
  }
}

function configuredCapabilitySecret(env: RemoteShareEnvPort): string {
  return String(
    env.REMOTE_SHARE_CAPABILITY_SECRET ||
      env.MXQR_CAPABILITY_SECRET ||
      env.CAPABILITY_HMAC_SECRET ||
      env.CAPABILITY_SECRET ||
      '',
  ).trim();
}

function getCapabilitySecret(env: RemoteShareEnvPort): string {
  const secret = configuredCapabilitySecret(env);
  return secret.length >= HMAC_SECRET_MIN_LENGTH ? secret : '';
}

function hasInvalidCapabilitySecret(env: RemoteShareEnvPort): boolean {
  const secret = configuredCapabilitySecret(env);
  return secret.length > 0 && secret.length < HMAC_SECRET_MIN_LENGTH;
}

function isCapabilityRequired(env: RemoteShareEnvPort): boolean {
  return !!getCapabilitySecret(env);
}

function allowUnguardedRemoteShare(env: RemoteShareEnvPort): boolean {
  const raw = String(
    env.MXQR_ALLOW_UNGUARDED_REMOTE_SHARE ?? env.ALLOW_UNGUARDED_REMOTE_SHARE ?? 'false',
  )
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function allowStatelessRemoteShareSession(env: RemoteShareEnvPort): boolean {
  const raw = String(env.MXQR_ALLOW_STATELESS_REMOTE_SHARE_SESSION ?? 'false')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function getR2S3Config(env: RemoteShareEnvPort): {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
} | null {
  const accountId = String(env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  const bucketName = String(env.R2_BUCKET_NAME || DEFAULT_R2_BUCKET_NAME).trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) return null;
  return { accountId, accessKeyId, secretAccessKey, bucketName };
}

function base64UrlEncode(value: Uint8Array | ArrayBuffer): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
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

function base64UrlToString(value: string): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(base64UrlDecode(value));
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function hmacBytes(keyBytes: Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
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

async function hmacSha256(secret: string, value: string | Uint8Array): Promise<string> {
  return base64UrlEncode(await hmacBytes(new TextEncoder().encode(secret), value));
}

function constantTimeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function getClientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown'
  );
}

async function capabilityIpHash(secret: string, request: Request): Promise<string> {
  return hmacSha256(secret, `ip:${getClientIp(request)}`);
}

async function rateLimitIpKey(secret: string, request: Request): Promise<string> {
  const digest = await hmacSha256(secret, `rate-limit-ip:${getClientIp(request)}`);
  return `session-ip:${digest}`;
}

async function uploadSessionRequestKey(
  secret: string,
  authorityScope: string,
  clientRequestId: string | null,
): Promise<string | null> {
  if (!clientRequestId) return null;
  return `rs_${await hmacSha256(
    secret,
    `upload-session-request:v3\u0000${authorityScope}\u0000${clientRequestId}`,
  )}`;
}

interface UploadSessionMetadata {
  roomId: string;
  sessionId: number;
  queueItemId: string;
  name: string;
  mime: string;
  storedSize: number;
}

interface SessionReservationExpectation extends UploadSessionMetadata {
  operationId: string;
  clientRequestId: string | null;
}

interface QuotaReservation extends SessionReservationExpectation, JsonRecord {
  objectId: string;
  objectKey: string;
  expiresAt: number;
  uploadAuthorityExpiresAt: number;
  cleanupToken: string;
  uploadEtag?: string;
  receiptInvalid?: boolean;
}

interface ReservationIdentity extends JsonRecord {
  cleanupToken: string;
  expiresAt: number;
  objectId: string;
  objectKey: string;
  storedSize: number;
}

interface ParsedQuotaReservation extends ReservationIdentity {
  roomId: string;
  operationId?: string;
  clientRequestId?: string | null;
  sessionId?: number;
  queueItemId?: string;
  name?: string;
  mime?: string;
  uploadEtag?: string;
  uploadAuthorityExpiresAt?: number;
}

interface SessionReceiptFields extends JsonRecord {
  operationId: string;
  clientRequestId: string | null;
  sessionId: number;
  queueItemId: string;
  name: string;
  mime: string;
  uploadEtag: string;
  uploadAuthorityExpiresAt: number;
  expiresAt: number;
}

interface StoredQuotaReservationInput extends ReservationIdentity {
  status: 'reserved' | 'completed';
  operationId?: unknown;
  clientRequestId?: unknown;
  sessionId?: unknown;
  queueItemId?: unknown;
  name?: unknown;
  mime?: unknown;
  uploadEtag?: unknown;
  uploadAuthorityExpiresAt?: unknown;
  receiptInvalid?: unknown;
  tombstoneQuietSince?: number;
  tombstoneNextSweepAt?: number;
}

interface StoredQuotaReservation extends ReservationIdentity {
  status: 'reserved' | 'completed';
  operationId?: string;
  clientRequestId?: string | null;
  sessionId?: number;
  queueItemId?: string;
  name?: string;
  mime?: string;
  uploadEtag?: string;
  uploadAuthorityExpiresAt?: number;
  receiptInvalid?: true;
  tombstoneQuietSince?: number;
  tombstoneNextSweepAt?: number;
}

interface QuotaState extends JsonRecord {
  v: number;
  roomId: string;
  reservations: Record<string, StoredQuotaReservation>;
}

interface SessionProofState extends JsonRecord {
  v: number;
  clientRequestId: string;
  operationId: string;
  expiresAt: number;
}

async function uploadSessionOperationId(
  secret: string,
  authorityScope: string,
  clientRequestId: string | null,
  metadata: UploadSessionMetadata,
): Promise<string> {
  const canonical = JSON.stringify([
    authorityScope,
    // A six-field cached client has no replay nonce. Give every request a
    // fresh operation identity so public metadata can never recover another
    // caller's upload, completion, or cleanup authority.
    clientRequestId || `legacy:${crypto.randomUUID()}`,
    metadata.roomId,
    metadata.sessionId,
    metadata.queueItemId,
    metadata.name,
    metadata.mime,
    metadata.storedSize,
  ]);
  return `rs_${await hmacSha256(secret, `upload-session:v3\u0000${canonical}`)}`;
}

function readCapabilityToken(request: Request): string {
  const headerToken =
    request.headers.get('x-mxqr-capability') || request.headers.get('X-MXQR-Capability') || '';
  if (headerToken) return headerToken.trim();
  const authorization = request.headers.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1];
  return typeof token === 'string' ? token.trim() : '';
}

async function verifyCapabilityToken(
  token: string,
  request: Request,
  env: RemoteShareEnvPort,
): Promise<string> {
  const secret = getCapabilitySecret(env);
  if (!secret || !token) return '';
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return '';

  const expectedSignature = await hmacSha256(secret, parts[0]);
  if (!constantTimeEqual(expectedSignature, parts[1])) return '';

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlToString(parts[0]));
  } catch {
    return '';
  }

  const now = Math.floor(Date.now() / 1000);
  if (!isRecord(payload) || payload.v !== 1) return '';
  if (!Array.isArray(payload.scopes) || !payload.scopes.includes(CAPABILITY_SCOPE)) return '';
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) return '';
  if (typeof payload.exp !== 'number' || payload.exp <= now) return '';

  const expectedIp = await capabilityIpHash(secret, request);
  if (!constantTimeEqual(String(payload.ip || ''), expectedIp)) return '';
  // The capability is already a bearer authority. Persist only a keyed,
  // domain-separated pseudonym so a different token (including one minted for
  // the same NAT/IP) can never retrieve this token's upload authorities.
  return hmacSha256(secret, `remote-share-session-actor:v1\u0000${token}`);
}

interface CapabilityAuthorization {
  response: Response | null;
  authorityScope: string;
}

async function authorizeSessionCapability(
  request: Request,
  env: RemoteShareEnvPort,
  signingSecret: string,
): Promise<CapabilityAuthorization> {
  if (hasInvalidCapabilitySecret(env)) {
    return {
      response: json(request, env, { error: 'CAPABILITY_SECRET_INVALID' }, 503),
      authorityScope: '',
    };
  }
  if (!isCapabilityRequired(env)) {
    // Parity with app-worker.guardSensitiveRequest: a missing capability
    // secret is a production-config error, not a license to bypass. Run-mode
    // override is the only escape so operators don't silently ship an
    // unguarded /session endpoint.
    if (allowUnguardedRemoteShare(env)) {
      return {
        response: null,
        authorityScope: await hmacSha256(
          signingSecret,
          `remote-share-unguarded-session-actor:v1\u0000${getClientIp(request)}`,
        ),
      };
    }
    return {
      response: json(request, env, { error: 'CAPABILITY_NOT_CONFIGURED' }, 503),
      authorityScope: '',
    };
  }
  const authorityScope = await verifyCapabilityToken(readCapabilityToken(request), request, env);
  return authorityScope
    ? { response: null, authorityScope }
    : {
        response: json(request, env, { error: 'CAPABILITY_REQUIRED' }, 401),
        authorityScope: '',
      };
}

function workerVersionFields(env: RemoteShareEnvPort): { workerVersionId?: string } {
  const metadata = env.CF_VERSION_METADATA;
  const workerVersionId = isRecord(metadata) ? metadata.id : undefined;
  return typeof workerVersionId === 'string' && workerVersionId ? { workerVersionId } : {};
}

function handleSecurityConfig(request: Request, env: RemoteShareEnvPort): Response {
  if (hasInvalidCapabilitySecret(env)) {
    return json(request, env, { error: 'CAPABILITY_SECRET_INVALID' }, 503);
  }
  const assertionConfigurationError = roomUploadAssertionConfigurationError(request, env);
  if (assertionConfigurationError) return assertionConfigurationError;
  const assertionMode = roomUploadAssertionMode(env);
  return json(request, env, {
    capabilityRequired: isCapabilityRequired(env),
    scope: CAPABILITY_SCOPE,
    ttl: CAPABILITY_TOKEN_TTL_DEFAULT,
    workerContractVersion: WORKER_CONTRACT_VERSION,
    sessionReplayRequired: !allowStatelessRemoteShareSession(env),
    sessionReplayEnabled: roomStorageSessionReplayEnabled(env),
    wholeObjectVersion: WHOLE_OBJECT_VERSION,
    downloadAuthorizationVersion: DOWNLOAD_AUTHORIZATION_VERSION,
    roomUploadAssertionVersion: REMOTE_SHARE_UPLOAD_ASSERTION_VERSION,
    roomUploadAssertionKeyringVersion: REMOTE_SHARE_UPLOAD_ASSERTION_KEYRING_VERSION,
    roomUploadAssertionMode: assertionMode,
    roomUploadAssertionRequired: assertionMode === 'required',
    ...workerVersionFields(env),
  });
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return hex(new Uint8Array(hash));
}

async function sha256Base64Url(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeObjectPath(path: string): string {
  return path.split('/').map(awsEncode).join('/');
}

function amzDateParts(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function canonicalQuery(params: readonly (readonly [string, string])[]): string {
  return [...params]
    .sort(([keyA, valueA], [keyB, valueB]) =>
      keyA === keyB ? valueA.localeCompare(valueB) : keyA.localeCompare(keyB),
    )
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
    .join('&');
}

function canonicalHeaderValue(value: unknown): string {
  return String(value).trim().replace(/\s+/g, ' ');
}

interface PresignedPutInput {
  env: RemoteShareEnvPort;
  objectKey: string;
  headers: Readonly<HeaderRecord>;
  expiresInSeconds: number;
  now: Date;
}

async function createR2PresignedPutUrl({
  env,
  objectKey: key,
  headers,
  expiresInSeconds,
  now,
}: PresignedPutInput): Promise<string | null> {
  const config = getR2S3Config(env);
  if (!config) return null;

  const { accountId, accessKeyId, secretAccessKey, bucketName } = config;
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const { amzDate, dateStamp } = amzDateParts(now);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const canonicalUri = `/${awsEncode(bucketName)}/${encodeObjectPath(key)}`;
  const signedHeaderEntries: HeaderRecord = {
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
  const queryParams: [string, string][] = [
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

async function createSignedToken(payload: JsonRecord, secret: string): Promise<string> {
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await importSigningKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encodedPayload));
  return `${encodedPayload}.${base64UrlEncode(signature)}`;
}

async function verifySignedToken(token: unknown, secret: string): Promise<unknown | null> {
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

    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
        base64UrlDecode(encodedPayload),
      ),
    );
  } catch {
    return null;
  }
}

async function downloadSigningSecret(signingSecret: string): Promise<string> {
  // Keep download bearers cryptographically separate from upload-completion
  // authorities even though production provisions one root signing secret.
  return hmacSha256(signingSecret, DOWNLOAD_SIGNING_PURPOSE);
}

async function createDownloadToken(payload: JsonRecord, signingSecret: string): Promise<string> {
  return createSignedToken(payload, await downloadSigningSecret(signingSecret));
}

async function verifyDownloadToken(token: unknown, signingSecret: string): Promise<unknown | null> {
  if (typeof token !== 'string' || token.length === 0 || token.length > DOWNLOAD_TOKEN_MAX_LENGTH) {
    return null;
  }
  return verifySignedToken(token, await downloadSigningSecret(signingSecret));
}

async function cleanupSigningSecret(signingSecret: string): Promise<string> {
  // Cleanup authority has a distinct cryptographic purpose so neither an
  // upload-completion token nor a download bearer can be replayed as DELETE
  // authority.
  return hmacSha256(signingSecret, CLEANUP_SIGNING_PURPOSE);
}

async function createCleanupToken(payload: JsonRecord, signingSecret: string): Promise<string> {
  return createSignedToken(payload, await cleanupSigningSecret(signingSecret));
}

async function verifyCleanupToken(token: unknown, signingSecret: string): Promise<unknown | null> {
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

function cleanupPayloadMatches(
  payload: unknown,
  {
    roomId,
    objectId,
    key,
    expiresAt,
    now = Date.now(),
  }: { roomId: string; objectId: string; key: string; expiresAt: unknown; now?: number },
): payload is JsonRecord & { exp: number; iat: number } {
  return (
    hasExactOwnKeys(payload, CLEANUP_TOKEN_KEYS) &&
    payload.v === WHOLE_OBJECT_VERSION &&
    payload.kind === CLEANUP_TOKEN_KIND &&
    payload.aud === CLEANUP_TOKEN_AUDIENCE &&
    payload.method === CLEANUP_TOKEN_METHOD &&
    payload.roomId === roomId &&
    payload.objectId === objectId &&
    payload.key === key &&
    UUID_V4_RE.test(String(payload.nonce || '')) &&
    isSafeInteger(payload.iat) &&
    payload.iat > 0 &&
    payload.iat <= now + 60_000 &&
    isSafeInteger(payload.exp) &&
    payload.exp === expiresAt &&
    payload.exp >= payload.iat &&
    payload.exp > now
  );
}

function readDownloadBearer(request: Request): string {
  const authorization = request.headers.get('authorization') || '';
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
  const token = match?.[1];
  return typeof token === 'string' && token.length <= DOWNLOAD_TOKEN_MAX_LENGTH ? token : '';
}

function standardRoomId(value: unknown): string | null {
  return typeof value === 'string' && STANDARD_ROOM_CODE_RE.test(value) ? value : null;
}

function hasExactOwnKeys(value: unknown, expectedKeys: readonly string[]): value is JsonRecord {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && keys.every((key) => expectedKeys.includes(key));
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function metadataString(value: unknown, fallback = ''): string {
  const raw = String(value || fallback)
    .replace(/[\r\n]/g, ' ')
    .trim();
  return encodeURIComponent(raw).slice(0, 512) || fallback;
}

const QUEUE_ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeQueueItemId(value: unknown): string {
  const queueItemId = String(value || '');
  return QUEUE_ITEM_ID_RE.test(queueItemId) ? queueItemId : '';
}

function readMetadata(object: unknown, ...keys: string[]): unknown {
  if (!isRecord(object)) return undefined;
  const metadata = isRecord(object.customMetadata) ? object.customMetadata : {};
  for (const key of keys) {
    if (metadata[key] !== undefined) return metadata[key];
  }
  return undefined;
}

type LimitConsumption = 'allowed' | 'limited' | 'unavailable';

async function consumeLimit(
  env: RemoteShareEnvPort,
  key: string,
  limit: number,
  ttlSeconds: number,
  operationId: string | undefined,
): Promise<LimitConsumption> {
  if (env.MUSIXQUARE_SERVICE_CONTROL) {
    const result = await consumeAbuseRateLimit(env, {
      scope: 'remote-share-upload',
      identity: key,
      limit,
      windowMs: ttlSeconds * 1_000,
      ...(operationId === undefined ? {} : { operationId }),
    });
    if (result.status !== 'ok') return 'unavailable';
    return result.allowed ? 'allowed' : 'limited';
  }

  // Direct unit tests invoke the Worker without Cloudflare globals. Production
  // fails closed if the shared atomic limiter binding is removed.
  return typeof caches === 'undefined' ? 'allowed' : 'unavailable';
}

function roomStorageQuotaBytes(env: RemoteShareEnvPort): number {
  return parseOptionalLimit(env.ROOM_STORAGE_QUOTA_BYTES, DEFAULT_ROOM_STORAGE_QUOTA_BYTES);
}

function roomStorageQuotaEnabled(env: RemoteShareEnvPort): boolean {
  return roomStorageQuotaBytes(env) > 0;
}

function hasRoomStorageQuotaBinding(env: RemoteShareEnvPort): boolean {
  return isDurableObjectNamespace(env.REMOTE_SHARE_QUOTA);
}

function roomStorageSessionReplayEnabled(env: RemoteShareEnvPort): boolean {
  return roomStorageQuotaEnabled(env) && hasRoomStorageQuotaBinding(env);
}

async function deleteBucketKeysInChunks(bucket: R2BucketPort, keys: string[]): Promise<void> {
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

interface RoomStorageInspection {
  activeKeys: Set<string>;
  observedKeys: Set<string>;
  totalBytes: number;
}

function parseR2ListPage(value: unknown): {
  objects: Array<JsonRecord & { key: string }>;
  truncated: boolean;
  cursor?: string;
} | null {
  if (!isRecord(value) || !Array.isArray(value.objects)) return null;
  const objects = value.objects.filter(
    (object): object is JsonRecord & { key: string } =>
      isRecord(object) && typeof object.key === 'string',
  );
  if (objects.length !== value.objects.length || typeof value.truncated !== 'boolean') return null;
  if (value.cursor !== undefined && typeof value.cursor !== 'string') return null;
  return {
    objects,
    truncated: value.truncated,
    ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
  };
}

async function inspectRoomStorage(
  bucket: R2BucketPort,
  roomId: string,
  now: number,
): Promise<RoomStorageInspection> {
  const prefixes = [`room/${roomId}/`];
  const staleKeys: string[] = [];
  const observedKeys = new Set<string>();
  const activeKeys = new Set<string>();
  let scannedObjects = 0;
  let totalBytes = 0;
  let saturated = false;

  for (const prefix of prefixes) {
    let cursor: string | undefined;
    do {
      const page = parseR2ListPage(
        await bucket.list({
          prefix,
          limit: ROOM_STORAGE_LIST_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
          include: ['customMetadata'],
        }),
      );
      if (!page) throw new Error('invalid room storage list response');
      for (const object of page.objects) {
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
        const size = Number(object.size);
        if (Number.isSafeInteger(size) && size > 0) {
          totalBytes += size;
          activeKeys.add(object.key);
        }
      }
      if (saturated) break;
      cursor = page.truncated ? page.cursor : undefined;
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

async function calculateRoomStorageBytes(
  bucket: R2BucketPort,
  roomId: string,
  now: number,
): Promise<number> {
  return (await inspectRoomStorage(bucket, roomId, now)).totalBytes;
}

async function roomHasStorageCapacity(
  env: RemoteShareEnvPort,
  roomId: string,
  additionalBytes: number,
): Promise<boolean> {
  const quotaBytes = roomStorageQuotaBytes(env);
  if (quotaBytes <= 0) return true;
  if (!env.REMOTE_SHARE_BUCKET) throw new Error('room storage quota bucket missing');
  const storedBytes = await calculateRoomStorageBytes(env.REMOTE_SHARE_BUCKET, roomId, Date.now());
  return storedBytes + additionalBytes <= quotaBytes;
}

function uploadHttpEtag(object: unknown): string {
  const httpEtag = String(isRecord(object) ? object.httpEtag || '' : '');
  if (UPLOAD_HTTP_ETAG_RE.test(httpEtag)) return httpEtag;
  const etag = String(isRecord(object) ? object.etag || '' : '');
  const quoted = `"${etag}"`;
  return UPLOAD_HTTP_ETAG_RE.test(quoted) ? quoted : '';
}

async function createUploadPlaceholder(
  env: RemoteShareEnvPort,
  reservation: QuotaReservation,
): Promise<string> {
  const bucket = env.REMOTE_SHARE_BUCKET;
  if (!bucket || typeof bucket.put !== 'function') {
    throw new Error('room storage quota bucket cannot create upload placeholder');
  }
  const object = await bucket.put(reservation.objectKey, new Uint8Array(), {
    customMetadata: {
      cleanupToken: reservation.cleanupToken,
      expiresAt: String(reservation.expiresAt),
      formatVersion: UPLOAD_PLACEHOLDER_FORMAT,
      objectId: reservation.objectId,
      roomId: reservation.roomId,
      storedSize: String(reservation.storedSize),
    },
    // A UUID collision or unexpected object is never safe to overwrite before
    // the room quota Durable Object has serialized this reservation.
    onlyIf: { etagDoesNotMatch: '*' },
  });
  const etag = uploadHttpEtag(object);
  if (!etag) {
    try {
      await bucket.delete(reservation.objectKey);
    } catch {
      // Preserve the primary fail-closed placeholder error.
    }
    throw new Error('upload placeholder ETag unavailable');
  }
  return etag;
}

async function deleteUnissuedUploadPlaceholder(
  env: RemoteShareEnvPort,
  key: string,
): Promise<void> {
  try {
    await env.REMOTE_SHARE_BUCKET?.delete(key);
  } catch (error) {
    // No presigned authority was returned for this candidate. A failed cleanup
    // is still conservative because the zero-byte placeholder remains visible
    // to reconciliation and cannot consume the declared-byte quota by itself.
    console.warn('remote share unissued upload placeholder cleanup failed', error);
  }
}

function roomStorageQuotaExceeded(request: Request, env: RemoteShareEnvPort): Response {
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

function quotaNamespace(env: RemoteShareEnvPort): DurableObjectNamespacePort {
  const namespace = env.REMOTE_SHARE_QUOTA;
  if (!isDurableObjectNamespace(namespace)) {
    throw new Error('room storage quota Durable Object missing');
  }
  return namespace;
}

function quotaStub(env: RemoteShareEnvPort, name: string): FetcherPort {
  const namespace = quotaNamespace(env);
  const stub = namespace.get(namespace.idFromName(name));
  if (!isFetcher(stub)) throw new Error('room storage quota Durable Object stub missing');
  return stub;
}

function roomQuotaStub(env: RemoteShareEnvPort, roomId: string): FetcherPort {
  return quotaStub(env, roomId);
}

function sessionProofStub(env: RemoteShareEnvPort, clientRequestId: string): FetcherPort {
  return quotaStub(env, `${SESSION_PROOF_OBJECT_PREFIX}${clientRequestId}`);
}

interface QuotaCallResult {
  payload: JsonRecord;
  status: number;
}

async function callQuotaStub(
  stub: FetcherPort,
  operation: string,
  body: JsonRecord,
): Promise<QuotaCallResult> {
  let activeReader: BodyReader | null = null;
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const outcome: Promise<{ response: Response; payload: unknown } | null> = Promise.resolve()
    .then(() =>
      stub.fetch(
        new Request(`https://remote-share-quota.internal/${operation}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
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
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      cancelBodyReader(activeReader, 'QUOTA_RESPONSE_TIMEOUT');
      resolve(null);
    }, QUOTA_RESPONSE_TIMEOUT_MS);
  });
  let result: { response: Response; payload: unknown } | null;
  try {
    result = await Promise.race([outcome, timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
  if (!result || !isRecord(result.payload)) {
    throw Object.assign(new Error('invalid room storage quota response'), {
      quotaOutcomeAmbiguous: true,
    });
  }
  return { payload: result.payload, status: result.response.status };
}

async function callRoomQuota(
  env: RemoteShareEnvPort,
  roomId: string,
  operation: string,
  body: JsonRecord,
): Promise<QuotaCallResult> {
  return callQuotaStub(roomQuotaStub(env, roomId), operation, { roomId, ...body });
}

async function claimUploadSessionProof(
  env: RemoteShareEnvPort,
  clientRequestId: string,
  operationId: string,
  expiresAt: number,
): Promise<{ replayed?: boolean; conflict?: true }> {
  const result = await callQuotaStub(sessionProofStub(env, clientRequestId), 'proof-claim', {
    clientRequestId,
    operationId,
    expiresAt,
  });
  if (result.status === 200 && result.payload?.claimed === true) {
    return { replayed: result.payload.replayed === true };
  }
  if (result.status === 409 && result.payload?.error === 'SESSION_REQUEST_CONFLICT') {
    return { conflict: true };
  }
  throw new Error('upload session proof fence unavailable');
}

async function reserveRoomStorage(
  env: RemoteShareEnvPort,
  reservation: QuotaReservation,
): Promise<{ replayed?: boolean; reservation?: unknown; conflict?: true } | null> {
  const result = await callRoomQuota(env, reservation.roomId, 'reserve', reservation);
  if (result.status === 200 && result.payload?.reserved === true) {
    return {
      replayed: result.payload.replayed === true,
      reservation:
        result.payload.reservation && typeof result.payload.reservation === 'object'
          ? result.payload.reservation
          : reservation,
    };
  }
  if (result.status === 409 && result.payload?.code === 'ROOM_STORAGE_QUOTA_EXCEEDED') {
    return null;
  }
  if (result.status === 409 && result.payload?.error === 'SESSION_REQUEST_CONFLICT') {
    return { conflict: true };
  }
  throw new Error('room storage quota unavailable');
}

async function lookupRoomStorageSession(
  env: RemoteShareEnvPort,
  roomId: string,
  operationId: string,
  clientRequestId: string,
): Promise<
  { status: 'found'; reservation: unknown } | { status: 'missing' } | { status: 'conflict' }
> {
  const result = await callRoomQuota(env, roomId, 'lookup', {
    operationId,
    clientRequestId,
  });
  if (result.status === 200 && result.payload?.found === true) {
    return { status: 'found', reservation: result.payload.reservation };
  }
  if (result.status === 404) return { status: 'missing' };
  if (result.status === 409 && result.payload?.error === 'SESSION_REQUEST_CONFLICT') {
    return { status: 'conflict' };
  }
  throw new Error('room storage quota unavailable');
}

async function completeRoomStorageReservation(
  env: RemoteShareEnvPort,
  reservation: JsonRecord & { roomId: string },
): Promise<'completed' | 'quota-exceeded' | 'missing'> {
  const result = await callRoomQuota(env, reservation.roomId, 'complete', reservation);
  if (result.status === 200 && result.payload?.completed === true) return 'completed';
  if (result.status === 409 && result.payload?.code === 'ROOM_STORAGE_QUOTA_EXCEEDED') {
    return 'quota-exceeded';
  }
  if (result.status === 404) return 'missing';
  throw new Error('room storage quota unavailable');
}

async function releaseRoomStorageReservation(
  env: RemoteShareEnvPort,
  roomId: string,
  objectId: string,
  cleanupToken: string,
): Promise<boolean> {
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

async function releaseRoomStorageReservationBestEffort(
  env: RemoteShareEnvPort,
  roomId: string,
  objectId: string,
  cleanupToken: string,
): Promise<{ confirmed: boolean; released: boolean }> {
  try {
    return {
      confirmed: true,
      released: await releaseRoomStorageReservation(env, roomId, objectId, cleanupToken),
    };
  } catch (error) {
    // A failed release leaves a conservative reservation until expiry. It can
    // temporarily deny capacity, but can never admit an over-quota upload.
    console.warn('remote share room storage reservation release failed', error);
    return { confirmed: false, released: false };
  }
}

function rateLimited(
  request: Request,
  env: RemoteShareEnvPort,
  message: string,
  retryAfterSeconds: number,
): Response {
  return json(request, env, { error: message, retryAfterSeconds }, 429, {
    'retry-after': String(retryAfterSeconds),
  });
}

async function consumeUploadSessionRateLimitsUncoalesced(
  request: Request,
  env: RemoteShareEnvPort,
  roomId: string,
  operationId: string,
  ipKey: string,
  rateWindowSeconds: number,
  ipUploadLimit: number,
  roomUploadLimit: number,
): Promise<Response | null> {
  const ipRate = await consumeLimit(env, ipKey, ipUploadLimit, rateWindowSeconds, operationId);
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
      operationId,
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

async function consumeUploadSessionRateLimits(
  request: Request,
  env: RemoteShareEnvPort,
  secret: string,
  roomId: string,
  operationId: string,
): Promise<Response | null> {
  const rateWindowSeconds = parseLimit(
    env.RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  );
  const ipUploadLimit = parseLimit(env.IP_UPLOADS_PER_WINDOW, DEFAULT_IP_UPLOADS_PER_WINDOW);
  const roomUploadLimit = parseOptionalLimit(
    env.ROOM_UPLOADS_PER_WINDOW,
    DEFAULT_ROOM_UPLOADS_PER_WINDOW,
  );
  const ipKey = await rateLimitIpKey(secret, request);
  const coalesceKey = JSON.stringify([
    operationId,
    ipKey,
    roomId,
    rateWindowSeconds,
    ipUploadLimit,
    roomUploadLimit,
  ]);
  let pending = inFlightUploadSessionRateLimits.get(coalesceKey);
  if (!pending) {
    pending = consumeUploadSessionRateLimitsUncoalesced(
      request,
      env,
      roomId,
      operationId,
      ipKey,
      rateWindowSeconds,
      ipUploadLimit,
      roomUploadLimit,
    );
    if (inFlightUploadSessionRateLimits.size < 1024) {
      inFlightUploadSessionRateLimits.set(coalesceKey, pending);
      const cleanup = () => {
        if (inFlightUploadSessionRateLimits.get(coalesceKey) === pending) {
          inFlightUploadSessionRateLimits.delete(coalesceKey);
        }
      };
      pending.then(cleanup, cleanup);
    }
  }
  const result = await pending;
  return result ? result.clone() : null;
}

function normalizeSessionReservation(
  value: unknown,
  expected: SessionReservationExpectation,
): QuotaReservation | null {
  if (!isRecord(value)) return null;
  const reservation = parseQuotaReservation({ ...value, roomId: expected.roomId });
  if (
    !reservation ||
    !validSessionReceiptFields(reservation) ||
    reservation.roomId !== expected.roomId ||
    reservation.operationId !== expected.operationId ||
    reservation.clientRequestId !== expected.clientRequestId ||
    reservation.storedSize !== expected.storedSize ||
    reservation.sessionId !== expected.sessionId ||
    reservation.queueItemId !== expected.queueItemId ||
    reservation.name !== expected.name ||
    reservation.mime !== expected.mime
  ) {
    return null;
  }
  return reservation;
}

async function issueUploadSession(
  reservation: QuotaReservation,
  env: RemoteShareEnvPort,
  secret: string,
  quotaEnabled: boolean,
): Promise<JsonRecord | null> {
  const now = Date.now();
  const signingSecond = Math.floor(now / 1000) * 1000;
  const authorityDeadline = Math.min(
    reservation.uploadAuthorityExpiresAt,
    reservation.expiresAt,
    signingSecond + MAX_UPLOAD_TOKEN_TTL_SECONDS * 1000,
  );
  if (now >= authorityDeadline) return null;
  const uploadTtlSeconds = Math.floor((authorityDeadline - signingSecond) / 1000);
  if (uploadTtlSeconds <= 0) return null;
  const uploadHeaders: HeaderRecord = {
    'content-type': 'application/octet-stream',
    ...(quotaEnabled ? { 'if-match': reservation.uploadEtag } : {}),
    'x-amz-meta-cleanup-token': reservation.cleanupToken,
    'x-amz-meta-expires-at': String(reservation.expiresAt),
    'x-amz-meta-format-version': WHOLE_OBJECT_STORAGE_FORMAT,
    'x-amz-meta-mime': reservation.mime,
    'x-amz-meta-name': reservation.name,
    'x-amz-meta-object-id': reservation.objectId,
    'x-amz-meta-room-id': reservation.roomId,
    'x-amz-meta-stored-size': String(reservation.storedSize),
  };
  const uploadUrl = await createR2PresignedPutUrl({
    env,
    objectKey: reservation.objectKey,
    headers: {
      ...uploadHeaders,
      'content-length': String(reservation.storedSize),
    },
    expiresInSeconds: uploadTtlSeconds,
    now: new Date(now),
  });
  if (!uploadUrl) throw new Error('r2 s3 config missing');
  const completeToken = await createSignedToken(
    {
      v: WHOLE_OBJECT_VERSION,
      ...(quotaEnabled ? { quotaReservationVersion: 1 } : {}),
      kind: 'complete',
      storageFormat: WHOLE_OBJECT_STORAGE_FORMAT,
      roomId: reservation.roomId,
      objectId: reservation.objectId,
      objectKey: reservation.objectKey,
      sessionId: reservation.sessionId,
      queueItemId: reservation.queueItemId,
      storedSize: reservation.storedSize,
      expiresAt: reservation.expiresAt,
      cleanupToken: reservation.cleanupToken,
      iat: now,
      exp: reservation.expiresAt,
      nonce: crypto.randomUUID(),
    },
    secret,
  );
  return {
    uploadUrl,
    uploadHeaders,
    uploadUrlExpiresAt: authorityDeadline,
    completeToken,
    objectId: reservation.objectId,
    expiresAt: reservation.expiresAt,
    cleanupToken: reservation.cleanupToken,
  };
}

async function authorizeRoomUploadAssertion(
  request: Request,
  env: RemoteShareEnvPort,
  context: WaitUntilContextPort,
  rateSecret: string,
  bodyBytes: Uint8Array,
  expected: {
    roomId: string;
    sessionId: number;
    queueItemId: string;
    size: number;
    actorId: string | null;
    requestId: string | null;
  },
): Promise<{ error: Response | null; metric: RoomUploadAssertionMetric | null }> {
  const configurationError = roomUploadAssertionConfigurationError(request, env);
  if (configurationError) return { error: configurationError, metric: null };
  const mode = roomUploadAssertionMode(env);
  if (mode === 'disabled') return { error: null, metric: null };

  if (!request.headers.has(ROOM_UPLOAD_ASSERTION_HEADER)) {
    if (mode === 'optional') {
      return { error: null, metric: 'remote_share_upload_assertion_legacy' };
    }
    await deferRejectedRoomUploadAssertionMetric(request, env, context, rateSecret);
    return {
      error: json(request, env, { error: 'ROOM_UPLOAD_ASSERTION_REQUIRED' }, 403),
      metric: null,
    };
  }

  const assertion = (request.headers.get(ROOM_UPLOAD_ASSERTION_HEADER) || '').trim();
  if (!assertion) {
    await deferRejectedRoomUploadAssertionMetric(request, env, context, rateSecret);
    return {
      error: json(request, env, { error: 'ROOM_UPLOAD_ASSERTION_INVALID' }, 403),
      metric: null,
    };
  }

  const bodySha256 = await sha256Base64Url(bodyBytes);
  const verified =
    expected.actorId && expected.requestId
      ? await verifyRemoteShareUploadAssertion(assertion, getRoomUploadAssertionSecret(env), {
          roomId: expected.roomId,
          sessionId: expected.sessionId,
          queueItemId: expected.queueItemId,
          size: expected.size,
          actorId: expected.actorId,
          requestId: expected.requestId,
          bodySha256,
        })
      : null;
  if (!verified) {
    await deferRejectedRoomUploadAssertionMetric(request, env, context, rateSecret);
    return {
      error: json(request, env, { error: 'ROOM_UPLOAD_ASSERTION_INVALID' }, 403),
      metric: null,
    };
  }
  return { error: null, metric: 'remote_share_upload_assertion_verified' };
}

async function handleSession(
  request: Request,
  env: RemoteShareEnvPort,
  context: WaitUntilContextPort,
): Promise<Response> {
  const secret = getSigningSecret(env);
  if (!secret) return json(request, env, { error: 'signing secret missing' }, 500);

  const capability = await authorizeSessionCapability(request, env, secret);
  if (capability.response) return capability.response;
  const authorityScope = capability.authorityScope;

  const parsedBody = await readJsonBodyLimited(request, SESSION_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(request, env, parsedBody);
  const body = parsedBody.value;

  const legacyKeys = ['roomId', 'sessionId', 'queueItemId', 'name', 'mime', 'size'];
  const legacyBody = hasExactOwnKeys(body, legacyKeys);
  const v2Body =
    hasExactOwnKeys(body, [...legacyKeys, 'requestId']) &&
    V2_CLIENT_SESSION_REQUEST_ID_RE.test(String(isRecord(body) ? body.requestId || '' : ''));
  const v3Body =
    hasExactOwnKeys(body, [...legacyKeys, 'requestId', 'actorId']) &&
    V3_CLIENT_SESSION_REQUEST_ID_RE.test(String(isRecord(body) ? body.requestId || '' : '')) &&
    V3_CLIENT_SESSION_ACTOR_ID_RE.test(String(isRecord(body) ? body.actorId || '' : ''));
  if (!legacyBody && !v2Body && !v3Body) {
    return json(request, env, { error: 'invalid upload session request' }, 400);
  }

  if (!isRecord(body)) return json(request, env, { error: 'invalid upload session request' }, 400);
  const roomId = standardRoomId(body.roomId);
  const sessionId = Number(body.sessionId);
  const queueItemId = safeQueueItemId(body.queueItemId);
  const storedSize = Number(body.size);
  const clientRequestId = body.requestId === undefined ? null : String(body.requestId || '');
  const clientActorId = v3Body ? String(body.actorId) : null;
  if (
    !roomId ||
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0 ||
    !queueItemId ||
    !Number.isSafeInteger(storedSize) ||
    storedSize <= 0 ||
    storedSize > REMOTE_SHARE_MAX_BYTES ||
    (clientRequestId !== null && !v2Body && !v3Body)
  ) {
    return json(request, env, { error: 'invalid upload session request' }, 400);
  }

  const name = metadataString(body.name, 'track');
  const mime = metadataString(body.mime, 'application/octet-stream');
  const assertionAuthorization = await authorizeRoomUploadAssertion(
    request,
    env,
    context,
    secret,
    parsedBody.bodyBytes,
    {
      roomId,
      sessionId,
      queueItemId,
      size: storedSize,
      actorId: clientActorId,
      requestId: v3Body ? clientRequestId : null,
    },
  );
  if (assertionAuthorization.error) return assertionAuthorization.error;
  const assertionMetric = assertionAuthorization.metric;
  // Only the actor-secret-derived v3 nonce is replay-authoritative. Cached v2
  // request IDs are deterministic from public queue metadata; treating them as
  // durable lookup keys would keep the cross-peer authority leak alive during
  // the mixed-version rollout. v2 and six-field clients remain accepted, but
  // every call receives an independent reservation.
  const replayClientRequestId = v3Body ? clientRequestId : null;
  const replayAuthorityScope = v3Body
    ? await hmacSha256(secret, `remote-share-client-actor:v3\u0000${clientActorId}`)
    : authorityScope;
  const receiptRequestId = await uploadSessionRequestKey(
    secret,
    replayAuthorityScope,
    replayClientRequestId,
  );
  const operationId = await uploadSessionOperationId(
    secret,
    replayAuthorityScope,
    replayClientRequestId,
    {
      roomId,
      sessionId,
      queueItemId,
      name,
      mime,
      storedSize,
    },
  );

  if (!getR2S3Config(env)) return json(request, env, { error: 'r2 s3 config missing' }, 500);
  const quotaEnabled = roomStorageSessionReplayEnabled(env);
  if (roomStorageQuotaEnabled(env) && !quotaEnabled) {
    return json(request, env, { error: 'room storage quota unavailable' }, 503);
  }
  if (!allowStatelessRemoteShareSession(env) && !quotaEnabled) {
    return json(request, env, { error: 'upload session replay unavailable' }, 503);
  }
  const now = Date.now();
  const objectTtlSeconds = parseLimit(env.OBJECT_TTL_SECONDS, DEFAULT_TTL_SECONDS);
  const expiresAt = Math.floor(now + objectTtlSeconds * 1000);
  const uploadTtlSeconds = Math.min(
    parseLimit(env.UPLOAD_TOKEN_TTL_SECONDS, DEFAULT_UPLOAD_TOKEN_TTL_SECONDS),
    MAX_UPLOAD_TOKEN_TTL_SECONDS,
  );
  const uploadAuthorityExpiresAt =
    Math.floor(Math.min(now + uploadTtlSeconds * 1000, expiresAt) / 1000) * 1000;
  const expectedReservation: SessionReservationExpectation = {
    roomId,
    operationId,
    storedSize,
    sessionId,
    queueItemId,
    name,
    mime,
    clientRequestId: receiptRequestId,
  };
  // The private v3 receipt is stable across an exact retry and across altered
  // metadata for the same proof. Consume the atomic limiter before touching
  // either proof or room Durable Objects so denied requests cannot create an
  // unbounded set of proof objects. Legacy requests retain their fresh
  // canonical operation identity.
  const rateLimitError = await consumeUploadSessionRateLimits(
    request,
    env,
    secret,
    roomId,
    receiptRequestId || operationId,
  );
  if (rateLimitError) return rateLimitError;

  if (quotaEnabled && receiptRequestId) {
    try {
      const proof = await claimUploadSessionProof(env, receiptRequestId, operationId, expiresAt);
      if (proof.conflict) {
        return json(request, env, { error: 'upload session request conflict' }, 409);
      }
    } catch (error) {
      console.warn('remote share upload session proof fence unavailable', error);
      return json(request, env, { error: 'room storage quota unavailable' }, 503);
    }
    let lookup;
    try {
      lookup = await lookupRoomStorageSession(env, roomId, operationId, receiptRequestId);
    } catch (error) {
      console.warn('remote share room storage quota unavailable', error);
      return json(request, env, { error: 'room storage quota unavailable' }, 503);
    }
    if (lookup.status === 'conflict') {
      return json(request, env, { error: 'upload session request conflict' }, 409);
    }
    if (lookup.status === 'found') {
      const replayedReservation = normalizeSessionReservation(
        lookup.reservation,
        expectedReservation,
      );
      if (!replayedReservation) {
        return json(request, env, { error: 'room storage quota unavailable' }, 503);
      }
      const replayedSession = await issueUploadSession(replayedReservation, env, secret, true);
      return replayedSession
        ? json(request, env, replayedSession)
        : json(request, env, { error: 'upload session replay expired' }, 409);
    }
  }

  const objectId = crypto.randomUUID();
  const objectKeyValue = objectKey(roomId, objectId);
  if (!objectKeyValue) {
    return json(request, env, { error: 'invalid upload session request' }, 400);
  }
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
  let candidateReservation: QuotaReservation = {
    roomId,
    objectId,
    objectKey: objectKeyValue,
    sessionId,
    queueItemId,
    storedSize,
    expiresAt,
    uploadAuthorityExpiresAt,
    cleanupToken,
    operationId,
    clientRequestId: receiptRequestId,
    name,
    mime,
  };
  let quotaReserved = false;
  let placeholderCreated = false;

  try {
    let authoritativeReservation = candidateReservation;
    if (quotaEnabled) {
      try {
        candidateReservation = {
          ...candidateReservation,
          uploadEtag: await createUploadPlaceholder(env, candidateReservation),
        };
        placeholderCreated = true;
      } catch (error) {
        console.warn('remote share upload placeholder unavailable', error);
        return json(request, env, { error: 'room storage quota unavailable' }, 503);
      }
      let reserved;
      try {
        reserved = await reserveRoomStorage(env, candidateReservation);
      } catch (error) {
        console.warn('remote share room storage quota unavailable', error);
        const release = await releaseRoomStorageReservationBestEffort(
          env,
          roomId,
          objectId,
          cleanupToken,
        );
        const reserveOutcomeAmbiguous = isRecord(error) && error.quotaOutcomeAmbiguous === true;
        if (release.released || (release.confirmed && !reserveOutcomeAmbiguous)) {
          await deleteUnissuedUploadPlaceholder(env, objectKeyValue);
          placeholderCreated = false;
        }
        // If reserve committed but its response and the compensating release
        // were both lost, retain the zero-byte placeholder. An exact v3 retry
        // can then recover a usable If-Match authority from the durable receipt.
        return json(request, env, { error: 'room storage quota unavailable' }, 503);
      }
      if (!reserved) {
        await deleteUnissuedUploadPlaceholder(env, objectKeyValue);
        placeholderCreated = false;
        return roomStorageQuotaExceeded(request, env);
      }
      if (reserved.conflict) {
        await deleteUnissuedUploadPlaceholder(env, objectKeyValue);
        placeholderCreated = false;
        return json(request, env, { error: 'upload session request conflict' }, 409);
      }
      quotaReserved = !reserved.replayed;
      const normalizedReservation = normalizeSessionReservation(
        reserved.reservation,
        expectedReservation,
      );
      if (!normalizedReservation) {
        throw new Error('invalid upload session reservation receipt');
      }
      authoritativeReservation = normalizedReservation;
      if (!reserved.replayed && authoritativeReservation.objectId !== objectId) {
        throw new Error('room storage quota selected an invalid upload placeholder');
      }
      if (reserved.replayed) {
        // Concurrent identical requests can both create a candidate before the
        // Durable Object selects one canonical receipt. The losing placeholder
        // has never had a URL issued and is safe to remove immediately.
        await deleteUnissuedUploadPlaceholder(env, objectKeyValue);
        placeholderCreated = false;
      }
    }
    const session = await issueUploadSession(authoritativeReservation, env, secret, quotaEnabled);
    if (!session) {
      if (quotaReserved) {
        const release = await releaseRoomStorageReservationBestEffort(
          env,
          roomId,
          objectId,
          cleanupToken,
        );
        if (release.released) {
          quotaReserved = false;
          if (placeholderCreated) {
            await deleteUnissuedUploadPlaceholder(env, objectKeyValue);
            placeholderCreated = false;
          }
        }
      }
      return json(request, env, { error: 'upload session replay expired' }, 409);
    }
    const response = json(request, env, session);
    if (assertionMetric && (!quotaEnabled || quotaReserved)) {
      deferRoomUploadAssertionMetric(context, env, assertionMetric);
    }
    quotaReserved = false;
    return response;
  } catch (error) {
    if (quotaReserved) {
      const release = await releaseRoomStorageReservationBestEffort(
        env,
        roomId,
        objectId,
        cleanupToken,
      );
      if (release.released) {
        quotaReserved = false;
        if (placeholderCreated) {
          await deleteUnissuedUploadPlaceholder(env, objectKeyValue);
          placeholderCreated = false;
        }
      }
    } else if (placeholderCreated) {
      await deleteUnissuedUploadPlaceholder(env, objectKeyValue);
      placeholderCreated = false;
    }
    throw error;
  }
}

async function deleteObjectAndRetainReservation(
  env: RemoteShareEnvPort,
  _roomId: string,
  _objectId: string,
  key: string,
  _cleanupToken: string,
): Promise<void> {
  if (!env.REMOTE_SHARE_BUCKET) throw new Error('room storage quota bucket missing');
  await env.REMOTE_SHARE_BUCKET.delete(key);
  // The canonical PUT is fenced by If-Match and cannot recreate a deleted key.
  // Keep the exact-byte reservation until fixed expiry anyway as conservative
  // defense-in-depth against provider/config drift and unexpected objects.
}

async function handleComplete(request: Request, env: RemoteShareEnvPort): Promise<Response> {
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
  const issuedAt = Number(isRecord(payload) ? payload.iat : undefined);
  const tokenExpiresAt = Number(isRecord(payload) ? payload.exp : undefined);
  const objectExpiresAt = Number(isRecord(payload) ? payload.expiresAt : undefined);
  const expectedTokenKeys =
    !isRecord(payload) || payload.quotaReservationVersion === undefined
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
    !isSafeInteger(payload.sessionId) ||
    payload.sessionId <= 0 ||
    !safeQueueItemId(payload.queueItemId) ||
    !isSafeInteger(payload.storedSize) ||
    payload.storedSize <= 0 ||
    payload.storedSize > REMOTE_SHARE_MAX_BYTES ||
    typeof payload.cleanupToken !== 'string' ||
    payload.cleanupToken.length === 0 ||
    payload.cleanupToken.length > CLEANUP_TOKEN_MAX_LENGTH ||
    !UUID_V4_RE.test(String(payload.nonce || '')) ||
    !isSafeInteger(issuedAt) ||
    !isSafeInteger(tokenExpiresAt) ||
    !isSafeInteger(objectExpiresAt) ||
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
  if (!isR2Object(object)) return json(request, env, { error: 'invalid uploaded object' }, 403);

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

function objectKey(roomId: unknown, objectId: unknown): string | null {
  const room = standardRoomId(roomId);
  if (
    !room ||
    typeof objectId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(objectId)
  ) {
    return null;
  }
  return `room/${room}/${objectId}`;
}

function downloadUnauthorized(request: Request, env: RemoteShareEnvPort): Response {
  return json(
    request,
    env,
    { error: 'download authorization required', code: 'DOWNLOAD_AUTHORIZATION_REQUIRED' },
    401,
    { 'www-authenticate': 'Bearer' },
  );
}

async function handleDownload(
  request: Request,
  env: RemoteShareEnvPort,
  roomId: string,
  objectId: string,
): Promise<Response> {
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
    !isSafeInteger(payload.storedSize) ||
    payload.storedSize <= 0 ||
    payload.storedSize > REMOTE_SHARE_MAX_BYTES ||
    !isSafeInteger(payload.iat) ||
    payload.iat <= 0 ||
    payload.iat > now + 60_000 ||
    !isSafeInteger(payload.exp) ||
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
  if (!isR2Object(object)) return json(request, env, { error: 'invalid stored object' }, 404);

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

  const objectBody = r2ObjectBody(object);
  if (!objectBody) return json(request, env, { error: 'invalid stored object' }, 404);
  return new Response(objectBody, {
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

async function handleDelete(
  request: Request,
  env: RemoteShareEnvPort,
  roomId: string,
  objectId: string,
): Promise<Response> {
  if (!env.REMOTE_SHARE_BUCKET) return json(request, env, { error: 'bucket missing' }, 500);
  const secret = getSigningSecret(env);
  if (!secret) return json(request, env, { error: 'signing secret missing' }, 500);

  const key = objectKey(roomId, objectId);
  if (!key) return json(request, env, { ok: true });

  const supplied = request.headers.get('x-mxqr-cleanup-token') || '';
  const cleanupPayload = await verifyCleanupToken(supplied, secret);
  const cleanupExpiresAt = isRecord(cleanupPayload) ? cleanupPayload.exp : undefined;
  if (
    !cleanupPayloadMatches(cleanupPayload, {
      roomId,
      objectId,
      key,
      expiresAt: cleanupExpiresAt,
    })
  ) {
    return json(request, env, { error: 'forbidden' }, 403);
  }

  // Signed cleanup authority is verified before HEAD so random object IDs or
  // UUID-shaped header values cannot be amplified into public R2 Class B work.
  const object = await env.REMOTE_SHARE_BUCKET.head(key);
  if (!object) return json(request, env, { ok: true });
  if (!isR2Object(object)) return json(request, env, { error: 'forbidden' }, 403);

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

function quotaJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function validSessionProofState(value: unknown): value is SessionProofState {
  return (
    hasExactOwnKeys(value, ['v', 'clientRequestId', 'operationId', 'expiresAt']) &&
    value.v === SESSION_PROOF_STATE_VERSION &&
    typeof value.clientRequestId === 'string' &&
    SESSION_RECEIPT_KEY_RE.test(value.clientRequestId) &&
    typeof value.operationId === 'string' &&
    SESSION_RECEIPT_KEY_RE.test(value.operationId) &&
    isSafeInteger(value.expiresAt) &&
    value.expiresAt > 0
  );
}

function emptyQuotaState(roomId: string): QuotaState {
  return {
    v: QUOTA_STATE_VERSION,
    roomId,
    reservations: {},
  };
}

function quotaStateWithinSerializedLimit(state: QuotaState): boolean {
  try {
    return (
      new TextEncoder().encode(JSON.stringify(state)).byteLength <= QUOTA_STATE_MAX_SERIALIZED_BYTES
    );
  } catch {
    return false;
  }
}

function reservationRetentionDeadline(reservation: StoredQuotaReservation): number {
  // R2 evaluates the signed If-Match condition when the object is committed,
  // so quota correctness does not depend on a transfer-duration bound. Keep
  // the exact-byte reservation through immutable object expiry anyway. The
  // subsequent non-charging tombstone repeatedly sweeps the exact key as
  // cleanup defense-in-depth against provider/config drift.
  return reservation.tombstoneNextSweepAt ?? reservation.expiresAt;
}

function hasSessionReceiptFields(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.operationId !== undefined ||
    value.clientRequestId !== undefined ||
    value.sessionId !== undefined ||
    value.queueItemId !== undefined ||
    value.name !== undefined ||
    value.mime !== undefined ||
    value.uploadEtag !== undefined ||
    value.uploadAuthorityExpiresAt !== undefined
  );
}

function validSessionReceiptFields(value: unknown): value is SessionReceiptFields {
  if (!isRecord(value)) return false;
  return (
    hasSessionReceiptFields(value) &&
    typeof value.operationId === 'string' &&
    SESSION_RECEIPT_KEY_RE.test(value.operationId) &&
    (value.clientRequestId === null ||
      (typeof value.clientRequestId === 'string' &&
        SESSION_RECEIPT_KEY_RE.test(value.clientRequestId))) &&
    isSafeInteger(value.sessionId) &&
    value.sessionId > 0 &&
    Boolean(safeQueueItemId(value.queueItemId)) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    value.name.length <= 512 &&
    !/[\r\n]/.test(value.name) &&
    typeof value.mime === 'string' &&
    value.mime.length > 0 &&
    value.mime.length <= 512 &&
    !/[\r\n]/.test(value.mime) &&
    typeof value.uploadEtag === 'string' &&
    UPLOAD_HTTP_ETAG_RE.test(value.uploadEtag) &&
    isSafeInteger(value.uploadAuthorityExpiresAt) &&
    value.uploadAuthorityExpiresAt > 0 &&
    isSafeInteger(value.expiresAt) &&
    value.uploadAuthorityExpiresAt <= value.expiresAt
  );
}

function validQuotaReservation(
  objectId: string,
  value: unknown,
  roomId: string,
): value is StoredQuotaReservationInput {
  if (!isRecord(value)) return false;
  const hasTombstoneFields =
    value.tombstoneQuietSince !== undefined || value.tombstoneNextSweepAt !== undefined;
  const validTombstoneFields =
    !hasTombstoneFields ||
    (isSafeInteger(value.tombstoneQuietSince) &&
      isSafeInteger(value.expiresAt) &&
      value.tombstoneQuietSince >= value.expiresAt &&
      isSafeInteger(value.tombstoneNextSweepAt) &&
      value.tombstoneNextSweepAt > value.tombstoneQuietSince);
  const key = objectKey(roomId, objectId);
  return (
    Boolean(key) &&
    value.objectId === objectId &&
    value.objectKey === key &&
    isSafeInteger(value.storedSize) &&
    value.storedSize > 0 &&
    value.storedSize <= REMOTE_SHARE_MAX_BYTES &&
    isSafeInteger(value.expiresAt) &&
    typeof value.cleanupToken === 'string' &&
    value.cleanupToken.length <= CLEANUP_TOKEN_MAX_LENGTH &&
    SIGNED_TOKEN_RE.test(value.cleanupToken) &&
    (value.status === 'reserved' || value.status === 'completed') &&
    validTombstoneFields
  );
}

function normalizeQuotaReservation(
  objectId: string,
  value: unknown,
  roomId: string,
): StoredQuotaReservation | null {
  if (!validQuotaReservation(objectId, value, roomId)) return null;
  const hasReceipt = hasSessionReceiptFields(value);
  const receiptValid = hasReceipt && validSessionReceiptFields(value);
  const receiptInvalid =
    value.receiptInvalid === true ||
    (value.receiptInvalid !== undefined && value.receiptInvalid !== true) ||
    (hasReceipt && !receiptValid);
  return {
    cleanupToken: value.cleanupToken,
    storedSize: value.storedSize,
    expiresAt: value.expiresAt,
    objectId,
    objectKey: value.objectKey,
    status: value.status,
    ...(receiptValid
      ? {
          operationId: value.operationId,
          clientRequestId: value.clientRequestId,
          sessionId: value.sessionId,
          queueItemId: value.queueItemId,
          name: value.name,
          mime: value.mime,
          uploadEtag: value.uploadEtag,
          uploadAuthorityExpiresAt: value.uploadAuthorityExpiresAt,
        }
      : {}),
    ...(receiptInvalid ? { receiptInvalid: true } : {}),
    ...(value.tombstoneQuietSince === undefined
      ? {}
      : { tombstoneQuietSince: value.tombstoneQuietSince }),
    ...(value.tombstoneNextSweepAt === undefined
      ? {}
      : { tombstoneNextSweepAt: value.tombstoneNextSweepAt }),
  };
}

function parseQuotaReservation(body: unknown): ParsedQuotaReservation | null {
  if (!isRecord(body)) return null;
  if (
    body.tombstoneQuietSince !== undefined ||
    body.tombstoneNextSweepAt !== undefined ||
    body.receiptInvalid !== undefined
  ) {
    return null;
  }
  const roomId = standardRoomId(body.roomId);
  const objectId = String(body.objectId || '');
  const storedSize = Number(body.storedSize);
  const expiresAt = Number(body.expiresAt);
  const cleanupToken = String(body.cleanupToken || '');
  const key = objectKey(roomId, objectId);
  if (
    !roomId ||
    !key ||
    body.objectKey !== key ||
    !Number.isSafeInteger(storedSize) ||
    storedSize <= 0 ||
    storedSize > REMOTE_SHARE_MAX_BYTES ||
    !Number.isSafeInteger(expiresAt) ||
    cleanupToken.length > CLEANUP_TOKEN_MAX_LENGTH ||
    !SIGNED_TOKEN_RE.test(cleanupToken)
  ) {
    return null;
  }
  const reservation: ParsedQuotaReservation = {
    cleanupToken,
    storedSize,
    expiresAt,
    objectId,
    objectKey: key,
    roomId,
  };
  if (!hasSessionReceiptFields(body)) return reservation;
  const withReceipt = {
    ...reservation,
    operationId: body.operationId,
    clientRequestId: body.clientRequestId ?? null,
    sessionId: body.sessionId,
    queueItemId: body.queueItemId,
    name: body.name,
    mime: body.mime,
    uploadEtag: body.uploadEtag,
    uploadAuthorityExpiresAt: body.uploadAuthorityExpiresAt,
  };
  return validSessionReceiptFields(withReceipt) ? withReceipt : null;
}

function reservationsMatch(left: ReservationIdentity, right: ReservationIdentity): boolean {
  return (
    left.objectId === right.objectId &&
    left.objectKey === right.objectKey &&
    left.storedSize === right.storedSize &&
    left.expiresAt === right.expiresAt &&
    constantTimeEqual(left.cleanupToken, right.cleanupToken)
  );
}

export class RemoteShareQuota {
  private readonly storage: DurableObjectStoragePort;
  private readonly env: RemoteShareEnvPort;
  private mutationTail: Promise<unknown>;

  constructor(state: DurableObjectStatePort, env: RemoteShareEnvPort = {}) {
    this.storage = state.storage;
    this.env = env;
    this.mutationTail = Promise.resolve();
  }

  private enqueueMutation<T>(task: (settledValue?: unknown) => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(task, task);
    this.mutationTail = run.catch(() => {});
    return run;
  }

  fetch(request: Request): Promise<Response> {
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

  private async handleSessionProofClaim(body: unknown): Promise<Response> {
    const now = Date.now();
    if (
      !hasExactOwnKeys(body, ['clientRequestId', 'operationId', 'expiresAt']) ||
      typeof body.clientRequestId !== 'string' ||
      !SESSION_RECEIPT_KEY_RE.test(body.clientRequestId) ||
      typeof body.operationId !== 'string' ||
      !SESSION_RECEIPT_KEY_RE.test(body.operationId) ||
      !isSafeInteger(body.expiresAt) ||
      body.expiresAt <= now
    ) {
      return quotaJson({ error: 'INVALID_REQUEST' }, 400);
    }

    const stored = await this.storage.get(SESSION_PROOF_STATE_KEY);
    if (stored !== undefined && stored !== null && !validSessionProofState(stored)) {
      throw new Error('invalid upload session proof state');
    }
    if (validSessionProofState(stored) && stored.expiresAt > now) {
      if (stored.clientRequestId !== body.clientRequestId) {
        throw new Error('upload session proof object mismatch');
      }
      if (stored.operationId !== body.operationId) {
        await this.storage.setAlarm(stored.expiresAt);
        return quotaJson({ error: 'SESSION_REQUEST_CONFLICT' }, 409);
      }
      const expiresAt = Math.max(stored.expiresAt, body.expiresAt);
      if (expiresAt !== stored.expiresAt) {
        await this.storage.put(SESSION_PROOF_STATE_KEY, { ...stored, expiresAt });
      }
      await this.storage.setAlarm(expiresAt);
      return quotaJson({ claimed: true, replayed: true });
    }

    const state: SessionProofState = {
      v: SESSION_PROOF_STATE_VERSION,
      clientRequestId: body.clientRequestId,
      operationId: body.operationId,
      expiresAt: body.expiresAt,
    };
    await this.storage.put(SESSION_PROOF_STATE_KEY, state);
    try {
      await this.storage.setAlarm(state.expiresAt);
    } catch (error) {
      // A brand-new proof has no older alarm to recover it. Remove the write so
      // a failed first claim cannot strand an immortal conflict fence.
      try {
        await this.storage.delete(SESSION_PROOF_STATE_KEY);
      } catch {
        // Preserve the alarm failure; cleanup remains best-effort.
      }
      throw error;
    }
    return quotaJson({ claimed: true, replayed: false });
  }

  private async readState(roomId: string): Promise<QuotaState> {
    const stored = await this.storage.get(QUOTA_STATE_KEY);
    if (stored === undefined || stored === null) return emptyQuotaState(roomId);
    if (isRecord(stored) && stored.v === 1 && stored.roomId === roomId) {
      // This deployment is an explicit no-active-session hard cutover. Drop the
      // obsolete reservation schema; the immediately following R2 scan remains
      // authoritative for every physical object that still exists.
      await this.storage.delete(QUOTA_STATE_KEY);
      if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
      return emptyQuotaState(roomId);
    }
    if (
      !isRecord(stored) ||
      stored.v !== QUOTA_STATE_VERSION ||
      stored.roomId !== roomId ||
      !isRecord(stored.reservations)
    ) {
      throw new Error('invalid room storage quota state');
    }
    const reservations: Record<string, StoredQuotaReservation> = {};
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

  private async scheduleAlarm(state: QuotaState): Promise<void> {
    const expiries = Object.values(state.reservations).map(reservationRetentionDeadline);
    if (expiries.length === 0) {
      if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
      return;
    }
    if (typeof this.storage.setAlarm === 'function') {
      await this.storage.setAlarm(Math.min(...expiries));
    }
  }

  private async persistState(state: QuotaState): Promise<void> {
    if (Object.keys(state.reservations).length === 0) {
      if (typeof this.storage.delete === 'function') await this.storage.delete(QUOTA_STATE_KEY);
    } else {
      await this.storage.put(QUOTA_STATE_KEY, state);
    }
    await this.scheduleAlarm(state);
  }

  private async maintainState(state: QuotaState, changed: boolean): Promise<void> {
    if (changed) await this.persistState(state);
    else await this.scheduleAlarm(state);
  }

  private async reconcile(
    state: QuotaState,
    now: number,
  ): Promise<{ changed: boolean; snapshot: RoomStorageInspection }> {
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
      const quietSince = observed || !isSafeInteger(priorQuietSince) ? now : priorQuietSince;
      if (
        !observed &&
        isSafeInteger(priorQuietSince) &&
        now - priorQuietSince >= EXPIRY_TOMBSTONE_QUIET_MS
      ) {
        delete state.reservations[objectId];
        changed = true;
        continue;
      }
      const tombstoneNextSweepAt = now + EXPIRY_TOMBSTONE_SWEEP_MS;
      if (
        hasSessionReceiptFields(reservation) ||
        reservation.receiptInvalid === true ||
        reservation.tombstoneQuietSince !== quietSince ||
        reservation.tombstoneNextSweepAt !== tombstoneNextSweepAt
      ) {
        const {
          operationId,
          clientRequestId,
          sessionId,
          queueItemId,
          name,
          mime,
          uploadEtag,
          uploadAuthorityExpiresAt,
          receiptInvalid,
          ...retainedReservation
        } = reservation;
        void operationId;
        void clientRequestId;
        void sessionId;
        void queueItemId;
        void name;
        void mime;
        void uploadEtag;
        void uploadAuthorityExpiresAt;
        void receiptInvalid;
        state.reservations[objectId] = {
          ...retainedReservation,
          tombstoneQuietSince: quietSince,
          tombstoneNextSweepAt,
        };
        changed = true;
      }
    }
    return { changed, snapshot };
  }

  private accountedBytes(state: QuotaState, snapshot: RoomStorageInspection, now: number): number {
    let totalBytes = snapshot.totalBytes;
    for (const reservation of Object.values(state.reservations)) {
      if (reservation.expiresAt <= now) continue;
      if (!snapshot.activeKeys.has(reservation.objectKey)) {
        totalBytes += reservation.storedSize;
      }
    }
    return Number.isSafeInteger(totalBytes) ? totalBytes : Number.POSITIVE_INFINITY;
  }

  private async handleFetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return quotaJson({ error: 'NOT_FOUND' }, 404);
    const url = new URL(request.url);
    const parsedBody = await readJsonBodyLimited(request, QUOTA_JSON_BODY_MAX_BYTES);
    if (parsedBody.error) return quotaJson({ error: 'INVALID_REQUEST' }, 400);
    const body = parsedBody.value;
    if (url.pathname === '/proof-claim') return this.handleSessionProofClaim(body);

    const roomId = standardRoomId(isRecord(body) ? body.roomId : undefined);
    if (!roomId) return quotaJson({ error: 'INVALID_REQUEST' }, 400);

    if (url.pathname === '/release') return this.handleRelease(roomId, body);
    if (url.pathname === '/lookup') return this.handleLookup(roomId, body);
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

  private async handleLookup(roomId: string, body: unknown): Promise<Response> {
    const operationId = String(isRecord(body) ? body.operationId || '' : '');
    const clientRequestId =
      isRecord(body) && body.clientRequestId === null
        ? null
        : String(isRecord(body) ? body.clientRequestId || '' : '');
    if (
      !hasExactOwnKeys(body, ['roomId', 'operationId', 'clientRequestId']) ||
      !SESSION_RECEIPT_KEY_RE.test(operationId) ||
      (clientRequestId !== null && !SESSION_RECEIPT_KEY_RE.test(clientRequestId))
    ) {
      return quotaJson({ error: 'INVALID_REQUEST' }, 400);
    }
    const now = Date.now();
    const state = await this.readState(roomId);
    if (
      Object.values(state.reservations).some(
        (candidate) => candidate.expiresAt > now && candidate.receiptInvalid === true,
      )
    ) {
      return quotaJson({ error: 'QUOTA_UNAVAILABLE' }, 503);
    }
    const replay = Object.values(state.reservations).find(
      (candidate) => candidate.expiresAt > now && candidate.operationId === operationId,
    );
    if (replay) {
      return quotaJson({ found: true, reservation: replay });
    }
    if (
      clientRequestId &&
      Object.values(state.reservations).some(
        (candidate) => candidate.expiresAt > now && candidate.clientRequestId === clientRequestId,
      )
    ) {
      return quotaJson({ error: 'SESSION_REQUEST_CONFLICT' }, 409);
    }
    return quotaJson({ found: false }, 404);
  }

  private async handleReserve(reservation: ParsedQuotaReservation): Promise<Response> {
    const quotaBytes = roomStorageQuotaBytes(this.env);
    if (quotaBytes <= 0) return quotaJson({ error: 'QUOTA_UNAVAILABLE' }, 503);
    const now = Date.now();
    if (reservation.expiresAt <= now) return quotaJson({ error: 'INVALID_REQUEST' }, 400);

    const state = await this.readState(reservation.roomId);
    const { changed, snapshot } = await this.reconcile(state, now);
    if (
      Object.values(state.reservations).some(
        (candidate) => candidate.expiresAt > now && candidate.receiptInvalid === true,
      )
    ) {
      await this.maintainState(state, changed);
      return quotaJson({ error: 'QUOTA_UNAVAILABLE' }, 503);
    }
    if (SESSION_RECEIPT_KEY_RE.test(reservation.operationId || '')) {
      const replay = Object.values(state.reservations).find(
        (candidate) => candidate.operationId === reservation.operationId,
      );
      if (replay) {
        await this.maintainState(state, changed);
        return quotaJson({ reserved: true, replayed: true, reservation: replay });
      }
      if (
        reservation.clientRequestId &&
        Object.values(state.reservations).some(
          (candidate) => candidate.clientRequestId === reservation.clientRequestId,
        )
      ) {
        await this.maintainState(state, changed);
        return quotaJson({ error: 'SESSION_REQUEST_CONFLICT' }, 409);
      }
    }
    const existing = state.reservations[reservation.objectId];
    if (existing) {
      if (!reservationsMatch(existing, reservation)) {
        await this.maintainState(state, changed);
        return quotaJson({ error: 'RESERVATION_CONFLICT' }, 409);
      }
      await this.maintainState(state, changed);
      return quotaJson({
        reserved: true,
        replayed: true,
        ...(hasSessionReceiptFields(existing) ? { reservation: existing } : {}),
      });
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
    return quotaJson({
      reserved: true,
      replayed: false,
      ...(hasSessionReceiptFields(reservation) ? { reservation } : {}),
    });
  }

  private async handleComplete(reservation: ParsedQuotaReservation): Promise<Response> {
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

  private async handleRelease(roomId: string, body: unknown): Promise<Response> {
    const objectId = String(isRecord(body) ? body.objectId || '' : '');
    const cleanupToken = String(isRecord(body) ? body.cleanupToken || '' : '');
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

  alarm(): Promise<void> {
    return this.enqueueMutation(async () => {
      try {
        if ((await readServiceMaintenance(this.env)).enabled) {
          if (typeof this.storage.setAlarm === 'function') {
            await this.storage.setAlarm(Date.now() + QUOTA_ALARM_RETRY_MS);
          }
          return;
        }
        const [proofStored, stored] = await Promise.all([
          this.storage.get(SESSION_PROOF_STATE_KEY),
          this.storage.get(QUOTA_STATE_KEY),
        ]);
        if (proofStored !== undefined && proofStored !== null) {
          if (stored !== undefined && stored !== null) {
            throw new Error('mixed upload session proof and room quota state');
          }
          if (!validSessionProofState(proofStored)) {
            throw new Error('invalid upload session proof state');
          }
          if (proofStored.expiresAt <= Date.now()) {
            await this.storage.delete(SESSION_PROOF_STATE_KEY);
            if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
          } else if (typeof this.storage.setAlarm === 'function') {
            await this.storage.setAlarm(proofStored.expiresAt);
          }
          return;
        }
        if (stored === undefined || stored === null) {
          if (typeof this.storage.deleteAll === 'function') await this.storage.deleteAll();
          if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
          return;
        }
        const roomId = standardRoomId(isRecord(stored) ? stored.roomId : undefined);
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
  async fetch(
    request: Request,
    env: RemoteShareEnvPort,
    context: WaitUntilContextPort = {},
  ): Promise<Response> {
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
        return await handleSession(request, env, context);
      }
      if (request.method === 'POST' && path === '/complete') {
        return await handleComplete(request, env);
      }
      const download = path.match(/^\/download\/([^/]+)\/([^/]+)$/);
      if (request.method === 'GET' && download?.[1] && download[2]) {
        return await handleDownload(request, env, download[1], download[2]);
      }
      const object = path.match(/^\/object\/([^/]+)\/([^/]+)$/);
      if (request.method === 'DELETE' && object?.[1] && object[2]) {
        return await handleDelete(request, env, object[1], object[2]);
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
} satisfies PortableRemoteShareHandler;
