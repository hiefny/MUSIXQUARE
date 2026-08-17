/**
 * MUSIXQUARE — Playback mode & state helpers
 *
 * Audio and YouTube are the supported engines. Local video files are rejected
 * at upload because browser container and codec support is inconsistent. The
 * exported mode helpers remain in this module to preserve its import contract.
 */

import { bus } from '../core/events.ts';
import type { PlaybackModeValue } from '../core/constants.ts';
import { clearManagedTimer } from '../core/timers.ts';
import {
  isPlaybackModeValue,
  isPlaybackPlaying,
  setPlaybackFilePaused,
  setPlaybackFilePlaying,
  setPlaybackIdle,
  setPlaybackYouTubePlaying,
} from './ownership.ts';

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

type WebKitFullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitCurrentFullScreenElement?: Element | null;
  webkitIsFullScreen?: boolean;
  webkitExitFullscreen?: () => void;
  webkitCancelFullScreen?: () => void;
};

/**
 * Leave every fullscreen surface owned by the YouTube player before its
 * wrapper is parked offscreen. Mobile browsers can otherwise keep the wrapper
 * (or its iframe) as the active fullscreen element after local-file playback
 * takes ownership, leaving the app chrome inaccessible. Fake fullscreen must
 * be cleared too because its `!important` layout rules override parking.
 */
export function exitYouTubeFullscreen(): void {
  const ytContainer = document.getElementById('youtube-player-container');
  const videoWrapper = (ytContainer?.closest('.video-wrapper') ??
    document.querySelector('.video-wrapper')) as HTMLElement | null;
  const pageWasYouTube = document.body.classList.contains('mode-youtube');
  clearManagedTimer('webkit-fullscreen-fallback');
  videoWrapper?.classList.remove('fake-fullscreen');
  document.body.classList.remove('has-fake-fullscreen');

  const doc = document as WebKitFullscreenDocument;
  const fullscreenElement =
    document.fullscreenElement ??
    doc.webkitFullscreenElement ??
    doc.webkitCurrentFullScreenElement ??
    null;
  const playerOwnsFullscreen = Boolean(
    fullscreenElement &&
    (fullscreenElement === videoWrapper ||
      videoWrapper?.contains(fullscreenElement) ||
      (pageWasYouTube && fullscreenElement === document.documentElement)),
  );
  const legacyPlayerFullscreen = pageWasYouTube && doc.webkitIsFullScreen === true;
  if (!playerOwnsFullscreen && !legacyPlayerFullscreen) return;

  const exitFullscreen =
    document.exitFullscreen ?? doc.webkitExitFullscreen ?? doc.webkitCancelFullScreen;
  if (!exitFullscreen) return;

  try {
    const pendingExit: void | Promise<void> = exitFullscreen.call(document);
    if (pendingExit && typeof pendingExit.catch === 'function') {
      void pendingExit.catch(() => undefined);
    }
  } catch {
    // Fullscreen teardown is best-effort on older WebKit. The fake-fullscreen
    // cleanup above still restores the app layout when the native API throws.
  }
}

function updateBodyModeClass(mode: PlaybackModeValue): void {
  const body = document.body;

  const wantYouTube = mode === 'youtube';
  const ytContainer = document.getElementById('youtube-player-container');
  const ytWrapper = ytContainer?.closest('.video-wrapper') as HTMLElement | null;
  if (!wantYouTube) exitYouTubeFullscreen();

  if (body.classList.contains('mode-youtube') !== wantYouTube) {
    body.classList.toggle('mode-youtube', wantYouTube);
  }

  const wantSysAudio = mode === 'system-audio';
  if (body.classList.contains('mode-system-audio') !== wantSysAudio) {
    body.classList.toggle('mode-system-audio', wantSysAudio);
  }

  if (ytContainer) {
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
