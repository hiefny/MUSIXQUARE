/**
 * The Standard-host manual-offset gate's cold-chunk row, in a file of its own.
 * The gate module keeps the runtime chunk it loads lazily for as long as the
 * module lives, and no reset drops it. Each row in
 * standard-host-manual-offset-gate.test.ts loads that chunk, and afterwards a
 * request begins the runtime synchronously, so this row passed there only
 * when it ran first. In its own file the chunk is cold in any test order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState, getState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { YouTubePlayerInstance } from '../_state.ts';
import {
  cancelStandardHostManualOffsetTransaction,
  isStandardHostManualOffsetTransactionPending,
  prepareStandardHostManualOffsetRuntimeForTests,
  requestStandardHostManualOffsetTransaction,
  resetStandardHostManualOffsetTransaction,
} from '../standard-host-manual-offset-gate.ts';

const runtime = vi.hoisted(() => ({ begin: vi.fn() }));

vi.mock('../standard-host-manual-offset-runtime.ts', () => ({
  beginStandardHostManualOffsetTransaction: runtime.begin,
}));

beforeEach(() => {
  resetStandardHostManualOffsetTransaction();
  clearAllManagedTimers();
  resetState();
  bus.clear();
  runtime.begin.mockClear();
});

afterEach(() => {
  resetStandardHostManualOffsetTransaction();
  clearAllManagedTimers();
});

describe('Standard-host manual-offset eager gate', () => {
  it('invalidates a cold deferred command synchronously before its chunk resolves', async () => {
    const player = {} as YouTubePlayerInstance;
    setState('sync.youtubeCoordinatorAppliedOffset', 0.25);

    requestStandardHostManualOffsetTransaction(player, 0.5);

    expect(isStandardHostManualOffsetTransactionPending()).toBe(true);
    expect(getState('sync.youtubeLocalOffset')).toBe(0.5);
    expect(runtime.begin).not.toHaveBeenCalled();

    expect(cancelStandardHostManualOffsetTransaction()).toBe(true);
    expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
    expect(getState('sync.youtubeLocalOffset')).toBe(0);

    await prepareStandardHostManualOffsetRuntimeForTests();
    expect(runtime.begin).not.toHaveBeenCalled();
  });
});
