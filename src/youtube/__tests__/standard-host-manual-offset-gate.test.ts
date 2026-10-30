import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { YouTubePlayerInstance } from '../_state.ts';
import {
  afterStandardHostManualOffsetTransaction,
  cancelStandardHostManualOffsetTransaction,
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

// 'invalidates a cold deferred command synchronously before its chunk
// resolves' runs in standard-host-manual-offset-gate-cold.test.ts: each row
// here loads the runtime chunk, and the gate keeps it loaded.
describe('Standard-host manual-offset eager gate', () => {
  it('releases deferred one-shot work only after a verified commit', async () => {
    const player = {} as YouTubePlayerInstance;
    const listener = vi.fn();

    requestStandardHostManualOffsetTransaction(player, 0.5);
    await prepareStandardHostManualOffsetRuntimeForTests();
    expect(afterStandardHostManualOffsetTransaction(listener)).toBe(true);

    const lease = runtime.begin.mock.calls.at(-1)?.[0] as {
      commit(action: () => void): boolean;
    };
    expect(lease.commit(() => undefined)).toBe(true);
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('discards deferred work on a hard media transition', async () => {
    const player = {} as YouTubePlayerInstance;
    const listener = vi.fn();

    requestStandardHostManualOffsetTransaction(player, 0.5);
    expect(afterStandardHostManualOffsetTransaction(listener)).toBe(true);
    expect(cancelStandardHostManualOffsetTransaction()).toBe(true);
    await Promise.resolve();

    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps deferred work behind a rapid follow-up transaction', async () => {
    const player = {} as YouTubePlayerInstance;
    const listener = vi.fn();

    requestStandardHostManualOffsetTransaction(player, 0.5);
    await prepareStandardHostManualOffsetRuntimeForTests();
    expect(afterStandardHostManualOffsetTransaction(listener)).toBe(true);

    const firstLease = runtime.begin.mock.calls.at(-1)?.[0] as {
      commit(action: () => void): boolean;
    };
    expect(firstLease.commit(() => undefined)).toBe(true);
    requestStandardHostManualOffsetTransaction(player, 0.75);
    await Promise.resolve();

    expect(listener).not.toHaveBeenCalled();
    const secondLease = runtime.begin.mock.calls.at(-1)?.[0] as {
      commit(action: () => void): boolean;
    };
    expect(secondLease.commit(() => undefined)).toBe(true);
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
