// Resource owner: RO-57 (the public status check ledger; see docs/design/resource-ownership-registry.md).
/**
 * The status check ledger: the mxqr_status_checks table in the admin metrics
 * D1 database, one row per status row (component) and 15-minute slot. It is
 * the resource of registry record RO-57, and this module is its only writer.
 * The App Worker cron's server checks and the GitHub browser monitor's report
 * both write through recordStatusChecks, the cron deletes old rows through
 * pruneStatusChecks, and GET /api/status reads through readStatusChecks.
 *
 * When two checks report the same slot, the newest checked_at wins in the
 * upsert itself, so a late cron run, a browser report and a re-run converge
 * whatever order they arrive in. Every row is checked against
 * cloudflare/status-contract.ts before it is bound, and every row read back is
 * checked the same way, so a malformed row never reaches the public payload.
 * Nothing here logs, sets a timer or puts row content into an error message.
 */

import {
  STATUS_COMPONENT_SCHEDULE,
  isStatusComponentId,
  isStatusReason,
  statusSlotAt,
  type StatusCheckRow,
  type StatusCheckSource,
  type StatusStoredResult,
} from './status-contract.ts';

/** A value the ledger binds: text, an integer or NULL. */
export type StatusD1Value = string | number | null;

/** The part of a D1 prepared statement the ledger uses. */
export interface StatusD1Statement {
  bind(...values: StatusD1Value[]): StatusD1Statement;
  run(): Promise<unknown>;
  all(): Promise<unknown>;
}

/** The part of a D1 database binding the ledger uses. */
export interface StatusD1Database {
  prepare(query: string): StatusD1Statement;
  batch(statements: StatusD1Statement[]): Promise<unknown>;
}

/** A GitHub Actions run id as the ledger keeps it (the column allows 1 to 32 characters). */
const STATUS_RUN_ID_RE = /^[0-9A-Za-z._-]{1,32}$/u;

const RECORD_SQL = `INSERT INTO mxqr_status_checks
  (component, slot_at, result, reason, checked_at, source, run_id)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(component, slot_at) DO UPDATE SET
  result = excluded.result,
  reason = excluded.reason,
  checked_at = excluded.checked_at,
  source = excluded.source,
  run_id = excluded.run_id
WHERE excluded.checked_at >= mxqr_status_checks.checked_at`;

const READ_SQL = `SELECT component, slot_at, result, reason, checked_at, source, run_id
FROM mxqr_status_checks
WHERE slot_at >= ?
ORDER BY slot_at, component`;

const PRUNE_SQL = 'DELETE FROM mxqr_status_checks WHERE slot_at < ?';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStoredResult(value: unknown): value is StatusStoredResult {
  return value === 'o' || value === 'p' || value === 'm';
}

function isCheckSource(value: unknown): value is StatusCheckSource {
  return value === 'cron' || value === 'browser';
}

/** The first field that keeps a value from being a ledger row, or null for a valid row. */
function statusCheckRowProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'row';
  const { component, slotAt, result, reason, checkedAt, source, runId } = value;
  if (!isStatusComponentId(component)) return 'component';
  if (!isEpochMs(slotAt) || statusSlotAt(slotAt, STATUS_COMPONENT_SCHEDULE[component]) !== slotAt) {
    return 'slotAt';
  }
  if (!isStoredResult(result)) return 'result';
  if (!isStatusReason(reason)) return 'reason';
  if (!isEpochMs(checkedAt)) return 'checkedAt';
  if (!isCheckSource(source)) return 'source';
  if (runId !== null && !(typeof runId === 'string' && STATUS_RUN_ID_RE.test(runId))) {
    return 'runId';
  }
  return null;
}

/**
 * Whether a value is a ledger row the contract accepts: a known component, a
 * slot on that component's schedule, o/p/m, a reason, safe epoch-ms integers,
 * a known source and a run id that is null or 1 to 32 id characters.
 */
export function isStatusCheckRow(value: unknown): value is StatusCheckRow {
  return statusCheckRowProblem(value) === null;
}

function assertD1Answer(answer: unknown, failure: string): void {
  const answers = Array.isArray(answer) ? answer : [answer];
  if (answers.some((entry) => isRecord(entry) && entry.success === false)) {
    throw new Error(failure);
  }
}

/**
 * Records results in one D1 batch. Every row is checked first, so an invalid
 * row writes nothing; the error names only the field. A slot that already has
 * a row keeps whichever of the two has the newer checked_at (a tie goes to the
 * later write).
 */
export async function recordStatusChecks(
  db: StatusD1Database,
  rows: readonly StatusCheckRow[],
): Promise<void> {
  if (!Array.isArray(rows)) throw new TypeError('Status check rows must be an array');
  for (const row of rows) {
    const problem = statusCheckRowProblem(row);
    if (problem !== null) throw new TypeError(`Invalid status check row (${problem})`);
  }
  if (rows.length === 0) return;
  const statement = db.prepare(RECORD_SQL);
  const answer = await db.batch(
    rows.map((row) =>
      statement.bind(
        row.component,
        row.slotAt,
        row.result,
        row.reason,
        row.checkedAt,
        row.source,
        row.runId,
      ),
    ),
  );
  assertD1Answer(answer, 'Status check write failed');
}

function rowFromD1(value: unknown): StatusCheckRow | null {
  if (!isRecord(value)) return null;
  const row = {
    component: value.component,
    slotAt: value.slot_at,
    result: value.result,
    reason: value.reason,
    checkedAt: value.checked_at,
    source: value.source,
    runId: value.run_id ?? null,
  };
  return isStatusCheckRow(row) ? row : null;
}

/**
 * Reads every row whose slot is at or after sinceMs, oldest slot first. Rows
 * the contract would refuse are left out. A failed read rejects; the caller
 * decides what a missing ledger means.
 */
export async function readStatusChecks(
  db: StatusD1Database,
  sinceMs: number,
): Promise<StatusCheckRow[]> {
  if (!Number.isSafeInteger(sinceMs)) throw new TypeError('Invalid status check read window');
  const answer = await db.prepare(READ_SQL).bind(sinceMs).all();
  if (!isRecord(answer) || answer.success === false || !Array.isArray(answer.results)) {
    throw new Error('Status check read failed');
  }
  const rows: StatusCheckRow[] = [];
  for (const value of answer.results) {
    const row = rowFromD1(value);
    if (row) rows.push(row);
  }
  return rows;
}

/** Deletes every row whose slot is before beforeMs. */
export async function pruneStatusChecks(db: StatusD1Database, beforeMs: number): Promise<void> {
  if (!Number.isSafeInteger(beforeMs)) throw new TypeError('Invalid status check prune boundary');
  const answer = await db.prepare(PRUNE_SQL).bind(beforeMs).run();
  assertD1Answer(answer, 'Status check prune failed');
}
