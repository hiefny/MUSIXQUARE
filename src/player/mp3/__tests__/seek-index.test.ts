import { describe, expect, it } from 'vitest';

import { MpegLayer3SeekIndex, type MpegLayer3SeekIndexOptions } from '../seek-index.ts';

const SAMPLES_PER_FRAME = 1_152;
const FRAME_BYTES = 100;
const MAIN_DATA_CAPACITY_BYTES = 62;
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
    firstFrameMainDataCapacityBytes: MAIN_DATA_CAPACITY_BYTES,
    firstFrameMainDataBeginBytes: 0,
    ...overrides,
  };
}

function addFrame(
  index: MpegLayer3SeekIndex,
  ordinal: number,
  mainDataCapacityBytes = MAIN_DATA_CAPACITY_BYTES,
  mainDataBeginBytes = 0,
) {
  return index.addVerifiedFrame(
    ordinal * SAMPLES_PER_FRAME,
    FIRST_AUDIO_FRAME_OFFSET + ordinal * FRAME_BYTES,
    ordinal,
    mainDataCapacityBytes,
    mainDataBeginBytes,
  );
}

describe('MpegLayer3SeekIndex', () => {
  it('constructs one immutable origin descriptor without retaining encoded media', () => {
    const index = new MpegLayer3SeekIndex(options());

    expect(index.origin).toEqual({
      rawSample: 0,
      byteOffset: FIRST_AUDIO_FRAME_OFFSET,
      frameOrdinal: 0,
      mainDataCapacityBytes: MAIN_DATA_CAPACITY_BYTES,
      mainDataBeginBytes: 0,
    });
    expect(Object.isFrozen(index.origin)).toBe(true);
    expect(index.snapshot()).toEqual([index.origin]);
    expect(Object.isFrozen(index.snapshot())).toBe(true);
    expect(Object.keys(index.origin)).toEqual([
      'rawSample',
      'byteOffset',
      'frameOrdinal',
      'mainDataCapacityBytes',
      'mainDataBeginBytes',
    ]);
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
    [{ firstFrameMainDataCapacityBytes: 0 }, 'main-data capacity'],
    [{ firstFrameMainDataCapacityBytes: 1.5 }, 'main-data capacity'],
    [{ firstFrameMainDataBeginBytes: 1 }, 'main_data_begin'],
    [{ maxPoints: 1_023 }, 'maxPoints'],
    [{ maxPoints: 8_193 }, 'maxPoints'],
    [{ maxPoints: 1_024.5 }, 'maxPoints'],
  ] satisfies ReadonlyArray<[Partial<MpegLayer3SeekIndexOptions>, string]>)(
    'rejects invalid constructor geometry %#',
    (overrides, message) => {
      expect(() => new MpegLayer3SeekIndex(options(overrides))).toThrow(message);
    },
  );

  it('rejects impossible audio spans and a mismatched single-frame capacity', () => {
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
    expect(
      () =>
        new MpegLayer3SeekIndex({
          sourceSize: 1_100,
          firstAudioFrameOffset: 1_000,
          audioEndByteOffset: 1_100,
          totalRawSamples: SAMPLES_PER_FRAME,
          samplesPerFrame: SAMPLES_PER_FRAME,
          firstFrameMainDataCapacityBytes: 61,
          firstFrameMainDataBeginBytes: 0,
        }),
    ).toThrow('main-data capacity');
  });

  it('adds exact verified descriptors in either discovery order', () => {
    const index = new MpegLayer3SeekIndex(options());

    expect(addFrame(index, 2)).toBe(true);
    expect(addFrame(index, 1)).toBe(true);
    expect(addFrame(index, 5)).toBe(true);
    expect(index.snapshot()).toEqual([
      {
        rawSample: 0,
        byteOffset: 1_000,
        frameOrdinal: 0,
        mainDataCapacityBytes: 62,
        mainDataBeginBytes: 0,
      },
      {
        rawSample: 1_152,
        byteOffset: 1_100,
        frameOrdinal: 1,
        mainDataCapacityBytes: 62,
        mainDataBeginBytes: 0,
      },
      {
        rawSample: 2_304,
        byteOffset: 1_200,
        frameOrdinal: 2,
        mainDataCapacityBytes: 62,
        mainDataBeginBytes: 0,
      },
      {
        rawSample: 5_760,
        byteOffset: 1_500,
        frameOrdinal: 5,
        mainDataCapacityBytes: 62,
        mainDataBeginBytes: 0,
      },
    ]);
  });

  it('rejects invalid candidates and exact-capacity/frame-span mismatches', () => {
    const index = new MpegLayer3SeekIndex(options());

    const candidates = [
      [-1, 1_100, 1, 62, 0],
      [Number.NaN, 1_100, 1, 62, 0],
      [1_152, -1, 1, 62, 0],
      [1_152, Number.MAX_SAFE_INTEGER + 1, 1, 62, 0],
      [1_152, 1_100, -1, 62, 0],
      [1_152, 1_100, 1.5, 62, 0],
      [1_153, 1_100, 1, 62, 0],
      [1_152, 999, 1, 62, 0],
      [1_152, 11_000, 1, 62, 0],
      [1_152, 1_100, 1, 0, 0],
      [1_152, 1_100, 1, 1.5, 0],
      [1_152, 1_100, 1, 62, 512],
      [115_200, 10_900, 100, 62, 0],
    ] as const;
    for (const candidate of candidates) {
      expect(index.addVerifiedFrame(...candidate)).toBe(false);
    }

    expect(addFrame(index, 2)).toBe(true);
    expect(addFrame(index, 2)).toBe(false);
    expect(index.addVerifiedFrame(2_304, 1_201, 2, 62, 0)).toBe(false);
    expect(index.addVerifiedFrame(0, 1_001, 0, 62, 0)).toBe(false);
    expect(index.addVerifiedFrame(1_152, 1_100, 1, 61, 0)).toBe(false);

    // Two MPEG-1 Layer III frames require at least 192 bytes and at most 2,882.
    expect(index.addVerifiedFrame(4_608, 1_391, 4, 62, 0)).toBe(false);
    expect(index.addVerifiedFrame(4_608, 4_083, 4, 62, 0)).toBe(false);
  });

  it('finds exact nearest points and brackets without estimated boundaries', () => {
    const index = new MpegLayer3SeekIndex(options());
    addFrame(index, 10);
    addFrame(index, 20);

    expect(index.nearestBefore(20 * SAMPLES_PER_FRAME - 1)).toEqual({
      rawSample: 10 * SAMPLES_PER_FRAME,
      byteOffset: 2_000,
      frameOrdinal: 10,
      mainDataCapacityBytes: 62,
      mainDataBeginBytes: 0,
    });
    expect(index.bracket(10 * SAMPLES_PER_FRAME)).toEqual({
      before: {
        rawSample: 10 * SAMPLES_PER_FRAME,
        byteOffset: 2_000,
        frameOrdinal: 10,
        mainDataCapacityBytes: 62,
        mainDataBeginBytes: 0,
      },
      after: {
        rawSample: 20 * SAMPLES_PER_FRAME,
        byteOffset: 3_000,
        frameOrdinal: 20,
        mainDataCapacityBytes: 62,
        mainDataBeginBytes: 0,
      },
    });
    expect(index.bracket(99 * SAMPLES_PER_FRAME).after).toBeNull();
    expect(() => index.nearestBefore(-1)).toThrow(RangeError);
    expect(() => index.bracket(100 * SAMPLES_PER_FRAME + 1)).toThrow(RangeError);
  });

  it('secures warmup first, then satisfies the warmup-start reservoir exactly', () => {
    const index = new MpegLayer3SeekIndex(options());
    for (let ordinal = 1; ordinal <= 30; ordinal += 1) {
      addFrame(index, ordinal, MAIN_DATA_CAPACITY_BYTES, ordinal === 14 ? 200 : 0);
    }

    const defaultPrelude = index.reservoirPrelude(30 * SAMPLES_PER_FRAME);
    expect(defaultPrelude).toMatchObject({
      kind: 'verified-history',
      minimumWarmupFrames: 16,
      warmupStart: { frameOrdinal: 14, mainDataBeginBytes: 200 },
      warmupStartMainDataBeginBytes: 200,
      reservoirCapacityBeforeWarmupBytes: 248,
      reachedAudioOrigin: false,
    });
    expect(Object.isFrozen(defaultPrelude)).toBe(true);
    if (defaultPrelude.kind === 'verified-history') {
      expect(defaultPrelude.previousFrames.map((point) => point.frameOrdinal)).toEqual(
        Array.from({ length: 20 }, (_, index) => index + 10),
      );
      expect(Object.isFrozen(defaultPrelude.previousFrames)).toBe(true);
    }
  });

  it('uses target main_data_begin when the requested synthesis warmup is zero', () => {
    const index = new MpegLayer3SeekIndex(options());
    for (let ordinal = 1; ordinal <= 20; ordinal += 1) {
      addFrame(index, ordinal, MAIN_DATA_CAPACITY_BYTES, ordinal === 20 ? 124 : 0);
    }

    const prelude = index.reservoirPrelude(20 * SAMPLES_PER_FRAME, 0);
    expect(prelude).toMatchObject({
      kind: 'verified-history',
      minimumWarmupFrames: 0,
      warmupStart: { frameOrdinal: 20, mainDataBeginBytes: 124 },
      warmupStartMainDataBeginBytes: 124,
      reservoirCapacityBeforeWarmupBytes: 124,
      reachedAudioOrigin: false,
    });
    if (prelude.kind === 'verified-history') {
      expect(prelude.previousFrames.map((point) => point.frameOrdinal)).toEqual([18, 19]);
    }

    const noHistory = index.reservoirPrelude(19 * SAMPLES_PER_FRAME, 0);
    expect(noHistory).toMatchObject({
      kind: 'verified-history',
      previousFrames: [],
      reservoirCapacityBeforeWarmupBytes: 0,
    });
  });

  it('stops at the audio origin when the full warmup cannot exist', () => {
    const index = new MpegLayer3SeekIndex(options());
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) addFrame(index, ordinal);

    const prelude = index.reservoirPrelude(3 * SAMPLES_PER_FRAME);
    expect(prelude).toMatchObject({
      kind: 'verified-history',
      minimumWarmupFrames: 16,
      warmupStart: { frameOrdinal: 0 },
      warmupStartMainDataBeginBytes: 0,
      reservoirCapacityBeforeWarmupBytes: 0,
      reachedAudioOrigin: true,
    });
    if (prelude.kind === 'verified-history') {
      expect(prelude.previousFrames.map((point) => point.frameOrdinal)).toEqual([0, 1, 2]);
    }

    expect(index.reservoirPrelude(0)).toMatchObject({
      kind: 'verified-history',
      previousFrames: [],
      reachedAudioOrigin: true,
    });
  });

  it('fails closed when origin history cannot satisfy a malformed reservoir pointer', () => {
    const index = new MpegLayer3SeekIndex(options());
    addFrame(index, 1);
    addFrame(index, 2);
    addFrame(index, 3, MAIN_DATA_CAPACITY_BYTES, 200);

    expect(() => index.reservoirPrelude(3 * SAMPLES_PER_FRAME, 0)).toThrow(
      /main_data_begin exceeds all available/i,
    );
  });

  it('supports the lower-generation 255-byte reservoir with exact one-byte capacities', () => {
    const samplesPerFrame = 576 as const;
    const frameBytes = 24;
    const totalFrames = 400;
    const index = new MpegLayer3SeekIndex({
      sourceSize: FIRST_AUDIO_FRAME_OFFSET + totalFrames * frameBytes,
      firstAudioFrameOffset: FIRST_AUDIO_FRAME_OFFSET,
      audioEndByteOffset: FIRST_AUDIO_FRAME_OFFSET + totalFrames * frameBytes,
      totalRawSamples: totalFrames * samplesPerFrame,
      samplesPerFrame,
      firstFrameMainDataCapacityBytes: 1,
      firstFrameMainDataBeginBytes: 0,
    });
    for (let ordinal = 1; ordinal <= 300; ordinal += 1) {
      expect(
        index.addVerifiedFrame(
          ordinal * samplesPerFrame,
          FIRST_AUDIO_FRAME_OFFSET + ordinal * frameBytes,
          ordinal,
          1,
          ordinal === 300 ? 255 : 0,
        ),
      ).toBe(true);
    }

    const prelude = index.reservoirPrelude(300 * samplesPerFrame, 0);
    expect(prelude).toMatchObject({
      kind: 'verified-history',
      warmupStartMainDataBeginBytes: 255,
      reservoirCapacityBeforeWarmupBytes: 255,
      reachedAudioOrigin: false,
    });
    if (prelude.kind === 'verified-history') {
      expect(prelude.previousFrames).toHaveLength(255);
      expect(prelude.previousFrames[0]?.frameOrdinal).toBe(45);
    }
    expect(
      index.addVerifiedFrame(
        301 * samplesPerFrame,
        FIRST_AUDIO_FRAME_OFFSET + 301 * frameBytes,
        301,
        1,
        256,
      ),
    ).toBe(false);
  });

  it('returns a bounded scanner plan from an exact earlier anchor when history has a gap', () => {
    const index = new MpegLayer3SeekIndex(options());
    addFrame(index, 4);
    addFrame(index, 8);
    addFrame(index, 10);

    const exactTarget = index.reservoirPrelude(10 * SAMPLES_PER_FRAME, 4);
    expect(exactTarget).toEqual({
      kind: 'scan-from-anchor',
      targetRawSample: 11_520,
      targetFrameOrdinal: 10,
      anchor: {
        rawSample: 0,
        byteOffset: 1_000,
        frameOrdinal: 0,
        mainDataCapacityBytes: 62,
        mainDataBeginBytes: 0,
      },
      minimumWarmupFrames: 4,
      warmupFrameLimit: 4,
      reservoirFrameLimit: 6,
      historyFrameLimit: 10,
    });
    expect(Object.isFrozen(exactTarget)).toBe(true);

    expect(index.reservoirPrelude(9 * SAMPLES_PER_FRAME, 4)).toMatchObject({
      kind: 'scan-from-anchor',
      targetFrameOrdinal: 9,
      anchor: { frameOrdinal: 0 },
      warmupFrameLimit: 4,
      reservoirFrameLimit: 5,
      historyFrameLimit: 9,
    });
  });

  it('validates warmup and exact target boundaries', () => {
    const index = new MpegLayer3SeekIndex(options());

    expect(() => index.reservoirPrelude(1)).toThrow('frame boundary');
    expect(() => index.reservoirPrelude(100 * SAMPLES_PER_FRAME)).toThrow('sample range');
    expect(() => index.reservoirPrelude(0, -1)).toThrow('between 0 and 511');
    expect(() => index.reservoirPrelude(0, 512)).toThrow('between 0 and 511');
    expect(() => index.reservoirPrelude(0, 1.5)).toThrow('between 0 and 511');
  });

  it('compacts deterministically while preserving warmup plus reservoir tail descriptors', () => {
    const totalFrames = 5_000;
    const longOptions = options({
      sourceSize: FIRST_AUDIO_FRAME_OFFSET + totalFrames * FRAME_BYTES,
      audioEndByteOffset: FIRST_AUDIO_FRAME_OFFSET + totalFrames * FRAME_BYTES,
      totalRawSamples: totalFrames * SAMPLES_PER_FRAME,
      maxPoints: 1_024,
    });
    const first = new MpegLayer3SeekIndex(longOptions);
    const second = new MpegLayer3SeekIndex(longOptions);
    const targetOrdinal = totalFrames - 1;
    const warmupStartOrdinal = targetOrdinal - 511;

    for (let ordinal = 1; ordinal < totalFrames; ordinal += 1) {
      const mainDataBeginBytes = ordinal === warmupStartOrdinal ? 511 : 0;
      expect(addFrame(first, ordinal, MAIN_DATA_CAPACITY_BYTES, mainDataBeginBytes)).toBe(true);
      expect(addFrame(second, ordinal, MAIN_DATA_CAPACITY_BYTES, mainDataBeginBytes)).toBe(true);
    }

    const snapshot = first.snapshot();
    expect(snapshot.length).toBeLessThanOrEqual(1_024);
    expect(snapshot).toEqual(second.snapshot());
    expect(snapshot[0]).toEqual({
      rawSample: 0,
      byteOffset: 1_000,
      frameOrdinal: 0,
      mainDataCapacityBytes: 62,
      mainDataBeginBytes: 0,
    });
    expect(snapshot.at(-1)?.frameOrdinal).toBe(totalFrames - 1);

    const prelude = first.reservoirPrelude(targetOrdinal * SAMPLES_PER_FRAME, 511);
    expect(prelude.kind).toBe('verified-history');
    if (prelude.kind === 'verified-history') {
      expect(prelude.previousFrames).toHaveLength(520);
      expect(prelude.previousFrames[0]?.frameOrdinal).toBe(targetOrdinal - 520);
      expect(prelude.previousFrames.at(-1)?.frameOrdinal).toBe(totalFrames - 2);
      expect(prelude.warmupStart.frameOrdinal).toBe(warmupStartOrdinal);
      expect(prelude.reservoirCapacityBeforeWarmupBytes).toBe(9 * MAIN_DATA_CAPACITY_BYTES);
    }
  });
});
