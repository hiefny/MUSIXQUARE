import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { YouTubePlayerInstance } from '../_state.ts';
import {
  isStandardHostManualOffsetTransactionPending,
  prepareStandardHostManualOffsetRuntimeForTests,
  requestStandardHostManualOffsetTransaction,
  resetStandardHostManualOffsetTransaction,
} from '../standard-host-manual-offset-gate.ts';

const runtime = vi.hoisted(() => ({ attempts: 0, begin: vi.fn() }));

vi.mock('../standard-host-manual-offset-runtime.ts', () => {
  runtime.attempts += 1;
  if (runtime.attempts === 1) throw new Error('transient chunk fetch');
  return { beginStandardHostManualOffsetTransaction: runtime.begin };
});

beforeEach(() => {
  resetStandardHostManualOffsetTransaction();
  clearAllManagedTimers();
  resetState();
  bus.clear();
  runtime.attempts = 0;
  runtime.begin.mockClear();
});

afterEach(() => {
  resetStandardHostManualOffsetTransaction();
  clearAllManagedTimers();
});

describe('Standard-host manual-offset chunk retry', () => {
  it('restores the verified boundary and starts a fresh import on the next input', async () => {
    const player = {} as YouTubePlayerInstance;
    setState('sync.youtubeLocalOffset', 0.25);
    setState('sync.youtubeCoordinatorAppliedOffset', 0.25);

    requestStandardHostManualOffsetTransaction(player, 0.5);
    await vi.waitFor(() => expect(isStandardHostManualOffsetTransactionPending()).toBe(false));

    expect(getState('sync.youtubeLocalOffset')).toBe(0.25);
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0.25);
    expect(runtime.attempts).toBe(1);

    requestStandardHostManualOffsetTransaction(player, 0.75);
    await expect(prepareStandardHostManualOffsetRuntimeForTests()).resolves.toBeUndefined();

    expect(runtime.attempts).toBe(2);
    expect(runtime.begin).toHaveBeenCalledOnce();
  });
});
