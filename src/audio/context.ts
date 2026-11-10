/**
 * MUSIXQUARE — AudioContext Singleton
 *
 * Owns the lazily created native AudioContext shared by all audio modules.
 */

import { delay } from '../core/timers.ts';
import {
  AUDIO_CLOCK_MIN_ADVANCE_SECONDS,
  AUDIO_CLOCK_SAMPLE_MS,
  AUDIO_RESUME_DEADLINE_MS,
} from './context-protocol.ts';
import {
  DEADLINE_ENSURE_RUNNING,
  DEADLINE_PROBE,
  RESUME_ENSURE_RUNNING,
  RESUME_PROBE,
  countAudioRecovery,
  raceAudioRecoveryDeadline,
} from './output-recovery-counters.ts';

let _ctx: AudioContext | null = null;

export type AudioContextHealthReason =
  | 'healthy'
  | 'not-created'
  | 'not-running'
  | 'clock-stalled'
  | 'inconclusive'
  | 'hidden'
  | 'superseded';

interface AudioContextHealthResult {
  readonly healthy: boolean;
  readonly reason: AudioContextHealthReason;
  readonly state: string;
  readonly clockAdvanceSeconds: number | null;
}

class AudioContextNotRunningError extends Error {
  constructor(readonly state: string) {
    super(`AudioContext did not enter running state (state: ${state})`);
    this.name = 'AudioContextNotRunningError';
  }
}

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

/** Observe the singleton without creating an AudioContext outside a gesture. */
export function getExistingAudioContext(): AudioContext | null {
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
    countAudioRecovery(RESUME_ENSURE_RUNNING);
    // Add a race to prevent hanging on browsers that don't resolve resume() without a gesture
    await raceAudioRecoveryDeadline(
      DEADLINE_ENSURE_RUNNING,
      ctx.resume(),
      delay(AUDIO_RESUME_DEADLINE_MS),
    );
  }
  // A timeout is not a successful resume. Mobile WebKit can leave resume()
  // pending indefinitely after a page suspension, so every caller must gate
  // source creation on the native state rather than Promise.race settlement.
  if (String(ctx.state) !== 'running') throw new AudioContextNotRunningError(String(ctx.state));
}

async function sampleRunningClock(
  ctx: AudioContext,
  isCurrent: () => boolean,
): Promise<AudioContextHealthResult> {
  let totalAdvance = 0;
  for (let sample = 0; sample < 2; sample += 1) {
    if (String(document.visibilityState) === 'hidden') {
      return {
        healthy: false,
        reason: 'hidden',
        state: String(ctx.state),
        clockAdvanceSeconds: null,
      };
    }
    if (!isCurrent()) {
      return {
        healthy: false,
        reason: 'superseded',
        state: String(ctx.state),
        clockAdvanceSeconds: null,
      };
    }

    const startedAt = ctx.currentTime;
    const wallStartedAt = performance.now();
    await delay(AUDIO_CLOCK_SAMPLE_MS);
    if (!isCurrent()) {
      return {
        healthy: false,
        reason: 'superseded',
        state: String(ctx.state),
        clockAdvanceSeconds: null,
      };
    }
    if (String(document.visibilityState) === 'hidden') {
      return {
        healthy: false,
        reason: 'hidden',
        state: String(ctx.state),
        clockAdvanceSeconds: null,
      };
    }
    if (String(ctx.state) !== 'running') {
      return {
        healthy: false,
        reason: 'not-running',
        state: String(ctx.state),
        clockAdvanceSeconds: null,
      };
    }

    const wallElapsed = performance.now() - wallStartedAt;
    const advance = Math.max(0, ctx.currentTime - startedAt);
    totalAdvance += advance;
    // A throttled/early test timer is inconclusive rather than proof that the
    // native audio clock is dead.
    if (wallElapsed < AUDIO_CLOCK_SAMPLE_MS * 0.75) {
      return {
        healthy: false,
        reason: 'inconclusive',
        state: String(ctx.state),
        clockAdvanceSeconds: totalAdvance,
      };
    }
    if (advance >= AUDIO_CLOCK_MIN_ADVANCE_SECONDS) {
      return {
        healthy: true,
        reason: 'healthy',
        state: String(ctx.state),
        clockAdvanceSeconds: totalAdvance,
      };
    }
  }

  return {
    healthy: false,
    reason: 'clock-stalled',
    state: String(ctx.state),
    clockAdvanceSeconds: totalAdvance,
  };
}

/**
 * Verify that WebKit's native audio clock actually advances after foreground.
 * `state === "running"` alone is insufficient on affected iOS releases.
 * Every caller chooses whether a context that is not running is resumed
 * first (`attemptResume`); there is no default resume.
 */
export async function probeAudioContextHealth(options: {
  attemptResume: boolean;
  isCurrent?: () => boolean;
  context?: AudioContext;
}): Promise<AudioContextHealthResult> {
  const ctx = options.context ?? _ctx;
  if (!ctx) {
    return {
      healthy: true,
      reason: 'not-created',
      state: 'not-created',
      clockAdvanceSeconds: null,
    };
  }
  const isCurrent = options.isCurrent ?? (() => true);
  if (!isCurrent()) {
    return {
      healthy: false,
      reason: 'superseded',
      state: String(ctx.state),
      clockAdvanceSeconds: null,
    };
  }

  if (String(ctx.state) !== 'running' && options.attemptResume) {
    countAudioRecovery(RESUME_PROBE);
    try {
      await raceAudioRecoveryDeadline(
        DEADLINE_PROBE,
        ctx.resume(),
        delay(AUDIO_RESUME_DEADLINE_MS),
      );
    } catch {
      // The concrete state below is authoritative.
    }
  }
  if (String(ctx.state) !== 'running') {
    return {
      healthy: false,
      reason: 'not-running',
      state: String(ctx.state),
      clockAdvanceSeconds: null,
    };
  }
  return sampleRunningClock(ctx, isCurrent);
}

/**
 * Resume the shared context synchronously inside a trusted user gesture.
 * A running-but-frozen context is suspended before the dialog is shown, so
 * this function never spends the transient activation awaiting suspend().
 */
export function restartAudioContextFromGesture(context?: AudioContext): Promise<void> {
  const ctx = context ?? getAudioContext();
  try {
    return ctx.resume();
  } catch (error) {
    return Promise.reject(error);
  }
}
