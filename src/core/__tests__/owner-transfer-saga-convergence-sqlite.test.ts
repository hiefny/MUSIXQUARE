import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
  ACCOUNT_ASSERTION_HEADER,
  createAccountAssertion,
} from '../../../cloudflare/account-assertion.ts';
import {
  recordAccountProRoomLink,
  resetAccountAuthCachesForTests,
} from '../../../cloudflare/account-auth.ts';
import appWorker, {
  purgeProRoomAccountAuthorityForTests,
  reconcileOwnerTransferSagasForTests,
} from '../../../cloudflare/app-worker.ts';
import { issueProRoomActivationClaim } from '../../../cloudflare/pro-room-claims.ts';
import proRoomWorker, { MusixquareProRoom } from '../../../cloudflare/pro-room-worker.ts';
import {
  MemoryDurableObjectStorage,
  createSqlJournal,
  nodeSqlite,
  SqliteD1,
  type SqlEvent,
  trackedSql,
} from './helpers/worker-test-bindings.ts';

/**
 * C7-0 characterization of the owner-transfer saga (resource RO-09 in
 * docs/design/resource-ownership-registry.md) over all three D1 bindings.
 *
 * Two executors drive one `mxqr_pro_room_owner_transfer_sagas` row: the
 * request executor (POST /api/pro-room/v1/rooms/:code/owner-transfer through
 * the real App Worker) and the minute cron's `reconcileOwnerTransferSagas`
 * (through its existing entry, `reconcileOwnerTransferSagasForTests`).
 * Everything they touch is real: the App Worker, the PRO front door and room
 * Durable Object (in-process, as both the public PREPARE route and the admin
 * namespace), and three node:sqlite databases shared by both Workers, as in
 * production: admin metrics (saga, registry, issuance, entitlements, audit),
 * auth (accounts, sessions, deletions, account-room edges) and Developer API
 * (keys, authority fence). Each is loaded from its tracked fresh-install
 * schema file, which already carries the saga, intent-admission, pro-grants
 * and authority-fence migrations.
 * The only fake is signaling (a third Worker): it answers presence broadcasts
 * and installs the owner-account-deletion fence, as
 * `handleInternalOwnerAccountDeletedFence` does for a first install; its own
 * fence rules are covered in cloudflare-signaling-worker.test.ts. The claim
 * issuance row is seeded directly (see `issueClaim`), because the admin
 * console route that records it sits behind Cloudflare Access.
 *
 * Crashes and races are injected at the D1 boundary (see worker-test-bindings):
 * a thrown statement models an unavailable database at that step, a parked
 * statement models a slow request that another executor overtakes. The
 * observed op log is the ordered list of executed D1 write statements,
 * classified into saga steps; a compare-and-swap that changed no row still
 * appears, because both executors issue it. Date, setTimeout and clearTimeout
 * are faked, so no request deadline can expire on the wall clock while a
 * statement is parked. Tests pin today's behaviour, including the divergent
 * step order and the duplicate success audit, with comments naming the owner
 * decision or plan step (C7-8, C7-9, C7-10) that may change them.
 */

const ROOM_CODE = '000417';
const ROOM_GENERATION = 0;
const OLD_OWNER = 'acct_OldOwnerBoundary000001';
const TARGET = 'acct_NewOwnerBoundary000002';
const REQUEST_ID = 'saga_request_0000001';
const SECRET = (purpose: string) => `saga-${purpose}-secret-`.padEnd(48, 'x');
const SESSION_PEPPER = SECRET('session-pepper');
const ASSERTION_SECRET = SECRET('assertion');
const ACTIVATION_SECRET = SECRET('activation');
const START = Date.UTC(2026, 9, 22, 3, 0, 0);
const TARGET_TOKEN = 'T'.repeat(43);
const fixtures: Array<() => void> = [];

async function sessionHash(token: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SESSION_PEPPER),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`account-session:v1\u0000${token}`),
  );
  return Buffer.from(signature).toString('base64url');
}

const ACCOUNT_LABELS: Record<string, string> = { [OLD_OWNER]: 'old', [TARGET]: 'target' };

/** One D1 write, classified into a saga step; null for unrelated writes. */
function step(event: SqlEvent): string | null {
  const sql = event.sql.replace(/\s+/g, ' ').trim();
  const value = (index: number) => event.values[index];
  if (/^UPDATE mxqr_pro_room_owner_transfer_sagas SET state = \?5/i.test(sql)) {
    return `saga:${value(4)}`;
  }
  if (/^UPDATE mxqr_pro_room_owner_transfer_sagas SET state = \?4/i.test(sql)) {
    return `saga:${value(3)}`;
  }
  if (/^INSERT OR IGNORE INTO mxqr_pro_room_owner_transfer_sagas/i.test(sql)) {
    return 'saga:intent';
  }
  if (/^UPDATE mxqr_pro_room_owner_transfer_sagas SET claim_generation/i.test(sql)) {
    return 'saga:prepared';
  }
  if (/^INSERT INTO mxqr_pro_account_entitlements .*'owner_transfer'/i.test(sql)) {
    return 'entitlement:reserve';
  }
  if (/^UPDATE mxqr_pro_account_entitlements SET status = 'transferred'/i.test(sql)) {
    return 'entitlement:finalize';
  }
  if (/^INSERT INTO mxqr_developer_api_room_authority_fences/i.test(sql)) {
    return `fence:${value(2)}`;
  }
  if (/^UPDATE mxqr_developer_api_room_authority_fences SET status = 'cleared'/i.test(sql)) {
    return 'fence:clear';
  }
  if (/^INSERT INTO mxqr_pro_room_admin_audit .*VALUES \('system:account-delete'/i.test(sql)) {
    return 'audit:room.suspend:owner_account_deleted';
  }
  if (/^INSERT INTO mxqr_pro_room_admin_audit/i.test(sql) && value(0) === 'system:owner-transfer') {
    return `audit:${value(1)}:${value(2)}`;
  }
  if (/^UPDATE mxqr_pro_room_registry SET status = \?3/i.test(sql)) {
    return `registry:${value(2)}${value(3) ? `/${value(3)}` : ''}`;
  }
  if (/^UPDATE mxqr_pro_room_registry SET status = 'suspended'/i.test(sql)) {
    return 'registry:suspended/owner_account_deleted';
  }
  if (event.db === 'auth' && /^INSERT INTO mxqr_account_pro_room_generations/i.test(sql)) {
    return `link:+${ACCOUNT_LABELS[String(value(0))] ?? value(0)}`;
  }
  if (event.db === 'auth' && /^DELETE FROM mxqr_account_pro_room_generations/i.test(sql)) {
    return `link:-${ACCOUNT_LABELS[String(value(0))] ?? value(0)}`;
  }
  return null;
}

type Fault = (event: SqlEvent) => boolean;

/** Matches the nth (1-based) statement accepted by `predicate`. */
function nth(count: number, predicate: Fault): Fault {
  let seen = 0;
  return (event) => predicate(event) && ++seen === count;
}

const sagaWrite =
  (state: string): Fault =>
  (event) =>
    step(event) === `saga:${state}`;
const stepIs =
  (name: string): Fault =>
  (event) =>
    step(event) === name;

async function transferFixture() {
  const journal = createSqlJournal();
  const admin = new SqliteD1('admin', trackedSql('admin-metrics.schema.sql'), journal);
  const auth = new SqliteD1('auth', trackedSql('auth.schema.sql'), journal);
  const developer = new SqliteD1('developer', trackedSql('developer-api.schema.sql'), journal);
  const background: Promise<unknown>[] = [];
  const signalingCalls: string[] = [];
  const signalingNamespace = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        const body = (await request.json()) as Record<string, unknown>;
        signalingCalls.push(path);
        if (path === '/internal/admin/v1/owner-account-deleted') {
          return Response.json({
            ok: true,
            roomCode: body.roomCode,
            roomGeneration: body.roomGeneration,
            status: 'suspended',
            reason: 'owner_account_deleted',
            fenceStatus: 'installed',
            changed: true,
            removalId: body.removalId,
            removedOwnerAuthorityEpoch: body.removedOwnerAuthorityEpoch,
            fencedCoordinatorEpoch: body.fencedCoordinatorEpoch,
            effectiveCoordinatorEpoch: body.fencedCoordinatorEpoch,
          });
        }
        return Response.json({ broadcast: true, eligible: 0, sent: 0 });
      },
    }),
  };
  const proEnv: Record<string, unknown> = {
    PRO_ROOM_ACTIVATION_SECRET: ACTIVATION_SECRET,
    PRO_ROOM_PIN_PEPPER: SECRET('pin'),
    PRO_ROOM_SESSION_SECRET: SECRET('room-session'),
    PRO_ROOM_RATE_LIMIT_SECRET: SECRET('rate'),
    MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET: ASSERTION_SECRET,
    PRO_SIGNALING_SECRET: SECRET('signaling'),
    MUSIXQUARE_ADMIN_DB: admin,
    MUSIXQUARE_AUTH_DB: auth,
    DEVELOPER_API_DB: developer,
    PRO_SIGNALING_ROOMS: signalingNamespace,
  };
  const rooms = new Map<string, MusixquareProRoom>();
  const roomNamespace = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: (request: Request) => {
        let room = rooms.get(name);
        if (!room) {
          room = new MusixquareProRoom(
            {
              storage: new MemoryDurableObjectStorage(),
              waitUntil: (promise: Promise<unknown>) => background.push(promise),
            } as never,
            proEnv as never,
          );
          rooms.set(name, room);
        }
        return room.fetch(request);
      },
    }),
  };
  proEnv.PRO_ROOMS = roomNamespace;
  const appEnv: Record<string, unknown> = {
    GOOGLE_OAUTH_CLIENT_ID: 'saga-test.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'saga-client-secret',
    MXQR_AUTH_SESSION_PEPPER: SESSION_PEPPER,
    MXQR_AUTH_SUBJECT_PEPPER: SECRET('subject-pepper'),
    MXQR_OAUTH_STATE_SECRET: SECRET('oauth-state'),
    MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET: ASSERTION_SECRET,
    MXQR_DEVELOPER_API_KEY_PEPPER: SECRET('developer-pepper'),
    MUSIXQUARE_ADMIN_DB: admin,
    MUSIXQUARE_AUTH_DB: auth,
    DEVELOPER_API_DB: developer,
    PRO_ROOM_ADMIN_ROOMS: roomNamespace,
    PRO_SIGNALING_ROOMS: signalingNamespace,
    PRO_ROOM_PUBLIC_API: {
      fetch: (request: Request) =>
        proRoomWorker.fetch(
          request,
          proEnv as never,
          {
            waitUntil: (promise: Promise<unknown>) => background.push(promise),
          } as never,
        ),
    },
  };
  const room = () => roomNamespace.get(`${ROOM_CODE}:generation:${ROOM_GENERATION}`);
  const internal = (path: string, body?: Record<string, unknown>) =>
    room().fetch(
      new Request(`https://pro-room.internal${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          'x-mxqr-pro-room-code': ROOM_CODE,
          'x-mxqr-pro-room-generation': String(ROOM_GENERATION),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify({ ...body, roomGeneration: ROOM_GENERATION }) } : {}),
      }),
    );
  fixtures.push(() => {
    for (const instance of rooms.values()) {
      instance.clearAlarmMaintenanceRetry();
      instance.invalidatePendingHeartbeatFlush();
    }
    admin.close();
    auth.close();
    developer.close();
  });

  // Earlier product steps, seeded as they would leave the databases: the
  // registry row and entitlement backfill marker, both accounts, the
  // target's App session, and one live Developer API key for the room.
  const seededAt = START - 60_000;
  admin.database
    .prepare(
      `INSERT INTO mxqr_pro_room_registry
         (room_code, label, status, suspension_reason, activation_state, room_generation,
          created_at, updated_at)
       VALUES (?, 'Saga fixture', 'registered', NULL, 'unactivated', ?, ?, ?)`,
    )
    .run(ROOM_CODE, ROOM_GENERATION, seededAt, seededAt);
  admin.database
    .prepare(
      `INSERT INTO mxqr_pro_grant_audit (actor_id, action, result, created_at)
       VALUES ('system:entitlement-backfill', 'entitlement.backfill', 'complete', ?)`,
    )
    .run(seededAt);
  for (const [accountId, nickname] of [
    [OLD_OWNER, 'Old owner'],
    [TARGET, 'New owner'],
  ] as const) {
    auth.database
      .prepare(
        `INSERT INTO mxqr_accounts
           (account_id, google_subject_hash, nickname, profile_complete, status,
            created_at, updated_at)
         VALUES (?, ?, ?, 1, 'active', ?, ?)`,
      )
      .run(accountId, accountId.slice(5).padEnd(43, 'h'), nickname, seededAt, seededAt);
  }
  auth.database
    .prepare(
      `INSERT INTO mxqr_account_sessions
         (session_hash, account_id, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(await sessionHash(TARGET_TOKEN), TARGET, seededAt, seededAt, START + 86_400_000);
  developer.database
    .prepare(
      `INSERT INTO mxqr_developer_api_keys
         (key_id, room_code, room_generation, label, secret_digest, digest_version,
          scope_mask, status, created_at, updated_at, expires_at, revoked_at, last_used_hour)
       VALUES ('SagaFixtureKey01', ?, ?, 'Saga key', ?, 1, 1, 'active', ?, ?, ?, NULL, NULL)`,
    )
    .run(ROOM_CODE, ROOM_GENERATION, 'K'.repeat(43), seededAt, seededAt, START + 86_400_000);

  const fixture = {
    admin,
    auth,
    developer,
    journal,
    appEnv,
    signalingCalls,
    internal,
    async settle() {
      for (let round = 0; round < 40; round += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        if (background.length === 0) return;
        await Promise.allSettled(background.splice(0));
      }
      throw new Error('background work did not settle');
    },
    /** Saga steps written since `mark` (an index into the write journal). */
    steps(mark = 0): string[] {
      return journal.writes
        .slice(mark)
        .map(step)
        .filter((entry): entry is string => entry !== null);
    },
    mark: () => journal.writes.length,
    /** Make the first statement matching `fault` throw, as an unavailable D1 would. */
    failOnce(fault: Fault) {
      let fired = false;
      journal.hooks.push((event) => {
        if (!fired && fault(event)) {
          fired = true;
          throw new Error('injected D1 outage');
        }
      });
    },
    /** Park the first statement matching `fault` until released. */
    pauseOnce(fault: Fault) {
      let fired = false;
      let arrive!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      journal.hooks.push(async (event) => {
        if (!fired && fault(event)) {
          fired = true;
          arrive();
          await gate;
        }
      });
      return { reached, release };
    },
    /** Account deletion of the target starts just before `fault` runs. */
    deleteTargetBefore(fault: Fault) {
      let fired = false;
      journal.hooks.push((event) => {
        if (!fired && fault(event)) {
          fired = true;
          fixture.deleteTarget();
        }
      });
    },
    /** The account-deletion job starts for `accountId` (default: the target). */
    deleteTarget(accountId = TARGET) {
      auth.database
        .prepare('INSERT INTO mxqr_account_deletions (account_id, started_at) VALUES (?, ?)')
        .run(accountId, Date.now());
    },
    /** One account-deletion purge attempt, as the deletion job runs it. */
    purge(accountId: string) {
      return purgeProRoomAccountAuthorityForTests(
        { accountId, roomCode: ROOM_CODE, roomGeneration: ROOM_GENERATION },
        appEnv,
      );
    },
    fenceDigest() {
      return developer.rows<{ fence_digest: string }>(
        'SELECT fence_digest FROM mxqr_developer_api_room_authority_fences',
      )[0]?.fence_digest;
    },
    saga() {
      return admin.rows<Record<string, unknown>>(
        'SELECT state FROM mxqr_pro_room_owner_transfer_sagas WHERE request_id = ?',
        REQUEST_ID,
      )[0]?.state;
    },
    commitAudits(): string[] {
      return admin
        .rows<{ result: string }>(
          `SELECT result FROM mxqr_pro_room_admin_audit
            WHERE actor_id = 'system:owner-transfer' AND action = 'owner_transfer.commit'
            ORDER BY id`,
        )
        .map((row) => row.result);
    },
    entitlements(): Record<string, string> {
      return Object.fromEntries(
        admin
          .rows<{ account_id: string; status: string }>(
            'SELECT account_id, status FROM mxqr_pro_account_entitlements ORDER BY entitlement_id',
          )
          .map((row) => [ACCOUNT_LABELS[row.account_id] ?? row.account_id, row.status]),
      );
    },
    fence() {
      return developer.rows<{ status: string; reason: string }>(
        'SELECT status, reason FROM mxqr_developer_api_room_authority_fences',
      )[0];
    },
    keyStatus() {
      return developer.rows<{ status: string }>('SELECT status FROM mxqr_developer_api_keys')[0]
        ?.status;
    },
    links(): string[] {
      return auth
        .rows<{ account_id: string }>(
          'SELECT account_id FROM mxqr_account_pro_room_generations ORDER BY account_id',
        )
        .map((row) => ACCOUNT_LABELS[row.account_id] ?? row.account_id);
    },
    registry() {
      return admin.rows<{ status: string; suspension_reason: string | null }>(
        'SELECT status, suspension_reason FROM mxqr_pro_room_registry WHERE room_code = ?',
        ROOM_CODE,
      )[0];
    },
    async canonical() {
      const response = await internal('/internal/admin/status');
      expect(response.status).toBe(200);
      const payload = (await response.json()) as Record<string, any>;
      return {
        status: payload.status as string,
        suspensionReason: payload.suspensionReason as string | null,
        owner: ACCOUNT_LABELS[payload.ownerAccountId] ?? payload.ownerAccountId,
        reconciliation: payload.ownerTransferReconciliation?.phase ?? null,
      };
    },
    async cron(nowMs = Date.now()) {
      const progressed = await reconcileOwnerTransferSagasForTests(appEnv, admin, nowMs);
      await fixture.settle();
      return progressed;
    },
  };

  // The old owner activates the room (DO route with an App account assertion)
  // and the App records that owner's account-room edge.
  expect((await internal('/internal/admin/provision', {})).status).toBe(200);
  const activation = await room().fetch(
    new Request(`https://pro.musixquare.com/v1/rooms/${ROOM_CODE}/activation`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mxqr-pro-room-code': ROOM_CODE,
        'x-mxqr-pro-room-generation': String(ROOM_GENERATION),
        'x-mxqr-pro-ip-hash': 'saga-client-address',
        [ACCOUNT_ASSERTION_HEADER]: (await createAccountAssertion(
          {
            accountId: OLD_OWNER,
            nickname: 'Old owner',
            roomCode: ROOM_CODE,
            roomGeneration: ROOM_GENERATION,
            audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
          },
          ASSERTION_SECRET,
        ))!,
      },
      body: JSON.stringify({
        claimToken: await issueProRoomActivationClaim(ROOM_CODE, ACTIVATION_SECRET, {
          nowMs: Date.now() - 1_000,
          expiresAtMs: Date.now() + 60_000,
          nonce: 'saga-activation-nonce',
        }),
        temporaryPin: ROOM_CODE.padStart(8, '0'),
        newPin: '12345678',
        ownerName: 'Old owner',
      }),
    }),
  );
  expect(activation.status).toBe(200);
  expect(
    await recordAccountProRoomLink(appEnv, OLD_OWNER, ROOM_CODE, Date.now(), ROOM_GENERATION),
  ).toBe(true);
  await fixture.settle();
  return fixture;
}

type TransferFixture = Awaited<ReturnType<typeof transferFixture>>;

/** The old owner issues a claim; the admin console records its issuance row. */
async function issueClaim(test: TransferFixture) {
  const response = await test.internal('/internal/admin/owner-transfer-claim', {
    targetAccountId: TARGET,
  });
  expect(response.status).toBe(200);
  const issued = (await response.json()) as {
    claimGeneration: number;
    expiresAt: number;
    transferUrl: string;
  };
  // Mirrors recordOwnerTransferIssuance; the issuance ledger is outside the saga.
  test.admin.database
    .prepare(
      `INSERT INTO mxqr_pro_room_owner_transfer_issuances
         (room_code, room_generation, claim_generation, target_account_id,
          transfer_id, request_id, state, issued_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, 'issued', ?, ?, ?)`,
    )
    .run(
      ROOM_CODE,
      ROOM_GENERATION,
      issued.claimGeneration,
      TARGET,
      Date.now(),
      issued.expiresAt,
      Date.now(),
    );
  return decodeURIComponent(new URL(issued.transferUrl).hash.replace(/^#pro-transfer=/, ''));
}

/** The target account submits the claim through the App facade. */
async function requestTransfer(test: TransferFixture, claimToken: string) {
  const response = await appWorker.fetch(
    new Request(`https://musixquare.com/api/pro-room/v1/rooms/${ROOM_CODE}/owner-transfer`, {
      method: 'POST',
      headers: {
        Origin: 'https://musixquare.com',
        'Content-Type': 'application/json',
        'cf-connecting-ip': '192.0.2.10',
        Cookie: `__Host-mxqr_account=${TARGET_TOKEN}`,
      },
      body: JSON.stringify({ claimToken, newPin: '24681357', requestId: REQUEST_ID }),
    }),
    test.appEnv as never,
  );
  await test.settle();
  const body = (await response.json()) as Record<string, unknown>;
  return {
    status: response.status,
    error: (body.error as string | undefined) ?? null,
    cookies: response.headers.getSetCookie().map((cookie) => cookie.split('=')[0]),
  };
}

/** The state every converged transfer must reach, whichever executor finished it. */
async function expectTransferred(test: TransferFixture) {
  expect(test.saga()).toBe('complete');
  expect(test.entitlements()).toEqual({ old: 'transferred', target: 'active' });
  expect(test.fence()).toEqual({ status: 'cleared', reason: 'ownership_transfer_pending' });
  expect(test.keyStatus()).toBe('revoked');
  expect(test.links()).toEqual(['target']);
  expect(test.registry()).toEqual({ status: 'registered', suspension_reason: null });
  expect(await test.canonical()).toEqual({
    status: 'active',
    suspensionReason: null,
    owner: 'target',
    reconciliation: 'completed',
  });
}

/**
 * purgeProRoomAccountAuthority as D1 sees it: the Developer API fence is
 * relabelled for the deletion (compare-and-swap on the captured digest), then
 * the DO's acknowledged projection suspends the registry row and audits it.
 */
const PURGE = [
  'fence:owner_account_deleted',
  'registry:suspended/owner_account_deleted',
  'audit:room.suspend:owner_account_deleted',
];

/** The post-commit tail as the request executor writes it today. */
const REQUEST_TAIL = [
  'saga:committed',
  'registry:registered',
  'saga:registry_active',
  'link:-old',
  'saga:old_owner_edge_retired',
  'registry:registered',
  'entitlement:finalize',
  'saga:verified',
  'fence:clear',
  'audit:owner_transfer.commit:success',
  'saga:complete',
];

/** The same tail as the minute cron writes it today (after adopting the row). */
const CRON_TAIL = [
  'saga:committed',
  'registry:registered',
  'saga:registry_active',
  'link:-old',
  'saga:old_owner_edge_retired',
  'registry:registered',
  'saga:verified',
  'entitlement:finalize',
  'fence:clear',
  'audit:owner_transfer.commit:success',
  'saga:complete',
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(START);
  // The App's schema-ensure and the PRO room's diagnostics log to the console.
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const close of fixtures.splice(0)) close();
  resetAccountAuthCachesForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

(nodeSqlite ? describe : describe.skip)('owner-transfer saga: request executor', () => {
  it('finishes the whole transfer in one request and finalizes the entitlement before "verified"', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    const mark = test.mark();
    const result = await requestTransfer(test, claim);
    expect(result).toEqual({
      status: 200,
      error: null,
      cookies: ['__Secure-mxqr_pro_session_000417', '__Secure-mxqr_pro_owner_000417'],
    });
    expect(test.steps(mark)).toEqual([
      'saga:intent',
      // The DO's PREPARE reserves the target entitlement in the shared D1.
      'entitlement:reserve',
      'saga:prepared',
      'link:+target',
      'audit:owner_transfer.prepare:success',
      'registry:suspended/ownership_transfer_pending',
      'fence:ownership_transfer_pending',
      ...REQUEST_TAIL,
    ]);
    await expectTransferred(test);
    expect(test.commitAudits()).toEqual(['success']);
    // Nothing is left for the cron.
    expect(await test.cron(START + 60_000)).toBe(0);
    expect(test.commitAudits()).toEqual(['success']);
  });
});

(nodeSqlite ? describe : describe.skip)('owner-transfer saga: minute cron executor', () => {
  it('adopts a DO-committed transfer whose request stopped and advances "verified" before finalizing', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    test.failOnce(sagaWrite('committed'));
    expect(await requestTransfer(test, claim)).toEqual({
      status: 503,
      error: 'PRO_ROOM_REGISTRY_UNAVAILABLE',
      cookies: [],
    });
    expect(test.saga()).toBe('prepared');
    expect(await test.canonical()).toMatchObject({ status: 'active', owner: 'target' });

    vi.setSystemTime(START + 60_000);
    const mark = test.mark();
    expect(await test.cron()).toBe(1);
    // Divergent step order: the cron marks "verified" before it finalizes the
    // entitlement; the request does the reverse (REQUEST_TAIL). Owner decision
    // "finalize-before-verified" (roadmap section 5) sets one order in C7-9.
    expect(test.steps(mark)).toEqual(CRON_TAIL);
    await expectTransferred(test);
    expect(test.commitAudits()).toEqual(['success']);
  });

  // One row per post-commit step: the D1 write that fails, the request's
  // answer, and the commit audit rows once the cron has converged. This is the
  // (audit result, HTTP status) table plan step C7-9 must keep or change on
  // purpose. Today some failures audit 'reconcile_required' and some
  // (old_owner_edge_retired, verified, the success audit) audit nothing.
  const crashes: Array<[string, Fault, { status: number; error: string }, string[]]> = [
    [
      'registry projection',
      nth(1, stepIs('registry:registered')),
      { status: 503, error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' },
      ['reconcile_required', 'success'],
    ],
    [
      'saga registry_active',
      sagaWrite('registry_active'),
      { status: 503, error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' },
      ['reconcile_required', 'success'],
    ],
    [
      'old-owner edge retirement',
      stepIs('link:-old'),
      { status: 503, error: 'ACCOUNT_STORE_UNAVAILABLE' },
      ['reconcile_required', 'success'],
    ],
    [
      'saga old_owner_edge_retired',
      sagaWrite('old_owner_edge_retired'),
      { status: 503, error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' },
      ['success'],
    ],
    [
      'final registry projection',
      nth(2, stepIs('registry:registered')),
      { status: 503, error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' },
      ['reconcile_required', 'success'],
    ],
    [
      'entitlement finalize',
      stepIs('entitlement:finalize'),
      { status: 503, error: 'PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED' },
      ['entitlement_reconcile_required', 'success'],
    ],
    [
      'saga verified',
      sagaWrite('verified'),
      { status: 503, error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' },
      ['success'],
    ],
    [
      'fence clear',
      stepIs('fence:clear'),
      { status: 503, error: 'DEVELOPER_API_ADMIN_UNAVAILABLE' },
      ['reconcile_required', 'success'],
    ],
    [
      'success audit',
      stepIs('audit:owner_transfer.commit:success'),
      { status: 503, error: 'PRO_ROOM_AUDIT_UNAVAILABLE' },
      ['success'],
    ],
    [
      'saga complete',
      sagaWrite('complete'),
      { status: 503, error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' },
      // The request already wrote its success audit; the cron writes another.
      ['success', 'success'],
    ],
  ];

  it.each(crashes)(
    'converges after the request stops at the %s step',
    async (_name, fault, response, audits) => {
      const test = await transferFixture();
      const claim = await issueClaim(test);
      test.failOnce(fault);
      expect(await requestTransfer(test, claim)).toEqual({ ...response, cookies: [] });
      expect(test.saga()).not.toBe('complete');

      vi.setSystemTime(START + 60_000);
      expect(await test.cron()).toBe(1);
      await expectTransferred(test);
      // Audit rows are not transfer-scoped: a cron finishing after a request
      // that already audited success writes a second success row (RO-09;
      // plan step C7-10, transfer-scoped dedupe preferred).
      expect(test.commitAudits()).toEqual(audits);
      expect(await test.cron(START + 120_000)).toBe(0);
    },
  );
});

(nodeSqlite ? describe : describe.skip)('owner-transfer saga: target deleted mid-transfer', () => {
  // Known gap (audit timing), pinned by the two request tests below: the
  // request writes its deleted-target audit AFTER the terminal 'target_deleted'
  // advance, while every cron site audits BEFORE it. A terminal row leaves the
  // cron listing, so if the request's audit insert fails it answers 503
  // PRO_ROOM_AUDIT_UNAVAILABLE and no executor ever writes that row: the
  // request's audit is at-most-once, the cron's at-least-once. Plan step C7-8
  // (shared terminator helper) must keep this order; C7-9 (roadmap Phase 1
  // app B, "audit before terminal advance", owner decision D3) moves the audit
  // ahead of the advance. Update these pins then.
  it('request, after the DO commit (today): purges, finalizes, terminalizes, and only then audits target_deleted_after_commit', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    test.deleteTargetBefore(sagaWrite('committed'));
    const mark = test.mark();
    expect(await requestTransfer(test, claim)).toEqual({
      status: 409,
      error: 'OWNER_TRANSFER_TARGET_UNAVAILABLE',
      cookies: [],
    });
    const tail = test.steps(mark);
    expect(tail.slice(tail.indexOf('saga:committed'))).toEqual([
      'saga:committed',
      ...PURGE,
      'entitlement:finalize',
      'saga:target_deleted',
      'audit:owner_transfer.commit:target_deleted_after_commit',
    ]);
    expect(test.signalingCalls).toContain('/internal/admin/v1/owner-account-deleted');
    // The deletion fence relabels the transfer fence; keys stay revoked.
    expect(test.fence()).toEqual({ status: 'active', reason: 'owner_account_deleted' });
    expect(test.keyStatus()).toBe('revoked');
    expect(await test.canonical()).toMatchObject({
      status: 'suspended',
      suspensionReason: 'owner_account_deleted',
    });
  });

  // Same audit-after-terminal gap as above (C7-9 flips it).
  it('request, at the final recheck (today): same sequence, audited target_deleted_during_finalize after the terminal advance', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    test.deleteTargetBefore(sagaWrite('old_owner_edge_retired'));
    const mark = test.mark();
    expect(await requestTransfer(test, claim)).toEqual({
      status: 409,
      error: 'OWNER_TRANSFER_TARGET_UNAVAILABLE',
      cookies: [],
    });
    const tail = test.steps(mark);
    expect(tail.slice(tail.indexOf('saga:old_owner_edge_retired'))).toEqual([
      'saga:old_owner_edge_retired',
      ...PURGE,
      'entitlement:finalize',
      'saga:target_deleted',
      'audit:owner_transfer.commit:target_deleted_during_finalize',
    ]);
    expect(test.saga()).toBe('target_deleted');
    expect(test.fence()).toEqual({ status: 'active', reason: 'owner_account_deleted' });
  });

  it('request: a deletion purge between "verified" and the fence clear keeps the deletion fence', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    const stall = test.pauseOnce(stepIs('fence:clear'));
    const request = requestTransfer(test, claim);
    await stall.reached;
    // The new owner's account deletion purges while the request waits on D1.
    test.deleteTarget();
    expect(
      await purgeProRoomAccountAuthorityForTests(
        { accountId: TARGET, roomCode: ROOM_CODE, roomGeneration: ROOM_GENERATION },
        test.appEnv,
      ),
    ).toBe(true);
    expect(test.fence()).toEqual({ status: 'active', reason: 'owner_account_deleted' });

    // The transfer clears only its own digest, so the deletion fence stays
    // active (deletion suspends; account-auth-operations.md). The request
    // reports the clear as unavailable and leaves the row at "verified".
    stall.release();
    expect(await request).toEqual({
      status: 503,
      error: 'DEVELOPER_API_ADMIN_UNAVAILABLE',
      cookies: [],
    });
    expect(test.fence()).toEqual({ status: 'active', reason: 'owner_account_deleted' });
    expect(test.keyStatus()).toBe('revoked');
    expect(test.saga()).toBe('verified');
    expect(test.commitAudits()).toEqual(['reconcile_required']);

    // The cron finds the room suspended for the deleted owner and terminates.
    vi.setSystemTime(START + 60_000);
    const mark = test.mark();
    expect(await test.cron()).toBe(1);
    expect(test.steps(mark)).toEqual([
      'audit:owner_transfer.commit:target_deleted_during_reconcile',
      'entitlement:finalize',
      'saga:target_deleted',
    ]);
    expect(test.fence()).toEqual({ status: 'active', reason: 'owner_account_deleted' });
    expect(test.commitAudits()).toEqual(['reconcile_required', 'target_deleted_during_reconcile']);
  });

  it('cron: a deletion still pending at its status read blocks adoption; the row only rotates', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    test.failOnce(sagaWrite('committed'));
    expect((await requestTransfer(test, claim)).status).toBe(503);
    const before = test.admin.rows<{ updated_at: number }>(
      'SELECT updated_at FROM mxqr_pro_room_owner_transfer_sagas',
    )[0]!.updated_at;
    // The account row is still active while its deletion runs; the DO answers
    // every admin status read with 503 ACCOUNT_AUTHORITY_UNAVAILABLE.
    test.deleteTarget();

    vi.setSystemTime(START + 60_000);
    const mark = test.mark();
    expect(await test.cron()).toBe(0);
    expect(test.steps(mark)).toEqual([]);
    expect(test.saga()).toBe('prepared');
    expect(
      test.admin.rows<{ updated_at: number }>(
        'SELECT updated_at FROM mxqr_pro_room_owner_transfer_sagas',
      )[0]!.updated_at,
    ).toBe(START + 60_000);
    expect(before).toBe(START);
  });

  it('cron, after the deletion job purged the room: audits and finalizes without a second purge', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    test.failOnce(sagaWrite('registry_active'));
    expect((await requestTransfer(test, claim)).status).toBe(503);
    expect(test.saga()).toBe('committed');
    // The account-deletion job runs first: it purges the new owner's authority,
    // which also drops the DO's completed-transfer record.
    test.deleteTarget();
    expect(
      await purgeProRoomAccountAuthorityForTests(
        { accountId: TARGET, roomCode: ROOM_CODE, roomGeneration: ROOM_GENERATION },
        test.appEnv,
      ),
    ).toBe(true);
    expect(await test.canonical()).toMatchObject({
      status: 'suspended',
      suspensionReason: 'owner_account_deleted',
      reconciliation: null,
    });
    const purges = test.signalingCalls.length;

    vi.setSystemTime(START + 60_000);
    const mark = test.mark();
    expect(await test.cron()).toBe(1);
    expect(test.steps(mark)).toEqual([
      'audit:owner_transfer.commit:target_deleted_during_reconcile',
      'entitlement:finalize',
      'saga:target_deleted',
    ]);
    expect(test.signalingCalls).toHaveLength(purges);
    // No executor clears a transfer fence once a deletion relabelled it.
    expect(test.fence()).toEqual({ status: 'active', reason: 'owner_account_deleted' });
    expect(test.keyStatus()).toBe('revoked');
  });

  it('cron, right after adopting the commit: purges, audits, then finalizes', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    test.failOnce(sagaWrite('committed'));
    expect((await requestTransfer(test, claim)).status).toBe(503);
    // Deletion starts after the cron's status read, as the cron adopts.
    test.deleteTargetBefore(sagaWrite('committed'));

    vi.setSystemTime(START + 60_000);
    const mark = test.mark();
    expect(await test.cron()).toBe(1);
    expect(test.steps(mark)).toEqual([
      'saga:committed',
      ...PURGE,
      'audit:owner_transfer.commit:target_deleted_during_reconcile',
      'entitlement:finalize',
      'saga:target_deleted',
    ]);
    expect(test.fence()).toEqual({ status: 'active', reason: 'owner_account_deleted' });
  });

  it('cron, at its final recheck: purges and finalizes but writes no audit row', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    test.failOnce(sagaWrite('committed'));
    expect((await requestTransfer(test, claim)).status).toBe(503);
    test.deleteTargetBefore(sagaWrite('old_owner_edge_retired'));

    vi.setSystemTime(START + 60_000);
    const mark = test.mark();
    expect(await test.cron()).toBe(1);
    const tail = test.steps(mark);
    // Known gap: this cron branch has no target_deleted audit, unlike the
    // other four sites. Plan step C7-9 (single post-commit executor) adds
    // 'target_deleted_during_reconcile' here; flip this pin then.
    expect(tail.slice(tail.indexOf('saga:old_owner_edge_retired'))).toEqual([
      'saga:old_owner_edge_retired',
      ...PURGE,
      'entitlement:finalize',
      'saga:target_deleted',
    ]);
    expect(test.commitAudits()).toEqual([]);
    expect(test.fence()).toEqual({ status: 'active', reason: 'owner_account_deleted' });
  });
});

(nodeSqlite ? describe : describe.skip)('owner-transfer saga: request and cron on one row', () => {
  it('lets a stalled request finish after the cron completed its tail, writing a second success audit', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    // The request stalls on D1 right after the DO commit and 'committed'.
    const stall = test.pauseOnce(sagaWrite('registry_active'));
    const request = requestTransfer(test, claim);
    await stall.reached;

    vi.setSystemTime(START + 60_000);
    const cronMark = test.mark();
    expect(await test.cron()).toBe(1);
    expect(test.steps(cronMark)).toEqual(CRON_TAIL);
    expect(test.saga()).toBe('complete');

    const requestMark = test.mark();
    stall.release();
    // Every ranked advance of the old request reports success against the
    // completed row, the fence clear is idempotent, and its success audit is
    // written again (RO-09 inference reproduced; plan step C7-10).
    expect(await request).toEqual({
      status: 200,
      error: null,
      cookies: ['__Secure-mxqr_pro_session_000417', '__Secure-mxqr_pro_owner_000417'],
    });
    expect(test.steps(requestMark)).toEqual(REQUEST_TAIL.slice(2));
    await expectTransferred(test);
    expect(test.commitAudits()).toEqual(['success', 'success']);
  });

  it('refuses a new claim while the committed transfer is still inside its replay window', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    test.failOnce(sagaWrite('registry_active'));
    expect((await requestTransfer(test, claim)).status).toBe(503);
    const response = await test.internal('/internal/admin/owner-transfer-claim', {
      targetAccountId: OLD_OWNER,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'OWNER_TRANSFER_RECONCILIATION_REQUIRED' });
    expect(test.saga()).toBe('committed');
  });
});

/** Whichever comes first: the parked statement, or the request's answer. */
async function stalledOrAnswered(
  reached: Promise<void>,
  request: Promise<unknown>,
): Promise<unknown> {
  return Promise.race([reached.then(() => 'stalled'), request]);
}

/**
 * Fence-write policy per caller (plan step C7-11 moves these four callers of
 * revokeDeveloperApiKeysForAuthorityChange to a typed policy). Today the
 * account-deletion purge compares and swaps on the digest it captured before
 * asking the DO (null when no fence existed), while both transfer executors
 * and the legacy duplicate-owner detach write without a compare-and-swap
 * (`expectedFenceDigest` undefined). The difference shows only when the write
 * lands on an existing fence row with another digest, so each case below
 * starts from one. Mutation check on 8e647e2e: passing null at either transfer
 * site, or dropping the purge's expected digest, fails a case here.
 *
 * The legacy detach is not driven here: its first detach requires a DO with
 * no owner-authority removal and no transfer record, and every fence writer
 * leaves one of those behind for the rest of the incarnation (a completed
 * transfer record is never pruned), so today it only ever writes onto an
 * empty row or, on replay, its own digest. Its policy is unobservable through
 * the route; C7-11 keeps it at "any" with identical SQL.
 */
(nodeSqlite ? describe : describe.skip)('owner-transfer saga: fence-write policy by caller', () => {
  it('a transfer relabels an active deletion fence, a stale purge refuses, and the purge retry converges', async () => {
    const test = await transferFixture();
    test.deleteTarget(OLD_OWNER);
    // Two runs of the deletion job overlap. The first captures "no fence yet"
    // and stalls on D1 at its fence write; the duplicate finishes the purge.
    const stale = test.pauseOnce(stepIs('fence:owner_account_deleted'));
    const stalePurge = test.purge(OLD_OWNER);
    await stale.reached;
    expect(await test.purge(OLD_OWNER)).toBe(true);
    expect(test.fence()).toEqual({ status: 'active', reason: 'owner_account_deleted' });
    expect(test.keyStatus()).toBe('revoked');
    const deletionDigest = test.fenceDigest();
    expect(await test.canonical()).toMatchObject({
      status: 'suspended',
      suspensionReason: 'owner_account_deleted',
      owner: null,
    });

    // The ownerless room is handed to a new owner. The transfer's fence write
    // lands on the active deletion fence without a compare-and-swap: it
    // relabels reason and digest, and the key stays revoked.
    const claim = await issueClaim(test);
    const relabelled = test.pauseOnce(stepIs('fence:clear'));
    const mark = test.mark();
    const request = requestTransfer(test, claim);
    expect(await stalledOrAnswered(relabelled.reached, request)).toBe('stalled');
    expect(test.fence()).toEqual({ status: 'active', reason: 'ownership_transfer_pending' });
    expect(test.fenceDigest()).not.toBe(deletionDigest);
    expect(test.keyStatus()).toBe('revoked');
    relabelled.release();
    expect((await request).status).toBe(200);
    expect(test.steps(mark)).toContain('fence:ownership_transfer_pending');
    const transferDigest = test.fenceDigest();
    expect(test.fence()).toEqual({ status: 'cleared', reason: 'ownership_transfer_pending' });
    expect(await test.canonical()).toMatchObject({ status: 'active', owner: 'target' });

    // The stalled purge resumes. Its compare-and-swap against "no fence"
    // misses the newer transfer fence, so it writes nothing and reports false.
    stale.release();
    expect(await stalePurge).toBe(false);
    expect(test.fence()).toEqual({ status: 'cleared', reason: 'ownership_transfer_pending' });
    expect(test.fenceDigest()).toBe(transferDigest);

    // The deletion job's next retry finds the old owner no longer holds owner
    // authority: it converges without touching the fence.
    const retryMark = test.mark();
    expect(await test.purge(OLD_OWNER)).toBe(true);
    expect(test.steps(retryMark).filter((entry) => entry.startsWith('fence:'))).toEqual([]);
    expect(test.fenceDigest()).toBe(transferDigest);
    expect(await test.canonical()).toMatchObject({ status: 'active', owner: 'target' });
  });

  it('the cron, adopting a prepared transfer, relabels an active deletion fence the same way', async () => {
    const test = await transferFixture();
    test.deleteTarget(OLD_OWNER);
    expect(await test.purge(OLD_OWNER)).toBe(true);
    const deletionDigest = test.fenceDigest();
    const claim = await issueClaim(test);
    // The request stops at its own fence write; the DO keeps the PREPARE.
    test.failOnce(stepIs('fence:ownership_transfer_pending'));
    expect(await requestTransfer(test, claim)).toEqual({
      status: 503,
      error: 'DEVELOPER_API_ADMIN_UNAVAILABLE',
      cookies: [],
    });
    expect(test.saga()).toBe('prepared');
    expect(test.fence()).toEqual({ status: 'active', reason: 'owner_account_deleted' });

    vi.setSystemTime(START + 60_000);
    const mark = test.mark();
    expect(await test.cron()).toBe(1);
    // The adopted commit writes the transfer fence over the deletion fence
    // before the DO commits. The adopt branch and the shared tail each advance
    // 'committed' (the second is a compare-and-swap that changes no row).
    expect(test.steps(mark).slice(0, 4)).toEqual([
      'link:+target',
      'fence:ownership_transfer_pending',
      'saga:committed',
      'saga:committed',
    ]);
    expect(test.saga()).toBe('complete');
    expect(test.fenceDigest()).not.toBe(deletionDigest);
    expect(test.fence()).toEqual({ status: 'cleared', reason: 'ownership_transfer_pending' });
    expect(test.keyStatus()).toBe('revoked');
    expect(await test.canonical()).toMatchObject({ status: 'active', owner: 'target' });
  });
});
