import { beforeAll, describe, expect, it } from 'vitest';

import { expectedLanczosOutputFrames } from '../../player/streaming/resampler-plan.ts';
import {
  BoundedPcmOutput,
  BoundedPcmOutputError,
  ensureBoundedPcmOutputRuntimeReady,
} from '../bounded-pcm-output.ts';

beforeAll(async () => {
  await ensureBoundedPcmOutputRuntimeReady();
});

function channel(frames: number, offset = 0): Float32Array {
  return Float32Array.from({ length: frames }, (_, index) => (offset + index) / 10_000);
}

describe.sequential('BoundedPcmOutput', () => {
  it('preserves an exact direct-rate timeline in bounded owned segments', () => {
    const output = new BoundedPcmOutput({
      sourceSampleRateHz: 48_000,
      outputSampleRateHz: 48_000,
      channelCount: 2,
      totalSourceFrames: 2_500,
      maxAppendFrames: 1_152,
    });
    const collected: number[] = [];
    let accepted = 0;
    while (accepted < output.totalSourceFrames) {
      const frames = Math.min(output.maxAppendFrames, output.totalSourceFrames - accepted);
      const left = channel(frames, accepted);
      const right = channel(frames, accepted + 10);
      output.append([left, right], frames);
      left.fill(99);
      right.fill(99);
      accepted += frames;
      if (accepted === output.totalSourceFrames) output.endInput();
      const segment = output.pull(700);
      expect(segment).not.toBeNull();
      if (!segment) throw new Error('expected direct PCM segment');
      expect(segment.channels).toHaveLength(2);
      expect(segment.frames).toBeLessThanOrEqual(700);
      expect(segment.channels[0]?.[0]).not.toBe(99);
      collected.push(segment.frames);
      while (!output.needsInput && !output.finished) {
        const remainder = output.pull(700);
        if (!remainder) break;
        collected.push(remainder.frames);
      }
    }

    expect(collected.reduce((sum, frames) => sum + frames, 0)).toBe(2_500);
    expect(output.producedOutputFrames).toBe(2_500);
    expect(output.finished).toBe(true);
    expect(output.pull(700)).toBeNull();
    output.close();
    output.close();
  });

  it('matches the pinned cumulative Lanczos length across incremental MP3-sized appends', () => {
    const totalSourceFrames = 11_777;
    const output = new BoundedPcmOutput({
      sourceSampleRateHz: 44_100,
      outputSampleRateHz: 48_000,
      channelCount: 1,
      totalSourceFrames,
      maxAppendFrames: 1_152,
    });
    let accepted = 0;
    let collected = 0;
    let finalCount = 0;

    while (!output.finished) {
      if (output.needsInput) {
        const frames = Math.min(output.maxAppendFrames, totalSourceFrames - accepted);
        output.append([channel(frames, accepted)], frames);
        accepted += frames;
        if (accepted === totalSourceFrames) output.endInput();
      }
      const segment = output.pull(733);
      if (!segment) continue;
      collected += segment.frames;
      if (segment.final) finalCount += 1;
      expect(segment.frames).toBeLessThanOrEqual(733);
      expect(segment.channels[0]).toHaveLength(segment.frames);
    }

    const expected = expectedLanczosOutputFrames({
      inputSampleRate: 44_100,
      outputSampleRate: 48_000,
      totalSourceFrames,
      startSourceFrame: 0,
    });
    expect(collected).toBe(expected);
    expect(output.producedOutputFrames).toBe(expected);
    expect(finalCount).toBe(1);
    output.close();
  });

  it('keeps cumulative phase exact for separately clipped MP3 head and tail blocks', () => {
    const output = new BoundedPcmOutput({
      sourceSampleRateHz: 44_100,
      outputSampleRateHz: 48_000,
      channelCount: 2,
      totalSourceFrames: 1_500,
      maxAppendFrames: 1_152,
    });
    let collected = 0;
    let finalCount = 0;
    const drain = (): void => {
      while (true) {
        const segment = output.pull(17);
        if (!segment) return;
        collected += segment.frames;
        if (segment.final) finalCount += 1;
      }
    };

    output.append([channel(623), channel(623, 10)], 623);
    drain();
    expect(output.needsInput).toBe(true);
    output.append([channel(877, 623), channel(877, 633)], 877);
    output.endInput();
    drain();

    expect(collected).toBe(
      expectedLanczosOutputFrames({
        inputSampleRate: 44_100,
        outputSampleRate: 48_000,
        totalSourceFrames: 1_500,
        startSourceFrame: 0,
      }),
    );
    expect(finalCount).toBe(1);
    expect(output.finished).toBe(true);
    output.close();
  });

  it('pads a one-frame upsample only inside the resampler and publishes six real outputs', () => {
    const output = new BoundedPcmOutput({
      sourceSampleRateHz: 8_000,
      outputSampleRateHz: 48_000,
      channelCount: 1,
      totalSourceFrames: 1,
      maxAppendFrames: 576,
    });
    output.append([Float32Array.of(0.25)], 1);
    expect(output.pull(32)).toBeNull();
    output.endInput();
    const segments = Array.from({ length: 6 }, () => output.pull(1));
    expect(segments.map((segment) => segment?.frames)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(segments.slice(0, -1).every((segment) => segment?.final === false)).toBe(true);
    expect(segments.at(-1)).toMatchObject({ frames: 1, final: true });
    expect(output.finished).toBe(true);
    output.close();
  });

  it('fails closed on malformed PCM, timeline overruns, premature EOF, and carry growth', () => {
    expect(
      () =>
        new BoundedPcmOutput({
          sourceSampleRateHz: 1,
          outputSampleRateHz: 1_000_000,
          channelCount: 1,
          totalSourceFrames: 2,
          maxAppendFrames: 2,
        }),
    ).toThrow(/sample-rate ratio/i);
    expect(
      () =>
        new BoundedPcmOutput({
          sourceSampleRateHz: 1_000_000,
          outputSampleRateHz: 1,
          channelCount: 1,
          totalSourceFrames: 2_000_000,
          maxAppendFrames: 32_768,
        }),
    ).toThrow(/sample-rate ratio/i);

    const invalid = new BoundedPcmOutput({
      sourceSampleRateHz: 44_100,
      outputSampleRateHz: 48_000,
      channelCount: 1,
      totalSourceFrames: 4,
      maxAppendFrames: 2,
    });
    expect(() => invalid.append([], 1)).toThrow(/exactly 1 channels/i);
    expect(() => invalid.append([Float32Array.of(Number.NaN)], 1)).toThrow(/non-finite/i);
    invalid.append([channel(2)], 2);
    expect(() => invalid.append([channel(2)], 2)).toThrow(/drained/i);
    expect(() => invalid.endInput()).toThrow(/expected 4/i);
    invalid.close();
    expect(() => invalid.pull(1)).toThrow(BoundedPcmOutputError);

    const overrun = new BoundedPcmOutput({
      sourceSampleRateHz: 48_000,
      outputSampleRateHz: 48_000,
      channelCount: 1,
      totalSourceFrames: 1,
      maxAppendFrames: 1,
    });
    overrun.append([channel(1)], 1);
    expect(() => overrun.append([channel(1)], 1)).toThrow(/timeline/i);
    overrun.close();

    const poisoned = new BoundedPcmOutput({
      sourceSampleRateHz: 48_000,
      outputSampleRateHz: 48_000,
      channelCount: 1,
      totalSourceFrames: 1,
      maxAppendFrames: 1,
    });
    poisoned.append([channel(1)], 1);
    const firstFailure = (() => {
      try {
        poisoned.pull(0);
      } catch (error) {
        return error;
      }
      throw new Error('invalid pull unexpectedly succeeded');
    })();
    expect(firstFailure).toBeInstanceOf(BoundedPcmOutputError);
    let secondFailure: unknown;
    try {
      poisoned.pull(1);
    } catch (error) {
      secondFailure = error;
    }
    expect(secondFailure).toBe(firstFailure);
    expect(poisoned.needsInput).toBe(false);
    poisoned.close();
  });
});
