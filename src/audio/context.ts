/**
 * MUSIXQUARE — AudioContext Singleton
 *
 * Owns the lazily created native AudioContext shared by all audio modules.
 */

import { delay } from '../core/timers.ts';

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
 * Return the current audio clock time, or zero before initialization.
 */
export function getCurrentTime(): number {
  return _ctx ? _ctx.currentTime : 0;
}

/**
 * Ensure the shared AudioContext is running.
 * Must be called from a user gesture on iOS/Safari.
 */
export async function ensureRunning(): Promise<void> {
  const ctx = getAudioContext();
  if (ctx.state !== 'running') {
    // Add a race to prevent hanging on browsers that don't resolve resume() without a gesture
    await Promise.race([ctx.resume(), delay(500)]);
  }
}
