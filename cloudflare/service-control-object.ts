import { readBodyBytesLimited } from './pro-room-body.ts';
import { hasExactKeys } from './pro-room-validation.ts';
import {
  ABUSE_RATE_CONSUME_PATH,
  ABUSE_RATE_IDEMPOTENT_CONSUME_PATH,
  ABUSE_RATE_PAIR_CONSUME_PATH,
  ABUSE_RATE_RESPONSE_PROTOCOL,
  ABUSE_RATE_RESPONSE_PROTOCOL_HEADER,
  ABUSE_RATE_RESPONSE_RESULT_HEADER,
  ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME,
  ADMIN_ANNOUNCEMENT_MIGRATION_HEADER,
  ADMIN_ANNOUNCEMENT_STATE_PATH,
  ADMIN_ANNOUNCEMENT_STATUS_PATH,
  SERVICE_CONTROL_STATE_PATH,
  SERVICE_CONTROL_STATUS_ACTIVATED_AT_HEADER,
  SERVICE_CONTROL_STATUS_ENABLED_HEADER,
  SERVICE_CONTROL_STATUS_PATH,
  SERVICE_CONTROL_STATUS_REVISION_HEADER,
  SERVICE_CONTROL_STATUS_UPDATED_AT_HEADER,
  SERVICE_CONTROL_STATUS_VERSION_HEADER,
  normalizeServiceMaintenanceState,
} from './service-maintenance.ts';

/**
 * Global service-control Durable Object.
 *
 * Object-name prefixes isolate maintenance, admin-announcement, and abuse-rate
 * records while preserving the single Cloudflare class binding and migration.
 */

const INTERNAL_REQUEST_BODY_TIMEOUT_MS = 2_000;
const SERVICE_CONTROL_STATE_KEY = 'service-maintenance-state';
const SERVICE_CONTROL_REQUESTS_KEY = 'service-maintenance-requests';
const SERVICE_CONTROL_REQUEST_HISTORY_LIMIT = 64;
const SERVICE_CONTROL_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
// Keep these in lockstep with service-maintenance.ts. Named abuse-rate
// Durable Objects own only their counter state, so loading unrelated global
// maintenance and announcement records on every cold start is unnecessary.
const ABUSE_RATE_OBJECT_NAME_PREFIX = 'musixquare-abuse-rate-v1:';
const ABUSE_RATE_PAIR_OBJECT_NAME_PREFIX = 'musixquare-abuse-rate-pair-v1:';
const ABUSE_RATE_STATE_KEY = 'abuse-rate-state-v1';
const ABUSE_RATE_PAIR_STATE_KEY = 'abuse-rate-pair-state-v1';
const ABUSE_RATE_REQUEST_MAX_BYTES = 1024;
const ABUSE_RATE_RESPONSE_RESULT_MAX_LENGTH = 2_048;
const ABUSE_RATE_OPERATION_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;
const ABUSE_RATE_OPERATION_HISTORY_LIMIT = 1024;
const ABUSE_RATE_PAIR_PRIMARY_LIMIT = 1024;
const ADMIN_ANNOUNCEMENT_STATE_KEY = 'admin-announcement-state';
const ADMIN_ANNOUNCEMENT_REQUESTS_KEY = 'admin-announcement-requests';
const ADMIN_ANNOUNCEMENT_HISTORY_LIMIT = 100;
const ADMIN_ANNOUNCEMENT_CONTROL_MAX_BYTES = 256 * 1024;
const ADMIN_ANNOUNCEMENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

type UnknownRecord = Record<string, unknown>;

interface ServiceControlStatePort {
  storage: object;
  id?: { name?: string };
  blockConcurrencyWhile?: (callback: () => Promise<void>) => Promise<void>;
}

interface StoredServiceControlState {
  enabled: boolean;
  revision: number;
  updatedAt: number | null;
  activatedAt: number | null;
}

interface ServiceControlRequestRecord {
  requestId: string;
  enabled: boolean;
  state: StoredServiceControlState;
}

type AdminAnnouncementAction = 'published' | 'disabled' | 'cleared';

interface AdminAnnouncement {
  id: string;
  message: string;
  enabled: boolean;
  expiresAt: string | null;
  updatedAt: string;
}

interface AdminAnnouncementHistoryEntry extends AdminAnnouncement {
  action: AdminAnnouncementAction;
}

interface AdminAnnouncementState {
  revision: number;
  announcement: AdminAnnouncement;
  history: AdminAnnouncementHistoryEntry[];
}

interface AdminAnnouncementRequestRecord {
  requestId: string;
  message: string;
  enabled: boolean;
  expiresAt: string | null;
  revision: number;
}

interface AbuseRateState {
  v: 2;
  limit: number;
  windowMs: number;
  windowStartMs: number;
  resetAtMs: number;
  count: number;
  operationIds: string[];
}

interface AbuseRatePairCounter {
  limit: number;
  count: number;
}

interface AbuseRatePairSecondary extends AbuseRatePairCounter {
  identity: string;
}

interface AbuseRatePairState {
  v: 1;
  windowMs: number;
  windowStartMs: number;
  resetAtMs: number;
  primary: AbuseRatePairCounter;
  secondaries: AbuseRatePairSecondary[];
}

interface AbuseRateProjection {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtMs: number;
  retryAfterSeconds: number;
}

type PrivateJsonBodyResult =
  | { value: unknown }
  | { error: 'REQUEST_TOO_LARGE' | 'REQUEST_TIMEOUT' | 'INVALID_JSON'; status: 400 | 408 | 413 };

interface AbuseRateConsumeBody {
  limit: number;
  windowMs: number;
  cost: number;
  operationId: string | null;
}

interface AbuseRatePairConsumeBase {
  limit: number;
  windowMs: number;
  cost: number;
}

type AbuseRatePairConsumeBody = AbuseRatePairConsumeBase &
  (
    | { secondaryIdentity: null; secondaryLimit: null; secondaryCost: null }
    | { secondaryIdentity: string; secondaryLimit: number; secondaryCost: number }
  );

interface ServiceMaintenanceMutationBody {
  enabled: boolean;
  expectedRevision: number;
  requestId: string;
}

interface AdminAnnouncementMutationBody {
  message: string;
  enabled: boolean;
  expiresAt: string | null;
  expectedRevision: number;
  requestId: string;
  baseHistory: AdminAnnouncementHistoryEntry[];
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function hasExactKeySet(value: UnknownRecord, required: readonly string[]): boolean {
  return hasExactKeys(value, required);
}

function storageMethod(storage: object, methodName: string): (...args: unknown[]) => unknown {
  const method = Reflect.get(storage, methodName);
  if (typeof method !== 'function') {
    throw new TypeError(`Service-control storage ${methodName}() is unavailable`);
  }
  return (...args: unknown[]): unknown => Reflect.apply(method, storage, args);
}

async function storageGet(storage: object, key: string): Promise<unknown> {
  return storageMethod(storage, 'get')(key);
}

async function storagePut(
  storage: object,
  keyOrEntries: string | Record<string, unknown>,
  value?: unknown,
): Promise<void> {
  if (typeof keyOrEntries === 'string') {
    await storageMethod(storage, 'put')(keyOrEntries, value);
    return;
  }
  await storageMethod(storage, 'put')(keyOrEntries);
}

async function storageDelete(storage: object, key: string): Promise<void> {
  await storageMethod(storage, 'delete')(key);
}

function optionalStorageMethod(
  storage: object,
  methodName: string,
): ((...args: unknown[]) => unknown) | null {
  const method = Reflect.get(storage, methodName);
  return typeof method === 'function'
    ? (...args: unknown[]): unknown => Reflect.apply(method, storage, args)
    : null;
}

async function readPrivateJsonBody(
  request: Request,
  maxBytes: number,
): Promise<PrivateJsonBodyResult> {
  const bounded = await readBodyBytesLimited(request, maxBytes, INTERNAL_REQUEST_BODY_TIMEOUT_MS);
  if ('error' in bounded && bounded.error === 'too-large') {
    return { error: 'REQUEST_TOO_LARGE', status: 413 };
  }
  if ('error' in bounded && (bounded.error === 'timeout' || bounded.error === 'aborted')) {
    return { error: 'REQUEST_TIMEOUT', status: 408 };
  }
  if (
    'error' in bounded ||
    !(bounded.body instanceof Uint8Array) ||
    bounded.body.byteLength === 0
  ) {
    return { error: 'INVALID_JSON', status: 400 };
  }
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bounded.body),
    );
    return { value };
  } catch {
    return { error: 'INVALID_JSON', status: 400 };
  }
}

function initialServiceControlState(): StoredServiceControlState {
  return {
    enabled: false,
    revision: 0,
    updatedAt: null,
    activatedAt: null,
  };
}

function canonicalServiceControlState(value: unknown): StoredServiceControlState | null {
  const normalized = normalizeServiceMaintenanceState(value);
  if (!normalized) return null;
  return {
    enabled: normalized.enabled,
    revision: normalized.revision,
    updatedAt: normalized.updatedAt,
    activatedAt: normalized.activatedAt,
  };
}

function publicServiceControlState(state: unknown) {
  return (
    normalizeServiceMaintenanceState(state) ||
    normalizeServiceMaintenanceState(initialServiceControlState())
  );
}

function normalizeServiceControlRequests(value: unknown): ServiceControlRequestRecord[] {
  if (!Array.isArray(value)) return [];
  const requests: ServiceControlRequestRecord[] = [];
  for (const entry of value) {
    if (!isUnknownRecord(entry)) continue;
    const state = canonicalServiceControlState(entry.state);
    if (
      !SERVICE_CONTROL_REQUEST_ID_RE.test(String(entry.requestId || '')) ||
      typeof entry.enabled !== 'boolean' ||
      !state
    ) {
      continue;
    }
    requests.push({ requestId: String(entry.requestId), enabled: entry.enabled, state });
    if (requests.length === SERVICE_CONTROL_REQUEST_HISTORY_LIMIT) break;
  }
  return requests;
}

function serviceControlJson(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function abuseRateResponse(request: Request, body: unknown, status: number = 200): Response {
  if (request.headers.get(ABUSE_RATE_RESPONSE_PROTOCOL_HEADER) !== ABUSE_RATE_RESPONSE_PROTOCOL) {
    return serviceControlJson(body, status);
  }
  const headers = new Headers({
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    [ABUSE_RATE_RESPONSE_PROTOCOL_HEADER]: ABUSE_RATE_RESPONSE_PROTOCOL,
  });
  if (status >= 200 && status < 300) {
    const encoded = JSON.stringify(body);
    if (encoded.length > ABUSE_RATE_RESPONSE_RESULT_MAX_LENGTH) {
      return new Response(null, { status: 503, headers });
    }
    headers.set(ABUSE_RATE_RESPONSE_RESULT_HEADER, encoded);
  }
  return new Response(null, { status, headers });
}

function serviceControlStatusHeaders(state: StoredServiceControlState): Record<string, string> {
  return {
    [SERVICE_CONTROL_STATUS_VERSION_HEADER]: '1',
    [SERVICE_CONTROL_STATUS_ENABLED_HEADER]: state.enabled ? '1' : '0',
    [SERVICE_CONTROL_STATUS_REVISION_HEADER]: String(state.revision),
    [SERVICE_CONTROL_STATUS_UPDATED_AT_HEADER]:
      state.updatedAt === null ? 'null' : String(state.updatedAt),
    [SERVICE_CONTROL_STATUS_ACTIVATED_AT_HEADER]:
      state.activatedAt === null ? 'null' : String(state.activatedAt),
  };
}

function emptyAdminAnnouncement(): AdminAnnouncement {
  return {
    id: '',
    message: '',
    enabled: false,
    expiresAt: null,
    updatedAt: '',
  };
}

function initialAdminAnnouncementState(): AdminAnnouncementState {
  return {
    revision: 0,
    announcement: emptyAdminAnnouncement(),
    history: [],
  };
}

function normalizedAdminAnnouncement(
  value: unknown,
  options: { history: true; allowEmpty?: boolean },
): AdminAnnouncementHistoryEntry | null;
function normalizedAdminAnnouncement(
  value: unknown,
  options?: { allowEmpty?: boolean; history?: false },
): AdminAnnouncement | null;
function normalizedAdminAnnouncement(
  value: unknown,
  { allowEmpty = false, history = false }: { allowEmpty?: boolean; history?: boolean } = {},
): AdminAnnouncement | AdminAnnouncementHistoryEntry | null {
  if (!isUnknownRecord(value)) return null;
  const message = typeof value.message === 'string' ? value.message.trim() : '';
  if (message.length > 280) return null;
  const id = typeof value.id === 'string' ? value.id : '';
  const updatedAtInput = typeof value.updatedAt === 'string' ? value.updatedAt : '';
  const updatedAtMs = new Date(updatedAtInput).getTime();
  if ((!allowEmpty || id) && (!ADMIN_ANNOUNCEMENT_ID_RE.test(id) || Number.isNaN(updatedAtMs))) {
    return null;
  }
  if (
    allowEmpty &&
    !id &&
    (message || updatedAtInput || value.enabled === true || value.expiresAt !== null)
  ) {
    return null;
  }
  let expiresAt = null;
  if (value.expiresAt !== null && value.expiresAt !== undefined && value.expiresAt !== '') {
    if (typeof value.expiresAt !== 'string' && typeof value.expiresAt !== 'number') return null;
    const expiresAtMs = new Date(value.expiresAt).getTime();
    if (Number.isNaN(expiresAtMs)) return null;
    expiresAt = new Date(expiresAtMs).toISOString();
  }
  const announcement = {
    id,
    message,
    enabled: value.enabled === true && Boolean(message),
    expiresAt,
    updatedAt: id ? new Date(updatedAtMs).toISOString() : '',
  };
  if (!history) return announcement;
  if (typeof value.action !== 'string' || !isAdminAnnouncementAction(value.action)) {
    return null;
  }
  if (value.action !== adminAnnouncementAction(announcement)) {
    return null;
  }
  return { ...announcement, action: value.action };
}

function normalizedAdminAnnouncementHistory(
  value: unknown,
): AdminAnnouncementHistoryEntry[] | null {
  if (!Array.isArray(value)) return null;
  const history: AdminAnnouncementHistoryEntry[] = [];
  for (const entry of value) {
    const normalized = normalizedAdminAnnouncement(entry, { history: true });
    if (!normalized) return null;
    history.push(normalized);
  }
  return history;
}

function canonicalAdminAnnouncementState(value: unknown): AdminAnnouncementState | null {
  if (
    !isUnknownRecord(value) ||
    !isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.history) ||
    value.history.length > ADMIN_ANNOUNCEMENT_HISTORY_LIMIT
  ) {
    return null;
  }
  const announcement = normalizedAdminAnnouncement(value.announcement, { allowEmpty: true });
  const history: AdminAnnouncementHistoryEntry[] = [];
  for (const entry of value.history) {
    const normalized = normalizedAdminAnnouncement(entry, { history: true });
    if (!normalized) return null;
    history.push(normalized);
  }
  if (!announcement) return null;
  if (value.revision === 0 && (announcement.id || history.length > 0)) return null;
  if (
    value.revision > 0 &&
    (!announcement.id ||
      history.length === 0 ||
      !adminAnnouncementHistoryMatches(announcement, history[0]))
  ) {
    return null;
  }
  return { revision: value.revision, announcement, history };
}

function normalizeAdminAnnouncementRequests(value: unknown): AdminAnnouncementRequestRecord[] {
  if (!Array.isArray(value)) return [];
  const requests: AdminAnnouncementRequestRecord[] = [];
  for (const entry of value) {
    if (
      !isUnknownRecord(entry) ||
      !SERVICE_CONTROL_REQUEST_ID_RE.test(String(entry.requestId || '')) ||
      typeof entry.message !== 'string' ||
      entry.message.length > 280 ||
      typeof entry.enabled !== 'boolean' ||
      (entry.expiresAt !== null &&
        (typeof entry.expiresAt !== 'string' ||
          Number.isNaN(new Date(entry.expiresAt).getTime()))) ||
      !isSafeInteger(entry.revision) ||
      entry.revision <= 0
    ) {
      continue;
    }
    requests.push({
      requestId: String(entry.requestId),
      message: entry.message,
      enabled: entry.enabled,
      expiresAt: entry.expiresAt,
      revision: entry.revision,
    });
    if (requests.length === SERVICE_CONTROL_REQUEST_HISTORY_LIMIT) break;
  }
  return requests;
}

function isAdminAnnouncementAction(value: string): value is AdminAnnouncementAction {
  return value === 'published' || value === 'disabled' || value === 'cleared';
}

function adminAnnouncementAction(announcement: AdminAnnouncement): AdminAnnouncementAction {
  if (announcement.enabled && announcement.message) return 'published';
  if (announcement.message) return 'disabled';
  return 'cleared';
}

function adminAnnouncementHistoryMatches(
  announcement: AdminAnnouncement,
  historyEntry: AdminAnnouncementHistoryEntry | undefined,
): boolean {
  return (
    historyEntry?.id === announcement.id &&
    historyEntry.message === announcement.message &&
    historyEntry.enabled === announcement.enabled &&
    historyEntry.expiresAt === announcement.expiresAt &&
    historyEntry.updatedAt === announcement.updatedAt &&
    historyEntry.action === adminAnnouncementAction(announcement)
  );
}

function createAdminAnnouncementId(now: number): string {
  const cryptoValue = Reflect.get(globalThis, 'crypto');
  const randomUUID =
    cryptoValue !== null && (typeof cryptoValue === 'object' || typeof cryptoValue === 'function')
      ? Reflect.get(cryptoValue, 'randomUUID')
      : null;
  const generated =
    typeof randomUUID === 'function' ? Reflect.apply(randomUUID, cryptoValue, []) : null;
  const suffix =
    (typeof generated === 'string' && generated) || Math.random().toString(36).slice(2, 12);
  return `${now.toString(36)}-${suffix}`;
}

function adminAnnouncementResponse(
  state: AdminAnnouncementState,
  status: number = 200,
  extra: Record<string, unknown> = {},
): Response {
  return serviceControlJson({ ...extra, announcementState: state }, status);
}

function normalizeAbuseRateState(value: unknown): AbuseRateState | null {
  if (!isUnknownRecord(value)) return null;
  const isV1 = hasExactKeySet(value, [
    'v',
    'limit',
    'windowMs',
    'windowStartMs',
    'resetAtMs',
    'count',
  ]);
  const isV2 = hasExactKeySet(value, [
    'v',
    'limit',
    'windowMs',
    'windowStartMs',
    'resetAtMs',
    'count',
    'operationIds',
  ]);
  if (
    (!isV1 && !isV2) ||
    (isV1 ? value.v !== 1 : value.v !== 2) ||
    !isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 1_000_000 ||
    !isSafeInteger(value.windowMs) ||
    value.windowMs < 1_000 ||
    value.windowMs > 24 * 60 * 60 * 1_000 ||
    !isSafeInteger(value.windowStartMs) ||
    value.windowStartMs < 0 ||
    value.windowStartMs % value.windowMs !== 0 ||
    !isSafeInteger(value.resetAtMs) ||
    value.resetAtMs !== value.windowStartMs + value.windowMs ||
    !isSafeInteger(value.count) ||
    value.count < 0 ||
    value.count > value.limit ||
    (isV2 &&
      (!Array.isArray(value.operationIds) ||
        value.operationIds.length > Math.min(value.limit, ABUSE_RATE_OPERATION_HISTORY_LIMIT) ||
        value.operationIds.length > value.count ||
        new Set(value.operationIds).size !== value.operationIds.length ||
        value.operationIds.some(
          (operationId) =>
            typeof operationId !== 'string' || !ABUSE_RATE_OPERATION_ID_RE.test(operationId),
        )))
  ) {
    return null;
  }
  const operationIds =
    isV2 && Array.isArray(value.operationIds)
      ? value.operationIds.filter(
          (operationId): operationId is string => typeof operationId === 'string',
        )
      : [];
  return {
    v: 2,
    limit: value.limit,
    windowMs: value.windowMs,
    windowStartMs: value.windowStartMs,
    resetAtMs: value.resetAtMs,
    count: value.count,
    operationIds,
  };
}

function normalizeAbuseRatePairState(value: unknown): AbuseRatePairState | null {
  if (
    !isUnknownRecord(value) ||
    !hasExactKeySet(value, [
      'v',
      'windowMs',
      'windowStartMs',
      'resetAtMs',
      'primary',
      'secondaries',
    ]) ||
    value.v !== 1 ||
    !isSafeInteger(value.windowMs) ||
    value.windowMs < 1_000 ||
    value.windowMs > 24 * 60 * 60 * 1_000 ||
    !isSafeInteger(value.windowStartMs) ||
    value.windowStartMs < 0 ||
    value.windowStartMs % value.windowMs !== 0 ||
    !isSafeInteger(value.resetAtMs) ||
    value.resetAtMs !== value.windowStartMs + value.windowMs ||
    !isUnknownRecord(value.primary) ||
    !hasExactKeySet(value.primary, ['limit', 'count']) ||
    !isSafeInteger(value.primary.limit) ||
    value.primary.limit < 1 ||
    value.primary.limit > ABUSE_RATE_PAIR_PRIMARY_LIMIT ||
    !isSafeInteger(value.primary.count) ||
    value.primary.count < 1 ||
    value.primary.count > value.primary.limit ||
    !Array.isArray(value.secondaries) ||
    value.secondaries.length > Math.min(value.primary.count, ABUSE_RATE_PAIR_PRIMARY_LIMIT)
  ) {
    return null;
  }
  const identities = new Set<string>();
  const secondaries: AbuseRatePairSecondary[] = [];
  let secondaryConsumeCount = 0;
  for (const entry of value.secondaries) {
    if (
      !isUnknownRecord(entry) ||
      !hasExactKeySet(entry, ['identity', 'limit', 'count']) ||
      typeof entry.identity !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,64}$/.test(entry.identity) ||
      identities.has(entry.identity) ||
      !isSafeInteger(entry.limit) ||
      entry.limit < 1 ||
      entry.limit > ABUSE_RATE_PAIR_PRIMARY_LIMIT ||
      !isSafeInteger(entry.count) ||
      entry.count < 1 ||
      entry.count > entry.limit
    ) {
      return null;
    }
    identities.add(entry.identity);
    secondaryConsumeCount += entry.count;
    secondaries.push({ identity: entry.identity, limit: entry.limit, count: entry.count });
  }
  if (secondaryConsumeCount > value.primary.count) return null;
  return {
    v: 1,
    windowMs: value.windowMs,
    windowStartMs: value.windowStartMs,
    resetAtMs: value.resetAtMs,
    primary: { limit: value.primary.limit, count: value.primary.count },
    secondaries,
  };
}

function abuseRateProjection(
  allowed: boolean,
  limit: number,
  count: number,
  resetAtMs: number,
  nowMs: number,
): AbuseRateProjection {
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - count),
    resetAtMs,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAtMs - nowMs) / 1_000)),
  };
}

function parseAbuseRateConsumeBody(
  value: unknown,
  idempotent: boolean,
): AbuseRateConsumeBody | null {
  const expectedKeys = idempotent
    ? ['limit', 'windowMs', 'cost', 'operationId']
    : ['limit', 'windowMs', 'cost'];
  if (
    !hasExactKeys(value, expectedKeys) ||
    !isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 1_000_000 ||
    !isSafeInteger(value.windowMs) ||
    value.windowMs < 1_000 ||
    value.windowMs > 24 * 60 * 60 * 1_000 ||
    !isSafeInteger(value.cost) ||
    value.cost < 1 ||
    value.cost > value.limit
  ) {
    return null;
  }
  const operationId =
    idempotent && typeof value.operationId === 'string' ? value.operationId : null;
  if (
    idempotent &&
    (operationId === null ||
      !ABUSE_RATE_OPERATION_ID_RE.test(operationId) ||
      value.limit > ABUSE_RATE_OPERATION_HISTORY_LIMIT)
  ) {
    return null;
  }
  return {
    limit: value.limit,
    windowMs: value.windowMs,
    cost: value.cost,
    operationId,
  };
}

function parseAbuseRatePairConsumeBody(value: unknown): AbuseRatePairConsumeBody | null {
  if (
    !hasExactKeys(value, [
      'limit',
      'windowMs',
      'cost',
      'secondaryIdentity',
      'secondaryLimit',
      'secondaryCost',
    ]) ||
    !isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > ABUSE_RATE_PAIR_PRIMARY_LIMIT ||
    !isSafeInteger(value.windowMs) ||
    value.windowMs < 1_000 ||
    value.windowMs > 24 * 60 * 60 * 1_000 ||
    !isSafeInteger(value.cost) ||
    value.cost < 1 ||
    value.cost > value.limit
  ) {
    return null;
  }
  if (
    value.secondaryIdentity === null &&
    value.secondaryLimit === null &&
    value.secondaryCost === null
  ) {
    return {
      limit: value.limit,
      windowMs: value.windowMs,
      cost: value.cost,
      secondaryIdentity: null,
      secondaryLimit: null,
      secondaryCost: null,
    };
  }
  if (
    typeof value.secondaryIdentity !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,64}$/.test(value.secondaryIdentity) ||
    !isSafeInteger(value.secondaryLimit) ||
    value.secondaryLimit < 1 ||
    value.secondaryLimit > ABUSE_RATE_PAIR_PRIMARY_LIMIT ||
    !isSafeInteger(value.secondaryCost) ||
    value.secondaryCost < 1 ||
    value.secondaryCost > value.secondaryLimit ||
    value.secondaryCost > value.cost
  ) {
    return null;
  }
  return {
    limit: value.limit,
    windowMs: value.windowMs,
    cost: value.cost,
    secondaryIdentity: value.secondaryIdentity,
    secondaryLimit: value.secondaryLimit,
    secondaryCost: value.secondaryCost,
  };
}

function parseServiceMaintenanceMutationBody(
  value: unknown,
): ServiceMaintenanceMutationBody | null {
  if (
    !isUnknownRecord(value) ||
    typeof value.enabled !== 'boolean' ||
    !isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0 ||
    typeof value.requestId !== 'string' ||
    !SERVICE_CONTROL_REQUEST_ID_RE.test(value.requestId)
  ) {
    return null;
  }
  return {
    enabled: value.enabled,
    expectedRevision: value.expectedRevision,
    requestId: value.requestId,
  };
}

function parseAdminAnnouncementMutationBody(value: unknown): AdminAnnouncementMutationBody | null {
  if (!isUnknownRecord(value)) return null;
  const keys = Object.keys(value);
  const message = typeof value.message === 'string' ? value.message.trim() : null;
  const expiresAt =
    value.expiresAt === null || value.expiresAt === ''
      ? null
      : typeof value.expiresAt === 'string' && !Number.isNaN(new Date(value.expiresAt).getTime())
        ? new Date(value.expiresAt).toISOString()
        : undefined;
  const baseHistory = normalizedAdminAnnouncementHistory(value.baseHistory);
  if (
    keys.length !== 6 ||
    !keys.includes('message') ||
    !keys.includes('enabled') ||
    !keys.includes('expiresAt') ||
    !keys.includes('expectedRevision') ||
    !keys.includes('requestId') ||
    !keys.includes('baseHistory') ||
    message === null ||
    message.length > 280 ||
    typeof value.enabled !== 'boolean' ||
    expiresAt === undefined ||
    !isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0 ||
    value.expectedRevision >= Number.MAX_SAFE_INTEGER ||
    typeof value.requestId !== 'string' ||
    !SERVICE_CONTROL_REQUEST_ID_RE.test(value.requestId) ||
    !baseHistory ||
    baseHistory.length > ADMIN_ANNOUNCEMENT_HISTORY_LIMIT
  ) {
    return null;
  }
  return {
    message,
    enabled: value.enabled,
    expiresAt,
    expectedRevision: value.expectedRevision,
    requestId: value.requestId,
    baseHistory,
  };
}

export class MusixquareServiceControl {
  private readonly storage: object;
  private readonly announcementOnly: boolean;
  private readonly abuseRatePairOnly: boolean;
  private readonly abuseRateOnly: boolean;
  private serviceStatus: StoredServiceControlState;
  private requests: ServiceControlRequestRecord[];
  private announcementState: AdminAnnouncementState;
  private announcementRequests: AdminAnnouncementRequestRecord[];
  private announcementStateInvalid: boolean;
  private abuseRateState: AbuseRateState | null;
  private abuseRateStateInvalid: boolean;
  private abuseRatePairState: AbuseRatePairState | null;
  private abuseRatePairStateInvalid: boolean;
  private abuseRateAlarmAt: number | null;
  private mutationTail: Promise<void>;
  private readonly ready: Promise<void>;

  constructor(state: ServiceControlStatePort) {
    this.storage = state.storage;
    this.announcementOnly = state?.id?.name === ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME;
    this.abuseRatePairOnly =
      typeof state?.id?.name === 'string' &&
      state.id.name.startsWith(ABUSE_RATE_PAIR_OBJECT_NAME_PREFIX);
    this.abuseRateOnly =
      this.abuseRatePairOnly ||
      (typeof state?.id?.name === 'string' &&
        state.id.name.startsWith(ABUSE_RATE_OBJECT_NAME_PREFIX));
    this.serviceStatus = initialServiceControlState();
    this.requests = [];
    this.announcementState = initialAdminAnnouncementState();
    this.announcementRequests = [];
    this.announcementStateInvalid = false;
    this.abuseRateState = null;
    this.abuseRateStateInvalid = false;
    this.abuseRatePairState = null;
    this.abuseRatePairStateInvalid = false;
    this.abuseRateAlarmAt = null;
    this.mutationTail = Promise.resolve();
    const load = async () => {
      if (this.announcementOnly) {
        const [storedAnnouncementState, storedAnnouncementRequests] = await Promise.all([
          storageGet(this.storage, ADMIN_ANNOUNCEMENT_STATE_KEY),
          storageGet(this.storage, ADMIN_ANNOUNCEMENT_REQUESTS_KEY),
        ]);
        const normalizedAnnouncementState =
          canonicalAdminAnnouncementState(storedAnnouncementState);
        if (
          storedAnnouncementState !== undefined &&
          storedAnnouncementState !== null &&
          !normalizedAnnouncementState
        ) {
          this.announcementStateInvalid = true;
        }
        this.announcementState = normalizedAnnouncementState || initialAdminAnnouncementState();
        this.announcementRequests = normalizeAdminAnnouncementRequests(storedAnnouncementRequests);
        return;
      }
      if (this.abuseRateOnly) {
        const stateKey = this.abuseRatePairOnly ? ABUSE_RATE_PAIR_STATE_KEY : ABUSE_RATE_STATE_KEY;
        const [storedAbuseRateState, storedAlarmAt] = await Promise.all([
          storageGet(this.storage, stateKey),
          optionalStorageMethod(this.storage, 'getAlarm')?.() ?? Promise.resolve(null),
        ]);
        if (this.abuseRatePairOnly) {
          const normalized = normalizeAbuseRatePairState(storedAbuseRateState);
          if (storedAbuseRateState !== undefined && storedAbuseRateState !== null && !normalized) {
            this.abuseRatePairStateInvalid = true;
          }
          this.abuseRatePairState = normalized;
        } else {
          const normalized = normalizeAbuseRateState(storedAbuseRateState);
          if (storedAbuseRateState !== undefined && storedAbuseRateState !== null && !normalized) {
            this.abuseRateStateInvalid = true;
          }
          this.abuseRateState = normalized;
        }
        this.abuseRateAlarmAt = isSafeInteger(storedAlarmAt) ? storedAlarmAt : null;
        return;
      }
      const [
        storedState,
        storedRequests,
        storedAnnouncementState,
        storedAnnouncementRequests,
        storedAbuseRateState,
      ] = await Promise.all([
        storageGet(this.storage, SERVICE_CONTROL_STATE_KEY),
        storageGet(this.storage, SERVICE_CONTROL_REQUESTS_KEY),
        storageGet(this.storage, ADMIN_ANNOUNCEMENT_STATE_KEY),
        storageGet(this.storage, ADMIN_ANNOUNCEMENT_REQUESTS_KEY),
        storageGet(this.storage, ABUSE_RATE_STATE_KEY),
      ]);
      const normalizedStoredState = canonicalServiceControlState(storedState);
      if (storedState !== undefined && storedState !== null && !normalizedStoredState) {
        throw new Error('SERVICE_MAINTENANCE_STATE_INVALID');
      }
      this.serviceStatus = normalizedStoredState || initialServiceControlState();
      this.requests = normalizeServiceControlRequests(storedRequests);
      const normalizedAnnouncementState = canonicalAdminAnnouncementState(storedAnnouncementState);
      if (
        storedAnnouncementState !== undefined &&
        storedAnnouncementState !== null &&
        !normalizedAnnouncementState
      ) {
        this.announcementStateInvalid = true;
      }
      this.announcementState = normalizedAnnouncementState || initialAdminAnnouncementState();
      this.announcementRequests = normalizeAdminAnnouncementRequests(storedAnnouncementRequests);
      const normalizedAbuseRateState = normalizeAbuseRateState(storedAbuseRateState);
      if (
        storedAbuseRateState !== undefined &&
        storedAbuseRateState !== null &&
        !normalizedAbuseRateState
      ) {
        this.abuseRateStateInvalid = true;
      }
      this.abuseRateState = normalizedAbuseRateState;
    };
    this.ready =
      typeof state.blockConcurrencyWhile === 'function'
        ? state.blockConcurrencyWhile(load)
        : load();
  }

  private async withMutation<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    const gate: { release?: () => void } = {};
    this.mutationTail = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      gate.release?.();
    }
  }

  private response(
    state: StoredServiceControlState = this.serviceStatus,
    status: number = 200,
    extra: Record<string, unknown> = {},
  ): Response {
    const response = serviceControlJson(
      {
        ...extra,
        serviceStatus: publicServiceControlState(state),
      },
      status,
    );
    for (const [name, value] of Object.entries(serviceControlStatusHeaders(state))) {
      response.headers.set(name, value);
    }
    return response;
  }

  private async handleAbuseRateConsume(request: Request, idempotent: boolean): Promise<Response> {
    if (this.abuseRateStateInvalid) {
      return abuseRateResponse(request, { error: 'ABUSE_RATE_STATE_INVALID' }, 503);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
      return abuseRateResponse(request, { error: 'JSON_REQUIRED' }, 415);
    }
    const declared = request.headers.get('content-length');
    if (
      declared !== null &&
      (!/^\d+$/.test(declared.trim()) || Number(declared) > ABUSE_RATE_REQUEST_MAX_BYTES)
    ) {
      return abuseRateResponse(request, { error: 'REQUEST_TOO_LARGE' }, 413);
    }
    const parsed = await readPrivateJsonBody(request, ABUSE_RATE_REQUEST_MAX_BYTES);
    if ('error' in parsed)
      return abuseRateResponse(request, { error: parsed.error }, parsed.status);
    const body = parseAbuseRateConsumeBody(parsed.value, idempotent);
    if (!body) {
      return abuseRateResponse(request, { error: 'INVALID_REQUEST' }, 400);
    }

    return this.withMutation(async () => {
      const nowMs = Date.now();
      const windowStartMs = Math.floor(nowMs / body.windowMs) * body.windowMs;
      const resetAtMs = windowStartMs + body.windowMs;
      const current =
        this.abuseRateState &&
        this.abuseRateState.windowStartMs === windowStartMs &&
        this.abuseRateState.windowMs === body.windowMs &&
        this.abuseRateState.limit === body.limit
          ? this.abuseRateState
          : null;
      const count = current?.count || 0;
      const operationIds = current?.operationIds || [];
      const replayed = body.operationId !== null && operationIds.includes(body.operationId);
      const allowed = replayed || count + body.cost <= body.limit;
      const nextCount = allowed && !replayed ? count + body.cost : count;
      if (allowed && !replayed) {
        const next: AbuseRateState = {
          v: 2,
          limit: body.limit,
          windowMs: body.windowMs,
          windowStartMs,
          resetAtMs,
          count: nextCount,
          operationIds:
            body.operationId !== null ? [...operationIds, body.operationId] : operationIds,
        };
        await storagePut(this.storage, ABUSE_RATE_STATE_KEY, next);
        this.abuseRateState = next;
      }
      // A Durable Object owns one persistent alarm. The cold load observes its
      // current value, so same-window consumes do not need to overwrite the
      // same alarm; a missing or stale alarm is still repaired fail-closed.
      const setAlarm = optionalStorageMethod(this.storage, 'setAlarm');
      if (setAlarm && this.abuseRateAlarmAt !== resetAtMs) {
        await setAlarm(resetAtMs);
        this.abuseRateAlarmAt = resetAtMs;
      }
      return abuseRateResponse(request, {
        allowed,
        limit: body.limit,
        remaining: Math.max(0, body.limit - nextCount),
        resetAtMs,
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAtMs - nowMs) / 1_000)),
      });
    });
  }

  private async handleAbuseRatePairConsume(request: Request): Promise<Response> {
    if (this.abuseRatePairStateInvalid) {
      return abuseRateResponse(request, { error: 'ABUSE_RATE_PAIR_STATE_INVALID' }, 503);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
      return abuseRateResponse(request, { error: 'JSON_REQUIRED' }, 415);
    }
    const declared = request.headers.get('content-length');
    if (
      declared !== null &&
      (!/^\d+$/.test(declared.trim()) || Number(declared) > ABUSE_RATE_REQUEST_MAX_BYTES)
    ) {
      return abuseRateResponse(request, { error: 'REQUEST_TOO_LARGE' }, 413);
    }
    const parsed = await readPrivateJsonBody(request, ABUSE_RATE_REQUEST_MAX_BYTES);
    if ('error' in parsed)
      return abuseRateResponse(request, { error: parsed.error }, parsed.status);
    const body = parseAbuseRatePairConsumeBody(parsed.value);
    if (!body) {
      return abuseRateResponse(request, { error: 'INVALID_REQUEST' }, 400);
    }
    const secondaryAbsent = body.secondaryIdentity === null;

    return this.withMutation(async () => {
      const nowMs = Date.now();
      const windowStartMs = Math.floor(nowMs / body.windowMs) * body.windowMs;
      const resetAtMs = windowStartMs + body.windowMs;
      const current =
        this.abuseRatePairState &&
        this.abuseRatePairState.windowStartMs === windowStartMs &&
        this.abuseRatePairState.windowMs === body.windowMs &&
        this.abuseRatePairState.primary.limit === body.limit
          ? this.abuseRatePairState
          : null;
      const primaryCount = current?.primary.count || 0;
      const primaryAllowed = primaryCount + body.cost <= body.limit;

      let secondary = null;
      let secondaryAllowed = true;
      let nextSecondaries = current?.secondaries || [];
      if (primaryAllowed && !secondaryAbsent) {
        const existingIndex = nextSecondaries.findIndex(
          (entry) => entry.identity === body.secondaryIdentity,
        );
        const existing = existingIndex >= 0 ? nextSecondaries[existingIndex] : null;
        const secondaryCount =
          existing && existing.limit === body.secondaryLimit ? existing.count : 0;
        secondaryAllowed = secondaryCount + body.secondaryCost <= body.secondaryLimit;
        const nextSecondaryCount = secondaryAllowed
          ? secondaryCount + body.secondaryCost
          : secondaryCount;
        secondary = abuseRateProjection(
          secondaryAllowed,
          body.secondaryLimit,
          nextSecondaryCount,
          resetAtMs,
          nowMs,
        );
        if (secondaryAllowed) {
          const nextEntry = {
            identity: body.secondaryIdentity,
            limit: body.secondaryLimit,
            count: nextSecondaryCount,
          };
          nextSecondaries = [...nextSecondaries];
          if (existingIndex >= 0) nextSecondaries[existingIndex] = nextEntry;
          else nextSecondaries.push(nextEntry);
        }
      }

      const allowed = primaryAllowed && secondaryAllowed;
      // The pair is one paid-resource authorization decision. A token that
      // exhausted only its private secondary quota must not spend the shared
      // Private Relay/NAT primary bucket and deny unrelated browsers.
      const committedPrimaryCount = allowed ? primaryCount + body.cost : primaryCount;
      const primary = abuseRateProjection(
        primaryAllowed,
        body.limit,
        committedPrimaryCount,
        resetAtMs,
        nowMs,
      );
      if (allowed) {
        const next: AbuseRatePairState = {
          v: 1,
          windowMs: body.windowMs,
          windowStartMs,
          resetAtMs,
          primary: { limit: body.limit, count: committedPrimaryCount },
          secondaries: nextSecondaries,
        };
        await storagePut(this.storage, ABUSE_RATE_PAIR_STATE_KEY, next);
        this.abuseRatePairState = next;
      }
      const setAlarm = optionalStorageMethod(this.storage, 'setAlarm');
      if (setAlarm && this.abuseRateAlarmAt !== resetAtMs) {
        await setAlarm(resetAtMs);
        this.abuseRateAlarmAt = resetAtMs;
      }
      return abuseRateResponse(request, {
        allowed,
        deniedBy: !primaryAllowed ? 'primary' : !secondaryAllowed ? 'secondary' : null,
        primary,
        secondary,
      });
    });
  }

  private async handleAnnouncementMutation(request: Request): Promise<Response> {
    if (this.announcementStateInvalid) {
      return serviceControlJson({ error: 'ADMIN_ANNOUNCEMENT_STATE_INVALID' }, 503);
    }
    const contentType = String(request.headers.get('Content-Type') || '').toLowerCase();
    if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
      return serviceControlJson({ error: 'JSON_REQUIRED' }, 415);
    }
    const contentLength = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(contentLength) && contentLength > ADMIN_ANNOUNCEMENT_CONTROL_MAX_BYTES) {
      return serviceControlJson({ error: 'REQUEST_TOO_LARGE' }, 413);
    }
    const parsed = await readPrivateJsonBody(request, ADMIN_ANNOUNCEMENT_CONTROL_MAX_BYTES);
    if ('error' in parsed) return serviceControlJson({ error: parsed.error }, parsed.status);
    const body = parseAdminAnnouncementMutationBody(parsed.value);
    const legacyMigration =
      this.announcementOnly && request.headers.get(ADMIN_ANNOUNCEMENT_MIGRATION_HEADER) === '1';
    if (!body) {
      return serviceControlJson({ error: 'INVALID_REQUEST' }, 400);
    }
    const { message, expiresAt, baseHistory } = body;

    return this.withMutation(async () => {
      const replay = this.announcementRequests.find((entry) => entry.requestId === body.requestId);
      if (replay) {
        if (
          replay.message !== message ||
          replay.enabled !== body.enabled ||
          replay.expiresAt !== expiresAt
        ) {
          return adminAnnouncementResponse(this.announcementState, 409, {
            error: 'ADMIN_ANNOUNCEMENT_REQUEST_ID_REUSED',
          });
        }
        if (replay.revision !== this.announcementState.revision) {
          return adminAnnouncementResponse(this.announcementState, 409, {
            error: 'ADMIN_ANNOUNCEMENT_REQUEST_SUPERSEDED',
          });
        }
        return adminAnnouncementResponse(this.announcementState, 200, {
          ok: true,
          changed: false,
          replayed: true,
        });
      }
      const migrationBaseRevision =
        legacyMigration &&
        this.announcementState.revision === 0 &&
        this.announcementState.history.length === 0 &&
        body.expectedRevision > 0 &&
        baseHistory.length > 0
          ? body.expectedRevision
          : null;
      if (
        body.expectedRevision !== this.announcementState.revision &&
        migrationBaseRevision === null
      ) {
        return adminAnnouncementResponse(this.announcementState, 409, {
          error: 'ADMIN_ANNOUNCEMENT_REVISION_CONFLICT',
        });
      }
      if (expiresAt !== null && new Date(expiresAt).getTime() <= Date.now()) {
        return serviceControlJson({ error: 'EXPIRES_AT_IN_PAST' }, 400);
      }

      const now = Date.now();
      const announcement = {
        id: createAdminAnnouncementId(now),
        message,
        enabled: body.enabled && Boolean(message),
        expiresAt,
        updatedAt: new Date(now).toISOString(),
      };
      const inheritedHistory =
        this.announcementState.revision === 0 && this.announcementState.history.length === 0
          ? baseHistory
          : this.announcementState.history;
      const nextState = {
        revision: (migrationBaseRevision ?? this.announcementState.revision) + 1,
        announcement,
        history: [
          { ...announcement, action: adminAnnouncementAction(announcement) },
          ...inheritedHistory,
        ].slice(0, ADMIN_ANNOUNCEMENT_HISTORY_LIMIT),
      };
      const requestRecord = {
        requestId: body.requestId,
        message,
        enabled: body.enabled,
        expiresAt,
        revision: nextState.revision,
      };
      const nextRequests = [requestRecord, ...this.announcementRequests].slice(
        0,
        SERVICE_CONTROL_REQUEST_HISTORY_LIMIT,
      );
      await storagePut(this.storage, {
        [ADMIN_ANNOUNCEMENT_STATE_KEY]: nextState,
        [ADMIN_ANNOUNCEMENT_REQUESTS_KEY]: nextRequests,
      });
      this.announcementState = nextState;
      this.announcementRequests = nextRequests;
      return adminAnnouncementResponse(nextState, 200, {
        ok: true,
        changed: true,
        replayed: false,
      });
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    if (url.search || url.hash) return serviceControlJson({ error: 'NOT_FOUND' }, 404);
    if (
      this.announcementOnly &&
      !(
        (request.method === 'GET' && url.pathname === ADMIN_ANNOUNCEMENT_STATUS_PATH) ||
        (request.method === 'POST' && url.pathname === ADMIN_ANNOUNCEMENT_STATE_PATH)
      )
    ) {
      return serviceControlJson({ error: 'NOT_FOUND' }, 404);
    }
    if (this.abuseRatePairOnly) {
      if (request.method === 'POST' && url.pathname === ABUSE_RATE_PAIR_CONSUME_PATH) {
        return this.handleAbuseRatePairConsume(request);
      }
      return serviceControlJson({ error: 'NOT_FOUND' }, 404);
    }
    if (
      this.abuseRateOnly &&
      !(
        request.method === 'POST' &&
        (url.pathname === ABUSE_RATE_CONSUME_PATH ||
          url.pathname === ABUSE_RATE_IDEMPOTENT_CONSUME_PATH)
      )
    ) {
      return serviceControlJson({ error: 'NOT_FOUND' }, 404);
    }
    if (
      request.method === 'POST' &&
      (url.pathname === ABUSE_RATE_CONSUME_PATH ||
        url.pathname === ABUSE_RATE_IDEMPOTENT_CONSUME_PATH)
    ) {
      return this.handleAbuseRateConsume(
        request,
        url.pathname === ABUSE_RATE_IDEMPOTENT_CONSUME_PATH,
      );
    }
    if (request.method === 'GET' && url.pathname === ADMIN_ANNOUNCEMENT_STATUS_PATH) {
      if (this.announcementStateInvalid) {
        return serviceControlJson({ error: 'ADMIN_ANNOUNCEMENT_STATE_INVALID' }, 503);
      }
      return adminAnnouncementResponse(this.announcementState);
    }
    if (request.method === 'POST' && url.pathname === ADMIN_ANNOUNCEMENT_STATE_PATH) {
      return this.handleAnnouncementMutation(request);
    }
    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      url.pathname === SERVICE_CONTROL_STATUS_PATH
    ) {
      const response = this.response();
      return request.method === 'HEAD'
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    }
    if (request.method !== 'POST' || url.pathname !== SERVICE_CONTROL_STATE_PATH) {
      return serviceControlJson({ error: 'NOT_FOUND' }, 404);
    }

    const contentType = String(request.headers.get('Content-Type') || '').toLowerCase();
    if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
      return serviceControlJson({ error: 'JSON_REQUIRED' }, 415);
    }
    const contentLength = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(contentLength) && contentLength > 4096) {
      return serviceControlJson({ error: 'REQUEST_TOO_LARGE' }, 413);
    }
    const parsed = await readPrivateJsonBody(request, 4096);
    if ('error' in parsed) return serviceControlJson({ error: parsed.error }, parsed.status);
    const body = parseServiceMaintenanceMutationBody(parsed.value);
    if (!body) {
      return serviceControlJson({ error: 'INVALID_REQUEST' }, 400);
    }

    return this.withMutation(async () => {
      const replay = this.requests.find((entry) => entry.requestId === body.requestId);
      if (replay) {
        if (replay.enabled !== body.enabled) {
          return this.response(this.serviceStatus, 409, {
            error: 'SERVICE_MAINTENANCE_REQUEST_ID_REUSED',
          });
        }
        if (replay.state.revision !== this.serviceStatus.revision) {
          return this.response(this.serviceStatus, 409, {
            error: 'SERVICE_MAINTENANCE_REQUEST_SUPERSEDED',
          });
        }
        return this.response(this.serviceStatus, 200, {
          ok: true,
          changed: false,
          replayed: true,
        });
      }
      if (body.expectedRevision !== this.serviceStatus.revision) {
        return this.response(this.serviceStatus, 409, {
          error: 'SERVICE_MAINTENANCE_REVISION_CONFLICT',
        });
      }

      const changed = body.enabled !== this.serviceStatus.enabled;
      const now = Date.now();
      const next = changed
        ? {
            enabled: body.enabled,
            revision: this.serviceStatus.revision + 1,
            updatedAt: now,
            activatedAt: body.enabled ? now : null,
          }
        : this.serviceStatus;
      const requestRecord = {
        requestId: body.requestId,
        enabled: body.enabled,
        state: next,
      };
      const nextRequests = [requestRecord, ...this.requests].slice(
        0,
        SERVICE_CONTROL_REQUEST_HISTORY_LIMIT,
      );
      await storagePut(this.storage, {
        [SERVICE_CONTROL_STATE_KEY]: next,
        [SERVICE_CONTROL_REQUESTS_KEY]: nextRequests,
      });
      this.serviceStatus = next;
      this.requests = nextRequests;
      return this.response(next, 200, { ok: true, changed, replayed: false });
    });
  }

  async alarm(): Promise<void> {
    await this.ready;
    return this.withMutation(async () => {
      const stateKey = this.abuseRatePairOnly ? ABUSE_RATE_PAIR_STATE_KEY : ABUSE_RATE_STATE_KEY;
      const stored = await storageGet(this.storage, stateKey);
      if (stored === undefined || stored === null) {
        if (this.abuseRatePairOnly) this.abuseRatePairState = null;
        else this.abuseRateState = null;
        const deleteAlarm = optionalStorageMethod(this.storage, 'deleteAlarm');
        if (deleteAlarm) await deleteAlarm();
        this.abuseRateAlarmAt = null;
        return;
      }
      const pairState = this.abuseRatePairOnly ? normalizeAbuseRatePairState(stored) : null;
      const singleState = this.abuseRatePairOnly ? null : normalizeAbuseRateState(stored);
      const state = pairState || singleState;
      if (!state) {
        if (this.abuseRatePairOnly) {
          this.abuseRatePairState = null;
          this.abuseRatePairStateInvalid = true;
        }
        throw new Error('ABUSE_RATE_STATE_INVALID');
      }
      if (pairState) this.abuseRatePairState = pairState;
      else if (singleState) this.abuseRateState = singleState;
      if (state.resetAtMs > Date.now()) {
        const setAlarm = optionalStorageMethod(this.storage, 'setAlarm');
        if (setAlarm) {
          await setAlarm(state.resetAtMs);
          this.abuseRateAlarmAt = state.resetAtMs;
        }
        return;
      }
      await storageDelete(this.storage, stateKey);
      if (this.abuseRatePairOnly) this.abuseRatePairState = null;
      else this.abuseRateState = null;
      const deleteAlarm = optionalStorageMethod(this.storage, 'deleteAlarm');
      if (deleteAlarm) await deleteAlarm();
      this.abuseRateAlarmAt = null;
    });
  }
}
