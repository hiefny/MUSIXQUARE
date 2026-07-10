/**
 * MUSIXQUARE — Playback mode & state helpers
 *
 * Audio and YouTube are the supported engines. Local video files are rejected
 * at upload because browser container and codec support is inconsistent. The
 * exported mode helpers remain in this module to preserve its import contract.
 */

import { bus } from '../core/events.ts';
import type { PlaybackModeValue } from '../core/constants.ts';
import {
  isPlaybackModeValue,
  isPlaybackPlaying,
  setPlaybackFilePaused,
  setPlaybackFilePlaying,
  setPlaybackIdle,
  setPlaybackYouTubePlaying,
} from './ownership.ts';

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
  switch (mode) {
    case 'youtube':
      setPlaybackYouTubePlaying();
      return;
    case 'buffer':
    case 'audio':
      if (isPlaybackPlaying()) {
        setPlaybackFilePlaying();
      } else {
        setPlaybackFilePaused();
      }
      return;
    default:
      setPlaybackIdle();
  }
}

// Body-class sync driven by decomposed playback mode.

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
    const ytWrapper = ytContainer.closest('.video-wrapper') as HTMLElement | null;
    const hasIframe = !!ytContainer.querySelector('iframe');

    if (mode === 'youtube') {
      if (ytWrapper) {
        ytWrapper.style.display = 'flex';
        ytWrapper.style.position = '';
        ytWrapper.style.left = '';
        ytWrapper.style.top = '';
        ytWrapper.style.width = '';
        ytWrapper.style.height = '';
        ytWrapper.style.maxWidth = '';
        ytWrapper.style.margin = '';
        ytWrapper.style.opacity = '';
        ytWrapper.style.visibility = '';
        ytWrapper.style.pointerEvents = '';
        ytWrapper.style.overflow = '';
      }
      ytContainer.style.display = 'block';
      ytContainer.style.opacity = '1';
      ytContainer.style.pointerEvents = 'auto';
      ytContainer.style.position = 'relative';
      ytContainer.style.left = '';
      ytContainer.style.top = '';
      ytContainer.style.width = '100%';
      ytContainer.style.height = '100%';
      ytContainer.style.overflow = '';
    } else {
      if (hasIframe) {
        if (ytWrapper) {
          ytWrapper.style.display = 'flex';
          ytWrapper.style.position = 'fixed';
          ytWrapper.style.left = '-9999px';
          ytWrapper.style.top = '0';
          ytWrapper.style.width = '1px';
          ytWrapper.style.height = '1px';
          ytWrapper.style.maxWidth = 'none';
          ytWrapper.style.margin = '0';
          ytWrapper.style.opacity = '0';
          ytWrapper.style.visibility = 'visible';
          ytWrapper.style.pointerEvents = 'none';
          ytWrapper.style.overflow = 'hidden';
        }
        ytContainer.style.display = 'block';
        ytContainer.style.opacity = '0';
        ytContainer.style.pointerEvents = 'none';
        ytContainer.style.position = 'relative';
        ytContainer.style.left = '';
        ytContainer.style.top = '';
        ytContainer.style.width = '1px';
        ytContainer.style.height = '1px';
        ytContainer.style.overflow = 'hidden';
      } else {
        if (ytWrapper) {
          ytWrapper.style.display = 'none';
          ytWrapper.style.opacity = '';
          ytWrapper.style.visibility = '';
          ytWrapper.style.pointerEvents = '';
        }
        ytContainer.style.opacity = '0';
        ytContainer.style.pointerEvents = 'none';
        ytContainer.style.display = 'none';
      }
    }
  }
}

bus.on('state:playback.mode', (mode) => {
  if (!isPlaybackModeValue(mode)) return;
  updateBodyModeClass(mode);
});
