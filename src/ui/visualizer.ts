/**
 * MUSIXQUARE — Canvas FFT Visualizer
 *
 * Manages: Bass/High frequency circle visualizer with light/dark theme.
 */

import { log } from '../core/log.ts';
import { createBusScope } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { APP_STATE } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { getAnalyser as getEngineAnalyser } from '../audio/engine.ts';

// ─── State ───────────────────────────────────────────────────────

let _animationId: number | null = null;
let _visualizerRetryCount = 0;
const MAX_VISUALIZER_RETRIES = 20;
let _resizeListenerAdded = false;
let _vizMode: 'circular' | 'spectrum' = 'circular';

// ─── Spectrum constants ─────────────────────────────────────────
const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const MIN_DB = -100;
const MAX_DB = 0;
const SLOPE_DB_PER_OCTAVE = 4.5;
const SLOPE_REF_FREQ = 1000;
const LOG_GAMMA = 1.3; // compress low frequencies on log scale

// ─── Smoothing coefficients (0 = instant, 1 = frozen) ───
const BASS_SMOOTH = 0.8;
const HIGH_SMOOTH = 0.8;

// ─── (Frame throttle removed — runs at display's native refresh rate) ───

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
    _themeObserver = new MutationObserver(refreshThemeCache);
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

// ─── Silence-aware fade-out stop ────────────────────────────────

// On IDLE the rAF loop keeps running until the analyser has been
// near-silent for a sustained window. This handles long reverb tails
// (settings.default_5s and beyond) cleanly — the visual stops when
// the audio actually stops, not after an arbitrary timer.
// Follow the audio all the way down. -100 dB is the analyser's float
// floor — frequency data only stays at -100 when the source is truly
// silent (or disconnected), so anything brushing above it is still
// audible to careful listeners and the visualizer should keep tracking
// it. 1000ms sustained absorbs brief gaps in long reverb washes;
// 30s cap is a safety net for stuck/disconnected analysers.
const VIZ_SILENCE_THRESHOLD_DB = -100;
const VIZ_SILENCE_SUSTAINED_MS = 1000;
const VIZ_SILENCE_MAX_CAP_MS = 30_000;
const VIZ_SILENCE_POLL_MS = 100;
let _silenceFirstSeenAt = 0;

function stopVisualizerAndClear(): void {
  if (_animationId) {
    cancelAnimationFrame(_animationId);
    _animationId = null;
  }
  clearManagedTimer('viz-silence-poll');
  _silenceFirstSeenAt = 0;
  // Intentionally NO clearRect: the silence-poll only stops once the
  // analyser has been near-silent for 500ms, so the last drawn frame
  // is already a tiny "idle" shape. clearing the canvas would leave a
  // black void where the visualizer used to be — users read that as
  // "the visualizer broke / disappeared". Leaving the residual silent
  // frame keeps an idle visual on screen until playback resumes.
  //
  // Edge case: 30s hard-cap path with a disconnected analyser leaves
  // whatever loud frame was last drawn frozen. That's still better
  // than a black void, and the next playback will overwrite it.
}

function scheduleVisualizerSilenceStop(): void {
  _silenceFirstSeenAt = 0;
  const pollStart = performance.now();
  const poll = (): void => {
    // User resumed playback in the meantime — startVisualizer cleared
    // the timer already, but be defensive.
    if (!_animationId) return;

    const analyser = getEngineAnalyser();
    if (!analyser) {
      stopVisualizerAndClear();
      return;
    }

    const data = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(data);
    let max = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v > max) max = v;
    }
    const isSilent = !isFinite(max) || max < VIZ_SILENCE_THRESHOLD_DB;
    const now = performance.now();

    if (isSilent) {
      if (!_silenceFirstSeenAt) _silenceFirstSeenAt = now;
      if (now - _silenceFirstSeenAt >= VIZ_SILENCE_SUSTAINED_MS) {
        stopVisualizerAndClear();
        return;
      }
    } else {
      _silenceFirstSeenAt = 0;
    }

    if (now - pollStart >= VIZ_SILENCE_MAX_CAP_MS) {
      stopVisualizerAndClear();
      return;
    }

    setManagedTimer('viz-silence-poll', poll, VIZ_SILENCE_POLL_MS);
  };
  setManagedTimer('viz-silence-poll', poll, VIZ_SILENCE_POLL_MS);
}

// ─── Start Active Visualizer ─────────────────────────────────────

export function startVisualizer(): void {
  if (_vizMode === 'spectrum') {
    startSpectrumVisualizer();
    return;
  }

  clearManagedTimer('viz-retry');
  if (_animationId) {
    cancelAnimationFrame(_animationId);
    _animationId = null;
  }

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
      return;
    }
    setManagedTimer('viz-retry', startVisualizer, 100);
    return;
  }
  _visualizerRetryCount = 0;

  const bufferLength = analyser.frequencyBinCount;
  const _freqData = new Float32Array(bufferLength);

  let smoothedBass = 0;
  let smoothedHigh = 0;

  // Initial Sync
  const wrapper = document.querySelector('.vinyl-wrapper') as HTMLElement | null;
  let logicalSize = syncCanvasSize(canvas, ctx, wrapper);

  // Pre-compute constants outside draw loop
  let scale = logicalSize / 240;
  const twoPi = 2 * Math.PI;
  const highStart = Math.floor(bufferLength * 0.7);
  const highEnd = bufferLength;
  let highCountVal = highEnd - highStart;
  if (highCountVal < 1) highCountVal = 1;
  let bassCount = 12;
  if (bassCount > bufferLength) bassCount = bufferLength;

  // Cache theme on start
  refreshThemeCache();

  function draw(): void {
    const currentState = getState('appState');
    // YouTube mode: analyser isn't connected or canvas is CSS-hidden, skip draw
    if (currentState === APP_STATE.PLAYING_YOUTUBE) {
      _animationId = null;
      return;
    }

    // Self-correct after resize — avoids stale dimensions during the 100ms
    // gap between resize event and startVisualizer() re-init.
    const curSize = canvas!.width / (window.devicePixelRatio || 1);
    if (curSize !== logicalSize) {
      logicalSize = curSize;
      scale = logicalSize / 240;
    }

    try {
      analyser!.getFloatFrequencyData(_freqData);
      const dbData = _freqData;

      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, logicalSize, logicalSize);

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

      const centerX = logicalSize / 2;
      const centerY = logicalSize / 2;

      ctx.shadowBlur = 0;

      // Circle 1: Bass
      ctx.globalCompositeOperation = 'source-over';
      const bassRadius = (55 + bassPunch * 200) * scale;
      const bassOpacity = Math.min(0.75, 0.25 + bassPunchOpacity * 0.75);
      ctx.fillStyle = _cachedIsLight
        ? `rgba(66, 129, 241, ${bassOpacity})`
        : `hsla(218, 86%, 60%, ${bassOpacity})`;
      ctx.beginPath();
      ctx.arc(centerX, centerY, bassRadius, 0, twoPi);
      ctx.fill();

      // Circle 2: High
      const highRadius = (40 + highPunch * 130) * scale;
      ctx.fillStyle = _cachedIsLight ? 'rgba(66, 129, 241, 1.0)' : 'hsla(218, 86%, 60%, 1.0)';
      ctx.beginPath();
      ctx.arc(centerX, centerY, highRadius, 0, twoPi);
      ctx.fill();

      _animationId = requestAnimationFrame(draw);
    } catch (e) {
      log.warn('[Visualizer] draw() error — stopping animation loop:', e);
      _animationId = null;
    }
  }

  draw();
}

// ─── Spectrum Helpers ────────────────────────────────────────────

function freqToX(freq: number, w: number, padX: number): number {
  const logMin = Math.log10(MIN_FREQ);
  const logMax = Math.log10(MAX_FREQ);
  const norm = (Math.log10(freq) - logMin) / (logMax - logMin);
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

function drawSpectrumGrid(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  padX: number,
  padY: number,
  isLight: boolean,
): void {
  const gridFreqs = [100, 1000, 10000];
  const alpha = isLight ? 0.06 : 0.06;
  ctx.lineWidth = 1;
  for (const f of gridFreqs) {
    const x = freqToX(f, w, padX);
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
  if (_animationId) {
    cancelAnimationFrame(_animationId);
    _animationId = null;
  }

  const canvas = document.getElementById('visualizerCanvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const _ctx = canvas.getContext('2d');
  if (!_ctx) return;
  const ctx: CanvasRenderingContext2D = _ctx;

  const analyser = getAnalyser();
  if (!analyser) {
    if (++_visualizerRetryCount > MAX_VISUALIZER_RETRIES) {
      _visualizerRetryCount = 0;
      return;
    }
    setManagedTimer('viz-retry', startVisualizer, 100);
    return;
  }
  _visualizerRetryCount = 0;

  analyser.smoothingTimeConstant = 0.8;
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

  function draw(): void {
    const currentState = getState('appState');
    if (currentState === APP_STATE.PLAYING_YOUTUBE) {
      _animationId = null;
      return;
    }

    // Self-correct after resize
    const curW = canvas!.width / (window.devicePixelRatio || 1);
    const curH = canvas!.height / (window.devicePixelRatio || 1);
    if (curW !== logicalW || curH !== logicalH) {
      logicalW = curW;
      logicalH = curH;
    }

    try {
      analyser!.getFloatFrequencyData(freqData);
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, logicalW, logicalH);
      drawSpectrumGrid(ctx, logicalW, logicalH, padX, padY, _cachedIsLight);

      const points: { x: number; y: number }[] = [];
      for (let i = 1; i < bufferLength; i += Math.max(1, Math.floor(i / 64))) {
        const freq = (i * sampleRate) / (bufferLength * 2);
        if (freq < MIN_FREQ) continue;
        if (freq > MAX_FREQ) break;
        const x = freqToX(freq, logicalW, padX);
        const y = dbToY(freqData[i] + slopeCompensation(freq), logicalH, padY);
        points.push({ x, y });
      }

      if (points.length >= 2) {
        ctx.globalCompositeOperation = _cachedIsLight ? 'source-over' : 'lighter';
        const grad = ctx.createLinearGradient(0, padY, 0, logicalH - padY);
        grad.addColorStop(
          0,
          _cachedIsLight ? 'rgba(59, 130, 246, 0.15)' : 'rgba(59, 130, 246, 0.12)',
        );
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
      _animationId = requestAnimationFrame(draw);
    } catch (e) {
      log.warn('[Visualizer] spectrum draw() error:', e);
      _animationId = null;
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

  // Always use startVisualizer — it retries if analyser isn't ready yet,
  // and renders silence naturally as idle circles when no audio plays.
  startVisualizer();

  if (!_resizeListenerAdded) {
    _resizeListenerAdded = true;

    const handleResize = () => {
      // For responsiveness, we can sync size immediately and THEN throttle the expensive draw
      const canvas = document.getElementById('visualizerCanvas') as HTMLCanvasElement | null;
      const ctx = canvas?.getContext('2d');
      const wrapper = document.querySelector('.vinyl-wrapper') as HTMLElement | null;
      if (canvas && ctx && wrapper) {
        syncCanvasSize(canvas, ctx, wrapper);
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

    // Orientation change: CSS transitions need time to settle before re-measuring
    const vizOrientationMql = window.matchMedia('(orientation: landscape)');
    vizOrientationMql.addEventListener('change', () => {
      handleResize();
      setManagedTimer('viz-orientation-resize', handleResize, 350);
    });
  }

  // Listen for check events from tab switch
  _busScope.on('ui:visualizer-check', () => {
    const currentState = getState('appState');
    if (currentState === APP_STATE.PAUSED) {
      // Keep last frame
    } else if (!_animationId) {
      startVisualizer();
    }
  });

  // Listen for playback state changes
  _busScope.on('state:appState', () => {
    const currentState = getState('appState');
    if (currentState === APP_STATE.PAUSED) {
      // PAUSED is a deliberate user action — freeze immediately so the
      // last frame stays visible until they press play again.
      if (_animationId) {
        cancelAnimationFrame(_animationId);
        _animationId = null;
      }
    } else if (
      currentState === APP_STATE.PLAYING_AUDIO ||
      currentState === APP_STATE.PLAYING_YOUTUBE ||
      currentState === APP_STATE.PLAYING_SYSTEM_AUDIO
    ) {
      // Cancel any pending silence-stop poll from a previous IDLE pass
      // — we're playing again, the loop should keep running.
      clearManagedTimer('viz-silence-poll');
      _silenceFirstSeenAt = 0;
      // Only spin up the rAF loop when there's actually audio to visualize.
      // Previously this branch fired for IDLE too — wasting frames during
      // landing/setup since the analyser had nothing to report.
      startVisualizer();
    } else if (_animationId) {
      // IDLE / unknown — keep the rAF loop running until the analyser
      // actually goes silent, then stop. A fixed 800ms timeout was the
      // first try, but reverb tails can ring out for 10+ seconds and
      // cutting the visual at 800ms while audio keeps playing looks
      // worse than the original stuck-frame bug. Poll the analyser
      // and only stop once the spectrum has been near-silent for a
      // sustained window. Hard 30s cap as a safety net (analyser
      // can stay non-zero forever if the source was disconnected
      // without the data buffer being cleared).
      scheduleVisualizerSilenceStop();
    }
  });

  // Listen for visualizer start command from playback
  _busScope.on('visualizer:start', () => {
    startVisualizer();
  });

  // Visualizer mode switch
  _busScope.on('visualizer:set-type', (mode: 'circular' | 'spectrum') => {
    _vizMode = mode;
    document.body.classList.toggle('viz-spectrum', mode === 'spectrum');
    document.body.classList.toggle('viz-circular', mode === 'circular');

    if (_animationId) {
      cancelAnimationFrame(_animationId);
      _animationId = null;
    }

    const analyser = getAnalyser();
    if (analyser) {
      analyser.smoothingTimeConstant = mode === 'spectrum' ? 0.8 : 0.3;
    }

    startVisualizer();
  });

  log.info('[Visualizer] Initialized');
}
