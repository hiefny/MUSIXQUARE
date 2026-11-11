/**
 * MUSIXQUARE — AudioContext Recovery Timing (RO-01)
 *
 * The timing home of the shared AudioContext's output recovery: both owners,
 * the play-request restart (in context.ts until Phase 7 7C-4) and the
 * playback scope in context-recovery.ts (since 7C-2 also the recovery
 * dialog's waits after its tap, which app.ts imported before), import their
 * waits from here, with the prepared-state predicate the two owners share.
 * Equal values with different jobs keep separate names.
 *
 * A leaf on purpose. Tests replace context.ts with factories that lack these
 * names, so they cannot live there; and audio/constants.ts sits in another
 * eager chunk than context.ts, so importing it there would move every audio
 * constant across the chunks.
 */

/** ensureRunning() and a probe that may resume: how long a native resume() is awaited. */
export const AUDIO_RESUME_DEADLINE_MS = 500;
/** One clock sample of the health probe (it takes two at most). */
export const AUDIO_CLOCK_SAMPLE_MS = 180;
/** Seconds the native clock must advance within one sample to count as running. */
export const AUDIO_CLOCK_MIN_ADVANCE_SECONDS = 0.01;
/** Both owners: how long a caller waits for a native suspend to park the context. */
export const AUDIO_SUSPEND_PREPARE_DEADLINE_MS = 500;
/** How long after that wait a late suspend's statechange still counts. */
export const AUDIO_LATE_SUSPEND_FENCE_MS = 250;
/** Both owners' suspend lease watchdog: the preparation wait plus the late fence. */
export const AUDIO_SUSPEND_WATCHDOG_MS =
  AUDIO_SUSPEND_PREPARE_DEADLINE_MS + AUDIO_LATE_SUSPEND_FENCE_MS;
/** Native suspends one recovery attempt may start before it gives up. */
export const AUDIO_SUSPEND_MAX_ATTEMPTS = 2;
/**
 * Both owners: how long a recovery resume (the gesture's, and the playback
 * scope's automatic one) is awaited before its caller reads not running.
 */
export const AUDIO_RECOVERY_RESUME_DEADLINE_MS = 750;
/** How long undoing a retired suspend is awaited before the binding adopts the parked context. */
export const AUDIO_RETIRED_SUSPEND_CLEANUP_DEADLINE_MS = 500;
/** The recovery dialog after its tap: the wait for the gesture resume before it reads the state. */
export const AUDIO_RECOVERY_GESTURE_WAIT_MS = 1_000;
/**
 * The recovery dialog after its tap: the limit of its wait for the restart's
 * clock requirement, which the owner's promise ends sooner (Phase 7 7B-5),
 * and since App 9.0.42 of its ordinary branch's wait for its own resume
 * still in flight after the 1 s wait, which that resume ends sooner.
 */
export const AUDIO_RECOVERY_CLOCK_REQUIREMENT_WAIT_MS = 5_000;

/**
 * Both owners' prepared state: the context is parked (suspended, or WebKit's
 * interrupted), so a trusted gesture may resume it.
 */
export function isAudioContextPrepared(context: AudioContext): boolean {
  const state = String(context.state);
  return state === 'suspended' || state === 'interrupted';
}
