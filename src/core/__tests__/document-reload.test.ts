import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetDocumentReloadForTests,
  capturePendingClaimReloadGuard,
  registerPendingClaimReloadPreparation,
  requestDocumentReload,
} from '../document-reload.ts';

type DocumentReloadAttempt = Parameters<Parameters<typeof requestDocumentReload>[0]>[0];

afterEach(() => __resetDocumentReloadForTests());

describe('pending-claim document reload coordinator', () => {
  it('restores only inside navigation and scrubs again on recovery', () => {
    const rollback = vi.fn();
    const prepare = vi.fn(() => rollback);
    registerPendingClaimReloadPreparation(prepare);
    let attempt: DocumentReloadAttempt | undefined;
    const navigate = vi.fn();

    requestDocumentReload((value) => {
      attempt = value;
    });
    expect(prepare).not.toHaveBeenCalled();
    attempt!.navigate(navigate);
    expect(prepare).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();

    attempt!.recover();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('defers a queued reload across an outcome-unknown mutation until lazy gate failure', async () => {
    const prepare = vi.fn(() => vi.fn());
    const guard = registerPendingClaimReloadPreparation(prepare);
    await guard.fenceOutcomeUnknownMutation();
    const start = vi.fn();

    requestDocumentReload(start);
    expect(start).not.toHaveBeenCalled();
    guard.restoreAfterLazyFeatureFailure();
    expect(start).toHaveBeenCalledOnce();
  });

  it('waits for an accepted reload to recover before entering a claim mutation', async () => {
    const guard = registerPendingClaimReloadPreparation(() => vi.fn());
    let attempt: DocumentReloadAttempt | undefined;
    requestDocumentReload((value) => {
      attempt = value;
    });
    let fenced = false;
    const fence = guard.fenceOutcomeUnknownMutation().then(() => {
      fenced = true;
    });

    await Promise.resolve();
    expect(fenced).toBe(false);
    attempt!.recover();
    await fence;
    expect(fenced).toBe(true);

    const queued = vi.fn();
    requestDocumentReload(queued);
    expect(queued).not.toHaveBeenCalled();
  });

  it('does not let a stale guard release its successor', () => {
    registerPendingClaimReloadPreparation(() => vi.fn());
    const stale = capturePendingClaimReloadGuard()!;
    const successorPrepare = vi.fn(() => vi.fn());
    registerPendingClaimReloadPreparation(successorPrepare);
    stale.release();
    let attempt: DocumentReloadAttempt | undefined;

    requestDocumentReload((value) => {
      attempt = value;
    });
    attempt!.navigate(vi.fn());
    expect(successorPrepare).toHaveBeenCalledOnce();
  });

  it('scrubs a prepared predecessor and releases its latch before flushing a successor reload', () => {
    const rollback = vi.fn();
    const guard = registerPendingClaimReloadPreparation(() => rollback);
    let first: DocumentReloadAttempt | undefined;
    let second: DocumentReloadAttempt | undefined;
    requestDocumentReload((attempt) => {
      first = attempt;
    });
    first!.navigate(vi.fn());
    requestDocumentReload((attempt) => {
      second = attempt;
    });

    guard.release();
    expect(rollback).toHaveBeenCalledOnce();
    expect(second).toBeUndefined();
    first!.recover();
    expect(second).toBeDefined();
    second!.navigate(vi.fn());
  });
});
