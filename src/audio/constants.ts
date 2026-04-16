/**
 * MUSIXQUARE — Audio Constants
 *
 * Shared numeric constants for the audio graph, effects, and channel routing.
 * Centralised here to avoid magic numbers scattered across engine/effects/channel.
 */

// ─── Ramp Durations (seconds) ────────────────────────────────────
/** Standard parameter ramp — EQ, reverb mix, preamp, stereo, master volume. */
export const RAMP_TIME = 0.1;
/** Fast ramp for channel routing — shorter to prevent audible click on switch. */
export const RAMP_TIME_FAST = 0.02;

// ─── Frequency Limits ────────────────────────────────────────────
/** Full-range lowpass — effectively bypassed. Used as "no filter" sentinel. */
export const FREQ_FULL_RANGE = 20000;
/** Sub-frequency range */
export const SUB_FREQ_MIN = 20;
export const SUB_FREQ_MAX = 500;

// ─── Analyser ────────────────────────────────────────────────────
export const ANALYSER_FFT_SIZE = 2048;
export const ANALYSER_SMOOTHING = 0.3;

// ─── Reverb Defaults ─────────────────────────────────────────────
export const REVERB_DEFAULT_DECAY = 5.0;
export const REVERB_DEFAULT_PREDELAY = 0.1;

/** Reverb damping filter: lowcut freq = BASE * pow(FACTOR, knob/100) */
export const REVERB_LOWCUT_BASE = 20;
export const REVERB_LOWCUT_FACTOR = 50;
/** Reverb damping filter: highcut freq = BASE * pow(FACTOR, knob/100) */
export const REVERB_HIGHCUT_BASE = 20000;
export const REVERB_HIGHCUT_FACTOR = 0.05;

// ─── Reverb Presets ──────────────────────────────────────────────
export const REVERB_PRESETS = {
  studio: { mix: 0.3, decay: 1.0, preDelay: 0.02, lowCut: 0, highCut: 0 },
  arena:  { mix: 0.4, decay: 5.0, preDelay: 0.12, lowCut: 0, highCut: 0 },
} as const;

// ─── Stereo Width Compensation ───────────────────────────────────
/** Below unity: compensation = NARROW_BASE + NARROW_SCALE * width */
export const STEREO_NARROW_BASE = 0.6;
export const STEREO_NARROW_SCALE = 0.4;
/** Above unity: compensation = max(WIDE_FLOOR, 1 / (NARROW_BASE + NARROW_SCALE * width)) */
export const STEREO_WIDE_FLOOR = 0.5;

// ─── Virtual Bass — Waveshaper ───────────────────────────────────
export const VB_CURVE_LENGTH = 8192;

// ─── Virtual Bass — Sub-bass Band (40–80 Hz) ────────────────────
export const VB_SUB_LP_FREQ = 80;
export const VB_SUB_HP_FREQ = 40;
export const VB_SUB_COMP = { threshold: -24, ratio: 4, attack: 0.01, release: 0.1, knee: 10 } as const;
export const VB_SUB_TRIM_GAIN = 0.8;
export const VB_SUB_POST_HP_FREQ = 80;
export const VB_SUB_POST_LP_FREQ = 320;

// ─── Virtual Bass — Mid-bass Band (80–160 Hz) ───────────────────
export const VB_MID_LP_FREQ = 160;
export const VB_MID_HP_FREQ = 80;
export const VB_MID_COMP = { threshold: -20, ratio: 3, attack: 0.005, release: 0.08, knee: 8 } as const;
export const VB_MID_TRIM_GAIN = 0.7;
export const VB_MID_POST_HP_FREQ = 150;
export const VB_MID_POST_LP_FREQ = 600;
export const VB_MID_MIX_GAIN = 0.8;

// ─── Virtual Bass — Output Limiter ───────────────────────────────
export const VB_LIMITER = { threshold: -3, ratio: 20, attack: 0.003, release: 0.01, knee: 0 } as const;
