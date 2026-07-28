import { describe, expect, it } from 'vitest';

import {
  M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT,
  M4A_AAC_MAX_ACCESS_UNITS,
  M4A_AAC_MAX_STTS_ENTRIES,
  M4aAacSttsAccumulator,
  normalizeM4aAacTimeline,
  type M4aAacEditEvidence,
  type M4aAacITunEvidence,
  type M4aAacSttsEvidence,
  type M4aAacTimelineNormalizationInput,
} from '../timeline.ts';

function accumulate(...runs: ReadonlyArray<readonly [number, number]>): M4aAacSttsEvidence {
  const accumulator = new M4aAacSttsAccumulator();
  for (const [sampleCount, sampleDelta] of runs) {
    accumulator.addRun(sampleCount, sampleDelta);
  }
  return accumulator.finish();
}

function input(
  stts: M4aAacSttsEvidence,
  overrides: Partial<M4aAacTimelineNormalizationInput> = {},
): M4aAacTimelineNormalizationInput {
  return {
    stts,
    sampleRateHz: 44_100,
    mdhdTimescale: 44_100,
    mdhdDurationCoreFrames: stts.presentationEndCoreFrames,
    movieTimescale: 1_000,
    trackDurationMovieTicks: 0,
    edit: null,
    iTun: null,
    ...overrides,
  };
}

describe('M4aAacSttsAccumulator', () => {
  it('accumulates ffmpeg-style full access units followed by one shortened final unit', () => {
    const evidence = accumulate([44, 1_024], [1, 68]);

    expect(evidence).toEqual({
      accessUnitCount: 45,
      presentationEndCoreFrames: 45_124,
      finalAccessUnitDelta: 68,
      entryCount: 2,
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT).toBe(1_024);
  });

  it('accepts one compact full-duration run without expanding it per access unit', () => {
    expect(accumulate([7_661, 1_024])).toEqual({
      accessUnitCount: 7_661,
      presentationEndCoreFrames: 7_844_864,
      finalAccessUnitDelta: 1_024,
      entryCount: 1,
    });
  });

  it('rejects a shortened non-final access unit without mutating the prior evidence', () => {
    const accumulator = new M4aAacSttsAccumulator();
    accumulator.addRun(1, 68);

    expect(() => accumulator.addRun(1, 1_024)).toThrow(/final logical access unit/i);
    expect(accumulator.finish()).toEqual({
      accessUnitCount: 1,
      presentationEndCoreFrames: 68,
      finalAccessUnitDelta: 68,
      entryCount: 1,
    });
  });

  it('rejects a multi-access-unit run with a shortened delta', () => {
    const accumulator = new M4aAacSttsAccumulator();
    expect(() => accumulator.addRun(2, 1_023)).toThrow(/final logical/i);
  });

  it.each([
    [0, 1_024],
    [-0, 1_024],
    [-1, 1_024],
    [1.5, 1_024],
    [Number.NaN, 1_024],
    [1, 0],
    [1, -0],
    [1, 1.5],
    [1, 1_025],
  ])('rejects an invalid run (%p, %p)', (sampleCount, sampleDelta) => {
    const accumulator = new M4aAacSttsAccumulator();
    expect(() => accumulator.addRun(sampleCount, sampleDelta)).toThrow(RangeError);
  });

  it('enforces the exact access-unit policy ceiling', () => {
    const accumulator = new M4aAacSttsAccumulator();
    accumulator.addRun(M4A_AAC_MAX_ACCESS_UNITS, 1_024);

    expect(() => accumulator.addRun(1, 1_024)).toThrow(/access-unit count exceeds/i);
    expect(accumulator.finish().accessUnitCount).toBe(M4A_AAC_MAX_ACCESS_UNITS);
  });

  it('enforces the exact stts-entry policy ceiling', () => {
    const accumulator = new M4aAacSttsAccumulator();
    for (let index = 0; index < M4A_AAC_MAX_STTS_ENTRIES; index += 1) {
      accumulator.addRun(1, 1_024);
    }

    expect(() => accumulator.addRun(1, 1_024)).toThrow(/entry count exceeds/i);
    expect(accumulator.finish().entryCount).toBe(M4A_AAC_MAX_STTS_ENTRIES);
  });

  it('rejects empty, repeated, and post-finish lifecycle operations', () => {
    const empty = new M4aAacSttsAccumulator();
    expect(() => empty.finish()).toThrow(/at least one/i);

    empty.addRun(1, 1_024);
    empty.finish();
    expect(() => empty.finish()).toThrow(/already finished/i);
    expect(() => empty.addRun(1, 1_024)).toThrow(/already finished/i);
  });
});

describe('normalizeM4aAacTimeline', () => {
  const ffmpegStts = accumulate([44, 1_024], [1, 68]);

  it('normalizes the ordinary ffmpeg 45-AU edit timeline exactly', () => {
    const edit: M4aAacEditEvidence = {
      mediaTimeCoreFrames: 1_024,
      mediaRateInteger: 1,
      mediaRateFraction: 0,
      segmentDurationMovieTicks: 1_000,
    };

    const timeline = normalizeM4aAacTimeline(input(ffmpegStts, { edit }));

    expect(timeline).toEqual({
      accessUnitCount: 45,
      sttsEntryCount: 2,
      finalAccessUnitDelta: 68,
      coreFramesPerAccessUnit: 1_024,
      rawCoreFrames: 46_080,
      presentationEndCoreFrames: 45_124,
      headTrimCoreFrames: 1_024,
      tailTrimCoreFrames: 956,
      totalMediaFrames: 44_100,
      sampleRateHz: 44_100,
    });
    expect(Object.isFrozen(timeline)).toBe(true);
  });

  it('normalizes the demo 7,661-AU iTunSMPB timeline without guessing priming', () => {
    const stts = accumulate([7_661, 1_024]);
    const iTun: M4aAacITunEvidence = {
      primingCoreFrames: 2_048,
      remainderCoreFrames: 0,
      audibleCoreFrames: 7_842_816,
    };

    expect(normalizeM4aAacTimeline(input(stts, { iTun }))).toMatchObject({
      accessUnitCount: 7_661,
      rawCoreFrames: 7_844_864,
      presentationEndCoreFrames: 7_844_864,
      headTrimCoreFrames: 2_048,
      tailTrimCoreFrames: 0,
      totalMediaFrames: 7_842_816,
    });
  });

  it('uses exact stts duration and zero head trim when no gapless evidence exists', () => {
    expect(normalizeM4aAacTimeline(input(ffmpegStts))).toMatchObject({
      rawCoreFrames: 46_080,
      presentationEndCoreFrames: 45_124,
      headTrimCoreFrames: 0,
      tailTrimCoreFrames: 956,
      totalMediaFrames: 45_124,
    });
  });

  it('accepts mutually identical edit and iTun evidence', () => {
    const edit: M4aAacEditEvidence = {
      mediaTimeCoreFrames: 1_024,
      mediaRateInteger: 1,
      mediaRateFraction: 0,
      segmentDurationMovieTicks: 1_000,
    };
    const iTun: M4aAacITunEvidence = {
      primingCoreFrames: 1_024,
      remainderCoreFrames: 956,
      audibleCoreFrames: 44_100,
    };

    expect(normalizeM4aAacTimeline(input(ffmpegStts, { edit, iTun }))).toMatchObject({
      headTrimCoreFrames: 1_024,
      tailTrimCoreFrames: 956,
      totalMediaFrames: 44_100,
    });
  });

  it.each([
    [
      'priming',
      { primingCoreFrames: 1_023, remainderCoreFrames: 956, audibleCoreFrames: 44_101 },
      /priming evidence conflict/i,
    ],
    [
      'remainder',
      { primingCoreFrames: 1_024, remainderCoreFrames: 955, audibleCoreFrames: 44_101 },
      /remainder conflicts/i,
    ],
    [
      'audible',
      { primingCoreFrames: 1_024, remainderCoreFrames: 957, audibleCoreFrames: 44_099 },
      /remainder conflicts|audible duration conflicts/i,
    ],
  ] as const)('rejects conflicting %s evidence', (_label, iTun, expected) => {
    const edit: M4aAacEditEvidence = {
      mediaTimeCoreFrames: 1_024,
      mediaRateInteger: 1,
      mediaRateFraction: 0,
      segmentDurationMovieTicks: 1_000,
    };
    expect(() => normalizeM4aAacTimeline(input(ffmpegStts, { edit, iTun }))).toThrow(expected);
  });

  it('rejects iTun fields that do not exactly cover raw decoder output', () => {
    expect(() =>
      normalizeM4aAacTimeline(
        input(ffmpegStts, {
          iTun: {
            primingCoreFrames: 1_024,
            remainderCoreFrames: 956,
            audibleCoreFrames: 44_099,
          },
        }),
      ),
    ).toThrow(/do not sum/i);
  });

  it.each([
    [{ mdhdTimescale: 48_000 }, /timescale must equal/i],
    [{ mdhdDurationCoreFrames: 45_123 }, /duration must equal/i],
    [{ mdhdDurationCoreFrames: 45_124.5 }, /positive safe integer/i],
    [{ sampleRateHz: 12_345, mdhdTimescale: 12_345 }, /13 indexed AAC core rates/i],
  ] as const)('rejects wrong mdhd geometry %#', (overrides, expected) => {
    expect(() => normalizeM4aAacTimeline(input(ffmpegStts, overrides))).toThrow(expected);
  });

  it('accepts floor and ceiling edit rounding only while each differs by less than one tick', () => {
    const stts = accumulate([48, 1_024]);
    const baseEdit = {
      mediaTimeCoreFrames: 1_151,
      mediaRateInteger: 1 as const,
      mediaRateFraction: 0 as const,
    };
    const base = {
      sampleRateHz: 48_000,
      mdhdTimescale: 48_000,
      movieTimescale: 1_000,
    };

    for (const segmentDurationMovieTicks of [1_000, 1_001]) {
      expect(() =>
        normalizeM4aAacTimeline(
          input(stts, {
            ...base,
            edit: { ...baseEdit, segmentDurationMovieTicks },
          }),
        ),
      ).not.toThrow();
    }
    expect(() =>
      normalizeM4aAacTimeline(
        input(stts, {
          ...base,
          edit: { ...baseEdit, segmentDurationMovieTicks: 999 },
        }),
      ),
    ).toThrow(/one (?:movie )?tick or more/i);
  });

  it('accepts independent FFmpeg tkhd and elst rounding when both are within one tick', () => {
    const stts = accumulate([58, 1_024], [1, 594]);
    expect(stts.presentationEndCoreFrames).toBe(59_986);

    expect(() =>
      normalizeM4aAacTimeline(
        input(stts, {
          sampleRateHz: 44_100,
          mdhdTimescale: 44_100,
          movieTimescale: 1_000,
          trackDurationMovieTicks: 1_338,
          edit: {
            mediaTimeCoreFrames: 1_024,
            mediaRateInteger: 1,
            mediaRateFraction: 0,
            segmentDurationMovieTicks: 1_337,
          },
        }),
      ),
    ).not.toThrow();

    expect(() =>
      normalizeM4aAacTimeline(
        input(stts, {
          sampleRateHz: 44_100,
          mdhdTimescale: 44_100,
          movieTimescale: 1_000,
          trackDurationMovieTicks: 1_339,
          edit: {
            mediaTimeCoreFrames: 1_024,
            mediaRateInteger: 1,
            mediaRateFraction: 0,
            segmentDurationMovieTicks: 1_337,
          },
        }),
      ),
    ).toThrow(/tkhd duration.*one movie tick/i);
  });

  it('rejects edit-duration error exactly equal to one movie tick', () => {
    const stts = accumulate([46, 1_024], [1, 896]);
    expect(stts.presentationEndCoreFrames).toBe(48_000);

    expect(() =>
      normalizeM4aAacTimeline(
        input(stts, {
          sampleRateHz: 48_000,
          mdhdTimescale: 48_000,
          movieTimescale: 1_000,
          edit: {
            mediaTimeCoreFrames: 0,
            mediaRateInteger: 1,
            mediaRateFraction: 0,
            segmentDurationMovieTicks: 999,
          },
        }),
      ),
    ).toThrow(/one (?:movie )?tick or more/i);
  });

  it.each([
    [
      {
        mediaTimeCoreFrames: 0,
        mediaRateInteger: 0,
        mediaRateFraction: 0,
        segmentDurationMovieTicks: 1,
      },
      /mediaRateInteger/i,
    ],
    [
      {
        mediaTimeCoreFrames: 0,
        mediaRateInteger: 1,
        mediaRateFraction: -0,
        segmentDurationMovieTicks: 1,
      },
      /mediaRateFraction/i,
    ],
    [
      {
        mediaTimeCoreFrames: 0,
        mediaRateInteger: 1,
        mediaRateFraction: 0,
        segmentDurationMovieTicks: 0,
      },
      /segmentDurationMovieTicks/i,
    ],
    [
      {
        mediaTimeCoreFrames: 45_124,
        mediaRateInteger: 1,
        mediaRateFraction: 0,
        segmentDurationMovieTicks: 1,
      },
      /non-empty media timeline/i,
    ],
  ])('rejects unsupported or empty edit evidence %#', (edit, expected) => {
    expect(() => normalizeM4aAacTimeline({ ...input(ffmpegStts), edit })).toThrow(expected);
  });

  it('normalizes the maximum admitted AU count with safe BigInt-backed arithmetic', () => {
    const stts = accumulate([M4A_AAC_MAX_ACCESS_UNITS, 1_024]);
    expect(normalizeM4aAacTimeline(input(stts)).rawCoreFrames).toBe(17_179_869_184);
  });

  it('rejects forged out-of-policy evidence and overflowing scalar evidence', () => {
    expect(() =>
      normalizeM4aAacTimeline(
        input({
          accessUnitCount: M4A_AAC_MAX_ACCESS_UNITS + 1,
          presentationEndCoreFrames: (M4A_AAC_MAX_ACCESS_UNITS + 1) * 1_024,
          finalAccessUnitDelta: 1_024,
          entryCount: 1,
        }),
      ),
    ).toThrow(/issued by this bounded accumulator realm/i);

    expect(() =>
      normalizeM4aAacTimeline(
        input(accumulate([1, 1_024]), {
          iTun: {
            primingCoreFrames: Number.MAX_SAFE_INTEGER,
            remainderCoreFrames: Number.MAX_SAFE_INTEGER,
            audibleCoreFrames: Number.MAX_SAFE_INTEGER,
          },
        }),
      ),
    ).toThrow(/safe-integer range/i);
  });

  it('rejects cloned or structurally forged stts aggregate evidence', () => {
    expect(() => normalizeM4aAacTimeline(input({ ...ffmpegStts }))).toThrow(
      /issued by this bounded accumulator realm/i,
    );
    expect(() =>
      normalizeM4aAacTimeline(
        input({
          accessUnitCount: 2,
          presentationEndCoreFrames: 2_048,
          finalAccessUnitDelta: 1_024,
          entryCount: 1,
        }),
      ),
    ).toThrow(/issued by this bounded accumulator realm/i);
  });

  it('rejects extras, accessors, symbols, class instances, and hostile proxies', () => {
    expect(() => normalizeM4aAacTimeline({ ...input(ffmpegStts), extra: true })).toThrow(
      /unexpected or missing fields/i,
    );

    expect(() =>
      normalizeM4aAacTimeline(input({ ...ffmpegStts, extra: true } as M4aAacSttsEvidence)),
    ).toThrow(/issued by this bounded accumulator realm/i);

    const getterEdit = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(getterEdit, {
      mediaTimeCoreFrames: {
        enumerable: true,
        get() {
          throw new Error('must not run');
        },
      },
      mediaRateInteger: { enumerable: true, value: 1 },
      mediaRateFraction: { enumerable: true, value: 0 },
      segmentDurationMovieTicks: { enumerable: true, value: 1_000 },
    });
    expect(() => normalizeM4aAacTimeline(input(ffmpegStts, { edit: getterEdit as never }))).toThrow(
      /data fields/i,
    );

    class ITunEvidence {
      primingCoreFrames = 0;
      remainderCoreFrames = 956;
      audibleCoreFrames = 45_124;
    }
    expect(() => normalizeM4aAacTimeline(input(ffmpegStts, { iTun: new ITunEvidence() }))).toThrow(
      /plain data record/i,
    );

    const symbolInput = input(ffmpegStts) as M4aAacTimelineNormalizationInput & {
      [key: symbol]: unknown;
    };
    symbolInput[Symbol('extra')] = true;
    expect(() => normalizeM4aAacTimeline(symbolInput)).toThrow(/unexpected or missing fields/i);

    const hostile = new Proxy(input(ffmpegStts), {
      ownKeys() {
        throw new Error('hostile ownKeys');
      },
    });
    expect(() => normalizeM4aAacTimeline(hostile)).toThrow(/inspected safely/i);
  });

  it.each([
    { sampleRateHz: -0 },
    { mdhdTimescale: -0 },
    { mdhdDurationCoreFrames: -0 },
    { movieTimescale: 1.5 },
    { trackDurationMovieTicks: -0 },
    { trackDurationMovieTicks: -1 },
  ])('rejects noncanonical container evidence %#', (overrides) => {
    expect(() => normalizeM4aAacTimeline(input(ffmpegStts, overrides))).toThrow(/safe integer/i);
  });
});
