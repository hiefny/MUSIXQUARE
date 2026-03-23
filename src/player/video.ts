/**
 * MUSIXQUARE 3.0 — Video Element & State Helpers
 *
 * Manages: videoElement reference, media type detection, idle/paused helper,
 * engine mode switching.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { APP_STATE } from '../core/constants.ts';
import type { AppStateValue } from '../core/constants.ts';
import { getCurrentAudioBuffer } from './_state.ts';
import { setVideoElement } from '../core/blob-manager.ts';

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

  let targetState: AppStateValue;
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

  const currentState = getState('appState');
  const newState: AppStateValue = isIdleOrPaused(currentState) ? APP_STATE.PAUSED : targetState;

  // For YouTube, always set the target state so body class is applied
  const finalState: AppStateValue = mode === 'youtube' ? targetState : newState;
  setState('appState', finalState);
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

  const videoElement = _videoElement;
  const currentFileBlob = getState('files.currentFileBlob');
  const meta = getState('transfer.meta');

  // UX: When a local *video* is paused we still want to keep the paused frame
  // visible (instead of collapsing back to the visualizer).
  const keepVideoVisibleOnIdle = (
    isIdleOrPaused(appState) &&
    videoElement &&
    !!videoElement.getAttribute('src') &&
    isMediaVideo(currentFileBlob, meta)
  );

  const isVideoMode = (
    appState === APP_STATE.PLAYING_VIDEO ||
    appState === APP_STATE.PLAYING_YOUTUBE ||
    keepVideoVisibleOnIdle
  );

  const wantVideo = !!isVideoMode;
  const wantYouTube = appState === APP_STATE.PLAYING_YOUTUBE;
  const hasVideo = body.classList.contains('mode-video');
  const hasYouTube = body.classList.contains('mode-youtube');

  // Only remove/add classes that actually need to change
  if (wantVideo !== hasVideo) {
    body.classList.toggle('mode-video', wantVideo);
  }
  if (wantYouTube !== hasYouTube) {
    body.classList.toggle('mode-youtube', wantYouTube);
  }

  // ── YouTube container visibility ──
  const ytContainer = document.getElementById('youtube-player-container');
  if (ytContainer) {
    if (appState === APP_STATE.PLAYING_YOUTUBE) {
      ytContainer.style.display = 'block';
      ytContainer.style.opacity = '1';
      ytContainer.style.pointerEvents = 'auto';
    } else {
      ytContainer.style.opacity = '0';
      ytContainer.style.pointerEvents = 'none';
      ytContainer.style.display = 'none';
    }
  }

  // ── Video wrapper: explicit inline style (backup for CSS) ──
  const videoWrapper = document.querySelector('.video-wrapper') as HTMLElement | null;
  if (videoWrapper) {
    videoWrapper.style.display = isVideoMode ? 'flex' : 'none';
    if (isVideoMode) {
      videoWrapper.style.visibility = 'visible';
      videoWrapper.style.pointerEvents = 'auto';
    } else {
      // Clean up inline styles to prevent stale overrides on next mode switch
      videoWrapper.style.removeProperty('visibility');
      videoWrapper.style.removeProperty('pointer-events');
    }
  }

  // ── Main video element: only show for local video (not YouTube) ──
  if (videoElement) {
    const showMainVideo = (appState === APP_STATE.PLAYING_VIDEO) || keepVideoVisibleOnIdle;
    videoElement.style.display = showMainVideo ? 'block' : 'none';
    // Pause hidden video to save CPU (e.g. video→audio mode switch)
    if (!showMainVideo && !videoElement.paused) {
      videoElement.pause();
    }
  }
}

// ─── Init ──────────────────────────────────────────────────────────

export function initVideo(): void {
  _videoElement = document.getElementById('main-video') as HTMLVideoElement | null;
  if (!_videoElement) {
    log.warn('[Video] #main-video element not found');
  }
  setVideoElement(_videoElement);

  // Sync body mode class with app state changes
  bus.on('state:appState', () => {
    updateBodyModeClass(getState('appState'));
  });

  // Sync video element volume with master volume
  bus.on('player:sync-video-volume', (volume: number) => {
    if (!_videoElement || !Number.isFinite(volume)) return;

    // [Double Audio Fix] Mute video when playing via audio buffer decode mode
    if (getCurrentAudioBuffer()) {
      _videoElement.volume = 0;
      _videoElement.muted = true;
    } else {
      _videoElement.muted = false;
      try { _videoElement.volume = volume; } catch (e) {
        log.debug('[Video] Volume set failed:', e);
      }
    }
  });

  log.info('[Video] Initialized');
}
