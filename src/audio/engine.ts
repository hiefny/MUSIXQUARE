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

// Tone.js — imported as `any` to keep our lightweight custom type stubs.
// Real Tone.js types are far richer; a full type migration can happen later.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as _Tone from 'tone';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Tone = _Tone as any;

// ─── Tone.js node type stubs ───────────────────────────────────────
interface ToneNode {
  connect(dest: ToneNode, outputNum?: number, inputNum?: number): ToneNode;
  disconnect(dest?: ToneNode): void;
  dispose(): void;
  toDestination(): ToneNode;
}

interface ToneParam {
  value: number;
  rampTo(value: number, time: number): void;
}

interface ToneGainNode extends ToneNode {
  gain: ToneParam;
}

interface ToneFilterNode extends ToneNode {
  frequency: ToneParam;
  gain: ToneParam;
  Q: ToneParam;
  type: string;
}

interface ToneReverbNode extends ToneNode {
  decay: number;
  preDelay: number;
  wet: ToneParam;
  generate(): Promise<void>;
}

interface ToneCrossFadeNode extends ToneNode {
  fade: ToneParam;
  a: ToneNode;
  b: ToneNode;
}

interface ToneWidenerNode extends ToneNode {
  width: ToneParam;
  wet: ToneParam;
}

interface ToneAnalyserNode extends ToneNode {
  smoothing: number;
  getValue(): Float32Array;
}

interface ToneBufferSourceNode extends ToneNode {
  buffer: unknown;
  start(time?: number, offset?: number): void;
  stop(time?: number): void;
  onended: (() => void) | null;
  playbackRate: ToneParam;
}

// ─── Module-scoped audio nodes ─────────────────────────────────────
let toneSplit: ToneNode | null = null;
let toneMerge: ToneNode | null = null;
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
let vbFilter: ToneFilterNode | null = null;
let vbCheby: ToneNode | null = null;
let vbPostFilter: ToneFilterNode | null = null;
let vbGain: ToneGainNode | null = null;
let surroundSplitter: ToneNode | null = null;
let surroundGain: ToneGainNode | null = null;

let _initAudioPromise: Promise<void> | null = null;

// ─── Public Getters ────────────────────────────────────────────────

export function getMasterGain(): ToneGainNode | null { return masterGain; }
export function getAnalyser(): ToneAnalyserNode | null { return analyser; }
export function getToneMerge(): ToneNode | null { return toneMerge; }
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
export function getVbFilter(): ToneFilterNode | null { return vbFilter; }
export function getVbPostFilter(): ToneFilterNode | null { return vbPostFilter; }
export function getVbGain(): ToneGainNode | null { return vbGain; }
export function getSurroundSplitter(): ToneNode | null { return surroundSplitter; }
export function getSurroundGain(): ToneGainNode | null { return surroundGain; }
export function isAudioReady(): boolean { return masterGain !== null; }

// For surround mode setup
export function ensureSurroundNodes(): { splitter: ToneNode; gain: ToneGainNode } {
  if (!surroundSplitter || !surroundGain) {
    surroundSplitter = new Tone.Split(8) as ToneNode;
    surroundGain = new Tone.Gain(1) as ToneGainNode;
  }
  return { splitter: surroundSplitter!, gain: surroundGain! };
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

  // ── Channel & Stereo Processing ──
  toneSplit = new Tone.Split() as ToneNode;
  toneMerge = new Tone.Merge() as ToneNode;
  gainL = new Tone.Gain(1) as ToneGainNode;
  gainR = new Tone.Gain(1) as ToneGainNode;

  toneSplit!.connect(gainL!, 0);  // L -> gainL
  toneSplit!.connect(gainR!, 1);  // R -> gainR

  // Default Routing: Stereo (L→0, R→1 of merge)
  gainL!.connect(toneMerge!, 0, 0);
  gainR!.connect(toneMerge!, 0, 1);

  // ── Effects Chain ──
  masterGain = new Tone.Gain(1) as ToneGainNode;

  // EQ (5-Band Peaking Filters)
  eqNodes = EQ_FREQUENCIES.map(f =>
    new Tone.Filter({ type: 'peaking', frequency: f, Q: 1.0, gain: 0 }) as ToneFilterNode
  );

  // Preamplifier + Stereo Widener
  preamp = new Tone.Gain(1) as ToneGainNode;
  widener = new Tone.StereoWidener(1) as ToneWidenerNode;

  // Reverb
  reverb = new Tone.Reverb({ decay: 5.0, preDelay: 0.1 }) as ToneReverbNode;
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

  // Damping filters
  rvbLowCut = new Tone.Filter(20, 'highpass', -12) as ToneFilterNode;
  rvbHighCut = new Tone.Filter(20000, 'lowpass', -12) as ToneFilterNode;
  rvbCrossFade = new Tone.CrossFade(0) as ToneCrossFadeNode; // Initially Dry

  // ── Virtual Bass Chain ──
  vbFilter = new Tone.Filter(120, 'lowpass', -12) as ToneFilterNode;
  vbCheby = new Tone.Chebyshev(50) as ToneNode;
  vbPostFilter = new Tone.Filter(20000, 'lowpass', -12) as ToneFilterNode;
  vbGain = new Tone.Gain(0) as ToneGainNode;

  // ── Connections ──
  // Player → Widener → Preamp → Split → (Channel Logic) → Merge → EQ → Reverb → Master

  // 1. Pre-Processing
  widener!.connect(preamp!);

  // 2. Channel Splitting
  preamp!.connect(toneSplit!);

  // 3. Post-Processing: Merge → GlobalLowPass → EQ → Reverb → Master
  globalLowPass = new Tone.Filter(20000, 'lowpass') as ToneFilterNode;
  toneMerge!.connect(globalLowPass);

  let eqIn: ToneNode = globalLowPass;
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

  // Virtual Bass (parallel tap after EQ)
  eqIn.connect(vbFilter!);
  vbFilter!.connect(vbCheby!);
  vbCheby!.connect(vbPostFilter!);
  vbPostFilter!.connect(vbGain!);
  vbGain!.connect(masterGain!);

  // Visualizer — 256 bins is enough (only bass 0~12 and high 70%~100% are used)
  analyser = new Tone.Analyser('fft', 256) as ToneAnalyserNode;
  analyser.smoothing = 0;
  masterGain!.connect(analyser);
  masterGain!.toDestination();

  // Store analyser reference in state for visualizer access
  setState('audio.analyser', analyser);

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
      videoEl.play().then(() => videoEl.pause()).catch(e => log.debug('[Audio] Video unlock failed', e));
    }
  } catch (e) {
    log.debug('[Audio] iOS unlock attempt failed:', e);
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

  const { splitter, gain } = ensureSurroundNodes();
  const pre = getPreamp();
  if (!pre) return;

  try {
    gain.disconnect();
  } catch { /* expected */ }
  gain.connect(pre);

  (playerNode as ToneNode).connect(splitter);

  try {
    splitter.disconnect();
  } catch { /* expected */ }

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
  ToneParam,
  ToneGainNode,
  ToneFilterNode,
  ToneReverbNode,
  ToneCrossFadeNode,
  ToneWidenerNode,
  ToneAnalyserNode,
  ToneBufferSourceNode,
};
