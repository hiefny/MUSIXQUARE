import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPendingDemoHostStartAt, setDemoHostStartAt } from '../host-start-anchor.ts';
import { LOCAL_FILE_START_LEAD_MS } from '../../player/file-play-timing.ts';
import { DEMO_PLAY_START_LEAD_MS, projectDemoPlay } from '../playback-timing.ts';

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
        { time: 5, hostStartAt: 10_200, receivedAt: 1_000 },
        now,
        hostNow,
        60,
      );
      expect(projected.position).toBeCloseTo(position, 6);
      expect(projected.delay).toBeCloseTo(delay, 6);
      expect(projected.ended).toBe(ended);
    },
  );

  it.each([
    { hostNow: 8_201, position: 5, delay: 1.999 },
    { hostNow: 8_200, position: 5, delay: 0.2 },
    { hostNow: 12_200, position: 7, delay: 0 },
  ])(
    'trusts a shared demo start up to 2 s ahead and any time behind (host $hostNow)',
    ({ hostNow, position, delay }) => {
      const projected = projectDemoPlay(
        { time: 5, hostStartAt: 10_200, receivedAt: 1_000 },
        1_000,
        hostNow,
        600,
      );
      expect(projected.position).toBeCloseTo(position, 6);
      expect(projected.delay).toBeCloseTo(delay, 6);
      expect(projected.ended).toBe(false);
    },
  );

  it('shares the 200 ms start lead with local files', () => {
    expect(DEMO_PLAY_START_LEAD_MS).toBe(200);
    expect(LOCAL_FILE_START_LEAD_MS).toBe(200);
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
