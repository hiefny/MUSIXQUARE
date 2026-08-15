import { readBodyBytesLimited } from './pro-room-body.js';
import { hasExactKeys } from './pro-room-validation.js';
import {
  ABUSE_RATE_CONSUME_PATH,
  ABUSE_RATE_IDEMPOTENT_CONSUME_PATH,
  ABUSE_RATE_PAIR_CONSUME_PATH,
  ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME,
  ADMIN_ANNOUNCEMENT_MIGRATION_HEADER,
  ADMIN_ANNOUNCEMENT_STATE_PATH,
  ADMIN_ANNOUNCEMENT_STATUS_PATH,
  SERVICE_CONTROL_STATE_PATH,
  SERVICE_CONTROL_STATUS_PATH,
  normalizeServiceMaintenanceState,
} from './service-maintenance.js';

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
// Keep these in lockstep with service-maintenance.js. Named abuse-rate
// Durable Objects own only their counter state, so loading unrelated global
// maintenance and announcement records on every cold start is unnecessary.
const ABUSE_RATE_OBJECT_NAME_PREFIX = 'musixquare-abuse-rate-v1:';
const ABUSE_RATE_PAIR_OBJECT_NAME_PREFIX = 'musixquare-abuse-rate-pair-v1:';
const ABUSE_RATE_STATE_KEY = 'abuse-rate-state-v1';
const ABUSE_RATE_PAIR_STATE_KEY = 'abuse-rate-pair-state-v1';
const ABUSE_RATE_REQUEST_MAX_BYTES = 1024;
const ABUSE_RATE_OPERATION_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;
const ABUSE_RATE_OPERATION_HISTORY_LIMIT = 1024;
const ABUSE_RATE_PAIR_PRIMARY_LIMIT = 1024;
const ADMIN_ANNOUNCEMENT_STATE_KEY = 'admin-announcement-state';
const ADMIN_ANNOUNCEMENT_REQUESTS_KEY = 'admin-announcement-requests';
const ADMIN_ANNOUNCEMENT_HISTORY_LIMIT = 100;
const ADMIN_ANNOUNCEMENT_CONTROL_MAX_BYTES = 256 * 1024;
const ADMIN_ANNOUNCEMENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

async function readPrivateJsonBody(request, maxBytes) {
  const bounded = await readBodyBytesLimited(request, maxBytes, INTERNAL_REQUEST_BODY_TIMEOUT_MS);
  if (bounded.error === 'too-large') return { error: 'REQUEST_TOO_LARGE', status: 413 };
  if (bounded.error === 'timeout' || bounded.error === 'aborted') {
    return { error: 'REQUEST_TIMEOUT', status: 408 };
  }
  if (bounded.error || !(bounded.body instanceof Uint8Array) || bounded.body.byteLength === 0) {
    return { error: 'INVALID_JSON', status: 400 };
  }
  try {
    return {
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bounded.body)),
    };
  } catch {
    return { error: 'INVALID_JSON', status: 400 };
  }
}

function initialServiceControlState() {
  return {
    enabled: false,
    revision: 0,
    updatedAt: null,
    activatedAt: null,
  };
}

function canonicalServiceControlState(value) {
  const normalized = normalizeServiceMaintenanceState(value);
  if (!normalized) return null;
  return {
    enabled: normalized.enabled,
    revision: normalized.revision,
    updatedAt: normalized.updatedAt,
    activatedAt: normalized.activatedAt,
  };
}

function publicServiceControlState(state) {
  return (
    normalizeServiceMaintenanceState(state) ||
    normalizeServiceMaintenanceState(initialServiceControlState())
  );
}

function normalizeServiceControlRequests(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        SERVICE_CONTROL_REQUEST_ID_RE.test(String(entry.requestId || '')) &&
        typeof entry.enabled === 'boolean' &&
        canonicalServiceControlState(entry.state),
    )
    .slice(0, SERVICE_CONTROL_REQUEST_HISTORY_LIMIT)
    .map((entry) => ({
      requestId: String(entry.requestId),
      enabled: entry.enabled,
      state: canonicalServiceControlState(entry.state),
    }));
}

function serviceControlJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function emptyAdminAnnouncement() {
  return {
    id: '',
    message: '',
    enabled: false,
    expiresAt: null,
    updatedAt: '',
  };
}

function initialAdminAnnouncementState() {
  return {
    revision: 0,
    announcement: emptyAdminAnnouncement(),
    history: [],
  };
}

function normalizedAdminAnnouncement(value, { allowEmpty = false, history = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
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
  if (
    !['published', 'disabled', 'cleared'].includes(value.action) ||
    value.action !== adminAnnouncementAction(announcement)
  ) {
    return null;
  }
  return { ...announcement, action: value.action };
}

function canonicalAdminAnnouncementState(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.history) ||
    value.history.length > ADMIN_ANNOUNCEMENT_HISTORY_LIMIT
  ) {
    return null;
  }
  const announcement = normalizedAdminAnnouncement(value.announcement, { allowEmpty: true });
  const history = value.history.map((entry) =>
    normalizedAdminAnnouncement(entry, { history: true }),
  );
  if (!announcement || history.some((entry) => entry === null)) return null;
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

function normalizeAdminAnnouncementRequests(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        SERVICE_CONTROL_REQUEST_ID_RE.test(String(entry.requestId || '')) &&
        typeof entry.message === 'string' &&
        entry.message.length <= 280 &&
        typeof entry.enabled === 'boolean' &&
        (entry.expiresAt === null ||
          (typeof entry.expiresAt === 'string' &&
            !Number.isNaN(new Date(entry.expiresAt).getTime()))) &&
        Number.isSafeInteger(entry.revision) &&
        entry.revision > 0,
    )
    .slice(0, SERVICE_CONTROL_REQUEST_HISTORY_LIMIT)
    .map((entry) => ({
      requestId: String(entry.requestId),
      message: entry.message,
      enabled: entry.enabled,
      expiresAt: entry.expiresAt,
      revision: entry.revision,
    }));
}

function adminAnnouncementAction(announcement) {
  if (announcement.enabled && announcement.message) return 'published';
  if (announcement.message) return 'disabled';
  return 'cleared';
}

function adminAnnouncementHistoryMatches(announcement, historyEntry) {
  return (
    historyEntry?.id === announcement.id &&
    historyEntry.message === announcement.message &&
    historyEntry.enabled === announcement.enabled &&
    historyEntry.expiresAt === announcement.expiresAt &&
    historyEntry.updatedAt === announcement.updatedAt &&
    historyEntry.action === adminAnnouncementAction(announcement)
  );
}

function createAdminAnnouncementId(now) {
  const suffix = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 12);
  return `${now.toString(36)}-${suffix}`;
}

function adminAnnouncementResponse(state, status = 200, extra = {}) {
  return serviceControlJson({ ...extra, announcementState: state }, status);
}

function normalizeAbuseRateState(value) {
  const isV1 = hasExactKeys(value, [
    'v',
    'limit',
    'windowMs',
    'windowStartMs',
    'resetAtMs',
    'count',
  ]);
  const isV2 = hasExactKeys(value, [
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
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 1_000_000 ||
    !Number.isSafeInteger(value.windowMs) ||
    value.windowMs < 1_000 ||
    value.windowMs > 24 * 60 * 60 * 1_000 ||
    !Number.isSafeInteger(value.windowStartMs) ||
    value.windowStartMs < 0 ||
    value.windowStartMs % value.windowMs !== 0 ||
    !Number.isSafeInteger(value.resetAtMs) ||
    value.resetAtMs !== value.windowStartMs + value.windowMs ||
    !Number.isSafeInteger(value.count) ||
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
  return {
    v: 2,
    limit: value.limit,
    windowMs: value.windowMs,
    windowStartMs: value.windowStartMs,
    resetAtMs: value.resetAtMs,
    count: value.count,
    operationIds: isV2 ? [...value.operationIds] : [],
  };
}

function normalizeAbuseRatePairState(value) {
  if (
    !hasExactKeys(value, [
      'v',
      'windowMs',
      'windowStartMs',
      'resetAtMs',
      'primary',
      'secondaries',
    ]) ||
    value.v !== 1 ||
    !Number.isSafeInteger(value.windowMs) ||
    value.windowMs < 1_000 ||
    value.windowMs > 24 * 60 * 60 * 1_000 ||
    !Number.isSafeInteger(value.windowStartMs) ||
    value.windowStartMs < 0 ||
    value.windowStartMs % value.windowMs !== 0 ||
    !Number.isSafeInteger(value.resetAtMs) ||
    value.resetAtMs !== value.windowStartMs + value.windowMs ||
    !hasExactKeys(value.primary, ['limit', 'count']) ||
    !Number.isSafeInteger(value.primary.limit) ||
    value.primary.limit < 1 ||
    value.primary.limit > ABUSE_RATE_PAIR_PRIMARY_LIMIT ||
    !Number.isSafeInteger(value.primary.count) ||
    value.primary.count < 1 ||
    value.primary.count > value.primary.limit ||
    !Array.isArray(value.secondaries) ||
    value.secondaries.length > Math.min(value.primary.count, ABUSE_RATE_PAIR_PRIMARY_LIMIT)
  ) {
    return null;
  }
  const identities = new Set();
  const secondaries = [];
  let secondaryConsumeCount = 0;
  for (const entry of value.secondaries) {
    if (
      !hasExactKeys(entry, ['identity', 'limit', 'count']) ||
      typeof entry.identity !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,64}$/.test(entry.identity) ||
      identities.has(entry.identity) ||
      !Number.isSafeInteger(entry.limit) ||
      entry.limit < 1 ||
      entry.limit > ABUSE_RATE_PAIR_PRIMARY_LIMIT ||
      !Number.isSafeInteger(entry.count) ||
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

function abuseRateProjection(allowed, limit, count, resetAtMs, nowMs) {
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - count),
    resetAtMs,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAtMs - nowMs) / 1_000)),
  };
}

export class MusixquareServiceControl {
  constructor(state) {
    this.state = state;
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
          this.storage.get(ADMIN_ANNOUNCEMENT_STATE_KEY),
          this.storage.get(ADMIN_ANNOUNCEMENT_REQUESTS_KEY),
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
          this.storage.get(stateKey),
          typeof this.storage.getAlarm === 'function'
            ? this.storage.getAlarm()
            : Promise.resolve(null),
        ]);
        const normalizedAbuseRateState = this.abuseRatePairOnly
          ? normalizeAbuseRatePairState(storedAbuseRateState)
          : normalizeAbuseRateState(storedAbuseRateState);
        if (
          storedAbuseRateState !== undefined &&
          storedAbuseRateState !== null &&
          !normalizedAbuseRateState
        ) {
          if (this.abuseRatePairOnly) this.abuseRatePairStateInvalid = true;
          else this.abuseRateStateInvalid = true;
        }
        if (this.abuseRatePairOnly) this.abuseRatePairState = normalizedAbuseRateState;
        else this.abuseRateState = normalizedAbuseRateState;
        this.abuseRateAlarmAt = Number.isSafeInteger(storedAlarmAt) ? storedAlarmAt : null;
        return;
      }
      const [
        storedState,
        storedRequests,
        storedAnnouncementState,
        storedAnnouncementRequests,
        storedAbuseRateState,
      ] = await Promise.all([
        this.storage.get(SERVICE_CONTROL_STATE_KEY),
        this.storage.get(SERVICE_CONTROL_REQUESTS_KEY),
        this.storage.get(ADMIN_ANNOUNCEMENT_STATE_KEY),
        this.storage.get(ADMIN_ANNOUNCEMENT_REQUESTS_KEY),
        this.storage.get(ABUSE_RATE_STATE_KEY),
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

  async withMutation(callback) {
    const previous = this.mutationTail;
    let release;
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

  response(state = this.serviceStatus, status = 200, extra = {}) {
    return serviceControlJson(
      {
        ...extra,
        serviceStatus: publicServiceControlState(state),
      },
      status,
    );
  }

  async handleAbuseRateConsume(request, idempotent) {
    if (this.abuseRateStateInvalid) {
      return serviceControlJson({ error: 'ABUSE_RATE_STATE_INVALID' }, 503);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
      return serviceControlJson({ error: 'JSON_REQUIRED' }, 415);
    }
    const declared = request.headers.get('content-length');
    if (
      declared !== null &&
      (!/^\d+$/.test(declared.trim()) || Number(declared) > ABUSE_RATE_REQUEST_MAX_BYTES)
    ) {
      return serviceControlJson({ error: 'REQUEST_TOO_LARGE' }, 413);
    }
    const parsed = await readPrivateJsonBody(request, ABUSE_RATE_REQUEST_MAX_BYTES);
    if (parsed.error) return serviceControlJson({ error: parsed.error }, parsed.status);
    const body = parsed.value;
    const expectedKeys = idempotent
      ? ['limit', 'windowMs', 'cost', 'operationId']
      : ['limit', 'windowMs', 'cost'];
    if (
      !hasExactKeys(body, expectedKeys) ||
      !Number.isSafeInteger(body.limit) ||
      body.limit < 1 ||
      body.limit > 1_000_000 ||
      !Number.isSafeInteger(body.windowMs) ||
      body.windowMs < 1_000 ||
      body.windowMs > 24 * 60 * 60 * 1_000 ||
      !Number.isSafeInteger(body.cost) ||
      body.cost < 1 ||
      body.cost > body.limit ||
      (idempotent &&
        (typeof body.operationId !== 'string' ||
          !ABUSE_RATE_OPERATION_ID_RE.test(body.operationId) ||
          body.limit > ABUSE_RATE_OPERATION_HISTORY_LIMIT))
    ) {
      return serviceControlJson({ error: 'INVALID_REQUEST' }, 400);
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
      const replayed = idempotent && operationIds.includes(body.operationId);
      const allowed = replayed || count + body.cost <= body.limit;
      const nextCount = allowed && !replayed ? count + body.cost : count;
      if (allowed && !replayed) {
        const next = {
          v: 2,
          limit: body.limit,
          windowMs: body.windowMs,
          windowStartMs,
          resetAtMs,
          count: nextCount,
          operationIds: idempotent ? [...operationIds, body.operationId] : operationIds,
        };
        await this.storage.put(ABUSE_RATE_STATE_KEY, next);
        this.abuseRateState = next;
      }
      // A Durable Object owns one persistent alarm. The cold load observes its
      // current value, so same-window consumes do not need to overwrite the
      // same alarm; a missing or stale alarm is still repaired fail-closed.
      if (typeof this.storage.setAlarm === 'function' && this.abuseRateAlarmAt !== resetAtMs) {
        await this.storage.setAlarm(resetAtMs);
        this.abuseRateAlarmAt = resetAtMs;
      }
      return serviceControlJson({
        allowed,
        limit: body.limit,
        remaining: Math.max(0, body.limit - nextCount),
        resetAtMs,
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAtMs - nowMs) / 1_000)),
      });
    });
  }

  async handleAbuseRatePairConsume(request) {
    if (this.abuseRatePairStateInvalid) {
      return serviceControlJson({ error: 'ABUSE_RATE_PAIR_STATE_INVALID' }, 503);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
      return serviceControlJson({ error: 'JSON_REQUIRED' }, 415);
    }
    const declared = request.headers.get('content-length');
    if (
      declared !== null &&
      (!/^\d+$/.test(declared.trim()) || Number(declared) > ABUSE_RATE_REQUEST_MAX_BYTES)
    ) {
      return serviceControlJson({ error: 'REQUEST_TOO_LARGE' }, 413);
    }
    const parsed = await readPrivateJsonBody(request, ABUSE_RATE_REQUEST_MAX_BYTES);
    if (parsed.error) return serviceControlJson({ error: parsed.error }, parsed.status);
    const body = parsed.value;
    const secondaryAbsent =
      body?.secondaryIdentity === null &&
      body?.secondaryLimit === null &&
      body?.secondaryCost === null;
    const secondaryValid =
      typeof body?.secondaryIdentity === 'string' &&
      /^[A-Za-z0-9._:-]{1,64}$/.test(body.secondaryIdentity) &&
      Number.isSafeInteger(body.secondaryLimit) &&
      body.secondaryLimit >= 1 &&
      body.secondaryLimit <= ABUSE_RATE_PAIR_PRIMARY_LIMIT &&
      Number.isSafeInteger(body.secondaryCost) &&
      body.secondaryCost >= 1 &&
      body.secondaryCost <= body.secondaryLimit &&
      body.secondaryCost <= body.cost;
    if (
      !hasExactKeys(body, [
        'limit',
        'windowMs',
        'cost',
        'secondaryIdentity',
        'secondaryLimit',
        'secondaryCost',
      ]) ||
      !Number.isSafeInteger(body.limit) ||
      body.limit < 1 ||
      body.limit > ABUSE_RATE_PAIR_PRIMARY_LIMIT ||
      !Number.isSafeInteger(body.windowMs) ||
      body.windowMs < 1_000 ||
      body.windowMs > 24 * 60 * 60 * 1_000 ||
      !Number.isSafeInteger(body.cost) ||
      body.cost < 1 ||
      body.cost > body.limit ||
      (!secondaryAbsent && !secondaryValid)
    ) {
      return serviceControlJson({ error: 'INVALID_REQUEST' }, 400);
    }

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
      const nextPrimaryCount = primaryAllowed ? primaryCount + body.cost : primaryCount;
      const primary = abuseRateProjection(
        primaryAllowed,
        body.limit,
        nextPrimaryCount,
        resetAtMs,
        nowMs,
      );

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

      if (primaryAllowed) {
        const next = {
          v: 1,
          windowMs: body.windowMs,
          windowStartMs,
          resetAtMs,
          primary: { limit: body.limit, count: nextPrimaryCount },
          secondaries: nextSecondaries,
        };
        await this.storage.put(ABUSE_RATE_PAIR_STATE_KEY, next);
        this.abuseRatePairState = next;
      }
      if (typeof this.storage.setAlarm === 'function' && this.abuseRateAlarmAt !== resetAtMs) {
        await this.storage.setAlarm(resetAtMs);
        this.abuseRateAlarmAt = resetAtMs;
      }
      const allowed = primaryAllowed && secondaryAllowed;
      return serviceControlJson({
        allowed,
        deniedBy: !primaryAllowed ? 'primary' : !secondaryAllowed ? 'secondary' : null,
        primary,
        secondary,
      });
    });
  }

  async handleAnnouncementMutation(request) {
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
    if (parsed.error) return serviceControlJson({ error: parsed.error }, parsed.status);
    const body = parsed.value;
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
    const message = typeof body?.message === 'string' ? body.message.trim() : null;
    const expiresAt =
      body?.expiresAt === null || body?.expiresAt === ''
        ? null
        : typeof body?.expiresAt === 'string' && !Number.isNaN(new Date(body.expiresAt).getTime())
          ? new Date(body.expiresAt).toISOString()
          : undefined;
    const baseHistory = Array.isArray(body?.baseHistory)
      ? body.baseHistory.map((entry) => normalizedAdminAnnouncement(entry, { history: true }))
      : null;
    const legacyMigration =
      this.announcementOnly && request.headers.get(ADMIN_ANNOUNCEMENT_MIGRATION_HEADER) === '1';
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
      typeof body.enabled !== 'boolean' ||
      expiresAt === undefined ||
      !Number.isSafeInteger(body.expectedRevision) ||
      body.expectedRevision < 0 ||
      body.expectedRevision >= Number.MAX_SAFE_INTEGER ||
      typeof body.requestId !== 'string' ||
      !SERVICE_CONTROL_REQUEST_ID_RE.test(body.requestId) ||
      !baseHistory ||
      baseHistory.length > ADMIN_ANNOUNCEMENT_HISTORY_LIMIT ||
      baseHistory.some((entry) => entry === null)
    ) {
      return serviceControlJson({ error: 'INVALID_REQUEST' }, 400);
    }

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
      await this.storage.put({
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

  async fetch(request) {
    if (this.ready) await this.ready;
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
    if (request.method === 'GET' && url.pathname === SERVICE_CONTROL_STATUS_PATH) {
      return this.response();
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
    if (parsed.error) return serviceControlJson({ error: parsed.error }, parsed.status);
    const body = parsed.value;
    if (
      !body ||
      typeof body !== 'object' ||
      typeof body.enabled !== 'boolean' ||
      !Number.isSafeInteger(body.expectedRevision) ||
      body.expectedRevision < 0 ||
      typeof body.requestId !== 'string' ||
      !SERVICE_CONTROL_REQUEST_ID_RE.test(body.requestId)
    ) {
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
      await this.storage.put({
        [SERVICE_CONTROL_STATE_KEY]: next,
        [SERVICE_CONTROL_REQUESTS_KEY]: nextRequests,
      });
      this.serviceStatus = next;
      this.requests = nextRequests;
      return this.response(next, 200, { ok: true, changed, replayed: false });
    });
  }

  async alarm() {
    if (this.ready) await this.ready;
    return this.withMutation(async () => {
      const stateKey = this.abuseRatePairOnly ? ABUSE_RATE_PAIR_STATE_KEY : ABUSE_RATE_STATE_KEY;
      const stored = await this.storage.get(stateKey);
      if (stored === undefined || stored === null) {
        if (this.abuseRatePairOnly) this.abuseRatePairState = null;
        else this.abuseRateState = null;
        if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
        this.abuseRateAlarmAt = null;
        return;
      }
      const state = this.abuseRatePairOnly
        ? normalizeAbuseRatePairState(stored)
        : normalizeAbuseRateState(stored);
      if (!state) {
        if (this.abuseRatePairOnly) {
          this.abuseRatePairState = null;
          this.abuseRatePairStateInvalid = true;
        }
        throw new Error('ABUSE_RATE_STATE_INVALID');
      }
      if (this.abuseRatePairOnly) this.abuseRatePairState = state;
      else this.abuseRateState = state;
      if (state.resetAtMs > Date.now()) {
        if (typeof this.storage.setAlarm === 'function') {
          await this.storage.setAlarm(state.resetAtMs);
          this.abuseRateAlarmAt = state.resetAtMs;
        }
        return;
      }
      await this.storage.delete(stateKey);
      if (this.abuseRatePairOnly) this.abuseRatePairState = null;
      else this.abuseRateState = null;
      if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
      this.abuseRateAlarmAt = null;
    });
  }
}
