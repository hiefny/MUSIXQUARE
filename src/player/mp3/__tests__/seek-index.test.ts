import { describe, expect, it } from 'vitest';

import { MpegLayer3SeekIndex, type MpegLayer3SeekIndexOptions } from '../seek-index.ts';

const SAMPLES_PER_FRAME = 1_152;
const FRAME_BYTES = 100;
const FIRST_AUDIO_FRAME_OFFSET = 1_000;

function options(overrides: Partial<MpegLayer3SeekIndexOptions> = {}): MpegLayer3SeekIndexOptions {
  const totalFrames = 100;
  const audioEndByteOffset = FIRST_AUDIO_FRAME_OFFSET + totalFrames * FRAME_BYTES;
  return {
    sourceSize: audioEndByteOffset + 128,
    firstAudioFrameOffset: FIRST_AUDIO_FRAME_OFFSET,
    audioEndByteOffset,
    totalRawSamples: totalFrames * SAMPLES_PER_FRAME,
    samplesPerFrame: SAMPLES_PER_FRAME,
    ...overrides,
  };
}

function addFrame(index: MpegLayer3SeekIndex, ordinal: number, bytesPerFrame = FRAME_BYTES) {
  return index.addVerifiedFrame(
    ordinal * SAMPLES_PER_FRAME,
    FIRST_AUDIO_FRAME_OFFSET + ordinal * bytesPerFrame,
    ordinal,
  );
}

describe('MpegLayer3SeekIndex', () => {
  it('constructs one immutable origin without retaining encoded media', () => {
    const index = new MpegLayer3SeekIndex(options());

    expect(index.origin).toEqual({
      rawSample: 0,
      byteOffset: FIRST_AUDIO_FRAME_OFFSET,
      frameOrdinal: 0,
    });
    expect(Object.isFrozen(index.origin)).toBe(true);
    expect(index.snapshot()).toEqual([index.origin]);
    expect(Object.isFrozen(index.snapshot())).toBe(true);
    expect(Object.keys(index.origin)).toEqual(['rawSample', 'byteOffset', 'frameOrdinal']);
  });

  it.each([
    [{ sourceSize: 0 }, 'source size'],
    [{ sourceSize: Number.MAX_SAFE_INTEGER + 1 }, 'source size'],
    [{ firstAudioFrameOffset: -1 }, 'audio span'],
    [{ firstAudioFrameOffset: 11_000 }, 'audio span'],
    [{ audioEndByteOffset: 12_000 }, 'audio span'],
    [{ totalRawSamples: 0 }, 'raw sample count'],
    [{ totalRawSamples: SAMPLES_PER_FRAME + 1 }, 'raw sample count'],
    [{ samplesPerFrame: 1_000 as 1_152 }, 'samplesPerFrame'],
    [{ maxPoints: 31 }, 'maxPoints'],
    [{ maxPoints: 32.5 }, 'maxPoints'],
  ] satisfies ReadonlyArray<[Partial<MpegLayer3SeekIndexOptions>, string]>)(
    'rejects invalid constructor geometry %#',
    (overrides, message) => {
      expect(() => new MpegLayer3SeekIndex(options(overrides))).toThrow(message);
    },
  );

  it('rejects audio spans that cannot contain the declared MPEG frames', () => {
    expect(
      () =>
        new MpegLayer3SeekIndex(
          options({
            audioEndByteOffset: FIRST_AUDIO_FRAME_OFFSET + 100 * 95,
            sourceSize: FIRST_AUDIO_FRAME_OFFSET + 100 * 95,
          }),
        ),
    ).toThrow('audio span');
    expect(
      () =>
        new MpegLayer3SeekIndex(
          options({
            audioEndByteOffset: FIRST_AUDIO_FRAME_OFFSET + 100 * 1_442,
            sourceSize: FIRST_AUDIO_FRAME_OFFSET + 100 * 1_442,
          }),
        ),
    ).toThrow('audio span');
  });

  it('adds exact verified points in either discovery order', () => {
    const index = new MpegLayer3SeekIndex(options());

    expect(addFrame(index, 2)).toBe(true);
    expect(addFrame(index, 1)).toBe(true);
    expect(addFrame(index, 5)).toBe(true);
    expect(index.snapshot()).toEqual([
      { rawSample: 0, byteOffset: 1_000, frameOrdinal: 0 },
      { rawSample: 1_152, byteOffset: 1_100, frameOrdinal: 1 },
      { rawSample: 2_304, byteOffset: 1_200, frameOrdinal: 2 },
      { rawSample: 5_760, byteOffset: 1_500, frameOrdinal: 5 },
    ]);
  });

  it.each([
    [-1, 1_100, 1],
    [Number.NaN, 1_100, 1],
    [1_152, -1, 1],
    [1_152, Number.MAX_SAFE_INTEGER + 1, 1],
    [1_152, 1_100, -1],
    [1_152, 1_100, 1.5],
    [1_153, 1_100, 1],
    [1_152, 999, 1],
    [1_152, 11_000, 1],
    [115_200, 10_900, 100],
  ])('rejects an invalid verified candidate %#', (rawSample, byteOffset, frameOrdinal) => {
    const index = new MpegLayer3SeekIndex(options());
    expect(index.addVerifiedFrame(rawSample, byteOffset, frameOrdinal)).toBe(false);
    expect(index.snapshot()).toHaveLength(1);
  });

  it('rejects duplicates, origin replacement, and impossible byte geometry', () => {
    const index = new MpegLayer3SeekIndex(options());

    expect(addFrame(index, 2)).toBe(true);
    expect(addFrame(index, 2)).toBe(false);
    expect(index.addVerifiedFrame(2_304, 1_201, 2)).toBe(false);
    expect(index.addVerifiedFrame(0, 1_001, 0)).toBe(false);

    // Two MPEG-1 Layer III frames require at least 192 bytes.
    expect(index.addVerifiedFrame(4_608, 1_391, 4)).toBe(false);
    // Two frames can occupy at most 2,882 bytes.
    expect(index.addVerifiedFrame(4_608, 4_083, 4)).toBe(false);
  });

  it('finds exact nearest points and brackets without estimated boundaries', () => {
    const index = new MpegLayer3SeekIndex(options());
    addFrame(index, 10);
    addFrame(index, 20);

    expect(index.nearestBefore(20 * SAMPLES_PER_FRAME - 1)).toEqual({
      rawSample: 10 * SAMPLES_PER_FRAME,
      byteOffset: 2_000,
      frameOrdinal: 10,
    });
    expect(index.bracket(10 * SAMPLES_PER_FRAME)).toEqual({
      before: { rawSample: 10 * SAMPLES_PER_FRAME, byteOffset: 2_000, frameOrdinal: 10 },
      after: { rawSample: 20 * SAMPLES_PER_FRAME, byteOffset: 3_000, frameOrdinal: 20 },
    });
    expect(index.bracket(99 * SAMPLES_PER_FRAME)).toEqual({
      before: { rawSample: 20 * SAMPLES_PER_FRAME, byteOffset: 3_000, frameOrdinal: 20 },
      after: null,
    });
    expect(index.nearestBefore(100 * SAMPLES_PER_FRAME)).toEqual({
      rawSample: 20 * SAMPLES_PER_FRAME,
      byteOffset: 3_000,
      frameOrdinal: 20,
    });
    expect(() => index.nearestBefore(-1)).toThrow(RangeError);
    expect(() => index.bracket(100 * SAMPLES_PER_FRAME + 1)).toThrow(RangeError);
  });

  it('returns up to sixteen contiguous verified predecessor offsets', () => {
    const index = new MpegLayer3SeekIndex(options());
    for (let ordinal = 1; ordinal <= 20; ordinal += 1) addFrame(index, ordinal);

    const prelude = index.reservoirPrelude(20 * SAMPLES_PER_FRAME);
    expect(prelude).toEqual({
      kind: 'verified-history',
      target: { rawSample: 23_040, byteOffset: 3_000, frameOrdinal: 20 },
      previousFrameOffsets: Array.from({ length: 16 }, (_, index) => 1_400 + index * 100),
    });
    expect(Object.isFrozen(prelude)).toBe(true);
    if (prelude.kind === 'verified-history') {
      expect(Object.isFrozen(prelude.previousFrameOffsets)).toBe(true);
    }

    expect(index.reservoirPrelude(3 * SAMPLES_PER_FRAME)).toEqual({
      kind: 'verified-history',
      target: { rawSample: 3_456, byteOffset: 1_300, frameOrdinal: 3 },
      previousFrameOffsets: [1_000, 1_100, 1_200],
    });
  });

  it('requires a scanner walk from an exact earlier anchor when history has a gap', () => {
    const index = new MpegLayer3SeekIndex(options());
    addFrame(index, 4);
    addFrame(index, 8);
    addFrame(index, 10);

    expect(index.reservoirPrelude(10 * SAMPLES_PER_FRAME, 4)).toEqual({
      kind: 'scan-from-anchor',
      targetRawSample: 11_520,
      targetFrameOrdinal: 10,
      anchor: { rawSample: 4_608, byteOffset: 1_400, frameOrdinal: 4 },
      requiredPreviousFrames: 4,
    });
    expect(index.reservoirPrelude(9 * SAMPLES_PER_FRAME, 4)).toEqual({
      kind: 'scan-from-anchor',
      targetRawSample: 10_368,
      targetFrameOrdinal: 9,
      anchor: { rawSample: 4_608, byteOffset: 1_400, frameOrdinal: 4 },
      requiredPreviousFrames: 4,
    });
  });

  it('validates reservoir targets and the hard sixteen-frame bound', () => {
    const index = new MpegLayer3SeekIndex(options());

    expect(index.reservoirPrelude(0)).toEqual({
      kind: 'verified-history',
      target: index.origin,
      previousFrameOffsets: [],
    });
    expect(() => index.reservoirPrelude(1)).toThrow('frame boundary');
    expect(() => index.reservoirPrelude(100 * SAMPLES_PER_FRAME)).toThrow('sample range');
    expect(() => index.reservoirPrelude(0, -1)).toThrow('between 0 and 16');
    expect(() => index.reservoirPrelude(0, 17)).toThrow('between 0 and 16');
    expect(() => index.reservoirPrelude(0, 1.5)).toThrow('between 0 and 16');
  });

  it('compacts deterministically within a fixed memory bound using verified points only', () => {
    const longOptions = options({
      sourceSize: FIRST_AUDIO_FRAME_OFFSET + 50_000 * FRAME_BYTES,
      audioEndByteOffset: FIRST_AUDIO_FRAME_OFFSET + 50_000 * FRAME_BYTES,
      totalRawSamples: 50_000 * SAMPLES_PER_FRAME,
      maxPoints: 32,
    });
    const first = new MpegLayer3SeekIndex(longOptions);
    const second = new MpegLayer3SeekIndex(longOptions);

    for (let ordinal = 1; ordinal < 50_000; ordinal += 1) {
      expect(addFrame(first, ordinal)).toBe(true);
      expect(addFrame(second, ordinal)).toBe(true);
    }

    const snapshot = first.snapshot();
    expect(snapshot.length).toBeLessThanOrEqual(32);
    expect(snapshot).toEqual(second.snapshot());
    expect(snapshot[0]).toEqual({ rawSample: 0, byteOffset: 1_000, frameOrdinal: 0 });
    expect(snapshot.at(-1)).toEqual({
      rawSample: 49_999 * SAMPLES_PER_FRAME,
      byteOffset: FIRST_AUDIO_FRAME_OFFSET + 49_999 * FRAME_BYTES,
      frameOrdinal: 49_999,
    });
    expect(
      snapshot.every(
        (point) =>
          point.rawSample === point.frameOrdinal * SAMPLES_PER_FRAME &&
          point.byteOffset === FIRST_AUDIO_FRAME_OFFSET + point.frameOrdinal * FRAME_BYTES,
      ),
    ).toBe(true);

    const prelude = first.reservoirPrelude(49_999 * SAMPLES_PER_FRAME);
    expect(prelude.kind).toBe('verified-history');
    if (prelude.kind === 'verified-history') {
      expect(prelude.previousFrameOffsets).toHaveLength(16);
      expect(prelude.previousFrameOffsets.at(-1)).toBe(
        FIRST_AUDIO_FRAME_OFFSET + 49_998 * FRAME_BYTES,
      );
    }
  });
});
