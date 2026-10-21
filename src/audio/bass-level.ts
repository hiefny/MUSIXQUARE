/**
 * Bass reading shared by the play-tab visualizer and the screensaver glow.
 *
 * Both read the 0–140 Hz band, with independent smoothing and response curves.
 */

/** Number of FFT bins whose centers fall below 140 Hz, including DC. */
export function bassBinCount(sampleRate: number, fftSize: number): number {
  if (!(sampleRate > 0) || !(fftSize > 0)) return 0;
  return Math.min(fftSize / 2, Math.ceil((140 * fftSize) / sampleRate));
}

/** Mean of a frequency band on the same 0–255 scale as the circular visualizer. */
export function averageFrequencyLevel(
  dbData: Float32Array,
  sampleRate: number,
  minHz: number,
  maxHz: number,
): number {
  if (!(sampleRate > 0) || maxHz < minHz) return 0;
  const binsPerHz = (dbData.length * 2) / sampleRate;
  const start = Math.max(0, Math.ceil(minHz * binsPerHz));
  const end = Math.min(dbData.length, Math.floor(maxHz * binsPerHz) + 1);
  return averageLevel(dbData, start, end);
}

/** Average energy of the first `binCount` bins on the visualizer's 0–255 scale. */
export function averageBassLevel(dbData: Float32Array, binCount: number): number {
  return averageLevel(dbData, 0, Math.min(dbData.length, binCount));
}

function averageLevel(dbData: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) {
    let value = (dbData[i] + 100) * 2.5;
    if (!isFinite(value)) value = 0;
    if (value < 0) value = 0;
    if (value > 255) value = 255;
    sum += value;
  }
  return end > start ? sum / (end - start) : 0;
}

/** The visualizer's bass punch curve: quiet passages stay near 0, kicks approach 1. */
export function bassPunch(level: number): number {
  const punch = Math.pow(level / 255, 2.5);
  return isFinite(punch) ? punch : 0;
}
