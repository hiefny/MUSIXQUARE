/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetState, setState, getState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { getTotalSyncOffsetMs, handleAutoSync } from '../sync.ts';

beforeEach(() => {
  resetState();
  bus.clear();
});

describe('getTotalSyncOffsetMs', () => {
  it('returns 0 initially', () => {
    expect(getTotalSyncOffsetMs()).toBe(0);
  });

  it('calculates from localOffset', () => {
    setState('sync.localOffset', 0.15);
    expect(getTotalSyncOffsetMs()).toBe(150);
  });

  it('handles negative offsets', () => {
    setState('sync.localOffset', -0.05);
    expect(getTotalSyncOffsetMs()).toBe(-50);
  });
});

describe('handleAutoSync', () => {
  it('resets localOffset to 0', () => {
    setState('sync.localOffset', 0.5);
    handleAutoSync();
    expect(getState('sync.localOffset')).toBe(0);
  });
});
