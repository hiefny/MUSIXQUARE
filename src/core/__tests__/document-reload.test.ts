/**
 * @vitest-environment jsdom
 *
 * The PRO claim fence (core/document-reload.ts) at the navigation owner's
 * boundary: scheduleDocumentReload with a recorded location.reload. Since
 * C6-5 the owner (core/session-reset.ts) runs every reload and its queue; the
 * fence decides when a reload may start and restores the claim for the sink.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  capturePendingClaimReloadGuard,
  registerPendingClaimReloadPreparation,
} from '../document-reload.ts';
import { NAVIGATION_COMMIT_TIMEOUT_MS, RESET_PAINT_FALLBACK_MS } from '../navigation-contract.ts';
import {
  __resetPageNavigationForTests,
  isSessionResetPending,
  scheduleDocumentReload,
} from '../session-reset.ts';
import { stubNavigationSinks, type NavigationSinks } from './__helpers__/navigation-sinks.ts';

const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(
  window,
  'requestAnimationFrame',
);
let sinks: NavigationSinks;

beforeEach(() => {
  vi.useFakeTimers();
  // Frames suspended: the reset runs its action on the paint fallback.
  Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: undefined });
  sinks = stubNavigationSinks();
});

afterEach(() => {
  __resetPageNavigationForTests();
  vi.unstubAllGlobals();
  if (originalRequestAnimationFrame) {
    Object.defineProperty(window, 'requestAnimationFrame', originalRequestAnimationFrame);
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('pending-claim reload fence', () => {
  it('restores only inside navigation and scrubs again on recovery', () => {
    const rollback = vi.fn();
    const prepare = vi.fn(() => rollback);
    registerPendingClaimReloadPreparation(prepare);

    scheduleDocumentReload('Reload');
    expect(prepare).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RESET_PAINT_FALLBACK_MS);
    expect(prepare).toHaveBeenCalledOnce();
    expect(sinks.reload).toHaveBeenCalledOnce();
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
      sinks.reload.mock.invocationCallOrder[0] ?? 0,
    );
    expect(rollback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(NAVIGATION_COMMIT_TIMEOUT_MS);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('defers a queued reload across an outcome-unknown mutation until lazy gate failure', async () => {
    const prepare = vi.fn(() => vi.fn());
    const guard = registerPendingClaimReloadPreparation(prepare);
    await guard.fenceOutcomeUnknownMutation();

    scheduleDocumentReload('Fenced reload');
    expect(isSessionResetPending()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(sinks.reload).not.toHaveBeenCalled();

    guard.restoreAfterLazyFeatureFailure();
    expect(isSessionResetPending()).toBe(true);
    vi.advanceTimersByTime(RESET_PAINT_FALLBACK_MS);
    expect(sinks.reload).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('waits for an accepted reload to recover before entering a claim mutation', async () => {
    const guard = registerPendingClaimReloadPreparation(() => vi.fn());
    scheduleDocumentReload('Reload');
    vi.advanceTimersByTime(RESET_PAINT_FALLBACK_MS);
    let fenced = false;
    const fence = guard.fenceOutcomeUnknownMutation().then(() => {
      fenced = true;
    });

    await Promise.resolve();
    expect(fenced).toBe(false);
    vi.advanceTimersByTime(NAVIGATION_COMMIT_TIMEOUT_MS);
    await fence;
    expect(fenced).toBe(true);

    scheduleDocumentReload('Queued reload');
    vi.advanceTimersByTime(10_000);
    expect(isSessionResetPending()).toBe(false);
    expect(sinks.reload).toHaveBeenCalledOnce();
  });

  it('does not let a stale guard release its successor', () => {
    registerPendingClaimReloadPreparation(() => vi.fn());
    const stale = capturePendingClaimReloadGuard()!;
    const successorPrepare = vi.fn(() => vi.fn());
    registerPendingClaimReloadPreparation(successorPrepare);
    stale.release();

    scheduleDocumentReload('Reload');
    vi.advanceTimersByTime(RESET_PAINT_FALLBACK_MS);
    expect(successorPrepare).toHaveBeenCalledOnce();
  });

  it('scrubs a prepared predecessor and releases its latch before flushing a successor reload', () => {
    const rollback = vi.fn();
    const guard = registerPendingClaimReloadPreparation(() => rollback);
    scheduleDocumentReload('First');
    vi.advanceTimersByTime(RESET_PAINT_FALLBACK_MS);
    scheduleDocumentReload('Second');

    guard.release();
    expect(rollback).toHaveBeenCalledOnce();
    expect(sinks.reload).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(NAVIGATION_COMMIT_TIMEOUT_MS);
    expect(isSessionResetPending()).toBe(true);
    vi.advanceTimersByTime(RESET_PAINT_FALLBACK_MS);
    expect(sinks.reload).toHaveBeenCalledTimes(2);
    expect(rollback).toHaveBeenCalledOnce();
  });
});
