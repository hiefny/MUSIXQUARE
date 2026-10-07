import { describe, expect, it } from 'vitest';

import { LOCAL_LARGE_TRACK_WARNING_BYTES } from '../../core/constants.ts';
import type { DecodeMemoryEstimate } from '../decode-admission.ts';
import { shouldUseLargeFileEngine } from '../large-file-policy.ts';

const MIB = 1024 * 1024;

function estimate(overrides: Partial<DecodeMemoryEstimate> = {}): DecodeMemoryEstimate {
  return {
    durationSeconds: 240,
    probedChannelCount: 2,
    hasReliableMetadata: true,
    channelCount: 2,
    outputSampleRate: 48_000,
    estimatedPcmBytes: 110 * MIB,
    ownDecodeFootprintBytes: 130 * MIB,
    estimatedWorkingSetBytes: 130 * MIB,
    budget: {
      tier: 'ios',
      maxDecodedPcmBytes: Number.MAX_SAFE_INTEGER,
      maxDecodeWorkingSetBytes: Number.MAX_SAFE_INTEGER,
    },
    ...overrides,
  };
}

describe('local-file engine selection', () => {
  it.each([
    ['ios', 192, 320],
    ['constrained', 256, 448],
    ['standard', 384, 768],
    ['high-memory', 512, 1024],
  ] as const)('switches above either track-local limit on %s devices', (tier, pcmMiB, peakMiB) => {
    const boundary = estimate({
      budget: { ...estimate().budget, tier },
      estimatedPcmBytes: pcmMiB * MIB,
      ownDecodeFootprintBytes: peakMiB * MIB,
    });

    expect(shouldUseLargeFileEngine(boundary, 10 * MIB)).toBe(false);
    expect(
      shouldUseLargeFileEngine({ ...boundary, estimatedPcmBytes: pcmMiB * MIB + 1 }, 10 * MIB),
    ).toBe(true);
    expect(
      shouldUseLargeFileEngine(
        { ...boundary, ownDecodeFootprintBytes: peakMiB * MIB + 1 },
        10 * MIB,
      ),
    ).toBe(true);
  });

  it('uses decoded size for long compressed songs even when the original file is small', () => {
    expect(
      shouldUseLargeFileEngine(
        estimate({
          durationSeconds: 3600,
          estimatedPcmBytes: 1648 * MIB,
          ownDecodeFootprintBytes: 1718 * MIB,
        }),
        35 * MIB,
      ),
    ).toBe(true);
  });

  it('returns to the ordinary engine despite surviving PCM and concurrent transfers', () => {
    const large = estimate({ estimatedPcmBytes: 600 * MIB, ownDecodeFootprintBytes: 660 * MIB });
    expect(shouldUseLargeFileEngine(large, 30 * MIB)).toBe(true);
    const ordinaryAfterLarge = estimate({ estimatedWorkingSetBytes: 2500 * MIB });
    expect(shouldUseLargeFileEngine(ordinaryAfterLarge, 10 * MIB)).toBe(false);
    expect(shouldUseLargeFileEngine(large, 30 * MIB)).toBe(true);
  });

  it('does not mistake unknown-duration accounting expansion for a known large track', () => {
    const unknown = estimate({
      durationSeconds: null,
      hasReliableMetadata: false,
      estimatedPcmBytes: 640 * MIB,
      ownDecodeFootprintBytes: 660 * MIB,
    });
    expect(shouldUseLargeFileEngine(unknown, 10 * MIB)).toBe(false);
    expect(shouldUseLargeFileEngine(unknown)).toBe(false);
    expect(shouldUseLargeFileEngine(unknown, LOCAL_LARGE_TRACK_WARNING_BYTES)).toBe(false);
    expect(shouldUseLargeFileEngine(unknown, LOCAL_LARGE_TRACK_WARNING_BYTES + 1)).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'does not choose an engine from invalid accounting or encoded byte count %s',
    (bytes) => {
      const invalid = estimate({ estimatedPcmBytes: bytes, ownDecodeFootprintBytes: bytes });
      expect(shouldUseLargeFileEngine(invalid, bytes)).toBe(false);
      expect(shouldUseLargeFileEngine(invalid, LOCAL_LARGE_TRACK_WARNING_BYTES + 1)).toBe(true);
    },
  );
});
