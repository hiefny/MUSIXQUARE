import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeAudioContext, FakeNode, FakeParam } from './__helpers__/fake-audio-context.ts';

const h = vi.hoisted(() => ({ ctx: null as unknown as FakeAudioContext }));

vi.mock('../context.ts', async () => {
  const { createFakeAudioContext } = await import('./__helpers__/fake-audio-context.ts');
  h.ctx = createFakeAudioContext(48_000);
  return { getAudioContext: () => h.ctx };
});

import {
  clampFilterFrequency,
  createStereoWidener,
  generateReverbIR,
  getFullRangeFrequency,
  makeExciterCurve,
  rampParam,
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

    const buffer = generateReverbIR(1);
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

  it('holds only the decay, so pre-delay cannot change its normalization', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);

    const buffer = generateReverbIR(0.5);

    expect(buffer.length).toBe(24_000);
    expect(buffer.getChannelData(0)[0]).toBeGreaterThan(0);
    expect(buffer.getChannelData(1)[0]).toBeGreaterThan(0);
  });
});

describe('rampParam', () => {
  it('holds the current value for the delay before a positive ramp', () => {
    h.ctx.currentTime = 2;
    const gain = (h.ctx.createGain as () => FakeNode)().gain as FakeParam;
    gain.value = 0;
    h.ctx.trace.length = 0;

    rampParam(gain as unknown as AudioParam, 0.5, 0.1, 0.02);

    expect(h.ctx.trace).toEqual([
      { op: 'set', param: gain, value: 0, time: 2.02 },
      { op: 'ramp', param: gain, value: 0.5, time: expect.closeTo(2.12) },
    ]);
  });
});

describe('createStereoWidener', () => {
  it('renders two speaker channels so mono reaches both sides and 5.1 keeps its centre', () => {
    const widener = createStereoWidener();
    const input = widener.input as unknown as FakeNode;

    // The splitter behind the input is explicit/discrete. A max/discrete
    // input would pass mono through to the left only and keep only the first
    // two of six 5.1 channels.
    expect(input.channelCount).toBe(2);
    expect(input.channelCountMode).toBe('explicit');
    expect(input.channelInterpretation).toBe('speakers');
    expect([...input.outputs].map((node) => node.kind)).toEqual(['ChannelSplitter']);
  });
});
