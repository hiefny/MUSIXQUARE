/**
 * MUSIXQUARE 2.0 — Video Element & State Helpers
 * Extracted from original app.js lines 502-504, 601-615, 1344, 4895-4926
 *
 * Manages: videoElement reference, media type detection, idle/paused helper,
 * engine mode switching.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { APP_STATE } from '../core/constants.ts';

// ─── Video Element ─────────────────────────────────────────────────

let _videoElement: HTMLVideoElement | null = null;

export function getVideoElement(): HTMLVideoElement | null {
  return _videoElement;
}

// ─── State Helpers ─────────────────────────────────────────────────

export function isIdleOrPaused(state: string): boolean {
  return state === APP_STATE.IDLE || state === APP_STATE.PAUSED;
}

// ─── Media Type Detection ──────────────────────────────────────────

const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'webm', 'mov'];

export function isMediaVideo(blob: Blob | File | null, metadata?: Record<string, unknown> | null): boolean {
  if (!blob) return false;

  // 1. Check MIME type
  if (blob.type && blob.type.startsWith('video/')) return true;
  if (metadata) {
    if (typeof metadata.mime === 'string' && metadata.mime.startsWith('video/')) return true;
    if (typeof metadata.type === 'string' && metadata.type.startsWith('video/')) return true;
  }

  // 2. Check extension
  const fileName = (metadata?.name as string) || (blob as File).name || '';
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return VIDEO_EXTENSIONS.includes(ext);
}

// ─── Engine Mode ───────────────────────────────────────────────────

/**
 * Handle UI and state transitions between Audio, Video, and YouTube modes.
 * Sets state to target mode, but if currently idle/paused, stays in PAUSED
 * to prevent "ghost playback" UI.
 */
export function setEngineMode(mode: string): void {
  log.debug(`[Engine] Switching mode to: ${mode}`);

  let targetState: string;
  switch (mode) {
    case 'video':
      targetState = APP_STATE.PLAYING_VIDEO;
      break;
    case 'youtube':
      targetState = APP_STATE.PLAYING_YOUTUBE;
      break;
    case 'buffer':
    case 'audio':
      targetState = APP_STATE.PLAYING_AUDIO;
      break;
    default:
      targetState = APP_STATE.IDLE;
  }

  const currentState = getState<string>('appState');
  const newState = isIdleOrPaused(currentState) ? APP_STATE.PAUSED : targetState;

  // For YouTube, always set the target state so body class is applied
  const finalState = mode === 'youtube' ? targetState : newState;
  setState('appState', finalState);
  bus.emit('player:state-changed', finalState);

  bus.emit('ui:update-playlist');
}

// ─── Body Mode Class ──────────────────────────────────────────────

/**
 * Update UI classes and elements based on state.
 * Faithfully ported from original app.js `updateUIForState()`.
 *
 * Key insight: `mode-video` is the master CSS toggle for the video-wrapper
 * (used by BOTH local video AND YouTube). `mode-youtube` is additionally set
 * for YouTube-specific UI (e.g. settings lock overlay). When a local video
 * is paused, we keep `mode-video` so the frozen frame stays visible.
 */
function updateBodyModeClass(appState: string): void {
  const body = document.body;
  body.classList.remove('mode-video', 'mode-youtube', 'mode-audio');

  const videoElement = _videoElement;
  const currentFileBlob = getState<Blob | null>('files.currentFileBlob');
  const meta = getState<Record<string, unknown>>('transfer.meta');

  // UX: When a local *video* is paused we still want to keep the paused frame
  // visible (instead of collapsing back to the visualizer).
  const keepVideoVisibleOnIdle = (
    isIdleOrPaused(appState) &&
    videoElement &&
    !!videoElement.src &&
    isMediaVideo(currentFileBlob, meta)
  );

  const isVideoMode = (
    appState === APP_STATE.PLAYING_VIDEO ||
    appState === APP_STATE.PLAYING_YOUTUBE ||
    keepVideoVisibleOnIdle
  );

  // mode-video is the master toggle for .video-wrapper visibility (CSS)
  if (isVideoMode) body.classList.add('mode-video');

  // mode-youtube is additional for YouTube-specific UI (settings lock)
  if (appState === APP_STATE.PLAYING_YOUTUBE) body.classList.add('mode-youtube');

  if (appState === APP_STATE.PLAYING_AUDIO) body.classList.add('mode-audio');

  // ── YouTube container visibility (default: hidden) ──
  const ytContainer = document.getElementById('youtube-player-container');
  if (ytContainer) {
    ytContainer.style.opacity = '0';
    ytContainer.style.pointerEvents = 'none';
    ytContainer.style.display = 'none';
  }

  // ── Video wrapper: explicit inline style (backup for CSS) ──
  const videoWrapper = document.querySelector('.video-wrapper') as HTMLElement | null;
  if (videoWrapper) {
    videoWrapper.style.display = isVideoMode ? 'flex' : 'none';
    if (isVideoMode) {
      videoWrapper.style.visibility = 'visible';
      videoWrapper.style.pointerEvents = 'auto';
    }
  }

  // ── Main video element: only show for local video (not YouTube) ──
  if (videoElement) {
    const showMainVideo = (appState === APP_STATE.PLAYING_VIDEO) || keepVideoVisibleOnIdle;
    videoElement.style.display = showMainVideo ? 'block' : 'none';
  }

  // ── YouTube container: show for YouTube mode ──
  if (appState === APP_STATE.PLAYING_YOUTUBE && ytContainer) {
    ytContainer.style.display = 'block';
    ytContainer.style.opacity = '1';
    ytContainer.style.pointerEvents = 'auto';
  }
}

// ─── Init ──────────────────────────────────────────────────────────

export function initVideo(): void {
  _videoElement = document.getElementById('main-video') as HTMLVideoElement | null;
  if (!_videoElement) {
    log.warn('[Video] #main-video element not found');
  }

  // Sync body mode class with app state changes
  bus.on('player:state-changed', ((...args: unknown[]) => {
    updateBodyModeClass(args[0] as string);
  }) as (...args: unknown[]) => void);

  log.info('[Video] Initialized');
}
