import { describe, expect, it } from 'vitest';

import { clampFilterFrequency, getFullRangeFrequency, makeExciterCurve } from '../helpers.ts';

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
