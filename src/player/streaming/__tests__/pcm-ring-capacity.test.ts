import { describe, expect, it } from 'vitest';
import {
  PCM_RING_DEFAULT_MAX_BYTES,
  PCM_RING_HARD_MAX_BYTES,
  planPcmRingCapacity,
} from '../pcm-ring-capacity.ts';

const MIB = 1024 * 1024;

describe('PCM ring capacity planner', () => {
  it.each([
    {
      sampleRate: 44_100,
      channels: 1,
      capacityFrames: 529_200,
      primeFrames: 176_400,
      allocationBytes: 2_116_800,
    },
    {
      sampleRate: 48_000,
      channels: 2,
      capacityFrames: 576_000,
      primeFrames: 192_000,
      allocationBytes: 4_608_000,
    },
    {
      sampleRate: 48_000,
      channels: 8,
      capacityFrames: 576_000,
      primeFrames: 192_000,
      allocationBytes: 18_432_000,
    },
    {
      sampleRate: 96_000,
      channels: 8,
      capacityFrames: 1_048_576,
      primeFrames: 384_000,
      allocationBytes: PCM_RING_DEFAULT_MAX_BYTES,
    },
    {
      sampleRate: 192_000,
      channels: 8,
      capacityFrames: 1_048_576,
      primeFrames: 768_000,
      allocationBytes: PCM_RING_DEFAULT_MAX_BYTES,
    },
    {
      sampleRate: 352_800,
      channels: 8,
      capacityFrames: 1_048_576,
      primeFrames: 960_376,
      allocationBytes: PCM_RING_DEFAULT_MAX_BYTES,
    },
    {
      sampleRate: 768_000,
      channels: 8,
      capacityFrames: 1_048_576,
      primeFrames: 856_576,
      allocationBytes: PCM_RING_DEFAULT_MAX_BYTES,
    },
  ])(
    'plans $sampleRate Hz / $channels channel(s) within both caps',
    ({ sampleRate, channels, capacityFrames, primeFrames, allocationBytes }) => {
      const plan = planPcmRingCapacity({ sampleRate, channels });
      expect(plan).toEqual({
        capacityFrames,
        primeFrames,
        highWaterFrames: Math.max(primeFrames, Math.floor(capacityFrames * 0.8)),
        allocationBytes,
      });
      expect(plan.allocationBytes).toBeLessThanOrEqual(PCM_RING_DEFAULT_MAX_BYTES);
      expect(plan.highWaterFrames).toBeGreaterThanOrEqual(plan.primeFrames);
      expect(plan.highWaterFrames).toBeLessThanOrEqual(plan.capacityFrames);
    },
  );

  it('accepts the exact 768 kHz / 8-channel minimum and rejects one byte less', () => {
    const exactMinimumBytes = 30_720_000;
    expect(
      planPcmRingCapacity({
        sampleRate: 768_000,
        channels: 8,
        maxRingBytes: exactMinimumBytes,
      }),
    ).toEqual({
      capacityFrames: 960_000,
      primeFrames: 768_000,
      highWaterFrames: 768_000,
      allocationBytes: exactMinimumBytes,
    });
    expect(() =>
      planPcmRingCapacity({
        sampleRate: 768_000,
        channels: 8,
        maxRingBytes: exactMinimumBytes - 1,
      }),
    ).toThrow(/minimum PCM prime/u);
  });

  it('accepts channel and sample-rate boundaries', () => {
    expect(planPcmRingCapacity({ sampleRate: 44_100, channels: 1 }).capacityFrames).toBe(529_200);
    expect(planPcmRingCapacity({ sampleRate: 768_000, channels: 8 }).allocationBytes).toBe(
      32 * MIB,
    );
  });

  it.each([
    { sampleRate: 44_099, channels: 1 },
    { sampleRate: 768_001, channels: 1 },
    { sampleRate: 48_000, channels: 0 },
    { sampleRate: 48_000, channels: 9 },
    { sampleRate: 48_000, channels: 1.5 },
    { sampleRate: 48_000.5, channels: 2 },
    { sampleRate: Number.NaN, channels: 2 },
    { sampleRate: Number.POSITIVE_INFINITY, channels: 2 },
    { sampleRate: '48000', channels: 2 },
    { sampleRate: 48_000, channels: '2' },
  ])('rejects invalid channel/sample-rate values %#', (options) => {
    expect(() => planPcmRingCapacity(options)).toThrow(RangeError);
  });

  it.each([
    { capacitySeconds: 1.249 },
    { capacitySeconds: 20.001 },
    { capacitySeconds: Number.NaN },
    { capacitySeconds: '12' },
    { primeSeconds: 0.999 },
    { primeSeconds: 20.001 },
    { primeSeconds: Number.POSITIVE_INFINITY },
    { primeSeconds: '4' },
    { maxRingBytes: 0 },
    { maxRingBytes: 1.5 },
    { maxRingBytes: PCM_RING_HARD_MAX_BYTES + 1 },
    { maxRingBytes: '33554432' },
  ])('rejects invalid optional numeric values %#', (override) => {
    expect(() => planPcmRingCapacity({ sampleRate: 48_000, channels: 2, ...override })).toThrow(
      RangeError,
    );
  });

  it('accepts exact duration and byte ceilings', () => {
    const plan = planPcmRingCapacity({
      sampleRate: 44_100,
      channels: 1,
      capacitySeconds: 20,
      primeSeconds: 20,
      maxRingBytes: PCM_RING_HARD_MAX_BYTES,
    });
    expect(plan).toEqual({
      capacityFrames: 882_000,
      primeFrames: 870_975,
      highWaterFrames: 870_975,
      allocationBytes: 3_528_000,
    });
  });

  it('rejects non-records, missing fields, extra keys, accessors, and symbols', () => {
    expect(() => planPcmRingCapacity(null)).toThrow(TypeError);
    expect(() => planPcmRingCapacity([])).toThrow(TypeError);
    expect(() => planPcmRingCapacity({ channels: 2 })).toThrow(TypeError);
    expect(() =>
      planPcmRingCapacity({ sampleRate: 48_000, channels: 2, unexpected: true }),
    ).toThrow(TypeError);
    expect(() => planPcmRingCapacity({ sampleRate: Symbol('rate'), channels: 2 })).toThrow(
      RangeError,
    );

    const accessor = { channels: 2 } as { channels: number; sampleRate?: number };
    Object.defineProperty(accessor, 'sampleRate', {
      enumerable: true,
      get: () => 48_000,
    });
    expect(() => planPcmRingCapacity(accessor)).toThrow(TypeError);

    const symbolKey = { sampleRate: 48_000, channels: 2 } as Record<PropertyKey, unknown>;
    symbolKey[Symbol('extra')] = true;
    expect(() => planPcmRingCapacity(symbolKey)).toThrow(TypeError);
  });

  it('keeps a two-renderer iOS ring budget at or below 64 MiB', () => {
    const current = planPcmRingCapacity({ sampleRate: 768_000, channels: 8 });
    const candidate = planPcmRingCapacity({ sampleRate: 768_000, channels: 8 });
    expect(current.allocationBytes + candidate.allocationBytes).toBe(PCM_RING_HARD_MAX_BYTES);
  });

  it('returns an immutable body-free plan', () => {
    const plan = planPcmRingCapacity({ sampleRate: 48_000, channels: 2 });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.keys(plan)).toEqual([
      'capacityFrames',
      'primeFrames',
      'highWaterFrames',
      'allocationBytes',
    ]);
  });
});
