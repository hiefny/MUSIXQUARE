import { describe, expect, it } from 'vitest';
import {
  calculateRendezvousLeadMs,
  ClockEstimator,
  mapPerformanceTimeToContext,
  type AudioContextTimingSource,
  type MonotonicNow,
} from '../clock-estimator.ts';

function makeNow(initial = 1_000): {
  now: MonotonicNow;
  set: (value: number) => void;
  advance: (deltaMs: number) => void;
} {
  let value = initial;
  return {
    now: () => value,
    set: (next) => {
      value = next;
    },
    advance: (deltaMs) => {
      value += deltaMs;
    },
  };
}

function addSample(
  estimator: ClockEstimator,
  rttMs: number,
  offsetMs: number,
  t0 = 10_000,
  hostProcessingMs = 2,
) {
  const oneWayMs = rttMs / 2;
  const t1 = t0 + oneWayMs + offsetMs;
  const t2 = t1 + hostProcessingMs;
  const t3 = t0 + rttMs + hostProcessingMs;
  return estimator.addNtpSample(t0, t1, t2, t3);
}

describe('ClockEstimator', () => {
  it('uses the median offset of the five lowest-RTT samples', () => {
    const clock = makeNow();
    const estimator = new ClockEstimator({ now: clock.now });

    addSample(estimator, 40, 101);
    addSample(estimator, 10, 99);
    addSample(estimator, 30, 100);
    addSample(estimator, 20, 102);
    addSample(estimator, 50, 98);
    addSample(estimator, 500, 104);

    const quality = estimator.quality();
    expect(quality.offsetMs).toBe(100);
    expect(quality.minRttMs).toBe(10);
    expect(quality.rttP95Ms).toBe(500);
    expect(quality.offsetSpreadMs).toBe(4);
    expect(quality.sampleCount).toBe(6);
    expect(quality.calibrated).toBe(true);
  });

  it('requires fresh, stable samples within the configured calibration thresholds', () => {
    const clock = makeNow();
    const estimator = new ClockEstimator({ now: clock.now });

    for (let index = 0; index < 4; index += 1) addSample(estimator, 20, 40 + index);
    expect(estimator.quality().calibrated).toBe(false);

    addSample(estimator, 20, 44);
    expect(estimator.quality().calibrated).toBe(true);

    clock.advance(3_001);
    expect(estimator.quality()).toMatchObject({ calibrated: false, ageMs: 3_001 });
  });

  it('bounds retained samples by count and age', () => {
    const clock = makeNow();
    const estimator = new ClockEstimator({
      now: clock.now,
      maxSamples: 3,
      maxSampleAgeMs: 100,
      calibration: { minimumSamples: 2 },
    });

    for (let index = 0; index < 5; index += 1) {
      addSample(estimator, 20 + index, index);
      clock.advance(10);
    }
    expect(estimator.quality().sampleCount).toBe(3);

    clock.advance(101);
    expect(estimator.quality()).toEqual({
      calibrated: false,
      offsetMs: 0,
      minRttMs: Infinity,
      rttP95Ms: Infinity,
      offsetSpreadMs: Infinity,
      sampleCount: 0,
      ageMs: Infinity,
    });
  });

  it.each([
    [[Number.NaN, 1, 2, 3], 'non-finite-timestamp'],
    [[0, 1, Number.POSITIVE_INFINITY, 3], 'non-finite-timestamp'],
    [[-1, 1, 2, 3], 'negative-timestamp'],
    [[10, 10, 11, 9], 'local-clock-reversed'],
    [[0, 20, 10, 30], 'host-clock-reversed'],
    [[0, 1, 2, 20_000], 'exchange-too-long'],
    [[0, 10, 10_020, 10_001], 'invalid-rtt'],
    [[0, 5_001, 5_001, 10_001], 'rtt-too-high'],
  ] as const)('rejects malformed exchange %j as %s', (timestamps, expectedReason) => {
    const estimator = new ClockEstimator({ now: () => 100 });
    const [clientSendMs, hostReceiveMs, hostSendMs, clientReceiveMs] = timestamps;
    const result = estimator.addNtpSample(clientSendMs, hostReceiveMs, hostSendMs, clientReceiveMs);
    expect(result).toMatchObject({ accepted: false, reason: expectedReason });
    expect(result.quality.sampleCount).toBe(0);
  });

  it('rejects a large offset outlier without poisoning established calibration', () => {
    const estimator = new ClockEstimator({ now: () => 100 });
    addSample(estimator, 10, 100);
    addSample(estimator, 11, 101);
    addSample(estimator, 12, 99);

    const result = addSample(estimator, 9, 20_000);
    expect(result).toMatchObject({ accepted: false, reason: 'offset-outlier' });
    expect(result.quality).toMatchObject({ sampleCount: 3, offsetMs: 100 });
  });

  it('transactionally rejects maintenance samples that would regress calibrated quality', () => {
    const clock = makeNow();
    const estimator = new ClockEstimator({ now: clock.now });
    for (let index = 0; index < 5; index += 1) {
      addSample(estimator, 10, 100 + index);
    }
    expect(estimator.quality()).toMatchObject({
      calibrated: true,
      sampleCount: 5,
      offsetMs: 102,
      offsetSpreadMs: 4,
      ageMs: 0,
    });

    clock.advance(1_000);
    const spreadRegression = addSample(estimator, 9, 109);
    expect(spreadRegression).toMatchObject({
      accepted: false,
      reason: 'quality-regression',
      quality: {
        calibrated: true,
        sampleCount: 5,
        offsetMs: 102,
        offsetSpreadMs: 4,
        ageMs: 1_000,
      },
    });

    const rttRegression = addSample(estimator, 1_501, 102);
    expect(rttRegression).toMatchObject({
      accepted: false,
      reason: 'quality-regression',
      quality: { calibrated: true, sampleCount: 5, ageMs: 1_000 },
    });

    const renewal = addSample(estimator, 9, 103);
    expect(renewal).toMatchObject({
      accepted: true,
      quality: { calibrated: true, sampleCount: 6, ageMs: 0 },
    });
  });

  it('does not extend the calibrated lease with rejected maintenance evidence', () => {
    const clock = makeNow();
    const estimator = new ClockEstimator({ now: clock.now });
    for (let index = 0; index < 5; index += 1) addSample(estimator, 10, 100 + index);

    clock.advance(2_000);
    expect(addSample(estimator, 9, 109)).toMatchObject({
      accepted: false,
      reason: 'quality-regression',
    });
    clock.advance(1_001);
    expect(estimator.quality()).toMatchObject({ calibrated: false, ageMs: 3_001 });
  });

  it('converts host and local monotonic timestamps in both directions', () => {
    const clock = makeNow(5_000);
    const estimator = new ClockEstimator({ now: clock.now });
    addSample(estimator, 20, 125);

    expect(estimator.localToHost(10_000)).toBe(10_125);
    expect(estimator.hostToLocal(10_125)).toBe(10_000);
    expect(estimator.hostNow()).toBe(5_125);
  });

  it('reads the injected monotonic source once for hostNow and supports explicit observations', () => {
    let sourceReads = 0;
    const estimator = new ClockEstimator({
      now: () => {
        sourceReads += 1;
        return 5_000;
      },
    });
    addSample(estimator, 20, 125);
    sourceReads = 0;

    expect(estimator.hostNow()).toBe(5_125);
    expect(sourceReads).toBe(1);
    expect(estimator.qualityAtLocalTime(5_000).offsetMs).toBe(125);
    expect(estimator.hostNowAtLocalTime(5_000)).toBe(5_125);
    expect(sourceReads).toBe(1);
  });

  it('treats the host as calibrated identity clock and resets on role changes', () => {
    const clock = makeNow(2_000);
    const estimator = new ClockEstimator({ now: clock.now });
    addSample(estimator, 20, 100);

    estimator.setHostClock(true);
    expect(estimator.isHostClock()).toBe(true);
    expect(estimator.quality()).toEqual({
      calibrated: true,
      offsetMs: 0,
      minRttMs: 0,
      rttP95Ms: 0,
      offsetSpreadMs: 0,
      sampleCount: 0,
      ageMs: 0,
    });
    expect(estimator.hostNow()).toBe(2_000);
    expect(estimator.localToHost(123)).toBe(123);

    estimator.setHostClock(false);
    expect(estimator.quality().calibrated).toBe(false);
    expect(estimator.quality().sampleCount).toBe(0);
  });

  it('invalidates guest calibration on wake and full session reset', () => {
    const estimator = new ClockEstimator({ now: () => 100 });
    addSample(estimator, 20, 10);
    expect(estimator.quality().sampleCount).toBe(1);

    estimator.handleWake();
    expect(estimator.quality().sampleCount).toBe(0);

    estimator.setHostClock(true);
    estimator.handleWake();
    expect(estimator.quality().calibrated).toBe(true);
    estimator.resetState();
    expect(estimator.isHostClock()).toBe(false);
    expect(estimator.quality().calibrated).toBe(false);
  });

  it('fails closed if the injected monotonic clock moves backwards', () => {
    const clock = makeNow(1_000);
    const estimator = new ClockEstimator({ now: clock.now });
    addSample(estimator, 20, 10);
    clock.set(999);
    expect(estimator.quality().sampleCount).toBe(0);
  });
});

describe('mapPerformanceTimeToContext', () => {
  it('uses a fresh, internally consistent output timestamp', () => {
    const context: AudioContextTimingSource = {
      currentTime: 12,
      getOutputTimestamp: () => ({ contextTime: 11.95, performanceTime: 9_950 }),
    };

    expect(mapPerformanceTimeToContext(context, 10_200, { now: () => 10_000 })).toEqual({
      contextTime: 12.2,
      method: 'output-timestamp',
    });
  });

  it.each([
    { contextTime: 0, performanceTime: 0 },
    { contextTime: Number.NaN, performanceTime: 9_950 },
    { contextTime: 12, performanceTime: 8_000 },
    { contextTime: 30, performanceTime: 9_950 },
  ])('falls back for an invalid output timestamp: %j', (timestamp) => {
    const reads = [10_000, 10_010, 10_014];
    const context: AudioContextTimingSource = {
      currentTime: 12,
      getOutputTimestamp: () => timestamp,
    };

    expect(
      mapPerformanceTimeToContext(context, 10_200, {
        now: () => reads.shift() ?? 10_014,
      }),
    ).toEqual({ contextTime: 12.188, method: 'current-time-fallback' });
  });

  it('falls back when getOutputTimestamp throws', () => {
    const reads = [1_000, 1_004];
    const context: AudioContextTimingSource = {
      currentTime: 2,
      getOutputTimestamp: () => {
        throw new Error('not ready');
      },
    };

    expect(
      mapPerformanceTimeToContext(context, 1_102, { now: () => reads.shift() ?? 1_004 }),
    ).toEqual({ contextTime: 2.1, method: 'current-time-fallback' });
  });
});

describe('calculateRendezvousLeadMs', () => {
  it('uses 2 * RTT p95 + arm p95 + 200ms safety', () => {
    expect(calculateRendezvousLeadMs(100, 300)).toBe(700);
  });

  it('clamps the result to the 450-2500ms product window', () => {
    expect(calculateRendezvousLeadMs(0, 0)).toBe(450);
    expect(calculateRendezvousLeadMs(2_000, 2_000)).toBe(2_500);
  });

  it.each([
    [Number.NaN, 1],
    [1, Number.POSITIVE_INFINITY],
    [-1, 1],
  ])('rejects invalid latency input (%s, %s)', (rttP95Ms, armP95Ms) => {
    expect(() => calculateRendezvousLeadMs(rttP95Ms, armP95Ms)).toThrow(RangeError);
  });
});
