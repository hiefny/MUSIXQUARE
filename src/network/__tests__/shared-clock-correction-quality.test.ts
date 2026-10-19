import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getClockCorrectionQuality,
  getClockOffset,
  getSharedClockDiagnostics,
  processSyncPong,
  registerPing,
  resetClockState,
  setIsHostClock,
} from '../shared-clock.ts';
import {
  getStandardStartObservations,
  resetStandardStartObservations,
} from '../../diagnostics/standard-start-observations.ts';

let mono = 0;
let ping = 0;
function advance(ms: number) {
  mono += ms;
  vi.advanceTimersByTime(ms);
}
function sample(up = 2, down = 2, hostOffset = 0) {
  const sentAt = Date.now();
  registerPing(++ping);
  advance(up + down);
  expect(processSyncPong(ping, sentAt + up + hostOffset)).not.toBeNull();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  mono = ping = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => mono);
  resetClockState();
  resetStandardStartObservations();
});
afterEach(() => {
  resetClockState();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('read-only evidence for optional clock-based correction', () => {
  it('has no guessed uncertainty before calibration and uses the host clock directly', () => {
    expect(getClockCorrectionQuality()).toMatchObject({
      eligible: false,
      reason: 'uncalibrated',
      rttMs: null,
      uncertaintyMs: null,
    });
    setIsHostClock(true);
    expect(getClockCorrectionQuality()).toMatchObject({
      eligible: true,
      reason: 'host-clock',
      rttMs: 0,
      uncertaintyMs: 5,
      offsetMs: 0,
    });
  });

  it('retains the selected minimum-RTT uncertainty while later replies maintain freshness', () => {
    sample();
    advance(4000);
    sample(100, 700);
    expect(getClockCorrectionQuality()).toMatchObject({
      eligible: true,
      reason: 'fresh',
      rttMs: 4,
      uncertaintyMs: 7,
      offsetMs: 0,
      selectedAgeMs: 4800,
      selectedMonotonicAgeMs: 4800,
      newestSampleAgeMs: 0,
      newestMonotonicAgeMs: 0,
    });
    // The estimate is unchanged. This API adds no estimator smoothing or retention.
    expect(getClockOffset()).toBe(0);
  });

  it('exposes, rather than conceals, uncertainty after the good sample ages out', () => {
    sample();
    for (let i = 0; i < 60; i++) sample(100, 700);
    // Capacity no longer evicts the good sample; only its 120s age limit does.
    expect(getClockCorrectionQuality()).toMatchObject({ rttMs: 4, offsetMs: 0 });
    for (let i = 60; i < 150; i++) sample(100, 700);
    expect(getClockCorrectionQuality()).toMatchObject({
      eligible: true,
      reason: 'fresh',
      rttMs: 800,
      uncertaintyMs: 405,
      offsetMs: -300,
    });
    expect(getSharedClockDiagnostics().sampleCount).toBe(60);
  });

  it('rejects stale replies after five seconds without mutating clock selection or diagnostics', () => {
    sample();
    advance(5000);
    expect(getClockCorrectionQuality().eligible).toBe(true);
    advance(1);
    const before = getSharedClockDiagnostics();
    const observations = getStandardStartObservations();
    expect(getClockCorrectionQuality()).toMatchObject({ eligible: false, reason: 'replies-stale' });
    expect(getSharedClockDiagnostics()).toEqual(before);
    expect(getStandardStartObservations()).toEqual(observations);
  });

  it('does not extend the two-minute sample age merely because the estimator remains calibrated', () => {
    sample();
    advance(120_000);
    expect(getClockCorrectionQuality()).toMatchObject({
      eligible: false,
      reason: 'selected-expired',
    });
    expect(getSharedClockDiagnostics()).toMatchObject({ calibrated: true, sampleCount: 1 });
  });

  it.each([-101, 101])('rejects an observable local wall discontinuity of %i ms', (step) => {
    sample();
    advance(1000);
    vi.setSystemTime(Date.now() + step);
    expect(getClockCorrectionQuality()).toMatchObject({ eligible: false, reason: 'discontinuity' });
    expect(getClockOffset()).toBe(0);
  });

  it('honors the existing 100ms clock-granularity allowance, rather than inventing a tighter step detector', () => {
    sample();
    advance(1000);
    vi.setSystemTime(Date.now() + 100);
    expect(getClockCorrectionQuality().eligible).toBe(true);
  });

  it('rejects negative monotonic ages without silently resetting the clock', () => {
    sample();
    mono = 0;
    expect(getClockCorrectionQuality()).toMatchObject({ eligible: false, reason: 'discontinuity' });
    expect(getSharedClockDiagnostics().sampleCount).toBe(1);
  });

  it('records a new epoch after a corroborated remote clock step and permits fresh correction evidence', () => {
    sample();
    sample();
    sample();
    const before = getClockCorrectionQuality();
    sample(2, 2, 3000);
    expect(getClockCorrectionQuality()).toMatchObject({
      eligible: true,
      rttMs: 4,
      uncertaintyMs: 7,
      offsetMs: 3000,
      epoch: before.epoch + 1,
    });
  });
});
