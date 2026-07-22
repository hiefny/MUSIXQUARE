/**
 * MUSIXQUARE — Canvas FFT Visualizer
 *
 * Manages: Bass/High frequency circle visualizer with light/dark theme.
 */

import { log } from '../core/log.ts';
import { createBusScope } from '../core/events.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { getAnalyser as getEngineAnalyser } from '../audio/engine.ts';
import { scopePlaybackModeActivity } from './_state-hooks.ts';
import { isPlaybackModeYouTube, isPlaybackPaused, isPlaybackPlaying } from '../player/ownership.ts';

// ─── State ───────────────────────────────────────────────────────

let _animationId: number | null = null;
let _visualizerRetryCount = 0;
const MAX_VISUALIZER_RETRIES = 20;
let _resizeListenerAdded = false;
let _visualizerResizeObserver: ResizeObserver | null = null;
let _vizMode: 'circular' | 'spectrum' = 'circular';
let _isVisualizerStartCoalescing = false;
let _visualizerLoopState: 'idle' | 'active' | 'settling' = 'idle';

function readPersistedVisualizerMode(): 'circular' | 'spectrum' {
  try {
    return localStorage.getItem('musixquare-viz-mode') === 'spectrum' ? 'spectrum' : 'circular';
  } catch {
    return 'circular';
  }
}

function applyVisualizerMode(mode: 'circular' | 'spectrum'): void {
  _vizMode = mode;
  document.body.classList.toggle('viz-spectrum', mode === 'spectrum');
  document.body.classList.toggle('viz-circular', mode === 'circular');
}

// ─── Spectrum constants ─────────────────────────────────────────
const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const MIN_DB = -100;
const MAX_DB = 0;
const SLOPE_DB_PER_OCTAVE = 4.5;
const SLOPE_REF_FREQ = 1000;
const LOG_GAMMA = 1.0; // neutral log-scale spacing
const LOG_MIN_FREQ = Math.log10(MIN_FREQ);
const LOG_FREQ_RANGE = Math.log10(MAX_FREQ) - LOG_MIN_FREQ;
const SPECTRUM_GRID_FREQS = [100, 1000, 10000] as const;

// ─── Smoothing coefficients (0 = instant, 1 = frozen) ───
const BASS_SMOOTH = 0.8;
const HIGH_SMOOTH = 0.8;
const VIZ_SETTLE_MS = 180;
const SPECTRUM_START_WARMUP_FRAMES = 2;

type SpectrumPoint = { x: number; y: number };

interface SpectrumBinLayout {
  bufferLength: number;
  sampleRate: number;
  logicalW: number;
  padX: number;
  indices: number[];
  xValues: number[];
  slopeValues: number[];
  gridXValues: number[];
}

interface CircularFrame {
  bassPunch: number;
  bassOpacity: number;
  highPunch: number;
}

interface SpectrumFrame {
  points: SpectrumPoint[];
  width: number;
  height: number;
  padX: number;
  padY: number;
}

let _lastCircularFrame: CircularFrame | null = null;
let _lastSpectrumFrame: SpectrumFrame | null = null;
let _visualizerRunToken = 0;

// ─── Display-rate Frame Loop ─────────────────────────────────────

// ─── Cached values (avoid per-frame DOM reads) ──────────────────
let _cachedIsLight = false;
let _themeListenersRegistered = false;
let _themeObserver: MutationObserver | null = null;

function refreshThemeCache(): void {
  const theme = document.documentElement.getAttribute('data-theme');
  _cachedIsLight = theme === 'light';
}

function _initThemeListeners(): void {
  if (_themeListenersRegistered) return;
  _themeListenersRegistered = true;

  // Listen for OS-level prefers-color-scheme change
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refreshThemeCache);
  } catch (e) {
    log.debug('[Visualizer] matchMedia listener error:', e);
  }

  // Listen for data-theme attribute changes (app-level theme toggle).
  // Idempotent: re-init replaces any previous observer.
  if (_themeObserver) {
    _themeObserver.disconnect();
    _themeObserver = null;
  }
  try {
    _themeObserver = new MutationObserver(() => {
      refreshThemeCache();
      // Repaint static content with the new theme — a paused-held or resting
      // frame would otherwise keep the old theme's colors (visible on the
      // spectrum grid) until the next playback transition. Active/settling
      // loops read the refreshed cache on their next frame.
      if (_visualizerLoopState === 'idle') {
        if (_isHoldingPauseFrame) redrawHeldFrame();
        else drawRestingVisualizerFrame();
      }
    });
    _themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  } catch {
    /* ignore */
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function getAnalyser(): AnalyserNode | null {
  return getEngineAnalyser();
}

/**
 * Unified sizing helper to ensure canvas matches the parent container perfectly (High DPI).
 * Returns the logical size of the container for drawing calculations.
 */
function syncCanvasSize(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  wrapper: HTMLElement | null,
): number {
  const rawW = wrapper ? wrapper.clientWidth : 0;
  const rawH = wrapper ? wrapper.clientHeight : 0;

  // For circular mode, we want a square fit
  if (_vizMode === 'circular') {
    const rawSize = Math.min(rawW, rawH);
    const logicalSize = rawSize > 10 ? rawSize : 240;
    const dpr = window.devicePixelRatio || 1;

    if (canvas.width !== logicalSize * dpr || canvas.height !== logicalSize * dpr) {
      canvas.width = logicalSize * dpr;
      canvas.height = logicalSize * dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    }
    return logicalSize;
  } else {
    // For spectrum mode, we use the full rectangular container
    const logicalW = rawW > 10 ? rawW : 400;
    const logicalH = rawH > 10 ? rawH : 240;
    const dpr = window.devicePixelRatio || 1;

    if (canvas.width !== logicalW * dpr || canvas.height !== logicalH * dpr) {
      canvas.width = logicalW * dpr;
      canvas.height = logicalH * dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    }
    return logicalW; // Return width for spectrum logic indexing if needed, though they usually use W/H directly
  }
}

// ─── Resting settle animation ─────────────────────────────────────
let _holdNextPauseFrame = false;
let _isHoldingPauseFrame = false;

function cancelVisualizerAnimation(): void {
  _visualizerRunToken++;
  if (_animationId) {
    cancelAnimationFrame(_animationId);
    _animationId = null;
  }
  _visualizerLoopState = 'idle';
}

function clearLastVisualizerFrames(): void {
  _lastCircularFrame = null;
  _lastSpectrumFrame = null;
}

function claimVisualizerStart(): boolean {
  if (_isVisualizerStartCoalescing) return false;
  _isVisualizerStartCoalescing = true;
  queueMicrotask(() => {
    _isVisualizerStartCoalescing = false;
  });
  return true;
}

function easeOutCubic(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - clamped, 3);
}

function drawCircularVisualizerFrame(
  ctx: CanvasRenderingContext2D,
  logicalSize: number,
  frame: CircularFrame,
): void {
  const scale = logicalSize / 240;
  const centerX = logicalSize / 2;
  const centerY = logicalSize / 2;
  const twoPi = 2 * Math.PI;

  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, logicalSize, logicalSize);
  ctx.shadowBlur = 0;

  const bassRadius = (55 + frame.bassPunch * 200) * scale;
  ctx.fillStyle = _cachedIsLight
    ? `rgba(66, 129, 241, ${frame.bassOpacity})`
    : `hsla(218, 86%, 60%, ${frame.bassOpacity})`;
  ctx.beginPath();
  ctx.arc(centerX, centerY, bassRadius, 0, twoPi);
  ctx.fill();

  const highRadius = (40 + frame.highPunch * 130) * scale;
  ctx.fillStyle = _cachedIsLight ? 'rgba(66, 129, 241, 1.0)' : 'hsla(218, 86%, 60%, 1.0)';
  ctx.beginPath();
  ctx.arc(centerX, centerY, highRadius, 0, twoPi);
  ctx.fill();
}

function drawSpectrumRestingLine(
  ctx: CanvasRenderingContext2D,
  logicalW: number,
  logicalH: number,
  padX: number,
  padY: number,
): void {
  const restY = dbToY(MIN_DB, logicalH, padY);
  ctx.strokeStyle = 'rgba(59, 130, 246, 0.38)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padX, restY);
  ctx.lineTo(logicalW - padX, restY);
  ctx.stroke();
}

function drawSpectrumCurve(
  ctx: CanvasRenderingContext2D,
  points: SpectrumPoint[],
  logicalH: number,
  padX: number,
  padY: number,
  isLight: boolean,
): void {
  if (points.length < 2) return;

  ctx.globalCompositeOperation = isLight ? 'source-over' : 'lighter';
  const grad = ctx.createLinearGradient(0, padY, 0, logicalH - padY);
  grad.addColorStop(0, isLight ? 'rgba(59, 130, 246, 0.15)' : 'rgba(59, 130, 246, 0.12)');
  grad.addColorStop(1, 'rgba(59, 130, 246, 0.0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(padX, logicalH - padY);
  ctx.lineTo(padX, points[0].y);
  for (let i = 0; i < points.length - 1; i++) {
    const mx = (points[i].x + points[i + 1].x) / 2;
    const my = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.lineTo(last.x, logicalH - padY);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padX, points[0].y);
  for (let i = 0; i < points.length - 1; i++) {
    const mx = (points[i].x + points[i + 1].x) / 2;
    const my = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
  }
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

function drawRestingVisualizerFrame(): void {
  const canvas = document.getElementById('visualizerCanvas') as HTMLCanvasElement | null;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;

  refreshThemeCache();
  const wrapper = document.querySelector('.vinyl-wrapper') as HTMLElement | null;
  syncCanvasSize(canvas, ctx, wrapper);
  const dpr = window.devicePixelRatio || 1;
  const logicalW = canvas.width / dpr;
  const logicalH = canvas.height / dpr;

  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, logicalW, logicalH);
  ctx.shadowBlur = 0;

  if (_vizMode === 'spectrum') {
    const padX = 4;
    const padY = 8;
    drawSpectrumGrid(ctx, logicalW, logicalH, padX, padY, _cachedIsLight);
    drawSpectrumRestingLine(ctx, logicalW, logicalH, padX, padY);
    clearLastVisualizerFrames();
    return;
  }

  const logicalSize = Math.min(logicalW, logicalH);
  drawCircularVisualizerFrame(ctx, logicalSize, {
    bassPunch: 0,
    bassOpacity: 0.25,
    highPunch: 0,
  });
  clearLastVisualizerFrames();
}

/**
 * Redraw the held pause-frame onto a (possibly resized/re-themed) canvas
 * without restarting the rAF loop. Spectrum points are re-normalized to the
 * new logical size — same mapping as settleVisualizerToRest at eased=0.
 */
function redrawHeldFrame(): void {
  const canvas = document.getElementById('visualizerCanvas') as HTMLCanvasElement | null;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;

  refreshThemeCache();
  const wrapper = document.querySelector('.vinyl-wrapper') as HTMLElement | null;
  syncCanvasSize(canvas, ctx, wrapper);
  const dpr = window.devicePixelRatio || 1;
  const logicalW = canvas.width / dpr;
  const logicalH = canvas.height / dpr;

  if (_vizMode === 'circular' && _lastCircularFrame) {
    drawCircularVisualizerFrame(ctx, Math.min(logicalW, logicalH), _lastCircularFrame);
    return;
  }

  if (_vizMode === 'spectrum' && _lastSpectrumFrame?.points.length) {
    const source = _lastSpectrumFrame;
    const padX = 4;
    const padY = 8;
    const points = source.points.map((p) => {
      const xRange = Math.max(1, source.width - 2 * source.padX);
      const yRange = Math.max(1, source.height - 2 * source.padY);
      const xNorm = Math.max(0, Math.min(1, (p.x - source.padX) / xRange));
      const yNorm = Math.max(0, Math.min(1, (p.y - source.padY) / yRange));
      return {
        x: padX + xNorm * (logicalW - 2 * padX),
        y: padY + yNorm * (logicalH - 2 * padY),
      };
    });
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, logicalW, logicalH);
    ctx.shadowBlur = 0;
    drawSpectrumGrid(ctx, logicalW, logicalH, padX, padY, _cachedIsLight);
    drawSpectrumCurve(ctx, points, logicalH, padX, padY, _cachedIsLight);
    _lastSpectrumFrame = { points, width: logicalW, height: logicalH, padX, padY };
    return;
  }

  drawRestingVisualizerFrame();
}

function fadeVisualizerOut(): void {
  settleVisualizerToRest();
  // Keep the event-facing name for compatibility with transport/playback.
  _holdNextPauseFrame = false;
  _isHoldingPauseFrame = false;
}

function settleVisualizerToRest(): void {
  cancelVisualizerAnimation();
  _visualizerLoopState = 'settling';
  const runToken = _visualizerRunToken;

  const canvas = document.getElementById('visualizerCanvas') as HTMLCanvasElement | null;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) {
    _visualizerLoopState = 'idle';
    return;
  }

  refreshThemeCache();
  const wrapper = document.querySelector('.vinyl-wrapper') as HTMLElement | null;
  syncCanvasSize(canvas, ctx, wrapper);
  const dpr = window.devicePixelRatio || 1;
  const logicalW = canvas.width / dpr;
  const logicalH = canvas.height / dpr;

  if (_vizMode === 'spectrum' && _lastSpectrumFrame?.points.length) {
    const source = _lastSpectrumFrame;
    const padX = 4;
    const padY = 8;
    const restY = dbToY(MIN_DB, logicalH, padY);
    const start = performance.now();

    const draw = (now: number): void => {
      if (runToken !== _visualizerRunToken) return;

      const eased = easeOutCubic((now - start) / VIZ_SETTLE_MS);
      const points = source.points.map((p) => {
        const xRange = Math.max(1, source.width - 2 * source.padX);
        const yRange = Math.max(1, source.height - 2 * source.padY);
        const xNorm = Math.max(0, Math.min(1, (p.x - source.padX) / xRange));
        const yNorm = Math.max(0, Math.min(1, (p.y - source.padY) / yRange));
        const x = padX + xNorm * (logicalW - 2 * padX);
        const startY = padY + yNorm * (logicalH - 2 * padY);
        return { x, y: startY + (restY - startY) * eased };
      });

      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, logicalW, logicalH);
      ctx.shadowBlur = 0;
      drawSpectrumGrid(ctx, logicalW, logicalH, padX, padY, _cachedIsLight);
      drawSpectrumCurve(ctx, points, logicalH, padX, padY, _cachedIsLight);
      _lastSpectrumFrame = { points, width: logicalW, height: logicalH, padX, padY };
      _lastCircularFrame = null;

      if (eased >= 1) {
        _animationId = null;
        _visualizerLoopState = 'idle';
        drawRestingVisualizerFrame();
        return;
      }
      _animationId = requestAnimationFrame(draw);
    };

    _animationId = requestAnimationFrame(draw);
    return;
  }

  if (_vizMode === 'circular' && _lastCircularFrame) {
    const source = _lastCircularFrame;
    const logicalSize = Math.min(logicalW, logicalH);
    const start = performance.now();

    const draw = (now: number): void => {
      if (runToken !== _visualizerRunToken) return;

      const eased = easeOutCubic((now - start) / VIZ_SETTLE_MS);
      const quiet = 1 - eased;
      const frame = {
        bassPunch: source.bassPunch * quiet,
        bassOpacity: source.bassOpacity + (0.25 - source.bassOpacity) * eased,
        highPunch: source.highPunch * quiet,
      };
      drawCircularVisualizerFrame(ctx, logicalSize, frame);
      _lastCircularFrame = frame;
      _lastSpectrumFrame = null;

      if (eased >= 1) {
        _animationId = null;
        _visualizerLoopState = 'idle';
        drawRestingVisualizerFrame();
        return;
      }
      _animationId = requestAnimationFrame(draw);
    };

    _animationId = requestAnimationFrame(draw);
    return;
  }

  _visualizerLoopState = 'idle';
  drawRestingVisualizerFrame();
}

// ─── Start Active Visualizer ─────────────────────────────────────

export function startVisualizer(): void {
  if (_visualizerLoopState === 'active' && _animationId !== null) return;

  // Activity gate — the single chokepoint for every entry point (resize,
  // ui:visualizer-check, set-type, visualizer:start, init/retry chain).
  // Without playing audio there is nothing to visualize: render a static
  // frame instead of spinning the rAF loop at full refresh rate (battery),
  // and never destroy a deliberately held pause-frame. Must NOT touch the
  // hold flags, and must draw (not bare-return): drawRestingVisualizerFrame
  // runs syncCanvasSize, which the iOS 0-sized-canvas wake and the resize
  // path rely on.
  if (!isPlaybackPlaying()) {
    if (_visualizerLoopState === 'settling') return; // settle rAF already converging to rest
    if (_isHoldingPauseFrame) {
      redrawHeldFrame();
      return;
    }
    drawRestingVisualizerFrame();
    return;
  }

  if (!claimVisualizerStart()) return;

  if (_vizMode === 'spectrum') {
    startSpectrumVisualizer();
    return;
  }

  clearManagedTimer('viz-retry');
  _holdNextPauseFrame = false;
  _isHoldingPauseFrame = false;
  cancelVisualizerAnimation();
  const runToken = _visualizerRunToken;
  clearLastVisualizerFrames();

  const canvas = document.getElementById('visualizerCanvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const _ctx = canvas.getContext('2d');
  if (!_ctx) return;
  const ctx: CanvasRenderingContext2D = _ctx;

  const analyser = getAnalyser();

  if (!analyser) {
    if (++_visualizerRetryCount > MAX_VISUALIZER_RETRIES) {
      log.warn(
        '[Visualizer] Gave up waiting for analyser after',
        MAX_VISUALIZER_RETRIES,
        'retries',
      );
      _visualizerRetryCount = 0;
      _visualizerLoopState = 'idle';
      return;
    }
    setManagedTimer('viz-retry', startVisualizer, 100);
    _visualizerLoopState = 'idle';
    return;
  }
  _visualizerRetryCount = 0;
  _visualizerLoopState = 'active';

  const bufferLength = analyser.frequencyBinCount;
  const _freqData = new Float32Array(bufferLength);

  let smoothedBass = 0;
  let smoothedHigh = 0;

  // Initial Sync
  const wrapper = document.querySelector('.vinyl-wrapper') as HTMLElement | null;
  let logicalSize = syncCanvasSize(canvas, ctx, wrapper);

  // Pre-compute constants outside draw loop
  const highStart = Math.floor(bufferLength * 0.7);
  const highEnd = bufferLength;
  let highCountVal = highEnd - highStart;
  if (highCountVal < 1) highCountVal = 1;
  let bassCount = 12;
  if (bassCount > bufferLength) bassCount = bufferLength;

  // Cache theme on start
  refreshThemeCache();

  function draw(): void {
    if (runToken !== _visualizerRunToken) return;

    // YouTube mode: analyser isn't connected or canvas is CSS-hidden, skip draw
    if (isPlaybackModeYouTube()) {
      _animationId = null;
      _visualizerLoopState = 'idle';
      return;
    }

    // Self-correct after resize — avoids stale dimensions during the 100ms
    // gap between resize event and startVisualizer() re-init.
    const curSize = canvas!.width / (window.devicePixelRatio || 1);
    if (curSize !== logicalSize) {
      logicalSize = curSize;
    }

    try {
      analyser!.getFloatFrequencyData(_freqData);
      const dbData = _freqData;

      // Bass: 0~260Hz (12 bins)
      let bassSum = 0;
      for (let i = 0; i < bassCount; i++) {
        let val = (dbData[i] + 100) * 2.5;
        if (!isFinite(val)) val = 0;
        if (val < 0) val = 0;
        if (val > 255) val = 255;
        bassSum += val;
      }
      const bassAverage = bassSum / bassCount;

      smoothedBass = smoothedBass * BASS_SMOOTH + bassAverage * (1 - BASS_SMOOTH);
      let bassPunch = Math.pow(smoothedBass / 255, 2.5);
      if (!isFinite(bassPunch)) bassPunch = 0;
      const bassPunchOpacity = Math.pow(smoothedBass / 255, 1.5);

      // High: 7.5kHz~20kHz (0.7~1.0 of buffer)
      let highSum = 0;
      for (let i = highStart; i < highEnd; i++) {
        let val = (dbData[i] + 100) * 2.5;
        if (!isFinite(val)) val = 0;
        if (val < 0) val = 0;
        if (val > 255) val = 255;
        highSum += val;
      }
      const highAverage = highSum / highCountVal;
      smoothedHigh = smoothedHigh * HIGH_SMOOTH + highAverage * (1 - HIGH_SMOOTH);
      let highPunch = smoothedHigh / 255;
      if (!isFinite(highPunch)) highPunch = 0;

      const bassOpacity = Math.min(0.75, 0.25 + bassPunchOpacity * 0.75);
      const frame = { bassPunch, bassOpacity, highPunch };
      drawCircularVisualizerFrame(ctx, logicalSize, frame);
      _lastCircularFrame = frame;
      _lastSpectrumFrame = null;

      _animationId = requestAnimationFrame(draw);
    } catch (e) {
      log.warn('[Visualizer] draw() error — stopping animation loop:', e);
      _animationId = null;
      _visualizerLoopState = 'idle';
    }
  }

  draw();
}

// ─── Spectrum Helpers ────────────────────────────────────────────

function freqToX(freq: number, w: number, padX: number): number {
  const norm = (Math.log10(freq) - LOG_MIN_FREQ) / LOG_FREQ_RANGE;
  const compressed = Math.pow(norm, LOG_GAMMA);
  return padX + compressed * (w - 2 * padX);
}

function dbToY(db: number, h: number, padY: number): number {
  const clamped = Math.max(MIN_DB, Math.min(MAX_DB, db));
  const norm = (clamped - MIN_DB) / (MAX_DB - MIN_DB);
  return padY + (1 - norm) * (h - 2 * padY);
}

function slopeCompensation(freq: number): number {
  if (freq <= 0) return 0;
  return SLOPE_DB_PER_OCTAVE * Math.log2(freq / SLOPE_REF_FREQ);
}

function createSpectrumBinLayout(
  bufferLength: number,
  sampleRate: number,
  logicalW: number,
  padX: number,
): SpectrumBinLayout {
  const indices: number[] = [];
  const xValues: number[] = [];
  const slopeValues: number[] = [];

  for (let i = 1; i < bufferLength; i += Math.max(1, Math.floor(i / 64))) {
    const freq = (i * sampleRate) / (bufferLength * 2);
    if (freq < MIN_FREQ) continue;
    if (freq > MAX_FREQ) break;
    indices.push(i);
    xValues.push(freqToX(freq, logicalW, padX));
    slopeValues.push(slopeCompensation(freq));
  }

  return {
    bufferLength,
    sampleRate,
    logicalW,
    padX,
    indices,
    xValues,
    slopeValues,
    gridXValues: SPECTRUM_GRID_FREQS.map((freq) => freqToX(freq, logicalW, padX)),
  };
}

function drawSpectrumGrid(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  padX: number,
  padY: number,
  isLight: boolean,
  gridXValues?: readonly number[],
): void {
  const alpha = isLight ? 0.06 : 0.06;
  ctx.lineWidth = 1;
  const xValues = gridXValues ?? SPECTRUM_GRID_FREQS.map((freq) => freqToX(freq, w, padX));
  for (const x of xValues) {
    const grad = ctx.createLinearGradient(0, padY, 0, h - padY);
    const col = isLight ? '0,0,0' : '255,255,255';
    grad.addColorStop(0, `rgba(${col},0)`);
    grad.addColorStop(0.15, `rgba(${col},${alpha})`);
    grad.addColorStop(0.85, `rgba(${col},${alpha})`);
    grad.addColorStop(1, `rgba(${col},0)`);
    ctx.strokeStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x, padY);
    ctx.lineTo(x, h - padY);
    ctx.stroke();
  }
}

// ─── Spectrum Active Drawing ────────────────────────────────────

function startSpectrumVisualizer(): void {
  clearManagedTimer('viz-retry');
  _holdNextPauseFrame = false;
  _isHoldingPauseFrame = false;
  cancelVisualizerAnimation();
  const runToken = _visualizerRunToken;
  clearLastVisualizerFrames();

  const canvas = document.getElementById('visualizerCanvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const _ctx = canvas.getContext('2d');
  if (!_ctx) return;
  const ctx: CanvasRenderingContext2D = _ctx;

  const analyser = getAnalyser();
  if (!analyser) {
    if (++_visualizerRetryCount > MAX_VISUALIZER_RETRIES) {
      _visualizerRetryCount = 0;
      _visualizerLoopState = 'idle';
      return;
    }
    setManagedTimer('viz-retry', startVisualizer, 100);
    _visualizerLoopState = 'idle';
    return;
  }
  _visualizerRetryCount = 0;
  _visualizerLoopState = 'active';

  const targetSmoothingTimeConstant = 0.8;
  analyser.smoothingTimeConstant = 0;
  const bufferLength = analyser.frequencyBinCount;
  const freqData = new Float32Array(bufferLength);
  const sampleRate = analyser.context.sampleRate;

  // Sync size
  const wrapper = document.querySelector('.vinyl-wrapper') as HTMLElement | null;
  syncCanvasSize(canvas, ctx, wrapper);
  let logicalW = canvas.width / (window.devicePixelRatio || 1);
  let logicalH = canvas.height / (window.devicePixelRatio || 1);

  const padX = 4;
  const padY = 8;
  refreshThemeCache();
  let warmupFrames = SPECTRUM_START_WARMUP_FRAMES;
  let binLayout = createSpectrumBinLayout(bufferLength, sampleRate, logicalW, padX);
  const points: SpectrumPoint[] = [];
  const lastSpectrumPoints: SpectrumPoint[] = [];

  function draw(): void {
    if (runToken !== _visualizerRunToken) return;

    if (isPlaybackModeYouTube()) {
      _animationId = null;
      _visualizerLoopState = 'idle';
      return;
    }

    // Self-correct after resize
    const curW = canvas!.width / (window.devicePixelRatio || 1);
    const curH = canvas!.height / (window.devicePixelRatio || 1);
    if (curW !== logicalW || curH !== logicalH) {
      logicalW = curW;
      logicalH = curH;
      if (curW !== binLayout.logicalW) {
        binLayout = createSpectrumBinLayout(bufferLength, sampleRate, logicalW, padX);
      }
    }

    try {
      analyser!.getFloatFrequencyData(freqData);
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, logicalW, logicalH);
      drawSpectrumGrid(ctx, logicalW, logicalH, padX, padY, _cachedIsLight, binLayout.gridXValues);

      if (warmupFrames > 0) {
        warmupFrames--;
        drawSpectrumRestingLine(ctx, logicalW, logicalH, padX, padY);
        clearLastVisualizerFrames();
        if (warmupFrames === 0) {
          analyser!.smoothingTimeConstant = targetSmoothingTimeConstant;
        }
        _animationId = requestAnimationFrame(draw);
        return;
      }

      points.length = binLayout.indices.length;
      for (let i = 0; i < binLayout.indices.length; i++) {
        const point = points[i] ?? { x: 0, y: 0 };
        point.x = binLayout.xValues[i];
        point.y = dbToY(freqData[binLayout.indices[i]] + binLayout.slopeValues[i], logicalH, padY);
        points[i] = point;
      }

      if (points.length >= 2) {
        drawSpectrumCurve(ctx, points, logicalH, padX, padY, _cachedIsLight);
        lastSpectrumPoints.length = points.length;
        for (let i = 0; i < points.length; i++) {
          const point = lastSpectrumPoints[i] ?? { x: 0, y: 0 };
          point.x = points[i].x;
          point.y = points[i].y;
          lastSpectrumPoints[i] = point;
        }
        _lastSpectrumFrame = {
          points: lastSpectrumPoints,
          width: logicalW,
          height: logicalH,
          padX,
          padY,
        };
        _lastCircularFrame = null;
      } else {
        _lastSpectrumFrame = null;
      }
      _animationId = requestAnimationFrame(draw);
    } catch (e) {
      log.warn('[Visualizer] spectrum draw() error:', e);
      _animationId = null;
      _visualizerLoopState = 'idle';
    }
  }
  draw();
}

// ─── Lifecycle ──────────────────────────────────────────────────────

const _busScope = createBusScope();

export function initVisualizer(): void {
  _busScope.dispose();

  refreshThemeCache();
  _initThemeListeners();
  applyVisualizerMode(readPersistedVisualizerMode());

  // Always use startVisualizer — it retries if analyser isn't ready yet,
  // and renders silence naturally as idle circles when no audio plays.
  startVisualizer();

  if (!_resizeListenerAdded) {
    _resizeListenerAdded = true;

    const handleResize = () => {
      // Browser zoom can change the viewport, DPR and wrapper geometry in
      // separate steps. Stop the old loop before resizing the bitmap so a
      // stale frame cannot draw with the previous coordinate system and leave
      // clipped arcs at the new canvas edges.
      const wasHoldingPauseFrame = _isHoldingPauseFrame;
      cancelVisualizerAnimation();

      const canvas = document.getElementById('visualizerCanvas') as HTMLCanvasElement | null;
      const ctx = canvas?.getContext('2d');
      const wrapper = document.querySelector('.vinyl-wrapper') as HTMLElement | null;
      if (canvas && ctx && wrapper) {
        syncCanvasSize(canvas, ctx, wrapper);
        if (_lastCircularFrame || _lastSpectrumFrame) {
          redrawHeldFrame();
          _isHoldingPauseFrame = wasHoldingPauseFrame;
        } else {
          drawRestingVisualizerFrame();
        }
      }

      setManagedTimer(
        'viz-resize',
        () => {
          if (!wrapper || (wrapper as HTMLElement).clientWidth < 10) return;
          startVisualizer();
        },
        100,
      );
    };

    window.addEventListener('resize', handleResize);
    window.visualViewport?.addEventListener('resize', handleResize);

    // CSS breakpoint and transformed-density changes are not guaranteed to
    // produce their final wrapper size in the same window resize callback.
    // Observe the actual drawing container as the authoritative geometry.
    const resizeWrapper = document.querySelector('.vinyl-wrapper') as HTMLElement | null;
    if (resizeWrapper && typeof ResizeObserver !== 'undefined') {
      _visualizerResizeObserver?.disconnect();
      _visualizerResizeObserver = new ResizeObserver(handleResize);
      _visualizerResizeObserver.observe(resizeWrapper);
    }

    // Orientation change: CSS transitions need time to settle before re-measuring
    const vizOrientationMql = window.matchMedia('(orientation: landscape)');
    vizOrientationMql.addEventListener('change', () => {
      handleResize();
      setManagedTimer('viz-orientation-resize', handleResize, 350);
    });
  }

  // Listen for check events from tab switch
  _busScope.on('ui:visualizer-check', () => {
    if (isPlaybackPaused()) {
      if (!_isHoldingPauseFrame) fadeVisualizerOut();
    } else if (!_animationId) {
      startVisualizer();
    }
  });

  // Listen for playback state changes
  scopePlaybackModeActivity(
    _busScope,
    (playback) => {
      if (playback.activity === 'paused' && _holdNextPauseFrame) {
        // PAUSED is a deliberate user action — freeze immediately so the
        // last frame stays visible until they press play again.
        cancelVisualizerAnimation();
        _holdNextPauseFrame = false;
        _isHoldingPauseFrame = true;
      } else if (playback.activity === 'paused') {
        fadeVisualizerOut();
      } else if (playback.activity === 'playing') {
        // Cancel any pending settle from a previous pause/idle pass.
        _holdNextPauseFrame = false;
        _isHoldingPauseFrame = false;
        // Only spin up the rAF loop when there's actually audio to visualize.
        // Previously this branch fired for IDLE too — wasting frames during
        // landing/setup since the analyser had nothing to report.
        startVisualizer();
      } else {
        // IDLE / unknown: quickly settle into the resting frame.
        fadeVisualizerOut();
      }
    },
    { immediate: true },
  );

  // Listen for visualizer start command from playback
  _busScope.on('visualizer:start', () => {
    startVisualizer();
  });

  _busScope.on('visualizer:hold-frame', () => {
    _holdNextPauseFrame = true;
  });

  _busScope.on('visualizer:fade-out', () => {
    fadeVisualizerOut();
  });

  // Visualizer mode switch
  _busScope.on('visualizer:set-type', (mode: 'circular' | 'spectrum') => {
    applyVisualizerMode(mode);

    cancelVisualizerAnimation();

    const analyser = getAnalyser();
    if (analyser) {
      analyser.smoothingTimeConstant = mode === 'spectrum' ? 0.8 : 0.3;
    }

    drawRestingVisualizerFrame();
    startVisualizer();
  });

  log.info('[Visualizer] Initialized');
}
