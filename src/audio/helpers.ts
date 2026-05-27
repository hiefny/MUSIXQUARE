/**
 * MUSIXQUARE — Web Audio Helpers
 *
 * Utility functions replacing Tone.js abstractions:
 * - rampParam: replaces .rampTo()
 * - safeDisconnect: replaces .dispose()
 * - generateReverbIR: replaces Tone.Reverb.generate()
 * - createCrossFade: replaces Tone.CrossFade
 * - createStereoWidener: replaces Tone.StereoWidener
 * - createCascadedFilter: replaces Tone.Filter with rolloff > -12
 */

import { getAudioContext } from './context.ts';
import { FREQ_FULL_RANGE, FULL_RANGE_NYQUIST_RATIO } from './constants.ts';

/**
 * Return a "no audible low-pass" cutoff for the current output sample rate.
 *
 * The UI still presents 20 kHz as the top of the audible band, but the engine
 * should preserve ultrasonic source content when the browser/device runs above
 * 40 kHz. The 0.49 ratio sits just below Nyquist for stable BiquadFilterNode
 * behavior: 44.1 kHz -> 21.6 kHz, 48 kHz -> 23.5 kHz.
 */
export function getFullRangeFrequency(sampleRate?: number): number {
  if (!Number.isFinite(sampleRate) || !sampleRate || sampleRate <= 0) return FREQ_FULL_RANGE;
  return sampleRate * FULL_RANGE_NYQUIST_RATIO;
}

export function clampFilterFrequency(frequency: number, sampleRate?: number): number {
  const safeFrequency = Number.isFinite(frequency) ? Math.max(1, frequency) : FREQ_FULL_RANGE;
  return Math.min(safeFrequency, getFullRangeFrequency(sampleRate));
}

// ─── Parameter Ramping ──────────────────────────────────────────

/**
 * Smoothly ramp an AudioParam to a target value over time.
 * Replacement for Tone.js `.rampTo(value, time)`.
 */
export function rampParam(param: AudioParam, targetValue: number, rampTime: number): void {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  if (rampTime <= 0) {
    param.value = targetValue;
  } else {
    param.linearRampToValueAtTime(targetValue, now + rampTime);
  }
}

// ─── Node Cleanup ───────────────────────────────────────────────

/**
 * Safely disconnect an AudioNode (replacement for .dispose()).
 * Native nodes are garbage-collected after disconnect + deref.
 */
export function safeDisconnect(node: AudioNode | null): void {
  if (!node) return;
  try {
    node.disconnect();
  } catch {
    /* already disconnected */
  }
}

// ─── Reverb IR Generation ───────────────────────────────────────

/**
 * Generate a stereo impulse response buffer for ConvolverNode.
 * Replaces Tone.Reverb.generate() — this is SYNCHRONOUS (no async needed).
 *
 * @param decay - Reverb tail length in seconds (e.g. 5.0)
 * @param preDelay - Silence before reverb onset in seconds (e.g. 0.1)
 * @returns AudioBuffer with exponentially decaying noise
 */

/**
 * Build a tanh saturation curve for the harmonic exciter's
 * WaveShaperNode. tanh keeps the transition smooth (no hard clip
 * spikes), and the final normalization keeps the downstream mix gain
 * predictable.
 *
 * The default zero bias keeps the transfer curve symmetric, which keeps
 * the virtual treble return cleaner on noisy cymbal/hat material. A
 * non-zero bias is still supported for experiments with even harmonics.
 */
export function makeExciterCurve(
  drive: number,
  length = 4096,
  bias = 0.0,
): Float32Array<ArrayBuffer> {
  // Float32Array<ArrayBuffer> (not the wider <ArrayBufferLike> default) so the
  // result is assignable directly to WaveShaperNode.curve under strict TS lib types.
  const curve = new Float32Array(length);
  const safeDrive = Number.isFinite(drive) ? Math.max(0.1, Math.min(12, drive)) : 1;
  const safeBias = Number.isFinite(bias) ? Math.max(-0.95, Math.min(0.95, bias)) : 0;
  const zero = Math.tanh(safeDrive * safeBias);
  let maxAbs = 0;

  for (let i = 0; i < length; i++) {
    const x = (i / (length - 1)) * 2 - 1;
    const y = Math.tanh(safeDrive * (x + safeBias)) - zero;
    curve[i] = y;
    maxAbs = Math.max(maxAbs, Math.abs(y));
  }

  if (maxAbs > 0) {
    for (let i = 0; i < length; i++) curve[i] /= maxAbs;
  }

  return curve as Float32Array<ArrayBuffer>;
}

export function generateReverbIR(decay: number, preDelay: number): AudioBuffer {
  const ctx = getAudioContext();
  const sampleRate = ctx.sampleRate;

  // Clamp inputs to prevent excessive memory allocation
  // (30s decay @ 48kHz = ~2.88M samples × 2ch ≈ 23MB — cap at 30s)
  const clampedDecay = Math.max(0.01, Math.min(30, decay));
  const clampedPreDelay = Math.max(0, Math.min(2, preDelay));

  const preDelaySamples = Math.floor(clampedPreDelay * sampleRate);
  const decaySamples = Math.max(1, Math.floor(clampedDecay * sampleRate));
  const totalSamples = preDelaySamples + decaySamples;

  const buffer = ctx.createBuffer(2, totalSamples, sampleRate);

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = preDelaySamples; i < totalSamples; i++) {
      const t = (i - preDelaySamples) / decaySamples;
      // White noise × exponential decay (matches Tone.js algorithm)
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, clampedDecay / 2);
    }
  }
  return buffer;
}

// ─── CrossFade ──────────────────────────────────────────────────

/**
 * Equal-power crossfade between two signal paths.
 * Replaces Tone.CrossFade.
 *
 * fade=0 → fully A (dry), fade=1 → fully B (wet)
 */
export interface CrossFadeGraph {
  a: GainNode; // Dry input
  b: GainNode; // Wet input
  output: GainNode; // Mixed output
}

export function createCrossFade(initialFade = 0): CrossFadeGraph {
  const ctx = getAudioContext();
  const a = ctx.createGain();
  const b = ctx.createGain();
  const output = ctx.createGain();

  a.connect(output);
  b.connect(output);

  a.gain.value = Math.cos((initialFade * Math.PI) / 2);
  b.gain.value = Math.sin((initialFade * Math.PI) / 2);

  return { a, b, output };
}

export function setCrossFade(cf: CrossFadeGraph, fade: number, rampTime: number): void {
  rampParam(cf.a.gain, Math.cos((fade * Math.PI) / 2), rampTime);
  rampParam(cf.b.gain, Math.sin((fade * Math.PI) / 2), rampTime);
}

// ─── Stereo Widener ─────────────────────────────────────────────

/**
 * Mid/Side stereo widener.
 * Replaces Tone.StereoWidener.
 *
 * width=0 → mono, width=0.5 → normal stereo, width=1 → max width
 */
export interface StereoWidenerGraph {
  input: GainNode; // Connect source here
  output: ChannelMergerNode; // Connect from here
  setWidth(value: number, rampTime: number): void;
  dispose(): void; // Disconnect all internal nodes
}

export function createStereoWidener(initialWidth = 0.5): StereoWidenerGraph {
  const ctx = getAudioContext();

  // Input (stereo)
  const input = ctx.createGain();
  const splitter = ctx.createChannelSplitter(2);
  input.connect(splitter);

  // Mid = (L + R) / 2
  const lToMid = ctx.createGain();
  const rToMid = ctx.createGain();
  lToMid.gain.value = 0.5;
  rToMid.gain.value = 0.5;
  splitter.connect(lToMid, 0);
  splitter.connect(rToMid, 1);

  const midSum = ctx.createGain();
  lToMid.connect(midSum);
  rToMid.connect(midSum);

  // Side = (L - R) / 2
  const lToSide = ctx.createGain();
  const rToSide = ctx.createGain();
  lToSide.gain.value = 0.5;
  rToSide.gain.value = -0.5;
  splitter.connect(lToSide, 0);
  splitter.connect(rToSide, 1);

  const sideSum = ctx.createGain();
  lToSide.connect(sideSum);
  rToSide.connect(sideSum);

  // Width control: scale mid vs side
  const midGain = ctx.createGain();
  const sideGain = ctx.createGain();
  midSum.connect(midGain);
  sideSum.connect(sideGain);

  midGain.gain.value = 1 - initialWidth;
  sideGain.gain.value = initialWidth;

  // Reconstruct: L = Mid + Side, R = Mid - Side
  const outL = ctx.createGain();
  const outR = ctx.createGain();
  const sideToR = ctx.createGain();
  sideToR.gain.value = -1; // Invert side for R channel

  midGain.connect(outL);
  sideGain.connect(outL);
  midGain.connect(outR);
  sideGain.connect(sideToR);
  sideToR.connect(outR);

  // Merge to stereo output
  const output = ctx.createChannelMerger(2);
  outL.connect(output, 0, 0);
  outR.connect(output, 0, 1);

  const allNodes: AudioNode[] = [
    input,
    splitter,
    lToMid,
    rToMid,
    midSum,
    lToSide,
    rToSide,
    sideSum,
    midGain,
    sideGain,
    outL,
    outR,
    sideToR,
    output,
  ];

  return {
    input,
    output,
    setWidth(value: number, rt: number): void {
      rampParam(midGain.gain, 1 - value, rt);
      rampParam(sideGain.gain, value, rt);
    },
    dispose(): void {
      for (const n of allNodes) safeDisconnect(n);
    },
  };
}

// ─── Cascaded Filter ────────────────────────────────────────────

/**
 * Create cascaded BiquadFilterNodes for steeper rolloff.
 * Replaces Tone.Filter with rolloff > -12dB/oct.
 *
 * -12dB/oct = 1 stage (native default)
 * -24dB/oct = 2 stages cascaded
 */
export interface CascadedFilter {
  input: BiquadFilterNode; // Connect source here
  output: BiquadFilterNode; // Connect from here
  setFrequency(value: number, rampTime?: number): void;
  setQ(value: number): void;
  disconnect(): void;
}

export function createCascadedFilter(
  type: BiquadFilterType,
  frequency: number,
  stages: number,
  q?: number,
): CascadedFilter {
  const ctx = getAudioContext();
  const filters: BiquadFilterNode[] = [];

  for (let i = 0; i < stages; i++) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    if (q !== undefined) f.Q.value = q;
    filters.push(f);
    if (i > 0) filters[i - 1].connect(f);
  }

  return {
    input: filters[0],
    output: filters[filters.length - 1],
    setFrequency(value: number, rampTime?: number): void {
      for (const f of filters) {
        if (rampTime && rampTime > 0) {
          rampParam(f.frequency, value, rampTime);
        } else {
          f.frequency.value = value;
        }
      }
    },
    setQ(value: number): void {
      for (const f of filters) f.Q.value = value;
    },
    disconnect(): void {
      for (const f of filters) safeDisconnect(f);
    },
  };
}
