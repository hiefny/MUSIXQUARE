/**
 * MUSIXQUARE 2.0 — Canvas FFT Visualizer
 * Extracted from original app.js lines 5712-5918
 *
 * Manages: Bass/High frequency circle visualizer with light/dark theme.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { isIdleOrPaused } from '../player/video.ts';

// ─── State ───────────────────────────────────────────────────────

let _animationId: number | null = null;
let _visualizerRetryCount = 0;
const MAX_VISUALIZER_RETRIES = 120;
let _vizResizeTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Helpers ─────────────────────────────────────────────────────

function getAnalyser(): unknown {
  return getState<unknown>('audio.analyser');
}

// ─── Start Active Visualizer ─────────────────────────────────────

export function startVisualizer(): void {
  if (_animationId) {
    cancelAnimationFrame(_animationId);
    _animationId = null;
  }

  const canvas = document.getElementById('visualizerCanvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const _ctx = canvas.getContext('2d');
  if (!_ctx) return;
  const ctx: CanvasRenderingContext2D = _ctx;

  const analyser = getAnalyser() as Record<string, unknown> | null;

  if (!analyser) {
    if (++_visualizerRetryCount > MAX_VISUALIZER_RETRIES) {
      log.warn('[Visualizer] Gave up waiting for analyser after', MAX_VISUALIZER_RETRIES, 'frames');
      _visualizerRetryCount = 0;
      return;
    }
    _animationId = requestAnimationFrame(startVisualizer);
    return;
  }
  _visualizerRetryCount = 0;

  // Check type: Tone.js analyser has .getValue(), native has .getByteFrequencyData()
  const isToneAnalyser = typeof (analyser as Record<string, unknown>).getValue === 'function';
  const bufferLength = isToneAnalyser
    ? ((analyser as Record<string, number>).size || 1024)
    : (analyser as unknown as AnalyserNode).frequencyBinCount;

  let smoothedBass = 0;

  // Canvas scale (High DPI)
  const wrapper = document.querySelector('.vinyl-wrapper');
  const logicalSize = (wrapper && (wrapper as HTMLElement).clientWidth > 10)
    ? (wrapper as HTMLElement).clientWidth : 240;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== logicalSize * dpr || canvas.height !== logicalSize * dpr) {
    canvas.width = logicalSize * dpr;
    canvas.height = logicalSize * dpr;
    canvas.style.width = '';
    canvas.style.height = '';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  }

  function draw(): void {
    const currentState = getState<string>('appState');
    if (isIdleOrPaused(currentState)) { _animationId = null; return; }
    if (!isToneAnalyser) { _animationId = null; return; }
    _animationId = requestAnimationFrame(draw);

    const dbData = (analyser as Record<string, (...args: unknown[]) => Float32Array>).getValue() as Float32Array;

    const theme = document.documentElement.getAttribute('data-theme');
    const isLight = (theme === 'light');

    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, logicalSize, logicalSize);

    // Bass: 0~260Hz (12 bins)
    let bassSum = 0;
    let bassCount = 12;
    if (bassCount > bufferLength) bassCount = bufferLength;
    for (let i = 0; i < bassCount; i++) {
      let val = (dbData[i] + 100) * 2.5;
      if (val < 0) val = 0;
      if (val > 255) val = 255;
      bassSum += val;
    }
    const bassAverage = bassSum / bassCount;

    smoothedBass = smoothedBass * 0.8 + bassAverage * 0.2;
    const bassPunch = Math.pow(smoothedBass / 255, 2.5);

    // High: 7.5kHz~20kHz (0.7~1.0 of buffer)
    let highSum = 0;
    const highStart = Math.floor(bufferLength * 0.7);
    const highEnd = bufferLength;
    let highCountVal = highEnd - highStart;
    if (highCountVal < 1) highCountVal = 1;

    for (let i = highStart; i < highEnd; i++) {
      let val = (dbData[i] + 100) * 2.5;
      if (val < 0) val = 0;
      if (val > 255) val = 255;
      highSum += val;
    }
    const highAverage = highSum / highCountVal;
    const highPunch = highAverage / 255;

    ctx.globalCompositeOperation = isLight ? 'source-over' : 'lighter';
    ctx.shadowBlur = 0;

    const centerX = logicalSize / 2;
    const centerY = logicalSize / 2;
    const scale = logicalSize / 240;

    // Circle 1: Bass
    const bassRadius = (55 + (bassPunch * 200)) * scale;
    const bassLightness = 20 + (bassPunch * 60);
    ctx.fillStyle = isLight
      ? 'rgba(59, 130, 246, 0.6)'
      : `hsla(217, 91%, ${bassLightness + 40}%, 0.4)`;
    ctx.beginPath();
    ctx.arc(centerX, centerY, bassRadius, 0, 2 * Math.PI);
    ctx.fill();

    // Circle 2: High
    const highRadius = (40 + (highPunch * 130)) * scale;
    const highLightness = 40 + (highPunch * 60);
    ctx.fillStyle = isLight
      ? 'rgba(96, 165, 250, 0.6)'
      : `hsla(217, 100%, ${highLightness + 30}%, 0.4)`;
    ctx.beginPath();
    ctx.arc(centerX, centerY, highRadius, 0, 2 * Math.PI);
    ctx.fill();
  }

  draw();
}

// ─── Idle Visualizer ─────────────────────────────────────────────

export function drawIdleVisualizer(): void {
  const canvas = document.getElementById('visualizerCanvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const _ctx2 = canvas.getContext('2d');
  if (!_ctx2) return;
  const ctx: CanvasRenderingContext2D = _ctx2;

  const wrapper = document.querySelector('.vinyl-wrapper');
  const logicalSize = wrapper ? (wrapper as HTMLElement).clientWidth : 240;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== logicalSize * dpr || canvas.height !== logicalSize * dpr) {
    canvas.width = logicalSize * dpr;
    canvas.height = logicalSize * dpr;
    canvas.style.width = '';
    canvas.style.height = '';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  }

  const theme = document.documentElement.getAttribute('data-theme');
  const isLight = (theme === 'light');

  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, logicalSize, logicalSize);
  ctx.globalCompositeOperation = isLight ? 'source-over' : 'lighter';
  ctx.shadowBlur = 0;

  const centerX = logicalSize / 2;
  const centerY = logicalSize / 2;
  const scale = logicalSize / 240;

  // Bass circle (static)
  const bassRadius = 55 * scale;
  ctx.fillStyle = isLight ? 'rgba(59, 130, 246, 0.6)' : 'hsla(217, 91%, 60%, 0.4)';
  ctx.beginPath();
  ctx.arc(centerX, centerY, bassRadius, 0, 2 * Math.PI);
  ctx.fill();

  // High circle (static)
  const highRadius = 40 * scale;
  ctx.fillStyle = isLight ? 'rgba(96, 165, 250, 0.6)' : 'hsla(217, 100%, 70%, 0.4)';
  ctx.beginPath();
  ctx.arc(centerX, centerY, highRadius, 0, 2 * Math.PI);
  ctx.fill();
}

// ─── Init ────────────────────────────────────────────────────────

export function initVisualizer(): void {
  drawIdleVisualizer();

  window.addEventListener('resize', () => {
    if (_vizResizeTimer) clearTimeout(_vizResizeTimer);
    _vizResizeTimer = setTimeout(() => {
      const wrapper = document.querySelector('.vinyl-wrapper');
      if (!wrapper || (wrapper as HTMLElement).clientWidth < 10) return;
      const currentState = getState<string>('appState');
      if (isIdleOrPaused(currentState)) {
        drawIdleVisualizer();
      } else {
        startVisualizer();
      }
    }, 250);
  });

  // Listen for check events from tab switch
  bus.on('ui:visualizer-check', ((..._args: unknown[]) => {
    const currentState = getState<string>('appState');
    if (isIdleOrPaused(currentState)) drawIdleVisualizer();
    else startVisualizer();
  }) as (...args: unknown[]) => void);

  // Listen for playback state changes
  bus.on('player:state-changed', ((..._args: unknown[]) => {
    const currentState = getState<string>('appState');
    if (isIdleOrPaused(currentState)) drawIdleVisualizer();
    else startVisualizer();
  }) as (...args: unknown[]) => void);

  // Listen for visualizer start command from playback
  bus.on('visualizer:start', ((..._args: unknown[]) => {
    startVisualizer();
  }) as (...args: unknown[]) => void);

  log.info('[Visualizer] Initialized');
}
