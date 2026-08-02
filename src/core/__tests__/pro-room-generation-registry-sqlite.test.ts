import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const ADMIN_SCHEMA = readFileSync(
  new URL('../../../cloudflare/admin-metrics.schema.sql', import.meta.url),
  'utf8',
);
const ADMIN_GENERATION_MIGRATION = readFileSync(
  new URL('../../../cloudflare/admin-metrics.pro-room-generation.migration.sql', import.meta.url),
  'utf8',
);
const ADMIN_SUSPENSION_REASON_MIGRATION = readFileSync(
  new URL('../../../cloudflare/admin-metrics.suspension-reason.migration.sql', import.meta.url),
  'utf8',
);
const ADMIN_OWNER_TRANSFER_SAGA_MIGRATION = readFileSync(
  new URL('../../../cloudflare/admin-metrics.owner-transfer-saga.migration.sql', import.meta.url),
  'utf8',
);
const RELEASE_SHA = '1234567890abcdef1234567890abcdef12345678';

const sqlite = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    // Node 20 remains supported even though node:sqlite starts in Node 22.
    return null;
  }
})();

function openDatabase(): DatabaseSync {
  if (!sqlite) throw new Error('node:sqlite is unavailable');
  return new sqlite.DatabaseSync(':memory:');
}

function insertRegistry(
  db: DatabaseSync,
  roomCode: string,
  status = 'registered',
  generation = 0,
): void {
  db.prepare(
    `INSERT INTO mxqr_pro_room_registry
       (
         room_code,
         label,
         status,
         activation_state,
         room_generation,
         created_at,
         updated_at
       )
     VALUES (?, ?, ?, 'unactivated', ?, 100, 100)`,
  ).run(roomCode, `Room ${roomCode}`, status, generation);
}

function enableCutover(db: DatabaseSync): void {
  db.prepare(
    `UPDATE mxqr_pro_room_generation_cutover
     SET status = 'ready',
         release_sha = ?,
         ever_enabled = 1,
         floor_release_sha = COALESCE(floor_release_sha, ?),
         updated_at = 200
     WHERE contract_version = 1`,
  ).run(RELEASE_SHA, RELEASE_SHA);
}

function conditionalInitialRegistration(
  db: DatabaseSync,
  roomCode: string,
  label: string,
  timestamp: number,
): number {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO mxqr_pro_room_registry
         (
           room_code,
           label,
           status,
           activation_state,
           room_generation,
           created_at,
           updated_at
         )
       SELECT ?, ?, 'provisioning', 'unactivated', 0, ?, ?
       WHERE (
         SELECT COUNT(*)
         FROM mxqr_pro_room_registry
         WHERE status <> 'decommissioned'
       ) < 1000
         AND NOT EXISTS (
           SELECT 1
           FROM mxqr_pro_room_generation_allocations
           WHERE room_code = ?
         )
         AND NOT EXISTS (
           SELECT 1
           FROM mxqr_pro_room_generation_history
           WHERE room_code = ?
         )`,
    )
    .run(roomCode, label, timestamp, timestamp, roomCode, roomCode);
  return Number(result.changes);
}

(sqlite ? describe : describe.skip)(
  'PRO room generation registry against tracked SQLite/D1 schemas',
  () => {
    it('allocates each incarnation once and enforces pointer, history, and floor immutability', () => {
      const db = openDatabase();
      try {
        db.exec(ADMIN_SCHEMA);
        insertRegistry(db, '000010');

        expect(
          db
            .prepare(
              `SELECT room_generation, allocated_at
               FROM mxqr_pro_room_generation_allocations
               WHERE room_code = '000010'`,
            )
            .all(),
        ).toEqual([{ room_generation: 0, allocated_at: 100 }]);

        expect(() =>
          db.exec(`DELETE FROM mxqr_pro_room_registry WHERE room_code = '000010'`),
        ).toThrow(/registry pointers are immutable/i);
        expect(() =>
          db.exec(
            `UPDATE mxqr_pro_room_registry
             SET room_code = '000011'
             WHERE room_code = '000010'`,
          ),
        ).toThrow(/registry code is immutable/i);
        expect(() =>
          db.exec(
            `UPDATE mxqr_pro_room_generation_allocations
             SET allocated_at = 101
             WHERE room_code = '000010' AND room_generation = 0`,
          ),
        ).toThrow(/generation allocation is immutable/i);
        expect(() =>
          db.exec(
            `DELETE FROM mxqr_pro_room_generation_allocations
             WHERE room_code = '000010' AND room_generation = 0`,
          ),
        ).toThrow(/generation allocation is immutable/i);
        expect(() =>
          db.exec(
            `INSERT INTO mxqr_pro_room_generation_history
               (room_code, room_generation, status, decommissioned_at)
             VALUES ('000010', 7, 'decommissioned', 101)`,
          ),
        ).toThrow(/generation allocation is missing/i);
        expect(() => insertRegistry(db, '000011', 'unknown-status')).toThrow(
          /invalid pro room registry status/i,
        );

        expect(() =>
          db.exec(
            `UPDATE mxqr_pro_room_registry
             SET status = 'provisioning', room_generation = 1
             WHERE room_code = '000010'`,
          ),
        ).toThrow(/invalid pro room generation transition/i);

        db.exec(
          `INSERT INTO mxqr_pro_room_generation_history
             (room_code, room_generation, status, decommissioned_at)
           VALUES ('000010', 0, 'decommissioned', 150);
           UPDATE mxqr_pro_room_registry
           SET status = 'decommissioned', updated_at = 150
           WHERE room_code = '000010';`,
        );
        expect(() =>
          db.exec(
            `UPDATE mxqr_pro_room_registry
             SET status = 'registered'
             WHERE room_code = '000010'`,
          ),
        ).toThrow(/terminal evidence transition/i);

        expect(() =>
          db.exec(
            `UPDATE mxqr_pro_room_registry
             SET status = 'provisioning',
                 room_generation = room_generation + 1,
                 created_at = 201,
                 updated_at = 201
             WHERE room_code = '000010'`,
          ),
        ).toThrow(/generation cutover is not ready/i);

        expect(() =>
          db
            .prepare(
              `UPDATE mxqr_pro_room_generation_cutover
               SET status = 'ready',
                   release_sha = ?,
                   ever_enabled = 1,
                   floor_release_sha = ?,
                   updated_at = 199
               WHERE contract_version = 1`,
            )
            .run(RELEASE_SHA, 'abcdefabcdefabcdefabcdefabcdefabcdefabcd'),
        ).toThrow(/rollback floor is immutable/i);

        enableCutover(db);
        const first = db
          .prepare(
            `UPDATE mxqr_pro_room_registry
             SET status = 'provisioning',
                 room_generation = room_generation + 1,
                 created_at = 201,
                 updated_at = 201
             WHERE room_code = '000010'
               AND room_generation = 0
               AND status = 'decommissioned'`,
          )
          .run();
        const competing = db
          .prepare(
            `UPDATE mxqr_pro_room_registry
             SET status = 'provisioning',
                 room_generation = room_generation + 1,
                 created_at = 202,
                 updated_at = 202
             WHERE room_code = '000010'
               AND room_generation = 0
               AND status = 'decommissioned'`,
          )
          .run();

        expect(Number(first.changes)).toBe(1);
        expect(Number(competing.changes)).toBe(0);
        expect(
          db
            .prepare(
              `SELECT room_generation
               FROM mxqr_pro_room_generation_allocations
               WHERE room_code = '000010'
               ORDER BY room_generation`,
            )
            .all(),
        ).toEqual([{ room_generation: 0 }, { room_generation: 1 }]);
        expect(
          db
            .prepare(
              `SELECT status, room_generation
               FROM mxqr_pro_room_registry
               WHERE room_code = '000010'`,
            )
            .get(),
        ).toMatchObject({ status: 'provisioning', room_generation: 1 });

        expect(() =>
          db.exec(
            `UPDATE mxqr_pro_room_generation_cutover
             SET ever_enabled = 0, floor_release_sha = NULL
             WHERE contract_version = 1`,
          ),
        ).toThrow(/rollback floor is immutable/i);
        expect(() =>
          db.exec(
            `DELETE FROM mxqr_pro_room_generation_cutover
             WHERE contract_version = 1`,
          ),
        ).toThrow(/generation cutover is permanent/i);

        db.exec(
          `UPDATE mxqr_pro_room_generation_cutover
           SET status = 'disabled', release_sha = NULL, updated_at = 203
           WHERE contract_version = 1`,
        );
        expect(
          db
            .prepare(
              `SELECT status, release_sha, ever_enabled, floor_release_sha
               FROM mxqr_pro_room_generation_cutover
               WHERE contract_version = 1`,
            )
            .get(),
        ).toMatchObject({
          status: 'disabled',
          release_sha: null,
          ever_enabled: 1,
          floor_release_sha: RELEASE_SHA,
        });
      } finally {
        db.close();
      }
    });

    it('keeps deletion states terminal and recovers a rolling-window completion only after evidence exists', () => {
      const db = openDatabase();
      try {
        db.exec(ADMIN_SCHEMA);
        insertRegistry(db, '000012');
        db.exec(
          `UPDATE mxqr_pro_room_registry
           SET status = 'decommissioning'
           WHERE room_code = '000012'`,
        );

        expect(() =>
          db.exec(
            `UPDATE mxqr_pro_room_registry
             SET status = 'registered'
             WHERE room_code = '000012'`,
          ),
        ).toThrow(/terminal evidence transition/i);
        // An old Worker completing during the additive migration has not yet
        // written generation history, so the pointer remains access-blocked.
        expect(() =>
          db.exec(
            `UPDATE mxqr_pro_room_registry
             SET status = 'decommissioned'
             WHERE room_code = '000012'`,
          ),
        ).toThrow(/terminal evidence transition/i);
        expect(
          db.prepare(`SELECT status FROM mxqr_pro_room_registry WHERE room_code = '000012'`).get(),
        ).toEqual({ status: 'decommissioning' });

        // The generation-aware repair/alarm writes immutable evidence first,
        // then the exact same transition succeeds.
        db.exec(
          `INSERT INTO mxqr_pro_room_generation_history
             (room_code, room_generation, status, decommissioned_at)
           VALUES ('000012', 0, 'decommissioned', 200);
           UPDATE mxqr_pro_room_registry
           SET status = 'decommissioned', updated_at = 200
           WHERE room_code = '000012';`,
        );
        expect(() =>
          db.exec(
            `UPDATE mxqr_pro_room_registry
             SET status = 'suspended', suspension_reason = 'operator_suspended'
             WHERE room_code = '000012'`,
          ),
        ).toThrow(/terminal evidence transition/i);
      } finally {
        db.close();
      }
    });

    it('requires a canonical suspension reason on every baseline insert and transition', () => {
      const db = openDatabase();
      try {
        db.exec(ADMIN_SCHEMA);
        insertRegistry(db, '000013');

        expect(() =>
          db.exec(
            `UPDATE mxqr_pro_room_registry
             SET status = 'suspended'
             WHERE room_code = '000013'`,
          ),
        ).toThrow(/invalid pro room suspension reason/i);
        expect(() =>
          db.exec(
            `UPDATE mxqr_pro_room_registry
             SET status = 'suspended', suspension_reason = 'unknown_reason'
             WHERE room_code = '000013'`,
          ),
        ).toThrow(/invalid pro room suspension reason/i);

        for (const reason of [
          'operator_suspended',
          'owner_account_deleted',
          'ownership_transfer_pending',
        ]) {
          db.prepare(
            `UPDATE mxqr_pro_room_registry
             SET status = 'suspended', suspension_reason = ?
             WHERE room_code = '000013'`,
          ).run(reason);
          expect(
            db
              .prepare(
                `SELECT status, suspension_reason
                 FROM mxqr_pro_room_registry
                 WHERE room_code = '000013'`,
              )
              .get(),
          ).toEqual({ status: 'suspended', suspension_reason: reason });
        }

        expect(() =>
          db.exec(
            `UPDATE mxqr_pro_room_registry
             SET status = 'registered'
             WHERE room_code = '000013'`,
          ),
        ).toThrow(/invalid pro room suspension reason/i);
        db.exec(
          `UPDATE mxqr_pro_room_registry
           SET status = 'registered', suspension_reason = NULL
           WHERE room_code = '000013'`,
        );
      } finally {
        db.close();
      }
    });

    it('backfills legacy suspended rows before the reason migration installs strict guards', () => {
      const db = openDatabase();
      try {
        db.exec(
          `CREATE TABLE mxqr_pro_room_registry (
             room_code TEXT PRIMARY KEY NOT NULL,
             label TEXT NOT NULL,
             status TEXT NOT NULL,
             activation_state TEXT NOT NULL,
             room_generation INTEGER NOT NULL DEFAULT 0,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL
           );
           INSERT INTO mxqr_pro_room_registry
             (room_code, label, status, activation_state, room_generation, created_at, updated_at)
           VALUES
             ('000014', 'Legacy suspended', 'suspended', 'active', 0, 1, 1),
             ('000015', 'Legacy active', 'registered', 'active', 0, 1, 1);`,
        );
        db.exec(ADMIN_SUSPENSION_REASON_MIGRATION);

        expect(
          db
            .prepare(
              `SELECT room_code, suspension_reason
               FROM mxqr_pro_room_registry
               ORDER BY room_code`,
            )
            .all(),
        ).toEqual([
          { room_code: '000014', suspension_reason: 'operator_suspended' },
          { room_code: '000015', suspension_reason: null },
        ]);
        expect(() =>
          db.exec(
            `INSERT INTO mxqr_pro_room_registry
               (room_code, label, status, activation_state, room_generation, created_at, updated_at)
             VALUES ('000016', 'Missing reason', 'suspended', 'active', 0, 1, 1)`,
          ),
        ).toThrow(/invalid pro room suspension reason/i);
      } finally {
        db.close();
      }
    });

    it('excludes lifetime tombstones from the cap and serializes same-code and cross-code races', () => {
      const db = openDatabase();
      try {
        db.exec(ADMIN_SCHEMA);
        for (let index = 0; index < 1_000; index += 1) {
          insertRegistry(db, `03${String(index).padStart(4, '0')}`, 'decommissioned');
        }
        for (let index = 0; index < 999; index += 1) {
          insertRegistry(db, `04${String(index).padStart(4, '0')}`);
        }

        expect(
          db
            .prepare(
              `SELECT
                 SUM(status = 'decommissioned') AS tombstones,
                 SUM(status <> 'decommissioned') AS active
               FROM mxqr_pro_room_registry`,
            )
            .get(),
        ).toEqual({ tombstones: 1_000, active: 999 });

        // These model two different registration requests linearized by D1.
        // The COUNT predicate is part of each INSERT, so only one can consume
        // the final slot even if both callers observed 999 beforehand.
        expect(conditionalInitialRegistration(db, '050000', 'Winner', 200)).toBe(1);
        expect(conditionalInitialRegistration(db, '050001', 'Capacity loser', 201)).toBe(0);
        expect(
          db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM mxqr_pro_room_registry
               WHERE status <> 'decommissioned'`,
            )
            .get(),
        ).toEqual({ count: 1_000 });
        expect(
          db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM mxqr_pro_room_generation_allocations
               WHERE room_code IN ('050000', '050001')`,
            )
            .get(),
        ).toEqual({ count: 1 });

        const sameCodeDb = openDatabase();
        try {
          sameCodeDb.exec(ADMIN_SCHEMA);
          expect(conditionalInitialRegistration(sameCodeDb, '060000', 'First', 300)).toBe(1);
          expect(conditionalInitialRegistration(sameCodeDb, '060000', 'Competing', 301)).toBe(0);
          expect(
            sameCodeDb
              .prepare(
                `SELECT room_generation
                 FROM mxqr_pro_room_generation_allocations
                 WHERE room_code = '060000'`,
              )
              .all(),
          ).toEqual([{ room_generation: 0 }]);
        } finally {
          sameCodeDb.close();
        }
      } finally {
        db.close();
      }
    });

    it('fails closed when a pointer is missing but immutable incarnation evidence remains', () => {
      const db = openDatabase();
      try {
        db.exec(ADMIN_SCHEMA);
        insertRegistry(db, '000020');
        db.exec(
          `INSERT INTO mxqr_pro_room_generation_history
             (room_code, room_generation, status, decommissioned_at)
           VALUES ('000020', 0, 'decommissioned', 150);
           UPDATE mxqr_pro_room_registry
           SET status = 'decommissioned', updated_at = 150
           WHERE room_code = '000020';`,
        );

        // Ordinary pointer deletion is impossible. Dropping just that guard
        // simulates a preexisting/out-of-band corruption while preserving the
        // independent allocation and history fences.
        db.exec(
          `DROP TRIGGER mxqr_pro_room_registry_no_delete;
           DELETE FROM mxqr_pro_room_registry WHERE room_code = '000020';`,
        );
        expect(
          db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM mxqr_pro_room_generation_allocations
               WHERE room_code = '000020'`,
            )
            .get(),
        ).toMatchObject({ count: 1 });
        expect(
          db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM mxqr_pro_room_generation_history
               WHERE room_code = '000020'`,
            )
            .get(),
        ).toMatchObject({ count: 1 });

        expect(() => insertRegistry(db, '000020')).toThrow(/registry repair required/i);
        expect(
          db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM mxqr_pro_room_registry
               WHERE room_code = '000020'`,
            )
            .get(),
        ).toMatchObject({ count: 0 });
      } finally {
        db.close();
      }
    });

    it('backfills every legacy current and terminal generation before installing guards', () => {
      const db = openDatabase();
      try {
        db.exec(
          `CREATE TABLE mxqr_pro_room_registry (
             room_code TEXT PRIMARY KEY NOT NULL,
             label TEXT NOT NULL,
             status TEXT NOT NULL DEFAULT 'registered',
             activation_state TEXT NOT NULL DEFAULT 'unactivated',
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL
           );
           CREATE TABLE mxqr_pro_room_admin_audit (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             actor_id TEXT NOT NULL,
             action TEXT NOT NULL,
             result TEXT NOT NULL,
             room_code TEXT NOT NULL,
             created_at INTEGER NOT NULL
           );
           INSERT INTO mxqr_pro_room_registry
             (room_code, label, status, activation_state, created_at, updated_at)
           VALUES
             ('000030', 'Active legacy', 'registered', 'active', 30, 31),
             ('000031', 'Deleted legacy', 'decommissioned', 'unactivated', 40, 41);`,
        );
        db.exec(ADMIN_GENERATION_MIGRATION);

        expect(
          db
            .prepare(
              `SELECT room_code, room_generation
               FROM mxqr_pro_room_generation_allocations
               ORDER BY room_code`,
            )
            .all(),
        ).toEqual([
          { room_code: '000030', room_generation: 0 },
          { room_code: '000031', room_generation: 0 },
        ]);
        expect(
          db
            .prepare(
              `SELECT room_code, room_generation, status
               FROM mxqr_pro_room_generation_history`,
            )
            .all(),
        ).toEqual([
          {
            room_code: '000031',
            room_generation: 0,
            status: 'decommissioned',
          },
        ]);
        expect(() =>
          db.exec(`DELETE FROM mxqr_pro_room_registry WHERE room_code = '000030'`),
        ).toThrow(/registry pointers are immutable/i);
        expect(() =>
          db.exec(
            `UPDATE mxqr_pro_room_registry
             SET room_code = '000032'
             WHERE room_code = '000030'`,
          ),
        ).toThrow(/registry code is immutable/i);
      } finally {
        db.close();
      }
    });

    it('keeps owner-transfer journals secret-free and strictly bound to exact identifiers', () => {
      for (const schema of [ADMIN_SCHEMA, ADMIN_OWNER_TRANSFER_SAGA_MIGRATION]) {
        const db = openDatabase();
        try {
          if (schema === ADMIN_OWNER_TRANSFER_SAGA_MIGRATION) {
            db.exec(`CREATE TABLE mxqr_pro_room_admin_audit (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              actor_id TEXT NOT NULL,
              action TEXT NOT NULL,
              result TEXT NOT NULL,
              room_code TEXT NOT NULL,
              room_generation INTEGER NOT NULL,
              created_at INTEGER NOT NULL
            )`);
          }
          db.exec(schema);
          db.exec(
            `INSERT INTO mxqr_pro_room_owner_transfer_issuances
               (room_code, room_generation, claim_generation, target_account_id,
                transfer_id, request_id, state, issued_at, expires_at, updated_at)
             VALUES
               ('000021', 7, 11, 'acct_0123456789abcdefghijkl',
                NULL, NULL, 'issued', 100, 200, 100);
             INSERT INTO mxqr_pro_room_owner_transfer_sagas
               (room_code, room_generation, claim_generation, transfer_id, request_id,
                target_account_id, previous_owner_account_id, fence_digest, state,
                intent_at, prepared_at, expires_at, updated_at)
             VALUES
               ('000021', 7, NULL, NULL, 'request_12345678',
                'acct_0123456789abcdefghijkl', NULL,
                NULL, 'intent', 90, NULL, 200, 90);
             UPDATE mxqr_pro_room_owner_transfer_sagas
                SET claim_generation = 11,
                    transfer_id = 'transfer_abcdefghijklmnopqrstuv',
                    previous_owner_account_id = 'acct_abcdefghijkl0123456789',
                    fence_digest = '${'F'.repeat(43)}',
                    state = 'prepared', prepared_at = 100, updated_at = 100
              WHERE room_code = '000021' AND room_generation = 7
                AND request_id = 'request_12345678';`,
          );
          expect(
            db
              .prepare(
                `SELECT state, transfer_id, request_id
                   FROM mxqr_pro_room_owner_transfer_issuances`,
              )
              .get(),
          ).toEqual({ state: 'issued', transfer_id: null, request_id: null });
          expect(
            db
              .prepare(`SELECT name FROM pragma_table_info('mxqr_pro_room_owner_transfer_sagas')`)
              .all()
              .map((row) => row.name),
          ).not.toEqual(
            expect.arrayContaining([
              'claim_token',
              'claim_nonce',
              'commit_proof',
              'pin',
              'cookie',
              'revocation_receipt',
            ]),
          );
          db.exec(`
            UPDATE mxqr_pro_room_owner_transfer_issuances
               SET state = 'expired', updated_at = 200
             WHERE room_code = '000021' AND room_generation = 7 AND claim_generation = 11;
            UPDATE mxqr_pro_room_owner_transfer_issuances
               SET state = 'expired', updated_at = 201
             WHERE room_code = '000021' AND room_generation = 7 AND claim_generation = 11;
            UPDATE mxqr_pro_room_owner_transfer_sagas
               SET state = 'expired', updated_at = 200
             WHERE room_code = '000021' AND room_generation = 7
               AND request_id = 'request_12345678';
            UPDATE mxqr_pro_room_owner_transfer_sagas
               SET state = 'expired', updated_at = 201
             WHERE room_code = '000021' AND room_generation = 7
               AND request_id = 'request_12345678';
          `);
          expect(
            db
              .prepare(
                `SELECT action, result, COUNT(*) AS count
                   FROM mxqr_pro_room_admin_audit
                  WHERE room_code = '000021' AND room_generation = 7
                  GROUP BY action, result
                  ORDER BY action`,
              )
              .all(),
          ).toEqual([
            { action: 'owner_transfer.prepare', result: 'expired', count: 1 },
            { action: 'owner_transfer_claim.expire', result: 'expired', count: 1 },
          ]);
          for (const invalidSql of [
            `INSERT INTO mxqr_pro_room_owner_transfer_sagas
               (room_code, room_generation, claim_generation, transfer_id, request_id,
                target_account_id, previous_owner_account_id, fence_digest, state,
                intent_at, prepared_at, expires_at, updated_at)
             VALUES ('000021', 7, -1, 'transfer_abcdefghijklmnopqrstuv', 'request_abcdefgh',
                     'acct_0123456789abcdefghijkl', NULL, '${'G'.repeat(43)}',
                     'prepared', 90, 100, 200, 100)`,
            `INSERT INTO mxqr_pro_room_owner_transfer_sagas
               (room_code, room_generation, claim_generation, transfer_id, request_id,
                target_account_id, previous_owner_account_id, fence_digest, state,
                intent_at, prepared_at, expires_at, updated_at)
             VALUES ('000021', 7, 12, 'transfer_short', 'request_abcdefgh',
                     'acct_0123456789abcdefghijkl', NULL, '${'H'.repeat(43)}',
                     'prepared', 90, 100, 200, 100)`,
            `INSERT INTO mxqr_pro_room_owner_transfer_sagas
               (room_code, room_generation, claim_generation, transfer_id, request_id,
                target_account_id, previous_owner_account_id, fence_digest, state,
                intent_at, prepared_at, expires_at, updated_at)
             VALUES ('000021', 7, 12, 'transfer_bcdefghijklmnopqrstuvw', 'request_abcdefgh',
                     'acct_0123456789abcdefghijkl', 'acct_0123456789abcdefghijkl',
                     '${'I'.repeat(43)}', 'prepared', 90, 100, 200, 100)`,
            `INSERT INTO mxqr_pro_room_owner_transfer_sagas
               (room_code, room_generation, claim_generation, transfer_id, request_id,
                target_account_id, previous_owner_account_id, fence_digest, state,
                intent_at, prepared_at, expires_at, updated_at)
             VALUES ('000021', 7, NULL, NULL, 'request_unfilled_1',
                     'acct_0123456789abcdefghijkl', 'acct_abcdefghijkl0123456789',
                     NULL, 'intent', 100, NULL, 200, 100)`,
            `INSERT INTO mxqr_pro_room_owner_transfer_issuances
               (room_code, room_generation, claim_generation, target_account_id,
                transfer_id, request_id, state, issued_at, expires_at, updated_at)
             VALUES ('000021', 7, 13, 'acct_0123456789abcdefghijkl',
                     NULL, NULL, 'prepared', 100, 200, 100)`,
            `INSERT INTO mxqr_pro_room_owner_transfer_issuances
               (room_code, room_generation, claim_generation, target_account_id,
                transfer_id, request_id, state, issued_at, expires_at, updated_at)
             VALUES ('000021', 7, 14, 'acct_short',
                     NULL, NULL, 'issued', 100, 200, 100)`,
          ]) {
            expect(() => db.exec(invalidSql)).toThrow(/constraint/i);
          }
        } finally {
          db.close();
        }
      }
    });
  },
);
