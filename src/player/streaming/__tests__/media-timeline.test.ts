import { describe, expect, it } from 'vitest';

import {
  createStreamingMediaTimeline,
  mediaFrameAtPosition,
  outputFrameAtMediaFrame,
  outputFrameAtPosition,
} from '../media-timeline.ts';

describe('streaming media timeline', () => {
  it('maps a direct-rate audible timeline without codec coordinates', () => {
    const timeline = createStreamingMediaTimeline({
      mediaSampleRateHz: 48_000,
      outputSampleRateHz: 48_000,
      totalMediaFrames: 480_000,
    });

    expect(timeline).toEqual({
      mediaSampleRateHz: 48_000,
      outputSampleRateHz: 48_000,
      totalMediaFrames: 480_000,
      totalOutputFrames: 480_000,
      durationSeconds: 10,
    });
    expect(Object.isFrozen(timeline)).toBe(true);
    expect(mediaFrameAtPosition(timeline, 1.25)).toBe(60_000);
    expect(outputFrameAtPosition(timeline, 1.25)).toBe(60_000);
  });

  it('uses the pinned resampler contract for total length and seek positions', () => {
    const timeline = createStreamingMediaTimeline({
      mediaSampleRateHz: 352_800,
      outputSampleRateHz: 48_000,
      totalMediaFrames: 5_461,
    });

    expect(timeline.totalOutputFrames).toBe(742);
    expect(outputFrameAtMediaFrame(timeline, 5_361)).toBe(729);
    expect(outputFrameAtMediaFrame(timeline, timeline.totalMediaFrames)).toBe(742);
  });

  it('clamps positions to the audible media interval', () => {
    const timeline = createStreamingMediaTimeline({
      mediaSampleRateHz: 44_100,
      outputSampleRateHz: 48_000,
      totalMediaFrames: 441_000,
    });

    expect(mediaFrameAtPosition(timeline, -3)).toBe(0);
    expect(mediaFrameAtPosition(timeline, 300)).toBe(441_000);
    expect(outputFrameAtPosition(timeline, 300)).toBe(timeline.totalOutputFrames);
  });

  it('rejects non-renderable or unsafe timelines and coordinates', () => {
    expect(() =>
      createStreamingMediaTimeline({
        mediaSampleRateHz: 352_800,
        outputSampleRateHz: 48_000,
        totalMediaFrames: 8,
      }),
    ).toThrow(/no renderable output frames/);
    expect(() =>
      createStreamingMediaTimeline({
        mediaSampleRateHz: 0,
        outputSampleRateHz: 48_000,
        totalMediaFrames: 48_000,
      }),
    ).toThrow(RangeError);

    const timeline = createStreamingMediaTimeline({
      mediaSampleRateHz: 48_000,
      outputSampleRateHz: 48_000,
      totalMediaFrames: 48_000,
    });
    expect(() => mediaFrameAtPosition(timeline, Number.NaN)).toThrow(RangeError);
    expect(() => outputFrameAtMediaFrame(timeline, 48_001)).toThrow(RangeError);
  });
});
