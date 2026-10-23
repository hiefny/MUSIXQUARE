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
 * Two executors drive one `mxqr_pro_room_owner_transfer_sagas` row: the
 * request executor (POST /api/pro-room/v1/rooms/:code/owner-transfer through
 * the real App Worker) and the minute cron's `reconcileOwnerTransferSagas`
 * (through its existing entry, `reconcileOwnerTransferSagasForTests`). The
 * fixture (helpers/owner-transfer-saga-fixture.ts) runs both against the real
 * App Worker, PRO room Durable Object and three node:sqlite databases, and
 * injects crashes and races at the D1 boundary. Tests pin today's behaviour,
 * including the divergent step order and the duplicate success audit, with
 * comments naming the owner decision or plan step (C7-8, C7-9, C7-10) that may
 * change them.
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

/**
 * The four deleted-target sites when one of their steps does not complete.
 * Plan step C7-8 replaces the four hand-written sequences with one terminator
 * whose options reproduce each site; these pins hold every site's order,
 * failure exits and audit placement, including the two known gaps that
 * owner decision D3 (plan step C7-9) changes later: the request's audit after
 * the terminal advance (lost when its insert fails) and the cron's final
 * recheck without any audit row.
 */
(nodeSqlite ? describe : describe.skip)('owner-transfer saga: deleted-target exits', () => {
  type Answer = { status: number; error: string };
  const reconcileRequired: Answer = {
    status: 503,
    error: 'PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED',
  };
  // [failing step, fault, steps from 'saga:committed', answer, saga state, commit audits]
  const requestExits: Array<[string, Fault, string[], Answer, string, string[]]> = [
    [
      'purge (its fence write)',
      stepIs('fence:owner_account_deleted'),
      ['saga:committed', 'audit:owner_transfer.commit:reconcile_required'],
      reconcileRequired,
      'committed',
      ['reconcile_required'],
    ],
    [
      'entitlement finalize',
      stepIs('entitlement:finalize'),
      ['saga:committed', ...PURGE, 'audit:owner_transfer.commit:reconcile_required'],
      reconcileRequired,
      'committed',
      ['reconcile_required'],
    ],
    [
      'terminal advance',
      sagaWrite('target_deleted'),
      [
        'saga:committed',
        ...PURGE,
        'entitlement:finalize',
        'audit:owner_transfer.commit:reconcile_required',
      ],
      reconcileRequired,
      'committed',
      ['reconcile_required'],
    ],
    [
      'audit insert',
      stepIs('audit:owner_transfer.commit:target_deleted_after_commit'),
      ['saga:committed', ...PURGE, 'entitlement:finalize', 'saga:target_deleted'],
      { status: 503, error: 'PRO_ROOM_AUDIT_UNAVAILABLE' },
      'target_deleted',
      [],
    ],
  ];

  it.each(requestExits)(
    'request: when the %s fails, audits the outcome after the fact and answers',
    async (_name, fault, steps, answer, state, audits) => {
      const test = await transferFixture();
      const claim = await issueClaim(test);
      test.deleteTargetBefore(sagaWrite('committed'));
      test.failOnce(fault);
      const mark = test.mark();
      expect(await requestTransfer(test, claim)).toEqual({ ...answer, cookies: [] });
      const tail = test.steps(mark);
      expect(tail.slice(tail.indexOf('saga:committed'))).toEqual(steps);
      expect(test.saga()).toBe(state);
      expect(test.commitAudits()).toEqual(audits);
      if (state === 'target_deleted') {
        // Terminal rows leave the cron listing: the lost audit is never
        // written (at-most-once; D3 moves the audit ahead of the advance).
        vi.setSystemTime(START + 60_000);
        expect(await test.cron()).toBe(0);
        expect(test.commitAudits()).toEqual([]);
      }
    },
  );

  /** Cron site right after it adopts the commit: purge, audit, finalize, advance. */
  async function adoptedCommitSite(test: TransferFixture) {
    const claim = await issueClaim(test);
    test.failOnce(sagaWrite('committed'));
    expect((await requestTransfer(test, claim)).status).toBe(503);
    test.deleteTargetBefore(sagaWrite('committed'));
  }

  /** Cron site after the deletion job purged the room: audit, finalize, advance. */
  async function purgedRoomSite(test: TransferFixture) {
    const claim = await issueClaim(test);
    test.failOnce(sagaWrite('registry_active'));
    expect((await requestTransfer(test, claim)).status).toBe(503);
    test.deleteTarget();
    expect(await test.purge(TARGET)).toBe(true);
  }

  /** Cron site at its final recheck: purge, finalize, advance, no audit. */
  async function finalRecheckSite(test: TransferFixture) {
    const claim = await issueClaim(test);
    test.failOnce(sagaWrite('committed'));
    expect((await requestTransfer(test, claim)).status).toBe(503);
    test.deleteTargetBefore(sagaWrite('old_owner_edge_retired'));
  }

  const TDR = 'audit:owner_transfer.commit:target_deleted_during_reconcile';
  // [site, failing step, setup, fault, steps of the failed sweep, commit audits it adds]
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
      'audit insert',
      adoptedCommitSite,
      stepIs(TDR),
      ['saga:committed', ...PURGE],
      [],
    ],
    [
      'after adopting the commit',
      'entitlement finalize',
      adoptedCommitSite,
      stepIs('entitlement:finalize'),
      ['saga:committed', ...PURGE, TDR],
      ['target_deleted_during_reconcile'],
    ],
    [
      'after adopting the commit',
      'terminal advance',
      adoptedCommitSite,
      sagaWrite('target_deleted'),
      ['saga:committed', ...PURGE, TDR, 'entitlement:finalize'],
      ['target_deleted_during_reconcile'],
    ],
    ['after the deletion purge', 'audit insert', purgedRoomSite, stepIs(TDR), [], []],
    [
      'after the deletion purge',
      'entitlement finalize',
      purgedRoomSite,
      stepIs('entitlement:finalize'),
      [TDR],
      ['target_deleted_during_reconcile'],
    ],
    [
      'after the deletion purge',
      'terminal advance',
      purgedRoomSite,
      sagaWrite('target_deleted'),
      [TDR, 'entitlement:finalize'],
      ['target_deleted_during_reconcile'],
    ],
    [
      'at the final recheck',
      'purge (its fence write)',
      finalRecheckSite,
      stepIs('fence:owner_account_deleted'),
      [
        'saga:committed',
        'registry:registered',
        'saga:registry_active',
        'link:-old',
        'saga:old_owner_edge_retired',
      ],
      [],
    ],
    [
      'at the final recheck',
      'entitlement finalize',
      finalRecheckSite,
      stepIs('entitlement:finalize'),
      [
        'saga:committed',
        'registry:registered',
        'saga:registry_active',
        'link:-old',
        'saga:old_owner_edge_retired',
        ...PURGE,
      ],
      [],
    ],
    [
      'at the final recheck',
      'terminal advance',
      finalRecheckSite,
      sagaWrite('target_deleted'),
      [
        'saga:committed',
        'registry:registered',
        'saga:registry_active',
        'link:-old',
        'saga:old_owner_edge_retired',
        ...PURGE,
        'entitlement:finalize',
      ],
      [],
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
    },
  );

  it('cron after the deletion purge: an audit written before a failed finalize is written again on the retry', async () => {
    const test = await transferFixture();
    await purgedRoomSite(test);
    // The request that stopped at 'registry_active' audited its own failure.
    expect(test.commitAudits()).toEqual(['reconcile_required']);
    test.failOnce(stepIs('entitlement:finalize'));
    vi.setSystemTime(START + 60_000);
    expect(await test.cron()).toBe(0);
    vi.setSystemTime(START + 120_000);
    const mark = test.mark();
    expect(await test.cron()).toBe(1);
    expect(test.steps(mark)).toEqual([TDR, 'entitlement:finalize', 'saga:target_deleted']);
    // Audit before finalize is at-least-once, so a retry duplicates it.
    expect(test.commitAudits()).toEqual([
      'reconcile_required',
      'target_deleted_during_reconcile',
      'target_deleted_during_reconcile',
    ]);
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
    // The saga state before each later admin statement: the forward-only
    // compare-and-swap in advanceOwnerTransferSagaState keeps the completed
    // row from moving back to the old request's earlier ranked states.
    const sagaStates = new Set<unknown>();
    test.journal.hooks.push((event) => {
      if (event.db === 'admin') sagaStates.add(test.saga());
    });
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
    expect([...sagaStates]).toEqual(['complete']);
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
 * the route; C7-11 keeps it at "any" with identical SQL. Every writer's SQL
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
