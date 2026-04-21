/**
 * MUSIXQUARE — Playback mode & state helpers
 *
 * Audio + YouTube are the only engines. Local <video> playback was dropped
 * because container/codec compatibility (notably iPhone .mov via HEVC/QT)
 * was too fragile to justify its own code path. Videos now ship exclusively
 * through the YouTube flow. The module keeps its historical filename so
 * existing imports resolve — rename later if desired.
 */

import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { APP_STATE } from '../core/constants.ts';
import type { AppStateValue } from '../core/constants.ts';

// ─── State predicates ─────────────────────────────────────────────

export function isIdleOrPaused(state: string): boolean {
  return state === APP_STATE.IDLE || state === APP_STATE.PAUSED;
}

// ─── Upload-time guard: reject video files ────────────────────────

const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v'];

export function isMediaVideo(blob: Blob | File | null, metadata?: Record<string, unknown> | null): boolean {
  if (!blob) return false;

  if (blob.type && blob.type.startsWith('video/')) return true;
  if (metadata) {
    if (typeof metadata.mime === 'string' && metadata.mime.startsWith('video/')) return true;
    if (typeof metadata.type === 'string' && metadata.type.startsWith('video/')) return true;
  }

  const fileName = (metadata?.name as string) || (blob as File).name || '';
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return VIDEO_EXTENSIONS.includes(ext);
}

// ─── Engine mode switch (audio ↔ YouTube) ─────────────────────────

export function setEngineMode(mode: 'audio' | 'buffer' | 'youtube'): void {
  let targetState: AppStateValue;
  switch (mode) {
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
  // YouTube forces its target state so body.mode-youtube keeps applying even when paused.
  const finalState: AppStateValue = mode === 'youtube' ? targetState : newState;
  setState('appState', finalState);
}

// ─── Body-class sync driven by appState ───────────────────────────

function updateBodyModeClass(appState: string): void {
  const body = document.body;

  const wantYouTube = appState === APP_STATE.PLAYING_YOUTUBE;
  if (body.classList.contains('mode-youtube') !== wantYouTube) {
    body.classList.toggle('mode-youtube', wantYouTube);
  }

  const wantSysAudio = appState === APP_STATE.PLAYING_SYSTEM_AUDIO;
  if (body.classList.contains('mode-system-audio') !== wantSysAudio) {
    body.classList.toggle('mode-system-audio', wantSysAudio);
  }

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
}

bus.on('state:appState', () => {
  updateBodyModeClass(getState('appState'));
});
