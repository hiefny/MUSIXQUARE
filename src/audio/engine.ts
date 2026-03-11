/**
 * MUSIXQUARE 2.0 — Audio Engine (Tone.js)
 * Extracted from original app.js lines 476-2112
 *
 * Manages the entire Tone.js audio graph:
 *   Player → Widener → Preamp → Split → Channel Routing → Merge
 *     → GlobalLowPass → EQ(5-band) → Reverb(wet/dry) → MasterGain → Analyser → Destination
 *     + Virtual Bass parallel chain
 */

import { log } from '../core/log.ts';
import { EQ_FREQUENCIES } from '../core/constants.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';

import * as Tone from 'tone';
import type {
  Gain, Filter, Reverb, CrossFade, StereoWidener,
  Analyser, Split, Merge,
  ToneAudioNode,
} from 'tone';
import type { Compressor } from 'tone/build/esm/component/dynamics/Compressor.js';
import type { Limiter } from 'tone/build/esm/component/dynamics/Limiter.js';
import type { WaveShaper } from 'tone/build/esm/signal/WaveShaper.js';

// ─── Tone.js type aliases (internal convenience) ──────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToneNode = ToneAudioNode<any>;
type ToneGainNode = Gain;
type ToneFilterNode = Filter;
type ToneReverbNode = Reverb;
type ToneCrossFadeNode = CrossFade;
type ToneWidenerNode = StereoWidener;
type ToneAnalyserNode = Analyser;

// ─── Module-scoped audio nodes ─────────────────────────────────────
let toneSplit: Split | null = null;
let toneMerge: Merge | null = null;
let gainL: ToneGainNode | null = null;
let gainR: ToneGainNode | null = null;
let masterGain: ToneGainNode | null = null;
let reverb: ToneReverbNode | null = null;
let rvbLowCut: ToneFilterNode | null = null;
let rvbHighCut: ToneFilterNode | null = null;
let rvbCrossFade: ToneCrossFadeNode | null = null;
let eqNodes: ToneFilterNode[] = [];
let preamp: ToneGainNode | null = null;
let widener: ToneWidenerNode | null = null;
let globalLowPass: ToneFilterNode | null = null;
let analyser: ToneAnalyserNode | null = null;
// Virtual Bass — Dual-Band Psychoacoustic Enhancement
let vbSubLP: ToneFilterNode | null = null;
let vbSubHP: ToneFilterNode | null = null;
let vbSubComp: Compressor | null = null;
let vbSubTrim: ToneGainNode | null = null;
let vbSubShaper: WaveShaper | null = null;
let vbSubPostHP: ToneFilterNode | null = null;
let vbSubPostLP: ToneFilterNode | null = null;
let vbSubMix: ToneGainNode | null = null;
let vbMidLP: ToneFilterNode | null = null;
let vbMidHP: ToneFilterNode | null = null;
let vbMidComp: Compressor | null = null;
let vbMidTrim: ToneGainNode | null = null;
let vbMidShaper: WaveShaper | null = null;
let vbMidPostHP: ToneFilterNode | null = null;
let vbMidPostLP: ToneFilterNode | null = null;
let vbMidMix: ToneGainNode | null = null;
let vbSum: ToneGainNode | null = null;
let vbLimiter: Limiter | null = null;
let vbGain: ToneGainNode | null = null;
let surroundSplitter: Split | null = null;
let surroundGain: ToneGainNode | null = null;

let _initAudioPromise: Promise<void> | null = null;
let _ctxStateChangeCtx: AudioContext | null = null;
let _ctxStateChangeHandler: (() => void) | null = null;

// ─── Public Getters ────────────────────────────────────────────────

export function getMasterGain(): ToneGainNode | null { return masterGain; }
export function getAnalyser(): ToneAnalyserNode | null { return analyser; }
export function getToneMerge(): Merge | null { return toneMerge; }
export function getGainL(): ToneGainNode | null { return gainL; }
export function getGainR(): ToneGainNode | null { return gainR; }
export function getPreamp(): ToneGainNode | null { return preamp; }
export function getWidener(): ToneWidenerNode | null { return widener; }
export function getReverb(): ToneReverbNode | null { return reverb; }
export function getRvbLowCut(): ToneFilterNode | null { return rvbLowCut; }
export function getRvbHighCut(): ToneFilterNode | null { return rvbHighCut; }
export function getRvbCrossFade(): ToneCrossFadeNode | null { return rvbCrossFade; }
export function getEqNodes(): ToneFilterNode[] { return eqNodes; }
export function getGlobalLowPass(): ToneFilterNode | null { return globalLowPass; }
export function getVbGain(): ToneGainNode | null { return vbGain; }
export function getSurroundSplitter(): Split | null { return surroundSplitter; }
export function getSurroundGain(): ToneGainNode | null { return surroundGain; }
export function isAudioReady(): boolean { return masterGain !== null; }
export function getAudioContext(): AudioContext | null {
  try { return (Tone?.getContext?.()?.rawContext as AudioContext) ?? null; } catch { return null; }
}

// For surround mode setup (creates nodes only; connected later in setSurroundChannel)
export function ensureSurroundNodes(): { splitter: Split; gain: Gain } {
  if (!surroundSplitter || !surroundGain) {
    surroundSplitter = new Tone.Split(8);
    surroundGain = new Tone.Gain(1);
  }
  return { splitter: surroundSplitter!, gain: surroundGain! };
}

/**
 * Safely disconnect a Tone.js node (no-op if already disconnected).
 */
export function safeDisconnect(node: ToneNode | null): void {
  if (!node) return;
  try {
    node.disconnect();
  } catch {
    // Tone.js throws when node has no active connections — expected
  }
}

// ─── Initialization ────────────────────────────────────────────────

/**
 * Initialize the full Tone.js audio graph.
 * Safe to call multiple times (idempotent).
 */
export async function initAudio(): Promise<void> {
  // Fast-path: already initialized
  if (masterGain) {
    if (typeof Tone !== 'undefined' && Tone?.context?.state !== 'running') {
      try { await Tone.start(); } catch { /* best-effort */ }
    }
    return;
  }

  // Prevent concurrent initializations
  if (_initAudioPromise) return _initAudioPromise;

  _initAudioPromise = _doInitAudio();

  try {
    await _initAudioPromise;
  } catch (e) {
    // Ensure sentinel is cleared on ANY init failure — prevents fast-path
    // with an incomplete audio graph on subsequent initAudio() calls.
    masterGain = null;
    throw e;
  } finally {
    _initAudioPromise = null;
  }
}

async function _doInitAudio(): Promise<void> {
  if (typeof Tone === 'undefined' || !Tone?.context) {
    throw new Error('Tone.js not loaded');
  }

  if (Tone.context.state !== 'running') {
    await Tone.start();
  }
  if (masterGain) return; // Another call may have finished while awaiting

  // Guard: if a previous failed init left partial nodes, dispose them first
  if (toneSplit || preamp || reverb || widener) {
    const leftoverNodes: (ToneNode | null)[] = [
      toneSplit, toneMerge, gainL, gainR, preamp, widener, reverb,
      rvbLowCut, rvbHighCut, rvbCrossFade, globalLowPass, analyser,
      vbSubLP, vbSubHP, vbSubComp, vbSubTrim, vbSubShaper, vbSubPostHP, vbSubPostLP, vbSubMix,
      vbMidLP, vbMidHP, vbMidComp, vbMidTrim, vbMidShaper, vbMidPostHP, vbMidPostLP, vbMidMix,
      vbSum, vbLimiter, vbGain,
      surroundSplitter, surroundGain,
    ];
    for (const n of leftoverNodes) { try { if (n) n.dispose(); } catch { /* */ } }
    for (const n of eqNodes) { try { n.dispose(); } catch { /* */ } }
    toneSplit = toneMerge = gainL = gainR = preamp = widener = null;
    reverb = null; rvbLowCut = rvbHighCut = null; rvbCrossFade = null;
    globalLowPass = analyser = null; eqNodes = [];
    vbSubLP = vbSubHP = vbSubComp = vbSubTrim = vbSubShaper = null;
    vbSubPostHP = vbSubPostLP = vbSubMix = null;
    vbMidLP = vbMidHP = vbMidComp = vbMidTrim = vbMidShaper = null;
    vbMidPostHP = vbMidPostLP = vbMidMix = null;
    vbSum = vbLimiter = vbGain = null;
    surroundSplitter = surroundGain = null;
    log.warn('[Audio] Cleaned up leftover nodes from previous failed init');
  }

  // ── Channel & Stereo Processing ──
  toneSplit = new Tone.Split();
  toneMerge = new Tone.Merge();
  gainL = new Tone.Gain(1);
  gainR = new Tone.Gain(1);

  toneSplit!.connect(gainL!, 0);  // L -> gainL
  toneSplit!.connect(gainR!, 1);  // R -> gainR

  // Default Routing: Stereo (L→0, R→1 of merge)
  gainL!.connect(toneMerge!, 0, 0);
  gainR!.connect(toneMerge!, 0, 1);

  // ── Effects Chain ──
  masterGain = new Tone.Gain(1);

  // EQ (5-Band Peaking Filters)
  eqNodes = EQ_FREQUENCIES.map(f =>
    new Tone.Filter({ type: 'peaking', frequency: f, Q: 1.0, gain: 0 })
  );

  // Preamplifier + Stereo Widener
  preamp = new Tone.Gain(1);
  widener = new Tone.StereoWidener(1); // applySettings() overwrites with state default

  // Reverb
  reverb = new Tone.Reverb({ decay: 5.0, preDelay: 0.1 });
  reverb.wet.value = 1; // 100% Wet for parallel routing

  try {
    await reverb.generate();
  } catch (reverbErr) {
    // Clean up partially created nodes before rethrowing
    [toneSplit, toneMerge, gainL, gainR, masterGain, preamp, widener, reverb].forEach(n => {
      try { if (n) n.dispose(); } catch { /* */ }
    });
    eqNodes.forEach(n => { try { n.dispose(); } catch { /* */ } });
    toneSplit = toneMerge = gainL = gainR = masterGain = preamp = widener = null;
    reverb = null;
    eqNodes = [];
    throw reverbErr;
  }

  // Damping filters — wrapped to prevent partial graph if any node throws
  // (masterGain is already set at this point, so initAudio() would fast-path)
  try {
  rvbLowCut = new Tone.Filter(20, 'highpass', -12);
  rvbHighCut = new Tone.Filter(20000, 'lowpass', -12);
  rvbCrossFade = new Tone.CrossFade(0); // Initially Dry

  // ── Virtual Bass — Dual-Band Psychoacoustic Enhancement ──
  // Custom waveshaper curves (8192 samples for smooth interpolation)
  const VB_CURVE_LEN = 8192;

  // Sub-bass: soft cubic saturation  f(x) = x - x³/3  (max ±0.667)
  const subCurve = new Float32Array(VB_CURVE_LEN);
  for (let i = 0; i < VB_CURVE_LEN; i++) {
    const x = (i / (VB_CURVE_LEN - 1)) * 2 - 1;
    subCurve[i] = x - (x * x * x) / 3;
  }

  // Mid-bass: soft quadratic saturation  f(x) = sign(x)·(2|x| - x²)  (max ±1.0)
  const midCurve = new Float32Array(VB_CURVE_LEN);
  for (let i = 0; i < VB_CURVE_LEN; i++) {
    const x = (i / (VB_CURVE_LEN - 1)) * 2 - 1;
    const ax = Math.abs(x);
    const shaped = ax <= 1.0 ? (2 * ax - ax * ax) : 1.0;
    midCurve[i] = x >= 0 ? shaped : -shaped;
  }

  // Sub-bass path (40-80 Hz)
  vbSubLP = new Tone.Filter({ frequency: 80, type: 'lowpass', rolloff: -24 });
  vbSubHP = new Tone.Filter({ frequency: 40, type: 'highpass', rolloff: -12 });
  vbSubComp = new Tone.Compressor({ threshold: -24, ratio: 4, attack: 0.01, release: 0.1, knee: 10 });
  vbSubTrim = new Tone.Gain(0.8);
  vbSubShaper = new Tone.WaveShaper(subCurve);
  vbSubPostHP = new Tone.Filter({ frequency: 80, type: 'highpass', rolloff: -12 });
  vbSubPostLP = new Tone.Filter({ frequency: 320, type: 'lowpass', rolloff: -24 });
  vbSubMix = new Tone.Gain(1.0);

  // Mid-bass path (80-160 Hz)
  vbMidLP = new Tone.Filter({ frequency: 160, type: 'lowpass', rolloff: -24 });
  vbMidHP = new Tone.Filter({ frequency: 80, type: 'highpass', rolloff: -12 });
  vbMidComp = new Tone.Compressor({ threshold: -20, ratio: 3, attack: 0.005, release: 0.08, knee: 8 });
  vbMidTrim = new Tone.Gain(0.7);
  vbMidShaper = new Tone.WaveShaper(midCurve);
  vbMidPostHP = new Tone.Filter({ frequency: 150, type: 'highpass', rolloff: -12 });
  vbMidPostLP = new Tone.Filter({ frequency: 600, type: 'lowpass', rolloff: -24 });
  vbMidMix = new Tone.Gain(0.8);

  // Output stage
  vbSum = new Tone.Gain(1.0);
  vbLimiter = new Tone.Limiter(-3);
  vbGain = new Tone.Gain(0);

  // ── Connections ──
  // Player → Widener → Preamp → Split → (Channel Logic) → Merge → EQ → Reverb → Master

  // 1. Pre-Processing
  widener!.connect(preamp!);

  // 2. Channel Splitting
  preamp!.connect(toneSplit!);

  // 3. Post-Processing: Merge → GlobalLowPass → EQ → Reverb → Master
  globalLowPass = new Tone.Filter(20000, 'lowpass');
  toneMerge!.connect(globalLowPass);

  let eqIn: ToneNode = globalLowPass!;
  for (const fx of eqNodes) {
    eqIn.connect(fx);
    eqIn = fx;
  }

  // Wet/Dry Routing with Damping
  eqIn.connect(rvbCrossFade.a);              // Dry path
  eqIn.connect(reverb);                       // Wet path
  reverb.connect(rvbLowCut);
  rvbLowCut.connect(rvbHighCut);
  rvbHighCut.connect(rvbCrossFade.b);
  rvbCrossFade!.connect(masterGain!);            // Output

  // Virtual Bass — dual-band parallel tap after EQ
  // Sub-bass path
  eqIn.connect(vbSubLP!);
  vbSubLP!.connect(vbSubHP!);
  vbSubHP!.connect(vbSubComp!);
  vbSubComp!.connect(vbSubTrim!);
  vbSubTrim!.connect(vbSubShaper!);
  vbSubShaper!.connect(vbSubPostHP!);
  vbSubPostHP!.connect(vbSubPostLP!);
  vbSubPostLP!.connect(vbSubMix!);
  vbSubMix!.connect(vbSum!);
  // Mid-bass path
  eqIn.connect(vbMidLP!);
  vbMidLP!.connect(vbMidHP!);
  vbMidHP!.connect(vbMidComp!);
  vbMidComp!.connect(vbMidTrim!);
  vbMidTrim!.connect(vbMidShaper!);
  vbMidShaper!.connect(vbMidPostHP!);
  vbMidPostHP!.connect(vbMidPostLP!);
  vbMidPostLP!.connect(vbMidMix!);
  vbMidMix!.connect(vbSum!);
  // Output stage
  vbSum!.connect(vbLimiter!);
  vbLimiter!.connect(vbGain!);
  vbGain!.connect(masterGain!);

  // Visualizer — 2048 bins for accurate frequency mapping (bass 0~260Hz, high 7.5k~20kHz)
  analyser = new Tone.Analyser('fft', 2048);
  analyser.smoothing = 0.3;
  masterGain!.connect(analyser);
  masterGain!.toDestination();

  // Analyser is available via getAnalyser() export — no need to duplicate in state

  } catch (postReverbErr) {
    // Post-reverb node construction failed — dispose ALL nodes to prevent
    // partial graph (masterGain already set would make initAudio() fast-path)
    const allNodes: (ToneNode | null)[] = [
      toneSplit, toneMerge, gainL, gainR, masterGain, preamp, widener, reverb,
      rvbLowCut, rvbHighCut, rvbCrossFade, globalLowPass, analyser,
      vbSubLP, vbSubHP, vbSubComp, vbSubTrim, vbSubShaper, vbSubPostHP, vbSubPostLP, vbSubMix,
      vbMidLP, vbMidHP, vbMidComp, vbMidTrim, vbMidShaper, vbMidPostHP, vbMidPostLP, vbMidMix,
      vbSum, vbLimiter, vbGain,
      surroundSplitter, surroundGain,
    ];
    for (const n of allNodes) { try { if (n) n.dispose(); } catch { /* */ } }
    for (const n of eqNodes) { try { n.dispose(); } catch { /* */ } }
    toneSplit = toneMerge = gainL = gainR = masterGain = preamp = widener = null;
    reverb = null; rvbLowCut = rvbHighCut = null; rvbCrossFade = null;
    globalLowPass = analyser = null; eqNodes = [];
    vbSubLP = vbSubHP = vbSubComp = vbSubTrim = vbSubShaper = null;
    vbSubPostHP = vbSubPostLP = vbSubMix = null;
    vbMidLP = vbMidHP = vbMidComp = vbMidTrim = vbMidShaper = null;
    vbMidPostHP = vbMidPostLP = vbMidMix = null;
    vbSum = vbLimiter = vbGain = null;
    surroundSplitter = surroundGain = null;
    throw postReverbErr;
  }

  // iOS Silent Mode Bypass: Play the hidden <audio> element to unlock
  // programmatic playback on iOS (must happen during user gesture)
  try {
    const silentAudio = document.getElementById('silent-trigger') as HTMLAudioElement | null;
    if (silentAudio) {
      silentAudio.play().catch(e => log.debug('[Audio] Silent Audio play failed', e));
    }

    // Also briefly play/pause the main video element to unlock it for later use
    const videoEl = document.getElementById('main-video') as HTMLVideoElement | null;
    if (videoEl) {
      try { await videoEl.play(); videoEl.pause(); } catch (e) { log.debug('[Audio] Video unlock failed', e); }
    }
  } catch (e) {
    log.debug('[Audio] iOS unlock attempt failed:', e);
  }

  // Auto-resume AudioContext on interruption (phone call, AirPlay switch, etc.)
  try {
    // Remove previous listener if re-init
    if (_ctxStateChangeCtx && _ctxStateChangeHandler) {
      _ctxStateChangeCtx.removeEventListener('statechange', _ctxStateChangeHandler);
    }
    const ctx = Tone.getContext().rawContext as AudioContext;
    const handler = () => {
      if (ctx.state === 'suspended' || (ctx.state as string) === 'interrupted') {
        log.info(`[Audio] AudioContext ${ctx.state} — auto-resuming`);
        ctx.resume().catch(e => log.debug('[Audio] Auto-resume failed', e));
      }
    };
    ctx.addEventListener('statechange', handler);
    _ctxStateChangeCtx = ctx;
    _ctxStateChangeHandler = handler;
  } catch (e) {
    log.debug('[Audio] statechange listener setup failed', e);
  }

  log.info('[Audio] Tone.js graph initialized');
  bus.emit('audio:ready');
}

// ─── Bus Event Handlers ─────────────────────────────────────────

/** Set master volume (0-1) */
bus.on('audio:set-volume', (volume) => {
  if (!Number.isFinite(volume)) return;
  const clamped = Math.max(0, Math.min(1, volume));
  setState('audio.masterVolume', clamped);
  if (masterGain) {
    masterGain.gain.rampTo(clamped, 0.1);
  }
  bus.emit('audio:volume-changed', clamped);
  // Also sync YouTube player volume when in YouTube mode
  bus.emit('youtube:set-volume', Math.round(clamped * 100));
  // Sync video element volume (native video playback)
  bus.emit('player:sync-video-volume', clamped);
});

/** Apply volume to YouTube player */
bus.on('audio:apply-youtube-volume', () => {
  const vol = getState('audio.masterVolume') ?? 1;
  // YouTube player volume is 0-100
  bus.emit('youtube:set-volume', Math.round(vol * 100));
});

/** Connect player node to surround routing */
bus.on('audio:connect-surround', (playerNode, channelIdx) => {
  if (!playerNode) return;
  if (typeof channelIdx !== 'number' || channelIdx < 0 || channelIdx > 7) {
    log.warn(`[Audio] Invalid surround channelIdx: ${channelIdx}`);
    return;
  }

  const { splitter, gain } = ensureSurroundNodes();
  const pre = getPreamp();
  if (!pre) return;

  try {
    gain.disconnect();
  } catch { /* expected */ }
  gain.connect(pre);

  // Disconnect splitter BEFORE connecting playerNode to avoid brief wrong routing
  try {
    splitter.disconnect();
  } catch { /* expected */ }

  (playerNode as ToneNode).connect(splitter);

  if (channelIdx === 6) {
    splitter.connect(gain, 6, 0);
    splitter.connect(gain, 4, 0);
  } else if (channelIdx === 7) {
    splitter.connect(gain, 7, 0);
    splitter.connect(gain, 5, 0);
  } else if (channelIdx === 3) {
    splitter.connect(gain, 3, 0);
  } else {
    splitter.connect(gain, channelIdx, 0);
  }

  log.debug(`[Audio] Surround connected: channel ${channelIdx}`);
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

// Re-export Tone types for downstream consumers
export type {
  ToneNode,
  ToneGainNode,
  ToneFilterNode,
  ToneReverbNode,
  ToneCrossFadeNode,
  ToneWidenerNode,
  ToneAnalyserNode,
};
