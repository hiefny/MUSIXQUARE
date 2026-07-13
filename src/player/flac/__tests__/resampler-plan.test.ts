import { beforeAll, describe, expect, it } from 'vitest';
import { ChunkedResampler, initWithBase64 } from 'lanczos-resampler/loader.js';
import { expectedLanczosOutputFrames as expectedLanczosOutputFramesFromFlacCompat } from '../resampler-plan.ts';
import {
  expectedLanczosOutputFrames,
  maximumLanczosOutputFrames,
  minimumLanczosInputFrames,
  planBoundedLanczosChunk,
  planShortLanczosInput,
  type LanczosRates,
} from '../../streaming/resampler-plan.ts';

const PCM_MESSAGE_LIMIT = 32_768;

let lanczosInitialization: Promise<void> | undefined;

beforeAll(async () => {
  // loader.js stores a single WASM export table at module scope. Initialize it
  // exactly once, then run every real-WASM assertion sequentially below.
  lanczosInitialization ??= initWithBase64();
  await lanczosInitialization;
});

interface RunResult {
  readonly chunks: readonly number[];
  readonly totalWritten: number;
}

function runPlannedStream(
  rates: LanczosRates,
  totalSourceFrames: number,
  maxOutputFrames = PCM_MESSAGE_LIMIT,
): RunResult {
  const resampler = new ChunkedResampler(rates.inputSampleRate, rates.outputSampleRate);
  const chunks: number[] = [];
  let remainingSourceFrames = totalSourceFrames;
  let totalWritten = 0;

  try {
    while (remainingSourceFrames > 0) {
      const plan = planBoundedLanczosChunk({
        ...rates,
        remainingSourceFrames,
        maxOutputFrames,
      });
      expect(plan).not.toBeNull();
      if (!plan) throw new Error('test stream unexpectedly required a short-input plan');

      expect(plan.maximumOutputFrames).toBe(resampler.maxNumOutputFrames(plan.inputFrames));
      expect(plan.maximumOutputFrames).toBeLessThanOrEqual(maxOutputFrames);
      expect(
        plan.remainingSourceFrames === 0 ||
          plan.remainingSourceFrames >= minimumLanczosInputFrames(rates),
      ).toBe(true);

      const input = new Float32Array(plan.inputFrames);
      const output = new Float32Array(plan.maximumOutputFrames);
      const outcome = resampler.resample(input, output);
      try {
        expect(outcome.numRead).toBe(plan.inputFrames);
        expect(outcome.numRead).toBeGreaterThan(0);
        expect(outcome.numWritten).toBeLessThanOrEqual(plan.maximumOutputFrames);
        totalWritten += outcome.numWritten;
      } finally {
        outcome.free();
      }

      chunks.push(plan.inputFrames);
      remainingSourceFrames = plan.remainingSourceFrames;
    }
  } finally {
    resampler.free();
  }

  return { chunks, totalWritten };
}

describe('pinned Lanczos planning arithmetic', () => {
  it('keeps the legacy FLAC import as the exact codec-neutral implementation', () => {
    expect(expectedLanczosOutputFramesFromFlacCompat).toBe(expectedLanczosOutputFrames);
  });

  it('uses exact floor arithmetic from a seek target and documents the one-output drop', () => {
    expect(
      expectedLanczosOutputFrames({
        inputSampleRate: 352_800,
        outputSampleRate: 48_000,
        totalSourceFrames: 5_461,
        startSourceFrame: 0,
      }),
    ).toBe(742);
    expect(
      expectedLanczosOutputFrames({
        inputSampleRate: 352_800,
        outputSampleRate: 48_000,
        totalSourceFrames: 100,
        startSourceFrame: 85,
      }),
    ).toBe(2);

    // floor(8 * 48,000 / 352,800) is one, but the pinned library maps that
    // unusable one-point result to zero.
    expect(
      expectedLanczosOutputFrames({
        inputSampleRate: 352_800,
        outputSampleRate: 48_000,
        totalSourceFrames: 8,
        startSourceFrame: 0,
      }),
    ).toBe(0);
  });

  it('computes the pinned minimum and rejects unsafe or impossible plans', () => {
    expect(minimumLanczosInputFrames({ inputSampleRate: 8_000, outputSampleRate: 48_000 })).toBe(2);
    expect(minimumLanczosInputFrames({ inputSampleRate: 352_800, outputSampleRate: 48_000 })).toBe(
      15,
    );
    expect(() =>
      expectedLanczosOutputFrames({
        inputSampleRate: 1,
        outputSampleRate: Number.MAX_SAFE_INTEGER,
        totalSourceFrames: Number.MAX_SAFE_INTEGER,
        startSourceFrame: 0,
      }),
    ).toThrow(/safe-integer/);
    expect(() =>
      planBoundedLanczosChunk({
        inputSampleRate: 8_000,
        outputSampleRate: 48_000,
        remainingSourceFrames: 2,
        maxOutputFrames: 1,
      }),
    ).toThrow(/minimum consumable/);
  });

  it('never creates the 16,384-frame upsample tail of one', () => {
    const rates = { inputSampleRate: 8_000, outputSampleRate: 48_000 };
    let remainingSourceFrames = 16_384;
    const chunks: number[] = [];
    while (remainingSourceFrames > 0) {
      const plan = planBoundedLanczosChunk({
        ...rates,
        remainingSourceFrames,
        maxOutputFrames: PCM_MESSAGE_LIMIT,
      });
      expect(plan).not.toBeNull();
      if (!plan) break;
      chunks.push(plan.inputFrames);
      remainingSourceFrames = plan.remainingSourceFrames;
    }
    expect(chunks).toEqual([5_461, 5_461, 5_460, 2]);
  });

  it('distinguishes carry from EOF zero-padding and exact trimming', () => {
    expect(
      planShortLanczosInput({
        inputSampleRate: 352_800,
        outputSampleRate: 48_000,
        consumedSourceFrames: 0,
        producedOutputFrames: 0,
        carriedSourceFrames: 8,
        endOfStream: false,
      }),
    ).toEqual({
      kind: 'carry',
      carriedSourceFrames: 8,
      additionalSourceFramesNeeded: 7,
      minimumInputFrames: 15,
    });

    const pathological = planShortLanczosInput({
      inputSampleRate: 352_800,
      outputSampleRate: 48_000,
      consumedSourceFrames: 0,
      producedOutputFrames: 0,
      carriedSourceFrames: 8,
      endOfStream: true,
    });
    expect(pathological).toMatchObject({
      kind: 'pad-and-trim',
      realInputFrames: 8,
      zeroPaddingFrames: 7,
      paddedInputFrames: 15,
      trimToOutputFrames: 0,
      expectedTotalOutputFrames: 0,
    });

    const oneFrameUpsample = planShortLanczosInput({
      inputSampleRate: 8_000,
      outputSampleRate: 48_000,
      consumedSourceFrames: 0,
      producedOutputFrames: 0,
      carriedSourceFrames: 1,
      endOfStream: true,
    });
    expect(oneFrameUpsample).toMatchObject({
      kind: 'pad-and-trim',
      realInputFrames: 1,
      zeroPaddingFrames: 1,
      paddedInputFrames: 2,
      trimToOutputFrames: 6,
      expectedTotalOutputFrames: 6,
    });
  });
});

describe.sequential('real lanczos-resampler@0.4.1 integration', () => {
  it.each([
    ['8kHz to 48kHz', { inputSampleRate: 8_000, outputSampleRate: 48_000 }, 16_384],
    ['352.8kHz to 48kHz', { inputSampleRate: 352_800, outputSampleRate: 48_000 }, 16_384],
    ['44.1kHz to 48kHz', { inputSampleRate: 44_100, outputSampleRate: 48_000 }, 16_384],
  ] as const)(
    '%s consumes every planned chunk and writes the exact contract',
    (_, rates, total) => {
      const result = runPlannedStream(rates, total);
      expect(result.totalWritten).toBe(
        expectedLanczosOutputFrames({
          ...rates,
          totalSourceFrames: total,
          startSourceFrame: 0,
        }),
      );
      expect(result.chunks.every((chunk) => chunk >= minimumLanczosInputFrames(rates))).toBe(true);
    },
  );

  it.each([
    ['one 8kHz frame keeps six of twelve padded outputs', 8_000, 48_000, 1, 6],
    ['one 44.1kHz frame drops the pinned computed-one output', 44_100, 48_000, 1, 0],
    ['eight 352.8kHz frames drop the pinned computed-one output', 352_800, 48_000, 8, 0],
  ] as const)('%s', (_, inputSampleRate, outputSampleRate, tailFrames, expected) => {
    const rates = { inputSampleRate, outputSampleRate };
    const plan = planShortLanczosInput({
      ...rates,
      consumedSourceFrames: 0,
      producedOutputFrames: 0,
      carriedSourceFrames: tailFrames,
      endOfStream: true,
    });
    expect(plan.kind).toBe('pad-and-trim');
    if (plan.kind !== 'pad-and-trim') throw new Error('expected an EOF padding plan');

    const resampler = new ChunkedResampler(inputSampleRate, outputSampleRate);
    try {
      expect(plan.maximumOutputFrames).toBe(resampler.maxNumOutputFrames(plan.paddedInputFrames));
      const outcome = resampler.resample(
        new Float32Array(plan.paddedInputFrames),
        new Float32Array(plan.maximumOutputFrames),
      );
      try {
        expect(outcome.numRead).toBe(plan.paddedInputFrames);
        expect(outcome.numRead).toBeGreaterThan(0);
        expect(outcome.numWritten).toBeGreaterThanOrEqual(plan.trimToOutputFrames);
        expect(plan.trimToOutputFrames).toBe(expected);
        expect(plan.trimToOutputFrames).toBe(
          expectedLanczosOutputFrames({
            ...rates,
            totalSourceFrames: tailFrames,
            startSourceFrame: 0,
          }),
        );
      } finally {
        outcome.free();
      }
    } finally {
      resampler.free();
    }
  });

  it('keeps cumulative phase exact when a processed stream ends in a tiny tail', () => {
    const rates = { inputSampleRate: 44_100, outputSampleRate: 48_000 };
    const resampler = new ChunkedResampler(rates.inputSampleRate, rates.outputSampleRate);
    let producedOutputFrames = 0;
    try {
      const firstInputFrames = 2;
      const firstOutcome = resampler.resample(
        new Float32Array(firstInputFrames),
        new Float32Array(maximumLanczosOutputFrames(firstInputFrames, rates)),
      );
      try {
        expect(firstOutcome.numRead).toBe(firstInputFrames);
        producedOutputFrames = firstOutcome.numWritten;
      } finally {
        firstOutcome.free();
      }

      const tailPlan = planShortLanczosInput({
        ...rates,
        consumedSourceFrames: firstInputFrames,
        producedOutputFrames,
        carriedSourceFrames: 1,
        endOfStream: true,
      });
      expect(tailPlan.kind).toBe('pad-and-trim');
      if (tailPlan.kind !== 'pad-and-trim') throw new Error('expected an EOF padding plan');

      const tailOutcome = resampler.resample(
        new Float32Array(tailPlan.paddedInputFrames),
        new Float32Array(tailPlan.maximumOutputFrames),
      );
      try {
        expect(tailOutcome.numRead).toBe(tailPlan.paddedInputFrames);
        expect(tailOutcome.numRead).toBeGreaterThan(0);
        expect(tailOutcome.numWritten).toBeGreaterThanOrEqual(tailPlan.trimToOutputFrames);
        producedOutputFrames += tailPlan.trimToOutputFrames;
      } finally {
        tailOutcome.free();
      }
    } finally {
      resampler.free();
    }

    expect(producedOutputFrames).toBe(
      expectedLanczosOutputFrames({
        ...rates,
        totalSourceFrames: 3,
        startSourceFrame: 0,
      }),
    );
  });
});
