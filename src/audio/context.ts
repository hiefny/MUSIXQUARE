/**
 * MUSIXQUARE — AudioContext Singleton
 *
 * Replaces Tone.js context management with a direct AudioContext.
 * All audio modules import from here instead of Tone.
 */

let _ctx: AudioContext | null = null;

/**
 * Get or create the shared AudioContext.
 * Created lazily on first call (should be inside a user gesture handler).
 */
export function getAudioContext(): AudioContext {
  if (!_ctx) {
    _ctx = new AudioContext();
  }
  return _ctx;
}

/**
 * Current audio clock time (replacement for Tone.now()).
 */
export function getCurrentTime(): number {
  return _ctx ? _ctx.currentTime : 0;
}

/**
 * Ensure AudioContext is running (replacement for Tone.start()).
 * Must be called from a user gesture on iOS/Safari.
 */
export async function ensureRunning(): Promise<void> {
  const ctx = getAudioContext();
  if (ctx.state !== 'running') {
    await ctx.resume();
  }
}
