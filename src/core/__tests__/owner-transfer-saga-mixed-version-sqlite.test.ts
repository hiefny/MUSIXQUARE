import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type CronEntry,
  issueClaim,
  requestTransfer,
  sagaWrite,
  START,
  stepIs,
  transferFixture,
  type TransferFixture,
  useSagaClock,
} from './helpers/owner-transfer-saga-fixture.ts';
import {
  hasCommit,
  type LegacyAppWorker,
  loadLegacyAppWorker,
} from './helpers/legacy-app-worker.ts';
import { nodeSqlite } from './helpers/worker-test-bindings.ts';

/**
 * Mixed App Worker versions on one owner-transfer saga row (resource RO-09 in
 * docs/design/resource-ownership-registry.md).
 *
 * A Worker deploy does not drain requests: a transfer request still running
 * on the old version can meet the minute cron on the new one, and the
 * reverse, on the same D1 rows. Each case runs one executor from an earlier
 * commit (helpers/legacy-app-worker.ts builds the App Worker exactly as
 * committed there) and the other from the current source, on the real PRO
 * room Durable Object and node:sqlite D1
 * (helpers/owner-transfer-saga-fixture.ts).
 *
 * The first legacy builds are the App Worker in production before Phase 1
 * (Phase 0d, `86ccefe6`) and the Phase 1 App Worker A tree (C7-8 and C7-11,
 * `09ecb95b`). Their saga tails behave the same. Only their cron runs here:
 * a request through them carries the PIN the App of its time sent, which
 * those builds require, and since 2026-10-26 the PRO room refuses that body
 * before it changes anything, so their request no longer reaches a commit.
 * Delete these cases once no production App Worker older than plan step
 * C7-9 can run.
 *
 * The last block runs 9.0.14 (`dd9c9d4d`), the App Worker that shares rows
 * with the current one while release W of old-version removal train 2
 * deploys or recovers, in both directions.
 */

const LEGACY_BUILDS: Array<[label: string, sha: string]> = [
  ['Phase 0d (86ccefe6)', '86ccefe6e48dfac05afc159f5bc372037093a523'],
  ['Phase 1 App A (09ecb95b)', '09ecb95bafdd167cc3223e32bacb013d6d9b525c'],
];

const COMMITTED_COOKIES = ['__Secure-mxqr_pro_session_000417', '__Secure-mxqr_pro_owner_000417'];

useSagaClock();

/** The converged transfer, whichever executor finished it. */
async function expectTransferred(test: TransferFixture) {
  expect(test.saga()).toBe('complete');
  expect(test.entitlements()).toEqual({ old: 'transferred', target: 'active' });
  expect(test.fence()).toEqual({ status: 'cleared', reason: 'ownership_transfer_pending' });
  expect(test.links()).toEqual(['target']);
  expect(await test.canonical()).toMatchObject({ status: 'active', owner: 'target' });
}

/** The request stops right after the DO commit, leaving the cron a committed transfer. */
async function stopAfterCommit(test: TransferFixture) {
  const claim = await issueClaim(test);
  test.failOnce(sagaWrite('committed'));
  expect((await requestTransfer(test, claim)).status).toBe(503);
  expect(test.saga()).toBe('prepared');
}

describe.each(LEGACY_BUILDS)(
  'owner-transfer saga across App Worker versions: %s',
  (_label, sha) => {
    const available = nodeSqlite !== null && hasCommit(sha);
    const run = available ? it : it.skip;
    let legacy: LegacyAppWorker;
    let legacyCron: CronEntry;

    beforeAll(async () => {
      if (!available) return;
      legacy = await loadLegacyAppWorker(sha);
      legacyCron = legacy.cron;
    }, 60_000);

    run('a new request stalled after the commit, overtaken by the old cron', async () => {
      const test = await transferFixture();
      const claim = await issueClaim(test);
      const stall = test.pauseOnce(sagaWrite('registry_active'));
      const request = requestTransfer(test, claim);
      await stall.reached;

      vi.setSystemTime(START + 60_000);
      expect(await test.cron(Date.now(), legacyCron)).toBe(1);
      expect(test.saga()).toBe('complete');

      stall.release();
      expect(await request).toEqual({ status: 200, error: null, cookies: COMMITTED_COOKIES });
      await expectTransferred(test);
      // Owner decision D3 (C7-9): the new request's success insert finds the
      // old cron's row for this transfer and adds none.
      expect(test.commitAudits()).toEqual(['success']);
    });

    run('a new request stalled after its success audit, finished by the old cron', async () => {
      const test = await transferFixture();
      const claim = await issueClaim(test);
      const stall = test.pauseOnce(sagaWrite('complete'));
      const request = requestTransfer(test, claim);
      await stall.reached;
      expect(test.commitAudits()).toEqual(['success']);

      vi.setSystemTime(START + 60_000);
      expect(await test.cron(Date.now(), legacyCron)).toBe(1);

      stall.release();
      expect(await request).toEqual({ status: 200, error: null, cookies: COMMITTED_COOKIES });
      await expectTransferred(test);
      // The old cron writes its success row without any check.
      expect(test.commitAudits()).toEqual(['success', 'success']);
    });

    run(
      'a row the old cron left at "verified" before finalizing, finished by the new cron',
      async () => {
        const test = await transferFixture();
        await stopAfterCommit(test);
        test.failOnce(stepIs('entitlement:finalize'));
        vi.setSystemTime(START + 60_000);
        expect(await test.cron(Date.now(), legacyCron)).toBe(0);
        // The old order marks "verified" before the entitlement moves.
        expect(test.saga()).toBe('verified');
        expect(test.entitlements()).toEqual({ old: 'transfer_source_active', target: 'reserved' });

        vi.setSystemTime(START + 120_000);
        expect(await test.cron()).toBe(1);
        await expectTransferred(test);
        expect(test.commitAudits()).toEqual(['success']);
      },
    );

    run('a row the new cron left before "verified", finished by the old cron', async () => {
      const test = await transferFixture();
      await stopAfterCommit(test);
      test.failOnce(sagaWrite('verified'));
      vi.setSystemTime(START + 60_000);
      expect(await test.cron()).toBe(0);
      expect(test.saga()).toBe('old_owner_edge_retired');
      // D3 (C7-9): the new order moved the entitlement before 'verified'; the
      // old cron's own finalize later is a no-op.
      expect(test.entitlements()).toEqual({ old: 'transferred', target: 'active' });

      vi.setSystemTime(START + 120_000);
      expect(await test.cron(Date.now(), legacyCron)).toBe(1);
      await expectTransferred(test);
      expect(test.commitAudits()).toEqual(['success']);
    });

    run('a new request ending a deleted target meets the old cron', async () => {
      const test = await transferFixture();
      const claim = await issueClaim(test);
      test.deleteTargetBefore(sagaWrite('committed'));
      const stall = test.pauseOnce(sagaWrite('target_deleted'));
      const request = requestTransfer(test, claim);
      await stall.reached;
      // D3 (C7-9): the new request writes its row before its terminal advance.
      expect(test.commitAudits()).toEqual(['target_deleted_after_commit']);

      vi.setSystemTime(START + 60_000);
      expect(await test.cron(Date.now(), legacyCron)).toBe(1);
      expect(test.saga()).toBe('target_deleted');

      stall.release();
      expect(await request).toEqual({
        status: 409,
        error: 'OWNER_TRANSFER_TARGET_UNAVAILABLE',
        cookies: [],
      });
      expect(test.saga()).toBe('target_deleted');
      // The old cron records its own label without any check.
      expect(test.commitAudits()).toEqual([
        'target_deleted_after_commit',
        'target_deleted_during_reconcile',
      ]);
      expect(test.fence()).toEqual({ status: 'active', reason: 'owner_account_deleted' });
    });
  },
);

/**
 * The App Worker in production before release W of old-version removal
 * train 2: 9.0.14, `dd9c9d4d`, every Worker's rollback checkpoint for that
 * release. During its deploy and automatic recovery this build and the
 * current one share saga rows. Its saga tails are already the C7-9 executor;
 * release W changed only the facade (the opt-in headers no longer reach the
 * commit, and a `newPin` body is refused before the intent). So both
 * directions keep one success row for an overlap (owner decision D3). Delete
 * this block once neither the production App Worker nor its rollback
 * checkpoint is older than release W.
 */
const PRE_RELEASE_W_BUILD = 'dd9c9d4d6493c50c86a7fc0240ae4ccf2b16cd99';

describe('owner-transfer saga across App Worker versions: 9.0.14 before release W (dd9c9d4d)', () => {
  const available = nodeSqlite !== null && hasCommit(PRE_RELEASE_W_BUILD);
  const run = available ? it : it.skip;
  let previous: LegacyAppWorker;
  // The 9.0.14 App sends both opt-in headers with every PRO request.
  const appHeaders = { entryPolicy: true };

  beforeAll(async () => {
    if (!available) return;
    previous = await loadLegacyAppWorker(PRE_RELEASE_W_BUILD);
  }, 60_000);

  run('an old request stalled after the commit, overtaken by the new cron', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    const stall = test.pauseOnce(sagaWrite('registry_active'));
    const request = requestTransfer(test, claim, { ...appHeaders, worker: previous.worker });
    await stall.reached;

    vi.setSystemTime(START + 60_000);
    expect(await test.cron()).toBe(1);
    expect(test.saga()).toBe('complete');
    expect(test.commitAudits()).toEqual(['success']);

    stall.release();
    expect(await request).toEqual({ status: 200, error: null, cookies: COMMITTED_COOKIES });
    await expectTransferred(test);
    // D3 (C7-9): the old request's success insert finds the new cron's row.
    expect(test.commitAudits()).toEqual(['success']);
  });

  run('a new request stalled after the commit, overtaken by the old cron', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    const stall = test.pauseOnce(sagaWrite('registry_active'));
    const request = requestTransfer(test, claim, appHeaders);
    await stall.reached;

    vi.setSystemTime(START + 60_000);
    expect(await test.cron(Date.now(), previous.cron)).toBe(1);
    expect(test.saga()).toBe('complete');

    stall.release();
    expect(await request).toEqual({ status: 200, error: null, cookies: COMMITTED_COOKIES });
    await expectTransferred(test);
    expect(test.commitAudits()).toEqual(['success']);
  });

  run('an old request stalled after its success audit, finished by the new cron', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    const stall = test.pauseOnce(sagaWrite('complete'));
    const request = requestTransfer(test, claim, { ...appHeaders, worker: previous.worker });
    await stall.reached;
    expect(test.saga()).toBe('verified');
    expect(test.commitAudits()).toEqual(['success']);

    vi.setSystemTime(START + 60_000);
    expect(await test.cron()).toBe(1);
    expect(test.saga()).toBe('complete');

    stall.release();
    expect(await request).toEqual({ status: 200, error: null, cookies: COMMITTED_COOKIES });
    await expectTransferred(test);
    // D3 (C7-9): the new cron's success insert finds the old request's row.
    expect(test.commitAudits()).toEqual(['success']);
  });

  run('an old request ending a deleted target meets the new cron', async () => {
    const test = await transferFixture();
    const claim = await issueClaim(test);
    test.deleteTargetBefore(sagaWrite('committed'));
    const stall = test.pauseOnce(sagaWrite('target_deleted'));
    const request = requestTransfer(test, claim, { ...appHeaders, worker: previous.worker });
    await stall.reached;
    // D3 (C7-9): the old request writes its row before its terminal advance.
    expect(test.commitAudits()).toEqual(['target_deleted_after_commit']);

    vi.setSystemTime(START + 60_000);
    expect(await test.cron()).toBe(1);
    expect(test.saga()).toBe('target_deleted');

    stall.release();
    expect(await request).toEqual({
      status: 409,
      error: 'OWNER_TRANSFER_TARGET_UNAVAILABLE',
      cookies: [],
    });
    expect(test.saga()).toBe('target_deleted');
    expect(test.commitAudits()).toEqual([
      'target_deleted_after_commit',
      'target_deleted_during_reconcile',
    ]);
    expect(test.fence()).toEqual({ status: 'active', reason: 'owner_account_deleted' });
  });
});
