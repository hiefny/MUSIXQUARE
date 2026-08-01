/**
 * MUSIXQUARE — Audio Engine (Native Web Audio API)
 *
 * Manages the entire audio graph:
 *   Player → Widener → Preamp → Split → Channel Routing → Merge
 *     → GlobalLowPass → EQ(5-band) → Reverb(wet/dry) → MasterGain → Analyser → Destination
 *     + Virtual Bass parallel chain
 * The graph uses native Web Audio nodes and the shared context from context.ts.
 */

import { log } from '../core/log.ts';
import { EQ_FREQUENCIES } from '../core/constants.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';

import { getAudioContext, ensureRunning } from './context.ts';
import { bindAudioContextInterruptionRecovery } from './context-recovery.ts';
import {
  rampParam,
  safeDisconnect,
  generateReverbIR,
  makeExciterCurve,
  getFullRangeFrequency,
  createCrossFade,
  createStereoWidener,
  createCascadedFilter,
  type CrossFadeGraph,
  type StereoWidenerGraph,
  type CascadedFilter,
} from './helpers.ts';
import {
  ANALYSER_FFT_SIZE,
  ANALYSER_SMOOTHING,
  REVERB_DEFAULT_DECAY,
  REVERB_DEFAULT_PREDELAY,
  REVERB_LOWCUT_BASE,
  EXCITER_HPF_FREQ,
  EXCITER_HPF_Q,
  EXCITER_HPF_POST_FREQ,
  EXCITER_HPF_POST_Q,
  EXCITER_HPF_POST_STAGES,
  EXCITER_DRIVE,
  EXCITER_BIAS,
  EXCITER_CURVE_LENGTH,
  VB_CURVE_LENGTH,
  VB_SUB_LP_FREQ,
  VB_SUB_HP_FREQ,
  VB_SUB_COMP,
  VB_SUB_TRIM_GAIN,
  VB_SUB_POST_HP_FREQ,
  VB_SUB_POST_LP_FREQ,
  VB_MID_LP_FREQ,
  VB_MID_HP_FREQ,
  VB_MID_COMP,
  VB_MID_TRIM_GAIN,
  VB_MID_POST_HP_FREQ,
  VB_MID_POST_LP_FREQ,
  VB_MID_MIX_GAIN,
  VB_LIMITER,
} from './constants.ts';
import { FilePlaybackRoute } from './file-playback-route.ts';

// ─── AudioGraph Struct ────────────────────────────────────────────
interface AudioGraph {
  // Stable input for AudioBuffer file playback.
  filePlaybackRoute: FilePlaybackRoute | null;

  // Channel & stereo processing
  toneSplit: ChannelSplitterNode | null;
  toneMerge: ChannelMergerNode | null;
  gainL: GainNode | null;
  gainR: GainNode | null;

  // Effects chain
  masterGain: GainNode | null;
  reverb: ConvolverNode | null;
  rvbLowCut: BiquadFilterNode | null;
  rvbHighCut: BiquadFilterNode | null;
  rvbCrossFade: CrossFadeGraph | null;
  eqNodes: BiquadFilterNode[];
  preamp: GainNode | null;
  widener: StereoWidenerGraph | null;
  globalLowPass: BiquadFilterNode | null;
  analyser: AnalyserNode | null;

  // Virtual Bass — Dual-Band
  vbSubLP: CascadedFilter | null; // -24dB rolloff
  vbSubHP: BiquadFilterNode | null; // -12dB rolloff
  vbSubComp: DynamicsCompressorNode | null;
  vbSubTrim: GainNode | null;
  vbSubShaper: WaveShaperNode | null;
  vbSubPostHP: BiquadFilterNode | null;
  vbSubPostLP: CascadedFilter | null; // -24dB rolloff
  vbSubMix: GainNode | null;
  vbMidLP: CascadedFilter | null; // -24dB rolloff
  vbMidHP: BiquadFilterNode | null; // -12dB rolloff
  vbMidComp: DynamicsCompressorNode | null;
  vbMidTrim: GainNode | null;
  vbMidShaper: WaveShaperNode | null;
  vbMidPostHP: BiquadFilterNode | null;
  vbMidPostLP: CascadedFilter | null; // -24dB rolloff
  vbMidMix: GainNode | null;
  vbSum: GainNode | null;
  vbLimiter: DynamicsCompressorNode | null;
  vbGain: GainNode | null;

  // Harmonic Exciter (parallel HPF → saturate → cascaded post-HPF → mix)
  exHpf: BiquadFilterNode | null;
  exShaper: WaveShaperNode | null;
  exHpfPost: CascadedFilter | null; // −24 dB/oct (2 biquads) for clean air-band isolation
  exGain: GainNode | null;

  // Surround
  surroundSplitter: ChannelSplitterNode | null;
  surroundGain: GainNode | null;
}

function createEmptyGraph(): AudioGraph {
  return {
    filePlaybackRoute: null,
    toneSplit: null,
    toneMerge: null,
    gainL: null,
    gainR: null,
    masterGain: null,
    reverb: null,
    rvbLowCut: null,
    rvbHighCut: null,
    rvbCrossFade: null,
    eqNodes: [],
    preamp: null,
    widener: null,
    globalLowPass: null,
    analyser: null,
    vbSubLP: null,
    vbSubHP: null,
    vbSubComp: null,
    vbSubTrim: null,
    vbSubShaper: null,
    vbSubPostHP: null,
    vbSubPostLP: null,
    vbSubMix: null,
    vbMidLP: null,
    vbMidHP: null,
    vbMidComp: null,
    vbMidTrim: null,
    vbMidShaper: null,
    vbMidPostHP: null,
    vbMidPostLP: null,
    vbMidMix: null,
    vbSum: null,
    vbLimiter: null,
    vbGain: null,
    exHpf: null,
    exShaper: null,
    exHpfPost: null,
    exGain: null,
    surroundSplitter: null,
    surroundGain: null,
  };
}

let _graph: AudioGraph = createEmptyGraph();
let _proPlaybackPauseGateToken: number | null = null;

let _initAudioPromise: Promise<void> | null = null;
let _disposeContextRecovery: (() => void) | null = null;

// ─── Public Getters ────────────────────────────────────────────────

export function getMasterGain(): GainNode | null {
  return _graph.masterGain;
}
export function getAnalyser(): AnalyserNode | null {
  return _graph.analyser;
}
export function getToneMerge(): ChannelMergerNode | null {
  return _graph.toneMerge;
}
export function getGainL(): GainNode | null {
  return _graph.gainL;
}
export function getGainR(): GainNode | null {
  return _graph.gainR;
}
export function getPreamp(): GainNode | null {
  return _graph.preamp;
}
export function getWidener(): StereoWidenerGraph | null {
  return _graph.widener;
}
export function getFilePlaybackDestination(): GainNode | null {
  return _graph.filePlaybackRoute?.input ?? null;
}
export function getReverb(): ConvolverNode | null {
  return _graph.reverb;
}
export function getRvbLowCut(): BiquadFilterNode | null {
  return _graph.rvbLowCut;
}
export function getRvbHighCut(): BiquadFilterNode | null {
  return _graph.rvbHighCut;
}
export function getRvbCrossFade(): CrossFadeGraph | null {
  return _graph.rvbCrossFade;
}
export function getEqNodes(): BiquadFilterNode[] {
  return _graph.eqNodes;
}
export function getGlobalLowPass(): BiquadFilterNode | null {
  return _graph.globalLowPass;
}
export function getVbGain(): GainNode | null {
  return _graph.vbGain;
}
export function getExciterGain(): GainNode | null {
  return _graph.exGain;
}
export function getSurroundSplitter(): ChannelSplitterNode | null {
  return _graph.surroundSplitter;
}
export function getSurroundGain(): GainNode | null {
  return _graph.surroundGain;
}
export function isAudioReady(): boolean {
  return _graph.masterGain !== null;
}

// Public audio-domain facade for the shared context helpers.
export { getAudioContext } from './context.ts';

// FilePlaybackRoute is the sole owner of connections between these shared
// surround nodes; channel.ts only publishes selection and output-role policy.
export function ensureSurroundNodes(): { splitter: ChannelSplitterNode; gain: GainNode } {
  if (!_graph.surroundSplitter || !_graph.surroundGain) {
    const ctx = getAudioContext();
    _graph.surroundSplitter = ctx.createChannelSplitter(8);
    _graph.surroundGain = ctx.createGain();
    _graph.surroundGain.gain.value = 1;
  }
  return { splitter: _graph.surroundSplitter!, gain: _graph.surroundGain! };
}

/**
 * Safely disconnect an AudioNode (no-op if already disconnected).
 */
export { safeDisconnect } from './helpers.ts';

// ─── Initialization ────────────────────────────────────────────────

/**
 * Initialize the full audio graph.
 * Safe to call multiple times (idempotent).
 */
export async function initAudio(): Promise<void> {
  if (_initAudioPromise) return _initAudioPromise;

  if (_graph.masterGain) {
    const ctx = getAudioContext();
    if (ctx.state !== 'running') {
      try {
        await ensureRunning();
      } catch (e) {
        log.debug('[Engine] ensureRunning:', e);
      }
    }
    return;
  }

  _initAudioPromise = _doInitAudio();

  try {
    await _initAudioPromise;
  } catch (e) {
    _graph.masterGain = null;
    throw e;
  } finally {
    _initAudioPromise = null;
  }
}

async function _doInitAudio(): Promise<void> {
  const ctx = getAudioContext();
  if (ctx.state !== 'running') {
    await ensureRunning();
  }
  if (_graph.masterGain) return;

  // Clean up a partially initialized graph before retrying.
  if (_graph.toneSplit || _graph.preamp || _graph.reverb || _graph.widener) {
    _cleanupAllNodes();
    log.warn('[Audio] Cleaned up leftover nodes from previous failed init');
  }

  // ── Channel & Stereo Processing ──
  _graph.toneSplit = ctx.createChannelSplitter(2);
  _graph.toneMerge = ctx.createChannelMerger(2);
  _graph.gainL = ctx.createGain();
  _graph.gainR = ctx.createGain();

  _graph.toneSplit.connect(_graph.gainL, 0, 0); // L -> gainL
  _graph.toneSplit.connect(_graph.gainR, 1, 0); // R -> gainR

  // Default Routing: Stereo (L→0, R→1 of merge)
  _graph.gainL.connect(_graph.toneMerge, 0, 0);
  _graph.gainR.connect(_graph.toneMerge, 0, 1);

  // ── Effects Chain ──
  _graph.masterGain = ctx.createGain();

  // EQ (5-Band Peaking Filters)
  _graph.eqNodes = EQ_FREQUENCIES.map((f) => {
    const filter = ctx.createBiquadFilter();
    filter.type = 'peaking';
    filter.frequency.value = f;
    filter.Q.value = 1.0;
    filter.gain.value = 0;
    return filter;
  });

  // Preamplifier + Stereo Widener
  _graph.preamp = ctx.createGain();
  _graph.widener = createStereoWidener(0.5); // applySettings() overwrites with state default
  _graph.filePlaybackRoute = new FilePlaybackRoute(ctx);
  _graph.filePlaybackRoute.input.gain.value = 1;
  const initialSurroundChannel = getState('audio.surroundChannelIndex');
  if (
    getState('audio.isSurroundMode') &&
    Number.isInteger(initialSurroundChannel) &&
    initialSurroundChannel >= 0 &&
    initialSurroundChannel <= 7
  ) {
    const { splitter, gain } = ensureSurroundNodes();
    _graph.filePlaybackRoute.connectSurround(splitter, gain, _graph.preamp, initialSurroundChannel);
  } else {
    _graph.filePlaybackRoute.connectStereo(_graph.widener.input);
  }

  // Reverb uses a synchronously generated impulse response.
  _graph.reverb = ctx.createConvolver();
  _graph.reverb.buffer = generateReverbIR(REVERB_DEFAULT_DECAY, REVERB_DEFAULT_PREDELAY);

  // Damping filters
  _graph.rvbLowCut = ctx.createBiquadFilter();
  _graph.rvbLowCut.type = 'highpass';
  _graph.rvbLowCut.frequency.value = REVERB_LOWCUT_BASE;

  _graph.rvbHighCut = ctx.createBiquadFilter();
  _graph.rvbHighCut.type = 'lowpass';
  _graph.rvbHighCut.frequency.value = getFullRangeFrequency(ctx.sampleRate);

  _graph.rvbCrossFade = createCrossFade(0); // Initially Dry

  // ── Virtual Bass — Dual-Band Psychoacoustic Enhancement ──

  // Sub-bass: soft cubic saturation  f(x) = x - x³/3
  const subCurve = new Float32Array(VB_CURVE_LENGTH);
  for (let i = 0; i < VB_CURVE_LENGTH; i++) {
    const x = (i / (VB_CURVE_LENGTH - 1)) * 2 - 1;
    subCurve[i] = x - (x * x * x) / 3;
  }

  // Mid-bass: soft quadratic saturation  f(x) = sign(x)·(2|x| - x²)
  const midCurve = new Float32Array(VB_CURVE_LENGTH);
  for (let i = 0; i < VB_CURVE_LENGTH; i++) {
    const x = (i / (VB_CURVE_LENGTH - 1)) * 2 - 1;
    const ax = Math.abs(x);
    const shaped = ax <= 1.0 ? 2 * ax - ax * ax : 1.0;
    midCurve[i] = x >= 0 ? shaped : -shaped;
  }

  // Sub-bass path (40-80 Hz)
  _graph.vbSubLP = createCascadedFilter('lowpass', VB_SUB_LP_FREQ, 2); // -24dB
  _graph.vbSubHP = ctx.createBiquadFilter();
  _graph.vbSubHP.type = 'highpass';
  _graph.vbSubHP.frequency.value = VB_SUB_HP_FREQ;
  _graph.vbSubComp = ctx.createDynamicsCompressor();
  _graph.vbSubComp.threshold.value = VB_SUB_COMP.threshold;
  _graph.vbSubComp.ratio.value = VB_SUB_COMP.ratio;
  _graph.vbSubComp.attack.value = VB_SUB_COMP.attack;
  _graph.vbSubComp.release.value = VB_SUB_COMP.release;
  _graph.vbSubComp.knee.value = VB_SUB_COMP.knee;
  _graph.vbSubTrim = ctx.createGain();
  _graph.vbSubTrim.gain.value = VB_SUB_TRIM_GAIN;
  _graph.vbSubShaper = ctx.createWaveShaper();
  _graph.vbSubShaper.curve = subCurve;
  _graph.vbSubPostHP = ctx.createBiquadFilter();
  _graph.vbSubPostHP.type = 'highpass';
  _graph.vbSubPostHP.frequency.value = VB_SUB_POST_HP_FREQ;
  _graph.vbSubPostLP = createCascadedFilter('lowpass', VB_SUB_POST_LP_FREQ, 2); // -24dB
  _graph.vbSubMix = ctx.createGain();

  // Mid-bass path (80-160 Hz)
  _graph.vbMidLP = createCascadedFilter('lowpass', VB_MID_LP_FREQ, 2); // -24dB
  _graph.vbMidHP = ctx.createBiquadFilter();
  _graph.vbMidHP.type = 'highpass';
  _graph.vbMidHP.frequency.value = VB_MID_HP_FREQ;
  _graph.vbMidComp = ctx.createDynamicsCompressor();
  _graph.vbMidComp.threshold.value = VB_MID_COMP.threshold;
  _graph.vbMidComp.ratio.value = VB_MID_COMP.ratio;
  _graph.vbMidComp.attack.value = VB_MID_COMP.attack;
  _graph.vbMidComp.release.value = VB_MID_COMP.release;
  _graph.vbMidComp.knee.value = VB_MID_COMP.knee;
  _graph.vbMidTrim = ctx.createGain();
  _graph.vbMidTrim.gain.value = VB_MID_TRIM_GAIN;
  _graph.vbMidShaper = ctx.createWaveShaper();
  _graph.vbMidShaper.curve = midCurve;
  _graph.vbMidPostHP = ctx.createBiquadFilter();
  _graph.vbMidPostHP.type = 'highpass';
  _graph.vbMidPostHP.frequency.value = VB_MID_POST_HP_FREQ;
  _graph.vbMidPostLP = createCascadedFilter('lowpass', VB_MID_POST_LP_FREQ, 2); // -24dB
  _graph.vbMidMix = ctx.createGain();
  _graph.vbMidMix.gain.value = VB_MID_MIX_GAIN;

  // Output stage
  _graph.vbSum = ctx.createGain();
  _graph.vbLimiter = ctx.createDynamicsCompressor();
  _graph.vbLimiter.threshold.value = VB_LIMITER.threshold;
  _graph.vbLimiter.ratio.value = VB_LIMITER.ratio;
  _graph.vbLimiter.attack.value = VB_LIMITER.attack;
  _graph.vbLimiter.release.value = VB_LIMITER.release;
  _graph.vbLimiter.knee.value = VB_LIMITER.knee;
  _graph.vbGain = ctx.createGain();
  _graph.vbGain.gain.value = 0;

  // ── Connections ──
  // Player → Widener → Preamp → Split → (Channel Logic) → Merge → EQ → Reverb → Master

  // 1. Pre-Processing
  _graph.widener.output.connect(_graph.preamp);

  // 2. Channel Splitting
  _graph.preamp.connect(_graph.toneSplit);

  // 3. Post-Processing: Merge → GlobalLowPass → EQ → Reverb → Master
  _graph.globalLowPass = ctx.createBiquadFilter();
  _graph.globalLowPass.type = 'lowpass';
  _graph.globalLowPass.frequency.value = getFullRangeFrequency(ctx.sampleRate);
  _graph.toneMerge.connect(_graph.globalLowPass);

  let eqIn: AudioNode = _graph.globalLowPass;
  for (const fx of _graph.eqNodes) {
    eqIn.connect(fx);
    eqIn = fx;
  }

  // Wet/Dry Routing with Damping
  eqIn.connect(_graph.rvbCrossFade.a); // Dry path
  eqIn.connect(_graph.reverb); // Wet path
  _graph.reverb.connect(_graph.rvbLowCut);
  _graph.rvbLowCut.connect(_graph.rvbHighCut);
  _graph.rvbHighCut.connect(_graph.rvbCrossFade.b);
  _graph.rvbCrossFade.output.connect(_graph.masterGain); // Output

  // Virtual Bass — dual-band parallel tap after EQ
  // Sub-bass path
  eqIn.connect(_graph.vbSubLP.input);
  _graph.vbSubLP.output.connect(_graph.vbSubHP);
  _graph.vbSubHP.connect(_graph.vbSubComp);
  _graph.vbSubComp.connect(_graph.vbSubTrim);
  _graph.vbSubTrim.connect(_graph.vbSubShaper);
  _graph.vbSubShaper.connect(_graph.vbSubPostHP);
  _graph.vbSubPostHP.connect(_graph.vbSubPostLP.input);
  _graph.vbSubPostLP.output.connect(_graph.vbSubMix);
  _graph.vbSubMix.connect(_graph.vbSum);
  // Mid-bass path
  eqIn.connect(_graph.vbMidLP.input);
  _graph.vbMidLP.output.connect(_graph.vbMidHP);
  _graph.vbMidHP.connect(_graph.vbMidComp);
  _graph.vbMidComp.connect(_graph.vbMidTrim);
  _graph.vbMidTrim.connect(_graph.vbMidShaper);
  _graph.vbMidShaper.connect(_graph.vbMidPostHP);
  _graph.vbMidPostHP.connect(_graph.vbMidPostLP.input);
  _graph.vbMidPostLP.output.connect(_graph.vbMidMix);
  _graph.vbMidMix.connect(_graph.vbSum);
  // Output stage
  _graph.vbSum.connect(_graph.vbLimiter);
  _graph.vbLimiter.connect(_graph.vbGain);
  _graph.vbGain.connect(_graph.masterGain);

  // Harmonic Exciter — parallel tap on the post-EQ bus.
  // Pre-HPF picks the mid-high content that will generate useful harmonics
  // (cymbals, snare top, breath, fricatives). A symmetric tanh WaveShaper
  // creates focused upper harmonics, then the post-HPF keeps the wet
  // return on the air band. 4x oversampling reduces aliasing in
  // the shaper. Gain rides 0 ↔ EXCITER_MIX_GAIN to toggle the effect
  // without re-wiring the graph.
  _graph.exHpf = ctx.createBiquadFilter();
  _graph.exHpf.type = 'highpass';
  _graph.exHpf.frequency.value = EXCITER_HPF_FREQ;
  _graph.exHpf.Q.value = EXCITER_HPF_Q;
  _graph.exShaper = ctx.createWaveShaper();
  _graph.exShaper.curve = makeExciterCurve(EXCITER_DRIVE, EXCITER_CURVE_LENGTH, EXCITER_BIAS);
  _graph.exShaper.oversample = '4x';
  _graph.exHpfPost = createCascadedFilter(
    'highpass',
    EXCITER_HPF_POST_FREQ,
    EXCITER_HPF_POST_STAGES,
    EXCITER_HPF_POST_Q,
  );
  _graph.exGain = ctx.createGain();
  _graph.exGain.gain.value = 0;
  eqIn.connect(_graph.exHpf);
  _graph.exHpf.connect(_graph.exShaper);
  _graph.exShaper.connect(_graph.exHpfPost.input);
  _graph.exHpfPost.output.connect(_graph.exGain);
  _graph.exGain.connect(_graph.masterGain);

  // Visualizer analyser for accurate frequency mapping
  _graph.analyser = ctx.createAnalyser();
  _graph.analyser.fftSize = ANALYSER_FFT_SIZE;
  _graph.analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
  _graph.masterGain.connect(_graph.analyser);
  _graph.masterGain.connect(ctx.destination);

  // iOS Silent Mode Bypass — kicks a muted <audio> element so the page's
  // audio output isn't routed to the silent channel on iOS.
  try {
    const silentAudio = document.getElementById('silent-trigger') as HTMLAudioElement | null;
    if (silentAudio) {
      silentAudio.play().catch((e) => log.debug('[Audio] Silent Audio play failed', e));
    }
  } catch (e) {
    log.debug('[Audio] iOS unlock attempt failed:', e);
  }

  // Auto-resume AudioContext on interruption and locally rejoin the room
  // timeline after an active-playback route change (for example AirPods).
  // Always remove the old observer first to prevent duplicates on re-init.
  try {
    _disposeContextRecovery?.();
    _disposeContextRecovery = bindAudioContextInterruptionRecovery(ctx);
  } catch (e) {
    log.debug('[Audio] statechange listener setup failed', e);
  }

  log.info('[Audio] Native Web Audio graph initialized');
  bus.emit('audio:ready');
}

// ─── Cleanup ────────────────────────────────────────────────────

function _cleanupAllNodes(): void {
  _graph.filePlaybackRoute?.destroy();

  const simpleNodes: (AudioNode | null)[] = [
    _graph.toneSplit,
    _graph.toneMerge,
    _graph.gainL,
    _graph.gainR,
    _graph.masterGain,
    _graph.reverb,
    _graph.preamp,
    _graph.rvbLowCut,
    _graph.rvbHighCut,
    _graph.globalLowPass,
    _graph.analyser,
    _graph.vbSubHP,
    _graph.vbSubComp,
    _graph.vbSubTrim,
    _graph.vbSubShaper,
    _graph.vbSubPostHP,
    _graph.vbSubMix,
    _graph.vbMidHP,
    _graph.vbMidComp,
    _graph.vbMidTrim,
    _graph.vbMidShaper,
    _graph.vbMidPostHP,
    _graph.vbMidMix,
    _graph.vbSum,
    _graph.vbLimiter,
    _graph.vbGain,
    _graph.exHpf,
    _graph.exShaper,
    _graph.exGain,
    _graph.surroundSplitter,
    _graph.surroundGain,
  ];
  for (const n of simpleNodes) safeDisconnect(n);
  for (const n of _graph.eqNodes) safeDisconnect(n);

  // Cascaded filters
  _graph.vbSubLP?.disconnect();
  _graph.vbSubPostLP?.disconnect();
  _graph.vbMidLP?.disconnect();
  _graph.vbMidPostLP?.disconnect();
  _graph.exHpfPost?.disconnect();

  // CrossFade
  if (_graph.rvbCrossFade) {
    safeDisconnect(_graph.rvbCrossFade.a);
    safeDisconnect(_graph.rvbCrossFade.b);
    safeDisconnect(_graph.rvbCrossFade.output);
  }

  // Widener
  if (_graph.widener) {
    _graph.widener.dispose();
  }

  _graph = createEmptyGraph();
}

// ─── Bus Event Handlers ─────────────────────────────────────────

/** Set master volume (0-1) */
bus.on('audio:set-volume', (volume) => {
  if (!Number.isFinite(volume)) return;
  const clamped = Math.max(0, Math.min(1, volume));
  setState('audio.masterVolume', clamped);
  if (_graph.masterGain) {
    rampParam(_graph.masterGain.gain, _proPlaybackPauseGateToken === null ? clamped : 0, 0.1);
  }
  bus.emit('audio:volume-changed', clamped);
  bus.emit('youtube:set-volume', Math.round(clamped * 100));
});

// A PRO pause remains server-authoritative, but the initiating device should
// become silent at click time. Gate only the physical output; the AudioBuffer
// timeline keeps running until the canonical pause arrives, so failure recovery
// is a simple un-gate instead of a drift-prone stop/seek/restart rollback.
bus.on('pro-playback:ui-control-pending', (event) => {
  if (event.kind !== 'pause') return;
  _proPlaybackPauseGateToken = event.token;
  if (_graph.masterGain) rampParam(_graph.masterGain.gain, 0, 0.015);
});

bus.on('pro-playback:ui-control-settled', (event) => {
  if (event.kind !== 'pause' || _proPlaybackPauseGateToken !== event.token) return;
  _proPlaybackPauseGateToken = null;
  const volume = Math.max(0, Math.min(1, getState('audio.masterVolume') ?? 1));
  if (_graph.masterGain) rampParam(_graph.masterGain.gain, volume, 0.03);
});

/** Apply volume to YouTube player */
bus.on('audio:apply-youtube-volume', () => {
  const vol = getState('audio.masterVolume') ?? 1;
  bus.emit('youtube:set-volume', Math.round(vol * 100));
});

function connectFilePlaybackStereoRoute(): void {
  const route = _graph.filePlaybackRoute;
  const widener = _graph.widener;
  if (!route || !widener) return;

  try {
    route.connectStereo(widener.input);
  } catch (error) {
    log.warn('[Audio] Failed to restore the stereo file-playback route:', error);
  }
}

function connectFilePlaybackSurroundRoute(channelIdx: unknown): void {
  if (!Number.isInteger(channelIdx) || (channelIdx as number) < 0 || (channelIdx as number) > 7) {
    log.warn(`[Audio] Invalid surround channelIdx: ${channelIdx}`);
    return;
  }

  const route = _graph.filePlaybackRoute;
  const preamp = _graph.preamp;
  if (!route || !preamp) return;
  const { splitter, gain } = ensureSurroundNodes();

  try {
    route.connectSurround(splitter, gain, preamp, channelIdx as number);
    log.debug(`[Audio] File playback routed to surround channel ${channelIdx}`);
  } catch (error) {
    log.warn('[Audio] Failed to switch the file-playback surround route:', error);
  }
}

/** Switch the stable file-playback route; no source node identity is accepted. */
bus.on('audio:connect-surround', (channelIdx) => {
  connectFilePlaybackSurroundRoute(channelIdx);
});

bus.on('state:audio.isSurroundMode', (enabled) => {
  if (enabled === true) {
    const channelIdx = getState('audio.surroundChannelIndex');
    // toggleSurroundMode(true) intentionally publishes `enabled` before it
    // assigns the default center channel. The channel state event below owns
    // that first valid switch, so the transient -1 is not an error.
    if (Number.isInteger(channelIdx) && channelIdx >= 0 && channelIdx <= 7) {
      connectFilePlaybackSurroundRoute(channelIdx);
    }
  } else if (enabled === false) {
    connectFilePlaybackStereoRoute();
  }
});

bus.on('state:audio.surroundChannelIndex', (channelIdx) => {
  if (getState('audio.isSurroundMode')) connectFilePlaybackSurroundRoute(channelIdx);
});

/** Activate audio engine (triggered from setup UI on user interaction) */
bus.on('audio:activate', async () => {
  try {
    await initAudio();
    log.info('[Audio] Activated via user interaction');
  } catch (e) {
    log.warn('[Audio] Activation failed:', e);
  }
});
