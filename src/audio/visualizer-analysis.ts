/** Shared raw FFT reads; each visual surface owns its own smoothing history. */
const FRAME_MS = 1000 / 60;
const CLOCK_TOLERANCE_MS = 1;
const RESET_GAP_MS = 250;

interface RawSpectrum {
  data: Float32Array<ArrayBuffer>;
  magnitudes: Float32Array<ArrayBuffer>;
  sampledAt: number;
  nextAt: number;
}

const rawSpectra = new WeakMap<AnalyserNode, RawSpectrum>();

function readRawSpectrum(analyser: AnalyserNode, now: number): RawSpectrum {
  let raw = rawSpectra.get(analyser);
  if (!raw || raw.data.length !== analyser.frequencyBinCount) {
    raw = {
      data: new Float32Array(analyser.frequencyBinCount),
      magnitudes: new Float32Array(analyser.frequencyBinCount),
      sampledAt: -Infinity,
      nextAt: now,
    };
    rawSpectra.set(analyser, raw);
  }
  // Smoothing on this shared node would let another surface change our envelope.
  analyser.smoothingTimeConstant = 0;
  const clockReversed = now < raw.sampledAt;
  if (!clockReversed && now + CLOCK_TOLERANCE_MS < raw.nextAt) return raw;
  analyser.getFloatFrequencyData(raw.data);
  for (let i = 0; i < raw.data.length; i++) {
    const db = raw.data[i];
    raw.magnitudes[i] = Number.isFinite(db) ? Math.pow(10, db / 20) : 0;
  }
  raw.sampledAt = now;
  // Preserve phase instead of adding an interval to every slightly late rAF.
  raw.nextAt = clockReversed
    ? now + FRAME_MS
    : raw.nextAt + Math.max(1, Math.floor((now - raw.nextAt) / FRAME_MS) + 1) * FRAME_MS;
  return raw;
}

export function createSpectrumReader(smoothing: number): {
  read(analyser: AnalyserNode, now: number): Float32Array<ArrayBuffer>;
  reset(): void;
} {
  const coefficient = Math.max(0, Math.min(1, smoothing));
  let previous: RawSpectrum | null = null;
  let readAt = 0;
  let magnitudes = new Float32Array(0);
  let output = new Float32Array(0);

  return {
    read(analyser, now) {
      const raw = readRawSpectrum(analyser, now);
      const elapsed = now - readAt;
      const reset = previous !== raw || elapsed < 0 || elapsed > RESET_GAP_MS;
      if (output.length !== raw.data.length) {
        magnitudes = new Float32Array(raw.data.length);
        output = new Float32Array(raw.data.length);
      }
      const hold = reset ? 0 : Math.pow(coefficient, elapsed / FRAME_MS);
      for (let i = 0; i < output.length; i++) {
        const before = magnitudes[i];
        magnitudes[i] = before * hold + raw.magnitudes[i] * (1 - hold);
        const after = magnitudes[i];
        // Keep display-rate motion between FFT reads without repeating dB work
        // after a bin has converged (including silence).
        if (reset || after !== before) output[i] = after > 0 ? 20 * Math.log10(after) : -Infinity;
      }
      previous = raw;
      readAt = now;
      return output;
    },
    reset() {
      previous = null;
    },
  };
}
