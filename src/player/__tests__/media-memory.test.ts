import { describe, expect, it, vi } from 'vitest';
import {
  assertAudioBlobWithinMemoryBudget,
  assertDecodedAudioWithinMemoryBudget,
  estimateDecodedPcmBytesForTests,
  resolveAudioMemoryBudgetForTests,
  validateAudioMemoryFootprintForTests,
} from '../media-memory.ts';

const MIB = 1024 * 1024;

describe('audio memory budget', () => {
  it('uses a conservative budget on mobile and low-memory devices', () => {
    const mobile = resolveAudioMemoryBudgetForTests({ userAgent: 'Mozilla/5.0 (iPhone)' });
    const lowMemory = resolveAudioMemoryBudgetForTests({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
      deviceMemoryGiB: 4,
    });

    expect(mobile.maxEncodedBytes).toBe(64 * MIB);
    expect(mobile.maxDecodedBytes).toBe(192 * MIB);
    expect(lowMemory).toEqual(mobile);
  });

  it('recognizes iPadOS when Safari advertises a desktop user agent', () => {
    const budget = resolveAudioMemoryBudgetForTests({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    });

    expect(budget.maxEncodedBytes).toBe(64 * MIB);
    expect(budget.maxDecodedBytes).toBe(192 * MIB);
  });

  it('allows larger, still-bounded buffers on high-memory desktop devices', () => {
    const budget = resolveAudioMemoryBudgetForTests({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
      deviceMemoryGiB: 8,
    });

    expect(budget.maxEncodedBytes).toBe(192 * MIB);
    expect(budget.maxDecodedBytes).toBe(512 * MIB);
  });

  it('estimates the Float32 stereo PCM allocation', () => {
    expect(estimateDecodedPcmBytesForTests(60)).toBe(60 * 48_000 * 2 * 4);
    expect(estimateDecodedPcmBytesForTests(Number.NaN)).toBe(0);
  });

  it('rejects encoded blobs before allocating their contents', () => {
    const budget = resolveAudioMemoryBudgetForTests({ userAgent: 'iPhone' });

    expect(() =>
      validateAudioMemoryFootprintForTests({
        encodedBytes: budget.maxEncodedBytes + 1,
        fileName: 'huge.flac',
        budget,
      }),
    ).toThrowError(expect.objectContaining({ name: 'AudioMemoryLimitError' }));
  });

  it('rejects long compressed audio from metadata before decoding', async () => {
    const budget = resolveAudioMemoryBudgetForTests({ userAgent: 'iPhone' });
    const durationProbe = vi.fn().mockResolvedValue(budget.maxEstimatedDurationSeconds + 1);
    const blob = new Blob([new Uint8Array(32)], { type: 'audio/mpeg' });

    await expect(
      assertAudioBlobWithinMemoryBudget(blob, {
        budget,
        durationProbe,
        fileName: 'podcast.mp3',
      }),
    ).rejects.toMatchObject({ reason: 'duration', fileName: 'podcast.mp3' });
    expect(durationProbe).toHaveBeenCalledOnce();
  });

  it('verifies the actual AudioBuffer footprint after decoding', () => {
    const budget = resolveAudioMemoryBudgetForTests({ userAgent: 'iPhone' });
    const tooManyFloatSamples = budget.maxDecodedBytes / 4 + 1;

    expect(() =>
      assertDecodedAudioWithinMemoryBudget(
        { length: tooManyFloatSamples, numberOfChannels: 1 },
        'oversized.wav',
        budget,
      ),
    ).toThrowError(expect.objectContaining({ reason: 'decoded' }));
  });
});
