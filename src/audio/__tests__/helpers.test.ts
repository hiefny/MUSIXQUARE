import { describe, expect, it } from 'vitest';

import { makeExciterCurve } from '../helpers.ts';

describe('makeExciterCurve', () => {
  it('keeps silence centered while using an asymmetric transfer curve', () => {
    const curve = makeExciterCurve(4.5, 257, 0.28);
    const mid = Math.floor(curve.length / 2);

    expect(curve[mid]).toBeCloseTo(0, 6);
    expect(curve[0]).toBeGreaterThanOrEqual(-1);
    expect(curve[curve.length - 1]).toBeLessThanOrEqual(1);

    // A biased curve should not be odd-symmetric; this is what preserves
    // even-order harmonics for the air-band exciter.
    expect(curve[32]).not.toBeCloseTo(-curve[curve.length - 1 - 32], 3);
  });
});
