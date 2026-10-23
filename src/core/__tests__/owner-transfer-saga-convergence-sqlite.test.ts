import { describe, expect, it, vi } from 'vitest';
import { purgeProRoomAccountAuthorityForTests } from '../../../cloudflare/app-worker.ts';
import {
  type Fault,
  nth,
  OLD_OWNER,
  ROOM_CODE,
  ROOM_GENERATION,
  REQUEST_ID,
  requestTransfer,
  sagaWrite,
  START,
  step,
  stepIs,
  TARGET,
  type TransferFixture,
  issueClaim,
  transferFixture,
  useSagaClock,
} from './helpers/owner-transfer-saga-fixture.ts';
import { nodeSqlite } from './helpers/worker-test-bindings.ts';

/**
 * C7-0 characterization of the owner-transfer saga (resource RO-09 in
 * docs/design/resource-ownership-registry.md) over all three D1 bindings.
 *
 * Two entries drive one `mxqr_pro_room_owner_transfer_sagas` row: the
 * transfer request (POST /api/pro-room/v1/rooms/:code/owner-transfer through
 * the real App Worker) and the minute cron's `reconcileOwnerTransferSagas`
 * (through its existing entry, `reconcileOwnerTransferSagasForTests`). Since
 * plan step C7-9 both finish a committed transfer through one post-commit
 * executor, `finishCommittedOwnerTransfer`. The fixture
 * (helpers/owner-transfer-saga-fixture.ts) runs both against the real App
 * Worker, PRO room Durable Object and three node:sqlite databases, and
 * injects crashes and races at the D1 boundary. Pins that owner decision D3
 * (2026-10-23) changed in C7-9 say so: one step order (the entitlement is
 * finalized before "verified"), the closing audit row written before any
 * terminal advance, and that row deduplicated per transfer.
 */

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

/** The request's answer when its 'committed' write fails after the DO commit. */
const REGISTRY_UNAVAILABLE_ANSWER = { status: 503, error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' };

/**
 * The post-commit tail as the request writes it: the executor's one order
 * (owner decision D3: finalize, then "verified"), which the request already
 * followed before C7-9.
 */
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

/**
 * readActiveOwnerTransferTarget: the request reads it before the fence, after
 * the commit and at its final recheck.
 */
const TARGET_READ = /FROM mxqr_accounts AS account[\s\S]*mxqr_account_deletions/i;
/** readAdminProRoom, the registry row the final recheck compares. */
const REGISTRY_READ = /^\s*SELECT room_code, label, status, suspension_reason, activation_state/i;

/** The nth (1-based) read of the target account after the fault is registered. */
const targetRead = (count: number): Fault => nth(count, (event) => TARGET_READ.test(event.sql));

/** Runs `action` once, just before the first statement matching `fault`. */
function beforeOnce(test: TransferFixture, fault: Fault, action: () => unknown) {
  let fired = false;
  test.journal.hooks.push(async (event) => {
    if (!fired && fault(event)) {
      fired = true;
      await action();
    }
  });
}

/** Another executor (a decommission) ends the saga just before the `state` advance. */
function supersedeBefore(test: TransferFixture, state: string) {
  beforeOnce(test, sagaWrite(state), () =>
    test.admin.database
      .prepare(
        `UPDATE mxqr_pro_room_owner_transfer_sagas SET state = 'superseded' WHERE request_id = ?`,
      )
      .run(REQUEST_ID),
  );
}

/** An operator suspends the room in its Durable Object just before `fault`. */
function operatorSuspendBefore(test: TransferFixture, fault: Fault) {
  beforeOnce(test, fault, async () => {
    expect((await test.internal('/internal/admin/suspend', {})).status).toBe(200);
  });
}

/**
 * The registry read after the request's final target recheck answers with
 * the next incarnation, as if the room had been decommissioned and reused.
 * The registry triggers forbid that move in place, so the row is rewritten
 * on its way out of the D1 binding.
 */
function nextIncarnationAtFinalRecheck(test: TransferFixture) {
  let armed = false;
  beforeOnce(test, targetRead(3), () => {
    armed = true;
  });
  const prepare = test.admin.prepare.bind(test.admin);
  test.admin.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (!armed || !REGISTRY_READ.test(sql)) return statement;
    armed = false;
    return {
      bind: (...values: unknown[]) => {
        const bound = statement.bind(...values);
        return {
          first: async () => {
            const row = await bound.first<Record<string, unknown>>();
            return row && { ...row, room_generation: Number(row.room_generation) + 1 };
          },
        };
      },
    };
  }) as typeof test.admin.prepare;
}

/**
 * The tail as the minute cron writes it after adopting the row. Owner
 * decision D3 (C7-9): the same executor and order as the request. Before
 * C7-9 the cron advanced "verified" before it finalized the entitlement.
 */
const CRON_TAIL = REQUEST_TAIL;

useSagaClock();

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
  it('adopts a DO-committed transfer whose request stopped and finalizes the entitlement before "verified"', async () => {
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
    // Owner decision D3 (C7-9): the cron runs the request's executor and order,
    // finalizing the entitlement before "verified". Before C7-9 it marked
    // "verified" first.
    expect(test.steps(mark)).toEqual(CRON_TAIL);
    await expectTransferred(test);
    expect(test.commitAudits()).toEqual(['success']);
  });

  // One row per post-commit step: the D1 write that fails, the request's
  // answer, and the commit audit rows once the cron has converged. Plan step
  // C7-9 kept every (audit result, HTTP status) pair (see also the request
  // outcome table). Some failures audit 'reconcile_required' and some
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
      // The request already wrote its success audit. Owner decision D3
      // (C7-9): the cron's insert finds that row for this transfer and adds
      // none; before C7-9 it wrote a second one.
      ['success'],
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
      // The success row is transfer-scoped (owner decision D3, C7-9): a cron
      // finishing after a request that already audited success adds none.
      expect(test.commitAudits()).toEqual(audits);
      expect(await test.cron(START + 120_000)).toBe(0);
    },
  );
});

/**
 * The request's answer for every way its post-commit tail can stop while the
 * target account stays active (plan step C7-9 maps each stop through one
 * table). A step either throws (an unavailable dependency) or refuses (a
 * compare-and-swap miss after another executor ended the row, a 409 from the
 * Durable Object, a canonical state that is not active, a fence another writer
 * relabelled), and the final registry read can name another incarnation.
 * Each row pins the HTTP answer, the commit audit rows the request wrote and
 * the saga state it left. The deleted-target exits are the next table.
 *
 * Not driven: the old-owner edge retirement refusing (it answers false only
 * without an auth database or with an invalid identity, which the saga row
 * cannot hold); it answers like a throw.
 */
(nodeSqlite ? describe : describe.skip)('owner-transfer saga: request outcome table', () => {
  type Row = [
    step: string,
    kind: string,
    inject: (test: TransferFixture) => void,
    answer: { status: number; error: string },
    audits: string[],
    state: string,
  ];
  const REGISTRY_UNAVAILABLE = { status: 503, error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' };
  const RECONCILE = { status: 503, error: 'PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED' };
  const ACCOUNT_STORE = { status: 503, error: 'ACCOUNT_STORE_UNAVAILABLE' };
  const DEVELOPER_API = { status: 503, error: 'DEVELOPER_API_ADMIN_UNAVAILABLE' };
  const rows: Row[] = [
    [
      'target read after the commit',
      'threw',
      (test) => test.failOnce(targetRead(2)),
      ACCOUNT_STORE,
      ['reconcile_required'],
      'committed',
    ],
    [
      'registry projection',
      'refused',
      (test) => operatorSuspendBefore(test, targetRead(2)),
      { status: 409, error: 'PRO_ROOM_STATE_CONFLICT' },
      [],
      'committed',
    ],
    [
      'registry projection',
      'threw',
      (test) => test.failOnce(nth(1, stepIs('registry:registered'))),
      REGISTRY_UNAVAILABLE,
      ['reconcile_required'],
      'committed',
    ],
    [
      'saga registry_active',
      'refused',
      (test) => supersedeBefore(test, 'registry_active'),
      RECONCILE,
      [],
      'superseded',
    ],
    [
      'saga registry_active',
      'threw',
      (test) => test.failOnce(sagaWrite('registry_active')),
      REGISTRY_UNAVAILABLE,
      ['reconcile_required'],
      'committed',
    ],
    [
      'old-owner edge retirement',
      'threw',
      (test) => test.failOnce(stepIs('link:-old')),
      ACCOUNT_STORE,
      ['reconcile_required'],
      'registry_active',
    ],
    [
      'saga old_owner_edge_retired',
      'refused',
      (test) => supersedeBefore(test, 'old_owner_edge_retired'),
      RECONCILE,
      [],
      'superseded',
    ],
    [
      'saga old_owner_edge_retired',
      'threw',
      (test) => test.failOnce(sagaWrite('old_owner_edge_retired')),
      REGISTRY_UNAVAILABLE,
      [],
      'registry_active',
    ],
    [
      'final target read',
      'threw',
      (test) => test.failOnce(targetRead(3)),
      ACCOUNT_STORE,
      ['reconcile_required'],
      'old_owner_edge_retired',
    ],
    [
      'final registry read',
      'not found',
      nextIncarnationAtFinalRecheck,
      { status: 409, error: 'PRO_ROOM_GENERATION_MISMATCH' },
      [],
      'old_owner_edge_retired',
    ],
    [
      'final canonical projection',
      'threw',
      (test) => test.failOnce(nth(2, stepIs('registry:registered'))),
      REGISTRY_UNAVAILABLE,
      ['reconcile_required'],
      'old_owner_edge_retired',
    ],
    [
      'final canonical state',
      'refused',
      (test) => operatorSuspendBefore(test, targetRead(3)),
      RECONCILE,
      ['reconcile_required'],
      'old_owner_edge_retired',
    ],
    [
      'entitlement finalize',
      'refused',
      (test) => test.failOnce(stepIs('entitlement:finalize')),
      RECONCILE,
      ['entitlement_reconcile_required'],
      'old_owner_edge_retired',
    ],
    [
      'saga verified',
      'refused',
      (test) => supersedeBefore(test, 'verified'),
      RECONCILE,
      [],
      'superseded',
    ],
    [
      'saga verified',
      'threw',
      (test) => test.failOnce(sagaWrite('verified')),
      REGISTRY_UNAVAILABLE,
      [],
      'old_owner_edge_retired',
    ],
    [
      'fence clear',
      'refused',
      // A deletion purge relabelled the fence; the transfer clears only its own digest.
      (test) =>
        beforeOnce(test, stepIs('fence:clear'), () =>
          test.developer.database
            .prepare(
              `UPDATE mxqr_developer_api_room_authority_fences
                  SET fence_digest = ?, reason = 'owner_account_deleted'`,
            )
            .run('D'.repeat(43)),
        ),
      DEVELOPER_API,
      ['reconcile_required'],
      'verified',
    ],
    [
      'fence clear',
      'threw',
      (test) => test.failOnce(stepIs('fence:clear')),
      DEVELOPER_API,
      ['reconcile_required'],
      'verified',
    ],
    [
      // A failed insert of the row recording a stop does not change this
      // answer (unlike the deleted-target stops, in the next table).
      'fence clear',
      'threw, and so did its stop audit',
      (test) => {
        test.failOnce(stepIs('fence:clear'));
        test.failOnce(stepIs('audit:owner_transfer.commit:reconcile_required'));
      },
      DEVELOPER_API,
      [],
      'verified',
    ],
    [
      'success audit',
      'threw',
      (test) => test.failOnce(stepIs('audit:owner_transfer.commit:success')),
      { status: 503, error: 'PRO_ROOM_AUDIT_UNAVAILABLE' },
      [],
      'verified',
    ],
    [
      'saga complete',
      'refused',
      (test) => supersedeBefore(test, 'complete'),
      RECONCILE,
      ['success'],
      'superseded',
    ],
    [
      'saga complete',
      'threw',
      (test) => test.failOnce(sagaWrite('complete')),
      REGISTRY_UNAVAILABLE,
      ['success'],
      'verified',
    ],
  ];

  it.each(rows)(
    'when the %s step %s: answers, audits and leaves the row as pinned',
    async (_step, _kind, inject, answer, audits, state) => {
      const test = await transferFixture();
      const claim = await issueClaim(test);
      inject(test);
      expect(await requestTransfer(test, claim)).toEqual({ ...answer, cookies: [] });
      expect(test.commitAudits()).toEqual(audits);
      expect(test.saga()).toBe(state);
    },
  );
});

/**
 * The minute cron's own post-commit tail stopping at each step: the sweep
 * reports no progress and leaves the row where it stopped, and the next sweep
 * converges. The request stops right after the DO commit (its 'committed'
 * write fails), so the cron adopts a committed transfer and runs the tail.
 * Each row pins the saga state and entitlement after the failed sweep, which
 * shows the cron's step order, and the commit audit rows at the end.
 */
(nodeSqlite ? describe : describe.skip)('owner-transfer saga: cron tail crash matrix', () => {
  const RESERVED = { old: 'transfer_source_active', target: 'reserved' };
  const FINALIZED = { old: 'transferred', target: 'active' };
  type Row = [
    step: string,
    fault: Fault,
    afterFailedSweep: { state: string; entitlements: Record<string, string>; audits: string[] },
    finalAudits: string[],
  ];
  const rows: Row[] = [
    [
      'saga committed',
      sagaWrite('committed'),
      { state: 'prepared', entitlements: RESERVED, audits: [] },
      ['success'],
    ],
    [
      'target read after the commit',
      targetRead(1),
      { state: 'committed', entitlements: RESERVED, audits: [] },
      ['success'],
    ],
    [
      'registry projection',
      nth(1, stepIs('registry:registered')),
      { state: 'committed', entitlements: RESERVED, audits: [] },
      ['success'],
    ],
    [
      'saga registry_active',
      sagaWrite('registry_active'),
      { state: 'committed', entitlements: RESERVED, audits: [] },
      ['success'],
    ],
    [
      'old-owner edge retirement',
      stepIs('link:-old'),
      { state: 'registry_active', entitlements: RESERVED, audits: [] },
      ['success'],
    ],
    [
      'saga old_owner_edge_retired',
      sagaWrite('old_owner_edge_retired'),
      { state: 'registry_active', entitlements: RESERVED, audits: [] },
      ['success'],
    ],
    [
      'final target read',
      targetRead(2),
      { state: 'old_owner_edge_retired', entitlements: RESERVED, audits: [] },
      ['success'],
    ],
    [
      'final canonical projection',
      nth(2, stepIs('registry:registered')),
      { state: 'old_owner_edge_retired', entitlements: RESERVED, audits: [] },
      ['success'],
    ],
    [
      // Owner decision D3 (C7-9): the entitlement is finalized before
      // "verified", so a failed 'verified' write leaves it moved. Before C7-9
      // the cron wrote 'verified' first and left it reserved here.
      'saga verified',
      sagaWrite('verified'),
      { state: 'old_owner_edge_retired', entitlements: FINALIZED, audits: [] },
      ['success'],
    ],
    [
      // D3 (C7-9): a failed finalize no longer leaves the row at 'verified'.
      'entitlement finalize',
      stepIs('entitlement:finalize'),
      { state: 'old_owner_edge_retired', entitlements: RESERVED, audits: [] },
      ['success'],
    ],
    [
      'fence clear',
      stepIs('fence:clear'),
      { state: 'verified', entitlements: FINALIZED, audits: [] },
      ['success'],
    ],
    [
      'success audit',
      stepIs('audit:owner_transfer.commit:success'),
      { state: 'verified', entitlements: FINALIZED, audits: [] },
      ['success'],
    ],
    [
      'saga complete',
      sagaWrite('complete'),
      { state: 'verified', entitlements: FINALIZED, audits: ['success'] },
      // Owner decision D3 (C7-9): the retry's success insert finds the row
      // this transfer already wrote. Before C7-9 it wrote a second one.
      ['success'],
    ],
  ];

  it.each(rows)(
    'when the %s step fails, the next sweep converges',
    async (_step, fault, afterFailedSweep, finalAudits) => {
      const test = await transferFixture();
      const claim = await issueClaim(test);
      test.failOnce(sagaWrite('committed'));
      expect(await requestTransfer(test, claim)).toEqual({
        ...REGISTRY_UNAVAILABLE_ANSWER,
        cookies: [],
      });
      expect(test.saga()).toBe('prepared');

      test.failOnce(fault);
      vi.setSystemTime(START + 60_000);
      expect(await test.cron()).toBe(0);
      expect({
        state: test.saga(),
        entitlements: test.entitlements(),
        audits: test.commitAudits(),
      }).toEqual(afterFailedSweep);

      vi.setSystemTime(START + 120_000);
      expect(await test.cron()).toBe(1);
      await expectTransferred(test);
      expect(test.commitAudits()).toEqual(finalAudits);
      expect(await test.cron(START + 180_000)).toBe(0);
    },
  );
});

(nodeSqlite ? describe : describe.skip)('owner-transfer saga: target deleted mid-transfer', () => {
  // Owner decision D3 (C7-9): every site purges (unless the deletion job
  // already did), finalizes, writes its audit row and only then advances to
  // 'target_deleted'. A terminal row leaves the cron listing, so before C7-9
  // the request, which audited after the advance, lost the row for good when
  // that insert failed; the cron sites audited before the finalize, and the
  // cron's final recheck wrote no row at all.
  it('request, after the DO commit: purges, finalizes, audits target_deleted_after_commit, then terminalizes', async () => {
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
      // D3 (C7-9): the audit now precedes the terminal advance.
      'audit:owner_transfer.commit:target_deleted_after_commit',
      'saga:target_deleted',
    ]);
    expect(test.commitAudits()).toEqual(['target_deleted_after_commit']);
    expect(test.signalingCalls).toContain('/internal/admin/v1/owner-account-deleted');
    // The deletion fence relabels the transfer fence; keys stay revoked.
    expect(test.fence()).toEqual({ status: 'active', reason: 'owner_account_deleted' });
    expect(test.keyStatus()).toBe('revoked');
    expect(await test.canonical()).toMatchObject({
      status: 'suspended',
      suspensionReason: 'owner_account_deleted',
    });
  });

  it('request, at the final recheck: same sequence, audited target_deleted_during_finalize before the terminal advance', async () => {
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
      // D3 (C7-9): the audit now precedes the terminal advance.
      'audit:owner_transfer.commit:target_deleted_during_finalize',
      'saga:target_deleted',
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

    // The cron finds the room suspended for the deleted owner and terminates
    // (D3, C7-9: finalize, audit, then the terminal advance).
    vi.setSystemTime(START + 60_000);
    const mark = test.mark();
    expect(await test.cron()).toBe(1);
    expect(test.steps(mark)).toEqual([
      'entitlement:finalize',
      'audit:owner_transfer.commit:target_deleted_during_reconcile',
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

  it('cron, after the deletion job purged the room: finalizes and audits without a second purge', async () => {
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
    // D3 (C7-9): the audit moved from before the finalize to before the advance.
    expect(test.steps(mark)).toEqual([
      'entitlement:finalize',
      'audit:owner_transfer.commit:target_deleted_during_reconcile',
      'saga:target_deleted',
    ]);
    expect(test.signalingCalls).toHaveLength(purges);
    // No executor clears a transfer fence once a deletion relabelled it.
    expect(test.fence()).toEqual({ status: 'active', reason: 'owner_account_deleted' });
    expect(test.keyStatus()).toBe('revoked');
  });

  it('cron, right after adopting the commit: purges, finalizes, then audits', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    test.failOnce(sagaWrite('committed'));
    expect((await requestTransfer(test, claim)).status).toBe(503);
    // Deletion starts after the cron's status read, as the cron adopts.
    test.deleteTargetBefore(sagaWrite('committed'));

    vi.setSystemTime(START + 60_000);
    const mark = test.mark();
    expect(await test.cron()).toBe(1);
    // D3 (C7-9): the audit moved from before the finalize to before the advance.
    expect(test.steps(mark)).toEqual([
      'saga:committed',
      ...PURGE,
      'entitlement:finalize',
      'audit:owner_transfer.commit:target_deleted_during_reconcile',
      'saga:target_deleted',
    ]);
    expect(test.fence()).toEqual({ status: 'active', reason: 'owner_account_deleted' });
  });

  it('cron, at its final recheck: purges, finalizes and audits like the other sites', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    test.failOnce(sagaWrite('committed'));
    expect((await requestTransfer(test, claim)).status).toBe(503);
    test.deleteTargetBefore(sagaWrite('old_owner_edge_retired'));

    vi.setSystemTime(START + 60_000);
    const mark = test.mark();
    expect(await test.cron()).toBe(1);
    const tail = test.steps(mark);
    // Owner decision D3 (C7-9) added the audit this branch lacked: the
    // executor's final recheck ends like every other deleted-target site.
    expect(tail.slice(tail.indexOf('saga:old_owner_edge_retired'))).toEqual([
      'saga:old_owner_edge_retired',
      ...PURGE,
      'entitlement:finalize',
      'audit:owner_transfer.commit:target_deleted_during_reconcile',
      'saga:target_deleted',
    ]);
    expect(test.commitAudits()).toEqual(['target_deleted_during_reconcile']);
    expect(test.fence()).toEqual({ status: 'active', reason: 'owner_account_deleted' });
  });
});

/**
 * The deleted-target sites when one of their steps does not complete. Plan
 * step C7-8 named one terminator for the four hand-written sequences; plan
 * step C7-9 (owner decision D3) gave every site one order: purge (unless the
 * deletion job already did), finalize, the audit row, then the terminal
 * advance, with the audit row written once per transfer. Before C7-9 the
 * request audited after the advance (and lost the row when that insert
 * failed), the cron audited before the finalize (and repeated the row on
 * every retry), and the cron's final recheck wrote no row.
 */
(nodeSqlite ? describe : describe.skip)('owner-transfer saga: deleted-target exits', () => {
  type Answer = { status: number; error: string };
  const reconcileRequired: Answer = {
    status: 503,
    error: 'PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED',
  };
  const TDC = 'audit:owner_transfer.commit:target_deleted_after_commit';
  // [failing step, fault, steps from 'saga:committed', answer, saga state,
  //  commit audits after the request, commit audits once the cron converged]
  const requestExits: Array<
    [string, Fault | Fault[], string[], Answer, string, string[], string[]]
  > = [
    [
      'purge (its fence write)',
      stepIs('fence:owner_account_deleted'),
      ['saga:committed', 'audit:owner_transfer.commit:reconcile_required'],
      reconcileRequired,
      'committed',
      ['reconcile_required'],
      ['reconcile_required', 'target_deleted_during_reconcile'],
    ],
    [
      // A deleted-target stop's answer stands on its 'reconcile_required'
      // row: when that insert fails too, the request answers that the audit
      // is unavailable (unlike a stop on the main tail).
      'purge, and then its stop audit,',
      [
        stepIs('fence:owner_account_deleted'),
        stepIs('audit:owner_transfer.commit:reconcile_required'),
      ],
      ['saga:committed'],
      { status: 503, error: 'PRO_ROOM_AUDIT_UNAVAILABLE' },
      'committed',
      [],
      ['target_deleted_during_reconcile'],
    ],
    [
      'entitlement finalize',
      stepIs('entitlement:finalize'),
      ['saga:committed', ...PURGE, 'audit:owner_transfer.commit:reconcile_required'],
      reconcileRequired,
      'committed',
      ['reconcile_required'],
      ['reconcile_required', 'target_deleted_during_reconcile'],
    ],
    [
      // D3 (C7-9): the outcome row is written before the failed advance, so
      // it is not lost; the cron then records its own termination label.
      'terminal advance',
      sagaWrite('target_deleted'),
      [
        'saga:committed',
        ...PURGE,
        'entitlement:finalize',
        TDC,
        'audit:owner_transfer.commit:reconcile_required',
      ],
      reconcileRequired,
      'committed',
      ['target_deleted_after_commit', 'reconcile_required'],
      ['target_deleted_after_commit', 'reconcile_required', 'target_deleted_during_reconcile'],
    ],
    [
      // D3 (C7-9): the row is no longer terminal when the audit insert fails,
      // so the cron finishes it and writes the row. Before C7-9 the request
      // had already advanced to 'target_deleted' and the row was lost.
      'audit insert',
      stepIs(TDC),
      ['saga:committed', ...PURGE, 'entitlement:finalize'],
      { status: 503, error: 'PRO_ROOM_AUDIT_UNAVAILABLE' },
      'committed',
      [],
      ['target_deleted_during_reconcile'],
    ],
  ];

  it.each(requestExits)(
    'request: when the %s fails, answers and leaves the row for the cron',
    async (_name, faults, steps, answer, state, audits, convergedAudits) => {
      const test = await transferFixture();
      const claim = await issueClaim(test);
      test.deleteTargetBefore(sagaWrite('committed'));
      for (const fault of [faults].flat()) test.failOnce(fault);
      const mark = test.mark();
      expect(await requestTransfer(test, claim)).toEqual({ ...answer, cookies: [] });
      const tail = test.steps(mark);
      expect(tail.slice(tail.indexOf('saga:committed'))).toEqual(steps);
      expect(test.saga()).toBe(state);
      expect(test.commitAudits()).toEqual(audits);

      // Every exit leaves a nonterminal row the cron finishes, auditing it
      // before its own terminal advance.
      vi.setSystemTime(START + 60_000);
      expect(await test.cron()).toBe(1);
      expect(test.saga()).toBe('target_deleted');
      expect(test.commitAudits()).toEqual(convergedAudits);
      // Keys stay revoked whichever fence label holds. When the purge stopped
      // at its fence write, the DO had already removed the owner and dropped
      // the transfer record, so the cron takes its already-purged branch (no
      // second purge, as before C7-9) and the account-deletion job's own
      // retry relabels the fence and acknowledges the removal.
      expect(test.keyStatus()).toBe('revoked');
      expect(test.fence()).toEqual({
        status: 'active',
        reason: steps.includes(PURGE[0]!) ? 'owner_account_deleted' : 'ownership_transfer_pending',
      });
    },
  );

  /** Cron site right after it adopts the commit: purge, finalize, audit, advance. */
  async function adoptedCommitSite(test: TransferFixture) {
    const claim = await issueClaim(test);
    test.failOnce(sagaWrite('committed'));
    expect((await requestTransfer(test, claim)).status).toBe(503);
    test.deleteTargetBefore(sagaWrite('committed'));
  }

  /** Cron site after the deletion job purged the room: finalize, audit, advance. */
  async function purgedRoomSite(test: TransferFixture) {
    const claim = await issueClaim(test);
    test.failOnce(sagaWrite('registry_active'));
    expect((await requestTransfer(test, claim)).status).toBe(503);
    test.deleteTarget();
    expect(await test.purge(TARGET)).toBe(true);
  }

  /** Cron site at its final recheck: purge, finalize, audit, advance. */
  async function finalRecheckSite(test: TransferFixture) {
    const claim = await issueClaim(test);
    test.failOnce(sagaWrite('committed'));
    expect((await requestTransfer(test, claim)).status).toBe(503);
    test.deleteTargetBefore(sagaWrite('old_owner_edge_retired'));
  }

  const TDR = 'audit:owner_transfer.commit:target_deleted_during_reconcile';
  const FINAL_RECHECK_PREFIX = [
    'saga:committed',
    'registry:registered',
    'saga:registry_active',
    'link:-old',
    'saga:old_owner_edge_retired',
  ];
  // [site, failing step, setup, fault, steps of the failed sweep, commit audits it adds]
  // Owner decision D3 (C7-9) moved each cron site's audit from before the
  // finalize to just before the terminal advance (and added it at the final
  // recheck), so a failed finalize no longer leaves an audit row behind.
  const cronExits: Array<
    [string, string, (test: TransferFixture) => Promise<void>, Fault, string[], string[]]
  > = [
    [
      'after adopting the commit',
      'purge (its fence write)',
      adoptedCommitSite,
      stepIs('fence:owner_account_deleted'),
      ['saga:committed'],
      [],
    ],
    [
      'after adopting the commit',
      'entitlement finalize',
      adoptedCommitSite,
      stepIs('entitlement:finalize'),
      ['saga:committed', ...PURGE],
      [],
    ],
    [
      'after adopting the commit',
      'audit insert',
      adoptedCommitSite,
      stepIs(TDR),
      ['saga:committed', ...PURGE, 'entitlement:finalize'],
      [],
    ],
    [
      'after adopting the commit',
      'terminal advance',
      adoptedCommitSite,
      sagaWrite('target_deleted'),
      ['saga:committed', ...PURGE, 'entitlement:finalize', TDR],
      ['target_deleted_during_reconcile'],
    ],
    [
      'after the deletion purge',
      'entitlement finalize',
      purgedRoomSite,
      stepIs('entitlement:finalize'),
      [],
      [],
    ],
    [
      'after the deletion purge',
      'audit insert',
      purgedRoomSite,
      stepIs(TDR),
      ['entitlement:finalize'],
      [],
    ],
    [
      'after the deletion purge',
      'terminal advance',
      purgedRoomSite,
      sagaWrite('target_deleted'),
      ['entitlement:finalize', TDR],
      ['target_deleted_during_reconcile'],
    ],
    [
      'at the final recheck',
      'purge (its fence write)',
      finalRecheckSite,
      stepIs('fence:owner_account_deleted'),
      FINAL_RECHECK_PREFIX,
      [],
    ],
    [
      'at the final recheck',
      'entitlement finalize',
      finalRecheckSite,
      stepIs('entitlement:finalize'),
      [...FINAL_RECHECK_PREFIX, ...PURGE],
      [],
    ],
    [
      'at the final recheck',
      'audit insert',
      finalRecheckSite,
      stepIs(TDR),
      [...FINAL_RECHECK_PREFIX, ...PURGE, 'entitlement:finalize'],
      [],
    ],
    [
      'at the final recheck',
      'terminal advance',
      finalRecheckSite,
      sagaWrite('target_deleted'),
      [...FINAL_RECHECK_PREFIX, ...PURGE, 'entitlement:finalize', TDR],
      ['target_deleted_during_reconcile'],
    ],
  ];

  it.each(cronExits)(
    'cron %s: when the %s fails, stops before the terminal advance and leaves the row',
    async (_site, _name, setup, fault, steps, audits) => {
      const test = await transferFixture();
      await setup(test);
      const earlierAudits = test.commitAudits().length;
      test.failOnce(fault);
      vi.setSystemTime(START + 60_000);
      const mark = test.mark();
      expect(await test.cron()).toBe(0);
      expect(test.steps(mark)).toEqual(steps);
      // The row stays at the last state the sweep reached, for the next sweep.
      const reached = steps.filter((entry) => entry.startsWith('saga:')).at(-1);
      expect(test.saga()).toBe(reached?.slice('saga:'.length) ?? 'committed');
      expect(test.commitAudits().slice(earlierAudits)).toEqual(audits);

      // The next sweep converges with exactly one row for this transfer.
      vi.setSystemTime(START + 120_000);
      expect(await test.cron()).toBe(1);
      expect(test.saga()).toBe('target_deleted');
      expect(test.commitAudits().slice(earlierAudits)).toEqual(['target_deleted_during_reconcile']);
    },
  );

  it('cron after the deletion purge: a retry after a failed terminal advance writes the audit row once', async () => {
    const test = await transferFixture();
    await purgedRoomSite(test);
    // The request that stopped at 'registry_active' audited its own failure.
    expect(test.commitAudits()).toEqual(['reconcile_required']);
    test.failOnce(sagaWrite('target_deleted'));
    vi.setSystemTime(START + 60_000);
    expect(await test.cron()).toBe(0);
    expect(test.commitAudits()).toEqual(['reconcile_required', 'target_deleted_during_reconcile']);
    vi.setSystemTime(START + 120_000);
    const mark = test.mark();
    expect(await test.cron()).toBe(1);
    // The retry issues the insert again, and it finds this transfer's row.
    expect(test.steps(mark)).toEqual(['entitlement:finalize', TDR, 'saga:target_deleted']);
    // Owner decision D3 (C7-9): at least once and, with the transfer-scoped
    // check, once. Before C7-9 the audit came before the finalize and every
    // retry added another row.
    expect(test.commitAudits()).toEqual(['reconcile_required', 'target_deleted_during_reconcile']);
  });
});

/**
 * The owner-transfer entitlement identity both executors pass to
 * reserve/finalize/abort (plan step C7-8 names it once). The request passes no
 * time, so the entitlement module stamps its own clock; the cron passes its
 * sweep time. Writes are compared by their bound values.
 */
(nodeSqlite ? describe : describe.skip)('owner-transfer saga: entitlement identity', () => {
  const ENTITLEMENT_WRITE_RE = /^\s*UPDATE mxqr_pro_account_entitlements\b/i;

  /**
   * Bound values of the entitlement writes after the first write classified
   * as `after` (skipping the PRO room's own PREPARE reservation).
   */
  function entitlementBindings(test: TransferFixture, mark: number, after?: string) {
    const writes = test.journal.writes.slice(mark);
    const start = after === undefined ? 0 : writes.findIndex((event) => step(event) === after);
    expect(start).toBeGreaterThanOrEqual(0);
    return writes
      .slice(start)
      .filter((event) => ENTITLEMENT_WRITE_RE.test(event.sql))
      .map((event) => [...event.values]);
  }

  it('the request finalizes with its own clock', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    vi.setSystemTime(START + 1_000);
    const mark = test.mark();
    expect((await requestTransfer(test, claim)).status).toBe(200);
    // The finalize batch after the DO commit: source transferred, target
    // activated (its grant, allocation and redemption writes touch other tables).
    expect(entitlementBindings(test, mark, 'saga:committed')).toEqual([
      [TARGET, ROOM_CODE, ROOM_GENERATION, REQUEST_ID, START + 1_000],
      [TARGET, ROOM_CODE, ROOM_GENERATION, REQUEST_ID, START + 1_000],
    ]);
  });

  it('the cron finalizes with its sweep time, not the wall clock', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    test.failOnce(sagaWrite('committed'));
    expect((await requestTransfer(test, claim)).status).toBe(503);
    vi.setSystemTime(START + 60_000);
    const mark = test.mark();
    expect(await test.cron(START + 61_234)).toBe(1);
    expect(entitlementBindings(test, mark)).toEqual([
      [TARGET, ROOM_CODE, ROOM_GENERATION, REQUEST_ID, START + 61_234],
      [TARGET, ROOM_CODE, ROOM_GENERATION, REQUEST_ID, START + 61_234],
    ]);
  });

  it('the request releases the reservation with its own clock when the target is gone before the fence', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    // The target's deletion starts just before the request's first recheck
    // of the target account (after PREPARE, before the Developer API fence).
    let reads = 0;
    test.journal.hooks.push((event) => {
      if (/FROM mxqr_accounts AS account[\s\S]*mxqr_account_deletions/i.test(event.sql)) {
        reads += 1;
        if (reads === 1) test.deleteTarget();
      }
    });
    vi.setSystemTime(START + 2_000);
    const mark = test.mark();
    expect(await requestTransfer(test, claim)).toEqual({
      status: 409,
      error: 'OWNER_TRANSFER_TARGET_UNAVAILABLE',
      cookies: [],
    });
    expect(test.commitAudits()).toEqual(['denied_target_unavailable']);
    expect(test.steps(mark)).not.toContain('fence:ownership_transfer_pending');
    const bindings = entitlementBindings(test, mark, 'audit:owner_transfer.prepare:success');
    expect(bindings.length).toBeGreaterThan(0);
    for (const values of bindings) {
      expect(values).toEqual([TARGET, ROOM_CODE, ROOM_GENERATION, REQUEST_ID, START + 2_000]);
    }
  });

  it('the cron releases an expired pending reservation with its sweep time', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    // The request stops at its fence write; the DO keeps the PREPARE pending.
    test.failOnce(stepIs('fence:ownership_transfer_pending'));
    expect((await requestTransfer(test, claim)).status).toBe(503);
    const expiresAt = test.admin.rows<{ expires_at: number }>(
      'SELECT expires_at FROM mxqr_pro_room_owner_transfer_sagas',
    )[0]!.expires_at;
    vi.setSystemTime(expiresAt + 1_000);
    const mark = test.mark();
    expect(await test.cron(expiresAt + 1_234)).toBe(1);
    expect(test.saga()).toBe('expired');
    const bindings = entitlementBindings(test, mark);
    expect(bindings.length).toBeGreaterThan(0);
    for (const values of bindings) {
      expect(values).toEqual([TARGET, ROOM_CODE, ROOM_GENERATION, REQUEST_ID, expiresAt + 1_234]);
    }
  });
});

(nodeSqlite ? describe : describe.skip)('owner-transfer saga: request and cron on one row', () => {
  it('lets a stalled request finish after the cron completed its tail, with one success audit', async () => {
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
    // The saga state before each later admin statement: the forward-only
    // compare-and-swap in advanceOwnerTransferSagaState keeps the completed
    // row from moving back to the old request's earlier ranked states.
    const sagaStates = new Set<unknown>();
    test.journal.hooks.push((event) => {
      if (event.db === 'admin') sagaStates.add(test.saga());
    });
    stall.release();
    // Every ranked advance of the stalled request reports success against
    // the completed row and the fence clear is idempotent. Its success insert
    // still runs, and owner decision D3 (C7-9) makes it find the cron's row
    // for this transfer: one row, where before C7-9 there were two (the RO-09
    // overlap; an adoption lease, C7-10, was not needed).
    expect(await request).toEqual({
      status: 200,
      error: null,
      cookies: ['__Secure-mxqr_pro_session_000417', '__Secure-mxqr_pro_owner_000417'],
    });
    expect(test.steps(requestMark)).toEqual(REQUEST_TAIL.slice(2));
    expect([...sagaStates]).toEqual(['complete']);
    await expectTransferred(test);
    expect(test.commitAudits()).toEqual(['success']);
  });

  it('a replayed request after completion runs the tail again and adds no success audit', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    expect((await requestTransfer(test, claim)).status).toBe(200);
    expect(test.commitAudits()).toEqual(['success']);
    // The browser repeats the same request (same claim and request id) inside
    // the DO's completed-transfer replay window, for example after a lost
    // response. The DO replays the commit and the request runs its tail again.
    vi.setSystemTime(START + 5_000);
    const mark = test.mark();
    expect(await requestTransfer(test, claim)).toEqual({
      status: 200,
      error: null,
      cookies: ['__Secure-mxqr_pro_session_000417', '__Secure-mxqr_pro_owner_000417'],
    });
    expect(test.steps(mark)).toContain('audit:owner_transfer.commit:success');
    await expectTransferred(test);
    // Owner decision D3 (C7-9): the replay's insert finds this transfer's row.
    // Before C7-9 it wrote a second one.
    expect(test.commitAudits()).toEqual(['success']);
  });

  it('two transfers of one room incarnation each write their own success audit', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    expect((await requestTransfer(test, claim)).status).toBe(200);
    expect(test.commitAudits()).toEqual(['success']);
    // Past the first transfer's replay window, the new owner hands the room
    // back to the old owner: a second saga row on the same incarnation.
    vi.setSystemTime(START + 11 * 60_000);
    const backClaim = await issueClaim(test, OLD_OWNER);
    expect(
      await requestTransfer(test, backClaim, {
        accountId: OLD_OWNER,
        requestId: 'saga_request_0000002',
        newPin: '13572468',
      }),
    ).toEqual({
      status: 200,
      error: null,
      cookies: ['__Secure-mxqr_pro_session_000417', '__Secure-mxqr_pro_owner_000417'],
    });
    expect(test.saga('saga_request_0000002')).toBe('complete');
    expect(await test.canonical()).toMatchObject({ status: 'active', owner: 'old' });
    // The success row is deduplicated per transfer (since the saga's intent),
    // not per room incarnation, so the second transfer keeps its own row.
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
 * Fence-write policy per caller (the four callers of
 * revokeDeveloperApiKeysForAuthorityChange pass a typed AuthorityFenceWrite
 * since plan step C7-11). The account-deletion purge compares and swaps on the
 * digest it captured before asking the DO (null when no fence existed), while
 * both transfer executors and the legacy duplicate-owner detach write without
 * a compare-and-swap (`expected: 'any'`). The difference shows only when the
 * write lands on an existing fence row with another digest, so each case below
 * starts from one. Mutation check on 8e647e2e: passing null at either transfer
 * site, or dropping the purge's expected digest, fails a case here.
 *
 * The legacy detach is not driven here: its first detach requires a DO with
 * no owner-authority removal and no transfer record, and every fence writer
 * leaves one of those behind for the rest of the incarnation (a completed
 * transfer record is never pruned), so today it only ever writes onto an
 * empty row or, on replay, its own digest. Its policy is unobservable through
 * the route; C7-11 kept it at "any" with identical SQL. Every writer's SQL
 * text and bound values, the detach's included, are pinned in
 * developer-api-authority-fence-sqlite.test.ts.
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
