import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const MIGRATION = readFileSync(
  new URL('../../../cloudflare/admin-metrics.pro-grants.migration.sql', import.meta.url),
  'utf8',
);
const ADMIN_BASELINE = readFileSync(
  new URL('../../../cloudflare/admin-metrics.schema.sql', import.meta.url),
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
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE mxqr_pro_room_registry (
      room_code TEXT PRIMARY KEY,
      room_generation INTEGER NOT NULL,
      status TEXT NOT NULL,
      activation_state TEXT NOT NULL
    );
  `);
  db.exec(MIGRATION);
  return db;
}

function seedCampaignAndBatch(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO mxqr_pro_grant_campaigns
       (campaign_id, slug, title, status, starts_at, ends_at, per_account_limit, created_at, updated_at)
     VALUES (?, 'asamo-0', 'ASAMO', 'active', NULL, NULL, 1, 100, 100)`,
  ).run(`campaign_${'A'.repeat(22)}`);
  db.prepare(
    `INSERT INTO mxqr_pro_grant_voucher_batches
       (campaign_id, request_id, request_digest, status, voucher_count, created_at, updated_at)
     VALUES (?, ?, ?, 'committed', 1, 100, 100)`,
  ).run(`campaign_${'A'.repeat(22)}`, `batch_${'B'.repeat(22)}`, 'C'.repeat(43));
}

(sqlite ? describe : describe.skip)('generic PRO grant D1 schema', () => {
  it('keeps the declarative admin baseline aligned with the forward migration', () => {
    const db = new sqlite!.DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec(ADMIN_BASELINE);
      const grantTables = db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'mxqr_pro_grant_%'
           ORDER BY name`,
        )
        .all();
      expect(grantTables.map((row: any) => row.name)).toEqual([
        'mxqr_pro_grant_account_fences',
        'mxqr_pro_grant_allocations',
        'mxqr_pro_grant_audit',
        'mxqr_pro_grant_campaigns',
        'mxqr_pro_grant_redemptions',
        'mxqr_pro_grant_voucher_batches',
        'mxqr_pro_grant_vouchers',
        'mxqr_pro_grants',
      ]);
      expect(
        db
          .prepare(
            `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name = 'mxqr_pro_account_entitlements'`,
          )
          .get(),
      ).toEqual({ name: 'mxqr_pro_account_entitlements' });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM sqlite_master
             WHERE type = 'trigger' AND name LIKE 'mxqr_pro_grant_%'`,
          )
          .get(),
      ).toEqual({ count: 12 });
    } finally {
      db.close();
    }
  });

  it('stores keyed voucher digests and exact room incarnations without plaintext columns', () => {
    const db = openDatabase();
    try {
      seedCampaignAndBatch(db);
      db.exec(
        `INSERT INTO mxqr_pro_room_registry
           (room_code, room_generation, status, activation_state)
         VALUES ('000100', 4, 'registered', 'unactivated')`,
      );
      const columns = db.prepare('PRAGMA table_info(mxqr_pro_grant_vouchers)').all();
      expect(columns.map((column: any) => column.name)).toEqual(
        expect.arrayContaining(['code_digest', 'room_code', 'room_generation']),
      );
      for (const forbidden of ['code', 'plaintext_code', 'raw_code']) {
        expect(columns.map((column: any) => column.name)).not.toContain(forbidden);
      }
      db.prepare(
        `INSERT INTO mxqr_pro_grant_vouchers
           (voucher_id, campaign_id, batch_request_id, code_digest, room_code, room_generation,
            status, redeemed_account_id, redeemed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, '000100', 4, 'available', NULL, NULL, 100, 100)`,
      ).run(
        `voucher_${'D'.repeat(22)}`,
        `campaign_${'A'.repeat(22)}`,
        `batch_${'B'.repeat(22)}`,
        'E'.repeat(43),
      );
      const voucher = db
        .prepare(
          `SELECT room_code, room_generation, status
           FROM mxqr_pro_grant_vouchers`,
        )
        .get();
      expect(voucher).toEqual({ room_code: '000100', room_generation: 4, status: 'available' });
      expect(() =>
        db.exec(`UPDATE mxqr_pro_grant_vouchers SET code_digest = '${'F'.repeat(43)}'`),
      ).toThrow(/material is immutable/i);
      expect(() => db.exec('DELETE FROM mxqr_pro_grant_vouchers')).toThrow(/retained/i);
    } finally {
      db.close();
    }
  });

  it('aborts voucher insertion when the exact registry incarnation is no longer unactivated', () => {
    const db = openDatabase();
    try {
      seedCampaignAndBatch(db);
      db.exec(
        `INSERT INTO mxqr_pro_room_registry
           (room_code, room_generation, status, activation_state)
         VALUES ('000100', 4, 'registered', 'active')`,
      );
      expect(() =>
        db
          .prepare(
            `INSERT INTO mxqr_pro_grant_vouchers
               (voucher_id, campaign_id, batch_request_id, code_digest, room_code, room_generation,
                status, redeemed_account_id, redeemed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, '000100', 4, 'available', NULL, NULL, 100, 100)`,
          )
          .run(
            `voucher_${'D'.repeat(22)}`,
            `campaign_${'A'.repeat(22)}`,
            `batch_${'B'.repeat(22)}`,
            'E'.repeat(43),
          ),
      ).toThrow(/room is unavailable/i);
    } finally {
      db.close();
    }
  });

  it('enforces one current PRO grant per account across acquisition sources', () => {
    const db = openDatabase();
    try {
      const accountId = `acct_${'A'.repeat(22)}`;
      db.prepare(
        `INSERT INTO mxqr_pro_grants
           (grant_id, product_code, plan_code, account_id, source_type, source_ref, status,
            valid_from, valid_until, created_at, updated_at)
         VALUES (?, 'pro_room', 'pro_room_perpetual', ?, 'campaign', 'asamo-0',
                 'pending_activation', 100, NULL, 100, 100)`,
      ).run(`grant_${'B'.repeat(22)}`, accountId);
      expect(() =>
        db
          .prepare(
            `INSERT INTO mxqr_pro_grants
               (grant_id, product_code, plan_code, account_id, source_type, source_ref, status,
                valid_from, valid_until, created_at, updated_at)
             VALUES (?, 'pro_room', 'pro_room_subscription', ?, 'purchase', 'order-1', 'active',
                     101, 200, 101, 101)`,
          )
          .run(`grant_${'C'.repeat(22)}`, accountId),
      ).toThrow(/unique/i);
      db.exec(`UPDATE mxqr_pro_grants SET status = 'revoked', updated_at = 102`);
      expect(
        db
          .prepare(
            `INSERT INTO mxqr_pro_grants
               (grant_id, product_code, plan_code, account_id, source_type, source_ref, status,
                valid_from, valid_until, created_at, updated_at)
             VALUES (?, 'pro_room', 'pro_room_subscription', ?, 'purchase', 'order-1', 'active',
                     103, 200, 103, 103)`,
          )
          .run(`grant_${'C'.repeat(22)}`, accountId).changes,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it('serializes current account and room entitlements while retaining transfer history', () => {
    const db = openDatabase();
    try {
      const sourceAccount = `acct_${'A'.repeat(22)}`;
      const targetAccount = `acct_${'B'.repeat(22)}`;
      const insert = db.prepare(
        `INSERT INTO mxqr_pro_account_entitlements
           (account_id, room_code, room_generation, source_kind, source_ref,
            transfer_request_id, status, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?, ?, 100, 100)`,
      );
      insert.run(sourceAccount, '000100', 'legacy_activation', 'legacy:source', null, 'active');
      expect(() =>
        insert.run(sourceAccount, '000101', 'legacy_activation', 'legacy:other', null, 'reserved'),
      ).toThrow(/unique/i);
      db.prepare(
        `UPDATE mxqr_pro_account_entitlements
            SET status = 'transfer_source_active', transfer_request_id = ?, updated_at = 101
          WHERE source_ref = 'legacy:source'`,
      ).run('transfer_request_0001');
      expect(
        insert.run(
          targetAccount,
          '000100',
          'owner_transfer',
          'transfer_request_0001',
          'transfer_request_0001',
          'reserved',
        ).changes,
      ).toBe(1);
      expect(() =>
        insert.run(sourceAccount, '000101', 'legacy_activation', 'legacy:other', null, 'reserved'),
      ).toThrow(/unique/i);
      expect(() =>
        db.exec(`UPDATE mxqr_pro_account_entitlements SET room_code = '000999'`),
      ).toThrow(/material is immutable/i);
      expect(() => db.exec('DELETE FROM mxqr_pro_account_entitlements')).toThrow(/retained/i);
    } finally {
      db.close();
    }
  });

  it('keeps account-deletion fences valid and append-only', () => {
    const db = openDatabase();
    try {
      const accountId = `acct_${'F'.repeat(22)}`;
      expect(
        db
          .prepare(
            `INSERT INTO mxqr_pro_grant_account_fences (account_id, reason, created_at)
             VALUES (?, 'account_deleted', 100)`,
          )
          .run(accountId).changes,
      ).toBe(1);
      expect(() =>
        db.exec(
          `INSERT INTO mxqr_pro_grant_account_fences
             (account_id, reason, created_at)
           VALUES ('acct_${'G'.repeat(22)}', 'session_logout', 101)`,
        ),
      ).toThrow(/check constraint/i);
      expect(() => db.exec(`UPDATE mxqr_pro_grant_account_fences SET created_at = 102`)).toThrow(
        /append-only/i,
      );
      expect(() => db.exec('DELETE FROM mxqr_pro_grant_account_fences')).toThrow(/append-only/i);
    } finally {
      db.close();
    }
  });

  it('keeps entitlement validity independent from exact room allocation', () => {
    const db = openDatabase();
    try {
      const grantId = `grant_${'G'.repeat(22)}`;
      db.prepare(
        `INSERT INTO mxqr_pro_grants
           (grant_id, product_code, plan_code, account_id, source_type, source_ref, status,
            valid_from, valid_until, created_at, updated_at)
         VALUES (?, 'pro_room', 'pro_room_perpetual', ?, 'campaign', 'asamo-0',
                 'pending_activation', 100, NULL, 100, 100)`,
      ).run(grantId, `acct_${'H'.repeat(22)}`);
      expect(
        db.prepare(`SELECT valid_until FROM mxqr_pro_grants WHERE grant_id = ?`).get(grantId),
      ).toEqual({ valid_until: null });
      db.prepare(
        `INSERT INTO mxqr_pro_grant_allocations
           (allocation_id, grant_id, room_code, room_generation, status, created_at, updated_at)
         VALUES (?, ?, '000100', 7, 'reserved', 100, 100)`,
      ).run(`allocation_${'I'.repeat(22)}`, grantId);
      expect(
        db
          .prepare(
            `SELECT room_code, room_generation, status
             FROM mxqr_pro_grant_allocations WHERE grant_id = ?`,
          )
          .get(grantId),
      ).toEqual({ room_code: '000100', room_generation: 7, status: 'reserved' });
    } finally {
      db.close();
    }
  });

  it('keeps identifiers-only audit rows append-only', () => {
    const db = openDatabase();
    try {
      const columns = db.prepare('PRAGMA table_info(mxqr_pro_grant_audit)').all();
      for (const forbidden of ['code', 'code_digest', 'email', 'ip']) {
        expect(columns.map((column: any) => column.name)).not.toContain(forbidden);
      }
      db.exec(
        `INSERT INTO mxqr_pro_grant_audit
           (actor_id, action, result, campaign_id, room_code, room_generation, created_at)
         VALUES ('operator:pseudonym', 'voucher.batch.create', 'success',
                 'campaign_ABCDEFGHIJKLMNOPQRSTUV', '000100', 0, 100)`,
      );
      expect(() => db.exec(`UPDATE mxqr_pro_grant_audit SET result = 'changed'`)).toThrow(
        /append-only/i,
      );
      expect(() => db.exec('DELETE FROM mxqr_pro_grant_audit')).toThrow(/append-only/i);
    } finally {
      db.close();
    }
  });
});
