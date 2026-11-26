import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';

import {
  STATUS_CHECK_INTERVAL_MINUTES,
  STATUS_COMPONENT_IDS,
  type StatusCheckRow,
} from '../../../cloudflare/status-contract.ts';
import {
  isStatusCheckRow,
  pruneStatusChecks,
  readStatusChecks,
  recordStatusChecks,
  type StatusD1Database,
  type StatusD1Statement,
  type StatusD1Value,
} from '../../../cloudflare/status-store.ts';
import { normalizeSchemaSql } from '../../../scripts/sql-schema-normalization.mts';

const ADMIN_SCHEMA = readFileSync(
  new URL('../../../cloudflare/admin-metrics.schema.sql', import.meta.url),
  'utf8',
);
const STATUS_CHECKS_MIGRATION = readFileSync(
  new URL('../../../cloudflare/admin-metrics.status-checks.migration.sql', import.meta.url),
  'utf8',
);
const RELEASE_WORKFLOW = readFileSync(
  new URL('../../../.github/workflows/release.yml', import.meta.url),
  'utf8',
);
const SCHEMA_MARKER = '-- Public /status check ledger (RO-57)';

const sqlite = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return null;
  }
})();

const INTERVAL_MS = STATUS_CHECK_INTERVAL_MINUTES * 60_000;
// 2026-11-26 05:45 UTC, a server boundary; the browser boundary 7 minutes later.
const SERVER_SLOT = Date.parse('2026-11-26T05:45:00.000Z');
const BROWSER_SLOT = Date.parse('2026-11-26T05:52:00.000Z');

function openDatabase(sql = ''): DatabaseSync {
  if (!sqlite) throw new Error('node:sqlite is unavailable');
  const db = new sqlite.DatabaseSync(':memory:');
  if (sql) db.exec(sql);
  return db;
}

interface RecordingDatabase extends StatusD1Database {
  readonly batches: StatusD1Statement[][];
}

/** A D1 binding over node:sqlite: bound statements, all/run answers and a transactional batch. */
function d1(db: DatabaseSync): RecordingDatabase {
  const statement = (sql: string, values: readonly StatusD1Value[]): StatusD1Statement => ({
    bind: (...next: StatusD1Value[]) => statement(sql, next),
    run: async () => {
      const result = db.prepare(sql).run(...values);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
    all: async () => ({ success: true, results: db.prepare(sql).all(...values) }),
  });
  const batches: StatusD1Statement[][] = [];
  return {
    batches,
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: StatusD1Statement[]) => {
      batches.push(statements);
      db.exec('BEGIN');
      try {
        const results: unknown[] = [];
        for (const entry of statements) results.push(await entry.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function row(overrides: Partial<StatusCheckRow> = {}): StatusCheckRow {
  return {
    component: 'rooms',
    slotAt: SERVER_SLOT,
    result: 'o',
    reason: 'passing',
    checkedAt: SERVER_SLOT + 6_000,
    source: 'cron',
    runId: null,
    ...overrides,
  };
}

function storedRows(db: DatabaseSync): unknown[] {
  return db
    .prepare(
      `SELECT component, slot_at, result, reason, checked_at, source, run_id
         FROM mxqr_status_checks
        ORDER BY slot_at, component`,
    )
    .all()
    .map((entry) => ({ ...entry }));
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [
      value,
      ...rest,
    ]),
  );
}

function releaseVerificationSql(): string {
  const start = RELEASE_WORKFLOW.indexOf('Apply and verify status checks D1 contract');
  expect(start).toBeGreaterThan(-1);
  const step = RELEASE_WORKFLOW.slice(
    start,
    RELEASE_WORKFLOW.indexOf('\n      - name:', start + 1),
  );
  expect(step).toContain('--file cloudflare/admin-metrics.status-checks.migration.sql');
  const sql = step.match(/verify_sql=\$\(cat <<'SQL'\n([\s\S]+?)\n\s+SQL\n/u)?.[1];
  expect(sql).toBeTruthy();
  return sql!;
}

function schemaDump(db: DatabaseSync): unknown[] {
  return db
    .prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all()
    .map((entry) => ({ ...entry, sql: normalizeSchemaSql(String(entry.sql)) }));
}

(sqlite ? describe : describe.skip)('status check ledger against SQLite/D1', () => {
  it('ships one idempotent DDL in the migration and at the end of the baseline', () => {
    const marker = ADMIN_SCHEMA.indexOf(SCHEMA_MARKER);
    expect(marker).toBeGreaterThan(0);
    const appended = ADMIN_SCHEMA.slice(marker);
    const ddl = (sql: string) =>
      normalizeSchemaSql(sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS mxqr_status_checks')));
    expect(ddl(appended)).toBe(ddl(STATUS_CHECKS_MIGRATION));
    expect(STATUS_CHECKS_MIGRATION.match(/^CREATE TABLE IF NOT EXISTS\b/gmu)).toHaveLength(1);

    const empty = openDatabase();
    try {
      empty.exec(STATUS_CHECKS_MIGRATION);
      empty.exec(STATUS_CHECKS_MIGRATION);
      expect(storedRows(empty)).toEqual([]);
    } finally {
      empty.close();
    }
  });

  it('upgrades the preceding admin baseline to the current one, twice over', () => {
    const marker = ADMIN_SCHEMA.indexOf(SCHEMA_MARKER);
    const previous = openDatabase(ADMIN_SCHEMA.slice(0, marker));
    const current = openDatabase(ADMIN_SCHEMA);
    try {
      const verification = releaseVerificationSql();
      const verified = {
        table_count: 1,
        column_count: 7,
        primary_key_count: 2,
        required_column_count: 7,
      };
      expect({ ...previous.prepare(verification).get() }).toEqual({
        table_count: 0,
        column_count: 0,
        primary_key_count: 0,
        required_column_count: 0,
      });
      previous.exec(STATUS_CHECKS_MIGRATION);
      previous.exec(STATUS_CHECKS_MIGRATION);
      current.exec(STATUS_CHECKS_MIGRATION);
      expect(schemaDump(previous)).toEqual(schemaDump(current));
      expect({ ...previous.prepare(verification).get() }).toEqual(verified);
      expect({ ...current.prepare(verification).get() }).toEqual(verified);
    } finally {
      previous.close();
      current.close();
    }
  });

  it('refuses rows that break a CHECK constraint or the primary key', () => {
    const db = openDatabase(STATUS_CHECKS_MIGRATION);
    try {
      const insert = (values: Record<string, unknown>) => {
        const full = {
          component: 'rooms',
          slot_at: SERVER_SLOT,
          result: 'o',
          reason: 'passing',
          checked_at: SERVER_SLOT + 6_000,
          source: 'cron',
          run_id: null,
          ...values,
        };
        db.prepare(
          `INSERT INTO mxqr_status_checks
             (component, slot_at, result, reason, checked_at, source, run_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          ...([
            full.component,
            full.slot_at,
            full.result,
            full.reason,
            full.checked_at,
            full.source,
            full.run_id,
          ] as (string | number | null)[]),
        );
      };
      insert({});
      const badRows: Array<Record<string, unknown>> = [
        { component: 'signaling' },
        { component: null },
        { slot_at: SERVER_SLOT + 1 },
        { slot_at: -60_000 },
        { slot_at: SERVER_SLOT + 0.5 },
        { slot_at: null },
        { result: 'n' },
        { result: 'x' },
        { reason: '' },
        { reason: 'r'.repeat(49) },
        { reason: null },
        { checked_at: -1 },
        { checked_at: 1.5 },
        { checked_at: null },
        { source: 'manual' },
        { source: null },
        { run_id: '' },
        { run_id: '1'.repeat(33) },
      ];
      for (const bad of badRows) {
        // A free slot, unless the slot itself is the bad value, so the
        // primary key never hides the CHECK being tested.
        const slot = 'slot_at' in bad ? {} : { slot_at: SERVER_SLOT + INTERVAL_MS };
        expect(() => insert({ ...bad, ...slot }), JSON.stringify(bad)).toThrow(
          /constraint failed/iu,
        );
      }
      // The primary key admits one row per component and slot.
      expect(() => insert({ reason: 'another' })).toThrow(/UNIQUE|PRIMARY KEY/iu);
      expect(() => insert({ component: 'pro' })).not.toThrow();
      expect(() =>
        insert({ run_id: '1'.repeat(32), slot_at: SERVER_SLOT + INTERVAL_MS }),
      ).not.toThrow();
      expect(storedRows(db)).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it('keeps the newest checked_at for a slot in every arrival order', async () => {
    // A cron result, a browser report and a re-run that all land in one slot.
    const candidates = [
      row({ checkedAt: SERVER_SLOT + 5_000, result: 'p', reason: 'host_timeout' }),
      row({ checkedAt: SERVER_SLOT + 40_000, source: 'browser', runId: '9101', reason: 'late' }),
      row({
        checkedAt: SERVER_SLOT + 70_000,
        source: 'browser',
        runId: '9102',
        result: 'm',
        reason: 'maintenance',
      }),
    ];
    const winner = candidates[2]!;
    for (const order of permutations(candidates)) {
      const db = openDatabase(STATUS_CHECKS_MIGRATION);
      try {
        const binding = d1(db);
        for (const entry of order) await recordStatusChecks(binding, [entry]);
        expect(await readStatusChecks(binding, 0)).toEqual([winner]);
      } finally {
        db.close();
      }
    }

    // One batch with two answers for a slot keeps the newer one as well.
    const db = openDatabase(STATUS_CHECKS_MIGRATION);
    try {
      const binding = d1(db);
      await recordStatusChecks(binding, [candidates[1]!, candidates[0]!]);
      expect(await readStatusChecks(binding, 0)).toEqual([candidates[1]]);
      // An equal checked_at is a re-delivery: the later write replaces the row.
      const resent = row({ checkedAt: candidates[1]!.checkedAt, reason: 'resent' });
      await recordStatusChecks(binding, [resent]);
      expect(await readStatusChecks(binding, 0)).toEqual([resent]);
    } finally {
      db.close();
    }
  });

  it('records several components in one batch and reads a window oldest slot first', async () => {
    const db = openDatabase(ADMIN_SCHEMA);
    try {
      const binding = d1(db);
      const rows: StatusCheckRow[] = [];
      for (let index = 0; index < 4; index += 1) {
        for (const component of STATUS_COMPONENT_IDS) {
          const browser = component === 'website' || component === 'connection';
          const slotAt = (browser ? BROWSER_SLOT : SERVER_SLOT) - index * INTERVAL_MS;
          rows.push(
            row({
              component,
              slotAt,
              checkedAt: slotAt + 30_000,
              source: browser ? 'browser' : 'cron',
              runId: browser ? `${100 + index}` : null,
              result: index === 1 ? 'p' : 'o',
              reason: index === 1 ? 'relay_failed' : 'passing',
            }),
          );
        }
      }
      await recordStatusChecks(binding, rows.slice(0, 8));
      await recordStatusChecks(binding, rows.slice(8));
      expect(binding.batches.map((batch) => batch.length)).toEqual([8, 8]);

      const all = await readStatusChecks(binding, 0);
      expect(all).toHaveLength(16);
      expect(all).toEqual(
        [...rows].sort(
          (left, right) =>
            left.slotAt - right.slotAt || left.component.localeCompare(right.component),
        ),
      );

      const since = SERVER_SLOT - INTERVAL_MS;
      const window = await readStatusChecks(binding, since);
      expect(window.every((entry) => entry.slotAt >= since)).toBe(true);
      expect(window.map((entry) => `${entry.component}@${entry.slotAt - since}`)).toEqual([
        'pro@0',
        'rooms@0',
        'connection@420000',
        'website@420000',
        'pro@900000',
        'rooms@900000',
        'connection@1320000',
        'website@1320000',
      ]);
    } finally {
      db.close();
    }
  });

  it('prunes rows before the boundary and keeps the boundary slot', async () => {
    const db = openDatabase(STATUS_CHECKS_MIGRATION);
    try {
      const binding = d1(db);
      const slots = [0, 1, 2, 3].map((index) => SERVER_SLOT - index * INTERVAL_MS);
      await recordStatusChecks(
        binding,
        slots.map((slotAt) => row({ slotAt, checkedAt: slotAt + 6_000 })),
      );
      await pruneStatusChecks(binding, slots[1]!);
      expect((await readStatusChecks(binding, 0)).map((entry) => entry.slotAt)).toEqual([
        slots[1],
        slots[0],
      ]);
      await pruneStatusChecks(binding, slots[0]! + 1);
      expect(await readStatusChecks(binding, 0)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('leaves out stored rows that the contract refuses', async () => {
    const db = openDatabase(STATUS_CHECKS_MIGRATION);
    try {
      // Both pass the table's CHECKs but not the contract: a rooms row off the
      // server schedule and a reason outside the reason alphabet.
      db.exec(`INSERT INTO mxqr_status_checks
          (component, slot_at, result, reason, checked_at, source, run_id)
        VALUES ('rooms', ${SERVER_SLOT + 60_000}, 'o', 'passing', ${SERVER_SLOT}, 'cron', NULL),
               ('pro', ${SERVER_SLOT}, 'o', 'Bad-Reason', ${SERVER_SLOT}, 'cron', NULL),
               ('website', ${BROWSER_SLOT}, 'o', 'passing', ${BROWSER_SLOT}, 'browser', '77')`);
      expect(await readStatusChecks(d1(db), 0)).toEqual([
        row({
          component: 'website',
          slotAt: BROWSER_SLOT,
          checkedAt: BROWSER_SLOT,
          source: 'browser',
          runId: '77',
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it('checks every row before binding and writes nothing for an invalid one', async () => {
    const db = openDatabase(STATUS_CHECKS_MIGRATION);
    try {
      const binding = d1(db);
      const invalid: Array<[string, Record<string, unknown>]> = [
        ['component', { component: 'signaling' }],
        ['slotAt', { slotAt: SERVER_SLOT + 60_000 }],
        ['slotAt', { component: 'website' }],
        ['slotAt', { slotAt: -INTERVAL_MS }],
        ['slotAt', { slotAt: Number.MAX_SAFE_INTEGER + 1 }],
        ['result', { result: 'n' }],
        ['reason', { reason: 'Secret-Value' }],
        ['reason', { reason: 'r'.repeat(49) }],
        ['reason', { reason: null }],
        ['checkedAt', { checkedAt: 1.5 }],
        ['checkedAt', { checkedAt: -1 }],
        ['source', { source: 'manual' }],
        ['runId', { runId: '' }],
        ['runId', { runId: '1'.repeat(33) }],
        ['runId', { runId: 'run 1' }],
        ['runId', { runId: undefined }],
      ];
      for (const [field, overrides] of invalid) {
        const bad = { ...row(), ...overrides } as StatusCheckRow;
        expect(isStatusCheckRow(bad)).toBe(false);
        const attempt = recordStatusChecks(binding, [
          row({ slotAt: SERVER_SLOT - INTERVAL_MS }),
          bad,
        ]);
        await expect(attempt).rejects.toThrow(new TypeError(`Invalid status check row (${field})`));
        await attempt.catch((error: unknown) => {
          expect(String(error)).not.toContain('Secret-Value');
        });
      }
      expect(isStatusCheckRow(null)).toBe(false);
      await expect(
        recordStatusChecks(binding, [null as unknown as StatusCheckRow]),
      ).rejects.toThrow('Invalid status check row (row)');
      await expect(
        recordStatusChecks(binding, 'rows' as unknown as StatusCheckRow[]),
      ).rejects.toThrow(TypeError);
      expect(binding.batches).toEqual([]);
      expect(storedRows(db)).toEqual([]);

      // No rows: no batch at all.
      await recordStatusChecks(binding, []);
      expect(binding.batches).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('status check ledger D1 answers', () => {
  function fakeDatabase(answer: { run?: unknown; all?: unknown; batch?: unknown }) {
    const bound: StatusD1Value[][] = [];
    const statement = (): StatusD1Statement => ({
      bind: (...next: StatusD1Value[]) => {
        bound.push(next);
        return statement();
      },
      run: async () => answer.run,
      all: async () => answer.all,
    });
    const database: StatusD1Database = {
      prepare: vi.fn(() => statement()),
      batch: vi.fn(async () => answer.batch),
    };
    return { database, bound };
  }

  it('rejects a failed write, read or prune', async () => {
    const failedWrite = fakeDatabase({ batch: [{ success: true }, { success: false }] });
    await expect(
      recordStatusChecks(failedWrite.database, [row(), row({ component: 'pro' })]),
    ).rejects.toThrow('Status check write failed');
    for (const all of [{ success: false, results: [] }, { results: 'none' }, null, []]) {
      await expect(readStatusChecks(fakeDatabase({ all }).database, 0)).rejects.toThrow(
        'Status check read failed',
      );
    }
    await expect(
      pruneStatusChecks(fakeDatabase({ run: { success: false } }).database, 0),
    ).rejects.toThrow('Status check prune failed');
  });

  it('leaves out answer rows that are not objects', async () => {
    const valid = {
      component: 'pro',
      slot_at: SERVER_SLOT,
      result: 'p',
      reason: 'pro_http_503',
      checked_at: SERVER_SLOT + 7_000,
      source: 'cron',
      run_id: null,
    };
    const reader = fakeDatabase({ all: { results: [null, 'row', [valid], valid] } });
    expect(await readStatusChecks(reader.database, 0)).toEqual([
      row({
        component: 'pro',
        result: 'p',
        reason: 'pro_http_503',
        checkedAt: SERVER_SLOT + 7_000,
      }),
    ]);
  });

  it('binds the read window and the prune boundary and refuses unsafe ones', async () => {
    const reader = fakeDatabase({ all: { results: [] } });
    await readStatusChecks(reader.database, SERVER_SLOT);
    const pruner = fakeDatabase({ run: { success: true } });
    await pruneStatusChecks(pruner.database, SERVER_SLOT);
    expect(reader.bound).toEqual([[SERVER_SLOT]]);
    expect(pruner.bound).toEqual([[SERVER_SLOT]]);
    for (const bad of [Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(readStatusChecks(reader.database, bad)).rejects.toThrow(TypeError);
      await expect(pruneStatusChecks(pruner.database, bad)).rejects.toThrow(TypeError);
    }
    expect(reader.database.prepare).toHaveBeenCalledTimes(1);
    expect(pruner.database.prepare).toHaveBeenCalledTimes(1);
  });

  it('upserts with the newest-wins guard in one batch', async () => {
    const writer = fakeDatabase({ batch: [{ success: true }] });
    await recordStatusChecks(writer.database, [row({ runId: '5', source: 'browser' })]);
    const sql = String(vi.mocked(writer.database.prepare).mock.calls[0]?.[0]);
    expect(sql).toContain('ON CONFLICT(component, slot_at) DO UPDATE SET');
    expect(sql).toContain('WHERE excluded.checked_at >= mxqr_status_checks.checked_at');
    expect(writer.database.batch).toHaveBeenCalledTimes(1);
    expect(writer.bound).toEqual([
      ['rooms', SERVER_SLOT, 'o', 'passing', SERVER_SLOT + 6_000, 'browser', '5'],
    ]);
  });
});
