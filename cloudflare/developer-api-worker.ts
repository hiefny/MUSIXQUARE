/**
 * MUSIXQUARE Developer API public edge Worker.
 *
 * This Worker intentionally has no binding to PRO room Durable Objects, R2,
 * signaling, or the browser-facing PRO Worker. It authenticates a room-bound
 * API key, applies ingress and room-serial limits, then sends one allowlisted
 * intent to the private Developer API Facade service binding.
 */

import {
  isProRoomGeneration,
  proRoomGenerationHeaderValue,
  proRoomObjectName,
} from './pro-room-generation.ts';
import { gateServiceMaintenance, readServiceMaintenance } from './service-maintenance.ts';

type JsonRecord = Record<string, unknown>;
type HeaderRecord = Record<string, string>;
type BodyReader = ReadableStreamDefaultReader<Uint8Array>;
type CancellableBody = { cancel(reason?: unknown): Promise<void> };
type Projection = 'room' | 'playback' | 'queue' | 'effects' | 'queue-mode';

interface DeveloperApiEnvPort {
  readonly CF_VERSION_METADATA?: unknown;
  readonly DEVELOPER_API_CANARY_ROOMS?: unknown;
  readonly DEVELOPER_API_DB?: unknown;
  readonly DEVELOPER_API_FACADE?: unknown;
  readonly DEVELOPER_API_LIMITERS?: unknown;
  readonly DEVELOPER_API_MODE?: unknown;
  readonly MUSIXQUARE_SERVICE_CONTROL?: unknown;
  readonly MXQR_DEVELOPER_API_KEY_PEPPER?: unknown;
  readonly MXQR_DEVELOPER_API_RATE_SECRET?: unknown;
}

interface WaitUntilContextPort {
  waitUntil?(promise: Promise<unknown>): void;
}

interface RequiredWaitUntilContextPort {
  waitUntil(promise: Promise<unknown>): void;
}

interface D1PreparedStatementPort {
  bind(...values: unknown[]): D1PreparedStatementPort;
  first(): Promise<unknown>;
  run(): Promise<unknown>;
}

interface D1DatabasePort {
  prepare(query: string): D1PreparedStatementPort;
}

interface FetcherPort {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespacePort {
  idFromName(name: string): unknown;
  get(id: unknown): unknown;
}

interface DurableObjectStoragePort {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete?(key: string): Promise<unknown>;
  deleteAll?(): Promise<void>;
  setAlarm?(scheduledTime: number): Promise<void>;
  deleteAlarm?(): Promise<void>;
}

interface DurableObjectStatePort {
  readonly storage: DurableObjectStoragePort;
}

interface DeveloperApiPrincipal {
  keyId: string;
  roomCode: string;
  roomGeneration: number;
  developerAuthorityEpoch: number;
  label: string;
  digest: string;
  scopeMask: number;
  status: 'active' | 'revoked';
  expiresAt: number;
  lastUsedHour: number | null;
}

interface RateLimitResult extends JsonRecord {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtMs: number;
  retryAfterSeconds: number;
}

interface MediaUpload extends JsonRecord {
  name: string;
  byteLength: number;
  mime: string;
  sha256?: string;
}

interface YouTubeQueueItem extends JsonRecord {
  type: 'add_youtube';
  videoId: string;
  name: string;
  playlistId?: string;
  videoIds?: string[];
}

interface QueueItem extends JsonRecord {
  queueItemId: string;
  kind: 'youtube' | 'audio';
  name: string;
  addedBy: string;
  byteLength?: number;
  youtubeSubItemCount?: number;
  youtubeEntrySubIndex?: number;
}

interface RateBucketRequest {
  id: string;
  limit: number;
  windowMs: number;
  cost: number;
}

interface StoredRateBucket extends JsonRecord {
  limit: number;
  count: number;
  windowStartMs: number;
  resetAtMs: number;
}

interface EvaluatedRateBucket extends RateBucketRequest {
  count: number;
  windowStartMs: number;
  resetAtMs: number;
}

interface PortableDeveloperApiHandler {
  fetch(
    request: Request,
    env: DeveloperApiEnvPort,
    context?: WaitUntilContextPort,
  ): Promise<Response>;
  scheduled(
    controller: unknown,
    env: DeveloperApiEnvPort,
    context: RequiredWaitUntilContextPort,
  ): void;
}

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
const QUEUE_ITEM_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASSET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const SHA256_RE = /^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/;
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS = 5_000;
const YOUTUBE_PLAYBACK_SUB_INDEX_MAX = 100_000;
const QUEUE_ITEM_ADDED_BY_VALUES: ReadonlySet<unknown> = new Set([
  'participant',
  'current_api_key',
  'another_api_key',
]);
const PLAYLIST_MAX_ITEMS = 1_000;
const YOUTUBE_BATCH_MAX_ITEMS = 100;
const ASSET_MAX_BYTES = 200 * 1024 * 1024;
const PLAYBACK_MAX_POSITION_SECONDS = 7 * 24 * 60 * 60;
// The PRO room core remains capped at 1.2 MiB, while its independently stored
// public playlist is capped below 3 MiB. Leave bounded framing room so every
// accepted queue remains readable through the unchanged public API contract.
const FACADE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const RATE_REQUEST_MAX_BYTES = 4 * 1024;
const DEPENDENCY_RESPONSE_TIMEOUT_MS = 5_000;
const PUBLIC_REQUEST_BODY_TIMEOUT_MS = 10_000;
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
const DEVELOPER_API_VERSION_HEADER = 'x-mxqr-developer-api-version';
const DEVELOPER_API_FACADE_VERSION_HEADER = 'x-mxqr-developer-api-facade-version';
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
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isD1Database(value: unknown): value is D1DatabasePort {
  return isRecord(value) && typeof value.prepare === 'function';
}

function isFetcher(value: unknown): value is FetcherPort {
  return isRecord(value) && typeof value.fetch === 'function';
}

function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespacePort {
  return (
    isRecord(value) && typeof value.idFromName === 'function' && typeof value.get === 'function'
  );
}

function developerApiDatabase(env: DeveloperApiEnvPort): D1DatabasePort | null {
  return isD1Database(env.DEVELOPER_API_DB) ? env.DEVELOPER_API_DB : null;
}

function proRoomGenerationWireFields(roomGeneration: unknown): { roomGeneration: number } {
  if (!isProRoomGeneration(roomGeneration)) throw new Error('Invalid room generation');
  return { roomGeneration };
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is JsonRecord {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function boundedString(value: unknown, maxLength: number, allowEmpty = false): string | null {
  if (typeof value !== 'string' || value.length > maxLength) return null;
  if (!allowEmpty && value.length === 0) return null;
  return value;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomRequestId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `req_${base64UrlEncode(bytes)}`;
}

async function hmacBase64Url(secret: string, value: string): Promise<string> {
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

function constantTimeEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function parseDeveloperApiKey(value: unknown): { keyId: string; secret: string } | null {
  if (typeof value !== 'string' || value.length > AUTHORIZATION_MAX_BYTES) return null;
  const match = value.match(API_KEY_RE);
  const keyId = match?.[1];
  const secret = match?.[2];
  return typeof keyId === 'string' && typeof secret === 'string' ? { keyId, secret } : null;
}

export async function deriveDeveloperApiKeyDigest(
  pepper: string,
  keyId: string,
  secret: string,
): Promise<string> {
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

function apiHeaders(
  requestId: string,
  extraHeaders: Readonly<HeaderRecord> = {},
  cacheControl = 'no-store',
): HeaderRecord {
  return {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    'cache-control': cacheControl,
    'x-request-id': requestId,
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  extraHeaders: Readonly<HeaderRecord> = {},
  cacheControl = 'no-store',
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...apiHeaders(requestId, extraHeaders, cacheControl),
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function emptyResponse(
  status: number,
  requestId: string,
  extraHeaders: Readonly<HeaderRecord> = {},
  cacheControl = 'private, no-cache',
): Response {
  return new Response(null, {
    status,
    headers: apiHeaders(requestId, extraHeaders, cacheControl),
  });
}

type DeveloperApiErrorCode = keyof typeof ERROR_MESSAGES | 'DEVELOPER_API_AUTHORITY_STALE';

function errorResponse(
  code: DeveloperApiErrorCode,
  status: number,
  requestId: string,
  options: { retryable?: boolean; headers?: Readonly<HeaderRecord> } = {},
): Response {
  return jsonResponse(
    {
      error: {
        code,
        message:
          code === 'DEVELOPER_API_AUTHORITY_STALE'
            ? 'The request could not be completed.'
            : ERROR_MESSAGES[code],
        requestId,
        retryable: options.retryable === true,
      },
    },
    status,
    requestId,
    options.headers || {},
  );
}

function dataPlaneVersionHeaders(
  env: DeveloperApiEnvPort,
  facadeWorkerVersionId: unknown,
): HeaderRecord {
  const headers: HeaderRecord = {};
  const metadata = env.CF_VERSION_METADATA;
  const workerVersionId = isRecord(metadata) ? metadata.id : undefined;
  if (typeof workerVersionId === 'string' && workerVersionId.length > 0) {
    headers[DEVELOPER_API_VERSION_HEADER] = workerVersionId;
  }
  if (typeof facadeWorkerVersionId === 'string' && facadeWorkerVersionId.length > 0) {
    headers[DEVELOPER_API_FACADE_VERSION_HEADER] = facadeWorkerVersionId;
  }
  return headers;
}

function configuredMode(env: DeveloperApiEnvPort): 'off' | 'read-only' | 'canary' | 'enabled' {
  const mode = String(env.DEVELOPER_API_MODE || 'off')
    .trim()
    .toLowerCase();
  return mode === 'read-only' || mode === 'canary' || mode === 'enabled' ? mode : 'off';
}

function configuredCanaryRooms(env: DeveloperApiEnvPort): Set<string> {
  return new Set(
    String(env.DEVELOPER_API_CANARY_ROOMS || '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => ROOM_CODE_RE.test(value)),
  );
}

function readBearer(request: Request): { keyId: string; secret: string } | null {
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

function validScopeMask(value: unknown): value is number {
  if (typeof value !== 'number') return false;
  return (
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= ALL_SCOPE_BITS &&
    (value & ~ALL_SCOPE_BITS) === 0
  );
}

function normalizeKeyRow(value: unknown): DeveloperApiPrincipal | null {
  if (!isRecord(value)) return null;
  const label =
    typeof value.label === 'string' &&
    value.label.length >= 1 &&
    value.label.length <= 64 &&
    !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value.label)
      ? value.label
      : null;
  if (
    !/^[A-Za-z0-9_-]{16}$/.test(String(value.key_id || '')) ||
    typeof value.key_id !== 'string' ||
    !ROOM_CODE_RE.test(String(value.room_code || '')) ||
    typeof value.room_code !== 'string' ||
    !isProRoomGeneration(value.room_generation) ||
    !isSafeNonNegativeInteger(value.authority_epoch) ||
    label === null ||
    !DIGEST_RE.test(String(value.secret_digest || '')) ||
    typeof value.secret_digest !== 'string' ||
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
    developerAuthorityEpoch: value.authority_epoch,
    label,
    digest: value.secret_digest,
    scopeMask: value.scope_mask,
    status: value.status,
    expiresAt: value.expires_at,
    lastUsedHour: value.last_used_hour,
  };
}

async function lookupKey(env: DeveloperApiEnvPort, keyId: string): Promise<unknown> {
  const database = developerApiDatabase(env);
  if (!database) throw new Error('Developer API D1 binding unavailable');
  return database
    .prepare(
      `SELECT key_id, room_code, room_generation, authority_epoch, label, secret_digest, digest_version, scope_mask,
            status, created_at, updated_at, expires_at, revoked_at, last_used_hour
     FROM mxqr_developer_api_keys
     WHERE key_id = ?1
     LIMIT 1`,
    )
    .bind(keyId)
    .first();
}

function updateLastUsedBestEffort(
  env: DeveloperApiEnvPort,
  context: WaitUntilContextPort,
  keyId: string,
  nowMs: number,
): void {
  const database = developerApiDatabase(env);
  if (!context.waitUntil || !database) return;
  const hour = Math.floor(nowMs / 3_600_000) * 3_600_000;
  const update = database
    .prepare(
      `UPDATE mxqr_developer_api_keys
     SET last_used_hour = ?2
     WHERE key_id = ?1 AND (last_used_hour IS NULL OR last_used_hour < ?2)`,
    )
    .bind(keyId, hour)
    .run()
    .catch(() => {});
  context.waitUntil(update);
}

export async function expireDeveloperApiKeys(
  env: DeveloperApiEnvPort,
  nowMs = Date.now(),
): Promise<unknown> {
  if (!isSafeNonNegativeInteger(nowMs)) {
    throw new Error('Invalid Developer API expiry timestamp');
  }
  const database = developerApiDatabase(env);
  if (!database) {
    throw new Error('Developer API D1 binding unavailable');
  }
  return database
    .prepare(
      `UPDATE mxqr_developer_api_keys
     SET status = 'revoked',
         revoked_at = expires_at,
         updated_at = CASE WHEN updated_at > expires_at THEN updated_at ELSE expires_at END
     WHERE status = 'active' AND expires_at <= ?1`,
    )
    .bind(nowMs)
    .run();
}

interface AuthenticationResult {
  configurationError?: true;
  unauthorized?: true;
  backendError?: true;
  principal?: DeveloperApiPrincipal;
}

async function authenticate(
  request: Request,
  env: DeveloperApiEnvPort,
  context: WaitUntilContextPort,
  nowMs: number,
): Promise<AuthenticationResult> {
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

function cancelBodyReader(reader: CancellableBody | null, reason: unknown): void {
  try {
    Promise.resolve(reader?.cancel(reason)).catch(() => {});
  } catch {
    // Cancellation is best-effort and must never delay a bounded response.
  }
}

async function readJsonLimited(
  response: Response,
  maxBytes: number,
  registerReader: (reader: BodyReader | null) => void = () => {},
): Promise<unknown | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > maxBytes)) {
    return null;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  registerReader(reader);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > maxBytes) {
        cancelBodyReader(reader, 'RESPONSE_BODY_TOO_LARGE');
        return null;
      }
      chunks.push(value);
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

interface LimitedJsonResponse {
  response: Response;
  value: unknown;
}

async function fetchJsonLimited(
  fetcher: () => Response | Promise<Response>,
  maxBytes: number,
  timeoutMs = DEPENDENCY_RESPONSE_TIMEOUT_MS,
): Promise<LimitedJsonResponse | null> {
  let activeReader: BodyReader | null = null;
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const operation: Promise<LimitedJsonResponse | null> = Promise.resolve()
    .then(() => fetcher())
    .then(
      async (response) => {
        if (timedOut) {
          cancelBodyReader(response.body, 'DEPENDENCY_RESPONSE_TIMEOUT');
          return null;
        }
        const value = await readJsonLimited(response, maxBytes, (reader) => {
          activeReader = reader;
        });
        return timedOut ? null : { response, value };
      },
      () => null,
    );
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      cancelBodyReader(activeReader, 'DEPENDENCY_RESPONSE_TIMEOUT');
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

async function readRequestJsonLimited(
  request: Request,
  maxBytes: number,
  timeoutMs = PUBLIC_REQUEST_BODY_TIMEOUT_MS,
): Promise<unknown | null> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    return null;
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > maxBytes)) {
    return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let stop: ((outcome: { kind: 'timeout' | 'aborted' }) => void) | undefined;
  const stopped = new Promise<{ kind: 'timeout' | 'aborted' }>((resolve) => {
    stop = resolve;
  });
  const timeout = setTimeout(() => {
    stop?.({ kind: 'timeout' });
    cancelBodyReader(reader, 'REQUEST_BODY_TIMEOUT');
  }, timeoutMs);
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
      if (outcome.kind !== 'read') return null;
      const { done, value } = outcome.value;
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > maxBytes) {
        cancelBodyReader(reader, 'REQUEST_BODY_TOO_LARGE');
        return null;
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', abort);
    try {
      reader.releaseLock();
    } catch {
      // A timed-out non-cooperative stream may still own its pending read.
    }
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

async function hasNonEmptyRequestBody(request: Request): Promise<boolean> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const normalized = declared.trim();
    if (!/^\d+$/.test(normalized) || Number(normalized) !== 0) return true;
  }
  if (!request.body) return false;

  let reader: BodyReader | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let abort: (() => void) | null = null;
  try {
    reader = request.body.getReader();
    let stop: ((outcome: { kind: 'timeout' | 'aborted' }) => void) | undefined;
    const stopped = new Promise<{ kind: 'timeout' | 'aborted' }>((resolve) => {
      stop = resolve;
    });
    timeout = setTimeout(() => {
      stop?.({ kind: 'timeout' });
      cancelBodyReader(reader, 'REQUEST_BODY_TIMEOUT');
    }, PUBLIC_REQUEST_BODY_TIMEOUT_MS);
    abort = () => {
      stop?.({ kind: 'aborted' });
      cancelBodyReader(reader, request.signal.reason);
    };
    if (request.signal.aborted) abort();
    else request.signal.addEventListener('abort', abort, { once: true });
    while (true) {
      const outcome = await Promise.race([
        reader.read().then(
          (value) => ({ kind: 'read' as const, value }),
          () => ({ kind: 'invalid' as const }),
        ),
        stopped,
      ]);
      if (outcome.kind !== 'read') return true;
      const { done, value } = outcome.value;
      if (done) return false;
      if (value?.byteLength) {
        cancelBodyReader(reader, 'UNEXPECTED_REQUEST_BODY');
        return true;
      }
    }
  } catch {
    // A bodyless endpoint cannot safely treat an unreadable stream as empty.
    return true;
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    if (abort) request.signal.removeEventListener('abort', abort);
    try {
      reader?.releaseLock();
    } catch {
      /* pending non-cooperative stream read */
    }
  }
}

type DeveloperCommand =
  | { type: 'play' | 'pause' | 'next' }
  | { type: 'seek'; positionSeconds: number }
  | { type: 'play_item'; queueItemId: string; youtubeSubIndex?: number }
  | { type: 'set_effects'; effects: JsonRecord };

function parseDeveloperCommand(value: unknown): DeveloperCommand | null {
  if (!isRecord(value)) return null;
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
    return hasExactKeys(value, ['type', 'queueItemId'], ['youtubeSubIndex']) &&
      typeof value.queueItemId === 'string' &&
      QUEUE_ITEM_UUID_RE.test(value.queueItemId) &&
      (value.youtubeSubIndex === undefined ||
        (isSafeNonNegativeInteger(value.youtubeSubIndex) &&
          value.youtubeSubIndex < YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS))
      ? {
          type: 'play_item',
          queueItemId: value.queueItemId,
          ...(value.youtubeSubIndex === undefined
            ? {}
            : { youtubeSubIndex: value.youtubeSubIndex }),
        }
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

function parseQueueModeUpdate(value: unknown): JsonRecord | null {
  return hasExactKeys(value, ['baseRevision', 'repeatMode', 'shuffleEnabled']) &&
    isSafeNonNegativeInteger(value.baseRevision) &&
    (value.repeatMode === 'off' || value.repeatMode === 'all' || value.repeatMode === 'one') &&
    typeof value.shuffleEnabled === 'boolean'
    ? {
        baseRevision: value.baseRevision,
        repeatMode: value.repeatMode,
        shuffleEnabled: value.shuffleEnabled,
      }
    : null;
}

const EFFECT_REVERB_FIELDS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  mixPercent: [0, 100],
  decaySeconds: [0.1, 30],
  preDelaySeconds: [0, 1],
  lowCutPercent: [0, 100],
  highCutPercent: [0, 100],
});

function boundedFiniteNumber(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

function parseReverbPatch(value: unknown, requireComplete = false): JsonRecord | null {
  if (!isRecord(value)) return null;
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
  const parsed: JsonRecord = {};
  for (const key of keys) {
    const bounds = EFFECT_REVERB_FIELDS[key];
    if (!bounds) return null;
    const [minimum, maximum] = bounds;
    if (!boundedFiniteNumber(value[key], minimum, maximum)) return null;
    parsed[key] = value[key];
  }
  return parsed;
}

function parseEqualizer(value: unknown): JsonRecord | null {
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

function parseVirtualBass(value: unknown): JsonRecord | null {
  return hasExactKeys(value, ['strengthPercent']) &&
    boundedFiniteNumber(value.strengthPercent, 0, 100)
    ? { strengthPercent: value.strengthPercent }
    : null;
}

function parseVirtualSurround(value: unknown): JsonRecord | null {
  return hasExactKeys(value, ['widthPercent']) && boundedFiniteNumber(value.widthPercent, 0, 200)
    ? { widthPercent: value.widthPercent }
    : null;
}

function parseVirtualTreble(value: unknown): JsonRecord | null {
  return hasExactKeys(value, ['enabled']) && typeof value.enabled === 'boolean'
    ? { enabled: value.enabled }
    : null;
}

function parseEffects(value: unknown, requireComplete: boolean): JsonRecord | null {
  if (!isRecord(value)) return null;
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
  const effects: JsonRecord = {};
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

function parseEffectsPatch(value: unknown): JsonRecord | null {
  return parseEffects(value, false);
}

function parseEffectsState(value: unknown): JsonRecord | null {
  return parseEffects(value, true);
}

interface MediaMetadata extends JsonRecord {
  name: string;
  title?: string;
  artist?: string;
  thumbnail?: string;
}

function parseMetadata(value: unknown): MediaMetadata | null {
  if (!isRecord(value)) return null;
  const name = boundedString(value.name, 512);
  if (!name) return null;
  const metadata: MediaMetadata = { name };
  for (const key of ['title', 'artist', 'thumbnail']) {
    if (value[key] === undefined) continue;
    const parsed = boundedString(value[key], 512);
    if (!parsed) return null;
    metadata[key] = parsed;
  }
  return metadata;
}

function parseYouTubeVideoIds(
  value: unknown,
  playlistId: string | undefined,
  videoId: string,
): string[] | null | undefined {
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

function parseYouTubeQueueItem(value: unknown): YouTubeQueueItem | null {
  if (
    !hasExactKeys(
      value,
      ['videoId', 'name'],
      ['playlistId', 'videoIds', 'title', 'artist', 'thumbnail'],
    ) ||
    typeof value.videoId !== 'string' ||
    !YOUTUBE_VIDEO_ID_RE.test(value.videoId) ||
    (value.playlistId !== undefined &&
      (typeof value.playlistId !== 'string' || !YOUTUBE_PLAYLIST_ID_RE.test(value.playlistId)))
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

function canonicalizeYouTubeBatchItems(
  items: readonly YouTubeQueueItem[],
): YouTubeQueueItem[] | null {
  const result: YouTubeQueueItem[] = [];
  const playlistStates = new Map<string, { index: number; hasManifest: boolean }>();
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
    if (!existing) return null;
    if (state.hasManifest !== (item.videoIds !== undefined)) return null;
    if (state.hasManifest) {
      const existingVideoIds = existing.videoIds;
      const itemVideoIds = item.videoIds;
      if (
        !existingVideoIds ||
        !itemVideoIds ||
        existingVideoIds.length !== itemVideoIds.length ||
        existingVideoIds.some((videoId, index) => videoId !== itemVideoIds[index])
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

function hasNoNull<T>(values: readonly (T | null)[]): values is T[] {
  return values.every((value) => value !== null);
}

function parseYouTubeQueueItemBatch(value: unknown): JsonRecord | null {
  if (
    !hasExactKeys(value, ['items']) ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.items.length > YOUTUBE_BATCH_MAX_ITEMS
  ) {
    return null;
  }
  const items = value.items.map((item) => parseYouTubeQueueItem(item));
  if (!hasNoNull(items)) return null;
  const canonicalItems = canonicalizeYouTubeBatchItems(items);
  if (!canonicalItems) return null;
  return {
    type: 'add_youtube_batch',
    items: canonicalItems.map(({ type: _type, ...item }) => item),
  };
}

function parseQueueOrder(value: unknown): JsonRecord | null {
  if (
    !hasExactKeys(value, ['basePlaylistRevision', 'queueItemIds']) ||
    !isSafeNonNegativeInteger(value.basePlaylistRevision) ||
    !Array.isArray(value.queueItemIds) ||
    value.queueItemIds.length > PLAYLIST_MAX_ITEMS ||
    value.queueItemIds.some(
      (queueItemId) => typeof queueItemId !== 'string' || !QUEUE_ITEM_UUID_RE.test(queueItemId),
    ) ||
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

function isAudioCandidate(name: string, mime: string): boolean {
  if (/^audio\//i.test(mime) || mime.toLowerCase() === 'application/ogg') return true;
  if (mime.toLowerCase() !== 'application/octet-stream') return false;
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  return DEVELOPER_AUDIO_EXTENSIONS.has(extension);
}

function parseMediaUpload(value: unknown): MediaUpload | null {
  if (
    !hasExactKeys(
      value,
      ['name', 'byteLength', 'mime'],
      ['sha256', 'title', 'artist', 'thumbnail'],
    ) ||
    !isSafeNonNegativeInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    value.byteLength > ASSET_MAX_BYTES ||
    typeof value.mime !== 'string' ||
    !MIME_RE.test(value.mime) ||
    (value.sha256 !== undefined &&
      (typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)))
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

const COMMAND_STATUSES: ReadonlySet<unknown> = new Set([
  'pending',
  'dispatched',
  'applied',
  'rejected',
  'expired',
]);
const COMMAND_RESULT_CODES: ReadonlySet<unknown> = new Set([
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

function validateCommandPayload(value: unknown, roomCode: string): JsonRecord | null {
  if (
    !hasExactKeys(
      value,
      ['schemaVersion', 'roomCode', 'commandId', 'status', 'createdAtMs', 'expiresAtMs'],
      ['completedAtMs', 'resultCode'],
    ) ||
    value.schemaVersion !== 1 ||
    value.roomCode !== roomCode ||
    typeof value.commandId !== 'string' ||
    !COMMAND_ID_RE.test(value.commandId) ||
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
    (value.resultCode === 'applied' ||
      value.resultCode === 'already_applied' ||
      value.resultCode === 'expired')
  ) {
    return null;
  }
  return value;
}

function validQueueItem(value: unknown): value is QueueItem {
  if (
    !hasExactKeys(
      value,
      ['queueItemId', 'kind', 'name', 'addedBy'],
      ['title', 'artist', 'thumbnail', 'byteLength', 'youtubeSubItemCount', 'youtubeEntrySubIndex'],
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
    if (value.youtubeSubItemCount !== undefined || value.youtubeEntrySubIndex !== undefined) {
      return false;
    }
    return isSafeNonNegativeInteger(value.byteLength) && value.byteLength > 0;
  }
  if (value.byteLength !== undefined) return false;
  const hasYouTubeManifestSummary =
    value.youtubeSubItemCount !== undefined || value.youtubeEntrySubIndex !== undefined;
  return (
    !hasYouTubeManifestSummary ||
    (isSafeNonNegativeInteger(value.youtubeSubItemCount) &&
      value.youtubeSubItemCount >= 1 &&
      value.youtubeSubItemCount <= YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS &&
      isSafeNonNegativeInteger(value.youtubeEntrySubIndex) &&
      value.youtubeEntrySubIndex < value.youtubeSubItemCount)
  );
}

function validateFacadePayload(
  value: unknown,
  expectedView: Projection,
  roomCode: string,
): JsonRecord | null {
  if (
    !isRecord(value) ||
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
      (value.status !== 'unactivated' &&
        value.status !== 'active' &&
        value.status !== 'suspended') ||
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
    const hasYoutubeIdentity =
      value.youtubeVideoId !== undefined || value.youtubeSubIndex !== undefined;
    const youtubeSubIndex = isSafeNonNegativeInteger(value.youtubeSubIndex)
      ? value.youtubeSubIndex
      : null;
    const youtubeIdentityIsPresent =
      typeof value.youtubeVideoId === 'string' &&
      /^[A-Za-z0-9_-]{11}$/u.test(value.youtubeVideoId) &&
      youtubeSubIndex !== null &&
      youtubeSubIndex <= YOUTUBE_PLAYBACK_SUB_INDEX_MAX;
    if (
      !hasExactKeys(
        value,
        [
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
        ],
        ['youtubeVideoId', 'youtubeSubIndex'],
      ) ||
      !isSafeNonNegativeInteger(value.revision) ||
      !isSafeNonNegativeInteger(value.playlistRevision) ||
      (value.state !== 'idle' && value.state !== 'playing' && value.state !== 'paused') ||
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
      (value.state !== 'idle' && (value.queueItemId === null || value.item === null)) ||
      (hasYoutubeIdentity && !youtubeIdentityIsPresent) ||
      (youtubeIdentityIsPresent && value.item?.kind !== 'youtube') ||
      (value.item?.kind === 'youtube' && !youtubeIdentityIsPresent) ||
      (youtubeIdentityIsPresent &&
        value.item?.youtubeSubItemCount !== undefined &&
        youtubeSubIndex !== null &&
        youtubeSubIndex >= value.item.youtubeSubItemCount)
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
      (value.repeatMode !== 'off' && value.repeatMode !== 'all' && value.repeatMode !== 'one') ||
      typeof value.shuffleEnabled !== 'boolean'
    ) {
      return null;
    }
    return value;
  }
  return null;
}

function validQuota(value: unknown): value is JsonRecord {
  return (
    hasExactKeys(value, ['limitBytes', 'perAssetLimitBytes', 'usedBytes', 'reservedBytes']) &&
    Object.values(value).every(isSafeNonNegativeInteger)
  );
}

function validUploadGenerationMetadata(headers: JsonRecord, roomGeneration: number): boolean {
  const value = headers['x-amz-meta-mxqr-generation'];
  return value === String(roomGeneration);
}

function validateUploadPayload(
  value: unknown,
  roomCode: string,
  roomGeneration: number,
  expectedMedia: MediaUpload,
): JsonRecord | null {
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
    typeof value.assetId !== 'string' ||
    !ASSET_ID_RE.test(value.assetId) ||
    typeof value.queueItemId !== 'string' ||
    !QUEUE_ITEM_UUID_RE.test(value.queueItemId) ||
    !isSafeNonNegativeInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    value.byteLength > ASSET_MAX_BYTES ||
    value.byteLength !== expectedMedia.byteLength ||
    !isSafeNonNegativeInteger(value.uploadExpiresAtMs) ||
    !isSafeNonNegativeInteger(value.completionExpiresAtMs) ||
    value.completionExpiresAtMs < value.uploadExpiresAtMs ||
    !validQuota(value.quota) ||
    !hasExactKeys(value.upload, ['method', 'url', 'headers']) ||
    value.upload.method !== 'PUT' ||
    typeof value.upload.url !== 'string'
  ) {
    return null;
  }
  let uploadUrl: URL;
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
    !isRecord(headers) ||
    Object.keys(headers).some((key) => !allowedHeaders.has(key)) ||
    headers['content-length'] !== String(value.byteLength) ||
    headers['x-amz-meta-mxqr-room'] !== roomCode ||
    !validUploadGenerationMetadata(headers, roomGeneration) ||
    headers['x-amz-meta-mxqr-asset'] !== value.assetId ||
    headers['x-amz-meta-mxqr-version'] !== '1' ||
    headers['x-amz-meta-mxqr-bytes'] !== String(value.byteLength) ||
    typeof headers['content-type'] !== 'string' ||
    !MIME_RE.test(headers['content-type']) ||
    headers['content-type'] !== expectedMedia.mime ||
    (headers['x-amz-meta-mxqr-sha256'] !== undefined &&
      (typeof headers['x-amz-meta-mxqr-sha256'] !== 'string' ||
        !SHA256_RE.test(headers['x-amz-meta-mxqr-sha256']))) ||
    (expectedMedia.sha256 === undefined
      ? headers['x-amz-meta-mxqr-sha256'] !== undefined
      : headers['x-amz-meta-mxqr-sha256'] !== expectedMedia.sha256)
  ) {
    return null;
  }
  return value;
}

function validateUploadCompletionPayload(
  value: unknown,
  roomCode: string,
  expectedAssetId: string,
): JsonRecord | null {
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
    typeof value.asset.assetId !== 'string' ||
    !ASSET_ID_RE.test(value.asset.assetId) ||
    value.asset.assetId !== expectedAssetId ||
    value.asset.version !== 1 ||
    !isSafeNonNegativeInteger(value.asset.byteLength) ||
    value.asset.byteLength <= 0 ||
    value.asset.byteLength > ASSET_MAX_BYTES ||
    value.asset.byteLength !== value.queueItem.byteLength ||
    typeof value.asset.mime !== 'string' ||
    !MIME_RE.test(value.asset.mime) ||
    (value.asset.sha256 !== undefined &&
      (typeof value.asset.sha256 !== 'string' || !SHA256_RE.test(value.asset.sha256)))
  ) {
    return null;
  }
  return value;
}

interface BaseApiRoute {
  roomCode: string;
  requiredScope: number;
}

type ApiRoute =
  | (BaseApiRoute & { kind: 'read'; view: Projection })
  | (BaseApiRoute & { kind: 'command-status'; commandId: string })
  | (BaseApiRoute & { kind: 'command-create' })
  | (BaseApiRoute & { kind: 'queue-add' })
  | (BaseApiRoute & { kind: 'queue-add-batch' })
  | (BaseApiRoute & { kind: 'media-create' })
  | (BaseApiRoute & { kind: 'media-complete'; assetId: string })
  | (BaseApiRoute & { kind: 'queue-clear' })
  | (BaseApiRoute & { kind: 'queue-clear-owned' })
  | (BaseApiRoute & { kind: 'queue-reorder' })
  | (BaseApiRoute & { kind: 'queue-remove'; queueItemId: string })
  | (BaseApiRoute & { kind: 'queue-mode-update' });

function parseRoute(method: string, url: URL): ApiRoute | null {
  if (method === 'GET') {
    const readMatch = url.pathname.match(
      /^\/v1\/rooms\/(0\d{5})(?:\/(playback|queue|effects|queue-mode))?$/,
    );
    const readRoomCode = readMatch?.[1];
    const readView = readMatch?.[2] ?? 'room';
    if (
      typeof readRoomCode === 'string' &&
      (readView === 'room' ||
        readView === 'playback' ||
        readView === 'queue' ||
        readView === 'effects' ||
        readView === 'queue-mode')
    ) {
      return {
        kind: 'read',
        roomCode: readRoomCode,
        view: readView,
        requiredScope:
          readView === 'room'
            ? SCOPE_ROOM_READ
            : readView === 'playback'
              ? SCOPE_PLAYBACK_READ
              : readView === 'queue'
                ? SCOPE_QUEUE_READ
                : readView === 'effects'
                  ? SCOPE_EFFECTS_READ
                  : SCOPE_PLAYBACK_READ,
      };
    }
    const statusMatch = url.pathname.match(
      /^\/v1\/rooms\/(0\d{5})\/commands\/(cmd_[A-Za-z0-9_-]{22})$/,
    );
    const statusRoomCode = statusMatch?.[1];
    const commandId = statusMatch?.[2];
    if (typeof statusRoomCode === 'string' && typeof commandId === 'string') {
      return {
        kind: 'command-status',
        roomCode: statusRoomCode,
        commandId,
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
    const createRoomCode = createMatch?.[1];
    if (typeof createRoomCode === 'string') {
      return {
        kind: 'command-create',
        roomCode: createRoomCode,
        // The command body selects playback:control or effects:control after
        // strict parsing. Do not force effect-only credentials to inherit
        // playback authority.
        requiredScope: 0,
      };
    }
    const queueItemMatch = url.pathname.match(/^\/v1\/rooms\/(0\d{5})\/queue\/items$/);
    const queueItemRoomCode = queueItemMatch?.[1];
    if (typeof queueItemRoomCode === 'string') {
      return {
        kind: 'queue-add',
        roomCode: queueItemRoomCode,
        requiredScope: SCOPE_QUEUE_WRITE,
      };
    }
    const queueBatchMatch = url.pathname.match(/^\/v1\/rooms\/(0\d{5})\/queue\/items\/batch$/);
    const queueBatchRoomCode = queueBatchMatch?.[1];
    if (typeof queueBatchRoomCode === 'string') {
      return {
        kind: 'queue-add-batch',
        roomCode: queueBatchRoomCode,
        requiredScope: SCOPE_QUEUE_WRITE,
      };
    }
    const completeMatch = url.pathname.match(
      /^\/v1\/rooms\/(0\d{5})\/media\/uploads\/([A-Za-z0-9][A-Za-z0-9_-]{15,127})\/complete$/,
    );
    const completeRoomCode = completeMatch?.[1];
    const assetId = completeMatch?.[2];
    if (typeof completeRoomCode === 'string' && typeof assetId === 'string') {
      return {
        kind: 'media-complete',
        roomCode: completeRoomCode,
        assetId,
        requiredScope: SCOPE_MEDIA_UPLOAD | SCOPE_QUEUE_WRITE,
      };
    }
    const uploadMatch = url.pathname.match(/^\/v1\/rooms\/(0\d{5})\/media\/uploads$/);
    const uploadRoomCode = uploadMatch?.[1];
    if (typeof uploadRoomCode === 'string') {
      return {
        kind: 'media-create',
        roomCode: uploadRoomCode,
        requiredScope: SCOPE_MEDIA_UPLOAD | SCOPE_QUEUE_WRITE,
      };
    }
    return null;
  }
  if (method === 'DELETE') {
    const clearMatch = url.pathname.match(/^\/v1\/rooms\/(0\d{5})\/queue\/items$/);
    const clearRoomCode = clearMatch?.[1];
    if (typeof clearRoomCode === 'string') {
      return {
        kind: 'queue-clear',
        roomCode: clearRoomCode,
        requiredScope: SCOPE_QUEUE_WRITE,
      };
    }
    const clearOwnedMatch = url.pathname.match(/^\/v1\/rooms\/(0\d{5})\/queue\/items\/owned$/);
    const clearOwnedRoomCode = clearOwnedMatch?.[1];
    if (typeof clearOwnedRoomCode === 'string') {
      return {
        kind: 'queue-clear-owned',
        roomCode: clearOwnedRoomCode,
        requiredScope: SCOPE_QUEUE_WRITE,
      };
    }
    const removeMatch = url.pathname.match(
      /^\/v1\/rooms\/(0\d{5})\/queue\/items\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
    );
    const removeRoomCode = removeMatch?.[1];
    const queueItemId = removeMatch?.[2];
    return typeof removeRoomCode === 'string' && typeof queueItemId === 'string'
      ? {
          kind: 'queue-remove',
          roomCode: removeRoomCode,
          queueItemId,
          requiredScope: SCOPE_QUEUE_WRITE,
        }
      : null;
  }
  if (method === 'PUT') {
    const queueModeMatch = url.pathname.match(/^\/v1\/rooms\/(0\d{5})\/queue-mode$/);
    const queueModeRoomCode = queueModeMatch?.[1];
    if (typeof queueModeRoomCode === 'string') {
      return {
        kind: 'queue-mode-update',
        roomCode: queueModeRoomCode,
        requiredScope: SCOPE_PLAYBACK_CONTROL,
      };
    }
    const orderMatch = url.pathname.match(/^\/v1\/rooms\/(0\d{5})\/queue\/order$/);
    const orderRoomCode = orderMatch?.[1];
    return typeof orderRoomCode === 'string'
      ? {
          kind: 'queue-reorder',
          roomCode: orderRoomCode,
          requiredScope: SCOPE_QUEUE_WRITE,
        }
      : null;
  }
  return null;
}

type RateOperation =
  | 'ingress-read'
  | 'authenticated-read'
  | 'authenticated-command'
  | 'authenticated-queue-write'
  | 'authenticated-media-upload-create'
  | 'authenticated-media-upload-complete';

async function callLimiter(
  env: DeveloperApiEnvPort,
  objectName: string,
  operation: RateOperation,
  keyId: string | null = null,
  roomGeneration: number | null = null,
): Promise<RateLimitResult | null> {
  const namespace = env.DEVELOPER_API_LIMITERS;
  if (!isDurableObjectNamespace(namespace)) return null;
  try {
    const stub = namespace.get(namespace.idFromName(objectName));
    if (!isFetcher(stub)) return null;
    const outcome = await fetchJsonLimited(
      () =>
        stub.fetch('https://developer-api-rate.internal/check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            operation,
            ...(keyId === null ? {} : { keyId }),
            ...(roomGeneration === null ? {} : proRoomGenerationWireFields(roomGeneration)),
          }),
        }),
      RATE_REQUEST_MAX_BYTES,
    );
    if (!outcome) return null;
    const { response, value } = outcome;
    if (
      response.status !== 200 ||
      !hasExactKeys(value, ['allowed', 'limit', 'remaining', 'resetAtMs', 'retryAfterSeconds']) ||
      typeof value.allowed !== 'boolean' ||
      !isSafeInteger(value.limit) ||
      !isSafeInteger(value.remaining) ||
      !isSafeInteger(value.resetAtMs) ||
      !isSafeInteger(value.retryAfterSeconds)
    ) {
      return null;
    }
    return {
      allowed: value.allowed,
      limit: value.limit,
      remaining: value.remaining,
      resetAtMs: value.resetAtMs,
      retryAfterSeconds: value.retryAfterSeconds,
    };
  } catch {
    return null;
  }
}

function rateHeaders(result: RateLimitResult): HeaderRecord {
  return {
    'ratelimit-limit': String(result.limit),
    'ratelimit-remaining': String(Math.max(0, result.remaining)),
    'ratelimit-reset': String(Math.max(0, Math.ceil((result.resetAtMs - Date.now()) / 1_000))),
  };
}

async function ingressLimit(
  request: Request,
  env: DeveloperApiEnvPort,
): Promise<RateLimitResult | null> {
  const secret = String(env.MXQR_DEVELOPER_API_RATE_SECRET || '');
  if (secret.length < 32) return null;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const ipHash = await hmacBase64Url(secret, `developer-api-ingress:v1\u0000${ip}`);
  return callLimiter(env, `ingress:${ipHash}`, 'ingress-read');
}

async function authenticatedReadLimit(
  env: DeveloperApiEnvPort,
  principal: DeveloperApiPrincipal,
): Promise<RateLimitResult | null> {
  return callLimiter(
    env,
    `room:${proRoomObjectName(principal.roomCode, principal.roomGeneration)}`,
    'authenticated-read',
    principal.keyId,
    principal.roomGeneration,
  );
}

async function authenticatedCommandLimit(
  env: DeveloperApiEnvPort,
  principal: DeveloperApiPrincipal,
): Promise<RateLimitResult | null> {
  return callLimiter(
    env,
    `room:${proRoomObjectName(principal.roomCode, principal.roomGeneration)}`,
    'authenticated-command',
    principal.keyId,
    principal.roomGeneration,
  );
}

async function authenticatedQueueWriteLimit(
  env: DeveloperApiEnvPort,
  principal: DeveloperApiPrincipal,
): Promise<RateLimitResult | null> {
  return callLimiter(
    env,
    `room:${proRoomObjectName(principal.roomCode, principal.roomGeneration)}`,
    'authenticated-queue-write',
    principal.keyId,
    principal.roomGeneration,
  );
}

async function authenticatedMediaUploadCreateLimit(
  env: DeveloperApiEnvPort,
  principal: DeveloperApiPrincipal,
): Promise<RateLimitResult | null> {
  return callLimiter(
    env,
    `room:${proRoomObjectName(principal.roomCode, principal.roomGeneration)}`,
    'authenticated-media-upload-create',
    principal.keyId,
    principal.roomGeneration,
  );
}

async function authenticatedMediaUploadCompleteLimit(
  env: DeveloperApiEnvPort,
  principal: DeveloperApiPrincipal,
): Promise<RateLimitResult | null> {
  return callLimiter(
    env,
    `room:${proRoomObjectName(principal.roomCode, principal.roomGeneration)}`,
    'authenticated-media-upload-complete',
    principal.keyId,
    principal.roomGeneration,
  );
}

function facadeGenerationHeaders(roomGeneration: number): HeaderRecord {
  return {
    'content-type': 'application/json',
    [PRO_ROOM_GENERATION_HEADER]: proRoomGenerationHeaderValue(roomGeneration),
  };
}

function facadeAuthorityBody(
  roomGeneration: number,
  developerAuthorityEpoch: number,
): { roomGeneration: number; developerAuthorityEpoch: number } {
  if (!isSafeNonNegativeInteger(developerAuthorityEpoch)) {
    throw new Error('Invalid Developer API authority epoch');
  }
  return { roomGeneration, developerAuthorityEpoch };
}

interface FacadeCallResult {
  configurationError?: true;
  backendError?: true;
  invalidResponse?: true;
  notFound?: true;
  errorCode?: DeveloperApiErrorCode;
  status?: number;
  payload?: JsonRecord;
  facadeWorkerVersionId?: string;
}

async function facadeRead(
  env: DeveloperApiEnvPort,
  route: Extract<ApiRoute, { kind: 'read' }>,
  principal: DeveloperApiPrincipal,
  effectsVersion: number,
): Promise<FacadeCallResult> {
  const facade = env.DEVELOPER_API_FACADE;
  if (!isFetcher(facade)) return { configurationError: true };
  try {
    const outcome = await fetchJsonLimited(
      () =>
        facade.fetch('https://developer-api-facade.internal/internal/v1/read', {
          method: 'POST',
          headers: facadeGenerationHeaders(principal.roomGeneration),
          body: JSON.stringify({
            roomCode: route.roomCode,
            ...facadeAuthorityBody(principal.roomGeneration, principal.developerAuthorityEpoch),
            keyId: principal.keyId,
            projection: route.view,
            ...(route.view === 'effects' ? { effectsVersion } : {}),
          }),
        }),
      FACADE_RESPONSE_MAX_BYTES,
    );
    if (!outcome) return { backendError: true };
    const { response, value } = outcome;
    const facadeWorkerVersionId = response.headers.get(DEVELOPER_API_FACADE_VERSION_HEADER) || '';
    if (!response.ok) {
      if (response.status === 404) return { notFound: true };
      if (
        hasExactKeys(value, ['error']) &&
        value.error === 'DEVELOPER_API_AUTHORITY_STALE' &&
        response.status === COMMAND_ERROR_STATUSES.DEVELOPER_API_AUTHORITY_STALE
      ) {
        return { errorCode: value.error, status: response.status };
      }
      return { backendError: true };
    }
    const payload = validateFacadePayload(value, route.view, route.roomCode);
    return payload ? { payload, facadeWorkerVersionId } : { invalidResponse: true };
  } catch {
    return { backendError: true };
  }
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
  DEVELOPER_API_AUTHORITY_STALE: 409,
});

type CommandErrorCode = keyof typeof COMMAND_ERROR_STATUSES;

function isCommandErrorCode(value: unknown): value is CommandErrorCode {
  return typeof value === 'string' && Object.hasOwn(COMMAND_ERROR_STATUSES, value);
}

async function facadeCommand(
  env: DeveloperApiEnvPort,
  path: string,
  body: JsonRecord,
  roomCode: string,
  roomGeneration: number,
  developerAuthorityEpoch: number,
): Promise<FacadeCallResult> {
  const facade = env.DEVELOPER_API_FACADE;
  if (!isFetcher(facade)) return { configurationError: true };
  try {
    const outcome = await fetchJsonLimited(
      () =>
        facade.fetch(`https://developer-api-facade.internal${path}`, {
          method: 'POST',
          headers: facadeGenerationHeaders(roomGeneration),
          body: JSON.stringify({
            ...body,
            ...facadeAuthorityBody(roomGeneration, developerAuthorityEpoch),
          }),
        }),
      COMMAND_RESPONSE_MAX_BYTES,
    );
    if (!outcome) return { backendError: true };
    const { response, value } = outcome;
    if (!response.ok) {
      if (
        hasExactKeys(value, ['error']) &&
        isCommandErrorCode(value.error) &&
        COMMAND_ERROR_STATUSES[value.error] === response.status
      ) {
        return { errorCode: value.error, status: response.status };
      }
      return { backendError: true };
    }
    const payload = validateCommandPayload(value, roomCode);
    return payload ? { payload, status: response.status } : { invalidResponse: true };
  } catch {
    return { backendError: true };
  }
}

async function facadeMutation(
  env: DeveloperApiEnvPort,
  path: string,
  body: JsonRecord,
  roomCode: string,
  roomGeneration: number,
  developerAuthorityEpoch: number,
  expectedStatus: number,
  validator: (value: unknown, roomCode: string) => JsonRecord | null,
): Promise<FacadeCallResult> {
  const facade = env.DEVELOPER_API_FACADE;
  if (!isFetcher(facade)) return { configurationError: true };
  try {
    const outcome = await fetchJsonLimited(
      () =>
        facade.fetch(`https://developer-api-facade.internal${path}`, {
          method: 'POST',
          headers: facadeGenerationHeaders(roomGeneration),
          body: JSON.stringify({
            ...body,
            ...facadeAuthorityBody(roomGeneration, developerAuthorityEpoch),
          }),
        }),
      MUTATION_RESPONSE_MAX_BYTES,
    );
    if (!outcome) return { backendError: true };
    const { response, value } = outcome;
    if (!response.ok) {
      if (
        hasExactKeys(value, ['error']) &&
        isCommandErrorCode(value.error) &&
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
  } catch {
    return { backendError: true };
  }
}

function auditCommandBestEffort(
  env: DeveloperApiEnvPort,
  context: WaitUntilContextPort,
  requestId: string,
  principal: DeveloperApiPrincipal,
  commandType: DeveloperCommand['type'],
  result: string,
  statusCode: number,
  nowMs: number,
): void {
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
  env: DeveloperApiEnvPort,
  context: WaitUntilContextPort,
  requestId: string,
  principal: DeveloperApiPrincipal,
  action: string,
  result: string,
  statusCode: number,
  nowMs: number,
): void {
  const database = developerApiDatabase(env);
  if (!context.waitUntil || !database) return;
  const audit = database
    .prepare(
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

async function etagFor(view: Projection, payload: JsonRecord): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(payload))),
  );
  return `"mxqr-${view}-${base64UrlEncode(digest)}"`;
}

function ifNoneMatchMatches(value: string, currentEtag: string): boolean {
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

function readIdempotencyKey(request: Request): string | null {
  const value = request.headers.get('idempotency-key');
  return value !== null && IDEMPOTENCY_KEY_RE.test(value) ? value : null;
}

async function handleApiRequest(
  request: Request,
  env: DeveloperApiEnvPort,
  context: WaitUntilContextPort,
  requestId: string,
): Promise<Response> {
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

    let path: string;
    let body: JsonRecord;
    let expectedStatus: number;
    let validator: (value: unknown, roomCode: string) => JsonRecord | null;
    let auditAction: string;
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
      principal.developerAuthorityEpoch,
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
    if (facade.errorCode && typeof facade.status === 'number') {
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
      principal.developerAuthorityEpoch,
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
    if (facade.errorCode && typeof facade.status === 'number') {
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
      principal.developerAuthorityEpoch,
    );
    if (facade.configurationError) {
      return errorResponse('API_NOT_CONFIGURED', 503, requestId, { retryable: true });
    }
    if (facade.errorCode && typeof facade.status === 'number') {
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
  if (facade.errorCode && typeof facade.status === 'number') {
    return errorResponse(facade.errorCode, facade.status, requestId);
  }
  if (facade.notFound) return errorResponse('NOT_FOUND', 404, requestId);
  if (facade.backendError) {
    return errorResponse('BACKEND_UNAVAILABLE', 503, requestId, { retryable: true });
  }
  if (!facade.payload) {
    return errorResponse('INTERNAL_RESPONSE_INVALID', 503, requestId, { retryable: true });
  }

  const etag = await etagFor(route.view, facade.payload);
  const representationHeaders: HeaderRecord =
    route.view === 'effects' ? { vary: 'X-MXQR-Effects-Version' } : {};
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch !== null && encoder.encode(ifNoneMatch).byteLength > ETAG_HEADER_MAX_BYTES) {
    return errorResponse('NOT_FOUND', 404, requestId);
  }
  const versionHeaders = dataPlaneVersionHeaders(env, facade.facadeWorkerVersionId);
  if (ifNoneMatch !== null && ifNoneMatchMatches(ifNoneMatch, etag)) {
    return emptyResponse(304, requestId, {
      ...limiterHeaders,
      ...representationHeaders,
      ...versionHeaders,
      etag,
    });
  }
  return jsonResponse(
    facade.payload,
    200,
    requestId,
    { ...limiterHeaders, ...representationHeaders, ...versionHeaders, etag },
    'private, no-cache',
  );
}

const developerApiWorker = {
  async fetch(
    request: Request,
    env: DeveloperApiEnvPort,
    context: WaitUntilContextPort = {},
  ): Promise<Response> {
    const requestId = randomRequestId();
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health' && !url.search && !url.hash) {
      const metadata = env.CF_VERSION_METADATA;
      const workerVersionId = isRecord(metadata) ? metadata.id : undefined;
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
    const maintenanceResponse = await gateServiceMaintenance(request, env, { format: 'json' });
    if (maintenanceResponse) return maintenanceResponse;
    try {
      return await handleApiRequest(request, env, context, requestId);
    } catch {
      return errorResponse('BACKEND_UNAVAILABLE', 503, requestId, { retryable: true });
    }
  },

  scheduled(
    controller: unknown,
    env: DeveloperApiEnvPort,
    context: RequiredWaitUntilContextPort,
  ): void {
    const scheduledTime = Number(isRecord(controller) ? controller.scheduledTime : undefined);
    const nowMs = isSafeNonNegativeInteger(scheduledTime) ? scheduledTime : Date.now();
    context.waitUntil(
      (async () => {
        if ((await readServiceMaintenance(env)).enabled) return;
        await expireDeveloperApiKeys(env, nowMs);
      })(),
    );
  },
} satisfies PortableDeveloperApiHandler;

export default developerApiWorker;

async function readRateRequest(request: Request): Promise<unknown | null> {
  if (
    request.method !== 'POST' ||
    new URL(request.url).pathname !== '/check' ||
    !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '') ||
    !request.body
  ) {
    return null;
  }
  return readRequestJsonLimited(request, RATE_REQUEST_MAX_BYTES, DEPENDENCY_RESPONSE_TIMEOUT_MS);
}

function rateBucketsForRequest(value: unknown): RateBucketRequest[] | null {
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

function exactInternalRoomGeneration(
  request: Request,
  value: unknown,
): { valid: true; roomGeneration: number } | { valid: false; roomGeneration: number | null } {
  const header = request.headers.get(PRO_ROOM_GENERATION_HEADER);
  const roomGeneration = /^(?:0|[1-9]\d*)$/.test(header || '') ? Number(header) : null;
  return isProRoomGeneration(roomGeneration) &&
    isRecord(value) &&
    value.roomGeneration === roomGeneration
    ? { valid: true, roomGeneration }
    : { valid: false, roomGeneration };
}

export class DeveloperApiRateLimiter {
  private readonly storage: DurableObjectStoragePort;
  private readonly env: DeveloperApiEnvPort;
  private mutationTail: Promise<unknown>;

  constructor(state: DurableObjectStatePort, env: DeveloperApiEnvPort = {}) {
    this.storage = state.storage;
    this.env = env;
    this.mutationTail = Promise.resolve();
  }

  private enqueueMutation<T>(task: (reason?: unknown) => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(task, task);
    this.mutationTail = run.catch(() => {});
    return run;
  }

  fetch(request: Request): Promise<Response> {
    return this.enqueueMutation(async () => {
      const maintenanceResponse = await gateServiceMaintenance(request, this.env, {
        format: 'json',
      });
      return maintenanceResponse || this.handleFetch(request);
    });
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/internal/admin/v1/decommission') {
      const value = await readRequestJsonLimited(request, 1024);
      const generation = exactInternalRoomGeneration(request, value);
      if (
        request.method !== 'POST' ||
        !hasExactKeys(value, ['roomCode', 'roomGeneration', 'requestId']) ||
        typeof value.roomCode !== 'string' ||
        !ROOM_CODE_RE.test(value.roomCode) ||
        request.headers.get('x-mxqr-pro-room-code') !== value.roomCode ||
        !generation.valid ||
        typeof value.requestId !== 'string' ||
        !DECOMMISSION_REQUEST_ID_RE.test(value.requestId)
      ) {
        return Response.json({ error: 'INVALID_REQUEST' }, { status: 400 });
      }
      const storedIdentity = await this.storage.get('roomIdentity');
      const storedGeneration = isRecord(storedIdentity) ? storedIdentity.roomGeneration : undefined;
      if (
        storedIdentity &&
        (!isProRoomGeneration(storedGeneration) || storedGeneration !== generation.roomGeneration)
      ) {
        return Response.json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, { status: 410 });
      }
      // Commit the permanent denial before clearing rate state. In particular,
      // an idempotent deletion retry must never erase an existing tombstone
      // before a fallible write can restore it.
      await this.storage.put('decommissioned', {
        v: 1,
        roomCode: value.roomCode,
        ...proRoomGenerationWireFields(generation.roomGeneration),
        requestId: value.requestId,
        decommissionedAtMs: Date.now(),
      });
      if (typeof this.storage.delete !== 'function') {
        throw new Error('Rate limiter storage cleanup unavailable');
      }
      await this.storage.delete('buckets');
      await this.storage.delete('roomIdentity');
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
    if (!requested || !isRecord(body)) {
      return Response.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    const authenticatedRoomGeneration =
      body.operation === 'ingress-read' && body.roomGeneration === undefined
        ? null
        : isProRoomGeneration(body.roomGeneration)
          ? body.roomGeneration
          : null;
    if (authenticatedRoomGeneration !== null) {
      const storedIdentity = await this.storage.get('roomIdentity');
      const storedGeneration = isRecord(storedIdentity) ? storedIdentity.roomGeneration : undefined;
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
    const storedValue = await this.storage.get('buckets');
    const stored: JsonRecord = isRecord(storedValue) ? storedValue : {};
    for (const [id, bucket] of Object.entries(stored)) {
      if (
        !isRecord(bucket) ||
        !isSafeNonNegativeInteger(bucket.resetAtMs) ||
        bucket.resetAtMs <= nowMs
      ) {
        delete stored[id];
      }
    }
    const evaluated: EvaluatedRateBucket[] = requested.map((requestBucket) => {
      const windowStartMs = Math.floor(nowMs / requestBucket.windowMs) * requestBucket.windowMs;
      const resetAtMs = windowStartMs + requestBucket.windowMs;
      const current = stored[requestBucket.id];
      const count =
        isRecord(current) &&
        current.windowStartMs === windowStartMs &&
        current.limit === requestBucket.limit &&
        isSafeNonNegativeInteger(current.count)
          ? current.count
          : 0;
      return { ...requestBucket, windowStartMs, resetAtMs, count };
    });
    const blocked = evaluated.filter((bucket) => bucket.count + bucket.cost > bucket.limit);
    if (blocked.length > 0) {
      const retryAtMs = Math.max(...blocked.map((bucket) => bucket.resetAtMs));
      const narrowest = blocked.sort((left, right) => left.limit - right.limit)[0];
      if (!narrowest) {
        return Response.json({ error: 'RATE_STATE_INVALID' }, { status: 503 });
      }
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
    if (!narrowest) {
      return Response.json({ error: 'RATE_STATE_INVALID' }, { status: 503 });
    }
    return Response.json({
      allowed: true,
      limit: narrowest.limit,
      remaining: Math.max(0, narrowest.limit - narrowest.count - narrowest.cost),
      resetAtMs: narrowest.resetAtMs,
      retryAfterSeconds: 0,
    });
  }

  alarm(): Promise<void> {
    return this.enqueueMutation(async () => {
      if ((await readServiceMaintenance(this.env)).enabled) {
        if (typeof this.storage.setAlarm === 'function') {
          await this.storage.setAlarm(Date.now() + 60_000);
        }
        return;
      }
      await this.handleAlarm();
    });
  }

  private async handleAlarm(): Promise<void> {
    if (await this.storage.get('decommissioned')) {
      if (typeof this.storage.delete === 'function') await this.storage.delete('buckets');
      if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
      return;
    }
    const nowMs = Date.now();
    const storedValue = await this.storage.get('buckets');
    const stored: JsonRecord = isRecord(storedValue) ? storedValue : {};
    for (const [id, bucket] of Object.entries(stored)) {
      if (
        !isRecord(bucket) ||
        !isSafeNonNegativeInteger(bucket.resetAtMs) ||
        bucket.resetAtMs <= nowMs
      ) {
        delete stored[id];
      }
    }
    const remaining = Object.values(stored).filter(
      (bucket): bucket is StoredRateBucket =>
        isRecord(bucket) &&
        isSafeNonNegativeInteger(bucket.limit) &&
        isSafeNonNegativeInteger(bucket.count) &&
        isSafeNonNegativeInteger(bucket.windowStartMs) &&
        isSafeNonNegativeInteger(bucket.resetAtMs),
    );
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

export function isDeveloperApiRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_RE.test(value);
}
