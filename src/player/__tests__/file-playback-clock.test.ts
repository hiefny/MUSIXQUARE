import { describe, expect, it } from 'vitest';

import { FilePlaybackClock } from '../file-playback-clock.ts';

interface FakeAudioContext {
  currentTime: number;
  getOutputTimestamp?: () => AudioTimestamp;
}

describe('FilePlaybackClock', () => {
  it('maps host room time to AudioContext time without using a wall clock', () => {
    let nowMs = 1_000;
    const clock = new FilePlaybackClock({ now: () => nowMs });
    clock.setHost(true);
    const context: FakeAudioContext = { currentTime: 2 };
    const bindings = clock.bindAudioContext(context as AudioContext);

    expect(bindings.nowRoomTimeMs()).toBe(1_000);
    expect(bindings.roomTimeMsToContextTime(1_500)).toBe(2.5);
    expect(bindings.localPerformanceMsToContextTime(1_250)).toBe(2.25);

    nowMs = 1_100;
    context.currentTime = 2.1;
    expect(bindings.nowRoomTimeMs()).toBe(1_100);
  });

  it('uses calibrated guest offset before mapping a room target', () => {
    let nowMs = 1_000;
    const clock = new FilePlaybackClock({
      now: () => nowMs,
      estimatorOptions: {
        calibration: { minimumSamples: 1 },
      },
    });
    // RTT 20ms, host midpoint is exactly 100ms ahead of the local midpoint.
    const sample = clock.addNtpSample(900, 1_010, 1_010, 920);
    expect(sample.accepted).toBe(true);
    expect(clock.quality()).toMatchObject({ calibrated: true, offsetMs: 100 });

    const context: FakeAudioContext = { currentTime: 5 };
    const bindings = clock.bindAudioContext(context as AudioContext);
    expect(bindings.nowRoomTimeMs()).toBe(1_100);
    // Room 1,300ms -> local 1,200ms -> 200ms after context time 5.0.
    expect(bindings.roomTimeMsToContextTime(1_300)).toBeCloseTo(5.2, 10);

    nowMs = 1_100;
    clock.handleWake();
    expect(clock.quality().calibrated).toBe(false);
  });

  it('uses a valid output timestamp when the browser exposes one', () => {
    const clock = new FilePlaybackClock({ now: () => 2_010 });
    clock.setHost(true);
    const context: FakeAudioContext = {
      currentTime: 10.01,
      getOutputTimestamp: () => ({ contextTime: 10, performanceTime: 2_000 }),
    };
    const bindings = clock.bindAudioContext(context as AudioContext);

    expect(bindings.roomTimeMsToContextTime(2_250)).toBe(10.25);
  });

  it('supports an already captured local time without rereading its source', () => {
    let sourceReads = 0;
    const clock = new FilePlaybackClock({
      now: () => {
        sourceReads += 1;
        return 2_000;
      },
    });
    clock.setHost(true);

    expect(clock.qualityAtLocalTime(2_000).calibrated).toBe(true);
    expect(clock.nowRoomTimeMsAtLocalTime(2_000)).toBe(2_000);
    expect(sourceReads).toBe(0);
  });

  it('resets role and samples at a full session boundary', () => {
    const clock = new FilePlaybackClock({ now: () => 100 });
    clock.setHost(true);
    expect(clock.quality().calibrated).toBe(true);

    clock.reset();
    expect(clock.isHost()).toBe(false);
    expect(clock.quality().calibrated).toBe(false);
  });
});
