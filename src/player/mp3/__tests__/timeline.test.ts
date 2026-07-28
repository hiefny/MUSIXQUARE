import { describe, expect, it } from 'vitest';

import {
  MPG123_DECODER_DELAY_SAMPLES,
  createMp3SampleTimeline,
  locateMp3MediaFrame,
  planMp3DecodeGeneration,
  type Mp3SampleTimeline,
  type Mp3SampleTimelineOptions,
} from '../timeline.ts';

describe('createMp3SampleTimeline', () => {
  it.each([
    [
      'MPEG-1, padding below 529',
      1_152,
      { encoderDelaySamples: 576, endPaddingSamples: 500 },
      1_105,
      0,
      21_935,
    ],
    [
      'MPEG-2, padding above 529',
      576,
      { encoderDelaySamples: 576, endPaddingSamples: 774 },
      1_105,
      245,
      10_170,
    ],
    [
      'MPEG-2.5, padding equal to 529',
      576,
      { encoderDelaySamples: 0, endPaddingSamples: 529 },
      529,
      0,
      10_991,
    ],
    ['untrusted/no tag', 1_152, null, 0, 0, 23_040],
  ] as const)(
    'normalizes the measured decoder-delay contract for %s',
    (_label, samplesPerFrame, gapless, headTrimSamples, tailTrimSamples, totalMediaFrames) => {
      const totalRawSamples = samplesPerFrame * 20;
      expect(createMp3SampleTimeline({ totalRawSamples, samplesPerFrame, gapless })).toEqual({
        totalRawSamples,
        samplesPerFrame,
        headTrimSamples,
        tailTrimSamples,
        rawEofSampleExclusive: totalRawSamples - tailTrimSamples,
        totalMediaFrames,
      });
    },
  );

  it('keeps the complete raw timeline when no gapless timing is trusted', () => {
    const timeline = createMp3SampleTimeline({
      totalRawSamples: 10 * 1_152,
      samplesPerFrame: 1_152,
      gapless: null,
    });

    expect(timeline).toEqual({
      totalRawSamples: 11_520,
      samplesPerFrame: 1_152,
      headTrimSamples: 0,
      tailTrimSamples: 0,
      rawEofSampleExclusive: 11_520,
      totalMediaFrames: 11_520,
    });
    expect(Object.isFrozen(timeline)).toBe(true);
  });

  it('moves the decoder delay to the head without double-trimming short padding', () => {
    const timeline = createMp3SampleTimeline({
      totalRawSamples: 10 * 1_152,
      samplesPerFrame: 1_152,
      gapless: { encoderDelaySamples: 576, endPaddingSamples: 500 },
    });

    expect(MPG123_DECODER_DELAY_SAMPLES).toBe(529);
    expect(timeline).toEqual({
      totalRawSamples: 11_520,
      samplesPerFrame: 1_152,
      headTrimSamples: 1_105,
      tailTrimSamples: 0,
      rawEofSampleExclusive: 11_520,
      totalMediaFrames: 10_415,
    });
  });

  it('preserves the established D+P duration when padding covers the decoder delay', () => {
    const timeline = createMp3SampleTimeline({
      totalRawSamples: 10 * 576,
      samplesPerFrame: 576,
      gapless: { encoderDelaySamples: 100, endPaddingSamples: 774 },
    });

    expect(timeline).toEqual({
      totalRawSamples: 5_760,
      samplesPerFrame: 576,
      headTrimSamples: 629,
      tailTrimSamples: 245,
      rawEofSampleExclusive: 5_515,
      totalMediaFrames: 4_886,
    });
    expect(timeline.totalMediaFrames).toBe(timeline.totalRawSamples - 100 - 774);
  });

  it.each([
    [{ totalRawSamples: 0, samplesPerFrame: 1_152, gapless: null }, /positive whole number/i],
    [{ totalRawSamples: 1_153, samplesPerFrame: 1_152, gapless: null }, /whole number/i],
    [{ totalRawSamples: 1_152, samplesPerFrame: 1_000, gapless: null }, /576 or 1,152/i],
    [
      {
        totalRawSamples: 1_152,
        samplesPerFrame: 1_152,
        gapless: { encoderDelaySamples: -1, endPaddingSamples: 0 },
      },
      /encoderDelaySamples/i,
    ],
    [
      {
        totalRawSamples: 1_152,
        samplesPerFrame: 1_152,
        gapless: { encoderDelaySamples: 700, endPaddingSamples: 0 },
      },
      /no audible media frames/i,
    ],
  ] as const)('rejects invalid exact timeline geometry %#', (options, expected) => {
    // The malformed rows intentionally cross the public type boundary to
    // verify that untrusted runtime input is still rejected.
    expect(() => createMp3SampleTimeline(options as Mp3SampleTimelineOptions)).toThrow(expected);
  });
});

describe('MP3 media and generation coordinates', () => {
  const timeline = createMp3SampleTimeline({
    totalRawSamples: 10 * 1_152,
    samplesPerFrame: 1_152,
    gapless: { encoderDelaySamples: 576, endPaddingSamples: 774 },
  });

  it('maps audible frames and the exclusive EOF onto exact raw coordinates', () => {
    expect(locateMp3MediaFrame(timeline, 0)).toEqual({
      mediaFrame: 0,
      rawSample: 1_105,
      audioFrameOrdinal: 0,
      sampleWithinAudioFrame: 1_105,
    });
    expect(locateMp3MediaFrame(timeline, 47)).toEqual({
      mediaFrame: 47,
      rawSample: 1_152,
      audioFrameOrdinal: 1,
      sampleWithinAudioFrame: 0,
    });
    expect(locateMp3MediaFrame(timeline, timeline.totalMediaFrames)).toEqual({
      mediaFrame: timeline.totalMediaFrames,
      rawSample: timeline.rawEofSampleExclusive,
      audioFrameOrdinal: 9,
      sampleWithinAudioFrame: 907,
    });
    expect(Object.isFrozen(locateMp3MediaFrame(timeline, 0))).toBe(true);
  });

  it('represents an untrimmed frame-boundary EOF as a terminal one-past ordinal', () => {
    const untrimmed = createMp3SampleTimeline({
      totalRawSamples: 10 * 1_152,
      samplesPerFrame: 1_152,
      gapless: null,
    });

    expect(locateMp3MediaFrame(untrimmed, untrimmed.totalMediaFrames)).toEqual({
      mediaFrame: 11_520,
      rawSample: 11_520,
      audioFrameOrdinal: 10,
      sampleWithinAudioFrame: 0,
    });
    expect(() => planMp3DecodeGeneration(untrimmed, untrimmed.totalMediaFrames, 9)).toThrow(
      /exclusive EOF.*decode generation/i,
    );
  });

  it('turns a chosen prelude ordinal into an exact generation discard', () => {
    const plan = planMp3DecodeGeneration(timeline, 2_400, 1);

    expect(plan).toEqual({
      mediaFrame: 2_400,
      rawSample: 3_505,
      audioFrameOrdinal: 3,
      sampleWithinAudioFrame: 49,
      preludeAudioFrameOrdinal: 1,
      preludeRawSample: 1_152,
      discardSamples: 2_353,
    });
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it('rejects media coordinates and preludes outside their exact bounds', () => {
    expect(() => locateMp3MediaFrame(timeline, -1)).toThrow(/mediaFrame/i);
    expect(() => locateMp3MediaFrame(timeline, timeline.totalMediaFrames + 1)).toThrow(/outside/i);
    expect(() => planMp3DecodeGeneration(timeline, 0, 1)).toThrow(/after its target/i);
    expect(() => planMp3DecodeGeneration(timeline, 0, 0.5)).toThrow(/preludeAudioFrameOrdinal/i);
  });

  it.each([
    [{ ...timeline, samplesPerFrame: 0 }, /samplesPerFrame/i],
    [{ ...timeline, samplesPerFrame: Number.NaN }, /samplesPerFrame/i],
    [{ ...timeline, rawEofSampleExclusive: timeline.rawEofSampleExclusive + 1 }, /geometry/i],
    [{ ...timeline, totalMediaFrames: timeline.totalMediaFrames - 1 }, /geometry/i],
  ] as const)('rejects a forged or corrupted timeline %#', (forged, expected) => {
    expect(() => locateMp3MediaFrame(forged as unknown as Mp3SampleTimeline, 0)).toThrow(expected);
  });
});
