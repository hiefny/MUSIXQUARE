import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getClockOffset,
  getSharedClockDiagnostics,
  processSyncPong,
  getHostNow,
  registerPing,
  resetClockState,
  resetClockSamples,
  setIsHostClock,
} from '../shared-clock.ts';
import {
  getStandardStartObservations,
  resetStandardStartObservations,
} from '../../diagnostics/standard-start-observations.ts';

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
  resetStandardStartObservations();
});

describe('standard clock selection observations', () => {
  const selections = () =>
    getStandardStartObservations().clock.filter(
      (observation) => observation.kind === 'clock-selection',
    );

  it('records changed estimates while preserving minimum-RTT selection', () => {
    receiveSample(1, 1_000, 40, 1_020);
    const first = selections().at(-1)!.detail;
    expect(first).toMatchObject({
      reason: 'new-sample',
      previousSampleId: null,
      selectedOffsetMs: 0,
      selectedRttMs: 40,
    });
    receiveSample(2, 2_000, 200, 2_010);
    expect(selections()).toHaveLength(1);
    expect(getClockOffset()).toBe(0);
    receiveSample(3, 3_000, 20, 3_015);
    expect(selections().at(-1)!.detail).toMatchObject({
      reason: 'new-sample',
      previousSampleId: first.selectedSampleId,
      previousOffsetMs: 0,
      selectedOffsetMs: 5,
      previousRttMs: 40,
      selectedRttMs: 20,
      sameEpoch: true,
      disjointIntervals: false,
      comparisonToleranceMs: 5,
    });
    expect(getClockOffset()).toBe(5);
  });

  it('keeps newest equal-RTT semantics but suppresses identical estimate noise', () => {
    receiveSample(1, 1_000, 20, 1_010);
    const firstId = selections().at(-1)!.detail.selectedSampleId as number;
    receiveSample(2, 2_000, 20, 2_010);
    expect(selections()).toHaveLength(1);
    receiveSample(3, 3_000, 20, 3_015);
    expect(selections().at(-1)!.detail).toMatchObject({
      reason: 'equal-rtt',
      selectedOffsetMs: 5,
      previousOffsetMs: 0,
    });
    expect(selections().at(-1)!.detail.previousSampleId).toBeGreaterThan(firstId);
    expect(getClockOffset()).toBe(5);
  });

  it.each([20, 21])(
    'compares same-epoch RTT intervals with a 5ms margin at offset %ims',
    (offset) => {
      receiveSample(1, 1_000, 20, 1_010);
      receiveSample(2, 2_000, 10, 2_005 + offset);
      expect(selections().at(-1)!.detail).toMatchObject({
        previousRttMs: 20,
        selectedRttMs: 10,
        offsetDifferenceMs: offset,
        comparisonToleranceMs: 5,
        intervalGapMs: offset - 15,
        disjointIntervals: offset > 20,
      });
    },
  );

  it('records selection expiry on the next accepted reply without adding read-time expiry', () => {
    receiveSample(1, 1_000, 20, 1_010);
    vi.setSystemTime(121_021);
    expect(getSharedClockDiagnostics()).toMatchObject({ calibrated: true, sampleCount: 1 });
    expect(selections()).toHaveLength(1);
    receiveSample(2, 122_000, 40, 122_030);
    expect(selections().at(-1)!.detail).toMatchObject({
      reason: 'expired',
      selectedOffsetMs: 10,
      previousAgeMs: 121_020,
      sampleCount: 1,
      sameEpoch: true,
    });
  });

  it('records capacity eviction when the original precise sample leaves the 60-item pool', () => {
    receiveSample(1, 1_000, 2, 1_001);
    for (let id = 2; id <= 60; id++) receiveSample(id, id * 1000, 20, id * 1000 + 11);
    expect(selections()).toHaveLength(1);
    receiveSample(61, 61_000, 20, 61_011);
    expect(selections().at(-1)!.detail).toMatchObject({
      reason: 'capacity',
      previousRttMs: 2,
      selectedRttMs: 20,
      selectedOffsetMs: 1,
      sampleCount: 60,
    });
    expect(getClockOffset()).toBe(1);
  });

  it('marks reset and host-role changes as incomparable clock epochs', () => {
    receiveSample(1, 1_000, 20, 1_510);
    setIsHostClock(true);
    expect(selections().at(-1)!.detail).toMatchObject({
      reason: 'host-role',
      previousIsHostClock: false,
      isHostClock: true,
      selectedOffsetMs: 0,
      sameEpoch: false,
      disjointIntervals: null,
      intervalGapMs: null,
      offsetDifferenceMs: null,
      previousAgeMs: null,
    });
    setIsHostClock(false);
    expect(getClockOffset()).toBe(500);
    resetClockSamples();
    expect(selections().at(-1)!.detail).toMatchObject({
      reason: 'reset',
      previousOffsetMs: 500,
      selectedSampleId: null,
      sameEpoch: false,
      disjointIntervals: null,
    });
    expect(getSharedClockDiagnostics().calibrated).toBe(false);
  });

  it('records rebasing the same selected sample without comparing different wall epochs', () => {
    let monotonic = 0;
    vi.mocked(performance.now).mockImplementation(() => monotonic);
    vi.setSystemTime(1_000);
    registerPing(1);
    vi.setSystemTime(1_004);
    monotonic = 4;
    processSyncPong(1, 1_002);
    vi.setSystemTime(2_010);
    monotonic = 10;
    registerPing(2);
    vi.setSystemTime(2_018);
    monotonic = 18;
    processSyncPong(2, 1_014);
    const rebase = selections().at(-1)!.detail;
    expect(rebase).toMatchObject({
      reason: 'rebase',
      previousOffsetMs: 0,
      selectedOffsetMs: -1000,
      previousRttMs: 4,
      selectedRttMs: 4,
      sameEpoch: false,
      disjointIntervals: null,
      previousAgeMs: null,
    });
    expect(rebase.selectedSampleId).toBe(rebase.previousSampleId);
    expect(rebase.epoch).not.toBe(rebase.previousEpoch);
    expect(
      getStandardStartObservations().clock.find((record) => record.kind === 'clock-continuity')
        ?.detail,
    ).toMatchObject({ reason: 'rebase', localClockStepMs: 1000, continuityToleranceMs: 100 });
    expect(getClockOffset()).toBe(-1000);
    expect(getSharedClockDiagnostics().sampleCount).toBe(2);
  });

  it('records a large clock-step flush as an epoch change', () => {
    calibrateClock();
    receiveSample(4, 10_000, 20, 15_010);
    expect(selections().at(-1)!.detail).toMatchObject({
      reason: 'clock-step',
      previousOffsetMs: 0,
      selectedOffsetMs: 5000,
      sampleCount: 1,
      sameEpoch: false,
      disjointIntervals: null,
      offsetDifferenceMs: null,
    });
    expect(getClockOffset()).toBe(5000);
  });

  it('preserves raw send time when an earlier reply rebased another outstanding ping', () => {
    let monotonic = 0;
    vi.mocked(performance.now).mockImplementation(() => monotonic);
    vi.setSystemTime(1_000);
    registerPing(1);
    vi.setSystemTime(1_004);
    monotonic = 4;
    processSyncPong(1, 1_002);

    vi.setSystemTime(1_005);
    monotonic = 5;
    registerPing(2);
    vi.setSystemTime(2_006);
    monotonic = 6;
    registerPing(3);
    vi.setSystemTime(2_014);
    monotonic = 14;
    processSyncPong(3, 1_010);
    expect(getClockOffset()).toBe(-1_000);

    // Ping 2's effective send timestamp was rebased to 2005, but its original
    // wire-send wall timestamp remains 1005 for the later discontinuity trace.
    vi.setSystemTime(2_520);
    monotonic = 20;
    expect(processSyncPong(2, 1_012)).toBeNull();
    const continuity = getStandardStartObservations().clock.filter(
      (record) => record.kind === 'clock-continuity',
    );
    expect(continuity.at(-1)?.detail).toMatchObject({
      reason: 'wall-monotonic',
      rawSentAtMs: 1_005,
      rawWallElapsedMs: 1_515,
      sentAtMs: 2_005,
      wallElapsedMs: 515,
      receivedAtMs: 2_520,
      monotonicElapsedMs: 15,
      continuityToleranceMs: 100,
      clockContinuitySuspect: true,
    });
    expect(getClockOffset()).toBe(-1_000);
    expect(getSharedClockDiagnostics().sampleCount).toBe(2);
  });

  it.each([100, 101])(
    'observes wall/monotonic disagreement %ims without changing the 100ms policy',
    (difference) => {
      let monotonic = 0;
      vi.mocked(performance.now).mockImplementation(() => monotonic);
      vi.setSystemTime(1_000);
      registerPing(1);
      vi.setSystemTime(1_020 + difference);
      monotonic = 20;
      const result = processSyncPong(1, 1_010);
      const continuity = getStandardStartObservations().clock.filter(
        (record) => record.kind === 'clock-continuity',
      );
      if (difference === 100) {
        expect(result).toEqual({ rtt: 120, offset: -50 });
        expect(continuity).toHaveLength(0);
      } else {
        expect(result).toBeNull();
        expect(continuity.at(-1)?.detail).toMatchObject({
          reason: 'wall-monotonic',
          wallElapsedMs: 121,
          monotonicElapsedMs: 20,
          continuityToleranceMs: 100,
          clockContinuitySuspect: true,
        });
        expect(getSharedClockDiagnostics().sampleCount).toBe(0);
      }
    },
  );
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
