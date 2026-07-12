import { describe, expect, it } from 'vitest';
import {
  discardDecodedSourcePrefix,
  expectedOutputFrames,
  validateFlacStreamDescriptor,
} from '../decoder-helpers.ts';
import type { FlacStreamDescriptor } from '../stream-protocol.ts';

function descriptor(patch: Partial<FlacStreamDescriptor> = {}): FlacStreamDescriptor {
  return {
    sourceSampleRate: 352_800,
    outputSampleRate: 48_000,
    channels: 2,
    bitDepth: 24,
    totalSourceSamples: 195_765_840,
    firstAudioFrameOffset: 128,
    targetSourceSample: 0,
    decodeAnchorByteOffset: 128,
    decodeAnchorSourceSample: 0,
    minBlockSize: 4096,
    maxBlockSize: 4096,
    minFrameSize: 18,
    maxFrameSize: 65_000,
    ...patch,
  };
}

describe('FLAC decoder descriptor helpers', () => {
  it('accepts mono through eight-channel STREAMINFO contracts', () => {
    for (const channels of [1, 2, 6, 8]) {
      expect(() => validateFlacStreamDescriptor(descriptor({ channels }))).not.toThrow();
    }
  });

  it('rejects invalid metadata and out-of-range seek positions', () => {
    expect(() => validateFlacStreamDescriptor(descriptor({ channels: 9 }))).toThrow(/channels/);
    expect(() => validateFlacStreamDescriptor(descriptor({ bitDepth: 0 }))).toThrow(/bitDepth/);
    expect(() => validateFlacStreamDescriptor(descriptor({ sourceSampleRate: 0 }))).toThrow(
      /sourceSampleRate/,
    );
    expect(() =>
      validateFlacStreamDescriptor(
        descriptor({ totalSourceSamples: 100, targetSourceSample: 101 }),
      ),
    ).toThrow(/targetSourceSample/);
    expect(() =>
      validateFlacStreamDescriptor(
        descriptor({ targetSourceSample: 10, decodeAnchorSourceSample: 11 }),
      ),
    ).toThrow(/decodeAnchorSourceSample/);
    expect(() =>
      validateFlacStreamDescriptor(
        descriptor({ decodeAnchorSourceSample: 0, decodeAnchorByteOffset: 129 }),
      ),
    ).toThrow(/firstAudioFrameOffset/);
    expect(() =>
      validateFlacStreamDescriptor(descriptor({ minBlockSize: 4096, maxBlockSize: 1024 })),
    ).toThrow(/maxBlockSize/);
  });

  it('uses the pinned Lanczos floor contract and the exact direct contract', () => {
    expect(
      expectedOutputFrames(
        descriptor({
          sourceSampleRate: 352_800,
          outputSampleRate: 48_000,
          totalSourceSamples: 195_765_840,
        }),
      ),
    ).toBe(26_634_808);
    expect(
      expectedOutputFrames(
        descriptor({
          sourceSampleRate: 3,
          outputSampleRate: 2,
          totalSourceSamples: 2,
        }),
      ),
    ).toBe(0);
    expect(
      expectedOutputFrames(descriptor({ totalSourceSamples: 10, targetSourceSample: 10 })),
    ).toBe(0);
    expect(
      expectedOutputFrames(
        descriptor({
          sourceSampleRate: 48_000,
          outputSampleRate: 48_000,
          totalSourceSamples: 10,
          targetSourceSample: 3,
        }),
      ),
    ).toBe(7);
  });
});

describe('discardDecodedSourcePrefix', () => {
  it('discards an exact in-frame seek prefix without copying channel storage', () => {
    const left = Float32Array.from([0, 1, 2, 3]);
    const right = Float32Array.from([10, 11, 12, 13]);
    const result = discardDecodedSourcePrefix([left, right], 4, 3);

    expect(result.discarded).toBe(3);
    expect(result.remainingDiscard).toBe(0);
    expect(result.frames).toBe(1);
    expect(Array.from(result.channels[0] ?? [])).toEqual([3]);
    expect(Array.from(result.channels[1] ?? [])).toEqual([13]);
    expect(result.channels[0]?.buffer).toBe(left.buffer);
  });

  it('carries seek discard across decoded frames for mono and multichannel PCM', () => {
    const mono = discardDecodedSourcePrefix([new Float32Array(4)], 4, 7);
    expect(mono.frames).toBe(0);
    expect(mono.remainingDiscard).toBe(3);

    const sixChannels = Array.from({ length: 6 }, (_, channel) =>
      Float32Array.from([channel, channel + 0.5]),
    );
    const surround = discardDecodedSourcePrefix(sixChannels, 2, mono.remainingDiscard);
    expect(surround.frames).toBe(0);
    expect(surround.remainingDiscard).toBe(1);
    expect(surround.channels).toHaveLength(6);
  });

  it('rejects inconsistent decoded channel lengths', () => {
    expect(() =>
      discardDecodedSourcePrefix([new Float32Array(2), new Float32Array(1)], 2, 0),
    ).toThrow(/match/);
  });
});
