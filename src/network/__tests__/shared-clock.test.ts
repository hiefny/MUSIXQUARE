import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getClockOffset,
  getSharedClockDiagnostics,
  processSyncPong,
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
  resetClockState();
});

afterEach(() => {
  resetClockState();
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
