/**
 * MUSIXQUARE 3.0 — Audio Engine (Tone.js)
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
type ToneNode = ToneAudioNode<any>;
type ToneGainNode = Gain;
type ToneFilterNode = Filter;
type ToneReverbNode = Reverb;
type ToneCrossFadeNode = CrossFade;
type ToneWidenerNode = StereoWidener;
type ToneAnalyserNode = Analyser;

// ─── AudioGraph Struct ────────────────────────────────────────────
interface AudioGraph {
  // Channel & stereo processing
  toneSplit: Split | null;
  toneMerge: Merge | null;
  gainL: ToneGainNode | null;
  gainR: ToneGainNode | null;

  // Effects chain
  masterGain: ToneGainNode | null;
  reverb: ToneReverbNode | null;
  rvbLowCut: ToneFilterNode | null;
  rvbHighCut: ToneFilterNode | null;
  rvbCrossFade: ToneCrossFadeNode | null;
  eqNodes: ToneFilterNode[];
  preamp: ToneGainNode | null;
  widener: ToneWidenerNode | null;
  globalLowPass: ToneFilterNode | null;
  analyser: ToneAnalyserNode | null;

  // Virtual Bass — Dual-Band
  vbSubLP: ToneFilterNode | null;
  vbSubHP: ToneFilterNode | null;
  vbSubComp: Compressor | null;
  vbSubTrim: ToneGainNode | null;
  vbSubShaper: WaveShaper | null;
  vbSubPostHP: ToneFilterNode | null;
  vbSubPostLP: ToneFilterNode | null;
  vbSubMix: ToneGainNode | null;
  vbMidLP: ToneFilterNode | null;
  vbMidHP: ToneFilterNode | null;
  vbMidComp: Compressor | null;
  vbMidTrim: ToneGainNode | null;
  vbMidShaper: WaveShaper | null;
  vbMidPostHP: ToneFilterNode | null;
  vbMidPostLP: ToneFilterNode | null;
  vbMidMix: ToneGainNode | null;
  vbSum: ToneGainNode | null;
  vbLimiter: Limiter | null;
  vbGain: ToneGainNode | null;

  // Surround
  surroundSplitter: Split | null;
  surroundGain: ToneGainNode | null;
}

function createEmptyGraph(): AudioGraph {
  return {
    toneSplit: null, toneMerge: null, gainL: null, gainR: null,
    masterGain: null, reverb: null, rvbLowCut: null, rvbHighCut: null,
    rvbCrossFade: null, eqNodes: [], preamp: null, widener: null,
    globalLowPass: null, analyser: null,
    vbSubLP: null, vbSubHP: null, vbSubComp: null, vbSubTrim: null,
    vbSubShaper: null, vbSubPostHP: null, vbSubPostLP: null, vbSubMix: null,
    vbMidLP: null, vbMidHP: null, vbMidComp: null, vbMidTrim: null,
    vbMidShaper: null, vbMidPostHP: null, vbMidPostLP: null, vbMidMix: null,
    vbSum: null, vbLimiter: null, vbGain: null,
    surroundSplitter: null, surroundGain: null,
  };
}

let _graph: AudioGraph = createEmptyGraph();

let _initAudioPromise: Promise<void> | null = null;
let _ctxStateChangeCtx: AudioContext | null = null;
let _ctxStateChangeHandler: (() => void) | null = null;

// ─── Public Getters ────────────────────────────────────────────────

export function getMasterGain(): ToneGainNode | null { return _graph.masterGain; }
export function getAnalyser(): ToneAnalyserNode | null { return _graph.analyser; }
export function getToneMerge(): Merge | null { return _graph.toneMerge; }
export function getGainL(): ToneGainNode | null { return _graph.gainL; }
export function getGainR(): ToneGainNode | null { return _graph.gainR; }
export function getPreamp(): ToneGainNode | null { return _graph.preamp; }
export function getWidener(): ToneWidenerNode | null { return _graph.widener; }
export function getReverb(): ToneReverbNode | null { return _graph.reverb; }
export function getRvbLowCut(): ToneFilterNode | null { return _graph.rvbLowCut; }
export function getRvbHighCut(): ToneFilterNode | null { return _graph.rvbHighCut; }
export function getRvbCrossFade(): ToneCrossFadeNode | null { return _graph.rvbCrossFade; }
export function getEqNodes(): ToneFilterNode[] { return _graph.eqNodes; }
export function getGlobalLowPass(): ToneFilterNode | null { return _graph.globalLowPass; }
export function getVbGain(): ToneGainNode | null { return _graph.vbGain; }
export function getSurroundSplitter(): Split | null { return _graph.surroundSplitter; }
export function getSurroundGain(): ToneGainNode | null { return _graph.surroundGain; }
export function isAudioReady(): boolean { return _graph.masterGain !== null; }
export function getAudioContext(): AudioContext | null {
  try { return (Tone?.getContext?.()?.rawContext as AudioContext) ?? null; } catch { return null; }
}

// For surround mode setup (creates nodes only; connected later in setSurroundChannel)
export function ensureSurroundNodes(): { splitter: Split; gain: Gain } {
  if (!_graph.surroundSplitter || !_graph.surroundGain) {
    _graph.surroundSplitter = new Tone.Split(8);
    _graph.surroundGain = new Tone.Gain(1);
  }
  return { splitter: _graph.surroundSplitter!, gain: _graph.surroundGain! };
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
  if (_graph.masterGain) {
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
    _graph.masterGain = null;
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
  if (_graph.masterGain) return; // Another call may have finished while awaiting

  // Guard: if a previous failed init left partial nodes, dispose them first
  if (_graph.toneSplit || _graph.preamp || _graph.reverb || _graph.widener) {
    const leftoverNodes: (ToneNode | null)[] = [
      _graph.toneSplit, _graph.toneMerge, _graph.gainL, _graph.gainR,
      _graph.preamp, _graph.widener, _graph.reverb,
      _graph.rvbLowCut, _graph.rvbHighCut, _graph.rvbCrossFade,
      _graph.globalLowPass, _graph.analyser,
      _graph.vbSubLP, _graph.vbSubHP, _graph.vbSubComp, _graph.vbSubTrim,
      _graph.vbSubShaper, _graph.vbSubPostHP, _graph.vbSubPostLP, _graph.vbSubMix,
      _graph.vbMidLP, _graph.vbMidHP, _graph.vbMidComp, _graph.vbMidTrim,
      _graph.vbMidShaper, _graph.vbMidPostHP, _graph.vbMidPostLP, _graph.vbMidMix,
      _graph.vbSum, _graph.vbLimiter, _graph.vbGain,
      _graph.surroundSplitter, _graph.surroundGain,
    ];
    for (const n of leftoverNodes) { try { if (n) n.dispose(); } catch { /* */ } }
    for (const n of _graph.eqNodes) { try { n.dispose(); } catch { /* */ } }
    _graph = createEmptyGraph();
    log.warn('[Audio] Cleaned up leftover nodes from previous failed init');
  }

  // ── Channel & Stereo Processing ──
  _graph.toneSplit = new Tone.Split();
  _graph.toneMerge = new Tone.Merge();
  _graph.gainL = new Tone.Gain(1);
  _graph.gainR = new Tone.Gain(1);

  _graph.toneSplit!.connect(_graph.gainL!, 0);  // L -> gainL
  _graph.toneSplit!.connect(_graph.gainR!, 1);  // R -> gainR

  // Default Routing: Stereo (L→0, R→1 of merge)
  _graph.gainL!.connect(_graph.toneMerge!, 0, 0);
  _graph.gainR!.connect(_graph.toneMerge!, 0, 1);

  // ── Effects Chain ──
  _graph.masterGain = new Tone.Gain(1);

  // EQ (5-Band Peaking Filters)
  _graph.eqNodes = EQ_FREQUENCIES.map(f =>
    new Tone.Filter({ type: 'peaking', frequency: f, Q: 1.0, gain: 0 })
  );

  // Preamplifier + Stereo Widener
  _graph.preamp = new Tone.Gain(1);
  _graph.widener = new Tone.StereoWidener(1); // applySettings() overwrites with state default

  // Reverb
  _graph.reverb = new Tone.Reverb({ decay: 5.0, preDelay: 0.1 });
  _graph.reverb.wet.value = 1; // 100% Wet for parallel routing

  try {
    await _graph.reverb.generate();
  } catch (reverbErr) {
    // Clean up partially created nodes before rethrowing
    [_graph.toneSplit, _graph.toneMerge, _graph.gainL, _graph.gainR,
     _graph.masterGain, _graph.preamp, _graph.widener, _graph.reverb].forEach(n => {
      try { if (n) n.dispose(); } catch { /* */ }
    });
    _graph.eqNodes.forEach(n => { try { n.dispose(); } catch { /* */ } });
    _graph = createEmptyGraph();
    throw reverbErr;
  }

  // Damping filters — wrapped to prevent partial graph if any node throws
  // (masterGain is already set at this point, so initAudio() would fast-path)
  try {
  _graph.rvbLowCut = new Tone.Filter(20, 'highpass', -12);
  _graph.rvbHighCut = new Tone.Filter(20000, 'lowpass', -12);
  _graph.rvbCrossFade = new Tone.CrossFade(0); // Initially Dry

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
  _graph.vbSubLP = new Tone.Filter({ frequency: 80, type: 'lowpass', rolloff: -24 });
  _graph.vbSubHP = new Tone.Filter({ frequency: 40, type: 'highpass', rolloff: -12 });
  _graph.vbSubComp = new Tone.Compressor({ threshold: -24, ratio: 4, attack: 0.01, release: 0.1, knee: 10 });
  _graph.vbSubTrim = new Tone.Gain(0.8);
  _graph.vbSubShaper = new Tone.WaveShaper(subCurve);
  _graph.vbSubPostHP = new Tone.Filter({ frequency: 80, type: 'highpass', rolloff: -12 });
  _graph.vbSubPostLP = new Tone.Filter({ frequency: 320, type: 'lowpass', rolloff: -24 });
  _graph.vbSubMix = new Tone.Gain(1.0);

  // Mid-bass path (80-160 Hz)
  _graph.vbMidLP = new Tone.Filter({ frequency: 160, type: 'lowpass', rolloff: -24 });
  _graph.vbMidHP = new Tone.Filter({ frequency: 80, type: 'highpass', rolloff: -12 });
  _graph.vbMidComp = new Tone.Compressor({ threshold: -20, ratio: 3, attack: 0.005, release: 0.08, knee: 8 });
  _graph.vbMidTrim = new Tone.Gain(0.7);
  _graph.vbMidShaper = new Tone.WaveShaper(midCurve);
  _graph.vbMidPostHP = new Tone.Filter({ frequency: 150, type: 'highpass', rolloff: -12 });
  _graph.vbMidPostLP = new Tone.Filter({ frequency: 600, type: 'lowpass', rolloff: -24 });
  _graph.vbMidMix = new Tone.Gain(0.8);

  // Output stage
  _graph.vbSum = new Tone.Gain(1.0);
  _graph.vbLimiter = new Tone.Limiter(-3);
  _graph.vbGain = new Tone.Gain(0);

  // ── Connections ──
  // Player → Widener → Preamp → Split → (Channel Logic) → Merge → EQ → Reverb → Master

  // 1. Pre-Processing
  _graph.widener!.connect(_graph.preamp!);

  // 2. Channel Splitting
  _graph.preamp!.connect(_graph.toneSplit!);

  // 3. Post-Processing: Merge → GlobalLowPass → EQ → Reverb → Master
  _graph.globalLowPass = new Tone.Filter(20000, 'lowpass');
  _graph.toneMerge!.connect(_graph.globalLowPass);

  let eqIn: ToneNode = _graph.globalLowPass!;
  for (const fx of _graph.eqNodes) {
    eqIn.connect(fx);
    eqIn = fx;
  }

  // Wet/Dry Routing with Damping
  eqIn.connect(_graph.rvbCrossFade.a);              // Dry path
  eqIn.connect(_graph.reverb!);                     // Wet path
  _graph.reverb!.connect(_graph.rvbLowCut);
  _graph.rvbLowCut.connect(_graph.rvbHighCut);
  _graph.rvbHighCut.connect(_graph.rvbCrossFade.b);
  _graph.rvbCrossFade!.connect(_graph.masterGain!);    // Output

  // Virtual Bass — dual-band parallel tap after EQ
  // Sub-bass path
  eqIn.connect(_graph.vbSubLP!);
  _graph.vbSubLP!.connect(_graph.vbSubHP!);
  _graph.vbSubHP!.connect(_graph.vbSubComp!);
  _graph.vbSubComp!.connect(_graph.vbSubTrim!);
  _graph.vbSubTrim!.connect(_graph.vbSubShaper!);
  _graph.vbSubShaper!.connect(_graph.vbSubPostHP!);
  _graph.vbSubPostHP!.connect(_graph.vbSubPostLP!);
  _graph.vbSubPostLP!.connect(_graph.vbSubMix!);
  _graph.vbSubMix!.connect(_graph.vbSum!);
  // Mid-bass path
  eqIn.connect(_graph.vbMidLP!);
  _graph.vbMidLP!.connect(_graph.vbMidHP!);
  _graph.vbMidHP!.connect(_graph.vbMidComp!);
  _graph.vbMidComp!.connect(_graph.vbMidTrim!);
  _graph.vbMidTrim!.connect(_graph.vbMidShaper!);
  _graph.vbMidShaper!.connect(_graph.vbMidPostHP!);
  _graph.vbMidPostHP!.connect(_graph.vbMidPostLP!);
  _graph.vbMidPostLP!.connect(_graph.vbMidMix!);
  _graph.vbMidMix!.connect(_graph.vbSum!);
  // Output stage
  _graph.vbSum!.connect(_graph.vbLimiter!);
  _graph.vbLimiter!.connect(_graph.vbGain!);
  _graph.vbGain!.connect(_graph.masterGain!);

  // Visualizer — 2048 bins for accurate frequency mapping (bass 0~260Hz, high 7.5k~20kHz)
  _graph.analyser = new Tone.Analyser('fft', 2048);
  _graph.analyser.smoothing = 0.3;
  _graph.masterGain!.connect(_graph.analyser);
  _graph.masterGain!.toDestination();

  // Analyser is available via getAnalyser() export — no need to duplicate in state

  } catch (postReverbErr) {
    // Post-reverb node construction failed — dispose ALL nodes to prevent
    // partial graph (masterGain already set would make initAudio() fast-path)
    const allNodes: (ToneNode | null)[] = [
      _graph.toneSplit, _graph.toneMerge, _graph.gainL, _graph.gainR,
      _graph.masterGain, _graph.preamp, _graph.widener, _graph.reverb,
      _graph.rvbLowCut, _graph.rvbHighCut, _graph.rvbCrossFade,
      _graph.globalLowPass, _graph.analyser,
      _graph.vbSubLP, _graph.vbSubHP, _graph.vbSubComp, _graph.vbSubTrim,
      _graph.vbSubShaper, _graph.vbSubPostHP, _graph.vbSubPostLP, _graph.vbSubMix,
      _graph.vbMidLP, _graph.vbMidHP, _graph.vbMidComp, _graph.vbMidTrim,
      _graph.vbMidShaper, _graph.vbMidPostHP, _graph.vbMidPostLP, _graph.vbMidMix,
      _graph.vbSum, _graph.vbLimiter, _graph.vbGain,
      _graph.surroundSplitter, _graph.surroundGain,
    ];
    for (const n of allNodes) { try { if (n) n.dispose(); } catch { /* */ } }
    for (const n of _graph.eqNodes) { try { n.dispose(); } catch { /* */ } }
    _graph = createEmptyGraph();
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
  if (_graph.masterGain) {
    _graph.masterGain.gain.rampTo(clamped, 0.1);
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
