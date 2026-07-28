import { describe, expect, it } from 'vitest';

import type { FlacMetadata } from '../flac/metadata.ts';
import { FlacSeekIndex } from '../flac/seek-index.ts';

function metadata(seekPoints: FlacMetadata['seekPoints'] = []): FlacMetadata {
  return {
    streamInfo: {
      minBlockSize: 4096,
      maxBlockSize: 4096,
      minFrameSize: 18,
      maxFrameSize: 20_000,
      sampleRate: 1000,
      channels: 2,
      bitDepth: 24,
      totalSamples: 100_000,
      duration: 100,
      md5: '0'.repeat(32),
    },
    seekPoints,
    firstAudioFrameOffset: 1_000,
    metadataBlockCount: 1,
  };
}

describe('FlacSeekIndex', () => {
  it('seeds absolute frame positions from relative SEEKTABLE offsets', () => {
    const index = new FlacSeekIndex(
      metadata([
        { sample: 20_000, streamOffset: 200_000, frameSamples: 4096 },
        { sample: 50_000, streamOffset: 500_000, frameSamples: 4096 },
      ]),
      1_001_000,
    );

    expect(index.snapshot()).toEqual([
      { sourceSample: 0, byteOffset: 1_000 },
      { sourceSample: 20_000, byteOffset: 201_000 },
      { sourceSample: 50_000, byteOffset: 501_000 },
    ]);
    expect(index.nearestBefore(49_999)).toEqual({ sourceSample: 20_000, byteOffset: 201_000 });
  });

  it('ignores SEEKTABLE candidates that cannot describe this exact source', () => {
    const index = new FlacSeekIndex(
      metadata([
        { sample: 20_000, streamOffset: 200_000, frameSamples: 4096 },
        { sample: 100_000, streamOffset: 600_000, frameSamples: 4096 },
        { sample: 30_000, streamOffset: 1_000_000, frameSamples: 4096 },
        { sample: 40_000, streamOffset: 400_000, frameSamples: 0 },
        { sample: 50_000, streamOffset: 500_000, frameSamples: 4097 },
        { sample: 99_000, streamOffset: 800_000, frameSamples: 4096 },
        { sample: 60_000, streamOffset: 600_000, frameSamples: 8 },
        { sample: 70_000, streamOffset: 0, frameSamples: 4096 },
        { sample: 99_998, streamOffset: 900_000, frameSamples: 2 },
      ]),
      1_001_000,
    );

    expect(index.snapshot()).toEqual([
      { sourceSample: 0, byteOffset: 1_000 },
      { sourceSample: 20_000, byteOffset: 201_000 },
      { sourceSample: 99_998, byteOffset: 901_000 },
    ]);
  });

  it('adds verified progressive frame points without filename or time identity', () => {
    const index = new FlacSeekIndex(metadata(), 1_001_000);
    expect(index.addVerifiedFrame(10_000, 101_000)).toBe(true);
    expect(index.addVerifiedFrame(20_000, 201_000)).toBe(true);
    expect(index.addVerifiedFrame(20_000, 202_000)).toBe(false);
    expect(index.addVerifiedFrame(15_000, 250_000)).toBe(false);
    expect(index.nearestBefore(19_000)).toEqual({ sourceSample: 10_000, byteOffset: 101_000 });
  });

  it('removes rejected SEEKTABLE hints and lets verified points correct them', () => {
    const rejected = new FlacSeekIndex(
      metadata([{ sample: 20_000, streamOffset: 200_000, frameSamples: 4096 }]),
      1_001_000,
    );
    expect(rejected.rejectUnverifiedCandidate(20_000, 201_000)).toBe(true);
    expect(rejected.nearestBefore(49_999)).toEqual({ sourceSample: 0, byteOffset: 1_000 });
    expect(rejected.rejectUnverifiedCandidate(20_000, 201_000)).toBe(false);

    const corrected = new FlacSeekIndex(
      metadata([{ sample: 20_000, streamOffset: 200_000, frameSamples: 4096 }]),
      1_001_000,
    );
    expect(corrected.addVerifiedFrame(20_000, 211_000)).toBe(true);
    expect(corrected.nearestBefore(49_999)).toEqual({
      sourceSample: 20_000,
      byteOffset: 211_000,
    });
    expect(corrected.rejectUnverifiedCandidate(20_000, 201_000)).toBe(false);
  });

  it('throttles dense progressive points while force-seeded seek points survive construction', () => {
    const index = new FlacSeekIndex(metadata(), 1_001_000, { minimumSpacingSeconds: 2 });
    expect(index.addVerifiedFrame(1_000, 11_000)).toBe(false);
    expect(index.addVerifiedFrame(2_000, 21_000)).toBe(true);
    expect(index.addVerifiedFrame(3_000, 31_000)).toBe(false);
  });

  it('interpolates a bounded probe window from the nearest bracket', () => {
    const index = new FlacSeekIndex(metadata(), 1_001_000);
    index.addVerifiedFrame(50_000, 501_000);

    expect(index.estimateByteOffset(25_000)).toBe(251_000);
    expect(index.probeWindow(25_000, 64_000)).toEqual({
      offset: 219_000,
      length: 64_000,
      estimatedFrameOffset: 251_000,
    });
    const end = index.probeWindow(100_000, 64_000);
    expect(end.offset + end.length).toBe(1_001_000);
  });

  it('keeps the index bounded and rejects invalid points and targets', () => {
    const index = new FlacSeekIndex(metadata(), 1_001_000, {
      maxPoints: 16,
      minimumSpacingSeconds: 0,
    });
    for (let sample = 1_000; sample < 40_000; sample += 1_000) {
      index.addVerifiedFrame(sample, 1_000 + sample * 10);
    }
    expect(index.snapshot().length).toBeLessThanOrEqual(16);
    expect(index.addVerifiedFrame(100_000, 900_000)).toBe(false);
    expect(index.addVerifiedFrame(50_000, 1_001_000)).toBe(false);
    expect(() => index.nearestBefore(-1)).toThrow(RangeError);
    expect(() => index.probeWindow(0, 0)).toThrow(RangeError);
  });
});
