import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../context.ts', () => ({
  getAudioContext: () => ({
    currentTime: 0,
    sampleRate: 48_000,
    createBuffer: (channels: number, length: number, sampleRate: number) => {
      const channelData = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        length,
        numberOfChannels: channels,
        sampleRate,
        getChannelData: (channel: number) => channelData[channel],
      } as AudioBuffer;
    },
  }),
}));

import {
  clampFilterFrequency,
  generateReverbIR,
  getFullRangeFrequency,
  makeExciterCurve,
} from '../helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getFullRangeFrequency', () => {
  it('opens the full-range cutoff to a safe Nyquist margin', () => {
    expect(getFullRangeFrequency(44_100)).toBeCloseTo(21_609, 5);
    expect(getFullRangeFrequency(48_000)).toBeCloseTo(23_520, 5);
  });

  it('falls back to the UI-facing 20 kHz marker without a valid sample rate', () => {
    expect(getFullRangeFrequency()).toBe(20_000);
    expect(getFullRangeFrequency(0)).toBe(20_000);
  });

  it('clamps explicit filter cutoffs below the safe Nyquist margin', () => {
    expect(clampFilterFrequency(30_000, 48_000)).toBeCloseTo(23_520, 5);
    expect(clampFilterFrequency(18_000, 48_000)).toBe(18_000);
  });
});

describe('makeExciterCurve', () => {
  it('keeps silence centered while using a symmetric default transfer curve', () => {
    const curve = makeExciterCurve(4.5, 257);
    const mid = Math.floor(curve.length / 2);

    expect(curve[mid]).toBeCloseTo(0, 6);
    expect(curve[0]).toBeGreaterThanOrEqual(-1);
    expect(curve[curve.length - 1]).toBeLessThanOrEqual(1);

    // Zero bias should stay odd-symmetric, keeping the exciter return cleaner.
    expect(curve[32]).toBeCloseTo(-curve[curve.length - 1 - 32], 3);
  });

  it('still supports asymmetric curves for bias experiments', () => {
    const curve = makeExciterCurve(4.5, 257, 0.28);

    expect(curve[32]).not.toBeCloseTo(-curve[curve.length - 1 - 32], 3);
  });
});

describe('generateReverbIR', () => {
  it('darkens the reverb tail with frequency-dependent damping', () => {
    let callCount = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      const sampleIndex = Math.floor(callCount++ / 2);
      return sampleIndex % 2 === 0 ? 0 : 1;
    });

    const buffer = generateReverbIR(1, 0);
    const left = buffer.getChannelData(0);

    const normalizedDelta = (start: number, length: number) => {
      let delta = 0;
      let level = 0;
      for (let i = start + 1; i < start + length; i++) {
        delta += Math.abs(left[i] - left[i - 1]);
        level += Math.abs(left[i]);
      }
      return delta / Math.max(level, Number.EPSILON);
    };

    expect(normalizedDelta(left.length - 4096, 4096)).toBeLessThan(normalizedDelta(256, 4096));
  });
});
