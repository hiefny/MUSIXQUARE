import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPendingDemoHostStartAt, setDemoHostStartAt } from '../host-start-anchor.ts';
import {
  LEGACY_FILE_SCHEDULE_AHEAD_MS,
  LOCAL_FILE_START_LEAD_MS,
} from '../../player/file-play-timing.ts';
import {
  DEMO_PLAY_SCHEDULE_AHEAD_MS,
  DEMO_PLAY_START_LEAD_MS,
  projectDemoPlay,
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

  it.each([
    { hostNow: 8_201, position: 5, delay: 1.999 },
    { hostNow: 8_200, position: 5, delay: 0.2 },
    { hostNow: 12_200, position: 7, delay: 0 },
  ])(
    'trusts a shared demo start up to 2 s ahead and any time behind (host $hostNow)',
    ({ hostNow, position, delay }) => {
      const projected = projectDemoPlay(
        { time: 5, hostStartAt: 10_200, hostPlayAt: 10_550, receivedAt: 1_000 },
        1_000,
        hostNow,
        600,
      );
      expect(projected.position).toBeCloseTo(position, 6);
      expect(projected.delay).toBeCloseTo(delay, 6);
      expect(projected.ended).toBe(false);
    },
  );

  it.each([
    { hostNow: 8_351, position: 5.35, delay: 1.999 },
    { hostNow: 8_350, position: 5, delay: 0 },
    { hostNow: 12_350, position: 7.35, delay: 0 },
  ])(
    'applies the same one-sided window to an older demo host (host $hostNow)',
    ({ hostNow, position, delay }) => {
      const projected = projectDemoPlay(
        { time: 5, hostPlayAt: 10_350, receivedAt: 1_000 },
        1_000,
        hostNow,
        600,
      );
      expect(projected.position).toBeCloseTo(position, 6);
      expect(projected.delay).toBeCloseTo(delay, 6);
      expect(projected.ended).toBe(false);
    },
  );

  it('shares the 200 ms start lead with local files but keeps each legacy wire lead', () => {
    expect(DEMO_PLAY_START_LEAD_MS).toBe(200);
    expect(LOCAL_FILE_START_LEAD_MS).toBe(200);
    // Older receivers read hostPlayAt with these leads; they differ on purpose.
    expect(LEGACY_FILE_SCHEDULE_AHEAD_MS).toBe(200);
    expect(DEMO_PLAY_SCHEDULE_AHEAD_MS).toBe(350);
  });

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
