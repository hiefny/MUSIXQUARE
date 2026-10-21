import { describe, expect, it, vi } from 'vitest';
import { createSpectrumReader } from '../visualizer-analysis.ts';

const FRAME_MS = 1000 / 60;

function fixture(initialDb = -Infinity, binCount = 4) {
  let db = initialDb;
  const getFloatFrequencyData = vi.fn((data: Float32Array) => data.fill(db));
  const analyser = {
    frequencyBinCount: binCount,
    smoothingTimeConstant: 0.8,
    getFloatFrequencyData,
  } as unknown as AnalyserNode;
  return { analyser, getFloatFrequencyData, setDb: (value: number) => (db = value) };
}

describe('visualizer spectrum readers', () => {
  it('shares raw reads without sharing smoothing or output buffers', () => {
    const source = fixture();
    const circular = createSpectrumReader(0.3);
    const spectrum = createSpectrumReader(0.8);
    const circleOutput = circular.read(source.analyser, 0);
    const spectrumOutput = spectrum.read(source.analyser, 0.2);
    expect(circleOutput).not.toBe(spectrumOutput);
    expect(source.getFloatFrequencyData).toHaveBeenCalledTimes(1);
    expect(source.analyser.smoothingTimeConstant).toBe(0);
    source.setDb(0);
    circular.read(source.analyser, FRAME_MS);
    spectrum.read(source.analyser, FRAME_MS + 0.2);
    expect(source.getFloatFrequencyData).toHaveBeenCalledTimes(2);
    expect(circleOutput[0]).toBeCloseTo(20 * Math.log10(0.7), 5);
    expect(spectrumOutput[0]).toBeCloseTo(20 * Math.log10(0.2), 5);
    expect(circular.read(source.analyser, FRAME_MS + 2)).toBe(circleOutput);
    expect(circleOutput[0]).toBeGreaterThan(20 * Math.log10(0.7));
    expect(source.getFloatFrequencyData).toHaveBeenCalledTimes(2);
  });

  it('keeps 60 Hz reads through submillisecond rAF jitter', () => {
    const source = fixture(-20);
    const reader = createSpectrumReader(0.3);
    for (let frame = 0; frame <= 120; frame++) {
      reader.read(source.analyser, frame * FRAME_MS + (frame % 3 === 0 ? 0 : 0.5));
    }
    expect(source.getFloatFrequencyData).toHaveBeenCalledTimes(121);
  });

  it('caps 120 Hz consumers at 60 Hz and does not reread for a second consumer', () => {
    const source = fixture(-20);
    const first = createSpectrumReader(0.3);
    const second = createSpectrumReader(0.8);
    for (let frame = 0; frame <= 120; frame++) {
      const now = (frame * 1000) / 120;
      first.read(source.analyser, now);
      second.read(source.analyser, now + 0.1);
    }
    expect(source.getFloatFrequencyData).toHaveBeenCalledTimes(61);
  });

  it('normalizes 30, 60 and 120 Hz decay after a shared target update boundary', () => {
    const source = fixture(0);
    const readers = [30, 60, 120].map((hz) => ({ hz, reader: createSpectrumReader(0.8) }));
    for (const { reader } of readers) reader.read(source.analyser, 0);
    source.setDb(-Infinity);
    for (const { reader } of readers) reader.read(source.analyser, FRAME_MS);
    const outcomes = [0, 0, 0];
    for (let frame = 1; frame <= 12; frame++) {
      for (let i = 0; i < readers.length; i++) {
        const { hz, reader } = readers[i];
        if (frame % (120 / hz) === 0) {
          outcomes[i] = reader.read(source.analyser, FRAME_MS + (frame * 1000) / 120)[0];
        }
      }
    }
    const expected = 20 * Math.log10(0.8 ** 7);
    for (const result of outcomes) expect(result).toBeCloseTo(expected, 5);
    expect(source.getFloatFrequencyData).toHaveBeenCalledTimes(8);
  });

  it('continues the same envelope at 120 Hz between native FFT snapshots', () => {
    const source = fixture(0);
    const reader = createSpectrumReader(0.8);
    reader.read(source.analyser, 0);
    source.setDb(-Infinity);
    const atOneFrame = reader.read(source.analyser, FRAME_MS)[0];
    const atHalfFrame = reader.read(source.analyser, FRAME_MS * 1.5)[0];
    expect(atHalfFrame).toBeLessThan(atOneFrame);
    expect(atHalfFrame).toBeCloseTo(20 * Math.log10(0.8 ** 1.5), 5);
    expect(source.getFloatFrequencyData).toHaveBeenCalledTimes(2);
    reader.read(source.analyser, FRAME_MS * 2);
    expect(source.getFloatFrequencyData).toHaveBeenCalledTimes(3);
  });

  it('snaps after a long gap rather than drawing a stale envelope', () => {
    const source = fixture(-10);
    const reader = createSpectrumReader(0.8);
    reader.read(source.analyser, 0);
    source.setDb(-70);
    expect(reader.read(source.analyser, 1000)[0]).toBeCloseTo(-70, 5);
    expect(source.getFloatFrequencyData).toHaveBeenCalledTimes(2);
    reader.read(source.analyser, 1000 + FRAME_MS);
    expect(source.getFloatFrequencyData).toHaveBeenCalledTimes(3);
  });

  it('resets history when switching source, resizing FFT, or explicitly resetting', () => {
    const first = fixture(-10);
    const second = fixture(-60, 8);
    const reader = createSpectrumReader(0.8);
    reader.read(first.analyser, 0);
    expect(reader.read(second.analyser, FRAME_MS)[0]).toBeCloseTo(-60, 5);
    second.setDb(-30);
    reader.reset();
    expect(reader.read(second.analyser, FRAME_MS * 2)[0]).toBeCloseTo(-30, 5);
    Object.defineProperty(second.analyser, 'frequencyBinCount', { value: 2 });
    second.setDb(-40);
    const resized = reader.read(second.analyser, FRAME_MS * 3);
    expect(resized.length).toBe(2);
    expect(resized[0]).toBeCloseTo(-40, 5);
  });

  it('recovers from backwards timestamps without waiting for the previous deadline', () => {
    const source = fixture(-10);
    const reader = createSpectrumReader(0.8);
    reader.read(source.analyser, 1000);
    source.setDb(-60);
    expect(reader.read(source.analyser, 0)[0]).toBeCloseTo(-60, 5);
    reader.read(source.analyser, FRAME_MS);
    expect(source.getFloatFrequencyData).toHaveBeenCalledTimes(3);
  });

  it.each([-Infinity, Infinity, NaN])('treats invalid or silent FFT data %s as silence', (db) => {
    const source = fixture(db);
    const output = createSpectrumReader(0.3).read(source.analyser, 0);
    expect([...output]).toEqual([-Infinity, -Infinity, -Infinity, -Infinity]);
  });

  it('preserves above-zero magnitude before the renderer clamps the display', () => {
    const source = fixture(6);
    const reader = createSpectrumReader(0.3);
    expect(reader.read(source.analyser, 0)[0]).toBeCloseTo(6, 5);
  });
});
