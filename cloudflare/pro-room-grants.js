import { isProRoomGeneration } from './pro-room-generation.js';

const PUBLIC_ROUTE_RE =
  /^\/api\/pro-grants\/campaigns\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/(session|redeem|setup-link)$/;
const ADMIN_ROUTE_RE =
  /^\/api\/admin\/pro-grants\/campaigns(?:\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/(status|vouchers|revoke))?$/;
const ACCOUNT_ID_RE = /^acct_[A-Za-z0-9_-]{22}$/;
const ROOM_CODE_RE = /^0\d{5}$/;
const VOUCHER_ALPHABET_RE = /^[0-9A-HJKMNP-TV-Z]{20,64}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const BATCH_REQUEST_ID_RE = /^batch_[A-Za-z0-9_-]{22}$/;
const MAX_BODY_BYTES = 32 * 1024;
const REQUEST_BODY_TIMEOUT_MS = 10_000;
const CAMPAIGN_TABLE = 'mxqr_pro_grant_campaigns';
const VOUCHER_TABLE = 'mxqr_pro_grant_vouchers';
const VOUCHER_BATCH_TABLE = 'mxqr_pro_grant_voucher_batches';
const GRANT_TABLE = 'mxqr_pro_grants';
const ALLOCATION_TABLE = 'mxqr_pro_grant_allocations';
const REDEMPTION_TABLE = 'mxqr_pro_grant_redemptions';
const AUDIT_TABLE = 'mxqr_pro_grant_audit';
const ACCOUNT_FENCE_TABLE = 'mxqr_pro_grant_account_fences';
const ENTITLEMENT_TABLE = 'mxqr_pro_account_entitlements';
const ACTIVE_GRANT_STATES = Object.freeze(['pending_activation', 'active', 'suspended']);
const ENTITLEMENT_ACCOUNT_CURRENT_SQL =
  "'reserved','active','suspended','transfer_source_reserved','transfer_source_active','transfer_source_suspended'";
const ENTITLEMENT_ROOM_RESERVED_SQL = "'reserved','active','suspended','orphaned'";
const ENTITLEMENT_TRANSFER_SOURCE_SQL =
  "'transfer_source_reserved','transfer_source_active','transfer_source_suspended','transfer_source_orphaned'";
const ENTITLEMENT_BACKFILL_ACTOR = 'system:entitlement-backfill';
const ENTITLEMENT_BACKFILL_ACTION = 'entitlement.backfill';
const ADMIN_CAMPAIGN_STATUS_TARGETS = new Set(['active', 'paused', 'ended']);
const MUTABLE_VOUCHER_CAMPAIGN_STATES = new Set(['draft', 'scheduled', 'active', 'paused']);
const SAFE_ADMIN_REASON_RE = /^[a-z][a-z0-9_]{2,63}$/;

function responseJson(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      pragma: 'no-cache',
      ...headers,
    },
  });
}

function randomId(prefix) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function keyedDigest(secret, domain, value) {
  if (typeof secret !== 'string' || secret.length < 32) return null;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToBase64Url(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${domain}\u0000${value}`)),
    ),
  );
}

function normalizeVoucherCode(value) {
  const normalized =
    typeof value === 'string'
      ? value
          .trim()
          .toUpperCase()
          .replace(/[\s-]+/g, '')
      : '';
  return VOUCHER_ALPHABET_RE.test(normalized) ? normalized : null;
}

async function first(statement) {
  return typeof statement.first === 'function'
    ? await statement.first()
    : (await statement.all())?.results?.[0] || null;
}

async function all(statement) {
  const result = await statement.all();
  return Array.isArray(result?.results) ? result.results : [];
}

function publicVoucherMappings(rows) {
  return rows.map((row) => ({
    voucherId: row.voucher_id,
    roomCode: row.room_code,
    roomGeneration: Number(row.room_generation),
    status: row.status,
  }));
}

function changeCount(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

function cancelBodyReader(reader, reason) {
  try {
    // A hostile or broken stream may never settle cancellation. Detaching the
    // best-effort promise keeps the bounded error response independent from
    // the transport while still consuming a later rejection.
    Promise.resolve(reader.cancel(reason)).catch(() => {});
  } catch {
    // Cancellation is best-effort; the bounded error response must still win.
  }
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const contentType = String(request.headers.get('content-type') || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) return { error: 'JSON_REQUIRED' };
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length.trim()) || Number(length) > maxBytes)) {
    return { error: 'INVALID_REQUEST' };
  }
  const chunks = [];
  let totalBytes = 0;
  let reader;
  let timeout = null;
  let abort = null;
  try {
    if (request.body) {
      reader = request.body.getReader();
      let stop;
      const stopped = new Promise((resolve) => {
        stop = resolve;
      });
      timeout = setTimeout(() => {
        stop({ kind: 'timeout' });
        cancelBodyReader(reader, 'REQUEST_BODY_TIMEOUT');
      }, REQUEST_BODY_TIMEOUT_MS);
      abort = () => {
        stop({ kind: 'aborted' });
        cancelBodyReader(reader, request.signal.reason);
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener('abort', abort, { once: true });
      while (true) {
        const outcome = await Promise.race([
          reader.read().then(
            (value) => ({ kind: 'read', value }),
            () => ({ kind: 'invalid' }),
          ),
          stopped,
        ]);
        if (outcome.kind === 'invalid') return { error: 'INVALID_REQUEST' };
        if (outcome.kind !== 'read') return { error: 'REQUEST_TIMEOUT' };
        const { done, value } = outcome.value;
        if (done) break;
        if (!(value instanceof Uint8Array) || value.byteLength > maxBytes - totalBytes) {
          cancelBodyReader(reader, 'REQUEST_BODY_TOO_LARGE');
          return { error: 'INVALID_REQUEST' };
        }
        chunks.push(value);
        totalBytes += value.byteLength;
      }
    }
  } catch {
    if (reader) cancelBodyReader(reader, 'REQUEST_BODY_INVALID');
    return { error: 'INVALID_REQUEST' };
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    if (abort) request.signal.removeEventListener('abort', abort);
    try {
      reader?.releaseLock();
    } catch {
      // A host stream can reject lock release after a failed read/cancel.
    }
  }
  try {
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { value }
      : { error: 'INVALID_REQUEST' };
  } catch {
    return { error: 'INVALID_REQUEST' };
  }
}

function sameOriginMutation(request) {
  if (request.method !== 'POST') return true;
  const origin = request.headers.get('origin') || '';
  const fetchSite = String(request.headers.get('sec-fetch-site') || '').toLowerCase();
  return origin === new URL(request.url).origin || (!origin && fetchSite === 'same-origin');
}

function campaignPublicState(row, nowMs) {
  if (!row) return null;
  const startsAt = row.starts_at === null ? null : Number(row.starts_at);
  const endsAt = row.ends_at === null ? null : Number(row.ends_at);
  let status = String(row.status || '');
  if (status === 'active' && Number.isSafeInteger(startsAt) && startsAt > nowMs) {
    status = 'scheduled';
  }
  if (status === 'active' && Number.isSafeInteger(endsAt) && endsAt <= nowMs) status = 'ended';
  return {
    slug: row.slug,
    title: row.title,
    status,
    startsAt,
    endsAt,
    perAccountLimit: Number(row.per_account_limit),
  };
}

function nonNegativeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function campaignVoucherSummary(row) {
  const total = nonNegativeCount(row?.total_count);
  const available = nonNegativeCount(row?.available_count);
  const redeemed = nonNegativeCount(row?.redeemed_count);
  const revoked = nonNegativeCount(row?.revoked_count);
  const roomCount = nonNegativeCount(row?.room_count ?? row?.total_count);
  const firstRoomCode = ROOM_CODE_RE.test(row?.first_room_code || '') ? row.first_room_code : null;
  const lastRoomCode = ROOM_CODE_RE.test(row?.last_room_code || '') ? row.last_room_code : null;
  return {
    counts: { total, available, redeemed, revoked },
    pool: { roomCount, firstRoomCode, lastRoomCode },
  };
}

const CAMPAIGN_SUMMARY_SELECT = `
  SELECT campaign.campaign_id, campaign.slug, campaign.title, campaign.status,
         campaign.starts_at, campaign.ends_at, campaign.per_account_limit,
         campaign.created_at, campaign.updated_at,
         COUNT(voucher.voucher_id) AS total_count,
         SUM(CASE WHEN voucher.status = 'available' THEN 1 ELSE 0 END) AS available_count,
         SUM(CASE WHEN voucher.status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed_count,
         SUM(CASE WHEN voucher.status = 'revoked' THEN 1 ELSE 0 END) AS revoked_count,
         COUNT(voucher.voucher_id) AS room_count,
         MIN(voucher.room_code) AS first_room_code,
         MAX(voucher.room_code) AS last_room_code
    FROM ${CAMPAIGN_TABLE} campaign
    LEFT JOIN ${VOUCHER_TABLE} voucher ON voucher.campaign_id = campaign.campaign_id`;

async function readCampaignSummary(db, campaignId) {
  return first(
    db
      .prepare(
        `${CAMPAIGN_SUMMARY_SELECT}
          WHERE campaign.campaign_id = ?1
          GROUP BY campaign.campaign_id
          LIMIT 1`,
      )
      .bind(campaignId),
  );
}

async function readCampaignList(db) {
  return all(
    db.prepare(
      `${CAMPAIGN_SUMMARY_SELECT}
       GROUP BY campaign.campaign_id
       ORDER BY campaign.created_at DESC, campaign.slug ASC`,
    ),
  );
}

function campaignAdminState(row, nowMs) {
  return {
    campaign: campaignPublicState(row, nowMs),
    ...campaignVoucherSummary(row),
  };
}

function campaignStatusTransitionAllowed(current, requested, endsAt, nowMs) {
  if (current === requested) {
    return requested !== 'active' || endsAt === null || endsAt > nowMs;
  }
  if (requested === 'active') {
    return ['draft', 'paused'].includes(current) && (endsAt === null || endsAt > nowMs);
  }
  if (requested === 'paused') return current === 'active' && (endsAt === null || endsAt > nowMs);
  if (requested === 'ended') return ['draft', 'active', 'paused'].includes(current);
  return false;
}

async function readCampaign(db, slug) {
  return first(
    db
      .prepare(
        `SELECT campaign_id, slug, title, status, starts_at, ends_at,
                per_account_limit, created_at, updated_at
           FROM ${CAMPAIGN_TABLE}
          WHERE slug = ?1 LIMIT 1`,
      )
      .bind(slug),
  );
}

async function readAccountRedemption(db, campaignId, accountId) {
  return first(
    db
      .prepare(
        `SELECT redemption.redemption_id, redemption.status AS redemption_status,
                grant.grant_id, grant.status AS grant_status,
                allocation.allocation_id, allocation.room_code, allocation.room_generation,
                registry.status AS registry_status,
                registry.activation_state
           FROM ${REDEMPTION_TABLE} redemption
           JOIN ${GRANT_TABLE} grant ON grant.grant_id = redemption.grant_id
           JOIN ${ALLOCATION_TABLE} allocation ON allocation.grant_id = grant.grant_id
           JOIN ${VOUCHER_TABLE} voucher ON voucher.voucher_id = redemption.voucher_id
           LEFT JOIN mxqr_pro_room_registry registry
             ON registry.room_code = allocation.room_code
            AND registry.room_generation = allocation.room_generation
          WHERE redemption.campaign_id = ?1 AND redemption.account_id = ?2
          ORDER BY redemption.created_at ASC LIMIT 1`,
      )
      .bind(campaignId, accountId),
  );
}

function normalizedRedemption(row) {
  if (
    !row ||
    !ROOM_CODE_RE.test(row.room_code || '') ||
    !isProRoomGeneration(Number(row.room_generation))
  ) {
    return null;
  }
  return {
    redemptionId: row.redemption_id,
    grantId: row.grant_id,
    status: row.redemption_status,
    grantStatus: row.grant_status,
    roomCode: row.room_code,
    roomGeneration: Number(row.room_generation),
    setupRequired:
      row.redemption_status === 'redeemed' &&
      row.grant_status === 'pending_activation' &&
      row.registry_status === 'registered' &&
      row.activation_state === 'unactivated',
  };
}

function proEntitlementDb(env) {
  return env?.MUSIXQUARE_ADMIN_DB || env?.ADMIN_METRICS_DB;
}

function validEntitlementIdentity(input, accountKey = 'accountId') {
  return (
    ACCOUNT_ID_RE.test(input?.[accountKey] || '') &&
    ROOM_CODE_RE.test(input?.roomCode || '') &&
    isProRoomGeneration(input?.roomGeneration)
  );
}

function entitlementNow(input) {
  return Number.isSafeInteger(input?.nowMs) && input.nowMs >= 0 ? input.nowMs : Date.now();
}

async function readExactEntitlement(db, input) {
  return first(
    db
      .prepare(
        `SELECT entitlement_id, account_id, room_code, room_generation,
                source_kind, source_ref, transfer_request_id, status
           FROM ${ENTITLEMENT_TABLE}
          WHERE account_id = ?1 AND room_code = ?2 AND room_generation = ?3
          ORDER BY CASE
            WHEN status IN (${ENTITLEMENT_ACCOUNT_CURRENT_SQL}) THEN 0
            WHEN status IN (${ENTITLEMENT_ROOM_RESERVED_SQL}) THEN 1
            ELSE 2
          END, entitlement_id DESC
          LIMIT 1`,
      )
      .bind(input.accountId, input.roomCode, input.roomGeneration),
  );
}

async function accountHasCurrentProEntitlement(db, accountId) {
  const row = await first(
    db
      .prepare(
        `SELECT 1 AS current
           FROM ${ENTITLEMENT_TABLE}
          WHERE account_id = ?1 AND status IN (${ENTITLEMENT_ACCOUNT_CURRENT_SQL})
          LIMIT 1`,
      )
      .bind(accountId),
  );
  return Number(row?.current) === 1;
}

async function hasCompletedOwnerEntitlementBackfill(db) {
  const row = await first(
    db.prepare(
      `SELECT 1 AS complete FROM ${AUDIT_TABLE}
        WHERE actor_id = '${ENTITLEMENT_BACKFILL_ACTOR}'
          AND action = '${ENTITLEMENT_BACKFILL_ACTION}'
          AND result = 'complete'
        LIMIT 1`,
    ),
  );
  return Number(row?.complete) === 1;
}

export async function markProRoomOwnerEntitlementBackfillComplete(env, nowMs = Date.now()) {
  const db = proEntitlementDb(env);
  if (!db?.prepare || !db?.batch || !Number.isSafeInteger(nowMs) || nowMs < 0) return false;
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO ${AUDIT_TABLE} (actor_id, action, result, created_at)
           SELECT '${ENTITLEMENT_BACKFILL_ACTOR}', '${ENTITLEMENT_BACKFILL_ACTION}',
                  'complete', ?1
            WHERE NOT EXISTS (
                    SELECT 1 FROM ${AUDIT_TABLE}
                     WHERE actor_id = '${ENTITLEMENT_BACKFILL_ACTOR}'
                       AND action = '${ENTITLEMENT_BACKFILL_ACTION}'
                       AND result = 'complete'
                  )`,
        )
        .bind(nowMs),
    ]);
    return hasCompletedOwnerEntitlementBackfill(db);
  } catch {
    return false;
  }
}

export async function canAccountReceiveProRoomEntitlement(env, input) {
  const db = proEntitlementDb(env);
  if (!db?.prepare || !ACCOUNT_ID_RE.test(input?.accountId || '')) return false;
  try {
    const blocker = await first(
      db
        .prepare(
          `SELECT 1 AS blocked
            WHERE NOT EXISTS (
                    SELECT 1 FROM ${AUDIT_TABLE}
                     WHERE actor_id = '${ENTITLEMENT_BACKFILL_ACTOR}'
                       AND action = '${ENTITLEMENT_BACKFILL_ACTION}'
                       AND result = 'complete'
                  )
               OR EXISTS (
                    SELECT 1 FROM ${ACCOUNT_FENCE_TABLE} WHERE account_id = ?1
                  )
               OR EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE}
                     WHERE account_id = ?1
                       AND status IN (${ENTITLEMENT_ACCOUNT_CURRENT_SQL})
                  )
           LIMIT 1`,
        )
        .bind(input.accountId),
    );
    return Number(blocker?.blocked || 0) === 0;
  } catch {
    return false;
  }
}

/**
 * Called only after the room DO has verified the activation claim and account
 * assertion. The single conditional insert is the cross-D1 serialization
 * point; preflight authorization alone is never treated as a reservation.
 */
export async function reserveProRoomActivationEntitlement(env, input) {
  const db = proEntitlementDb(env);
  if (!db?.prepare || !db?.batch || !validEntitlementIdentity(input)) return false;
  const nowMs = entitlementNow(input);
  try {
    const existing = await readExactEntitlement(db, input);
    if (
      existing &&
      ['grant', 'legacy_activation'].includes(existing.source_kind) &&
      existing.status === 'reserved'
    ) {
      return true;
    }

    const sourceRef = `activation:${input.roomCode}:${input.roomGeneration}:${input.accountId}`;
    await db.batch([
      db
        .prepare(
          `INSERT INTO ${ENTITLEMENT_TABLE}
             (account_id, room_code, room_generation, source_kind, source_ref,
              transfer_request_id, status, created_at, updated_at)
           SELECT ?1, ?2, ?3, 'legacy_activation', ?4, NULL, 'reserved', ?5, ?5
            WHERE EXISTS (
                    SELECT 1 FROM ${AUDIT_TABLE}
                     WHERE actor_id = '${ENTITLEMENT_BACKFILL_ACTOR}'
                       AND action = '${ENTITLEMENT_BACKFILL_ACTION}'
                       AND result = 'complete'
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM ${ACCOUNT_FENCE_TABLE}
                     WHERE account_id = ?1
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE}
                     WHERE account_id = ?1
                       AND status IN (${ENTITLEMENT_ACCOUNT_CURRENT_SQL})
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE}
                     WHERE room_code = ?2 AND room_generation = ?3
                       AND status IN (${ENTITLEMENT_ROOM_RESERVED_SQL})
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM ${VOUCHER_TABLE}
                     WHERE room_code = ?2 AND room_generation = ?3
                       AND status = 'available'
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE}
                     WHERE source_kind = 'legacy_activation' AND source_ref = ?4
                  )`,
        )
        .bind(input.accountId, input.roomCode, input.roomGeneration, sourceRef, nowMs),
    ]);
    const reserved = await readExactEntitlement(db, input);
    return reserved?.source_kind === 'legacy_activation' && reserved.status === 'reserved';
  } catch {
    try {
      const raced = await readExactEntitlement(db, input);
      return (
        ['grant', 'legacy_activation'].includes(raced?.source_kind) && raced?.status === 'reserved'
      );
    } catch {
      return false;
    }
  }
}

export async function finalizeProRoomActivationEntitlement(env, input) {
  const db = env?.MUSIXQUARE_ADMIN_DB || env?.ADMIN_METRICS_DB;
  if (!db?.prepare || !db?.batch || !validEntitlementIdentity(input)) {
    return false;
  }
  const nowMs = entitlementNow(input);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE ${ENTITLEMENT_TABLE}
              SET status = 'active', updated_at = ?4
            WHERE account_id = ?1 AND room_code = ?2 AND room_generation = ?3
              AND source_kind IN ('grant', 'legacy_activation')
              AND status = 'reserved'`,
        )
        .bind(input.accountId, input.roomCode, input.roomGeneration, nowMs),
      db
        .prepare(
          `UPDATE ${GRANT_TABLE}
              SET status = 'active', updated_at = ?4
            WHERE account_id = ?1 AND product_code = 'pro_room'
              AND status = 'pending_activation'
              AND grant_id IN (
                SELECT entitlement.source_ref
                  FROM ${ENTITLEMENT_TABLE} entitlement
                 WHERE entitlement.account_id = ?1
                   AND entitlement.room_code = ?2
                   AND entitlement.room_generation = ?3
                   AND entitlement.source_kind = 'grant'
                   AND entitlement.status = 'active'
              )`,
        )
        .bind(input.accountId, input.roomCode, input.roomGeneration, nowMs),
      db
        .prepare(
          `UPDATE ${ALLOCATION_TABLE}
              SET status = 'active', updated_at = ?4
            WHERE room_code = ?2 AND room_generation = ?3 AND status = 'reserved'
              AND grant_id IN (
                SELECT grant_id FROM ${GRANT_TABLE} WHERE account_id = ?1 AND status = 'active'
              )`,
        )
        .bind(input.accountId, input.roomCode, input.roomGeneration, nowMs),
      db
        .prepare(
          `UPDATE ${REDEMPTION_TABLE}
              SET status = 'fulfilled', updated_at = ?4
            WHERE account_id = ?1 AND status = 'redeemed'
              AND grant_id IN (
                SELECT grant_id FROM ${GRANT_TABLE}
                 WHERE account_id = ?1 AND grant_id IN (
                   SELECT grant_id FROM ${ALLOCATION_TABLE}
                    WHERE room_code = ?2 AND room_generation = ?3
                 )
              )`,
        )
        .bind(input.accountId, input.roomCode, input.roomGeneration, nowMs),
      db
        .prepare(
          `INSERT INTO ${AUDIT_TABLE}
             (actor_id, action, result, campaign_id, voucher_id, grant_id,
              allocation_id, redemption_id, room_code, room_generation, created_at)
           SELECT ?1, 'grant.activate', 'fulfilled', redemption.campaign_id,
                  redemption.voucher_id, redemption.grant_id, allocation.allocation_id,
                  redemption.redemption_id, ?2, ?3, ?4
             FROM ${REDEMPTION_TABLE} redemption
             JOIN ${ALLOCATION_TABLE} allocation ON allocation.grant_id = redemption.grant_id
            WHERE redemption.account_id = ?1
              AND redemption.grant_id IN (
                SELECT grant_id FROM ${GRANT_TABLE}
                 WHERE account_id = ?1 AND grant_id IN (
                   SELECT grant_id FROM ${ALLOCATION_TABLE}
                    WHERE room_code = ?2 AND room_generation = ?3
                 )
              )
              AND NOT EXISTS (
                SELECT 1 FROM ${AUDIT_TABLE} prior
                 WHERE prior.action = 'grant.activate'
                   AND prior.grant_id = redemption.grant_id
                   AND prior.result = 'fulfilled'
              )
            LIMIT 1`,
        )
        .bind(input.accountId, input.roomCode, input.roomGeneration, nowMs),
    ]);
    const finalized = await readExactEntitlement(db, input);
    return (
      ['grant', 'legacy_activation'].includes(finalized?.source_kind) &&
      finalized?.status === 'active'
    );
  } catch {
    return false;
  }
}

export async function finalizeProGrantActivation(env, input) {
  return finalizeProRoomActivationEntitlement(env, input);
}

export async function upsertProRoomOwnerEntitlement(env, input) {
  const db = proEntitlementDb(env);
  if (
    !db?.prepare ||
    !db?.batch ||
    !validEntitlementIdentity(input) ||
    !['active', 'suspended'].includes(input?.status) ||
    typeof input?.sourceRef !== 'string' ||
    input.sourceRef.length < 1 ||
    input.sourceRef.length > 128
  ) {
    return false;
  }
  const nowMs = entitlementNow(input);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE ${ENTITLEMENT_TABLE}
              SET status = ?4, updated_at = ?5
            WHERE account_id = ?1 AND room_code = ?2 AND room_generation = ?3
              AND source_kind IN ('grant', 'legacy_activation', 'owner_transfer')
              AND status IN ('reserved', 'active', 'suspended')`,
        )
        .bind(input.accountId, input.roomCode, input.roomGeneration, input.status, nowMs),
      db
        .prepare(
          `INSERT INTO ${ENTITLEMENT_TABLE}
             (account_id, room_code, room_generation, source_kind, source_ref,
              transfer_request_id, status, created_at, updated_at)
           SELECT ?1, ?2, ?3, 'legacy_activation', ?4, NULL, ?5, ?6, ?6
            WHERE NOT EXISTS (
                    SELECT 1 FROM ${ACCOUNT_FENCE_TABLE} WHERE account_id = ?1
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE}
                     WHERE account_id = ?1
                       AND status IN (${ENTITLEMENT_ACCOUNT_CURRENT_SQL})
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE}
                     WHERE room_code = ?2 AND room_generation = ?3
                       AND status IN (${ENTITLEMENT_ROOM_RESERVED_SQL})
                  )`,
        )
        .bind(
          input.accountId,
          input.roomCode,
          input.roomGeneration,
          input.sourceRef,
          input.status,
          nowMs,
        ),
    ]);
    const current = await readExactEntitlement(db, input);
    return current?.status === input.status;
  } catch {
    return false;
  }
}

/**
 * Exact-room preflight for an operator-owned authority removal. This is a
 * releasing operation, so it deliberately does not depend on the global
 * owner-backfill marker. It must never adopt a transfer that is already in
 * flight or infer ownership from another room belonging to the same account.
 */
export async function canOrphanProRoomOwnerEntitlement(env, input) {
  const db = proEntitlementDb(env);
  if (!db?.prepare || !validEntitlementIdentity(input)) return false;
  try {
    const row = await first(
      db
        .prepare(
          `SELECT 1 AS allowed
             FROM ${ENTITLEMENT_TABLE} entitlement
            WHERE entitlement.account_id = ?1
              AND entitlement.room_code = ?2
              AND entitlement.room_generation = ?3
              AND entitlement.status IN ('active', 'suspended', 'orphaned')
              AND NOT EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE} transfer
                     WHERE transfer.room_code = ?2
                       AND transfer.room_generation = ?3
                       AND transfer.status IN (
                         'transfer_source_reserved',
                         'transfer_source_active',
                         'transfer_source_suspended',
                         'transfer_source_orphaned',
                         'transfer_target_pending'
                       )
                  )
            LIMIT 1`,
        )
        .bind(input.accountId, input.roomCode, input.roomGeneration),
    );
    return Number(row?.allowed) === 1;
  } catch {
    return false;
  }
}

/**
 * Release exactly one canonical owner while retaining the room incarnation.
 * `orphaned` is non-current for the account index but remains reserved by the
 * room index, and is already a supported source for a later ownership
 * transfer. Grant-backed acquisition rows follow the same exact grant only;
 * the consumed voucher is immutable and intentionally remains consumed.
 */
export async function orphanProRoomOwnerEntitlement(env, input) {
  const db = proEntitlementDb(env);
  if (!db?.prepare || !db?.batch || !validEntitlementIdentity(input)) return false;
  if (!(await canOrphanProRoomOwnerEntitlement(env, input))) return false;
  const nowMs = entitlementNow(input);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE ${ENTITLEMENT_TABLE}
              SET status = 'orphaned', updated_at = ?4
            WHERE account_id = ?1 AND room_code = ?2 AND room_generation = ?3
              AND status IN ('active', 'suspended')
              AND NOT EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE} transfer
                     WHERE transfer.room_code = ?2
                       AND transfer.room_generation = ?3
                       AND transfer.status IN (
                         'transfer_source_reserved',
                         'transfer_source_active',
                         'transfer_source_suspended',
                         'transfer_source_orphaned',
                         'transfer_target_pending'
                       )
                  )`,
        )
        .bind(input.accountId, input.roomCode, input.roomGeneration, nowMs),
      db
        .prepare(
          `UPDATE ${GRANT_TABLE}
              SET status = 'orphaned', updated_at = ?4
            WHERE grant_id IN (
                  SELECT source_ref FROM ${ENTITLEMENT_TABLE}
                   WHERE account_id = ?1 AND room_code = ?2 AND room_generation = ?3
                     AND source_kind = 'grant' AND status = 'orphaned'
                )
              AND status IN ('pending_activation', 'active', 'suspended')`,
        )
        .bind(input.accountId, input.roomCode, input.roomGeneration, nowMs),
      db
        .prepare(
          `UPDATE ${ALLOCATION_TABLE}
              SET status = 'orphaned', updated_at = ?4
            WHERE room_code = ?2 AND room_generation = ?3
              AND grant_id IN (
                  SELECT source_ref FROM ${ENTITLEMENT_TABLE}
                   WHERE account_id = ?1 AND room_code = ?2 AND room_generation = ?3
                     AND source_kind = 'grant' AND status = 'orphaned'
                )
              AND status IN ('reserved', 'active', 'suspended')`,
        )
        .bind(input.accountId, input.roomCode, input.roomGeneration, nowMs),
      db
        .prepare(
          `UPDATE ${REDEMPTION_TABLE}
              SET status = 'orphaned', updated_at = ?4
            WHERE account_id = ?1
              AND grant_id IN (
                  SELECT source_ref FROM ${ENTITLEMENT_TABLE}
                   WHERE account_id = ?1 AND room_code = ?2 AND room_generation = ?3
                     AND source_kind = 'grant' AND status = 'orphaned'
                )
              AND status IN ('redeemed', 'fulfilled')`,
        )
        .bind(input.accountId, input.roomCode, input.roomGeneration, nowMs),
    ]);

    const exact = await readExactEntitlement(db, input);
    if (
      exact?.account_id !== input.accountId ||
      exact?.room_code !== input.roomCode ||
      Number(exact?.room_generation) !== input.roomGeneration ||
      exact?.status !== 'orphaned' ||
      !(await canOrphanProRoomOwnerEntitlement(env, input))
    ) {
      return false;
    }
    if (exact.source_kind !== 'grant') return true;

    const lineage = await first(
      db
        .prepare(
          `SELECT
             EXISTS (
               SELECT 1 FROM ${GRANT_TABLE}
                WHERE grant_id = ?4 AND account_id = ?1 AND status = 'orphaned'
             ) AS grant_orphaned,
             EXISTS (
               SELECT 1 FROM ${ALLOCATION_TABLE}
                WHERE grant_id = ?4 AND room_code = ?2 AND room_generation = ?3
                  AND status = 'orphaned'
             ) AS allocation_orphaned,
             EXISTS (
               SELECT 1 FROM ${REDEMPTION_TABLE}
                WHERE grant_id = ?4 AND account_id = ?1 AND status = 'orphaned'
             ) AS redemption_orphaned`,
        )
        .bind(input.accountId, input.roomCode, input.roomGeneration, exact.source_ref),
    );
    return (
      Number(lineage?.grant_orphaned) === 1 &&
      Number(lineage?.allocation_orphaned) === 1 &&
      Number(lineage?.redemption_orphaned) === 1
    );
  } catch {
    return false;
  }
}

async function readOwnershipTransferTarget(db, input) {
  return first(
    db
      .prepare(
        `SELECT entitlement_id, account_id, room_code, room_generation,
                source_kind, source_ref, transfer_request_id, status
           FROM ${ENTITLEMENT_TABLE}
          WHERE source_kind = 'owner_transfer' AND source_ref = ?1
          LIMIT 1`,
      )
      .bind(input.requestId),
  );
}

function ownershipTransferTargetMatches(row, input) {
  return (
    row?.account_id === input.targetAccountId &&
    row?.room_code === input.roomCode &&
    Number(row?.room_generation) === input.roomGeneration &&
    row?.transfer_request_id === input.requestId
  );
}

export async function reserveProRoomOwnershipTransferEntitlement(env, input) {
  const db = proEntitlementDb(env);
  if (
    !db?.prepare ||
    !db?.batch ||
    !validEntitlementIdentity(input, 'targetAccountId') ||
    !REQUEST_ID_RE.test(input?.requestId || '')
  ) {
    return false;
  }
  const nowMs = entitlementNow(input);
  try {
    const existing = await readOwnershipTransferTarget(db, input);
    if (existing) {
      return (
        ownershipTransferTargetMatches(existing, input) &&
        ['reserved', 'active'].includes(existing.status)
      );
    }

    await db.batch([
      // The non-current target row lets a source entitlement on this room
      // remain inside its unique indexes until all target-side guards pass.
      db
        .prepare(
          `INSERT INTO ${ENTITLEMENT_TABLE}
             (account_id, room_code, room_generation, source_kind, source_ref,
              transfer_request_id, status, created_at, updated_at)
           SELECT ?1, ?2, ?3, 'owner_transfer', ?4, ?4,
                  'transfer_target_pending', ?5, ?5
            WHERE EXISTS (
                    SELECT 1 FROM ${AUDIT_TABLE}
                     WHERE actor_id = '${ENTITLEMENT_BACKFILL_ACTOR}'
                       AND action = '${ENTITLEMENT_BACKFILL_ACTION}'
                       AND result = 'complete'
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM ${ACCOUNT_FENCE_TABLE} WHERE account_id = ?1
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE}
                     WHERE source_kind = 'owner_transfer' AND source_ref = ?4
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE}
                     WHERE account_id = ?1
                       AND status IN (${ENTITLEMENT_ACCOUNT_CURRENT_SQL})
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE}
                     WHERE account_id = ?1
                       AND room_code = ?2 AND room_generation = ?3
                       AND status IN (${ENTITLEMENT_ROOM_RESERVED_SQL})
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE}
                     WHERE room_code = ?2 AND room_generation = ?3
                       AND source_kind = 'owner_transfer' AND status = 'reserved'
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE}
                     WHERE room_code = ?2 AND room_generation = ?3
                       AND status IN (
                         'transfer_source_reserved',
                         'transfer_source_active',
                         'transfer_source_suspended',
                         'transfer_source_orphaned',
                         'transfer_target_pending'
                       )
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM ${VOUCHER_TABLE}
                     WHERE room_code = ?2 AND room_generation = ?3
                       AND status = 'available'
                  )`,
        )
        .bind(input.targetAccountId, input.roomCode, input.roomGeneration, input.requestId, nowMs),
      db
        .prepare(
          `UPDATE ${ENTITLEMENT_TABLE}
                  SET status = CASE status
                    WHEN 'reserved' THEN 'transfer_source_reserved'
                    WHEN 'active' THEN 'transfer_source_active'
                    WHEN 'suspended' THEN 'transfer_source_suspended'
                    ELSE 'transfer_source_orphaned'
                  END,
                  transfer_request_id = ?4,
                  updated_at = ?5
            WHERE room_code = ?2 AND room_generation = ?3
              AND account_id <> ?1
              AND status IN ('reserved', 'active', 'suspended', 'orphaned')
              AND (
                    source_kind IN ('grant', 'legacy_activation')
                    OR (
                      source_kind = 'owner_transfer'
                      AND status IN ('active', 'suspended', 'orphaned')
                    )
                  )
              AND EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE} target
                     WHERE target.source_kind = 'owner_transfer'
                       AND target.source_ref = ?4
                       AND target.account_id = ?1
                       AND target.room_code = ?2
                       AND target.room_generation = ?3
                       AND target.status = 'transfer_target_pending'
                  )`,
        )
        .bind(input.targetAccountId, input.roomCode, input.roomGeneration, input.requestId, nowMs),
      db
        .prepare(
          `UPDATE ${ENTITLEMENT_TABLE}
              SET status = 'reserved', updated_at = ?5
            WHERE source_kind = 'owner_transfer' AND source_ref = ?4
              AND account_id = ?1 AND room_code = ?2 AND room_generation = ?3
              AND status = 'transfer_target_pending'
              AND NOT EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE} current_account
                     WHERE current_account.account_id = ?1
                       AND current_account.status IN (${ENTITLEMENT_ACCOUNT_CURRENT_SQL})
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE} current_room
                     WHERE current_room.room_code = ?2
                       AND current_room.room_generation = ?3
                       AND current_room.status IN (${ENTITLEMENT_ROOM_RESERVED_SQL})
                  )
              AND NOT EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE} other_transfer
                     WHERE other_transfer.room_code = ?2
                       AND other_transfer.room_generation = ?3
                       AND other_transfer.status IN (${ENTITLEMENT_TRANSFER_SOURCE_SQL})
                       AND other_transfer.transfer_request_id <> ?4
                  )`,
        )
        .bind(input.targetAccountId, input.roomCode, input.roomGeneration, input.requestId, nowMs),
    ]);
    const reserved = await readOwnershipTransferTarget(db, input);
    return ownershipTransferTargetMatches(reserved, input) && reserved?.status === 'reserved';
  } catch {
    try {
      const raced = await readOwnershipTransferTarget(db, input);
      return (
        ownershipTransferTargetMatches(raced, input) &&
        ['reserved', 'active'].includes(raced?.status)
      );
    } catch {
      return false;
    }
  }
}

export async function finalizeProRoomOwnershipTransferEntitlement(env, input) {
  const db = proEntitlementDb(env);
  if (
    !db?.prepare ||
    !db?.batch ||
    !validEntitlementIdentity(input, 'targetAccountId') ||
    !REQUEST_ID_RE.test(input?.requestId || '')
  ) {
    return false;
  }
  const nowMs = entitlementNow(input);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE ${ENTITLEMENT_TABLE}
              SET status = 'transferred', updated_at = ?5
            WHERE room_code = ?2 AND room_generation = ?3
              AND transfer_request_id = ?4
              AND status IN (${ENTITLEMENT_TRANSFER_SOURCE_SQL})
              AND EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE} target
                     WHERE target.source_kind = 'owner_transfer'
                       AND target.source_ref = ?4
                       AND target.account_id = ?1
                       AND target.room_code = ?2
                       AND target.room_generation = ?3
                       AND target.status IN ('reserved', 'active', 'orphaned')
                  )`,
        )
        .bind(input.targetAccountId, input.roomCode, input.roomGeneration, input.requestId, nowMs),
      db
        .prepare(
          `UPDATE ${GRANT_TABLE}
              SET status = 'revoked', updated_at = ?5
            WHERE grant_id IN (
              SELECT source.source_ref
                FROM ${ENTITLEMENT_TABLE} source
               WHERE source.room_code = ?2 AND source.room_generation = ?3
                 AND source.transfer_request_id = ?4
                 AND source.source_kind = 'grant'
                 AND source.status = 'transferred'
                 AND EXISTS (
                       SELECT 1 FROM ${ENTITLEMENT_TABLE} target
                        WHERE target.source_kind = 'owner_transfer'
                          AND target.source_ref = ?4
                          AND target.account_id = ?1
                          AND target.room_code = ?2
                          AND target.room_generation = ?3
                          AND target.status IN ('reserved', 'active', 'orphaned')
                     )
            )
              AND status <> 'revoked'`,
        )
        .bind(input.targetAccountId, input.roomCode, input.roomGeneration, input.requestId, nowMs),
      db
        .prepare(
          `UPDATE ${ALLOCATION_TABLE}
              SET status = 'revoked', updated_at = ?5
            WHERE room_code = ?2 AND room_generation = ?3
              AND grant_id IN (
                    SELECT source.source_ref
                      FROM ${ENTITLEMENT_TABLE} source
                     WHERE source.room_code = ?2 AND source.room_generation = ?3
                       AND source.transfer_request_id = ?4
                       AND source.source_kind = 'grant'
                       AND source.status = 'transferred'
                       AND EXISTS (
                             SELECT 1 FROM ${ENTITLEMENT_TABLE} target
                              WHERE target.source_kind = 'owner_transfer'
                                AND target.source_ref = ?4
                                AND target.account_id = ?1
                                AND target.room_code = ?2
                                AND target.room_generation = ?3
                                AND target.status IN ('reserved', 'active', 'orphaned')
                           )
                  )
              AND status <> 'revoked'`,
        )
        .bind(input.targetAccountId, input.roomCode, input.roomGeneration, input.requestId, nowMs),
      db
        .prepare(
          `UPDATE ${REDEMPTION_TABLE}
              SET status = 'revoked', updated_at = ?5
            WHERE grant_id IN (
              SELECT source.source_ref
                FROM ${ENTITLEMENT_TABLE} source
               WHERE source.room_code = ?2 AND source.room_generation = ?3
                 AND source.transfer_request_id = ?4
                 AND source.source_kind = 'grant'
                 AND source.status = 'transferred'
                 AND EXISTS (
                       SELECT 1 FROM ${ENTITLEMENT_TABLE} target
                        WHERE target.source_kind = 'owner_transfer'
                          AND target.source_ref = ?4
                          AND target.account_id = ?1
                          AND target.room_code = ?2
                          AND target.room_generation = ?3
                          AND target.status IN ('reserved', 'active', 'orphaned')
                     )
            )
              AND status <> 'revoked'`,
        )
        .bind(input.targetAccountId, input.roomCode, input.roomGeneration, input.requestId, nowMs),
      db
        .prepare(
          `UPDATE ${ENTITLEMENT_TABLE}
              SET status = CASE
                    WHEN EXISTS (
                      SELECT 1 FROM ${ACCOUNT_FENCE_TABLE} fence
                       WHERE fence.account_id = ?1
                    ) THEN 'orphaned'
                    ELSE 'active'
                  END,
                  updated_at = ?5
            WHERE source_kind = 'owner_transfer' AND source_ref = ?4
              AND account_id = ?1 AND room_code = ?2 AND room_generation = ?3
              AND status = 'reserved'`,
        )
        .bind(input.targetAccountId, input.roomCode, input.roomGeneration, input.requestId, nowMs),
    ]);
    const target = await readOwnershipTransferTarget(db, input);
    return (
      ownershipTransferTargetMatches(target, input) &&
      ['active', 'orphaned'].includes(target?.status)
    );
  } catch {
    return false;
  }
}

export async function abortProRoomOwnershipTransferEntitlement(env, input) {
  const db = proEntitlementDb(env);
  if (
    !db?.prepare ||
    !db?.batch ||
    !validEntitlementIdentity(input, 'targetAccountId') ||
    !REQUEST_ID_RE.test(input?.requestId || '')
  ) {
    return false;
  }
  const nowMs = entitlementNow(input);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE ${ENTITLEMENT_TABLE}
              SET status = 'revoked', updated_at = ?5
            WHERE source_kind = 'owner_transfer' AND source_ref = ?4
              AND account_id = ?1 AND room_code = ?2 AND room_generation = ?3
              AND status IN ('transfer_target_pending', 'reserved', 'orphaned')`,
        )
        .bind(input.targetAccountId, input.roomCode, input.roomGeneration, input.requestId, nowMs),
      db
        .prepare(
          `UPDATE ${ENTITLEMENT_TABLE}
              SET status = CASE status
                    WHEN 'transfer_source_reserved' THEN 'reserved'
                    WHEN 'transfer_source_active' THEN 'active'
                    WHEN 'transfer_source_suspended' THEN 'suspended'
                    ELSE 'orphaned'
                  END,
                  transfer_request_id = CASE
                    WHEN source_kind = 'owner_transfer' THEN source_ref
                    ELSE NULL
                  END,
                  updated_at = ?5
            WHERE room_code = ?2 AND room_generation = ?3
              AND transfer_request_id = ?4
              AND status IN (${ENTITLEMENT_TRANSFER_SOURCE_SQL})
              AND EXISTS (
                    SELECT 1 FROM ${ENTITLEMENT_TABLE} target
                     WHERE target.source_kind = 'owner_transfer'
                       AND target.source_ref = ?4
                       AND target.account_id = ?1
                       AND target.room_code = ?2
                       AND target.room_generation = ?3
                       AND target.status = 'revoked'
                  )`,
        )
        .bind(input.targetAccountId, input.roomCode, input.roomGeneration, input.requestId, nowMs),
    ]);
    const target = await readOwnershipTransferTarget(db, input);
    if (!ownershipTransferTargetMatches(target, input) || target?.status !== 'revoked')
      return false;
    const source = await first(
      db
        .prepare(
          `SELECT 1 AS pending FROM ${ENTITLEMENT_TABLE}
            WHERE room_code = ?1 AND room_generation = ?2
              AND transfer_request_id = ?3
              AND status IN (${ENTITLEMENT_TRANSFER_SOURCE_SQL})
            LIMIT 1`,
        )
        .bind(input.roomCode, input.roomGeneration, input.requestId),
    );
    return Number(source?.pending || 0) === 0;
  } catch {
    return false;
  }
}

export async function revokeProRoomEntitlement(env, input) {
  const db = proEntitlementDb(env);
  if (
    !db?.prepare ||
    !db?.batch ||
    !ROOM_CODE_RE.test(input?.roomCode || '') ||
    !isProRoomGeneration(input?.roomGeneration) ||
    (input?.accountId !== undefined && !ACCOUNT_ID_RE.test(input.accountId || ''))
  ) {
    return false;
  }
  const nowMs = entitlementNow(input);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE ${ENTITLEMENT_TABLE}
              SET status = 'revoked', updated_at = ?4
            WHERE room_code = ?1 AND room_generation = ?2
              AND (?3 IS NULL OR account_id = ?3)
              AND status IN (
                'reserved', 'active', 'suspended', 'orphaned',
                'transfer_source_reserved', 'transfer_source_active',
                'transfer_source_suspended', 'transfer_source_orphaned',
                'transfer_target_pending'
              )`,
        )
        .bind(input.roomCode, input.roomGeneration, input.accountId ?? null, nowMs),
      db
        .prepare(
          `UPDATE ${GRANT_TABLE}
              SET status = 'revoked', updated_at = ?4
            WHERE grant_id IN (
              SELECT source_ref FROM ${ENTITLEMENT_TABLE}
               WHERE room_code = ?1 AND room_generation = ?2
                 AND (?3 IS NULL OR account_id = ?3)
                 AND source_kind = 'grant' AND status = 'revoked'
            )
              AND status IN ('pending_activation', 'active', 'suspended', 'orphaned')`,
        )
        .bind(input.roomCode, input.roomGeneration, input.accountId ?? null, nowMs),
      db
        .prepare(
          `UPDATE ${ALLOCATION_TABLE}
              SET status = 'revoked', updated_at = ?4
            WHERE room_code = ?1 AND room_generation = ?2
              AND grant_id IN (SELECT grant_id FROM ${GRANT_TABLE} WHERE status = 'revoked')
              AND status <> 'revoked'`,
        )
        .bind(input.roomCode, input.roomGeneration, input.accountId ?? null, nowMs),
      db
        .prepare(
          `UPDATE ${REDEMPTION_TABLE}
              SET status = 'revoked', updated_at = ?4
            WHERE grant_id IN (
              SELECT grant_id FROM ${ALLOCATION_TABLE}
               WHERE room_code = ?1 AND room_generation = ?2 AND status = 'revoked'
            )
              AND (?3 IS NULL OR account_id = ?3)
              AND status <> 'revoked'`,
        )
        .bind(input.roomCode, input.roomGeneration, input.accountId ?? null, nowMs),
      db
        .prepare(
          `UPDATE ${VOUCHER_TABLE}
              SET status = 'revoked', updated_at = ?4
            WHERE room_code = ?1 AND room_generation = ?2
              AND status = 'available'`,
        )
        .bind(input.roomCode, input.roomGeneration, input.accountId ?? null, nowMs),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function orphanAccountProGrants(env, accountId, nowMs = Date.now()) {
  const db = env?.MUSIXQUARE_ADMIN_DB || env?.ADMIN_METRICS_DB;
  if (!db?.prepare || !db?.batch || !ACCOUNT_ID_RE.test(accountId || '')) return false;
  try {
    await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO ${ACCOUNT_FENCE_TABLE} (account_id, reason, created_at)
           VALUES (?1, 'account_deleted', ?2)`,
        )
        .bind(accountId, nowMs),
      db
        .prepare(
          `UPDATE ${ENTITLEMENT_TABLE}
              SET status = CASE
                    WHEN status IN (${ENTITLEMENT_TRANSFER_SOURCE_SQL})
                      THEN 'transfer_source_orphaned'
                    ELSE 'orphaned'
                  END,
                  updated_at = ?2
            WHERE account_id = ?1
              AND status IN (${ENTITLEMENT_ACCOUNT_CURRENT_SQL})`,
        )
        .bind(accountId, nowMs),
      db
        .prepare(
          `UPDATE ${GRANT_TABLE}
              SET status = 'orphaned', updated_at = ?2
            WHERE account_id = ?1 AND status IN ('pending_activation','active','suspended')`,
        )
        .bind(accountId, nowMs),
      db
        .prepare(
          `UPDATE ${ALLOCATION_TABLE}
              SET status = 'orphaned', updated_at = ?2
            WHERE status IN ('reserved','active','suspended')
              AND grant_id IN (SELECT grant_id FROM ${GRANT_TABLE} WHERE account_id = ?1)`,
        )
        .bind(accountId, nowMs),
      db
        .prepare(
          `UPDATE ${REDEMPTION_TABLE}
              SET status = 'orphaned', updated_at = ?2
            WHERE account_id = ?1 AND status IN ('redeemed','fulfilled')`,
        )
        .bind(accountId, nowMs),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function reconcileProGrantLifecycle(env, dependencies, options = {}) {
  const db = env?.MUSIXQUARE_ADMIN_DB || env?.ADMIN_METRICS_DB;
  if (!db?.prepare || !dependencies?.isAccountActive || !dependencies?.inspectRoom) {
    return { configured: false, checked: 0, finalized: 0, orphaned: 0 };
  }
  const limit = Math.max(
    1,
    Math.min(100, Number.isSafeInteger(options.limit) ? options.limit : 25),
  );
  let rows;
  try {
    rows = await all(
      db
        .prepare(
          `SELECT grant.account_id, allocation.room_code, allocation.room_generation,
                  registry.activation_state
             FROM ${GRANT_TABLE} grant
             JOIN ${ALLOCATION_TABLE} allocation ON allocation.grant_id = grant.grant_id
             LEFT JOIN mxqr_pro_room_registry registry
               ON registry.room_code = allocation.room_code
              AND registry.room_generation = allocation.room_generation
            WHERE grant.status = 'pending_activation' AND allocation.status = 'reserved'
            ORDER BY grant.updated_at ASC LIMIT ?1`,
        )
        .bind(limit),
    );
  } catch {
    return { configured: false, checked: 0, finalized: 0, orphaned: 0 };
  }
  const result = { configured: true, checked: 0, finalized: 0, orphaned: 0 };
  for (const row of rows) {
    const accountId = row.account_id;
    const roomCode = row.room_code;
    const roomGeneration = Number(row.room_generation);
    if (
      !ACCOUNT_ID_RE.test(accountId || '') ||
      !ROOM_CODE_RE.test(roomCode || '') ||
      !isProRoomGeneration(roomGeneration)
    ) {
      continue;
    }
    result.checked += 1;
    let accountActive = false;
    try {
      accountActive = (await dependencies.isAccountActive(accountId)) === true;
    } catch {
      // An Auth D1 outage is not proof of deletion. Preserve the pending grant
      // and retry rather than orphaning a legitimate owner.
      continue;
    }
    if (!accountActive) {
      if (await orphanAccountProGrants(env, accountId)) result.orphaned += 1;
      continue;
    }
    let canonical;
    try {
      canonical = await dependencies.inspectRoom(roomCode, roomGeneration);
    } catch {
      continue;
    }
    if (canonical?.status === 'active' && canonical.ownerAccountId === accountId) {
      if (await finalizeProGrantActivation(env, { accountId, roomCode, roomGeneration })) {
        result.finalized += 1;
      }
    }
  }
  return result;
}

export async function hasReservedProGrantAllocation(env, roomCode, roomGeneration) {
  const db = env?.MUSIXQUARE_ADMIN_DB || env?.ADMIN_METRICS_DB;
  if (!db?.prepare || !ROOM_CODE_RE.test(roomCode || '') || !isProRoomGeneration(roomGeneration)) {
    return true;
  }
  try {
    const row = await first(
      db
        .prepare(
          `SELECT 1 AS reserved
            WHERE EXISTS (
                    SELECT 1 FROM ${VOUCHER_TABLE}
                     WHERE room_code = ?1 AND room_generation = ?2
                       AND status = 'available'
                  )
               OR EXISTS (
                    SELECT 1 FROM ${ALLOCATION_TABLE}
                     WHERE room_code = ?1 AND room_generation = ?2
                       AND status IN ('reserved','active','suspended','orphaned')
                  )
           LIMIT 1`,
        )
        .bind(roomCode, roomGeneration),
    );
    return Number(row?.reserved) === 1;
  } catch {
    // Missing grant schema during a matched rollout is an unavailable
    // authorization decision, never proof that a reserved room is free.
    return true;
  }
}

export async function authorizeProGrantActivation(env, input) {
  const db = env?.MUSIXQUARE_ADMIN_DB || env?.ADMIN_METRICS_DB;
  if (
    !db?.prepare ||
    !ACCOUNT_ID_RE.test(input?.accountId || '') ||
    !ROOM_CODE_RE.test(input?.roomCode || '') ||
    !isProRoomGeneration(input?.roomGeneration)
  ) {
    return false;
  }
  try {
    const conflict = await first(
      db
        .prepare(
          `SELECT account_id, room_code, room_generation, source_kind, status
             FROM ${ENTITLEMENT_TABLE}
            WHERE (account_id = ?1 AND status IN (${ENTITLEMENT_ACCOUNT_CURRENT_SQL}))
               OR (room_code = ?2 AND room_generation = ?3
                   AND status IN (${ENTITLEMENT_ROOM_RESERVED_SQL}))
            ORDER BY CASE
              WHEN account_id = ?1 AND room_code = ?2 AND room_generation = ?3 THEN 0
              ELSE 1
            END
            LIMIT 1`,
        )
        .bind(input.accountId, input.roomCode, input.roomGeneration),
    );
    if (conflict) {
      return (
        conflict.account_id === input.accountId &&
        conflict.room_code === input.roomCode &&
        Number(conflict.room_generation) === input.roomGeneration &&
        ['reserved', 'active', 'suspended'].includes(conflict.status)
      );
    }
    const blocker = await first(
      db
        .prepare(
          `SELECT 1 AS blocked
            WHERE NOT EXISTS (
                    SELECT 1 FROM ${AUDIT_TABLE}
                     WHERE actor_id = '${ENTITLEMENT_BACKFILL_ACTOR}'
                       AND action = '${ENTITLEMENT_BACKFILL_ACTION}'
                       AND result = 'complete'
                  )
               OR EXISTS (
                    SELECT 1 FROM ${ACCOUNT_FENCE_TABLE} WHERE account_id = ?1
                  )
               OR EXISTS (
                    SELECT 1 FROM ${VOUCHER_TABLE}
                     WHERE room_code = ?2 AND room_generation = ?3
                       AND status = 'available'
                  )
           LIMIT 1`,
        )
        .bind(input.accountId, input.roomCode, input.roomGeneration),
    );
    return Number(blocker?.blocked || 0) === 0;
  } catch {
    return false;
  }
}

async function issueSetupUrl(env, dependencies, accountId, redemption) {
  if (!redemption?.setupRequired) return { setupRequired: false };
  const issued = await dependencies.issueActivationHandoff({
    accountId,
    roomCode: redemption.roomCode,
    roomGeneration: redemption.roomGeneration,
    grantId: redemption.grantId,
    redemptionId: redemption.redemptionId,
  });
  if (
    !issued ||
    issued.roomCode !== redemption.roomCode ||
    Number(issued.roomGeneration) !== redemption.roomGeneration ||
    typeof issued.activationUrl !== 'string' ||
    !Number.isSafeInteger(issued.expiresAt)
  ) {
    return { error: 'PRO_GRANT_HANDOFF_UNAVAILABLE' };
  }
  return {
    setupRequired: true,
    activationUrl: issued.activationUrl,
    expiresAt: issued.expiresAt,
  };
}

async function reconcileAccountRedemption(env, dependencies, accountId, row) {
  let redemption = normalizedRedemption(row);
  if (!redemption || redemption.grantStatus !== 'pending_activation') return redemption;
  const canonical = await dependencies.inspectRoom(redemption.roomCode, redemption.roomGeneration);
  if (
    canonical?.status === 'active' &&
    canonical?.ownerAccountId === accountId &&
    (await finalizeProGrantActivation(env, {
      accountId,
      roomCode: redemption.roomCode,
      roomGeneration: redemption.roomGeneration,
    }))
  ) {
    row.redemption_status = 'fulfilled';
    row.grant_status = 'active';
    redemption = normalizedRedemption(row);
  }
  return redemption;
}

async function existingProEntitlementCount(db, accountId) {
  const row = await first(
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM ${ENTITLEMENT_TABLE}
          WHERE account_id = ?1 AND status IN (${ENTITLEMENT_ACCOUNT_CURRENT_SQL})`,
      )
      .bind(accountId),
  );
  return Number(row?.count || 0);
}

async function redeemVoucher(request, env, dependencies, campaign, account) {
  const parsed = await readJson(request, 4096);
  if (parsed.error)
    return responseJson({ error: parsed.error }, parsed.error === 'JSON_REQUIRED' ? 415 : 400);
  if (Object.keys(parsed.value).length !== 1)
    return responseJson({ error: 'INVALID_REQUEST' }, 400);
  const code = normalizeVoucherCode(parsed.value.code);
  if (!code) return responseJson({ error: 'REDEEM_CODE_INVALID' }, 400);

  const db = env.MUSIXQUARE_ADMIN_DB || env.ADMIN_METRICS_DB;
  let existingRow = await readAccountRedemption(db, campaign.campaign_id, account.accountId);
  if (existingRow) {
    const existing = await reconcileAccountRedemption(
      env,
      dependencies,
      account.accountId,
      existingRow,
    );
    if (!existing || ['orphaned', 'revoked'].includes(existing.status)) {
      return responseJson({ error: 'PRO_GRANT_UNAVAILABLE' }, 409);
    }
    return responseJson({
      outcome: 'already_redeemed',
      roomCode: existing.roomCode,
      roomGeneration: existing.roomGeneration,
      setupRequired: existing.setupRequired,
    });
  }

  const nowMs = Date.now();
  const publicCampaign = campaignPublicState(campaign, nowMs);
  if (publicCampaign.status !== 'active') {
    return responseJson({ error: 'CAMPAIGN_NOT_ACTIVE' }, 409);
  }
  if ((await existingProEntitlementCount(db, account.accountId)) > 0) {
    return responseJson({ error: 'ACCOUNT_PRO_ROOM_LIMIT_REACHED' }, 409);
  }
  if (
    dependencies.isAccountActive &&
    (await dependencies.isAccountActive(account.accountId)) !== true
  ) {
    return responseJson({ error: 'ACCOUNT_SESSION_REQUIRED' }, 401);
  }

  const pepper = String(env.MXQR_PRO_GRANT_VOUCHER_PEPPER || '');
  const codeDigest = await keyedDigest(
    pepper,
    'pro-grant-voucher:v1',
    `${campaign.slug}\u0000${code}`,
  );
  if (!codeDigest) return responseJson({ error: 'PRO_GRANT_UNAVAILABLE' }, 503);
  const voucher = await first(
    db
      .prepare(
        `SELECT voucher_id, status, redeemed_account_id, room_code, room_generation
           FROM ${VOUCHER_TABLE}
          WHERE campaign_id = ?1 AND code_digest = ?2 LIMIT 1`,
      )
      .bind(campaign.campaign_id, codeDigest),
  );
  if (!voucher) return responseJson({ error: 'REDEEM_CODE_INVALID' }, 404);
  if (voucher.status !== 'available') {
    return responseJson({ error: 'REDEEM_CODE_USED' }, 409);
  }
  if (
    !ROOM_CODE_RE.test(voucher.room_code || '') ||
    !isProRoomGeneration(Number(voucher.room_generation))
  ) {
    return responseJson({ error: 'PRO_GRANT_UNAVAILABLE' }, 503);
  }

  const grantId = randomId('grant_');
  const allocationId = randomId('allocation_');
  const redemptionId = randomId('redemption_');
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO ${ENTITLEMENT_TABLE}
             (account_id, room_code, room_generation, source_kind, source_ref,
              transfer_request_id, status, created_at, updated_at)
           SELECT ?1, voucher.room_code, voucher.room_generation,
                  'grant', ?2, NULL, 'reserved', ?5, ?5
             FROM ${VOUCHER_TABLE} voucher
             JOIN ${CAMPAIGN_TABLE} campaign ON campaign.campaign_id = voucher.campaign_id
            WHERE voucher.campaign_id = ?3 AND voucher.voucher_id = ?4
              AND voucher.status = 'available'
              AND campaign.status = 'active'
              AND EXISTS (
                    SELECT 1 FROM ${AUDIT_TABLE}
                     WHERE actor_id = '${ENTITLEMENT_BACKFILL_ACTOR}'
                       AND action = '${ENTITLEMENT_BACKFILL_ACTION}'
                       AND result = 'complete'
                  )
              AND (campaign.starts_at IS NULL OR campaign.starts_at <= ?5)
              AND (campaign.ends_at IS NULL OR campaign.ends_at > ?5)
              AND (SELECT COUNT(*) FROM ${REDEMPTION_TABLE} prior
                    WHERE prior.campaign_id = ?3 AND prior.account_id = ?1)
                  < campaign.per_account_limit
              AND NOT EXISTS (
                    SELECT 1 FROM ${ACCOUNT_FENCE_TABLE} fence
                     WHERE fence.account_id = ?1
                  )
              AND EXISTS (
                    SELECT 1 FROM mxqr_pro_room_registry registry
                     WHERE registry.room_code = voucher.room_code
                       AND registry.room_generation = voucher.room_generation
                       AND registry.status = 'registered'
                       AND registry.activation_state = 'unactivated'
                  )`,
        )
        .bind(account.accountId, grantId, campaign.campaign_id, voucher.voucher_id, nowMs),
      db
        .prepare(
          `UPDATE ${VOUCHER_TABLE}
              SET status = 'redeemed', redeemed_account_id = ?3,
                  redeemed_at = ?4, updated_at = ?4
            WHERE campaign_id = ?1 AND voucher_id = ?2 AND status = 'available'
              AND EXISTS (
                SELECT 1 FROM ${CAMPAIGN_TABLE} campaign
                 WHERE campaign.campaign_id = ?1 AND campaign.status = 'active'
                   AND (campaign.starts_at IS NULL OR campaign.starts_at <= ?4)
                   AND (campaign.ends_at IS NULL OR campaign.ends_at > ?4)
                   AND (SELECT COUNT(*) FROM ${REDEMPTION_TABLE} prior
                         WHERE prior.campaign_id = ?1 AND prior.account_id = ?3)
                       < campaign.per_account_limit
              )
              AND NOT EXISTS (
                SELECT 1 FROM ${ACCOUNT_FENCE_TABLE} fence
                 WHERE fence.account_id = ?3
              )
              AND EXISTS (
                SELECT 1 FROM ${ENTITLEMENT_TABLE} entitlement
                 WHERE entitlement.source_kind = 'grant'
                   AND entitlement.source_ref = ?5
                   AND entitlement.account_id = ?3
                   AND entitlement.room_code = ${VOUCHER_TABLE}.room_code
                   AND entitlement.room_generation = ${VOUCHER_TABLE}.room_generation
                   AND entitlement.status = 'reserved'
              )
              AND EXISTS (
                SELECT 1 FROM mxqr_pro_room_registry registry
                 WHERE registry.room_code = ${VOUCHER_TABLE}.room_code
                   AND registry.room_generation = ${VOUCHER_TABLE}.room_generation
                   AND registry.status = 'registered'
                   AND registry.activation_state = 'unactivated'
              )`,
        )
        .bind(campaign.campaign_id, voucher.voucher_id, account.accountId, nowMs, grantId),
      db
        .prepare(
          `INSERT INTO ${GRANT_TABLE}
             (grant_id, product_code, plan_code, account_id, source_type, source_ref,
              status, valid_from, valid_until, created_at, updated_at)
           SELECT ?1, 'pro_room', 'pro_room_perpetual', ?2, 'campaign', ?3,
                  'pending_activation', ?4, NULL, ?4, ?4
             FROM ${VOUCHER_TABLE} voucher
             WHERE voucher.voucher_id = ?5 AND voucher.campaign_id = ?3
               AND voucher.status = 'redeemed' AND voucher.redeemed_account_id = ?2
               AND EXISTS (
                 SELECT 1 FROM ${ENTITLEMENT_TABLE} entitlement
                  WHERE entitlement.source_kind = 'grant'
                    AND entitlement.source_ref = ?1
                    AND entitlement.account_id = ?2
                    AND entitlement.room_code = voucher.room_code
                    AND entitlement.room_generation = voucher.room_generation
                    AND entitlement.status = 'reserved'
               )`,
        )
        .bind(grantId, account.accountId, campaign.campaign_id, nowMs, voucher.voucher_id),
      db
        .prepare(
          `INSERT INTO ${ALLOCATION_TABLE}
             (allocation_id, grant_id, room_code, room_generation, status, created_at, updated_at)
           SELECT ?1, ?2, voucher.room_code, voucher.room_generation, 'reserved', ?3, ?3
             FROM ${VOUCHER_TABLE} voucher
             WHERE voucher.voucher_id = ?4
               AND EXISTS (SELECT 1 FROM ${GRANT_TABLE} WHERE grant_id = ?2)
               AND EXISTS (
                 SELECT 1 FROM ${ENTITLEMENT_TABLE}
                  WHERE source_kind = 'grant' AND source_ref = ?2 AND status = 'reserved'
               )`,
        )
        .bind(allocationId, grantId, nowMs, voucher.voucher_id),
      db
        .prepare(
          `INSERT INTO ${REDEMPTION_TABLE}
             (redemption_id, campaign_id, voucher_id, grant_id, account_id,
              status, claim_generation, created_at, updated_at)
             SELECT ?1, ?2, ?3, ?4, ?5, 'redeemed', NULL, ?6, ?6
             WHERE EXISTS (SELECT 1 FROM ${GRANT_TABLE} WHERE grant_id = ?4)
               AND EXISTS (SELECT 1 FROM ${ALLOCATION_TABLE} WHERE grant_id = ?4)
               AND EXISTS (
                 SELECT 1 FROM ${ENTITLEMENT_TABLE}
                  WHERE source_kind = 'grant' AND source_ref = ?4
                    AND account_id = ?5 AND status = 'reserved'
               )`,
        )
        .bind(
          redemptionId,
          campaign.campaign_id,
          voucher.voucher_id,
          grantId,
          account.accountId,
          nowMs,
        ),
      db
        .prepare(
          `INSERT INTO ${AUDIT_TABLE}
             (actor_id, action, result, campaign_id, voucher_id, grant_id,
              allocation_id, redemption_id, room_code, room_generation, created_at)
           SELECT ?1, 'voucher.redeem', 'redeemed', ?2, ?3, ?4, ?7, ?5,
                  voucher.room_code, voucher.room_generation, ?6
             FROM ${VOUCHER_TABLE} voucher
             WHERE voucher.voucher_id = ?3
               AND EXISTS (SELECT 1 FROM ${REDEMPTION_TABLE} WHERE redemption_id = ?5)
               AND EXISTS (
                 SELECT 1 FROM ${ENTITLEMENT_TABLE}
                  WHERE source_kind = 'grant' AND source_ref = ?4
                    AND account_id = ?1 AND status = 'reserved'
               )`,
        )
        .bind(
          account.accountId,
          campaign.campaign_id,
          voucher.voucher_id,
          grantId,
          redemptionId,
          nowMs,
          allocationId,
        ),
    ]);
  } catch {
    // A competing request may have committed the same account or voucher.
    // Resolve from durable state below; never release or reassign an
    // ambiguous voucher after crossing the D1 transaction boundary.
  }

  existingRow = await readAccountRedemption(db, campaign.campaign_id, account.accountId);
  if (!existingRow) {
    const accountFence = await first(
      db
        .prepare(`SELECT 1 AS fenced FROM ${ACCOUNT_FENCE_TABLE} WHERE account_id = ?1 LIMIT 1`)
        .bind(account.accountId),
    );
    if (Number(accountFence?.fenced) === 1) {
      return responseJson({ error: 'ACCOUNT_SESSION_REQUIRED' }, 401);
    }
    if (await accountHasCurrentProEntitlement(db, account.accountId)) {
      return responseJson({ error: 'ACCOUNT_PRO_ROOM_LIMIT_REACHED' }, 409);
    }
    const currentVoucher = await first(
      db
        .prepare(`SELECT status, redeemed_account_id FROM ${VOUCHER_TABLE} WHERE voucher_id = ?1`)
        .bind(voucher.voucher_id),
    );
    if (currentVoucher?.status === 'redeemed') {
      return responseJson({ error: 'REDEEM_CODE_USED' }, 409);
    }
    return responseJson({ error: 'PRO_GRANT_UNAVAILABLE' }, 503);
  }
  const redemption = normalizedRedemption(existingRow);
  if (!redemption) return responseJson({ error: 'PRO_GRANT_UNAVAILABLE' }, 503);
  if (
    dependencies.isAccountActive &&
    (await dependencies.isAccountActive(account.accountId)) !== true
  ) {
    await orphanAccountProGrants(env, account.accountId);
    return responseJson({ error: 'ACCOUNT_SESSION_REQUIRED' }, 401);
  }
  return responseJson(
    {
      outcome: redemptionId === redemption.redemptionId ? 'redeemed' : 'already_redeemed',
      roomCode: redemption.roomCode,
      roomGeneration: redemption.roomGeneration,
      setupRequired: redemption.setupRequired,
    },
    redemptionId === redemption.redemptionId ? 201 : 200,
  );
}

export async function handleProGrantPublicRequest(request, env, url, dependencies) {
  const route = url.pathname.match(PUBLIC_ROUTE_RE);
  if (!route) return null;
  const [, slug, action] = route;
  const allowed = action === 'session' ? ['GET', 'HEAD'] : ['POST'];
  if (!allowed.includes(request.method)) {
    return responseJson({ error: 'METHOD_NOT_ALLOWED' }, 405, { allow: allowed.join(', ') });
  }
  if (!sameOriginMutation(request)) return responseJson({ error: 'CSRF_FAILED' }, 403);
  const db = env.MUSIXQUARE_ADMIN_DB || env.ADMIN_METRICS_DB;
  if (!db?.prepare || !env.MUSIXQUARE_AUTH_DB?.prepare || !dependencies) {
    return responseJson({ error: 'PRO_GRANT_UNAVAILABLE' }, 503);
  }
  let campaign;
  let account;
  try {
    [campaign, account] = await Promise.all([
      readCampaign(db, slug),
      dependencies.resolveAccountSession(request, env),
    ]);
  } catch {
    return responseJson({ error: 'PRO_GRANT_UNAVAILABLE' }, 503);
  }
  if (!campaign) return responseJson({ error: 'CAMPAIGN_NOT_FOUND' }, 404);

  if (action === 'session') {
    let redemption = null;
    if (account?.profileComplete && ACCOUNT_ID_RE.test(account.accountId || '')) {
      try {
        const row = await readAccountRedemption(db, campaign.campaign_id, account.accountId);
        redemption = row
          ? await reconcileAccountRedemption(env, dependencies, account.accountId, row)
          : null;
      } catch {
        return responseJson({ error: 'PRO_GRANT_UNAVAILABLE' }, 503);
      }
    }
    return responseJson({
      campaign: campaignPublicState(campaign, Date.now()),
      account: {
        authenticated: !!account,
        profileComplete: !!account?.profileComplete,
      },
      redemption: redemption
        ? {
            status: redemption.status,
            roomCode: redemption.roomCode,
            roomGeneration: redemption.roomGeneration,
            setupRequired: redemption.setupRequired,
          }
        : null,
    });
  }

  if (!account || !ACCOUNT_ID_RE.test(account.accountId || '')) {
    return responseJson({ error: 'ACCOUNT_SESSION_REQUIRED' }, 401);
  }
  if (!account.profileComplete || !account.nickname) {
    return responseJson({ error: 'ACCOUNT_PROFILE_REQUIRED' }, 409);
  }
  if (action === 'setup-link') {
    const parsed = await readJson(request, 1024);
    if (parsed.error || Object.keys(parsed.value).length !== 0) {
      return responseJson({ error: parsed.error || 'INVALID_REQUEST' }, 400);
    }
    const row = await readAccountRedemption(db, campaign.campaign_id, account.accountId);
    const redemption = row
      ? await reconcileAccountRedemption(env, dependencies, account.accountId, row)
      : null;
    if (!redemption || ['orphaned', 'revoked'].includes(redemption.status)) {
      return responseJson({ error: 'PRO_GRANT_NOT_FOUND' }, 404);
    }
    const setup = await issueSetupUrl(env, dependencies, account.accountId, redemption);
    if (setup.error) return responseJson({ error: setup.error }, 503);
    return responseJson({
      roomCode: redemption.roomCode,
      roomGeneration: redemption.roomGeneration,
      ...setup,
    });
  }
  return redeemVoucher(request, env, dependencies, campaign, account);
}

async function batchFingerprint(pepper, campaignId, vouchers) {
  return keyedDigest(
    pepper,
    'pro-grant-voucher-batch:v1',
    `${campaignId}\u0000${vouchers
      .map((item) => `${item.roomCode}:${item.codeDigest}`)
      .sort()
      .join('\u0000')}`,
  );
}

async function readVoucherBatchReplay(db, campaignId, requestId, requestDigest, expectedCount) {
  const existing = await first(
    db
      .prepare(
        `SELECT request_digest, voucher_count FROM ${VOUCHER_BATCH_TABLE}
          WHERE campaign_id = ?1 AND request_id = ?2 LIMIT 1`,
      )
      .bind(campaignId, requestId),
  );
  if (!existing) return { state: 'missing' };
  if (existing.request_digest !== requestDigest) return { state: 'conflict' };
  if (Number(existing.voucher_count) !== expectedCount) return { state: 'unavailable' };
  const mappings = await all(
    db
      .prepare(
        `SELECT voucher_id, room_code, room_generation, status
           FROM ${VOUCHER_TABLE}
          WHERE campaign_id = ?1 AND batch_request_id = ?2 ORDER BY room_code ASC`,
      )
      .bind(campaignId, requestId),
  );
  return mappings.length === expectedCount
    ? { state: 'replayed', mappings }
    : { state: 'unavailable' };
}

async function adminVoucherBatch(request, env, campaign, dependencies) {
  const parsed = await readJson(request);
  if (parsed.error) return responseJson({ error: parsed.error }, 400);
  const { requestId, dryRun, vouchers: input } = parsed.value;
  if (
    !BATCH_REQUEST_ID_RE.test(requestId || '') ||
    typeof dryRun !== 'boolean' ||
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > 100 ||
    Object.keys(parsed.value).some((key) => !['requestId', 'dryRun', 'vouchers'].includes(key))
  ) {
    return responseJson({ error: 'INVALID_REQUEST' }, 400);
  }
  const normalized = [];
  const seenRooms = new Set();
  for (const item of input) {
    if (!item || Object.keys(item).some((key) => !['roomCode', 'code'].includes(key))) {
      return responseJson({ error: 'INVALID_REQUEST' }, 400);
    }
    const roomCode = item.roomCode;
    const code = normalizeVoucherCode(item.code);
    if (!ROOM_CODE_RE.test(roomCode || '') || !code || seenRooms.has(roomCode)) {
      return responseJson({ error: 'INVALID_REQUEST' }, 400);
    }
    seenRooms.add(roomCode);
    normalized.push({ roomCode, code });
  }
  const pepper = String(env.MXQR_PRO_GRANT_VOUCHER_PEPPER || '');
  if (pepper.length < 32) return responseJson({ error: 'PRO_GRANT_UNAVAILABLE' }, 503);
  const digested = [];
  for (const item of normalized) {
    const codeDigest = await keyedDigest(
      pepper,
      'pro-grant-voucher:v1',
      `${campaign.slug}\u0000${item.code}`,
    );
    digested.push({ roomCode: item.roomCode, codeDigest });
  }
  // Resolve exact retries before touching mutable room state. A committed
  // operation must remain replayable after its rooms have activated or its
  // vouchers have been redeemed; only a genuinely new batch needs preflight.
  const requestDigest = await batchFingerprint(pepper, campaign.campaign_id, digested);
  const db = env.MUSIXQUARE_ADMIN_DB || env.ADMIN_METRICS_DB;
  const existing = await readVoucherBatchReplay(
    db,
    campaign.campaign_id,
    requestId,
    requestDigest,
    digested.length,
  );
  if (existing.state === 'conflict') {
    return responseJson({ error: 'IDEMPOTENCY_CONFLICT' }, 409);
  }
  if (existing.state === 'unavailable') {
    return responseJson({ error: 'PRO_GRANT_BATCH_UNAVAILABLE' }, 503);
  }
  if (existing.state === 'replayed') {
    return responseJson({
      requestId,
      campaign: campaignPublicState(campaign, Date.now()),
      count: existing.mappings.length,
      mappings: publicVoucherMappings(existing.mappings),
      replayed: true,
    });
  }
  const effectiveCampaign = campaignPublicState(campaign, Date.now());
  if (!MUTABLE_VOUCHER_CAMPAIGN_STATES.has(effectiveCampaign?.status)) {
    return responseJson({ error: 'CAMPAIGN_NOT_MUTABLE' }, 409);
  }
  const prepared = [];
  for (const item of digested) {
    const room = await dependencies.preflightVoucherRoom(item.roomCode);
    if (
      !room ||
      room.status !== 'registered' ||
      room.activationState !== 'unactivated' ||
      !isProRoomGeneration(room.roomGeneration)
    ) {
      return responseJson({ error: 'PRO_GRANT_ROOM_UNAVAILABLE', roomCode: item.roomCode }, 409);
    }
    prepared.push({
      voucherId: randomId('voucher_'),
      roomCode: item.roomCode,
      roomGeneration: room.roomGeneration,
      codeDigest: item.codeDigest,
    });
  }
  if (dryRun) {
    return responseJson({
      requestId,
      campaign: campaignPublicState(campaign, Date.now()),
      dryRun: true,
      validatedCount: prepared.length,
      rooms: prepared.map(({ roomCode, roomGeneration }) => ({ roomCode, roomGeneration })),
    });
  }
  const nowMs = Date.now();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO ${VOUCHER_BATCH_TABLE}
             (campaign_id, request_id, request_digest, status, voucher_count, created_at, updated_at)
           VALUES (?1, ?2, ?3, 'committed', ?5, ?4, ?4)`,
        )
        .bind(campaign.campaign_id, requestId, requestDigest, nowMs, prepared.length),
      ...prepared.map((item) =>
        db
          .prepare(
            `INSERT INTO ${VOUCHER_TABLE}
               (voucher_id, campaign_id, batch_request_id, code_digest,
                room_code, room_generation, status, redeemed_account_id,
                redeemed_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'available', NULL, NULL, ?7, ?7)`,
          )
          .bind(
            item.voucherId,
            campaign.campaign_id,
            requestId,
            item.codeDigest,
            item.roomCode,
            item.roomGeneration,
            nowMs,
          ),
      ),
      db
        .prepare(
          `INSERT INTO ${AUDIT_TABLE}
             (actor_id, action, result, campaign_id, created_at)
           VALUES (?1, 'voucher.batch.issue', 'issued', ?2, ?3)`,
        )
        .bind(`admin:${requestId}`, campaign.campaign_id, nowMs),
    ]);
  } catch {
    // A concurrent identical request can win the unique request-id race, or
    // the batch may commit while its response is lost. Re-read the durable
    // operation before reporting failure so the exact artifact remains a
    // single-attempt, idempotent operator workflow.
    const raced = await readVoucherBatchReplay(
      db,
      campaign.campaign_id,
      requestId,
      requestDigest,
      prepared.length,
    ).catch(() => ({ state: 'unavailable' }));
    if (raced.state === 'conflict') {
      return responseJson({ error: 'IDEMPOTENCY_CONFLICT' }, 409);
    }
    if (raced.state === 'replayed') {
      return responseJson({
        requestId,
        campaign: campaignPublicState(campaign, Date.now()),
        count: raced.mappings.length,
        mappings: publicVoucherMappings(raced.mappings),
        replayed: true,
      });
    }
    return responseJson({ error: 'PRO_GRANT_BATCH_UNAVAILABLE' }, 503);
  }
  const mappings = await all(
    db
      .prepare(
        `SELECT voucher_id, room_code, room_generation, status
           FROM ${VOUCHER_TABLE}
          WHERE campaign_id = ?1 AND batch_request_id = ?2 ORDER BY room_code ASC`,
      )
      .bind(campaign.campaign_id, requestId),
  );
  if (mappings.length !== prepared.length) {
    return responseJson({ error: 'PRO_GRANT_BATCH_UNAVAILABLE' }, 503);
  }
  return responseJson(
    {
      requestId,
      campaign: campaignPublicState(campaign, Date.now()),
      count: mappings.length,
      mappings: publicVoucherMappings(mappings),
      replayed: false,
    },
    201,
  );
}

export async function handleProGrantAdminRequest(request, env, url, dependencies) {
  const route = url.pathname.match(ADMIN_ROUTE_RE);
  if (!route) return null;
  const [, slug, action] = route;
  const db = env.MUSIXQUARE_ADMIN_DB || env.ADMIN_METRICS_DB;
  if (!db?.prepare || !dependencies) return responseJson({ error: 'PRO_GRANT_UNAVAILABLE' }, 503);
  if (!slug) {
    if (request.method === 'GET' || request.method === 'HEAD') {
      try {
        const rows = await readCampaignList(db);
        const nowMs = Date.now();
        return responseJson({ campaigns: rows.map((row) => campaignAdminState(row, nowMs)) });
      } catch {
        return responseJson({ error: 'PRO_GRANT_UNAVAILABLE' }, 503);
      }
    }
    if (request.method !== 'POST') {
      return responseJson({ error: 'METHOD_NOT_ALLOWED' }, 405, {
        allow: 'GET, HEAD, POST',
      });
    }
    const parsed = await readJson(request);
    if (parsed.error) return responseJson({ error: parsed.error }, 400);
    const { slug: newSlug, title, startsAt, endsAt, perAccountLimit, dryRun } = parsed.value;
    if (
      Object.keys(parsed.value).some(
        (key) =>
          !['slug', 'title', 'startsAt', 'endsAt', 'perAccountLimit', 'dryRun'].includes(key),
      ) ||
      !PUBLIC_ROUTE_RE.test(`/api/pro-grants/campaigns/${newSlug}/session`) ||
      typeof title !== 'string' ||
      title.trim().length < 1 ||
      title.trim().length > 100 ||
      (startsAt !== null && (!Number.isSafeInteger(startsAt) || startsAt < 0)) ||
      (endsAt !== null && (!Number.isSafeInteger(endsAt) || endsAt < 0)) ||
      (startsAt !== null && endsAt !== null && endsAt <= startsAt) ||
      !Number.isSafeInteger(perAccountLimit) ||
      perAccountLimit < 1 ||
      perAccountLimit > 10 ||
      typeof dryRun !== 'boolean'
    ) {
      return responseJson({ error: 'INVALID_REQUEST' }, 400);
    }
    const existing = await readCampaign(db, newSlug);
    if (existing) {
      const matches =
        existing.title === title.trim() &&
        (existing.starts_at === null ? null : Number(existing.starts_at)) === startsAt &&
        (existing.ends_at === null ? null : Number(existing.ends_at)) === endsAt &&
        Number(existing.per_account_limit) === perAccountLimit;
      return matches
        ? responseJson({
            campaign: campaignPublicState(existing, Date.now()),
            dryRun,
            created: false,
          })
        : responseJson({ error: 'CAMPAIGN_CONFLICT' }, 409);
    }
    const campaign = {
      campaignId: randomId('campaign_'),
      slug: newSlug,
      title: title.trim(),
      startsAt,
      endsAt,
      perAccountLimit,
    };
    if (!dryRun) {
      const nowMs = Date.now();
      try {
        await db.batch([
          db
            .prepare(
              `INSERT INTO ${CAMPAIGN_TABLE}
                 (campaign_id, slug, title, status, starts_at, ends_at,
                  per_account_limit, created_at, updated_at)
               VALUES (?1, ?2, ?3, 'draft', ?4, ?5, ?6, ?7, ?7)`,
            )
            .bind(
              campaign.campaignId,
              campaign.slug,
              campaign.title,
              campaign.startsAt,
              campaign.endsAt,
              campaign.perAccountLimit,
              nowMs,
            ),
          db
            .prepare(
              `INSERT INTO ${AUDIT_TABLE}
                 (actor_id, action, result, campaign_id, created_at)
               VALUES ('admin:campaign-create', 'campaign.create', 'created', ?1, ?2)`,
            )
            .bind(campaign.campaignId, nowMs),
        ]);
      } catch {
        const raced = await readCampaign(db, newSlug).catch(() => null);
        const matches =
          raced?.title === campaign.title &&
          (raced?.starts_at === null ? null : Number(raced?.starts_at)) === campaign.startsAt &&
          (raced?.ends_at === null ? null : Number(raced?.ends_at)) === campaign.endsAt &&
          Number(raced?.per_account_limit) === campaign.perAccountLimit;
        if (!matches) return responseJson({ error: 'CAMPAIGN_CONFLICT' }, 409);
        return responseJson({
          campaign: campaignPublicState(raced, Date.now()),
          dryRun: false,
          created: false,
        });
      }
    }
    const campaignRow = {
      slug: campaign.slug,
      title: campaign.title,
      status: 'draft',
      starts_at: campaign.startsAt,
      ends_at: campaign.endsAt,
      per_account_limit: campaign.perAccountLimit,
    };
    return responseJson(
      {
        campaign: campaignPublicState(campaignRow, Date.now()),
        dryRun,
        created: !dryRun,
      },
      !dryRun ? 201 : 200,
    );
  }

  const campaign = await readCampaign(db, slug);
  if (!campaign) return responseJson({ error: 'CAMPAIGN_NOT_FOUND' }, 404);
  if (action === 'vouchers') {
    if (request.method !== 'POST') return responseJson({ error: 'METHOD_NOT_ALLOWED' }, 405);
    return adminVoucherBatch(request, env, campaign, dependencies);
  }
  if (action === 'status') {
    if (request.method === 'GET' || request.method === 'HEAD') {
      try {
        const summary = await readCampaignSummary(db, campaign.campaign_id);
        return responseJson(campaignAdminState(summary || campaign, Date.now()));
      } catch {
        return responseJson({ error: 'PRO_GRANT_UNAVAILABLE' }, 503);
      }
    }
    if (request.method === 'POST') {
      const parsed = await readJson(request, 4096);
      const { requestId, status, dryRun } = parsed.value || {};
      if (
        parsed.error ||
        !REQUEST_ID_RE.test(requestId || '') ||
        !ADMIN_CAMPAIGN_STATUS_TARGETS.has(status) ||
        typeof dryRun !== 'boolean' ||
        Object.keys(parsed.value).some((key) => !['requestId', 'status', 'dryRun'].includes(key))
      ) {
        return responseJson({ error: 'INVALID_REQUEST' }, 400);
      }
      const actorId = `admin:${requestId}`;
      const result = `status:${status}`;
      const previous = await first(
        db
          .prepare(
            `SELECT result FROM ${AUDIT_TABLE}
              WHERE actor_id = ?1 AND action = 'campaign.status'
                AND campaign_id = ?2
              ORDER BY id ASC LIMIT 1`,
          )
          .bind(actorId, campaign.campaign_id),
      );
      if (previous && previous.result !== result) {
        return responseJson({ error: 'IDEMPOTENCY_CONFLICT' }, 409);
      }
      const nowMs = Date.now();
      if (
        !previous &&
        !campaignStatusTransitionAllowed(
          campaign.status,
          status,
          campaign.ends_at === null ? null : Number(campaign.ends_at),
          nowMs,
        )
      ) {
        return responseJson(
          {
            error: 'CAMPAIGN_STATUS_TRANSITION_INVALID',
            campaign: campaignPublicState(campaign, nowMs),
            requestedStatus: status,
          },
          409,
        );
      }
      if (!previous && status === 'active' && campaign.status !== 'active') {
        let summary;
        try {
          summary = await readCampaignSummary(db, campaign.campaign_id);
        } catch {
          return responseJson({ error: 'PRO_GRANT_UNAVAILABLE' }, 503);
        }
        if (campaignVoucherSummary(summary).counts.total < 1) {
          return responseJson({ error: 'CAMPAIGN_VOUCHERS_REQUIRED' }, 409);
        }
      }
      if (dryRun || previous) {
        return responseJson({
          requestId,
          dryRun,
          replayed: !!previous,
          campaign: campaignPublicState(campaign, nowMs),
          requestedStatus: status,
        });
      }
      if (status === 'active' && campaign.status !== 'active') {
        let ownersBackfilled = false;
        try {
          ownersBackfilled =
            typeof dependencies.verifyOwnerEntitlementBackfill === 'function' &&
            (await dependencies.verifyOwnerEntitlementBackfill()) === true;
        } catch {
          ownersBackfilled = false;
        }
        if (!ownersBackfilled) {
          return responseJson({ error: 'PRO_GRANT_OWNER_BACKFILL_REQUIRED' }, 503);
        }
      }
      try {
        await db.batch([
          db
            .prepare(
              `UPDATE ${CAMPAIGN_TABLE} SET status = ?2, updated_at = ?3
                WHERE campaign_id = ?1 AND status = ?4
                  AND NOT EXISTS (
                    SELECT 1 FROM ${AUDIT_TABLE}
                     WHERE actor_id = ?5 AND action = 'campaign.status'
                       AND campaign_id = ?1
                  )`,
            )
            .bind(campaign.campaign_id, status, nowMs, campaign.status, actorId),
          db
            .prepare(
              `INSERT INTO ${AUDIT_TABLE}
                 (actor_id, action, result, campaign_id, created_at)
               SELECT ?1, 'campaign.status', ?2, ?3, ?4
                WHERE EXISTS (
                  SELECT 1 FROM ${CAMPAIGN_TABLE}
                   WHERE campaign_id = ?3 AND status = ?5
                )
                  AND NOT EXISTS (
                    SELECT 1 FROM ${AUDIT_TABLE}
                     WHERE actor_id = ?1 AND action = 'campaign.status'
                       AND campaign_id = ?3
                  )`,
            )
            .bind(actorId, result, campaign.campaign_id, nowMs, status),
        ]);
      } catch {
        return responseJson({ error: 'PRO_GRANT_UNAVAILABLE' }, 503);
      }
      const committed = await first(
        db
          .prepare(
            `SELECT result FROM ${AUDIT_TABLE}
              WHERE actor_id = ?1 AND action = 'campaign.status'
                AND campaign_id = ?2
              ORDER BY id ASC LIMIT 1`,
          )
          .bind(actorId, campaign.campaign_id),
      );
      if (committed?.result !== result) {
        return responseJson({ error: 'CAMPAIGN_STATUS_RACE' }, 409);
      }
      const updated = await readCampaign(db, slug);
      return responseJson({
        requestId,
        dryRun: false,
        replayed: false,
        campaign: campaignPublicState(updated, Date.now()),
      });
    }
    return responseJson({ error: 'METHOD_NOT_ALLOWED' }, 405, { allow: 'GET, HEAD, POST' });
  }
  if (action === 'revoke') {
    if (request.method !== 'POST') {
      return responseJson({ error: 'METHOD_NOT_ALLOWED' }, 405, { allow: 'POST' });
    }
    const parsed = await readJson(request, 4096);
    if (
      parsed.error ||
      !REQUEST_ID_RE.test(parsed.value?.requestId || '') ||
      !SAFE_ADMIN_REASON_RE.test(parsed.value?.reason || '') ||
      Object.keys(parsed.value || {}).some((key) => !['requestId', 'reason'].includes(key))
    ) {
      return responseJson({ error: 'INVALID_REQUEST' }, 400);
    }
    const nowMs = Date.now();
    const actorId = `admin:${parsed.value.requestId}`;
    const result = `revoke-unused:${parsed.value.reason}`;
    const previous = await first(
      db
        .prepare(
          `SELECT result FROM ${AUDIT_TABLE}
            WHERE actor_id = ?1 AND action = 'campaign.revoke'
              AND campaign_id = ?2
            ORDER BY id ASC LIMIT 1`,
        )
        .bind(actorId, campaign.campaign_id),
    );
    if (previous && previous.result !== result) {
      return responseJson({ error: 'IDEMPOTENCY_CONFLICT' }, 409);
    }
    let replayed = !!previous;
    let revokedVouchers = 0;
    if (!previous) {
      let results;
      try {
        results = await db.batch([
          db
            .prepare(
              `UPDATE ${CAMPAIGN_TABLE} SET status = 'ended', updated_at = ?2
                WHERE campaign_id = ?1 AND status IN ('draft', 'active', 'paused', 'ended')
                  AND NOT EXISTS (
                    SELECT 1 FROM ${AUDIT_TABLE}
                     WHERE actor_id = ?3 AND action = 'campaign.revoke'
                       AND campaign_id = ?1
                  )`,
            )
            .bind(campaign.campaign_id, nowMs, actorId),
          db
            .prepare(
              `INSERT INTO ${AUDIT_TABLE}
                 (actor_id, action, result, campaign_id, created_at)
               SELECT ?1, 'campaign.revoke', ?2, ?3, ?4
                WHERE EXISTS (
                  SELECT 1 FROM ${CAMPAIGN_TABLE}
                   WHERE campaign_id = ?3 AND status IN ('ended', 'revoked')
                )
                  AND NOT EXISTS (
                    SELECT 1 FROM ${AUDIT_TABLE}
                     WHERE actor_id = ?1 AND action = 'campaign.revoke'
                       AND campaign_id = ?3
                  )`,
            )
            .bind(actorId, result, campaign.campaign_id, nowMs),
          db
            .prepare(
              `UPDATE ${VOUCHER_TABLE} SET status = 'revoked', updated_at = ?2
                WHERE campaign_id = ?1 AND status = 'available'
                  AND EXISTS (
                    SELECT 1 FROM ${AUDIT_TABLE}
                     WHERE actor_id = ?3 AND action = 'campaign.revoke'
                       AND campaign_id = ?1 AND result = ?4
                  )`,
            )
            .bind(campaign.campaign_id, nowMs, actorId, result),
        ]);
      } catch {
        return responseJson({ error: 'PRO_GRANT_UNAVAILABLE' }, 503);
      }
      const committed = await first(
        db
          .prepare(
            `SELECT result FROM ${AUDIT_TABLE}
              WHERE actor_id = ?1 AND action = 'campaign.revoke'
                AND campaign_id = ?2
              ORDER BY id ASC LIMIT 1`,
          )
          .bind(actorId, campaign.campaign_id),
      );
      if (committed?.result !== result) {
        return responseJson({ error: 'CAMPAIGN_STATUS_TRANSITION_INVALID' }, 409);
      }
      replayed = changeCount(results?.[1]) === 0;
      revokedVouchers = changeCount(results?.[2]);
    }
    const summary = await readCampaignSummary(db, campaign.campaign_id);
    return responseJson({
      requestId: parsed.value.requestId,
      replayed,
      ...campaignAdminState(summary || campaign, Date.now()),
      revokedVouchers,
    });
  }
  return responseJson({ error: 'NOT_FOUND' }, 404);
}

export const PRO_GRANT_ACTIVE_STATES = ACTIVE_GRANT_STATES;
