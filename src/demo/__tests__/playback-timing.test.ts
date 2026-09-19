import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getPendingDemoHostStartAt,
  projectDemoPlay,
  setDemoHostStartAt,
} from '../playback-timing.ts';

afterEach(() => {
  setDemoHostStartAt(null);
  vi.useRealTimers();
});

describe('demo shared-start timing', () => {
  it.each([
    { now: 1_000, hostNow: 10_000, position: 5, delay: 0.2, ended: false },
    { now: 1_500, hostNow: 10_500, position: 5.3, delay: 0, ended: false },
    { now: 31_000, hostNow: 40_000, position: 34.8, delay: 0, ended: false },
    { now: 61_000, hostNow: 70_000, position: 60, delay: 0, ended: true },
    { now: 1_000, hostNow: null, position: 5, delay: 0.2, ended: false },
    { now: 31_000, hostNow: null, position: 34.8, delay: 0, ended: false },
    { now: 1_000, hostNow: -10_000, position: 5, delay: 0.2, ended: false },
  ])(
    'projects decoding at $now with host clock $hostNow',
    ({ now, hostNow, position, delay, ended }) => {
      const projected = projectDemoPlay(
        { time: 5, hostStartAt: 10_200, hostPlayAt: 10_550, receivedAt: 1_000 },
        now,
        hostNow,
        60,
      );
      expect(projected.position).toBeCloseTo(position, 6);
      expect(projected.delay).toBeCloseTo(delay, 6);
      expect(projected.ended).toBe(ended);
    },
  );

  it('keeps the historical 350ms meaning for older demo hosts', () => {
    expect(
      projectDemoPlay({ time: 5, hostPlayAt: 10_350, receivedAt: 1_000 }, 1_000, 10_000, 60),
    ).toEqual({ position: 5.35, delay: 0.35, ended: false });
  });

  it('exposes only a still-pending published host start and clears it on cancellation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    setDemoHostStartAt(1_200);
    expect(getPendingDemoHostStartAt()).toBe(1_200);
    vi.setSystemTime(1_200);
    expect(getPendingDemoHostStartAt()).toBeUndefined();
    setDemoHostStartAt(1_500);
    setDemoHostStartAt(null);
    expect(getPendingDemoHostStartAt()).toBeUndefined();
    setDemoHostStartAt(Number.POSITIVE_INFINITY);
    expect(getPendingDemoHostStartAt()).toBeUndefined();
  });
});
