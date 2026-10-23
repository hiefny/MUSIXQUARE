import { afterEach, beforeEach, expect, vi } from 'vitest';
import {
  ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
  ACCOUNT_ASSERTION_HEADER,
  createAccountAssertion,
} from '../../../../cloudflare/account-assertion.ts';
import {
  recordAccountProRoomLink,
  resetAccountAuthCachesForTests,
} from '../../../../cloudflare/account-auth.ts';
import appWorker, {
  purgeProRoomAccountAuthorityForTests,
  reconcileOwnerTransferSagasForTests,
} from '../../../../cloudflare/app-worker.ts';
import { issueProRoomActivationClaim } from '../../../../cloudflare/pro-room-claims.ts';
import proRoomWorker, { MusixquareProRoom } from '../../../../cloudflare/pro-room-worker.ts';
import {
  MemoryDurableObjectStorage,
  createSqlJournal,
  SqliteD1,
  type SqlEvent,
  trackedSql,
} from './worker-test-bindings.ts';

/**
 * Owner-transfer saga fixture (resource RO-09 in
 * docs/design/resource-ownership-registry.md) over all three D1 bindings,
 * shared by owner-transfer-saga-convergence-sqlite.test.ts and
 * developer-api-authority-fence-sqlite.test.ts.
 *
 * Everything the two saga executors touch is real: the App Worker, the PRO
 * front door and room Durable Object (in-process, as both the public PREPARE
 * route and the admin namespace), and three node:sqlite databases shared by
 * both Workers, as in production: admin metrics (saga, registry, issuance,
 * entitlements, audit), auth (accounts, sessions, deletions, account-room
 * edges) and Developer API (keys, authority fence). Each is loaded from its
 * tracked fresh-install schema file, which already carries the saga,
 * intent-admission, pro-grants and authority-fence migrations.
 * The only fake is signaling (a third Worker): it answers presence broadcasts
 * and installs the owner-account-deletion fence, as
 * `handleInternalOwnerAccountDeletedFence` does for a first install; its own
 * fence rules are covered in cloudflare-signaling-worker.test.ts. The claim
 * issuance row is seeded directly (see `issueClaim`), because the admin
 * console route that records it sits behind Cloudflare Access. A test may
 * replace one room's Durable Object with a stub (`stubAdminRoom`) for a room
 * the real objects cannot reach, such as a legacy duplicate owner's second
 * room.
 *
 * Crashes and races are injected at the D1 boundary (see worker-test-bindings):
 * a thrown statement models an unavailable database at that step, a parked
 * statement models a slow request that another executor overtakes. The
 * observed op log is the ordered list of executed D1 write statements,
 * classified into saga steps by `step`; a compare-and-swap that changed no
 * row still appears, because both executors issue it. Callers fake Date,
 * setTimeout and clearTimeout (see `useSagaClock`), so no request deadline can
 * expire on the wall clock while a statement is parked.
 */

export const ROOM_CODE = '000417';
export const ROOM_GENERATION = 0;
export const OLD_OWNER = 'acct_OldOwnerBoundary000001';
export const TARGET = 'acct_NewOwnerBoundary000002';
export const REQUEST_ID = 'saga_request_0000001';
const SECRET = (purpose: string) => `saga-${purpose}-secret-`.padEnd(48, 'x');
const SESSION_PEPPER = SECRET('session-pepper');
export const ASSERTION_SECRET = SECRET('assertion');
const ACTIVATION_SECRET = SECRET('activation');
export const START = Date.UTC(2026, 9, 22, 3, 0, 0);
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
export function step(event: SqlEvent): string | null {
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

export type Fault = (event: SqlEvent) => boolean;

/** Matches the nth (1-based) statement accepted by `predicate`. */
export function nth(count: number, predicate: Fault): Fault {
  let seen = 0;
  return (event) => predicate(event) && ++seen === count;
}

export const sagaWrite =
  (state: string): Fault =>
  (event) =>
    step(event) === `saga:${state}`;
export const stepIs =
  (name: string): Fault =>
  (event) =>
    step(event) === name;

export async function transferFixture() {
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
  const stubbedRooms = new Map<string, (request: Request) => Promise<Response>>();
  const roomNamespace = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: (request: Request) => {
        const stub = stubbedRooms.get(name);
        if (stub) return stub(request);
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
    /**
     * Replace the Durable Object of another room code (generation 0) with a
     * stub, for a room the real objects cannot reach.
     */
    stubAdminRoom(roomCode: string, fetch: (request: Request) => Promise<Response>) {
      stubbedRooms.set(`${roomCode}:generation:${ROOM_GENERATION}`, fetch);
    },
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

export type TransferFixture = Awaited<ReturnType<typeof transferFixture>>;

/** The old owner issues a claim; the admin console records its issuance row. */
export async function issueClaim(test: TransferFixture) {
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
export async function requestTransfer(test: TransferFixture, claimToken: string) {
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

/**
 * Registers the fixture clock for the calling test file: Date, setTimeout and
 * clearTimeout are faked at START, and every fixture closes after each test.
 */
export function useSagaClock() {
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
}
