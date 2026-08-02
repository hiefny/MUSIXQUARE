import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const DEVELOPER_SCHEMA = readFileSync(
  new URL('../../../cloudflare/developer-api.schema.sql', import.meta.url),
  'utf8',
);
const AUTHORITY_FENCE_MIGRATION = readFileSync(
  new URL('../../../cloudflare/developer-api.authority-fence.migration.sql', import.meta.url),
  'utf8',
);
const AUTHORITY_EPOCH_MIGRATION = readFileSync(
  new URL('../../../cloudflare/developer-api.authority-epoch.migration.sql', import.meta.url),
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

function insertKey(
  db: DatabaseSync,
  keyId: string,
  digestCharacter: string,
  roomGeneration: number,
  status: 'active' | 'revoked' = 'active',
): void {
  db.prepare(
    `INSERT INTO mxqr_developer_api_keys
       (key_id, room_code, room_generation, label, secret_digest, digest_version,
        scope_mask, status, created_at, updated_at, expires_at, revoked_at, last_used_hour)
     VALUES (?, '000021', ?, 'Fence test', ?, 1, 1, ?, 100, 100, 1000, ?, NULL)`,
  ).run(
    keyId,
    roomGeneration,
    digestCharacter.repeat(43),
    status,
    status === 'revoked' ? 150 : null,
  );
}

(sqlite ? describe : describe.skip)('Developer API ownership authority fence in SQLite/D1', () => {
  it('binds baseline keys to an immutable nonnegative owner-authority epoch', () => {
    const db = openDatabase();
    try {
      db.exec(DEVELOPER_SCHEMA);
      insertKey(db, 'EpochZeroKey0001', 'Z', 7);
      expect(
        db
          .prepare(
            `SELECT authority_epoch
               FROM mxqr_developer_api_keys
              WHERE key_id = 'EpochZeroKey0001'`,
          )
          .get(),
      ).toEqual({ authority_epoch: 0 });
      expect(() =>
        db.exec(
          `UPDATE mxqr_developer_api_keys
              SET authority_epoch = 1
            WHERE key_id = 'EpochZeroKey0001'`,
        ),
      ).toThrow(/developer_api_key_authority_epoch_immutable/i);
      expect(() =>
        db.exec(
          `INSERT INTO mxqr_developer_api_keys
             (key_id, room_code, room_generation, authority_epoch, label, secret_digest,
              digest_version, scope_mask, status, created_at, updated_at, expires_at,
              revoked_at, last_used_hour)
           VALUES ('NegativeEpoch001', '000021', 7, -1, 'Invalid epoch',
                   '${'N'.repeat(43)}', 1, 1, 'active', 100, 100, 1000, NULL, NULL)`,
        ),
      ).toThrow(/check constraint/i);
    } finally {
      db.close();
    }
  });

  it('backfills and locks authority epoch through the forward migration', () => {
    const db = openDatabase();
    try {
      db.exec(
        `CREATE TABLE mxqr_developer_api_keys (
           key_id TEXT PRIMARY KEY NOT NULL,
           room_code TEXT NOT NULL,
           room_generation INTEGER NOT NULL DEFAULT 0,
           status TEXT NOT NULL
         );
         INSERT INTO mxqr_developer_api_keys
           (key_id, room_code, room_generation, status)
         VALUES ('LegacyEpochKey001', '000021', 7, 'active');`,
      );
      db.exec(AUTHORITY_EPOCH_MIGRATION);
      expect(
        db
          .prepare(
            `SELECT authority_epoch
               FROM mxqr_developer_api_keys
              WHERE key_id = 'LegacyEpochKey001'`,
          )
          .get(),
      ).toEqual({ authority_epoch: 0 });
      expect(() =>
        db.exec(
          `UPDATE mxqr_developer_api_keys
              SET authority_epoch = 2
            WHERE key_id = 'LegacyEpochKey001'`,
        ),
      ).toThrow(/developer_api_key_authority_epoch_immutable/i);
      expect(() =>
        db.exec(
          `INSERT INTO mxqr_developer_api_keys
             (key_id, room_code, room_generation, status, authority_epoch)
           VALUES ('NegativeEpoch002', '000021', 8, 'active', -1)`,
        ),
      ).toThrow(/check constraint/i);
    } finally {
      db.close();
    }
  });

  it('blocks issue and reactivation only for the exact actively fenced incarnation', () => {
    const db = openDatabase();
    try {
      db.exec(DEVELOPER_SCHEMA);
      insertKey(db, 'RevokedKey000001', 'A', 7, 'revoked');
      db.prepare(
        `INSERT INTO mxqr_developer_api_room_authority_fences
           (room_code, room_generation, status, reason, fence_digest, fenced_at, updated_at)
         VALUES ('000021', 7, 'active', 'ownership_transfer_pending', ?, 120, 120)`,
      ).run('F'.repeat(43));

      expect(() => insertKey(db, 'BlockedKey000001', 'B', 7)).toThrow(
        /DEVELOPER_API_AUTHORITY_FENCED/i,
      );
      expect(() =>
        db.exec(
          `UPDATE mxqr_developer_api_keys
           SET status = 'active', revoked_at = NULL, updated_at = 160
           WHERE key_id = 'RevokedKey000001'`,
        ),
      ).toThrow(/DEVELOPER_API_AUTHORITY_FENCED/i);

      insertKey(db, 'OtherGenKey00001', 'C', 8);
      expect(
        db
          .prepare(
            `SELECT room_generation, status
             FROM mxqr_developer_api_keys
             WHERE key_id = 'OtherGenKey00001'`,
          )
          .get(),
      ).toEqual({ room_generation: 8, status: 'active' });

      db.exec(
        `UPDATE mxqr_developer_api_room_authority_fences
         SET status = 'cleared', updated_at = 200
         WHERE room_code = '000021' AND room_generation = 7`,
      );
      insertKey(db, 'ClearedKey000001', 'D', 7);
      expect(
        db
          .prepare(
            `SELECT status
             FROM mxqr_developer_api_keys
             WHERE key_id = 'ClearedKey000001'`,
          )
          .get(),
      ).toEqual({ status: 'active' });

      expect(() =>
        db.exec(
          `INSERT INTO mxqr_developer_api_room_authority_fences
             (room_code, room_generation, status, reason, fence_digest, fenced_at, updated_at)
           VALUES ('000022', 0, 'active', 'unknown_reason',
                   '${'E'.repeat(43)}', 1, 1)`,
        ),
      ).toThrow(/check constraint/i);
    } finally {
      db.close();
    }
  });

  it('installs the same fail-closed issue guard through the forward migration', () => {
    const db = openDatabase();
    try {
      db.exec(
        `CREATE TABLE mxqr_developer_api_keys (
           key_id TEXT PRIMARY KEY NOT NULL,
           room_code TEXT NOT NULL,
           room_generation INTEGER NOT NULL DEFAULT 0,
           status TEXT NOT NULL
         );`,
      );
      db.exec(AUTHORITY_FENCE_MIGRATION);
      db.prepare(
        `INSERT INTO mxqr_developer_api_room_authority_fences
           (room_code, room_generation, status, reason, fence_digest, fenced_at, updated_at)
         VALUES ('000023', 3, 'active', 'owner_account_deleted', ?, 10, 10)`,
      ).run('G'.repeat(43));

      expect(() =>
        db.exec(
          `INSERT INTO mxqr_developer_api_keys
             (key_id, room_code, room_generation, status)
           VALUES ('MigratedKey00001', '000023', 3, 'active')`,
        ),
      ).toThrow(/DEVELOPER_API_AUTHORITY_FENCED/i);
      db.exec(
        `INSERT INTO mxqr_developer_api_keys
           (key_id, room_code, room_generation, status)
         VALUES ('MigratedKey00002', '000023', 4, 'active')`,
      );
      expect(
        db
          .prepare(
            `SELECT room_generation
             FROM mxqr_developer_api_keys
             WHERE key_id = 'MigratedKey00002'`,
          )
          .get(),
      ).toEqual({ room_generation: 4 });
    } finally {
      db.close();
    }
  });
});
