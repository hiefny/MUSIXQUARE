/**
 * Bass reading shared by the play-tab visualizer and the screensaver glow.
 *
 * Both read the engine analyser's dB spectrum and treat its lowest bins as
 * the kick/bass band, so the screensaver reacts to exactly what the circular
 * visualizer draws.
 */

/** Lowest analyser bins read as bass: about 0–140 Hz at the engine's FFT size. */
export const BASS_BIN_COUNT = 12;

/** Average energy of the first `binCount` bins on the visualizer's 0–255 scale. */
export function averageBassLevel(dbData: Float32Array, binCount: number): number {
  let sum = 0;
  for (let i = 0; i < binCount; i++) {
    let value = (dbData[i] + 100) * 2.5;
    if (!isFinite(value)) value = 0;
    if (value < 0) value = 0;
    if (value > 255) value = 255;
    sum += value;
  }
  return binCount > 0 ? sum / binCount : 0;
}

/** The visualizer's bass punch curve: quiet passages stay near 0, kicks approach 1. */
export function bassPunch(level: number): number {
  const punch = Math.pow(level / 255, 2.5);
  return isFinite(punch) ? punch : 0;
}
