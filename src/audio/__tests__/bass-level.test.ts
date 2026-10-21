import { describe, expect, it } from 'vitest';
import { averageBassLevel, averageFrequencyLevel, bassBinCount } from '../bass-level.ts';

describe('visualizer frequency bands', () => {
  it.each([44100, 48000, 96000])('uses Hz boundaries at a %i Hz sample rate', (sampleRate) => {
    const data = new Float32Array(2048).fill(-Infinity);
    const resolution = sampleRate / 4096;
    const count = bassBinCount(sampleRate, 4096);
    expect((count - 1) * resolution).toBeLessThan(140);
    expect(count * resolution).toBeGreaterThanOrEqual(140);
    data.fill(-20, 0, count);
    expect(averageBassLevel(data, count)).toBe(200);
    data.fill(-Infinity);
    const start = Math.ceil(7500 / resolution);
    const end = Math.floor(20000 / resolution) + 1;
    data.fill(-20, start, end);
    expect(averageFrequencyLevel(data, sampleRate, 7500, 20000)).toBe(200);
    data.fill(-Infinity, start, end);
    data[start - 1] = 0;
    data[end] = 0;
    expect(averageFrequencyLevel(data, sampleRate, 7500, 20000)).toBe(0);
  });

  it('retains the existing 48 kHz bass band and safely clamps empty/out-of-range bands', () => {
    expect(bassBinCount(48000, 4096)).toBe(12);
    expect(bassBinCount(0, 4096)).toBe(0);
    const data = new Float32Array(8).fill(-20);
    expect(averageBassLevel(data, 12)).toBe(200);
    expect(averageBassLevel(data, 0)).toBe(0);
    expect(averageFrequencyLevel(data, 48000, 25000, 30000)).toBe(0);
    expect(averageFrequencyLevel(data, 0, 0, 20000)).toBe(0);
    expect(averageFrequencyLevel(data, 48000, 20000, 1000)).toBe(0);
  });

  it('keeps silence and invalid bins finite on the display scale', () => {
    const data = new Float32Array([-Infinity, NaN, Infinity, -120, 20]);
    expect(averageBassLevel(data, data.length)).toBe(51);
    expect(averageFrequencyLevel(data, 48000, 0, 24000)).toBe(51);
  });
});
