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
import { APP_STATE } from '../core/constants.ts';
import type { AppStateValue, PlaybackModeValue } from '../core/constants.ts';
import { isPlaybackPlaying, setPlaybackAppState } from './ownership.ts';

// ─── Upload-time guard: reject video files ────────────────────────

const VIDEO_EXTENSIONS = [
  'mp4',
  'm4v',
  'mkv',
  'webm',
  'mov',
  'qt',
  'avi',
  'wmv',
  'asf',
  '3gp',
  '3g2',
  'flv',
  'f4v',
  'mpeg',
  'mpg',
  'mpe',
  'mp2',
  'ts',
  'm2ts',
  'mts',
  'ogv',
  'vob',
  'dv',
  'mxf',
];

export function isMediaVideo(
  blob: Blob | File | null,
  metadata?: Record<string, unknown> | null,
): boolean {
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

  const newState: AppStateValue = isPlaybackPlaying() ? targetState : APP_STATE.PAUSED;
  // YouTube forces its target state so playback.mode keeps applying even when paused.
  const finalState: AppStateValue = mode === 'youtube' ? targetState : newState;
  setPlaybackAppState(finalState);
}

// Body-class sync driven by decomposed playback mode.

function isPlaybackModeValue(value: unknown): value is PlaybackModeValue {
  return value === null || value === 'file' || value === 'youtube' || value === 'system-audio';
}

function updateBodyModeClass(mode: PlaybackModeValue): void {
  const body = document.body;

  const wantYouTube = mode === 'youtube';
  if (body.classList.contains('mode-youtube') !== wantYouTube) {
    body.classList.toggle('mode-youtube', wantYouTube);
  }

  const wantSysAudio = mode === 'system-audio';
  if (body.classList.contains('mode-system-audio') !== wantSysAudio) {
    body.classList.toggle('mode-system-audio', wantSysAudio);
  }

  const ytContainer = document.getElementById('youtube-player-container');
  if (ytContainer) {
    if (mode === 'youtube') {
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

bus.on('state:playback.mode', (mode) => {
  if (!isPlaybackModeValue(mode)) return;
  updateBodyModeClass(mode);
});
