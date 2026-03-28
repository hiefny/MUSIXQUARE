/**
 * MUSIXQUARE 3.0 — BPM Beat Detector
 *
 * Detects BPM from the current AudioBuffer using energy-map autocorrelation
 * (proven v2 algorithm), then emits 'beat:pulse' events synced to the
 * audio clock via requestAnimationFrame.
 *
 * Integration:
 *   - Listens to state:appState for play/pause/stop transitions
 *   - Reads AudioBuffer from player/_state.ts
 *   - Uses audioCtx.currentTime + player.startedAt for beat grid alignment
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { APP_STATE } from '../core/constants.ts';
import { getCurrentTime } from './context.ts';
import { getCurrentAudioBuffer } from '../player/_state.ts';

// ─── Module State ────────────────────────────────────────────────

let _bpm = 0;
let _phase = 0;          // first beat offset in seconds
let _beatDuration = 0;   // seconds per beat
let _animId: number | null = null;
let _lastBeatIdx = -1;
let _analysedBuffer: AudioBuffer | null = null;   // avoid re-analysis of same buffer

// ─── Public Getters ──────────────────────────────────────────────

export function getDetectedBPM(): number { return _bpm; }
export function getBeatPhase(): number { return _phase; }

// ─── Init ────────────────────────────────────────────────────────

export function initBeatDetector(): void {
  bus.on('state:appState', (value) => {
    const state = value as string;
    if (state === APP_STATE.PLAYING_AUDIO || state === APP_STATE.PLAYING_VIDEO) {
      analyzeAndStart();
    } else {
      stopBeatLoop();
    }
  });

  // Re-analyze when a new track loads (buffer changes while already playing)
  bus.on('player:ended', stopBeatLoop);

  log.info('[BeatDetector] Initialized');
}

// ─── Analysis (original v2 algorithm — verbatim) ────────────────

function analyzeAndStart(): void {
  const buf = getCurrentAudioBuffer();
  if (!buf) return;

  // Skip if same buffer already analyzed
  if (buf === _analysedBuffer && _bpm > 0) {
    startBeatLoop();
    return;
  }

  const t0 = performance.now();
  const result = detectBPM_V2(buf);
  const ms = performance.now() - t0;

  // >200 BPM → halve (original v2 behavior)
  let finalBPM = result.bpm;
  if (finalBPM > 200) finalBPM /= 2;

  _bpm = Math.round(finalBPM);
  _phase = result.phase;
  _beatDuration = 60 / _bpm;
  _analysedBuffer = buf;

  setState('audio.detectedBPM', _bpm);

  log.info(`[BeatDetector] ${_bpm} BPM (raw ${result.bpm.toFixed(1)}) in ${ms.toFixed(0)}ms`);
  bus.emit('beat:detected', _bpm, _phase);

  startBeatLoop();
}

/**
 * Original v2 detection — 200Hz energy map autocorrelation + parabolic interpolation.
 * Unchanged from the proven playground implementation.
 */
function detectBPM_V2(audioBuffer: AudioBuffer): { bpm: number; phase: number } {
  const data = audioBuffer.numberOfChannels > 1
    ? mixToMono(audioBuffer)
    : audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;

  // 1) 200Hz energy map
  const targetFreq = 200;
  const step = Math.floor(sampleRate / targetFreq);
  const actualFreq = sampleRate / step;
  const energyMap: number[] = [];
  for (let i = 0; i < data.length; i += step) {
    let sum = 0;
    for (let j = 0; j < step && (i + j) < data.length; j++) sum += data[i + j] * data[i + j];
    energyMap.push(Math.sqrt(sum / step));
  }

  // 2) Autocorrelation (50–220 BPM)
  const allScores: { lag: number; score: number }[] = [];
  const minLag = Math.floor(actualFreq * (60 / 220));
  const maxLag = Math.ceil(actualFreq * (60 / 50));
  const limit = Math.min(energyMap.length, 12000);

  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let i = lag; i < limit; i++) score += energyMap[i] * energyMap[i - lag];
    score /= (limit - lag);
    allScores.push({ lag, score });
  }

  // 3) Peak + parabolic interpolation
  let maxScore = -1, bestIdx = -1;
  for (let i = 0; i < allScores.length; i++) {
    if (allScores[i].score > maxScore) { maxScore = allScores[i].score; bestIdx = i; }
  }

  let refinedLag = allScores[bestIdx].lag;
  if (bestIdx > 0 && bestIdx < allScores.length - 1) {
    const s0 = allScores[bestIdx - 1].score;
    const s1 = allScores[bestIdx].score;
    const s2 = allScores[bestIdx + 1].score;
    const denom = s0 - 2 * s1 + s2;
    if (Math.abs(denom) > 0.000001) {
      refinedLag = allScores[bestIdx].lag + 0.5 * (s0 - s2) / denom;
    }
  }

  // 4) Phase (first beat offset)
  let maxEnergy = 0;
  for (let i = 0; i < energyMap.length; i++) {
    if (energyMap[i] > maxEnergy) maxEnergy = energyMap[i];
  }
  const threshold = maxEnergy * 0.4;
  let firstBeatOffset = 0;
  for (let i = 0; i < Math.min(energyMap.length, 1000); i++) {
    if (energyMap[i] > threshold) { firstBeatOffset = i / actualFreq; break; }
  }

  const finalBPM = (60 * actualFreq) / refinedLag;
  return { bpm: finalBPM, phase: firstBeatOffset };
}

function mixToMono(buf: AudioBuffer): Float32Array {
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const out = new Float32Array(L.length);
  for (let i = 0; i < out.length; i++) out[i] = (L[i] + R[i]) * 0.5;
  return out;
}

// ─── Beat Loop (rAF + audioCtx.currentTime) ─────────────────────

function startBeatLoop(): void {
  stopBeatLoop();
  _lastBeatIdx = -1;
  tick();
}

function stopBeatLoop(): void {
  if (_animId !== null) {
    cancelAnimationFrame(_animId);
    _animId = null;
  }
  _lastBeatIdx = -1;
}

function tick(): void {
  const state = getState('appState');
  if (state !== APP_STATE.PLAYING_AUDIO && state !== APP_STATE.PLAYING_VIDEO) return;
  if (_bpm <= 0) return;

  const startedAt = getState('player.startedAt') as number || 0;
  const localOffset = (getState('sync.localOffset') as number) || 0;
  const autoSyncOffset = (getState('sync.autoSyncOffset') as number) || 0;
  const now = (getCurrentTime() - startedAt) + localOffset + autoSyncOffset;

  const beatsElapsed = (now - _phase) / _beatDuration;
  const beatIdx = Math.floor(beatsElapsed);

  if (beatIdx >= 0 && beatIdx !== _lastBeatIdx) {
    _lastBeatIdx = beatIdx;
    bus.emit('beat:pulse', _bpm, beatIdx);
  }

  _animId = requestAnimationFrame(tick);
}
