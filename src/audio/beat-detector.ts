/**
 * MUSIXQUARE — BPM Beat Detector
 *
 * Detects BPM from the current AudioBuffer using energy-map autocorrelation
 * (proven v2 algorithm), then emits 'beat:pulse' events synced to the
 * audio clock via requestAnimationFrame.
 *
 * Integration:
 *   - Listens to playback mode/activity for play/pause/stop transitions
 *   - Reads AudioBuffer from player/_state.ts
 *   - Uses audioCtx.currentTime + player.startedAt for beat grid alignment
 */

import { log } from '../core/log.ts';
import { analyzeFullBuffer } from 'realtime-bpm-analyzer';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { getCurrentTime } from './context.ts';
import { getCurrentAudioBuffer } from '../player/_state.ts';
import { isPlaybackPlayingFile } from '../player/ownership.ts';

// ─── Module State ────────────────────────────────────────────────

let _bpm = 0;
let _phase = 0; // first beat offset in seconds
let _beatDuration = 0; // seconds per beat
let _animId: number | null = null;
let _lastBeatIdx = -1;
let _analysedBuffer: AudioBuffer | null = null; // avoid re-analysis of same buffer
let _cachedIsFilePlaying = isPlaybackPlayingFile();

function refreshCachedPlaybackState(): void {
  _cachedIsFilePlaying = isPlaybackPlayingFile();
}

function isCachedFilePlaying(): boolean {
  return _cachedIsFilePlaying;
}

// ─── Public Getters ──────────────────────────────────────────────

export function getDetectedBPM(): number {
  return _bpm;
}

let _partyMode = false;
export function isPartyMode(): boolean {
  return _partyMode;
}
export function setPartyMode(on: boolean): void {
  const wasOn = _partyMode;
  _partyMode = on;
  if (on && !wasOn) {
    // Lazy analysis: party just turned on. If a track is already playing, kick
    // off BPM analysis now (the regular playback-state entry point skipped it
    // while party was off). _analysedBuffer cache survives toggles, so the same
    // track only ever incurs the analysis cost once.
    refreshCachedPlaybackState();
    if (isCachedFilePlaying()) {
      void analyzeAndStart();
    }
  } else if (!on && wasOn) {
    // Party turned off. Stop the rAF beat loop so it isn't burning a frame
    // every paint just to fire 'beat:pulse' events that no consumer is
    // listening for. _bpm and _analysedBuffer stay populated so re-enabling
    // party for the same track is instant.
    stopBeatLoop();
  }
}

// ─── Init ────────────────────────────────────────────────────────

export function initBeatDetector(): void {
  const handlePlaybackStateChange = () => {
    refreshCachedPlaybackState();
    if (isCachedFilePlaying()) {
      void analyzeAndStart();
      return;
    }

    // Non-playing or non-file state: stop loop AND release buffer memory.
    clearBeatDetector();
  };

  bus.on('state:playback.mode', handlePlaybackStateChange);
  bus.on('state:playback.activity', handlePlaybackStateChange);

  // Track ended: full reset to release AudioBuffer memory
  bus.on('player:ended', clearBeatDetector);

  // Handle track change: when stopAllMedia({ silent: true }) keeps playback
  // activity as playing, playback-state events won't fire again. Listen for
  // buffer swaps to re-analyze BPM.
  bus.on('player:buffer-changed', () => {
    refreshCachedPlaybackState();
    if (isCachedFilePlaying()) {
      void analyzeAndStart();
    }
  });

  log.info('[BeatDetector] Initialized');
}

// ─── Analysis (original v2 algorithm — verbatim) ────────────────

async function analyzeAndStart(): Promise<void> {
  // Skip the entire pipeline while party mode is off. analyzeFullBuffer()
  // is heavyweight (autocorrelation over the whole AudioBuffer) and the
  // only consumer of 'beat:pulse' is party-mode.ts, which itself early-
  // returns on !isPartyMode(). Running analysis just to discard the result
  // wasted main-thread time on every track change. setPartyMode(true)
  // re-entry covers the case where the user enables party mid-playback.
  if (!_partyMode) return;

  const buf = getCurrentAudioBuffer();
  if (!buf) return;

  // Skip if same buffer already analyzed
  if (buf === _analysedBuffer && _bpm > 0) {
    startBeatLoop();
    return;
  }

  const t0 = performance.now();

  try {
    // 1) Use the robust library for BPM
    const candidates = await analyzeFullBuffer(buf);
    // Race guard: if a newer buffer was loaded while we awaited (rapid track
    // switch), discard this stale analysis. Without this, the older track's
    // BPM clobbers the newer one's, and the rAF loop pulses out-of-sync until
    // the next track change. Also prevents a leaked rAF self-loop on pause.
    if (buf !== getCurrentAudioBuffer()) return;
    // Sibling race guard: party turned off while we awaited. setPartyMode(false)'s
    // stopBeatLoop() was a no-op (no _animId yet — analyzeFullBuffer was blocking),
    // so without this the post-await startBeatLoop() below spawns a rAF that
    // emits 'beat:pulse' every paint despite _partyMode=false. The consumer
    // early-returns on !isPartyMode() so it's silent, but the rAF still burns
    // ~1 frame of work per paint until the next track change clears it.
    if (!_partyMode) return;

    // Sort candidates by frequency (count)
    candidates.sort((a, b) => b.count - a.count);
    let topBPM = candidates[0]?.tempo || 0;

    // 2) Use our V2 logic just for Phase detection (library doesn't give phase)
    const v2Result = detectBPM_V2(buf);

    const ms = performance.now() - t0;

    // >200 BPM → halve
    if (topBPM > 200) topBPM /= 2;

    _bpm = Math.round(topBPM);
    _phase = v2Result.phase; // Use custom phase logic
    _analysedBuffer = buf;

    if (_bpm <= 0) {
      log.warn('[BeatDetector] Could not detect BPM');
      _beatDuration = 0;
      return;
    }

    _beatDuration = 60 / _bpm;

    log.info(`[BeatDetector] ${_bpm} BPM via library in ${ms.toFixed(0)}ms`);

    startBeatLoop();
  } catch (err) {
    log.error('[BeatDetector] Analysis failed', err);
    // Same race guard: detectBPM_V2 below is sync but operates on the stale
    // `buf` captured pre-await. Without this, the fallback path can still
    // publish the wrong track's BPM after a fast track-swap.
    if (buf !== getCurrentAudioBuffer()) return;
    // Sibling partyMode guard — same reasoning as the try-path version above.
    if (!_partyMode) return;
    // Fallback to V2 if library fails
    const v2 = detectBPM_V2(buf);
    _bpm = Math.round(v2.bpm);
    _phase = v2.phase;
    _analysedBuffer = buf;

    if (_bpm <= 0) {
      _beatDuration = 0;
      return;
    }

    _beatDuration = 60 / _bpm;
    startBeatLoop();
  }
}

/**
 * Original v2 detection — 200Hz energy map autocorrelation + parabolic interpolation.
 * Unchanged from the proven playground implementation.
 */
function detectBPM_V2(audioBuffer: AudioBuffer): { bpm: number; phase: number } {
  const data = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;

  // 1) 200Hz energy map
  const targetFreq = 200;
  const step = Math.floor(sampleRate / targetFreq);
  const actualFreq = sampleRate / step;
  const energyMap: number[] = [];
  for (let i = 0; i < data.length; i += step) {
    let sum = 0;
    for (let j = 0; j < step && i + j < data.length; j++) sum += data[i + j] * data[i + j];
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
    score /= limit - lag;
    allScores.push({ lag, score });
  }

  // 3) Peak + parabolic interpolation
  let maxScore = -1,
    bestIdx = -1;
  for (let i = 0; i < allScores.length; i++) {
    if (allScores[i].score > maxScore) {
      maxScore = allScores[i].score;
      bestIdx = i;
    }
  }

  let refinedLag = allScores[bestIdx].lag;
  if (bestIdx > 0 && bestIdx < allScores.length - 1) {
    const s0 = allScores[bestIdx - 1].score;
    const s1 = allScores[bestIdx].score;
    const s2 = allScores[bestIdx + 1].score;
    const denom = s0 - 2 * s1 + s2;
    if (Math.abs(denom) > 0.000001) {
      refinedLag = allScores[bestIdx].lag + (0.5 * (s0 - s2)) / denom;
    }
  }
  const finalBPM = (60 * actualFreq) / refinedLag;

  // 4) Phase (Global Phase Alignment — Comb Filter approach)
  // Instead of the first peak, we find the offset (0..1 beat) that maximizes
  // alignment with the energy map over the first 15 seconds.
  const beatDurationFrames = actualFreq * (60 / finalBPM);
  const searchLimitFrames = Math.floor(actualFreq * 15); // Check first 15 seconds
  const framesToScan = Math.min(energyMap.length, searchLimitFrames);

  let bestOffsetFrames = 0;
  let maxAlignmentScore = -1;

  // Scan every possible offset within one beat (1 frame resolution = 5ms)
  for (let offset = 0; offset < beatDurationFrames; offset++) {
    let score = 0;
    let count = 0;

    // Sum energy at every beat position for this offset candidate
    for (let t = offset; t < framesToScan; t += beatDurationFrames) {
      const idx = Math.floor(t);
      if (idx < framesToScan) {
        // Use squared energy for better peak emphasis
        score += energyMap[idx] * energyMap[idx];
        count++;
      }
    }

    if (count > 0) {
      score /= count;
      if (score > maxAlignmentScore) {
        maxAlignmentScore = score;
        bestOffsetFrames = offset;
      }
    }
  }

  const finalPhaseS = bestOffsetFrames / actualFreq;
  return { bpm: finalBPM, phase: finalPhaseS };
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
  // M16: Memory note — _analysedBuffer is NOT nullified here anymore.
  // Clearing it here defeated the cache check in analyzeAndStart() (line 73),
  // causing full BPM re-analysis on every resume of the same track.
  // Instead, _analysedBuffer is released in clearBeatDetector() (called on
  // track change / stop) so memory is still freed when it matters.
}

/** Full reset — call on track change or playback stop to release memory. */
export function clearBeatDetector(): void {
  stopBeatLoop();
  _analysedBuffer = null;
  _bpm = 0;
  _beatDuration = 0;
  _phase = 0;
}

function tick(): void {
  _animId = requestAnimationFrame(tick);

  if (!isCachedFilePlaying()) {
    _lastBeatIdx = -1;
    return;
  }

  if (_bpm <= 0 || _beatDuration <= 0) return;

  const startedAt = (getState('player.startedAt') as number) || 0;
  const localOffset = (getState('sync.localOffset') as number) || 0;
  const now = getCurrentTime() - startedAt + localOffset;

  const beatsElapsed = (now - _phase) / _beatDuration;
  const beatIdx = Math.floor(beatsElapsed);

  if (beatIdx >= 0 && beatIdx !== _lastBeatIdx) {
    _lastBeatIdx = beatIdx;
    bus.emit('beat:pulse', _bpm, beatIdx);
  }
}
