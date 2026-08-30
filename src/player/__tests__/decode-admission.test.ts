import { describe, expect, it, vi } from 'vitest';
import {
  assertBlobCanDecodeToAudioBuffer,
  assertDecodedAudioBufferWithinBudget,
  bindEncodedReceiveReservationToBlob,
  estimateDecodedPcmBytes,
  evaluateDecodeMemoryWarning,
  memoryReservationStatsForTests,
  reserveEncodedReceiveMemoryWithinBudget,
  reserveRemoteTransportMemoryWithinBudget,
  reserveDecodeMemoryWithinBudget,
  resolveDecodeMemoryBudget,
  waitForInFlightMemoryReservationChange,
} from '../decode-admission.ts';

const MIB = 1024 * 1024;
const IOS_BOUNDED_BUDGET = {
  tier: 'ios',
  maxDecodedPcmBytes: 192 * MIB,
  maxDecodeWorkingSetBytes: 320 * MIB,
} as const;
const STANDARD_BOUNDED_BUDGET = {
  tier: 'standard',
  maxDecodedPcmBytes: 384 * MIB,
  maxDecodeWorkingSetBytes: 768 * MIB,
} as const;
const HIGH_MEMORY_BOUNDED_BUDGET = {
  tier: 'high-memory',
  maxDecodedPcmBytes: 512 * MIB,
  maxDecodeWorkingSetBytes: 1024 * MIB,
} as const;

function warningThresholdForTier(
  tier: ReturnType<typeof resolveDecodeMemoryBudget>['tier'],
): NonNullable<ReturnType<typeof evaluateDecodeMemoryWarning>>['threshold'] {
  const evaluation = evaluateDecodeMemoryWarning({
    durationSeconds: 1,
    probedChannelCount: 2,
    hasReliableMetadata: true,
    channelCount: 2,
    outputSampleRate: 48_000,
    estimatedPcmBytes: 2048 * MIB,
    ownDecodeFootprintBytes: 2048 * MIB,
    estimatedWorkingSetBytes: 2048 * MIB,
    budget: {
      tier,
      maxDecodedPcmBytes: Number.MAX_SAFE_INTEGER,
      maxDecodeWorkingSetBytes: Number.MAX_SAFE_INTEGER,
    },
  });
  if (!evaluation) throw new Error(`Expected a warning threshold for ${tier}`);
  return evaluation.threshold;
}

describe('AudioBuffer decode admission', () => {
  it('keeps iOS classification but does not impose a production memory ceiling', () => {
    const iphone = resolveDecodeMemoryBudget({ userAgent: 'Mozilla/5.0 (iPhone)' });
    const ipad = resolveDecodeMemoryBudget({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    });

    expect(iphone).toMatchObject({
      tier: 'ios',
      maxDecodedPcmBytes: Number.MAX_SAFE_INTEGER,
      maxDecodeWorkingSetBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(ipad).toEqual(iphone);
  });

  it('estimates stereo Float32 PCM with decode headroom', () => {
    expect(estimateDecodedPcmBytes(60)).toBe(60 * 48_000 * 2 * 4 * 1.25);
    expect(estimateDecodedPcmBytes(Number.NaN)).toBe(0);
  });

  it('keeps finite device-tier values advisory and separate from production admission', () => {
    expect(warningThresholdForTier('ios')).toEqual({
      tier: 'ios',
      maxDecodedPcmBytes: 192 * MIB,
      maxDecodeWorkingSetBytes: 320 * MIB,
    });
    expect(warningThresholdForTier('constrained')).toEqual({
      tier: 'constrained',
      maxDecodedPcmBytes: 256 * MIB,
      maxDecodeWorkingSetBytes: 448 * MIB,
    });
    expect(warningThresholdForTier('standard')).toEqual({
      tier: 'standard',
      maxDecodedPcmBytes: 384 * MIB,
      maxDecodeWorkingSetBytes: 768 * MIB,
    });
    expect(warningThresholdForTier('high-memory')).toEqual({
      tier: 'high-memory',
      maxDecodedPcmBytes: 512 * MIB,
      maxDecodeWorkingSetBytes: 1024 * MIB,
    });

    expect(resolveDecodeMemoryBudget({ userAgent: 'Mozilla/5.0 (iPhone)' })).toMatchObject({
      maxDecodedPcmBytes: Number.MAX_SAFE_INTEGER,
      maxDecodeWorkingSetBytes: Number.MAX_SAFE_INTEGER,
    });
  });

  it('returns a non-throwing warning estimate and evaluates both PCM and working-set risk', async () => {
    const estimate = await assertBlobCanDecodeToAudioBuffer({ size: 1 * MIB } as Blob, {
      budget: resolveDecodeMemoryBudget({ userAgent: 'Mozilla/5.0 (iPhone)' }),
      durationProbe: vi.fn().mockResolvedValue(600),
      channelCountProbe: vi.fn().mockResolvedValue(2),
      outputSampleRate: 48_000,
    });

    expect(estimate).toMatchObject({
      hasReliableMetadata: true,
      durationSeconds: 600,
      probedChannelCount: 2,
      estimatedPcmBytes: 600 * 48_000 * 2 * 4 * 1.25,
    });
    expect(evaluateDecodeMemoryWarning(estimate)).toEqual({
      reason: 'estimated-pcm',
      estimatedMiB: Math.ceil(estimate.estimatedWorkingSetBytes / MIB),
      threshold: warningThresholdForTier('ios'),
    });

    expect(
      evaluateDecodeMemoryWarning({
        ...estimate,
        estimatedPcmBytes: 100 * MIB,
        estimatedWorkingSetBytes: 321 * MIB,
      }),
    ).toMatchObject({ reason: 'working-set', estimatedMiB: 321 });
    expect(evaluateDecodeMemoryWarning({ ...estimate, hasReliableMetadata: false })).toBeNull();
  });

  it('estimates metadata without rejecting under the unbounded production policy', async () => {
    const budget = resolveDecodeMemoryBudget({ userAgent: 'Mozilla/5.0 (iPhone)' });
    const blob = { size: 80 * MIB } as Blob;
    const durationProbe = vi.fn().mockResolvedValue(300);
    const channelCountProbe = vi.fn().mockResolvedValue(2);

    const admission = await assertBlobCanDecodeToAudioBuffer(blob, {
      budget,
      durationProbe,
      channelCountProbe,
      fileName: 'five-minute.wav',
    });

    expect(durationProbe).toHaveBeenCalledOnce();
    expect(channelCountProbe).toHaveBeenCalledOnce();
    expect(admission).toMatchObject({
      durationSeconds: 300,
      probedChannelCount: 2,
      hasReliableMetadata: true,
      estimatedPcmBytes: 300 * 48_000 * 2 * 4 * 1.25,
    });
    expect(admission.estimatedWorkingSetBytes).toBeLessThan(budget.maxDecodeWorkingSetBytes);
  });

  it('uses a stereo advisory estimate when a supported container has no channel parser', async () => {
    const budget = resolveDecodeMemoryBudget({ userAgent: 'Mozilla/5.0 (iPhone)' });
    const estimate = await assertBlobCanDecodeToAudioBuffer({ size: 4 * MIB } as Blob, {
      budget,
      durationProbe: vi.fn().mockResolvedValue(60 * 60),
      channelCountProbe: vi.fn().mockResolvedValue(null),
    });

    expect(estimate).toMatchObject({
      durationSeconds: 60 * 60,
      probedChannelCount: null,
      channelCount: 2,
      hasReliableMetadata: true,
      estimatedPcmBytes: 60 * 60 * 48_000 * 2 * 4 * 1.25,
    });
    expect(evaluateDecodeMemoryWarning(estimate)).not.toBeNull();
  });

  it('does not pre-reject a long compressed program after estimating its PCM', async () => {
    const budget = resolveDecodeMemoryBudget({ userAgent: 'Mozilla/5.0 (iPhone)' });
    const blob = { size: 32 * MIB } as Blob;
    const durationProbe = vi.fn().mockResolvedValue(60 * 60);

    await expect(
      assertBlobCanDecodeToAudioBuffer(blob, {
        budget,
        durationProbe,
        channelCountProbe: vi.fn().mockResolvedValue(2),
        fileName: 'podcast.mp3',
      }),
    ).resolves.toMatchObject({
      durationSeconds: 60 * 60,
      estimatedPcmBytes: 60 * 60 * 48_000 * 2 * 4 * 1.25,
    });
    expect(durationProbe).toHaveBeenCalledOnce();
  });

  it('includes estimated PCM and retained iOS memory without rejecting production', async () => {
    const budget = resolveDecodeMemoryBudget({ userAgent: 'Mozilla/5.0 (iPhone)' });
    const blob = { size: 80 * MIB } as Blob;

    const admission = await assertBlobCanDecodeToAudioBuffer(blob, {
      budget,
      durationProbe: vi.fn().mockResolvedValue(300),
      channelCountProbe: vi.fn().mockResolvedValue(2),
      retainedPcmBytes: 32 * MIB,
      fileName: 'next.wav',
    });
    expect(admission.estimatedWorkingSetBytes).toBe(
      32 * MIB + 300 * 48_000 * 2 * 4 * 1.25 + blob.size * 2,
    );
  });

  it('does not fail closed when duration metadata is unavailable', async () => {
    const budget = resolveDecodeMemoryBudget({ userAgent: 'Mozilla/5.0 (iPhone)' });
    const blob = { size: 4 * MIB } as Blob;

    await expect(
      assertBlobCanDecodeToAudioBuffer(blob, {
        budget,
        durationProbe: vi.fn().mockResolvedValue(null),
        fileName: 'unknown.bin',
      }),
    ).resolves.toMatchObject({
      durationSeconds: null,
      hasReliableMetadata: false,
      estimatedPcmBytes: 4 * MIB * 64,
    });
  });

  it('fails warning metadata probes open so admission can still reach the native decoder', async () => {
    const budget = resolveDecodeMemoryBudget({ userAgent: 'Mozilla/5.0 (iPhone)' });

    await expect(
      assertBlobCanDecodeToAudioBuffer({ size: 2 * MIB } as Blob, {
        budget,
        durationProbe: vi.fn().mockRejectedValue(new Error('duration parser crashed')),
        channelCountProbe: vi.fn().mockRejectedValue(new Error('header parser crashed')),
      }),
    ).resolves.toMatchObject({
      durationSeconds: null,
      probedChannelCount: null,
      hasReliableMetadata: false,
      estimatedPcmBytes: 2 * MIB * 64,
    });
  });

  it('bounds a stalled header probe so warning analysis cannot hold decode admission forever', async () => {
    vi.useFakeTimers();
    try {
      const budget = resolveDecodeMemoryBudget({ userAgent: 'Mozilla/5.0 (iPhone)' });
      const admission = assertBlobCanDecodeToAudioBuffer({ size: 2 * MIB } as Blob, {
        budget,
        durationProbe: vi.fn().mockResolvedValue(60),
        channelCountProbe: vi.fn(() => new Promise<number | null>(() => undefined)),
      });

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(admission).resolves.toMatchObject({
        durationSeconds: 60,
        probedChannelCount: null,
        hasReliableMetadata: true,
        channelCount: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not turn an absurd metadata estimate into a production admission limit', async () => {
    const budget = resolveDecodeMemoryBudget({ userAgent: 'Mozilla/5.0 (iPhone)' });

    await expect(
      assertBlobCanDecodeToAudioBuffer({ size: 2 * MIB } as Blob, {
        budget,
        durationProbe: vi.fn().mockResolvedValue(Number.MAX_VALUE),
        channelCountProbe: vi.fn().mockResolvedValue(2),
      }),
    ).resolves.toMatchObject({
      hasReliableMetadata: false,
      estimatedPcmBytes: 2 * MIB * 64,
    });
  });

  it('accepts a large browser-reported AudioBuffer footprint under the legacy policy', () => {
    const budget = resolveDecodeMemoryBudget({ userAgent: 'Mozilla/5.0 (iPhone)' });
    const frames = (600 * MIB) / 4;

    expect(
      assertDecodedAudioBufferWithinBudget({ length: frames, numberOfChannels: 1 }, 1, {
        budget,
        fileName: 'oversized.wav',
      }),
    ).toBe(600 * MIB + 2);
  });

  it('uses the AudioContext output rate and probed multichannel layout', async () => {
    const budget = HIGH_MEMORY_BOUNDED_BUDGET;
    const admission = await assertBlobCanDecodeToAudioBuffer({ size: 1 * MIB } as Blob, {
      budget,
      durationProbe: vi.fn().mockResolvedValue(60),
      channelCountProbe: vi.fn().mockResolvedValue(6),
      outputSampleRate: 96_000,
      fileName: '96k-5.1.wav',
    });

    expect(admission).toMatchObject({ channelCount: 6, outputSampleRate: 96_000 });
    expect(admission.estimatedPcmBytes).toBe(60 * 96_000 * 6 * 4 * 1.25);
  });

  it('uses 32 channels when a bounded header probe cannot identify the layout', async () => {
    const budget = HIGH_MEMORY_BOUNDED_BUDGET;
    const admission = await assertBlobCanDecodeToAudioBuffer({ size: 1 } as Blob, {
      budget,
      durationProbe: vi.fn().mockResolvedValue(30),
      channelCountProbe: vi.fn().mockResolvedValue(null),
    });

    expect(admission.channelCount).toBe(32);
    expect(admission.estimatedPcmBytes).toBe(30 * 48_000 * 32 * 4 * 1.25);
  });

  it('evaluates in-flight reservations after the async metadata probes settle', async () => {
    const budget = STANDARD_BOUNDED_BUDGET;
    let resolveDuration!: (duration: number) => void;
    const durationProbe = vi.fn(() => {
      return new Promise<number>((resolve) => {
        resolveDuration = resolve;
      });
    });
    const admission = assertBlobCanDecodeToAudioBuffer({ size: 1 } as Blob, {
      budget,
      durationProbe,
      channelCountProbe: vi.fn().mockResolvedValue(2),
    });
    const competingLease = reserveDecodeMemoryWithinBudget(budget.maxDecodeWorkingSetBytes, {
      budget,
    });

    try {
      resolveDuration(1);
      await expect(admission).rejects.toMatchObject({ reason: 'working-set' });
    } finally {
      competingLease.release();
    }
  });

  it('counts each global decode lease exactly once during atomic reservation', () => {
    const budget = STANDARD_BOUNDED_BUDGET;
    // 300 + 200 MiB fits the 768 MiB standard budget. Counting the first
    // lease twice would project 800 MiB and incorrectly reject the second.
    const first = reserveDecodeMemoryWithinBudget(300 * MIB, { budget });
    let second: ReturnType<typeof reserveDecodeMemoryWithinBudget> | undefined;
    try {
      expect(() => {
        second = reserveDecodeMemoryWithinBudget(200 * MIB, { budget });
      }).not.toThrow();
    } finally {
      second?.release();
      first.release();
    }
  });

  it('atomically admits only one of two decodes whose probes finish together', async () => {
    const budget = STANDARD_BOUNDED_BUDGET;
    const blob = { size: 6 * MIB } as Blob;
    const options = {
      budget,
      durationProbe: vi.fn().mockResolvedValue(null),
      channelCountProbe: vi.fn().mockResolvedValue(null),
    };
    const [first, second] = await Promise.all([
      assertBlobCanDecodeToAudioBuffer(blob, options),
      assertBlobCanDecodeToAudioBuffer(blob, options),
    ]);

    const reservation = reserveDecodeMemoryWithinBudget(first.ownDecodeFootprintBytes, { budget });
    try {
      expect(() =>
        reserveDecodeMemoryWithinBudget(second.ownDecodeFootprintBytes, {
          budget,
        }),
      ).toThrowError(expect.objectContaining({ reason: 'working-set' }));
    } finally {
      reservation.release();
    }
  });

  it('admits whole-object transfer before its two overlapping copies allocate', () => {
    const budget = IOS_BOUNDED_BUDGET;

    const safeReservation = reserveRemoteTransportMemoryWithinBudget(160 * MIB, {
      budget,
      fileName: 'safe.wav',
    });
    safeReservation.release();
    expect(() =>
      reserveRemoteTransportMemoryWithinBudget(161 * MIB, {
        budget,
        fileName: 'unsafe.wav',
      }),
    ).toThrowError(expect.objectContaining({ reason: 'transport-working-set' }));
  });

  it('includes an active remote transport lease in a new decode decision', async () => {
    const budget = STANDARD_BOUNDED_BUDGET;
    const remoteTransport = reserveRemoteTransportMemoryWithinBudget(200 * MIB, {
      budget: HIGH_MEMORY_BOUNDED_BUDGET,
    });
    try {
      await expect(
        assertBlobCanDecodeToAudioBuffer({ size: 80 * MIB } as Blob, {
          budget,
          durationProbe: vi.fn().mockResolvedValue(460),
          channelCountProbe: vi.fn().mockResolvedValue(2),
          fileName: 'next.mp3',
        }),
      ).rejects.toMatchObject({ reason: 'working-set' });
    } finally {
      remoteTransport.release();
    }
  });

  it('includes an active native decode lease in a new remote transport decision', () => {
    const budget = IOS_BOUNDED_BUDGET;
    const decode = reserveDecodeMemoryWithinBudget(1 * MIB, { budget });
    try {
      expect(() =>
        reserveRemoteTransportMemoryWithinBudget(160 * MIB, {
          budget,
          fileName: 'next.wav',
        }),
      ).toThrowError(expect.objectContaining({ reason: 'transport-working-set' }));
    } finally {
      decode.release();
    }
  });

  it('rejects a P2P receive before its two-copy iOS assembly peak exceeds RAM', () => {
    const budget = IOS_BOUNDED_BUDGET;
    const safe = reserveEncodedReceiveMemoryWithinBudget(160 * MIB, { budget });
    safe.release();

    expect(() =>
      reserveEncodedReceiveMemoryWithinBudget(161 * MIB, { budget, fileName: 'too-large.wav' }),
    ).toThrowError(expect.objectContaining({ reason: 'receive-working-set' }));
  });

  it('shrinks a finalized receive lease while retaining its encoded Blob bytes', () => {
    const budget = IOS_BOUNDED_BUDGET;
    const first = reserveEncodedReceiveMemoryWithinBudget(80 * MIB, { budget });
    try {
      expect(() => reserveEncodedReceiveMemoryWithinBudget(120 * MIB, { budget })).toThrowError(
        expect.objectContaining({ reason: 'receive-working-set' }),
      );
      first.markFinalized();
      const second = reserveEncodedReceiveMemoryWithinBudget(120 * MIB, { budget });
      second.release();
    } finally {
      first.release();
    }
  });

  it('excludes only the source Blob receive lease across both decode rechecks', async () => {
    const budget = IOS_BOUNDED_BUDGET;
    const blob = { size: 100 * MIB } as Blob;
    const receive = reserveEncodedReceiveMemoryWithinBudget(blob.size, { budget });
    receive.markFinalized();
    bindEncodedReceiveReservationToBlob(blob, receive.id);

    try {
      const admission = await assertBlobCanDecodeToAudioBuffer(blob, {
        budget,
        durationProbe: vi.fn().mockResolvedValue(180),
        channelCountProbe: vi.fn().mockResolvedValue(2),
      });
      expect(admission.sourceEncodedReceiveReservationId).toBe(receive.id);

      const decode = reserveDecodeMemoryWithinBudget(admission.ownDecodeFootprintBytes, {
        budget,
        excludeEncodedReceiveReservationId: admission.sourceEncodedReceiveReservationId,
      });
      try {
        expect(() =>
          assertDecodedAudioBufferWithinBudget(
            { length: 180 * 48_000, numberOfChannels: 2, sampleRate: 48_000 },
            blob.size,
            {
              budget,
              excludeDecodeReservationId: decode.id,
              excludeEncodedReceiveReservationId: admission.sourceEncodedReceiveReservationId,
            },
          ),
        ).not.toThrow();
      } finally {
        decode.release();
      }
    } finally {
      receive.release();
    }
  });

  it('does not wait forever on its own finalized source lease', async () => {
    const budget = IOS_BOUNDED_BUDGET;
    const blob = { size: 100 * MIB } as Blob;
    const receive = reserveEncodedReceiveMemoryWithinBudget(blob.size, { budget });
    receive.markFinalized();
    bindEncodedReceiveReservationToBlob(blob, receive.id);
    try {
      await expect(
        waitForInFlightMemoryReservationChange(undefined, {
          excludeEncodedReceiveReservationId: receive.id,
        }),
      ).resolves.toBe(false);
      await expect(waitForInFlightMemoryReservationChange()).resolves.toBe(false);
    } finally {
      receive.release();
    }
  });

  it('atomically hands a remote transport peak to a retained encoded lease', () => {
    const budget = IOS_BOUNDED_BUDGET;
    const file = { size: 80 * MIB } as Blob;
    const transport = reserveRemoteTransportMemoryWithinBudget(file.size, { budget });
    const retained = transport.handoffToRetainedEncoded(file, file.size);
    try {
      expect(memoryReservationStatsForTests()).toMatchObject({
        remoteTransportBytes: 0,
        encodedReceiveBytes: 80 * MIB,
        encodedReceiveCount: 1,
        waitableEncodedReceiveCount: 0,
      });
      expect(() => reserveEncodedReceiveMemoryWithinBudget(121 * MIB, { budget })).toThrowError(
        expect.objectContaining({ reason: 'receive-working-set' }),
      );
    } finally {
      retained.release();
    }

    const next = reserveEncodedReceiveMemoryWithinBudget(121 * MIB, { budget });
    next.release();
  });
});
