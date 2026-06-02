/**
 * MUSIXQUARE — Audio Constants
 *
 * Shared numeric constants for the audio graph, effects, and channel routing.
 * Centralised here to avoid magic numbers scattered across engine/effects/channel.
 */

export { REVERB_DEFAULT_DECAY, REVERB_DEFAULT_PREDELAY } from '../core/constants.ts';

// ─── Ramp Durations (seconds) ────────────────────────────────────
/** Standard parameter ramp — EQ, reverb mix, preamp, stereo, master volume. */
export const RAMP_TIME = 0.1;
/** Fast ramp for channel routing — shorter to prevent audible click on switch. */
export const RAMP_TIME_FAST = 0.02;

// ─── Frequency Limits ────────────────────────────────────────────
/** UI-facing/fallback full-range marker; runtime filters open up to safe Nyquist. */
export const FREQ_FULL_RANGE = 20000;
/** Keep "bypass" low-pass cutoffs just below Nyquist for browser filter stability. */
export const FULL_RANGE_NYQUIST_RATIO = 0.49;
/** Sub-frequency range */
export const SUB_FREQ_MIN = 20;
export const SUB_FREQ_MAX = 500;

// ─── Analyser ────────────────────────────────────────────────────
export const ANALYSER_FFT_SIZE = 4096;
export const ANALYSER_SMOOTHING = 0.3;

// ─── Reverb Defaults ─────────────────────────────────────────────
/** Reverb damping filter: lowcut freq = BASE * pow(FACTOR, knob/100) */
export const REVERB_LOWCUT_BASE = 20;
export const REVERB_LOWCUT_FACTOR = 50;
/** Reverb damping filter: highcut freq = BASE * pow(FACTOR, knob/100) */
export const REVERB_HIGHCUT_BASE = 20000;
export const REVERB_HIGHCUT_FACTOR = 0.05;

/** IR synthesis air damping: low-pass cutoff slides down over the tail. */
export const REVERB_IR_DAMPING_START_FREQ = 16000;
export const REVERB_IR_DAMPING_END_FREQ = 2600;
export const REVERB_IR_DAMPING_BLOCK_SIZE = 64;

// ─── Reverb Presets ──────────────────────────────────────────────
export const REVERB_PRESETS = {
  studio: { mix: 0.4, decay: 1.0, preDelay: 0.02, lowCut: 0, highCut: 0 },
  arena: { mix: 0.6, decay: 5.0, preDelay: 0.12, lowCut: 0, highCut: 0 },
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
export const VB_SUB_COMP = {
  threshold: -24,
  ratio: 4,
  attack: 0.01,
  release: 0.1,
  knee: 10,
} as const;
export const VB_SUB_TRIM_GAIN = 0.8;
export const VB_SUB_POST_HP_FREQ = 80;
export const VB_SUB_POST_LP_FREQ = 320;

// ─── Virtual Bass — Mid-bass Band (80–160 Hz) ───────────────────
export const VB_MID_LP_FREQ = 160;
export const VB_MID_HP_FREQ = 80;
export const VB_MID_COMP = {
  threshold: -20,
  ratio: 3,
  attack: 0.005,
  release: 0.08,
  knee: 8,
} as const;
export const VB_MID_TRIM_GAIN = 0.7;
export const VB_MID_POST_HP_FREQ = 150;
export const VB_MID_POST_LP_FREQ = 600;
export const VB_MID_MIX_GAIN = 0.8;

// ─── Virtual Bass — Output Limiter ───────────────────────────────
export const VB_LIMITER = {
  threshold: -3,
  ratio: 20,
  attack: 0.003,
  release: 0.01,
  knee: 0,
} as const;

// ─── Harmonic Exciter ────────────────────────────────────────────
// Two-HPF "harmonic isolation" topology, inspired by classic
// BBE/Aphex-style exciters:
//
//   in → HPF(4k) → tanh saturate → HPF(14k) → ×mix → out
//
// First HPF picks the material that has enough mid-high energy to
// generate useful harmonics (cymbals, snare top, breath, fricatives).
// A symmetric tanh shaper synthesizes focused odd harmonics. Listening
// tests favored zero bias because added even harmonics made noisy
// cymbal/hat material feel grainy instead of cleaner.
// The post-shaper HPF then removes most of the saturated fundamental
// and lower harmonics, leaving a subtle air-band layer under the dry
// path. This is enhancement, not source restoration.

/** Pre-shaper HPF cutoff. Sets the input window for harmonic
 *  generation. 4 kHz is wide enough to catch percussive content whose
 *  upper harmonics can land above 14 kHz. */
export const EXCITER_HPF_FREQ = 4000;
/** Q for the pre-shaper HPF — gentle slope so the transition isn't audible. */
export const EXCITER_HPF_Q = 0.707;
/** Post-shaper HPF cutoff. This is what makes the effect mostly "air only".
 *  16 kHz with a steep slope keeps most harshness-prone mid-high content
 *  out of the wet return while letting synthesized top-end through. */
export const EXCITER_HPF_POST_FREQ = 16000;
/** Cascaded stages on the post-HPF — 2 stages = −24 dB/oct, the
 *  industry standard for BBE / Aphex-style harmonic isolation.
 *  At 16 kHz cutoff: 14 kHz ≈ −10 dB, 12 kHz ≈ −16 dB, 10 kHz ≈ −24 dB,
 *  so the mid-high response stays flat where the ear is most sensitive
 *  to roughness while still passing real synthesized air above ~14 kHz.
 *  4 stages (−48 dB/oct) is technically possible but the phase shift
 *  around cutoff starts reading as an unnatural "edge". */
export const EXCITER_HPF_POST_STAGES = 2;
/** Q for each cascade stage. 0.707 keeps the joint response Butterworth
 *  (maximally flat passband, no resonance bump). */
export const EXCITER_HPF_POST_Q = 0.707;
/** Drive into the tanh curve. With the post-HPF removing the bulk of
 *  the fundamental, we can push drive higher (4.5) for richer upper
 *  harmonic content without smudging the mid-high. Above ~6 the
 *  curve hard-clips and the harmonics turn into buzzy distortion. */
export const EXCITER_DRIVE = 4.5;
/** Transfer-curve bias. 0 keeps the shaper symmetric and avoids the
 *  sand-like even-harmonic grit that showed up with noisy high-frequency
 *  source material. */
export const EXCITER_BIAS = 0.0;
/** Mix amount when the toggle is ON. Effects.ts ramps the gain node
 *  between 0 and this value when the user flips the switch. The post-HPF
 *  keeps the return air-band focused, so 0.5 is audible without turning
 *  the effect into a broad treble boost. */
export const EXCITER_MIX_GAIN = 0.5;
/** Curve resolution — 4096 samples is enough for an audibly smooth
 *  tanh without bloating the WaveShaperNode. */
export const EXCITER_CURVE_LENGTH = 4096;
