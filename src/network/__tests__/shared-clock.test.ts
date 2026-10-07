import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getClockOffset,
  getSharedClockDiagnostics,
  processSyncPong,
  getHostNow,
  registerPing,
  resetClockState,
} from '../shared-clock.ts';

function receiveSample(pingId: number, sentAt: number, rtt: number, hostTime: number): void {
  vi.setSystemTime(sentAt);
  registerPing(pingId);
  vi.setSystemTime(sentAt + rtt);
  expect(processSyncPong(pingId, hostTime)).not.toBeNull();
}

function calibrateClock(): void {
  for (let pingId = 1; pingId <= 3; pingId += 1) {
    receiveSample(pingId, pingId * 1_000, 10, pingId * 1_000 + 5);
  }
  expect(getClockOffset()).toBe(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  // Legacy network-delay fixtures advance their common wall/elapsed clock
  // via setSystemTime. Local discontinuity cases override this below.
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  resetClockState();
});

afterEach(() => {
  resetClockState();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('shared clock delayed replies', () => {
  it.each([
    ['outbound', 8_495],
    ['inbound', 4_005],
  ])('retains the calibrated clock when %s queueing resembles a clock step', (_, hostTime) => {
    calibrateClock();

    // The clocks still agree. Only one leg of this exchange spent 4.495s
    // queued, so its midpoint estimate is wrong by 2.245s in either direction.
    receiveSample(4, 4_000, 4_500, Number(hostTime));

    expect(getClockOffset()).toBe(0);
    expect(getSharedClockDiagnostics()).toMatchObject({ sampleCount: 4, bestRttMs: 10 });
  });

  it.each([-5_000, 5_000])('recalibrates after an actual %ims clock step', (offset) => {
    calibrateClock();

    receiveSample(4, 10_000, 10, 10_005 + offset);

    expect(getClockOffset()).toBe(offset);
    expect(getSharedClockDiagnostics()).toMatchObject({ sampleCount: 1, bestRttMs: 10 });
  });

  it('expires a pending reply even when background throttling prevented the next ping', () => {
    calibrateClock();
    vi.setSystemTime(4_000);
    registerPing(4);
    vi.setSystemTime(12_000);

    expect(processSyncPong(4, 4_005)).toBeNull();

    expect(getClockOffset()).toBe(0);
    expect(getSharedClockDiagnostics()).toMatchObject({
      sampleCount: 3,
      pendingPingCount: 0,
      pongsReceived: 3,
    });
  });
});

describe('local wall-clock discontinuities', () => {
  let monotonic = 0;
  const advance = (ms: number): void => {
    monotonic += ms;
    vi.setSystemTime(Date.now() + ms);
  };

  beforeEach(() => {
    monotonic = 0;
    vi.setSystemTime(100_000);
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    for (let id = 1; id <= 3; id++) {
      const sentAt = Date.now();
      registerPing(id);
      advance(4);
      processSyncPong(id, sentAt + 2);
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([-1_000, 1_000])('rebases old precise samples after a local %ims step', (step) => {
    advance(1_000);
    const hostSentAt = Date.now();
    vi.setSystemTime(Date.now() + step);
    registerPing(4);
    advance(8);

    expect(processSyncPong(4, hostSentAt + 4)).toEqual({ rtt: 8, offset: -step });
    expect(getClockOffset()).toBe(-step);
    expect(getHostNow()).toBe(hostSentAt + 8);
    expect(getSharedClockDiagnostics()).toMatchObject({ sampleCount: 4, bestRttMs: 4 });
  });

  it.each([-1_000, 1_000])(
    'waits for a fresh exchange when wall time steps %ims in flight',
    (step) => {
      const hostSentAt = Date.now();
      registerPing(4);
      advance(4);
      vi.setSystemTime(Date.now() + step);
      advance(4);

      expect(processSyncPong(4, hostSentAt + 4)).toBeNull();
      expect(getClockOffset()).toBe(0);
      registerPing(5);
      advance(8);
      expect(processSyncPong(5, hostSentAt + 12)).toEqual({ rtt: 8, offset: -step });
      expect(getHostNow()).toBe(hostSentAt + 16);
    },
  );

  it('ignores a reply held across sleep when the monotonic clock stopped', () => {
    const sentAt = Date.now();
    registerPing(4);
    advance(8);
    vi.setSystemTime(Date.now() + 500);
    expect(processSyncPong(4, sentAt + 4)).toBeNull();
    expect(getClockOffset()).toBe(0);
    registerPing(5);
    const freshSentAt = Date.now();
    advance(8);
    expect(processSyncPong(5, freshSentAt + 4)).toEqual({ rtt: 8, offset: 0 });
    expect(getClockOffset()).toBe(0);
  });

  it('defers ambiguous high-RTT corroboration after a stopped monotonic clock', () => {
    vi.setSystemTime(Date.now() + 500);
    const sentAt = Date.now();
    registerPing(4);
    advance(4_500);
    processSyncPong(4, sentAt + 5);
    expect(getClockOffset()).toBe(0);
    expect(getSharedClockDiagnostics()).toMatchObject({ sampleCount: 4, bestRttMs: 4 });
  });

  it('does not mistake a paused monotonic clock during sleep for a local wall edit', () => {
    vi.setSystemTime(Date.now() + 30_000);
    const sentAt = Date.now();
    registerPing(4);
    advance(8);

    expect(processSyncPong(4, sentAt + 4)).toEqual({ rtt: 8, offset: 0 });
    expect(getClockOffset()).toBe(0);
    expect(getHostNow()).toBe(sentAt + 8);
  });

  it.each(['outbound', 'inbound'])('keeps low-RTT precision with monotonic %s queueing', (leg) => {
    const sentAt = Date.now();
    registerPing(4);
    advance(4_500);
    processSyncPong(4, sentAt + (leg === 'outbound' ? 4_495 : 5));

    expect(getClockOffset()).toBe(0);
    expect(getSharedClockDiagnostics()).toMatchObject({ sampleCount: 4, bestRttMs: 4 });
  });
});
