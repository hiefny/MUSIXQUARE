/**
 * The GET /api/status body that musixquare.com/status reads
 * (browser/classic-runtime/status-page.ts), built from the status check
 * ledger, the maintenance state and the status note.
 *
 * Rules, per component (website and connection on the browser schedule, rooms
 * and pro on the server schedule):
 * - Slots. `current` is the latest boundary at or before now. The newest
 *   shown slot N is `current` when it already has a row and the slot before
 *   it otherwise, so a check that is still running never shows as missed.
 *   `slots` holds one mark per slot from N - 95 intervals to N: o, p or m
 *   from a row, n for a slot without one. Marks before the component's first
 *   row are left out (the page pads them), and `recent` is null when no mark
 *   is left.
 * - lastCheckedAt is the newest checked_at of an o or p row; lastOkAt that of
 *   an o row. Maintenance marks never move either.
 * - state: maintenance while maintenance is active; stale when lastCheckedAt
 *   is missing or more than 30 minutes old; problem when the two newest o or
 *   p rows both failed (missed slots and maintenance marks are skipped), with
 *   problemSince at the first failure of that run; ok otherwise, also after a
 *   single failure.
 * Overall, highest first: maintenance, problem (since the earliest
 * problemSince), stale, ok. Without the ledger every row is stale with reason
 * results_unavailable, unless maintenance is active, which still wins.
 *
 * Pure: time comes only from nowMs, and every policy value from
 * cloudflare/status-contract.ts.
 */

import {
  STATUS_BROWSER_CHECK_MINUTES,
  STATUS_CHECK_INTERVAL_MINUTES,
  STATUS_COMPONENT_IDS,
  STATUS_COMPONENT_SCHEDULE,
  STATUS_PROBLEM_AFTER_FAILURES,
  STATUS_RECENT_SLOTS,
  STATUS_SCHEMA_VERSION,
  STATUS_SERVER_CHECK_MINUTES,
  STATUS_STALE_AFTER_MINUTES,
  statusSlotAt,
  type StatusCheckRow,
  type StatusComponentId,
  type StatusPublicNote,
  type StatusSchedule,
} from './status-contract.ts';
import { isStatusCheckRow } from './status-store.ts';

export type StatusState = 'ok' | 'problem' | 'maintenance' | 'stale';

/** Component reason of a row that passes. */
export const STATUS_REASON_PASSING = 'passing';
/** Overall reason when every row passes. */
export const STATUS_REASON_ALL_PASSING = 'all_passing';
/** Overall reason when at least one row has a problem. */
export const STATUS_REASON_COMPONENT_PROBLEM = 'component_problem';
/** Reason of a row, or of the overall line, without a recent check. */
export const STATUS_REASON_NOT_CHECKED_RECENTLY = 'not_checked_recently';
/** Reason of a row, or of the overall line, during maintenance. */
export const STATUS_REASON_MAINTENANCE = 'maintenance';
/** Reason of every row and of the overall line when the ledger could not be read. */
export const STATUS_REASON_RESULTS_UNAVAILABLE = 'results_unavailable';

export interface StatusRecentPayload {
  /** ISO time of the newest shown slot. */
  readonly lastAt: string;
  /** One mark per slot, oldest first: o passed, p failed, m maintenance, n no check. */
  readonly slots: string;
}

export interface StatusComponentPayload {
  readonly id: StatusComponentId;
  readonly state: StatusState;
  readonly reason: string;
  readonly lastCheckedAt: string | null;
  readonly lastOkAt: string | null;
  readonly problemSince: string | null;
  readonly recent: StatusRecentPayload | null;
}

export interface StatusOverallPayload {
  readonly state: StatusState;
  readonly reason: string;
  readonly lastCheckedAt: string | null;
  readonly since: string | null;
}

export interface StatusPolicyPayload {
  readonly checkIntervalMinutes: number;
  readonly problemAfterFailures: number;
  readonly staleAfterMinutes: number;
  readonly recentSlots: number;
  readonly schedule: { readonly server: number[]; readonly browser: number[] };
}

export interface StatusPayload {
  readonly schemaVersion: typeof STATUS_SCHEMA_VERSION;
  /** ISO time the body was built; /api/status stamps the serve time over it. */
  readonly generatedAt: string;
  readonly timeZone: 'UTC';
  readonly policy: StatusPolicyPayload;
  readonly overall: StatusOverallPayload;
  readonly maintenance: { readonly active: boolean; readonly since: string | null };
  readonly announcement: StatusPublicNote | null;
  readonly components: readonly StatusComponentPayload[];
}

export interface StatusMaintenanceInput {
  /** enabled && !controlUnavailable, as the App reads it. */
  readonly active: boolean;
  /** When the active maintenance began, in epoch ms. */
  readonly sinceMs: number | null;
}

export interface StatusPayloadInput {
  readonly nowMs: number;
  /** The ledger rows of the last 48 hours, or null when they could not be read. */
  readonly rows: readonly StatusCheckRow[] | null;
  readonly maintenance: StatusMaintenanceInput;
  /** The published status note, or null when there is none or it could not be read. */
  readonly note: StatusPublicNote | null;
}

const MINUTE_MS = 60_000;
const STATUS_INTERVAL_MS = STATUS_CHECK_INTERVAL_MINUTES * MINUTE_MS;
const STATUS_STALE_AFTER_MS = STATUS_STALE_AFTER_MINUTES * MINUTE_MS;

interface ComponentSummary {
  readonly payload: StatusComponentPayload;
  readonly lastCheckedMs: number | null;
  readonly problemSinceMs: number | null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : iso(ms);
}

function earliest(values: readonly (number | null)[]): number | null {
  let found: number | null = null;
  for (const value of values) {
    if (value !== null && (found === null || value < found)) found = value;
  }
  return found;
}

function newest(values: readonly (number | null)[]): number | null {
  let found: number | null = null;
  for (const value of values) {
    if (value !== null && (found === null || value > found)) found = value;
  }
  return found;
}

/** The component's rows, oldest slot first, one per slot (the newest checked_at wins). */
function componentRows(rows: readonly StatusCheckRow[], id: StatusComponentId): StatusCheckRow[] {
  const bySlot = new Map<number, StatusCheckRow>();
  for (const row of rows) {
    if (row.component !== id || !isStatusCheckRow(row)) continue;
    const kept = bySlot.get(row.slotAt);
    if (!kept || row.checkedAt >= kept.checkedAt) bySlot.set(row.slotAt, row);
  }
  return [...bySlot.values()].sort((left, right) => left.slotAt - right.slotAt);
}

function recentMarks(
  rows: readonly StatusCheckRow[],
  schedule: StatusSchedule,
  nowMs: number,
): StatusRecentPayload | null {
  const first = rows[0];
  if (!first) return null;
  const marks = new Map(rows.map((row) => [row.slotAt, row.result]));
  const current = statusSlotAt(nowMs, schedule);
  const newest = marks.has(current) ? current : current - STATUS_INTERVAL_MS;
  const start = Math.max(newest - (STATUS_RECENT_SLOTS - 1) * STATUS_INTERVAL_MS, first.slotAt);
  if (start > newest) return null;
  let slots = '';
  for (let slot = start; slot <= newest; slot += STATUS_INTERVAL_MS) {
    slots += marks.get(slot) ?? 'n';
  }
  return { lastAt: iso(newest), slots };
}

function summarizeComponent(
  id: StatusComponentId,
  rows: readonly StatusCheckRow[],
  nowMs: number,
  maintenanceActive: boolean,
): ComponentSummary {
  const checks = rows.filter((row) => row.result !== 'm');
  const lastCheckedMs = newest(checks.map((row) => row.checkedAt));
  const lastOkMs = newest(checks.filter((row) => row.result === 'o').map((row) => row.checkedAt));
  let failures = 0;
  while (checks[checks.length - 1 - failures]?.result === 'p') failures += 1;
  const newestFailure = checks[checks.length - 1];
  const firstFailure = checks[checks.length - failures];

  let state: StatusState;
  let reason: string;
  let problemSinceMs: number | null = null;
  if (maintenanceActive) {
    state = 'maintenance';
    reason = STATUS_REASON_MAINTENANCE;
  } else if (lastCheckedMs === null || nowMs - lastCheckedMs > STATUS_STALE_AFTER_MS) {
    state = 'stale';
    reason = STATUS_REASON_NOT_CHECKED_RECENTLY;
  } else if (failures >= STATUS_PROBLEM_AFTER_FAILURES && newestFailure && firstFailure) {
    state = 'problem';
    reason = newestFailure.reason;
    problemSinceMs = firstFailure.checkedAt;
  } else {
    state = 'ok';
    reason = STATUS_REASON_PASSING;
  }
  return {
    payload: {
      id,
      state,
      reason,
      lastCheckedAt: isoOrNull(lastCheckedMs),
      lastOkAt: isoOrNull(lastOkMs),
      problemSince: isoOrNull(problemSinceMs),
      recent: recentMarks(rows, STATUS_COMPONENT_SCHEDULE[id], nowMs),
    },
    lastCheckedMs,
    problemSinceMs,
  };
}

/** Every row without results: stale (results_unavailable), or maintenance while active. */
function unavailableComponent(id: StatusComponentId, maintenanceActive: boolean): ComponentSummary {
  return {
    payload: {
      id,
      state: maintenanceActive ? 'maintenance' : 'stale',
      reason: maintenanceActive ? STATUS_REASON_MAINTENANCE : STATUS_REASON_RESULTS_UNAVAILABLE,
      lastCheckedAt: null,
      lastOkAt: null,
      problemSince: null,
      recent: null,
    },
    lastCheckedMs: null,
    problemSinceMs: null,
  };
}

function overallPayload(
  summaries: readonly ComponentSummary[],
  resultsAvailable: boolean,
  maintenance: { readonly active: boolean; readonly since: string | null },
): StatusOverallPayload {
  const lastCheckedAt = isoOrNull(newest(summaries.map((summary) => summary.lastCheckedMs)));
  if (maintenance.active) {
    return {
      state: 'maintenance',
      reason: STATUS_REASON_MAINTENANCE,
      lastCheckedAt,
      since: maintenance.since,
    };
  }
  if (!resultsAvailable) {
    return {
      state: 'stale',
      reason: STATUS_REASON_RESULTS_UNAVAILABLE,
      lastCheckedAt: null,
      since: null,
    };
  }
  const problems = summaries.filter((summary) => summary.payload.state === 'problem');
  if (problems.length > 0) {
    return {
      state: 'problem',
      reason: STATUS_REASON_COMPONENT_PROBLEM,
      lastCheckedAt,
      since: isoOrNull(earliest(problems.map((summary) => summary.problemSinceMs))),
    };
  }
  if (summaries.some((summary) => summary.payload.state === 'stale')) {
    return {
      state: 'stale',
      reason: STATUS_REASON_NOT_CHECKED_RECENTLY,
      lastCheckedAt,
      since: null,
    };
  }
  return { state: 'ok', reason: STATUS_REASON_ALL_PASSING, lastCheckedAt, since: null };
}

/** The note while it is published: a message and no expiry, or an expiry after nowMs. */
function activeNote(note: StatusPublicNote | null, nowMs: number): StatusPublicNote | null {
  if (!note || typeof note.message !== 'string' || note.message.trim() === '') return null;
  if (note.expiresAt !== null && !(Date.parse(note.expiresAt) > nowMs)) return null;
  return {
    id: note.id,
    message: note.message,
    postedAt: note.postedAt,
    expiresAt: note.expiresAt,
  };
}

/** Builds the /api/status body for nowMs. */
export function buildStatusPayload(input: StatusPayloadInput): StatusPayload {
  const { nowMs, rows } = input;
  if (!Number.isFinite(nowMs)) throw new TypeError('Invalid status payload time');
  const maintenanceActive = input.maintenance.active === true;
  const sinceMs = input.maintenance.sinceMs;
  const maintenance = {
    active: maintenanceActive,
    since:
      maintenanceActive && typeof sinceMs === 'number' && Number.isFinite(sinceMs)
        ? iso(sinceMs)
        : null,
  };
  const summaries = STATUS_COMPONENT_IDS.map((id) =>
    rows === null
      ? unavailableComponent(id, maintenanceActive)
      : summarizeComponent(id, componentRows(rows, id), nowMs, maintenanceActive),
  );
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: iso(nowMs),
    timeZone: 'UTC',
    policy: {
      checkIntervalMinutes: STATUS_CHECK_INTERVAL_MINUTES,
      problemAfterFailures: STATUS_PROBLEM_AFTER_FAILURES,
      staleAfterMinutes: STATUS_STALE_AFTER_MINUTES,
      recentSlots: STATUS_RECENT_SLOTS,
      schedule: {
        server: [...STATUS_SERVER_CHECK_MINUTES],
        browser: [...STATUS_BROWSER_CHECK_MINUTES],
      },
    },
    overall: overallPayload(summaries, rows !== null, maintenance),
    maintenance,
    announcement: activeNote(input.note, nowMs),
    components: summaries.map((summary) => summary.payload),
  };
}
