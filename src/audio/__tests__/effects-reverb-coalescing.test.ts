/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateReverbIR: vi.fn(() => ({ id: Symbol('ir') })),
  reverb: { buffer: null as unknown },
}));

vi.mock('../engine.ts', () => ({
  getMasterGain: () => ({ gain: {} }),
  getReverb: () => mocks.reverb,
  getRvbLowCut: () => null,
  getRvbHighCut: () => null,
  getRvbCrossFade: () => null,
  getEqNodes: () => [],
  getPreamp: () => null,
  getWidener: () => null,
  getGlobalLowPass: () => null,
  getVbGain: () => null,
  getExciterGain: () => null,
}));

vi.mock('../helpers.ts', () => ({
  rampParam: vi.fn(),
  setCrossFade: vi.fn(),
  generateReverbIR: mocks.generateReverbIR,
  getFullRangeFrequency: () => 20_000,
  clampFilterFrequency: (value: number) => value,
}));

import { resetState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { setReverbParam } from '../effects.ts';

describe('reverb impulse preview coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearAllManagedTimers();
    resetState();
    mocks.generateReverbIR.mockClear();
    mocks.reverb.buffer = null;
  });

  afterEach(() => {
    clearAllManagedTimers();
    vi.useRealTimers();
  });

  it('coalesces shape previews and commits the exact final change immediately', () => {
    setReverbParam('decay', 4, false, true);
    setReverbParam('decay', 5, false, true);
    setReverbParam('decay', 6, false, true);

    expect(mocks.generateReverbIR).not.toHaveBeenCalled();
    vi.advanceTimersByTime(140);
    expect(mocks.generateReverbIR).toHaveBeenCalledTimes(1);
    expect(mocks.generateReverbIR).toHaveBeenLastCalledWith(6, 0.1);

    setReverbParam('predelay', 0.2, false, true);
    setReverbParam('predelay', 0.25);
    expect(mocks.generateReverbIR).toHaveBeenCalledTimes(2);
    expect(mocks.generateReverbIR).toHaveBeenLastCalledWith(6, 0.25);

    vi.runAllTimers();
    expect(mocks.generateReverbIR).toHaveBeenCalledTimes(2);
  });
});
