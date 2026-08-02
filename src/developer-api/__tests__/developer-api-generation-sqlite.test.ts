import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const DEVELOPER_SCHEMA = readFileSync(
  new URL('../../../cloudflare/developer-api.schema.sql', import.meta.url),
  'utf8',
);

const sqlite = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return null;
  }
})();

function openDatabase(): DatabaseSync {
  if (!sqlite) throw new Error('node:sqlite is unavailable');
  return new sqlite.DatabaseSync(':memory:');
}

function insertKey(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO mxqr_developer_api_keys
       (
         key_id,
         room_code,
         room_generation,
         label,
         secret_digest,
         scope_mask,
         status,
         created_at,
         updated_at,
         expires_at
       )
     VALUES (?, '000010', 2, 'immutable key', ?, 1, 'active', 100, 100, 1000)`,
  ).run('ImmutableKey0001', 'a'.repeat(43));
}

(sqlite ? describe : describe.skip)(
  'Developer API incarnation fences against tracked SQLite/D1 schema',
  () => {
    it('keeps generation tombstones permanent while allowing an earlier same-request repair', () => {
      const db = openDatabase();
      try {
        db.exec(DEVELOPER_SCHEMA);
        db.exec(
          `INSERT INTO mxqr_developer_api_room_generation_tombstones
             (room_code, room_generation, request_id, decommissioned_at)
           VALUES ('000010', 2, 'request-a', 200);`,
        );

        db.exec(
          `UPDATE mxqr_developer_api_room_generation_tombstones
           SET decommissioned_at = 150
           WHERE room_code = '000010' AND room_generation = 2;`,
        );

        expect(() =>
          db.exec(
            `UPDATE mxqr_developer_api_room_generation_tombstones
             SET request_id = 'request-b'
             WHERE room_code = '000010' AND room_generation = 2`,
          ),
        ).toThrow(/tombstone_immutable/i);
        expect(() =>
          db.exec(
            `UPDATE mxqr_developer_api_room_generation_tombstones
             SET decommissioned_at = 151
             WHERE room_code = '000010' AND room_generation = 2`,
          ),
        ).toThrow(/tombstone_immutable/i);
        expect(() =>
          db.exec(
            `UPDATE mxqr_developer_api_room_generation_tombstones
             SET room_generation = 3
             WHERE room_code = '000010' AND room_generation = 2`,
          ),
        ).toThrow(/tombstone_immutable/i);
        expect(() =>
          db.exec(
            `DELETE FROM mxqr_developer_api_room_generation_tombstones
             WHERE room_code = '000010' AND room_generation = 2`,
          ),
        ).toThrow(/tombstone_immutable/i);
      } finally {
        db.close();
      }
    });

    it('prevents rebinding a Developer API key to another room incarnation', () => {
      const db = openDatabase();
      try {
        db.exec(DEVELOPER_SCHEMA);
        insertKey(db);

        expect(() =>
          db.exec(
            `UPDATE mxqr_developer_api_keys
             SET room_code = '000011'
             WHERE key_id = 'ImmutableKey0001'`,
          ),
        ).toThrow(/key_incarnation_immutable/i);
        expect(() =>
          db.exec(
            `UPDATE mxqr_developer_api_keys
             SET room_generation = 3
             WHERE key_id = 'ImmutableKey0001'`,
          ),
        ).toThrow(/key_incarnation_immutable/i);

        db.exec(
          `UPDATE mxqr_developer_api_keys
           SET status = 'revoked', revoked_at = 300, updated_at = 300
           WHERE key_id = 'ImmutableKey0001'`,
        );
        expect(
          db
            .prepare(
              `SELECT room_code, room_generation, status
               FROM mxqr_developer_api_keys
               WHERE key_id = 'ImmutableKey0001'`,
            )
            .get(),
        ).toEqual({ room_code: '000010', room_generation: 2, status: 'revoked' });
      } finally {
        db.close();
      }
    });

    it('records a natural-expiry audit when the cleanup preserves the trigger timestamp', () => {
      const db = openDatabase();
      try {
        db.exec(DEVELOPER_SCHEMA);
        insertKey(db);

        db.exec(
          `UPDATE mxqr_developer_api_keys
           SET status = 'revoked',
               revoked_at = expires_at,
               updated_at = CASE
                 WHEN updated_at > expires_at THEN updated_at
                 ELSE expires_at
               END
           WHERE room_code = '000010'
             AND room_generation = 2
             AND status = 'active'
             AND expires_at <= 2000`,
        );

        expect(
          db
            .prepare(
              `SELECT actor_id, action, result, key_id, room_code, room_generation, created_at
               FROM mxqr_developer_api_admin_audit
               WHERE key_id = 'ImmutableKey0001'`,
            )
            .get(),
        ).toEqual({
          actor_id: 'system:expiry',
          action: 'key.expire',
          result: 'expired',
          key_id: 'ImmutableKey0001',
          room_code: '000010',
          room_generation: 2,
          created_at: 1000,
        });
      } finally {
        db.close();
      }
    });
  },
);
