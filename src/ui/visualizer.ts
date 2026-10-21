/**
 * MUSIXQUARE — Canvas FFT Visualizer
 *
 * Manages: Bass/High frequency circle visualizer with light/dark theme.
 */

import { log } from '../core/log.ts';
import { bus, createBusScope } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { getAnalyser } from '../audio/engine.ts';
import {
  bassBinCount,
  averageBassLevel,
  averageFrequencyLevel,
  bassPunch as toBassPunch,
} from '../audio/bass-level.ts';
import { createSpectrumReader } from '../audio/visualizer-analysis.ts';
import { watchVisualizerVisibility } from './visualizer-visibility.ts';
import { drawSpectrumGrid, drawSpectrumRestingLine, dbToY } from './visualizer-spectrum-static.ts';
import type { SpectrumPoint } from './visualizer-spectrum.ts';
import { scopePlaybackModeActivity } from './_state-hooks.ts';
import { isPlaybackModeYouTube, isPlaybackPaused, isPlaybackPlaying } from '../player/ownership.ts';
import { t, type I18nKey } from '../i18n/index.ts';

// ─── State ───────────────────────────────────────────────────────

let _animationId: number | null = null;
let _visualizerRetryCount = 0;
const MAX_VISUALIZER_RETRIES = 20;
let _resizeListenerAdded = false;
let _visualizerResizeObserver: ResizeObserver | null = null;
type VisualizerMode = 'circular' | 'spectrum';
let _vizMode: VisualizerMode = 'circular';
let _appVizMode: VisualizerMode | null = null;
let _visualizerControlCanvas: HTMLCanvasElement | null = null;
let _isVisualizerStartCoalescing = false;
let _visualizerLoopState: 'idle' | 'active' | 'settling' | 'suspended' = 'idle';
let _canvasPixelRatio = 1;

let _visibility: ReturnType<typeof watchVisualizerVisibility> | null = null;
let _resumeFrame: FrameRequestCallback | null = null;
let _spectrumRenderer: typeof import('./visualizer-spectrum.ts') | null = null;
let _spectrumLoad: Promise<void> | null = null;
let _spectrumLoadFailed = false;
let _spectrumLoadError: unknown;
let _spectrumRequestedRun: number | null = null;

function requestSpectrumRenderer(): void {
  if (_spectrumRenderer) return;
  if (_spectrumLoadFailed) {
    bus.emit('app:lazy-feature-load-failed', 'visualizer-spectrum', _spectrumLoadError);
    return;
  }
  _spectrumLoad ??= import('./visualizer-spectrum.ts')
    .then((renderer) => {
      _spectrumRenderer = renderer;
      // Loading never owns playback. Resolve the current source and all gates
      // again, only for a start request that has not since been cancelled.
      if (_spectrumRequestedRun === _visualizerRunToken && _vizMode === 'spectrum') {
        startVisualizer();
      }
    })
    .catch((error: unknown) => {
      // A failed ESM evaluation can remain cached until this document reloads.
      _spectrumLoadFailed = true;
      _spectrumLoadError = error;
      if (_vizMode === 'spectrum') {
        bus.emit('app:lazy-feature-load-failed', 'visualizer-spectrum', error);
      }
    });
}

function readPersistedVisualizerMode(): VisualizerMode {
  try {
    return localStorage.getItem('musixquare-viz-mode') === 'spectrum' ? 'spectrum' : 'circular';
  } catch {
    return 'circular';
  }
}

function syncVisualizerControlAccessibility(mode: VisualizerMode): void {
  const canvas = document.getElementById('visualizerCanvas');
  const demo = isDemoVisualizerPresentation();
  canvas?.setAttribute('role', demo ? 'img' : 'button');
  canvas?.setAttribute('tabindex', demo ? '-1' : '0');
  if (demo) {
    canvas?.removeAttribute('aria-pressed');
    canvas?.removeAttribute('aria-describedby');
  } else {
    canvas?.setAttribute('aria-pressed', String(mode === 'spectrum'));
    canvas?.setAttribute('aria-describedby', 'visualizer-mode-hint');
  }
  canvas?.setAttribute('data-visualizer-mode', mode);

  const modeLabel = document.getElementById('visualizer-current-mode');
  if (!modeLabel) return;
  const modeKey: I18nKey =
    mode === 'spectrum' ? 'player.visualizer_spectrum' : 'player.visualizer_circular';
  modeLabel.setAttribute('data-i18n', modeKey);
  modeLabel.textContent = t(modeKey);
}

function applyVisualizerMode(mode: VisualizerMode): void {
  _vizMode = mode;
  document.body.classList.toggle('viz-spectrum', mode === 'spectrum');
  document.body.classList.toggle('viz-circular', mode === 'circular');
  syncVisualizerControlAccessibility(mode);
  if (mode === 'spectrum') requestSpectrumRenderer();
}

function persistVisualizerMode(mode: VisualizerMode): void {
  try {
    localStorage.setItem('musixquare-viz-mode', mode);
  } catch {
    /* Safari private mode */
  }
}

function setVisualizerMode(mode: VisualizerMode, persist: boolean): void {
  applyVisualizerMode(mode);
  if (persist) persistVisualizerMode(mode);

  cancelVisualizerAnimation();

  drawRestingVisualizerFrame();
  startVisualizer();
}

function isDemoVisualizerPresentation(): boolean {
  // The demo still owns the canvas while its exit curtain is covering it.
  return getState('demo.active') || document.body.classList.contains('demo-mobile');
}

function refreshVisualizerPresentation(): void {
  setVisualizerMode(
    isDemoVisualizerPresentation() ? 'spectrum' : (_appVizMode ?? 'circular'),
    false,
  );
}

function toggleVisualizerMode(): void {
  if (isDemoVisualizerPresentation()) return;
  _appVizMode = _vizMode === 'circular' ? 'spectrum' : 'circular';
  setVisualizerMode(_appVizMode, true);
}

function handleVisualizerControlKeydown(event: KeyboardEvent): void {
  if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  toggleVisualizerMode();
}

function bindVisualizerModeControl(): void {
  const canvas = document.getElementById('visualizerCanvas') as HTMLCanvasElement | null;
  if (_visualizerControlCanvas === canvas) return;

  _visualizerControlCanvas?.removeEventListener('click', toggleVisualizerMode);
  _visualizerControlCanvas?.removeEventListener('keydown', handleVisualizerControlKeydown);
  _visualizerControlCanvas = canvas;
  canvas?.addEventListener('click', toggleVisualizerMode);
  canvas?.addEventListener('keydown', handleVisualizerControlKeydown);
}

const MIN_DB = -100;

// ─── Smoothing coefficients (0 = instant, 1 = frozen) ───
const CIRCULAR_SMOOTH = 0.8;
const VIZ_SETTLE_MS = 180;
const SPECTRUM_START_WARMUP_MS = 1000 / 30;

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
  const renderedRect = wrapper?.getBoundingClientRect();
  const renderedScaleX = rawW > 0 && renderedRect ? renderedRect.width / rawW : 1;
  const renderedScaleY = rawH > 0 && renderedRect ? renderedRect.height / rawH : 1;
  const renderedScale = Math.max(1, renderedScaleX, renderedScaleY);
  // `devicePixelRatio` alone does not account for the desktop density
  // transform. Rasterize at the final on-screen scale so a logical 604px
  // canvas displayed at 1.5x receives roughly 906px of backing resolution.
  // Cap pathological combinations to keep memory/GPU cost bounded.
  const pixelRatio = Math.min(3, Math.max(1, (window.devicePixelRatio || 1) * renderedScale));
  _canvasPixelRatio = pixelRatio;

  // For circular mode, we want a square fit
  if (_vizMode === 'circular') {
    const rawSize = Math.min(rawW, rawH);
    const logicalSize = rawSize > 10 ? rawSize : 240;
    const targetSize = Math.max(1, Math.round(logicalSize * pixelRatio));

    if (canvas.width !== targetSize || canvas.height !== targetSize) {
      canvas.width = targetSize;
      canvas.height = targetSize;
    }
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    return logicalSize;
  } else {
    // For spectrum mode, we use the full rectangular container
    const logicalW = rawW > 10 ? rawW : 400;
    const logicalH = rawH > 10 ? rawH : 240;
    const targetW = Math.max(1, Math.round(logicalW * pixelRatio));
    const targetH = Math.max(1, Math.round(logicalH * pixelRatio));

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
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
  _resumeFrame = null;
  _spectrumRequestedRun = null;
}

function suspendVisualizer(): void {
  if (_visualizerLoopState !== 'active') return;
  if (_animationId !== null) cancelAnimationFrame(_animationId);
  _animationId = null;
  _visualizerLoopState = 'suspended';
}

function queueActiveFrame(draw: FrameRequestCallback): void {
  _resumeFrame = draw;
  _animationId = requestAnimationFrame(draw);
}

function reconcileVisualizerVisibility(): void {
  if (_visibility?.reduced) {
    cancelVisualizerAnimation();
    if (_isHoldingPauseFrame) redrawHeldFrame();
    else drawRestingVisualizerFrame();
  } else if (_visibility && !_visibility.visible) {
    if (_visualizerLoopState === 'settling') {
      cancelVisualizerAnimation();
      drawRestingVisualizerFrame();
    } else suspendVisualizer();
  } else startVisualizer();
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

  const maxRadius = Math.max(0, logicalSize / 2 - 0.5);
  const bassRadius = Math.min(maxRadius, (55 + frame.bassPunch * 200) * scale);
  ctx.fillStyle = _cachedIsLight
    ? `rgba(66, 129, 241, ${frame.bassOpacity})`
    : `hsla(218, 86%, 60%, ${frame.bassOpacity})`;
  ctx.beginPath();
  ctx.arc(centerX, centerY, bassRadius, 0, twoPi);
  ctx.fill();

  const highRadius = Math.min(maxRadius, (40 + frame.highPunch * 130) * scale);
  ctx.fillStyle = _cachedIsLight ? 'rgba(66, 129, 241, 1.0)' : 'hsla(218, 86%, 60%, 1.0)';
  ctx.beginPath();
  ctx.arc(centerX, centerY, highRadius, 0, twoPi);
  ctx.fill();
}

function drawRestingVisualizerFrame(): void {
  const canvas = document.getElementById('visualizerCanvas') as HTMLCanvasElement | null;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;

  refreshThemeCache();
  const wrapper = document.querySelector('.vinyl-wrapper') as HTMLElement | null;
  syncCanvasSize(canvas, ctx, wrapper);
  const logicalW = canvas.width / _canvasPixelRatio;
  const logicalH = canvas.height / _canvasPixelRatio;

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
  const logicalW = canvas.width / _canvasPixelRatio;
  const logicalH = canvas.height / _canvasPixelRatio;

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
    _spectrumRenderer!.drawSpectrumCurve(ctx, points, logicalH, padX, padY, _cachedIsLight);
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
  if (_visibility?.reduced || (_visibility && !_visibility.visible)) {
    drawRestingVisualizerFrame();
    return;
  }
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
  const logicalW = canvas.width / _canvasPixelRatio;
  const logicalH = canvas.height / _canvasPixelRatio;

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
      _spectrumRenderer!.drawSpectrumCurve(ctx, points, logicalH, padX, padY, _cachedIsLight);
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
  _visibility?.refresh();
  if (isPlaybackModeYouTube()) {
    cancelVisualizerAnimation();
    return;
  }
  if (_visibility?.reduced) {
    cancelVisualizerAnimation();
    if (_isHoldingPauseFrame) redrawHeldFrame();
    else drawRestingVisualizerFrame();
    return;
  }
  if (_visibility && !_visibility.visible) {
    suspendVisualizer();
    return;
  }
  if (_visualizerLoopState === 'suspended' && _resumeFrame && isPlaybackPlaying()) {
    _visualizerLoopState = 'active';
    queueActiveFrame(_resumeFrame);
    return;
  }
  if (_visualizerLoopState === 'active' && _animationId !== null) return;

  // Activity gate — the single chokepoint for every entry point (resize,
  // ui:visualizer-check, presentation refresh, visualizer:start, init/retry chain).
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
    if (!_spectrumRenderer) {
      _spectrumRequestedRun = _visualizerRunToken;
      drawRestingVisualizerFrame();
      requestSpectrumRenderer();
      return;
    }
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
      log.warn('[Visualizer] Analyser unavailable:', MAX_VISUALIZER_RETRIES);
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
  const reader = createSpectrumReader(0.3);
  let previousDraw: number | null = null;

  let smoothedBass = 0;
  let smoothedHigh = 0;

  // Initial Sync
  const wrapper = document.querySelector('.vinyl-wrapper') as HTMLElement | null;
  let logicalSize = syncCanvasSize(canvas, ctx, wrapper);

  // Pre-compute constants outside draw loop
  const sampleRate = analyser.context.sampleRate;
  const bassCount = bassBinCount(sampleRate, bufferLength * 2);

  // Cache theme on start
  refreshThemeCache();

  function draw(now = performance.now()): void {
    if (runToken !== _visualizerRunToken) return;

    // YouTube mode: analyser isn't connected or canvas is CSS-hidden, skip draw
    if (isPlaybackModeYouTube()) {
      _animationId = null;
      _visualizerLoopState = 'idle';
      return;
    }

    // Self-correct after resize — avoids stale dimensions during the 100ms
    // gap between resize event and startVisualizer() re-init.
    const curSize = canvas!.width / _canvasPixelRatio;
    if (curSize !== logicalSize) {
      logicalSize = curSize;
    }

    try {
      const dbData = reader.read(analyser!, now);
      const elapsed =
        previousDraw === null ? 1000 / 60 : Math.min(100, Math.max(0, now - previousDraw));
      previousDraw = now;
      const smooth = Math.pow(CIRCULAR_SMOOTH, elapsed / (1000 / 60));

      // Bass: lowest analyser bins, shared with the screensaver glow.
      const bassAverage = averageBassLevel(dbData, bassCount);

      smoothedBass = smoothedBass * smooth + bassAverage * (1 - smooth);
      const bassPunch = toBassPunch(smoothedBass);
      const bassPunchOpacity = Math.pow(smoothedBass / 255, 1.5);

      const highAverage = averageFrequencyLevel(dbData, sampleRate, 7500, 20000);
      smoothedHigh = smoothedHigh * smooth + highAverage * (1 - smooth);
      let highPunch = smoothedHigh / 255;
      if (!isFinite(highPunch)) highPunch = 0;

      const bassOpacity = Math.min(0.75, 0.25 + bassPunchOpacity * 0.75);
      const frame = { bassPunch, bassOpacity, highPunch };
      drawCircularVisualizerFrame(ctx, logicalSize, frame);
      _lastCircularFrame = frame;
      _lastSpectrumFrame = null;

      queueActiveFrame(draw);
    } catch (e) {
      log.warn('[Visualizer] draw error:', e);
      _animationId = null;
      _visualizerLoopState = 'idle';
    }
  }

  draw();
}

// ─── Spectrum Active Drawing ────────────────────────────────────

function startSpectrumVisualizer(): void {
  const { createSpectrumBinLayout, updateSpectrumPoints, drawSpectrumCurve } = _spectrumRenderer!;
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

  const reader = createSpectrumReader(0.8);
  const bufferLength = analyser.frequencyBinCount;
  const sampleRate = analyser.context.sampleRate;

  // Sync size
  const wrapper = document.querySelector('.vinyl-wrapper') as HTMLElement | null;
  syncCanvasSize(canvas, ctx, wrapper);
  let logicalW = canvas.width / _canvasPixelRatio;
  let logicalH = canvas.height / _canvasPixelRatio;

  const padX = 4;
  const padY = 8;
  refreshThemeCache();
  const warmupUntil = performance.now() + SPECTRUM_START_WARMUP_MS;
  let warmingUp = true;
  let binLayout = createSpectrumBinLayout(bufferLength, sampleRate, logicalW, padX);
  const points: SpectrumPoint[] = [];

  function draw(now = performance.now()): void {
    if (runToken !== _visualizerRunToken) return;

    if (isPlaybackModeYouTube()) {
      _animationId = null;
      _visualizerLoopState = 'idle';
      return;
    }

    // Self-correct after resize
    const curW = canvas!.width / _canvasPixelRatio;
    const curH = canvas!.height / _canvasPixelRatio;
    if (curW !== logicalW || curH !== logicalH) {
      logicalW = curW;
      logicalH = curH;
      if (curW !== binLayout.logicalW) {
        binLayout = createSpectrumBinLayout(bufferLength, sampleRate, logicalW, padX);
      }
    }

    try {
      // Startup samples can contain the previous source. Do not carry their
      // smoothing history into the first visible curve, including at 120 Hz.
      if (warmingUp) reader.reset();
      const freqData = reader.read(analyser!, now);
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, logicalW, logicalH);
      drawSpectrumGrid(ctx, logicalW, logicalH, padX, padY, _cachedIsLight, binLayout.gridXValues);

      if (now < warmupUntil) {
        drawSpectrumRestingLine(ctx, logicalW, logicalH, padX, padY);
        clearLastVisualizerFrames();
        queueActiveFrame(draw);
        return;
      }
      warmingUp = false;

      updateSpectrumPoints(points, freqData, binLayout, logicalH, padY);

      if (points.length >= 2) {
        drawSpectrumCurve(ctx, points, logicalH, padX, padY, _cachedIsLight);
        _lastSpectrumFrame = {
          points,
          width: logicalW,
          height: logicalH,
          padX,
          padY,
        };
        _lastCircularFrame = null;
      } else {
        _lastSpectrumFrame = null;
      }
      queueActiveFrame(draw);
    } catch (e) {
      log.warn('[Visualizer] draw error:', e);
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
  _visibility?.dispose();
  _visibility = watchVisualizerVisibility(
    document.querySelector('.vinyl-wrapper'),
    reconcileVisualizerVisibility,
  );

  refreshThemeCache();
  _initThemeListeners();
  _appVizMode ??= readPersistedVisualizerMode();
  applyVisualizerMode(isDemoVisualizerPresentation() ? 'spectrum' : _appVizMode);
  bindVisualizerModeControl();

  // Always use startVisualizer — it retries if analyser isn't ready yet,
  // and renders silence naturally as idle circles when no audio plays.
  startVisualizer();

  if (!_resizeListenerAdded) {
    _resizeListenerAdded = true;

    const handleResize = () => {
      const canvas = document.getElementById('visualizerCanvas') as HTMLCanvasElement | null;
      const ctx = canvas?.getContext('2d');
      const wrapper = document.querySelector('.vinyl-wrapper') as HTMLElement | null;
      _visibility?.refresh();
      // A hidden wrapper has no authoritative size. Keep the frame and loop
      // closure so returning to the same size does not replay startup warmup.
      if (wrapper && (wrapper.clientWidth < 10 || wrapper.clientHeight < 10)) return;
      if (canvas && ctx && wrapper) {
        const previousWidth = canvas.width;
        const previousHeight = canvas.height;
        const previousPixelRatio = _canvasPixelRatio;
        syncCanvasSize(canvas, ctx, wrapper);
        // Demo steps and other layout updates also dispatch resize without
        // changing this canvas. Keep their live analyser history and drawing
        // loop instead of replaying the fresh-start spectrum warmup at zero.
        if (
          (_visualizerLoopState === 'active' || _visualizerLoopState === 'suspended') &&
          wrapper.clientWidth > 10 &&
          wrapper.clientHeight > 10 &&
          canvas.width === previousWidth &&
          canvas.height === previousHeight &&
          _canvasPixelRatio === previousPixelRatio
        )
          return;
      }

      // Browser zoom can change the viewport, DPR and wrapper geometry in
      // separate steps. Cancel the old loop within this same callback before
      // another frame can draw with the previous coordinate system and leave
      // clipped arcs at the new canvas edges. Static/held frames still repaint.
      const wasHoldingPauseFrame = _isHoldingPauseFrame;
      cancelVisualizerAnimation();

      if (canvas && ctx && wrapper) {
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

  _busScope.on('audio:ready', () => {
    cancelVisualizerAnimation();
    startVisualizer();
  });

  _busScope.on('visualizer:hold-frame', () => {
    _holdNextPauseFrame = true;
  });

  _busScope.on('visualizer:fade-out', () => {
    fadeVisualizerOut();
  });

  // Demo presentation never changes the remembered app preference. Its DOM
  // exit signal also covers exits that deliberately skip media restoration.
  _busScope.on('state:demo.active', refreshVisualizerPresentation);
  _busScope.on('visualizer:refresh-presentation', refreshVisualizerPresentation);
}
