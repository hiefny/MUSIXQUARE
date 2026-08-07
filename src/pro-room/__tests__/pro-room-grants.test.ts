import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { StatementSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  abortProRoomOwnershipTransferEntitlement,
  authorizeProGrantActivation,
  finalizeProGrantActivation,
  finalizeProRoomOwnershipTransferEntitlement,
  handleProGrantAdminRequest,
  handleProGrantPublicRequest,
  hasReservedProGrantAllocation,
  markProRoomOwnerEntitlementBackfillComplete,
  orphanAccountProGrants,
  reserveProRoomActivationEntitlement,
  reserveProRoomOwnershipTransferEntitlement,
  revokeProRoomEntitlement,
  upsertProRoomOwnerEntitlement,
} from '../../../cloudflare/pro-room-grants.js';

const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const MIGRATION = readFileSync(
  new URL('../../../cloudflare/admin-metrics.pro-grants.migration.sql', import.meta.url),
  'utf8',
);
const ACCOUNT_A = `acct_${'A'.repeat(22)}`;
const ACCOUNT_B = `acct_${'B'.repeat(22)}`;
const ACCOUNT_C = `acct_${'C'.repeat(22)}`;
const PEPPER = 'pro-grant-test-pepper-that-is-at-least-32-bytes';

type SqlValue = string | number | bigint | Uint8Array | null;

class Statement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: readonly SqlValue[] = [],
  ) {}

  bind(...values: SqlValue[]) {
    return new Statement(this.statement, values);
  }

  async first() {
    return (this.statement.get(...this.values) as Record<string, unknown> | undefined) ?? null;
  }

  async all() {
    return { results: this.statement.all(...this.values) as Record<string, unknown>[] };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class D1 {
  readonly database = new sqlite.DatabaseSync(':memory:');

  constructor() {
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec(`
      CREATE TABLE mxqr_pro_room_registry (
        room_code TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        suspension_reason TEXT,
        activation_state TEXT NOT NULL,
        room_generation INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.database.exec(MIGRATION);
  }

  prepare(sql: string) {
    return new Statement(this.database.prepare(sql));
  }

  async batch(statements: Statement[]) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://musixquare.com${path}`, init);
}

async function body(response: Response) {
  return response.json() as Promise<Record<string, any>>;
}

async function voucherDigest(slug: string, code: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(PEPPER),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`pro-grant-voucher:v1\u0000${slug}\u0000${code}`),
    ),
  );
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function seedEntitlement(
  database: D1['database'],
  input: {
    accountId: string;
    roomCode: string;
    roomGeneration?: number;
    sourceKind?: 'grant' | 'legacy_activation' | 'owner_transfer';
    sourceRef: string;
    status: string;
    now: number;
  },
) {
  database
    .prepare(
      `INSERT INTO mxqr_pro_account_entitlements
         (account_id, room_code, room_generation, source_kind, source_ref,
          transfer_request_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      input.accountId,
      input.roomCode,
      input.roomGeneration ?? 0,
      input.sourceKind ?? 'legacy_activation',
      input.sourceRef,
      input.status,
      input.now,
      input.now,
    );
}

describe('generic PRO grant redemption', () => {
  let db: D1 | null = null;
  afterEach(() => {
    db?.close();
    db = null;
  });

  it('atomically redeems a digest-only voucher and retries for the same account', async () => {
    db = new D1();
    const now = Date.now();
    expect(
      await markProRoomOwnerEntitlementBackfillComplete({ MUSIXQUARE_ADMIN_DB: db }, now),
    ).toBe(true);
    db.database
      .prepare(
        `INSERT INTO mxqr_pro_room_registry
          (room_code,label,status,suspension_reason,activation_state,room_generation,created_at,updated_at)
         VALUES ('000100','Event','registered',NULL,'unactivated',0,?,?)`,
      )
      .run(now, now);
    const env = {
      MUSIXQUARE_ADMIN_DB: db,
      MUSIXQUARE_AUTH_DB: { prepare() {} },
      MXQR_PRO_GRANT_VOUCHER_PEPPER: PEPPER,
    };
    let accountId = ACCOUNT_A;
    let handoff = 0;
    const dependencies = {
      resolveAccountSession: async () => ({
        accountId,
        nickname: 'Owner',
        profileComplete: true,
      }),
      hasLegacyProRoomLink: async () => false,
      inspectRoom: async () => ({ status: 'unactivated', ownerAccountId: null }),
      preflightVoucherRoom: async () => ({
        roomCode: '000100',
        roomGeneration: 0,
        status: 'registered',
        activationState: 'unactivated',
      }),
      issueActivationHandoff: async () => ({
        roomCode: '000100',
        roomGeneration: 0,
        activationUrl: `https://musixquare.com/000100#pro-claim=v1.claim${++handoff}.sig`,
        expiresAt: Date.now() + 60_000,
      }),
      verifyOwnerEntitlementBackfill: async () => true,
    };

    const create = await handleProGrantAdminRequest(
      request('/api/admin/pro-grants/campaigns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: 'asamo-0',
          title: 'ASAMO',
          startsAt: now - 1_000,
          endsAt: now + 60_000,
          perAccountLimit: 1,
          dryRun: false,
        }),
      }),
      env,
      new URL('https://musixquare.com/api/admin/pro-grants/campaigns'),
      dependencies,
    );
    expect(create?.status).toBe(201);
    const batchBody = {
      requestId: `batch_${'C'.repeat(22)}`,
      dryRun: false,
      vouchers: [{ roomCode: '000100', code: '23456789ABCDEFGHJKMN' }],
    };
    const createVoucher = await handleProGrantAdminRequest(
      request('/api/admin/pro-grants/campaigns/asamo-0/vouchers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batchBody),
      }),
      env,
      new URL('https://musixquare.com/api/admin/pro-grants/campaigns/asamo-0/vouchers'),
      dependencies,
    );
    expect(createVoucher?.status).toBe(201);
    expect(await hasReservedProGrantAllocation(env, '000100', 0)).toBe(true);
    expect(JSON.stringify(await body(createVoucher!))).not.toContain('23456789ABCDEFGHJKMN');

    const status = await handleProGrantAdminRequest(
      request('/api/admin/pro-grants/campaigns/asamo-0/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'status_activate_0001',
          status: 'active',
          dryRun: false,
        }),
      }),
      env,
      new URL('https://musixquare.com/api/admin/pro-grants/campaigns/asamo-0/status'),
      dependencies,
    );
    expect(status?.status).toBe(200);
    const statusReplay = await handleProGrantAdminRequest(
      request('/api/admin/pro-grants/campaigns/asamo-0/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'status_activate_0001',
          status: 'active',
          dryRun: false,
        }),
      }),
      env,
      new URL('https://musixquare.com/api/admin/pro-grants/campaigns/asamo-0/status'),
      dependencies,
    );
    expect(statusReplay?.status).toBe(200);
    const statusConflict = await handleProGrantAdminRequest(
      request('/api/admin/pro-grants/campaigns/asamo-0/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'status_activate_0001',
          status: 'paused',
          dryRun: false,
        }),
      }),
      env,
      new URL('https://musixquare.com/api/admin/pro-grants/campaigns/asamo-0/status'),
      dependencies,
    );
    expect(statusConflict?.status).toBe(409);
    expect(await body(statusConflict!)).toEqual({ error: 'IDEMPOTENCY_CONFLICT' });

    const redeemRequest = () =>
      request('/api/pro-grants/campaigns/asamo-0/redeem', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://musixquare.com',
        },
        body: JSON.stringify({ code: '2345-6789-ABCD-EFGH-JKMN' }),
      });
    const redeemed = await handleProGrantPublicRequest(
      redeemRequest(),
      env,
      new URL('https://musixquare.com/api/pro-grants/campaigns/asamo-0/redeem'),
      dependencies,
    );
    expect(redeemed?.status).toBe(201);
    expect(await body(redeemed!)).toMatchObject({
      outcome: 'redeemed',
      roomCode: '000100',
      roomGeneration: 0,
      setupRequired: true,
    });
    expect(redeemed?.headers.get('cache-control')).toContain('no-store');

    const retried = await handleProGrantPublicRequest(
      redeemRequest(),
      env,
      new URL('https://musixquare.com/api/pro-grants/campaigns/asamo-0/redeem'),
      dependencies,
    );
    expect(retried?.status).toBe(200);
    expect(await body(retried!)).toMatchObject({ outcome: 'already_redeemed' });
    expect(handoff).toBe(0);

    accountId = ACCOUNT_B;
    const stolen = await handleProGrantPublicRequest(
      redeemRequest(),
      env,
      new URL('https://musixquare.com/api/pro-grants/campaigns/asamo-0/redeem'),
      dependencies,
    );
    expect(stolen?.status).toBe(409);
    expect(await body(stolen!)).toEqual({ error: 'REDEEM_CODE_USED' });

    const stored = db.database
      .prepare('SELECT code_digest FROM mxqr_pro_grant_vouchers LIMIT 1')
      .get() as { code_digest: string };
    expect(stored.code_digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored.code_digest).not.toContain('2345');
    const audit = db.database
      .prepare('SELECT action, COUNT(*) AS count FROM mxqr_pro_grant_audit GROUP BY action')
      .all() as Array<{ action: string; count: number }>;
    expect(Object.fromEntries(audit.map((row) => [row.action, row.count]))).toMatchObject({
      'campaign.create': 1,
      'campaign.status': 1,
      'voucher.batch.issue': 1,
      'voucher.redeem': 1,
    });
  });

  it('keeps passive session reads credential-free and mints a setup link only on POST', async () => {
    db = new D1();
    const now = Date.now();
    db.database.exec(`
      INSERT INTO mxqr_pro_room_registry VALUES
        ('000100','Event','registered',NULL,'unactivated',0,${now},${now});
      INSERT INTO mxqr_pro_grant_campaigns VALUES
        ('campaign_${'A'.repeat(22)}','asamo-0','ASAMO','active',${now - 1},NULL,1,${now},${now});
      INSERT INTO mxqr_pro_grant_voucher_batches VALUES
        ('campaign_${'A'.repeat(22)}','batch_${'B'.repeat(22)}','${'C'.repeat(43)}','committed',1,${now},${now});
      INSERT INTO mxqr_pro_grant_vouchers VALUES
        ('voucher_${'D'.repeat(22)}','campaign_${'A'.repeat(22)}','batch_${'B'.repeat(22)}','${'E'.repeat(43)}','000100',0,'redeemed','${ACCOUNT_A}',${now},${now},${now});
      INSERT INTO mxqr_pro_grants VALUES
        ('grant_${'F'.repeat(22)}','pro_room','pro_room_perpetual','${ACCOUNT_A}','campaign','campaign_${'A'.repeat(22)}','pending_activation',${now},NULL,${now},${now});
      INSERT INTO mxqr_pro_grant_allocations VALUES
        ('allocation_${'G'.repeat(22)}','grant_${'F'.repeat(22)}','000100',0,'reserved',${now},${now});
      INSERT INTO mxqr_pro_account_entitlements
        (account_id,room_code,room_generation,source_kind,source_ref,transfer_request_id,status,created_at,updated_at)
      VALUES
        ('${ACCOUNT_A}','000100',0,'grant','grant_${'F'.repeat(22)}',NULL,'reserved',${now},${now});
      INSERT INTO mxqr_pro_grant_redemptions VALUES
        ('redemption_${'H'.repeat(22)}','campaign_${'A'.repeat(22)}','voucher_${'D'.repeat(22)}','grant_${'F'.repeat(22)}','${ACCOUNT_A}','redeemed',NULL,${now},${now});
    `);
    let issued = 0;
    const env = { MUSIXQUARE_ADMIN_DB: db, MUSIXQUARE_AUTH_DB: db };
    const dependencies = {
      resolveAccountSession: async () => ({
        accountId: ACCOUNT_A,
        nickname: 'Owner',
        profileComplete: true,
      }),
      inspectRoom: async () => ({ status: 'unactivated', ownerAccountId: null }),
      issueActivationHandoff: async () => ({
        roomCode: '000100',
        roomGeneration: 0,
        activationUrl: `https://musixquare.com/000100#pro-claim=v1.${++issued}.sig`,
        expiresAt: Date.now() + 60_000,
      }),
    };
    const session = await handleProGrantPublicRequest(
      request('/api/pro-grants/campaigns/asamo-0/session'),
      env,
      new URL('https://musixquare.com/api/pro-grants/campaigns/asamo-0/session'),
      dependencies,
    );
    const sessionBody = await body(session!);
    expect(session?.status).toBe(200);
    expect(sessionBody.redemption).toMatchObject({
      status: 'redeemed',
      roomCode: '000100',
      roomGeneration: 0,
      setupRequired: true,
    });
    expect(JSON.stringify(sessionBody)).not.toContain('activationUrl');
    expect(issued).toBe(0);

    const setup = await handleProGrantPublicRequest(
      request('/api/pro-grants/campaigns/asamo-0/setup-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://musixquare.com' },
        body: '{}',
      }),
      env,
      new URL('https://musixquare.com/api/pro-grants/campaigns/asamo-0/setup-link'),
      dependencies,
    );
    expect(setup?.status).toBe(200);
    expect(await body(setup!)).toMatchObject({
      roomCode: '000100',
      roomGeneration: 0,
      setupRequired: true,
    });
    expect(issued).toBe(1);
  });

  it('replays a committed voucher batch without rechecking changed room state', async () => {
    db = new D1();
    const now = Date.now();
    db.database.exec(`
      INSERT INTO mxqr_pro_room_registry VALUES
        ('000100','Event','registered',NULL,'unactivated',0,${now},${now});
      INSERT INTO mxqr_pro_grant_campaigns VALUES
        ('campaign_${'A'.repeat(22)}','asamo-0','ASAMO','draft',${now - 1},NULL,1,${now},${now});
    `);
    const env = {
      MUSIXQUARE_ADMIN_DB: db,
      MXQR_PRO_GRANT_VOUCHER_PEPPER: PEPPER,
    };
    let allowPreflight = true;
    const dependencies = {
      preflightVoucherRoom: async () => {
        if (!allowPreflight) throw new Error('replay must not inspect mutable room state');
        return {
          roomCode: '000100',
          roomGeneration: 0,
          status: 'registered',
          activationState: 'unactivated',
        };
      },
    };
    const batchInput = {
      requestId: `batch_${'R'.repeat(22)}`,
      dryRun: false,
      vouchers: [{ roomCode: '000100', code: '23456789ABCDEFGHJKMN' }],
    };
    const call = () =>
      handleProGrantAdminRequest(
        request('/api/admin/pro-grants/campaigns/asamo-0/vouchers', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(batchInput),
        }),
        env,
        new URL('https://musixquare.com/api/admin/pro-grants/campaigns/asamo-0/vouchers'),
        dependencies,
      );
    expect((await call())?.status).toBe(201);
    db.database
      .prepare(
        `UPDATE mxqr_pro_room_registry SET activation_state = 'active' WHERE room_code = '000100'`,
      )
      .run();
    allowPreflight = false;
    const replay = await call();
    expect(replay?.status).toBe(200);
    expect(await body(replay!)).toMatchObject({ replayed: true, count: 1 });
    expect(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM mxqr_pro_grant_audit
            WHERE action = 'voucher.batch.issue'`,
        )
        .get(),
    ).toMatchObject({ count: 1 });
  });

  it('fails campaign activation closed until canonical-owner backfill verifies', async () => {
    db = new D1();
    const now = Date.now();
    db.database.exec(`
      INSERT INTO mxqr_pro_grant_campaigns VALUES
        ('campaign_${'A'.repeat(22)}','asamo-0','ASAMO','draft',${now - 1},NULL,1,${now},${now});
    `);
    const env = { MUSIXQUARE_ADMIN_DB: db };
    const activate = (verifyOwnerEntitlementBackfill: () => Promise<boolean>) =>
      handleProGrantAdminRequest(
        request('/api/admin/pro-grants/campaigns/asamo-0/status', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'status_backfill_0001',
            status: 'active',
            dryRun: false,
          }),
        }),
        env,
        new URL('https://musixquare.com/api/admin/pro-grants/campaigns/asamo-0/status'),
        { verifyOwnerEntitlementBackfill },
      );
    const blocked = await activate(async () => false);
    expect(blocked?.status).toBe(503);
    expect(await body(blocked!)).toEqual({ error: 'PRO_GRANT_OWNER_BACKFILL_REQUIRED' });
    expect(db.database.prepare('SELECT status FROM mxqr_pro_grant_campaigns').get()).toMatchObject({
      status: 'draft',
    });

    const activated = await activate(async () =>
      markProRoomOwnerEntitlementBackfillComplete(env, now + 1),
    );
    expect(activated?.status).toBe(200);
    expect(db.database.prepare('SELECT status FROM mxqr_pro_grant_campaigns').get()).toMatchObject({
      status: 'active',
    });
  });

  it('returns the committed result when an identical batch wins during a response-loss race', async () => {
    db = new D1();
    const now = Date.now();
    db.database.exec(`
      INSERT INTO mxqr_pro_room_registry VALUES
        ('000100','Event','registered',NULL,'unactivated',0,${now},${now});
      INSERT INTO mxqr_pro_grant_campaigns VALUES
        ('campaign_${'A'.repeat(22)}','asamo-0','ASAMO','draft',${now - 1},NULL,1,${now},${now});
    `);
    const durableDb = db;
    let loseResponseAfterCommit = true;
    const racedDb = {
      prepare: (sql: string) => durableDb.prepare(sql),
      batch: async (statements: Statement[]) => {
        const result = await durableDb.batch(statements);
        if (loseResponseAfterCommit) {
          loseResponseAfterCommit = false;
          throw new Error('simulated concurrent winner or response loss');
        }
        return result;
      },
    };
    const response = await handleProGrantAdminRequest(
      request('/api/admin/pro-grants/campaigns/asamo-0/vouchers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: `batch_${'S'.repeat(22)}`,
          dryRun: false,
          vouchers: [{ roomCode: '000100', code: '23456789ABCDEFGHJKMN' }],
        }),
      }),
      {
        MUSIXQUARE_ADMIN_DB: racedDb,
        MXQR_PRO_GRANT_VOUCHER_PEPPER: PEPPER,
      },
      new URL('https://musixquare.com/api/admin/pro-grants/campaigns/asamo-0/vouchers'),
      {
        preflightVoucherRoom: async () => ({
          roomCode: '000100',
          roomGeneration: 0,
          status: 'registered',
          activationState: 'unactivated',
        }),
      },
    );

    expect(response?.status).toBe(200);
    expect(await body(response!)).toMatchObject({ replayed: true, count: 1 });
    expect(
      durableDb.database
        .prepare('SELECT COUNT(*) AS count FROM mxqr_pro_grant_voucher_batches')
        .get(),
    ).toMatchObject({ count: 1 });
    expect(
      durableDb.database.prepare('SELECT COUNT(*) AS count FROM mxqr_pro_grant_vouchers').get(),
    ).toMatchObject({ count: 1 });
  });

  it('fails closed when account deletion fences a redemption before its D1 transaction', async () => {
    db = new D1();
    const now = Date.now();
    expect(
      await markProRoomOwnerEntitlementBackfillComplete({ MUSIXQUARE_ADMIN_DB: db }, now),
    ).toBe(true);
    db.database.exec(`
      INSERT INTO mxqr_pro_room_registry VALUES
        ('000100','Event','registered',NULL,'unactivated',0,${now},${now});
      INSERT INTO mxqr_pro_grant_campaigns VALUES
        ('campaign_${'A'.repeat(22)}','asamo-0','ASAMO','active',${now - 1},NULL,1,${now},${now});
    `);
    const env = {
      MUSIXQUARE_ADMIN_DB: db,
      MUSIXQUARE_AUTH_DB: db,
      MXQR_PRO_GRANT_VOUCHER_PEPPER: PEPPER,
    };
    const dependencies = {
      resolveAccountSession: async () => ({
        accountId: ACCOUNT_A,
        nickname: 'Owner',
        profileComplete: true,
      }),
      isAccountActive: async () => true,
      hasLegacyProRoomLink: async () => false,
      preflightVoucherRoom: async () => ({
        roomCode: '000100',
        roomGeneration: 0,
        status: 'registered',
        activationState: 'unactivated',
      }),
    };
    const voucher = await handleProGrantAdminRequest(
      request('/api/admin/pro-grants/campaigns/asamo-0/vouchers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: `batch_${'R'.repeat(22)}`,
          dryRun: false,
          vouchers: [{ roomCode: '000100', code: '23456789ABCDEFGHJKMN' }],
        }),
      }),
      env,
      new URL('https://musixquare.com/api/admin/pro-grants/campaigns/asamo-0/vouchers'),
      dependencies,
    );
    expect(voucher?.status).toBe(201);
    db.database
      .prepare(
        `INSERT INTO mxqr_pro_grant_account_fences (account_id,reason,created_at)
         VALUES (?, 'account_deleted', ?)`,
      )
      .run(ACCOUNT_A, now + 1);

    const redeemed = await handleProGrantPublicRequest(
      request('/api/pro-grants/campaigns/asamo-0/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://musixquare.com' },
        body: JSON.stringify({ code: '2345-6789-ABCD-EFGH-JKMN' }),
      }),
      env,
      new URL('https://musixquare.com/api/pro-grants/campaigns/asamo-0/redeem'),
      dependencies,
    );
    expect(redeemed?.status).toBe(401);
    expect(await body(redeemed!)).toEqual({ error: 'ACCOUNT_SESSION_REQUIRED' });
    expect(db.database.prepare('SELECT status FROM mxqr_pro_grant_vouchers').get()).toMatchObject({
      status: 'available',
    });
    expect(
      db.database.prepare('SELECT COUNT(*) AS count FROM mxqr_pro_grants').get(),
    ).toMatchObject({
      count: 0,
    });
  });

  it('gives one voucher to exactly one account under concurrent redemption', async () => {
    db = new D1();
    const now = Date.now();
    expect(
      await markProRoomOwnerEntitlementBackfillComplete({ MUSIXQUARE_ADMIN_DB: db }, now),
    ).toBe(true);
    db.database.exec(`
      INSERT INTO mxqr_pro_room_registry VALUES
        ('000100','Event','registered',NULL,'unactivated',0,${now},${now});
      INSERT INTO mxqr_pro_grant_campaigns VALUES
        ('campaign_${'A'.repeat(22)}','asamo-0','ASAMO','active',${now - 1},NULL,1,${now},${now});
    `);
    const env = {
      MUSIXQUARE_ADMIN_DB: db,
      MUSIXQUARE_AUTH_DB: db,
      MXQR_PRO_GRANT_VOUCHER_PEPPER: PEPPER,
    };
    let issued = 0;
    const dependencies = {
      resolveAccountSession: async (incoming: Request) => ({
        accountId: incoming.headers.get('x-test-account'),
        nickname: 'Owner',
        profileComplete: true,
      }),
      isAccountActive: async () => true,
      hasLegacyProRoomLink: async () => false,
      inspectRoom: async () => ({ status: 'unactivated', ownerAccountId: null }),
      preflightVoucherRoom: async () => ({
        roomCode: '000100',
        roomGeneration: 0,
        status: 'registered',
        activationState: 'unactivated',
      }),
      issueActivationHandoff: async () => ({
        roomCode: '000100',
        roomGeneration: 0,
        activationUrl: `https://musixquare.com/000100#pro-claim=v1.${++issued}.sig`,
        expiresAt: Date.now() + 60_000,
      }),
    };
    const voucher = await handleProGrantAdminRequest(
      request('/api/admin/pro-grants/campaigns/asamo-0/vouchers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: `batch_${'R'.repeat(22)}`,
          dryRun: false,
          vouchers: [{ roomCode: '000100', code: '23456789ABCDEFGHJKMN' }],
        }),
      }),
      env,
      new URL('https://musixquare.com/api/admin/pro-grants/campaigns/asamo-0/vouchers'),
      dependencies,
    );
    expect(voucher?.status).toBe(201);

    const redeem = (accountId: string) =>
      handleProGrantPublicRequest(
        request('/api/pro-grants/campaigns/asamo-0/redeem', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://musixquare.com',
            'x-test-account': accountId,
          },
          body: JSON.stringify({ code: '2345-6789-ABCD-EFGH-JKMN' }),
        }),
        env,
        new URL('https://musixquare.com/api/pro-grants/campaigns/asamo-0/redeem'),
        dependencies,
      );
    const responses = await Promise.all([redeem(ACCOUNT_A), redeem(ACCOUNT_B)]);
    expect(responses.map((response) => response?.status).sort()).toEqual([201, 409]);
    const successful = responses.find((response) => response?.status === 201);
    const successfulBody = await body(successful!);
    expect(successfulBody).toMatchObject({
      outcome: 'redeemed',
      roomCode: '000100',
      roomGeneration: 0,
      setupRequired: true,
    });
    expect(successfulBody).not.toHaveProperty('activationUrl');
    expect(successfulBody).not.toHaveProperty('expiresAt');
    expect(issued).toBe(0);
    expect(
      db.database.prepare('SELECT COUNT(*) AS count FROM mxqr_pro_grants').get(),
    ).toMatchObject({ count: 1 });
    expect(
      db.database.prepare('SELECT COUNT(*) AS count FROM mxqr_pro_grant_redemptions').get(),
    ).toMatchObject({ count: 1 });
    const durableVoucher = db.database
      .prepare(
        `SELECT status, redeemed_account_id FROM mxqr_pro_grant_vouchers WHERE room_code = '000100'`,
      )
      .get() as { status: string; redeemed_account_id: string };
    expect(durableVoucher.status).toBe('redeemed');
    expect([ACCOUNT_A, ACCOUNT_B]).toContain(durableVoucher.redeemed_account_id);
  });

  it('finalizes a reserved allocation without changing room identity', async () => {
    db = new D1();
    const now = Date.now();
    db.database.exec(`
      INSERT INTO mxqr_pro_room_registry
        (room_code,label,status,suspension_reason,activation_state,room_generation,created_at,updated_at)
      VALUES ('000100','Event','registered',NULL,'unactivated',0,${now},${now});
      INSERT INTO mxqr_pro_grant_campaigns VALUES
        ('campaign_${'A'.repeat(22)}','asamo-0','ASAMO','active',${now - 1},NULL,1,${now},${now});
      INSERT INTO mxqr_pro_grant_voucher_batches VALUES
        ('campaign_${'A'.repeat(22)}','batch_${'B'.repeat(22)}','${'C'.repeat(43)}','committed',1,${now},${now});
      INSERT INTO mxqr_pro_grant_vouchers VALUES
        ('voucher_${'D'.repeat(22)}','campaign_${'A'.repeat(22)}','batch_${'B'.repeat(22)}','${'E'.repeat(43)}','000100',0,'redeemed','${ACCOUNT_A}',${now},${now},${now});
      INSERT INTO mxqr_pro_grants VALUES
        ('grant_${'F'.repeat(22)}','pro_room','pro_room_perpetual','${ACCOUNT_A}','campaign','campaign_${'A'.repeat(22)}','pending_activation',${now},NULL,${now},${now});
      INSERT INTO mxqr_pro_grant_allocations VALUES
        ('allocation_${'G'.repeat(22)}','grant_${'F'.repeat(22)}','000100',0,'reserved',${now},${now});
      INSERT INTO mxqr_pro_account_entitlements
        (account_id,room_code,room_generation,source_kind,source_ref,transfer_request_id,status,created_at,updated_at)
      VALUES
        ('${ACCOUNT_A}','000100',0,'grant','grant_${'F'.repeat(22)}',NULL,'reserved',${now},${now});
      INSERT INTO mxqr_pro_grant_redemptions VALUES
        ('redemption_${'H'.repeat(22)}','campaign_${'A'.repeat(22)}','voucher_${'D'.repeat(22)}','grant_${'F'.repeat(22)}','${ACCOUNT_A}','redeemed',NULL,${now},${now});
    `);
    const finalized = await finalizeProGrantActivation(
      { MUSIXQUARE_ADMIN_DB: db },
      { accountId: ACCOUNT_A, roomCode: '000100', roomGeneration: 0, nowMs: now + 1 },
    );
    expect(finalized).toBe(true);
    expect(db.database.prepare('SELECT status FROM mxqr_pro_grants').get()).toMatchObject({
      status: 'active',
    });
    expect(
      db.database.prepare('SELECT status, room_code FROM mxqr_pro_grant_allocations').get(),
    ).toMatchObject({ status: 'active', room_code: '000100' });
    expect(
      db.database.prepare('SELECT status FROM mxqr_pro_grant_redemptions').get(),
    ).toMatchObject({ status: 'fulfilled' });
  });

  it('rolls back the whole voucher batch when the room changes after preflight', async () => {
    db = new D1();
    const now = Date.now();
    db.database.exec(`
      INSERT INTO mxqr_pro_room_registry VALUES
        ('000100','Event','registered',NULL,'active',0,${now},${now});
      INSERT INTO mxqr_pro_grant_campaigns VALUES
        ('campaign_${'A'.repeat(22)}','asamo-0','ASAMO','draft',${now - 1},NULL,1,${now},${now});
    `);
    const env = {
      MUSIXQUARE_ADMIN_DB: db,
      MUSIXQUARE_AUTH_DB: { prepare() {} },
      MXQR_PRO_GRANT_VOUCHER_PEPPER: PEPPER,
    };
    const dependencies = {
      preflightVoucherRoom: async () => ({
        roomCode: '000100',
        roomGeneration: 0,
        status: 'registered',
        activationState: 'unactivated',
      }),
    };
    const result = await handleProGrantAdminRequest(
      request('/api/admin/pro-grants/campaigns/asamo-0/vouchers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: `batch_${'R'.repeat(22)}`,
          dryRun: false,
          vouchers: [{ roomCode: '000100', code: '23456789ABCDEFGHJKMN' }],
        }),
      }),
      env,
      new URL('https://musixquare.com/api/admin/pro-grants/campaigns/asamo-0/vouchers'),
      dependencies,
    );
    expect(result?.status).toBe(503);
    expect(
      db.database.prepare('SELECT COUNT(*) AS count FROM mxqr_pro_grant_voucher_batches').get(),
    ).toMatchObject({ count: 0 });
    expect(
      db.database.prepare('SELECT COUNT(*) AS count FROM mxqr_pro_grant_vouchers').get(),
    ).toMatchObject({ count: 0 });
  });

  it('authorizes only the allocated account and fences ordinary activation or admin deletion', async () => {
    db = new D1();
    const now = Date.now();
    const env = { MUSIXQUARE_ADMIN_DB: db };
    expect(await markProRoomOwnerEntitlementBackfillComplete(env, now)).toBe(true);
    expect(
      await authorizeProGrantActivation(env, {
        accountId: ACCOUNT_A,
        roomCode: '000100',
        roomGeneration: 0,
      }),
    ).toBe(true);
    db.database.exec(`
      INSERT INTO mxqr_pro_grant_campaigns VALUES
        ('campaign_${'A'.repeat(22)}','asamo-0','ASAMO','active',${now - 1},NULL,1,${now},${now});
      INSERT INTO mxqr_pro_grants VALUES
        ('grant_${'F'.repeat(22)}','pro_room','pro_room_perpetual','${ACCOUNT_A}','campaign','campaign_${'A'.repeat(22)}','pending_activation',${now},NULL,${now},${now});
      INSERT INTO mxqr_pro_grant_allocations VALUES
        ('allocation_${'G'.repeat(22)}','grant_${'F'.repeat(22)}','000100',0,'reserved',${now},${now});
      INSERT INTO mxqr_pro_account_entitlements
        (account_id,room_code,room_generation,source_kind,source_ref,transfer_request_id,status,created_at,updated_at)
      VALUES
        ('${ACCOUNT_A}','000100',0,'grant','grant_${'F'.repeat(22)}',NULL,'reserved',${now},${now});
    `);
    expect(await hasReservedProGrantAllocation(env, '000100', 0)).toBe(true);
    expect(
      await authorizeProGrantActivation(env, {
        accountId: ACCOUNT_A,
        roomCode: '000100',
        roomGeneration: 0,
      }),
    ).toBe(true);
    expect(
      await authorizeProGrantActivation(env, {
        accountId: ACCOUNT_B,
        roomCode: '000100',
        roomGeneration: 0,
      }),
    ).toBe(false);
    expect(
      await authorizeProGrantActivation(env, {
        accountId: ACCOUNT_A,
        roomCode: '000101',
        roomGeneration: 0,
      }),
    ).toBe(false);
  });

  it('orphaning an account preserves its exact room allocation and makes it non-current', async () => {
    db = new D1();
    const now = Date.now();
    db.database.exec(`
      INSERT INTO mxqr_pro_room_registry
        (room_code,label,status,suspension_reason,activation_state,room_generation,created_at,updated_at)
      VALUES ('000100','Event','registered',NULL,'unactivated',0,${now},${now});
      INSERT INTO mxqr_pro_grant_campaigns VALUES
        ('campaign_${'A'.repeat(22)}','asamo-0','ASAMO','active',${now - 1},NULL,1,${now},${now});
      INSERT INTO mxqr_pro_grant_voucher_batches VALUES
        ('campaign_${'A'.repeat(22)}','batch_${'B'.repeat(22)}','${'C'.repeat(43)}','committed',1,${now},${now});
      INSERT INTO mxqr_pro_grant_vouchers VALUES
        ('voucher_${'D'.repeat(22)}','campaign_${'A'.repeat(22)}','batch_${'B'.repeat(22)}','${'E'.repeat(43)}','000100',0,'redeemed','${ACCOUNT_A}',${now},${now},${now});
      INSERT INTO mxqr_pro_grants VALUES
        ('grant_${'F'.repeat(22)}','pro_room','pro_room_perpetual','${ACCOUNT_A}','campaign','campaign_${'A'.repeat(22)}','pending_activation',${now},NULL,${now},${now});
      INSERT INTO mxqr_pro_grant_allocations VALUES
        ('allocation_${'G'.repeat(22)}','grant_${'F'.repeat(22)}','000100',0,'reserved',${now},${now});
      INSERT INTO mxqr_pro_account_entitlements
        (account_id,room_code,room_generation,source_kind,source_ref,transfer_request_id,status,created_at,updated_at)
      VALUES
        ('${ACCOUNT_A}','000100',0,'grant','grant_${'F'.repeat(22)}',NULL,'reserved',${now},${now});
      INSERT INTO mxqr_pro_grant_redemptions VALUES
        ('redemption_${'H'.repeat(22)}','campaign_${'A'.repeat(22)}','voucher_${'D'.repeat(22)}','grant_${'F'.repeat(22)}','${ACCOUNT_A}','redeemed',NULL,${now},${now});
    `);
    expect(await orphanAccountProGrants({ MUSIXQUARE_ADMIN_DB: db }, ACCOUNT_A, now + 1)).toBe(
      true,
    );
    expect(db.database.prepare('SELECT status FROM mxqr_pro_grants').get()).toMatchObject({
      status: 'orphaned',
    });
    expect(
      db.database.prepare('SELECT status FROM mxqr_pro_account_entitlements').get(),
    ).toMatchObject({ status: 'orphaned' });
    expect(
      db.database.prepare('SELECT status, room_code FROM mxqr_pro_grant_allocations').get(),
    ).toMatchObject({ status: 'orphaned', room_code: '000100' });
    expect(
      db.database.prepare('SELECT status FROM mxqr_pro_grant_redemptions').get(),
    ).toMatchObject({ status: 'orphaned' });
    expect(await hasReservedProGrantAllocation({ MUSIXQUARE_ADMIN_DB: db }, '000100', 0)).toBe(
      true,
    );
  });

  it('blocks acquisition until the canonical-owner backfill marker is durable', async () => {
    db = new D1();
    const now = Date.now();
    const env = { MUSIXQUARE_ADMIN_DB: db };
    const input = {
      accountId: ACCOUNT_A,
      roomCode: '000100',
      roomGeneration: 0,
      nowMs: now,
    };

    expect(await reserveProRoomActivationEntitlement(env, input)).toBe(false);
    expect(
      await reserveProRoomOwnershipTransferEntitlement(env, {
        targetAccountId: ACCOUNT_B,
        roomCode: '000101',
        roomGeneration: 0,
        requestId: 'transfer_request_gate',
        nowMs: now,
      }),
    ).toBe(false);
    expect(
      db.database.prepare('SELECT COUNT(*) AS count FROM mxqr_pro_account_entitlements').get(),
    ).toMatchObject({ count: 0 });
    expect(await markProRoomOwnerEntitlementBackfillComplete(env, now + 1)).toBe(true);
    expect(await reserveProRoomActivationEntitlement(env, { ...input, nowMs: now + 2 })).toBe(true);
    expect(
      await reserveProRoomOwnershipTransferEntitlement(env, {
        targetAccountId: ACCOUNT_B,
        roomCode: '000101',
        roomGeneration: 0,
        requestId: 'transfer_request_gate',
        nowMs: now + 2,
      }),
    ).toBe(true);
  });

  it('serializes voucher redemption against legacy activation for one account', async () => {
    db = new D1();
    const now = Date.now();
    const digest = await voucherDigest('asamo-0', '23456789ABCDEFGHJKMN');
    db.database.exec(`
      INSERT INTO mxqr_pro_room_registry VALUES
        ('000100','Voucher','registered',NULL,'unactivated',0,${now},${now}),
        ('000101','Legacy','registered',NULL,'unactivated',0,${now},${now});
      INSERT INTO mxqr_pro_grant_campaigns VALUES
        ('campaign_${'A'.repeat(22)}','asamo-0','ASAMO','active',${now - 1},NULL,1,${now},${now});
      INSERT INTO mxqr_pro_grant_voucher_batches VALUES
        ('campaign_${'A'.repeat(22)}','batch_${'B'.repeat(22)}','${'C'.repeat(43)}','committed',1,${now},${now});
    `);
    db.database
      .prepare(
        `INSERT INTO mxqr_pro_grant_vouchers VALUES
          (?, 'campaign_${'A'.repeat(22)}', 'batch_${'B'.repeat(22)}', ?,
           '000100', 0, 'available', NULL, NULL, ?, ?)`,
      )
      .run(`voucher_${'D'.repeat(22)}`, digest, now, now);
    const env = {
      MUSIXQUARE_ADMIN_DB: db,
      MUSIXQUARE_AUTH_DB: db,
      MXQR_PRO_GRANT_VOUCHER_PEPPER: PEPPER,
    };
    const dependencies = {
      resolveAccountSession: async () => ({
        accountId: ACCOUNT_A,
        nickname: 'Owner',
        profileComplete: true,
      }),
      isAccountActive: async () => true,
      issueActivationHandoff: async () => ({
        roomCode: '000100',
        roomGeneration: 0,
        activationUrl: 'https://musixquare.com/000100#pro-claim=v1.claim.sig',
        expiresAt: now + 60_000,
      }),
    };
    const redeemVoucherForAccount = () =>
      handleProGrantPublicRequest(
        request('/api/pro-grants/campaigns/asamo-0/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://musixquare.com' },
          body: JSON.stringify({ code: '2345-6789-ABCD-EFGH-JKMN' }),
        }),
        env,
        new URL('https://musixquare.com/api/pro-grants/campaigns/asamo-0/redeem'),
        dependencies,
      );
    expect((await redeemVoucherForAccount())?.status).toBe(503);
    expect(db.database.prepare('SELECT status FROM mxqr_pro_grant_vouchers').get()).toMatchObject({
      status: 'available',
    });
    expect(await markProRoomOwnerEntitlementBackfillComplete(env, now + 1)).toBe(true);
    const redeem = redeemVoucherForAccount();
    const legacy = reserveProRoomActivationEntitlement(env, {
      accountId: ACCOUNT_A,
      roomCode: '000101',
      roomGeneration: 0,
      nowMs: now + 2,
    });
    const [redeemed, legacyReserved] = await Promise.all([redeem, legacy]);

    expect(Number(redeemed?.status === 201) + Number(legacyReserved)).toBe(1);
    expect([201, 409]).toContain(redeemed?.status);
    expect(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM mxqr_pro_account_entitlements
            WHERE account_id = ? AND status IN ('reserved','active','suspended')`,
        )
        .get(ACCOUNT_A),
    ).toMatchObject({ count: 1 });
  });

  it('keeps the transfer source account occupied, blocks voucher issuance, and restores on abort', async () => {
    db = new D1();
    const now = Date.now();
    const sourceVoucherDigest = await voucherDigest('asamo-0', '23456789ABCDEFGHJKMN');
    db.database.exec(`
      INSERT INTO mxqr_pro_room_registry VALUES
        ('000100','Transfer','registered',NULL,'unactivated',0,${now},${now}),
        ('000101','Voucher','registered',NULL,'unactivated',0,${now},${now});
      INSERT INTO mxqr_pro_grant_campaigns VALUES
        ('campaign_${'A'.repeat(22)}','asamo-0','ASAMO','active',${now - 1},NULL,1,${now},${now});
      INSERT INTO mxqr_pro_grant_voucher_batches VALUES
        ('campaign_${'A'.repeat(22)}','batch_${'T'.repeat(22)}','${'U'.repeat(43)}','committed',2,${now},${now});
    `);
    db.database
      .prepare(
        `INSERT INTO mxqr_pro_grant_vouchers VALUES
          (?, 'campaign_${'A'.repeat(22)}', 'batch_${'T'.repeat(22)}', ?,
           '000101', 0, 'available', NULL, NULL, ?, ?)`,
      )
      .run(`voucher_${'V'.repeat(22)}`, sourceVoucherDigest, now, now);
    seedEntitlement(db.database, {
      accountId: ACCOUNT_A,
      roomCode: '000100',
      sourceRef: 'legacy:source-owner',
      status: 'active',
      now,
    });
    const env = {
      MUSIXQUARE_ADMIN_DB: db,
      MUSIXQUARE_AUTH_DB: db,
      MXQR_PRO_GRANT_VOUCHER_PEPPER: PEPPER,
    };
    expect(await markProRoomOwnerEntitlementBackfillComplete(env, now + 1)).toBe(true);
    const transfer = {
      targetAccountId: ACCOUNT_B,
      roomCode: '000100',
      roomGeneration: 0,
      requestId: 'transfer_request_0001',
      nowMs: now + 2,
    };
    expect(await reserveProRoomOwnershipTransferEntitlement(env, transfer)).toBe(true);
    expect(
      db.database
        .prepare(
          `SELECT status FROM mxqr_pro_account_entitlements
            WHERE source_ref = 'legacy:source-owner'`,
        )
        .get(),
    ).toMatchObject({ status: 'transfer_source_active' });
    expect(
      await reserveProRoomActivationEntitlement(env, {
        accountId: ACCOUNT_A,
        roomCode: '000102',
        roomGeneration: 0,
        nowMs: now + 3,
      }),
    ).toBe(false);

    const sourceRedeem = await handleProGrantPublicRequest(
      request('/api/pro-grants/campaigns/asamo-0/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://musixquare.com' },
        body: JSON.stringify({ code: '2345-6789-ABCD-EFGH-JKMN' }),
      }),
      env,
      new URL('https://musixquare.com/api/pro-grants/campaigns/asamo-0/redeem'),
      {
        resolveAccountSession: async () => ({
          accountId: ACCOUNT_A,
          nickname: 'Source',
          profileComplete: true,
        }),
      },
    );
    expect(sourceRedeem?.status).toBe(409);
    expect(await body(sourceRedeem!)).toEqual({ error: 'ACCOUNT_PRO_ROOM_LIMIT_REACHED' });
    expect(() =>
      db!.database.exec(`
        INSERT INTO mxqr_pro_grant_vouchers VALUES
          ('voucher_${'W'.repeat(22)}','campaign_${'A'.repeat(22)}','batch_${'T'.repeat(22)}',
           '${'X'.repeat(43)}','000100',0,'available',NULL,NULL,${now + 3},${now + 3})
      `),
    ).toThrow(/room is unavailable/i);

    expect(
      await abortProRoomOwnershipTransferEntitlement(env, { ...transfer, nowMs: now + 4 }),
    ).toBe(true);
    expect(
      db.database
        .prepare(
          `SELECT source_kind, status FROM mxqr_pro_account_entitlements
            ORDER BY entitlement_id`,
        )
        .all(),
    ).toEqual([
      { source_kind: 'legacy_activation', status: 'active' },
      { source_kind: 'owner_transfer', status: 'revoked' },
    ]);
  });

  it('finalizes a transfer by retaining its source history and activating the target', async () => {
    db = new D1();
    const now = Date.now();
    const env = { MUSIXQUARE_ADMIN_DB: db };
    seedEntitlement(db.database, {
      accountId: ACCOUNT_A,
      roomCode: '000100',
      sourceRef: 'legacy:suspended-source',
      status: 'suspended',
      now,
    });
    expect(await markProRoomOwnerEntitlementBackfillComplete(env, now + 1)).toBe(true);
    const transfer = {
      targetAccountId: ACCOUNT_B,
      roomCode: '000100',
      roomGeneration: 0,
      requestId: 'transfer_request_0002',
      nowMs: now + 2,
    };
    expect(await reserveProRoomOwnershipTransferEntitlement(env, transfer)).toBe(true);
    expect(
      await finalizeProRoomOwnershipTransferEntitlement(env, { ...transfer, nowMs: now + 3 }),
    ).toBe(true);
    expect(
      db.database
        .prepare(
          `SELECT source_kind, status FROM mxqr_pro_account_entitlements
            ORDER BY entitlement_id`,
        )
        .all(),
    ).toEqual([
      { source_kind: 'legacy_activation', status: 'transferred' },
      { source_kind: 'owner_transfer', status: 'active' },
    ]);
    expect(
      await upsertProRoomOwnerEntitlement(env, {
        accountId: ACCOUNT_B,
        roomCode: '000100',
        roomGeneration: 0,
        status: 'suspended',
        sourceRef: 'canonical:000100:0',
        nowMs: now + 4,
      }),
    ).toBe(true);
    expect(
      db.database
        .prepare(
          `SELECT status FROM mxqr_pro_account_entitlements
            WHERE source_kind = 'owner_transfer'`,
        )
        .get(),
    ).toMatchObject({ status: 'suspended' });
  });

  it('retires grant projections only when a transfer finalizes and retries idempotently', async () => {
    db = new D1();
    const now = Date.now();
    const env = { MUSIXQUARE_ADMIN_DB: db };
    db.database.exec(`
      INSERT INTO mxqr_pro_room_registry VALUES
        ('000100','Grant transfer','registered',NULL,'unactivated',0,${now},${now});
      INSERT INTO mxqr_pro_grant_campaigns VALUES
        ('campaign_${'A'.repeat(22)}','asamo-0','ASAMO','active',${now - 1},NULL,1,${now},${now});
      INSERT INTO mxqr_pro_grant_voucher_batches VALUES
        ('campaign_${'A'.repeat(22)}','batch_${'B'.repeat(22)}','${'C'.repeat(43)}','committed',1,${now},${now});
      INSERT INTO mxqr_pro_grant_vouchers VALUES
        ('voucher_${'D'.repeat(22)}','campaign_${'A'.repeat(22)}','batch_${'B'.repeat(22)}','${'E'.repeat(43)}','000100',0,'redeemed','${ACCOUNT_A}',${now},${now},${now});
      INSERT INTO mxqr_pro_grants VALUES
        ('grant_${'F'.repeat(22)}','pro_room','pro_room_perpetual','${ACCOUNT_A}','campaign','campaign_${'A'.repeat(22)}','active',${now},NULL,${now},${now});
      INSERT INTO mxqr_pro_grant_allocations VALUES
        ('allocation_${'G'.repeat(22)}','grant_${'F'.repeat(22)}','000100',0,'active',${now},${now});
      INSERT INTO mxqr_pro_account_entitlements
        (account_id,room_code,room_generation,source_kind,source_ref,transfer_request_id,status,created_at,updated_at)
      VALUES
        ('${ACCOUNT_A}','000100',0,'grant','grant_${'F'.repeat(22)}',NULL,'active',${now},${now});
      INSERT INTO mxqr_pro_grant_redemptions VALUES
        ('redemption_${'H'.repeat(22)}','campaign_${'A'.repeat(22)}','voucher_${'D'.repeat(22)}','grant_${'F'.repeat(22)}','${ACCOUNT_A}','fulfilled',NULL,${now},${now});
    `);
    expect(await markProRoomOwnerEntitlementBackfillComplete(env, now + 1)).toBe(true);
    const aborted = {
      targetAccountId: ACCOUNT_B,
      roomCode: '000100',
      roomGeneration: 0,
      requestId: 'transfer_grant_abort',
      nowMs: now + 2,
    };
    expect(await reserveProRoomOwnershipTransferEntitlement(env, aborted)).toBe(true);
    expect(
      db.database
        .prepare(
          `SELECT grant_row.status AS grant_status,
                  allocation.status AS allocation_status,
                  redemption.status AS redemption_status
             FROM mxqr_pro_grants grant_row
             JOIN mxqr_pro_grant_allocations allocation USING (grant_id)
             JOIN mxqr_pro_grant_redemptions redemption USING (grant_id)`,
        )
        .get(),
    ).toEqual({
      grant_status: 'active',
      allocation_status: 'active',
      redemption_status: 'fulfilled',
    });
    expect(
      await abortProRoomOwnershipTransferEntitlement(env, { ...aborted, nowMs: now + 3 }),
    ).toBe(true);
    expect(
      db.database
        .prepare(
          `SELECT grant_row.status AS grant_status,
                  allocation.status AS allocation_status,
                  redemption.status AS redemption_status,
                  entitlement.status AS entitlement_status
             FROM mxqr_pro_grants grant_row
             JOIN mxqr_pro_grant_allocations allocation USING (grant_id)
             JOIN mxqr_pro_grant_redemptions redemption USING (grant_id)
             JOIN mxqr_pro_account_entitlements entitlement
               ON entitlement.source_kind = 'grant'
              AND entitlement.source_ref = grant_row.grant_id`,
        )
        .get(),
    ).toEqual({
      grant_status: 'active',
      allocation_status: 'active',
      redemption_status: 'fulfilled',
      entitlement_status: 'active',
    });

    const finalized = {
      ...aborted,
      requestId: 'transfer_grant_final',
      nowMs: now + 4,
    };
    expect(await reserveProRoomOwnershipTransferEntitlement(env, finalized)).toBe(true);
    expect(
      await finalizeProRoomOwnershipTransferEntitlement(env, {
        ...finalized,
        nowMs: now + 5,
      }),
    ).toBe(true);
    const afterFinalize = db.database
      .prepare(
        `SELECT grant_row.status AS grant_status,
                grant_row.updated_at AS grant_updated_at,
                allocation.status AS allocation_status,
                allocation.updated_at AS allocation_updated_at,
                redemption.status AS redemption_status,
                redemption.updated_at AS redemption_updated_at,
                source.status AS source_status,
                source.updated_at AS source_updated_at,
                target.status AS target_status,
                target.updated_at AS target_updated_at
           FROM mxqr_pro_grants grant_row
           JOIN mxqr_pro_grant_allocations allocation USING (grant_id)
           JOIN mxqr_pro_grant_redemptions redemption USING (grant_id)
           JOIN mxqr_pro_account_entitlements source
             ON source.source_kind = 'grant' AND source.source_ref = grant_row.grant_id
           JOIN mxqr_pro_account_entitlements target
             ON target.source_kind = 'owner_transfer'
            AND target.source_ref = 'transfer_grant_final'`,
      )
      .get();
    expect(afterFinalize).toMatchObject({
      grant_status: 'revoked',
      allocation_status: 'revoked',
      redemption_status: 'revoked',
      source_status: 'transferred',
      target_status: 'active',
    });
    expect(db.database.prepare('SELECT status FROM mxqr_pro_grant_vouchers').get()).toEqual({
      status: 'redeemed',
    });
    expect(
      await finalizeProRoomOwnershipTransferEntitlement(env, {
        ...finalized,
        nowMs: now + 6,
      }),
    ).toBe(true);
    expect(
      db.database
        .prepare(
          `SELECT grant_row.status AS grant_status,
                  grant_row.updated_at AS grant_updated_at,
                  allocation.status AS allocation_status,
                  allocation.updated_at AS allocation_updated_at,
                  redemption.status AS redemption_status,
                  redemption.updated_at AS redemption_updated_at,
                  source.status AS source_status,
                  source.updated_at AS source_updated_at,
                  target.status AS target_status,
                  target.updated_at AS target_updated_at
             FROM mxqr_pro_grants grant_row
             JOIN mxqr_pro_grant_allocations allocation USING (grant_id)
             JOIN mxqr_pro_grant_redemptions redemption USING (grant_id)
             JOIN mxqr_pro_account_entitlements source
               ON source.source_kind = 'grant' AND source.source_ref = grant_row.grant_id
             JOIN mxqr_pro_account_entitlements target
               ON target.source_kind = 'owner_transfer'
              AND target.source_ref = 'transfer_grant_final'`,
        )
        .get(),
    ).toEqual(afterFinalize);
    expect(
      db.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM mxqr_pro_grants) AS grants,
             (SELECT COUNT(*) FROM mxqr_pro_grant_allocations) AS allocations,
             (SELECT COUNT(*) FROM mxqr_pro_grant_redemptions) AS redemptions`,
        )
        .get(),
    ).toEqual({ grants: 1, allocations: 1, redemptions: 1 });
  });

  it('revokes exact-room available vouchers without rewriting redeemed voucher history', async () => {
    db = new D1();
    const now = Date.now();
    const env = { MUSIXQUARE_ADMIN_DB: db };
    db.database.exec(`
      INSERT INTO mxqr_pro_room_registry VALUES
        ('000100','Available','registered',NULL,'unactivated',0,${now},${now}),
        ('000101','Redeemed','registered',NULL,'unactivated',0,${now},${now});
      INSERT INTO mxqr_pro_grant_campaigns VALUES
        ('campaign_${'A'.repeat(22)}','asamo-0','ASAMO','active',${now - 1},NULL,1,${now},${now});
      INSERT INTO mxqr_pro_grant_voucher_batches VALUES
        ('campaign_${'A'.repeat(22)}','batch_${'B'.repeat(22)}','${'C'.repeat(43)}','committed',2,${now},${now});
      INSERT INTO mxqr_pro_grant_vouchers VALUES
        ('voucher_${'D'.repeat(22)}','campaign_${'A'.repeat(22)}','batch_${'B'.repeat(22)}','${'E'.repeat(43)}','000100',0,'available',NULL,NULL,${now},${now}),
        ('voucher_${'I'.repeat(22)}','campaign_${'A'.repeat(22)}','batch_${'B'.repeat(22)}','${'J'.repeat(43)}','000101',0,'redeemed','${ACCOUNT_A}',${now},${now},${now});
    `);
    expect(
      await revokeProRoomEntitlement(env, {
        roomCode: '000100',
        roomGeneration: 0,
        nowMs: now + 1,
      }),
    ).toBe(true);
    expect(
      db.database
        .prepare(
          `SELECT status, redeemed_account_id, redeemed_at, updated_at
             FROM mxqr_pro_grant_vouchers WHERE room_code = '000100'`,
        )
        .get(),
    ).toEqual({
      status: 'revoked',
      redeemed_account_id: null,
      redeemed_at: null,
      updated_at: now + 1,
    });
    expect(
      await revokeProRoomEntitlement(env, {
        accountId: ACCOUNT_A,
        roomCode: '000101',
        roomGeneration: 0,
        nowMs: now + 2,
      }),
    ).toBe(true);
    expect(
      db.database
        .prepare(
          `SELECT status, redeemed_account_id, redeemed_at, updated_at
             FROM mxqr_pro_grant_vouchers WHERE room_code = '000101'`,
        )
        .get(),
    ).toEqual({
      status: 'redeemed',
      redeemed_account_id: ACCOUNT_A,
      redeemed_at: now,
      updated_at: now,
    });
  });

  it('closes transfer-source history when a committed target account is orphaned', async () => {
    db = new D1();
    const now = Date.now();
    const env = { MUSIXQUARE_ADMIN_DB: db };
    seedEntitlement(db.database, {
      accountId: ACCOUNT_A,
      roomCode: '000100',
      sourceRef: 'legacy:target-deleted-source',
      status: 'active',
      now,
    });
    expect(await markProRoomOwnerEntitlementBackfillComplete(env, now + 1)).toBe(true);
    const transfer = {
      targetAccountId: ACCOUNT_B,
      roomCode: '000100',
      roomGeneration: 0,
      requestId: 'transfer_request_0005',
      nowMs: now + 2,
    };
    expect(await reserveProRoomOwnershipTransferEntitlement(env, transfer)).toBe(true);
    expect(await orphanAccountProGrants(env, ACCOUNT_B, now + 3)).toBe(true);
    expect(
      await finalizeProRoomOwnershipTransferEntitlement(env, { ...transfer, nowMs: now + 4 }),
    ).toBe(true);
    expect(
      db.database
        .prepare(
          `SELECT source_kind, status FROM mxqr_pro_account_entitlements
            ORDER BY entitlement_id`,
        )
        .all(),
    ).toEqual([
      { source_kind: 'legacy_activation', status: 'transferred' },
      { source_kind: 'owner_transfer', status: 'orphaned' },
    ]);
  });

  it('supports source-less transfer reservations and restores an orphaned source on abort', async () => {
    db = new D1();
    const now = Date.now();
    const env = { MUSIXQUARE_ADMIN_DB: db };
    expect(await markProRoomOwnerEntitlementBackfillComplete(env, now)).toBe(true);
    const sourceLess = {
      targetAccountId: ACCOUNT_C,
      roomCode: '000101',
      roomGeneration: 0,
      requestId: 'transfer_request_0003',
      nowMs: now + 1,
    };
    expect(await reserveProRoomOwnershipTransferEntitlement(env, sourceLess)).toBe(true);
    expect(
      await reserveProRoomOwnershipTransferEntitlement(env, {
        ...sourceLess,
        targetAccountId: ACCOUNT_B,
        requestId: 'transfer_request_race',
      }),
    ).toBe(false);
    expect(
      db.database
        .prepare(
          `SELECT account_id, source_ref, status FROM mxqr_pro_account_entitlements
            WHERE room_code = '000101'`,
        )
        .get(),
    ).toEqual({
      account_id: ACCOUNT_C,
      source_ref: 'transfer_request_0003',
      status: 'reserved',
    });
    expect(
      await finalizeProRoomOwnershipTransferEntitlement(env, { ...sourceLess, nowMs: now + 2 }),
    ).toBe(true);
    const chained = {
      targetAccountId: ACCOUNT_A,
      roomCode: '000101',
      roomGeneration: 0,
      requestId: 'transfer_request_chain',
      nowMs: now + 3,
    };
    expect(await reserveProRoomOwnershipTransferEntitlement(env, chained)).toBe(true);
    expect(
      db.database
        .prepare(
          `SELECT status FROM mxqr_pro_account_entitlements
            WHERE source_ref = 'transfer_request_0003'`,
        )
        .get(),
    ).toMatchObject({ status: 'transfer_source_active' });
    expect(
      await abortProRoomOwnershipTransferEntitlement(env, { ...chained, nowMs: now + 4 }),
    ).toBe(true);
    expect(
      db.database
        .prepare(
          `SELECT status, transfer_request_id FROM mxqr_pro_account_entitlements
            WHERE source_ref = 'transfer_request_0003'`,
        )
        .get(),
    ).toEqual({ status: 'active', transfer_request_id: 'transfer_request_0003' });

    seedEntitlement(db.database, {
      accountId: ACCOUNT_A,
      roomCode: '000102',
      sourceRef: 'legacy:orphaned-source',
      status: 'orphaned',
      now: now + 5,
    });
    const orphaned = {
      targetAccountId: ACCOUNT_B,
      roomCode: '000102',
      roomGeneration: 0,
      requestId: 'transfer_request_0004',
      nowMs: now + 6,
    };
    expect(await reserveProRoomOwnershipTransferEntitlement(env, orphaned)).toBe(true);
    expect(
      db.database
        .prepare(
          `SELECT status FROM mxqr_pro_account_entitlements
            WHERE source_ref = 'legacy:orphaned-source'`,
        )
        .get(),
    ).toMatchObject({ status: 'transfer_source_orphaned' });
    expect(
      await abortProRoomOwnershipTransferEntitlement(env, { ...orphaned, nowMs: now + 7 }),
    ).toBe(true);
    expect(
      db.database
        .prepare(
          `SELECT status FROM mxqr_pro_account_entitlements
            WHERE source_ref = 'legacy:orphaned-source'`,
        )
        .get(),
    ).toMatchObject({ status: 'orphaned' });
  });
});
