import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import appWorker from '../../../cloudflare/app-worker.ts';
import {
  ASSERTION_SECRET,
  issueClaim,
  OLD_OWNER,
  REQUEST_ID,
  ROOM_CODE,
  ROOM_GENERATION,
  requestTransfer,
  START,
  stepIs,
  TARGET,
  type TransferFixture,
  transferFixture,
  useSagaClock,
} from './helpers/owner-transfer-saga-fixture.ts';
import { nodeSqlite } from './helpers/worker-test-bindings.ts';

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

/**
 * Every writer of the authority fence row (registry RO-25), driven through its
 * real caller on the owner-transfer saga fixture: the SQL text each one sends
 * to the Developer API database and every bound value. The activator
 * (`revokeDeveloperApiKeysForAuthorityChange`) sends one batch of three
 * statements; only its caller-specific values differ:
 *
 * - account-deletion purge: reason `owner_account_deleted`, compare-and-swap
 *   on the digest it captured before asking the Durable Object (?6 = 1, ?7 =
 *   that digest, or null when no fence row existed);
 * - owner transfer, from the request and from the cron's adoption: reason
 *   `ownership_transfer_pending`, no compare-and-swap (?6 = 0, ?7 = null);
 * - legacy duplicate-owner detach: the same, with its own audit identity.
 *
 * The clearer (`clearDeveloperApiAuthorityFence`) clears only the transfer's
 * own digest. Each digest is recomputed from its documented material. Plan
 * step C7-11 moves the callers to a typed fence-write object; these values
 * must not move with it.
 */
const FENCE_ACTIVATE_SQL = `INSERT INTO mxqr_developer_api_room_authority_fences
  (room_code, room_generation, status, reason, fence_digest, fenced_at, updated_at)
 VALUES (?1, ?2, 'active', ?3, ?4, ?5, ?5)
 ON CONFLICT(room_code, room_generation) DO UPDATE SET
   status = CASE
     WHEN mxqr_developer_api_room_authority_fences.fence_digest = excluded.fence_digest
      AND mxqr_developer_api_room_authority_fences.status = 'cleared'
     THEN 'cleared'
     ELSE 'active'
   END,
   reason = CASE
     WHEN mxqr_developer_api_room_authority_fences.fence_digest = excluded.fence_digest
      AND mxqr_developer_api_room_authority_fences.status = 'cleared'
     THEN mxqr_developer_api_room_authority_fences.reason
     ELSE excluded.reason
   END,
   fence_digest = excluded.fence_digest,
   fenced_at = CASE
     WHEN mxqr_developer_api_room_authority_fences.fence_digest = excluded.fence_digest
     THEN mxqr_developer_api_room_authority_fences.fenced_at
     ELSE excluded.fenced_at
   END,
   updated_at = MAX(mxqr_developer_api_room_authority_fences.updated_at, excluded.updated_at)
 WHERE ?6 = 0
    OR mxqr_developer_api_room_authority_fences.fence_digest = ?7
    OR mxqr_developer_api_room_authority_fences.fence_digest = excluded.fence_digest`;
const FENCED_KEY_REVOKE_SQL = `UPDATE mxqr_developer_api_keys
    SET status = 'revoked', revoked_at = ?3, updated_at = ?3
  WHERE room_code = ?1 AND room_generation = ?2 AND status = 'active'
    AND EXISTS (
      SELECT 1 FROM mxqr_developer_api_room_authority_fences AS fence
       WHERE fence.room_code = ?1 AND fence.room_generation = ?2
         AND fence.status = 'active' AND fence.fence_digest = ?4
    )`;
const FENCED_KEY_AUDIT_SQL = `INSERT OR IGNORE INTO mxqr_developer_api_admin_audit
  (actor_id, action, result, key_id, room_code, room_generation, created_at)
 SELECT ?1, 'key.revoke', ?2, key.key_id, key.room_code,
        key.room_generation, ?5
   FROM mxqr_developer_api_keys AS key
  WHERE key.room_code = ?3 AND key.room_generation = ?4
    AND key.status = 'revoked' AND key.revoked_at = ?5`;
const FENCE_CLEAR_SQL = `UPDATE mxqr_developer_api_room_authority_fences
    SET status = 'cleared', updated_at = ?4
  WHERE room_code = ?1 AND room_generation = ?2
    AND fence_digest = ?3 AND status = 'active'`;

const normalizeSql = (sql: string) => sql.replace(/\s+/g, ' ').trim();

/** The fence digest as `developerApiAuthorityFenceDigest` derives it. */
function fenceDigest(purpose: string, ...material: Array<string | number>) {
  return createHmac('sha256', ASSERTION_SECRET)
    .update(`developer-api-authority-fence:v1\u0000${purpose}\u0000${material.join('\u0000')}`)
    .digest('base64url');
}

/** The three statements of one activation, as the activator binds them. */
function activation(
  reason: string,
  digest: string,
  atMs: number,
  expected: { readonly compareAndSwap: 0 | 1; readonly digest: string | null },
  audit: { readonly actorId: string; readonly result: string },
) {
  return [
    {
      sql: normalizeSql(FENCE_ACTIVATE_SQL),
      values: [
        ROOM_CODE,
        ROOM_GENERATION,
        reason,
        digest,
        atMs,
        expected.compareAndSwap,
        expected.digest,
      ],
    },
    {
      sql: normalizeSql(FENCED_KEY_REVOKE_SQL),
      values: [ROOM_CODE, ROOM_GENERATION, atMs, digest],
    },
    {
      sql: normalizeSql(FENCED_KEY_AUDIT_SQL),
      values: [audit.actorId, audit.result, ROOM_CODE, ROOM_GENERATION, atMs],
    },
  ];
}

function clearing(digest: string, atMs: number) {
  return {
    sql: normalizeSql(FENCE_CLEAR_SQL),
    values: [ROOM_CODE, ROOM_GENERATION, digest, atMs],
  };
}

/** Developer API database writes since `mark`, normalized. */
function developerWrites(test: TransferFixture, mark: number) {
  return test.journal.writes
    .slice(mark)
    .filter((event) => event.db === 'developer')
    .map((event) => ({ sql: normalizeSql(event.sql), values: [...event.values] }));
}

async function ownerAuthorityRemoval(test: TransferFixture) {
  const response = await test.internal('/internal/admin/status');
  const payload = (await response.json()) as {
    ownerAuthorityRemoval: {
      removalId: string;
      ownerAuthorityEpoch: number;
      fencedCoordinatorEpoch: number;
    } | null;
  };
  if (!payload.ownerAuthorityRemoval) throw new Error('no owner-authority removal');
  return payload.ownerAuthorityRemoval;
}

function transferDigest(test: TransferFixture) {
  const transferId = test.admin.rows<{ transfer_id: string }>(
    'SELECT transfer_id FROM mxqr_pro_room_owner_transfer_sagas',
  )[0]!.transfer_id;
  return fenceDigest(
    'ownership-transfer',
    ROOM_CODE,
    ROOM_GENERATION,
    transferId,
    TARGET,
    REQUEST_ID,
  );
}

const ACCOUNT_DELETE_AUDIT = { actorId: 'system:account-delete', result: 'owner_account_deleted' };
const OWNER_TRANSFER_AUDIT = { actorId: 'system:owner-transfer', result: 'ownership_transfer' };
const LEGACY_DETACH_AUDIT = {
  actorId: 'system:legacy-owner-detach',
  result: 'legacy_duplicate_owner_detach',
};
const NO_COMPARE_AND_SWAP = { compareAndSwap: 0, digest: null } as const;

(nodeSqlite ? describe : describe.skip)('Developer API authority fence writers (RO-25)', () => {
  useSagaClock();

  it('account deletion with no fence row compares and swaps against null', async () => {
    const test = await transferFixture();
    test.deleteTarget(OLD_OWNER);
    const mark = test.mark();
    expect(await test.purge(OLD_OWNER)).toBe(true);
    const removal = await ownerAuthorityRemoval(test);
    const digest = fenceDigest(
      'owner-account-deleted',
      ROOM_CODE,
      ROOM_GENERATION,
      OLD_OWNER,
      removal.removalId,
      removal.ownerAuthorityEpoch,
      removal.fencedCoordinatorEpoch,
    );
    expect(developerWrites(test, mark)).toEqual(
      activation(
        'owner_account_deleted',
        digest,
        START,
        { compareAndSwap: 1, digest: null },
        ACCOUNT_DELETE_AUDIT,
      ),
    );
    expect(test.fenceDigest()).toBe(digest);
  });

  it('account deletion over a transfer fence compares and swaps against the digest it captured', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    expect((await requestTransfer(test, claim)).status).toBe(200);
    const captured = transferDigest(test);
    expect(test.fenceDigest()).toBe(captured);

    vi.setSystemTime(START + 5_000);
    test.deleteTarget();
    const mark = test.mark();
    expect(await test.purge(TARGET)).toBe(true);
    const removal = await ownerAuthorityRemoval(test);
    const digest = fenceDigest(
      'owner-account-deleted',
      ROOM_CODE,
      ROOM_GENERATION,
      TARGET,
      removal.removalId,
      removal.ownerAuthorityEpoch,
      removal.fencedCoordinatorEpoch,
    );
    expect(developerWrites(test, mark)).toEqual(
      activation(
        'owner_account_deleted',
        digest,
        START + 5_000,
        { compareAndSwap: 1, digest: captured },
        ACCOUNT_DELETE_AUDIT,
      ),
    );
  });

  it('the transfer request activates without a compare-and-swap and clears its own digest', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    vi.setSystemTime(START + 1_000);
    const mark = test.mark();
    expect((await requestTransfer(test, claim)).status).toBe(200);
    const digest = transferDigest(test);
    expect(developerWrites(test, mark)).toEqual([
      ...activation(
        'ownership_transfer_pending',
        digest,
        START + 1_000,
        NO_COMPARE_AND_SWAP,
        OWNER_TRANSFER_AUDIT,
      ),
      clearing(digest, START + 1_000),
    ]);
  });

  it('the cron, adopting a prepared transfer, activates the same way with the wall clock', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    // The request stops at its own fence write; the DO keeps the PREPARE.
    test.failOnce(stepIs('fence:ownership_transfer_pending'));
    expect((await requestTransfer(test, claim)).status).toBe(503);
    vi.setSystemTime(START + 60_000);
    const mark = test.mark();
    // The sweep time does not reach the fence: both writes stamp Date.now().
    expect(await test.cron(START + 61_234)).toBe(1);
    const digest = transferDigest(test);
    expect(developerWrites(test, mark)).toEqual([
      ...activation(
        'ownership_transfer_pending',
        digest,
        START + 60_000,
        NO_COMPARE_AND_SWAP,
        OWNER_TRANSFER_AUDIT,
      ),
      clearing(digest, START + 60_000),
    ]);
  });

  it('the legacy duplicate-owner detach activates without a compare-and-swap', async () => {
    const test = await transferFixture();
    const retainedRoomCode = '000418';
    const adminPassword = 'fence-writer-admin-password';
    test.appEnv.MXQR_ADMIN_PASSWORD = adminPassword;
    test.appEnv.MXQR_ADMIN_SESSION_SECRET = 'fence-writer-admin-session-secret-32+';
    // The owner's other, retained room: registered in the App and owned by
    // the same account in its (stubbed) Durable Object. A real second room
    // cannot be activated: the account already holds this room's entitlement.
    test.admin.database
      .prepare(
        `INSERT INTO mxqr_pro_room_registry
           (room_code, label, status, suspension_reason, activation_state, room_generation,
            created_at, updated_at)
         VALUES (?, 'Retained room', 'registered', NULL, 'active', ?, ?, ?)`,
      )
      .run(retainedRoomCode, ROOM_GENERATION, START - 60_000, START - 60_000);
    test.stubAdminRoom(retainedRoomCode, async (request) => {
      expect(new URL(request.url).pathname).toBe('/internal/admin/status');
      return Response.json({
        roomCode: retainedRoomCode,
        roomGeneration: ROOM_GENERATION,
        provisioned: true,
        status: 'active',
        suspensionReason: null,
        ownerAccountLinked: true,
        ownerAccountId: OLD_OWNER,
        ownerAuthorityEpoch: 1,
        ownerAuthorityRemoval: null,
        ownerTransferReconciliation: null,
      });
    });
    const adminHeaders = {
      Origin: 'https://musixquare.com',
      'Content-Type': 'application/json',
      'X-MXQR-Admin-CSRF': '1',
    };
    const login = await appWorker.fetch(
      new Request('https://musixquare.com/api/admin/login', {
        method: 'POST',
        headers: { ...adminHeaders, 'CF-Connecting-IP': '192.0.2.20' },
        body: JSON.stringify({ password: adminPassword }),
      }),
      test.appEnv as never,
    );
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('Set-Cookie') || '').split(';')[0] ?? '';

    vi.setSystemTime(START + 3_000);
    const mark = test.mark();
    const detached = await appWorker.fetch(
      new Request(`https://musixquare.com/api/admin/pro-rooms/${ROOM_CODE}/legacy-owner-detach`, {
        method: 'POST',
        headers: { ...adminHeaders, Cookie: cookie },
        body: JSON.stringify({
          roomGeneration: ROOM_GENERATION,
          retainRoomCode: retainedRoomCode,
          confirmRoomCode: ROOM_CODE,
        }),
      }),
      test.appEnv as never,
    );
    await test.settle();
    expect(detached.status).toBe(200);
    expect(await detached.json()).toMatchObject({
      ok: true,
      status: 'suspended',
      suspensionReason: 'ownership_transfer_pending',
      retainedRoomCode,
      changed: true,
    });
    const removal = await ownerAuthorityRemoval(test);
    const digest = fenceDigest(
      'legacy-owner-detach',
      ROOM_CODE,
      ROOM_GENERATION,
      OLD_OWNER,
      removal.removalId,
      removal.ownerAuthorityEpoch,
      removal.fencedCoordinatorEpoch,
    );
    expect(developerWrites(test, mark)).toEqual(
      activation(
        'ownership_transfer_pending',
        digest,
        START + 3_000,
        NO_COMPARE_AND_SWAP,
        LEGACY_DETACH_AUDIT,
      ),
    );
    expect(test.fence()).toEqual({ status: 'active', reason: 'ownership_transfer_pending' });
    expect(test.keyStatus()).toBe('revoked');
  });
});
