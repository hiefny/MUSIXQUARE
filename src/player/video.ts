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
  exitFullscreenFor,
  getFullscreenElement,
  type FullscreenDocument,
} from '../core/fullscreen.ts';
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

function notifyFullscreenExit(listener: (() => void) | undefined): void {
  try {
    listener?.();
  } catch {
    // A surface observer cannot break the mode switch that asked for the exit.
  }
}

/**
 * Leave every fullscreen surface owned by the YouTube player before its
 * wrapper is parked offscreen. Mobile browsers can otherwise keep the wrapper
 * (or its iframe) as the active fullscreen element after local-file playback
 * takes ownership, leaving the app chrome inaccessible. Fake fullscreen must
 * be cleared too so its viewport layout cannot remain active while parking.
 * The explicit fullscreen toggle may use document scope to preserve its
 * existing ability to leave fullscreen belonging to another app surface.
 */
export function exitYouTubeFullscreen(
  onSettled?: () => void,
  options: { scope?: 'document' } = {},
): void {
  const ytContainer = document.getElementById('youtube-player-container');
  const videoWrapper = (ytContainer?.closest('.video-wrapper') ??
    document.querySelector('.video-wrapper')) as HTMLElement | null;
  const pageWasYouTube = document.body.classList.contains('mode-youtube');
  clearManagedTimer('webkit-fullscreen-fallback');
  videoWrapper?.classList.remove('fake-fullscreen');
  document.body.classList.remove('has-fake-fullscreen');

  const doc = document as FullscreenDocument;
  const fullscreenElement = getFullscreenElement();
  const playerOwnsFullscreen = Boolean(
    fullscreenElement &&
    (options.scope === 'document' ||
      fullscreenElement === videoWrapper ||
      videoWrapper?.contains(fullscreenElement) ||
      (pageWasYouTube && fullscreenElement === document.documentElement)),
  );
  const legacyPlayerFullscreen =
    (options.scope === 'document' || pageWasYouTube) && doc.webkitIsFullScreen === true;
  if (!playerOwnsFullscreen && !legacyPlayerFullscreen) {
    notifyFullscreenExit(onSettled);
    return;
  }

  // Leave through the shared bounded exit (core/fullscreen.ts), by the same
  // matching-method rule as the screensaver. A second exit for the same element
  // joins the one in flight instead of exiting twice.
  exitFullscreenFor('youtube', fullscreenElement, onSettled);
}

/**
 * Accessibility state of the `.video-wrapper` that hosts the YouTube iframe.
 * A parked wrapper (retained iframe outside YouTube mode, or the iOS
 * pre-created player before any playback) stays rendered offscreen, so its
 * fullscreen button would otherwise take reverse keyboard focus. `inert` also
 * removes the subtree from accessibility APIs, so no separate aria-hidden is
 * needed. It keeps the iframe rendered and does not block the player's
 * postMessage API, so the retained player and the iOS prime flow are
 * unaffected.
 */
export function setYouTubeWrapperParked(wrapper: HTMLElement, parked: boolean): void {
  wrapper.toggleAttribute('inert', parked);
}

function updateBodyModeClass(mode: PlaybackModeValue): void {
  const body = document.body;

  const wantYouTube = mode === 'youtube';
  const ytContainer = document.getElementById('youtube-player-container');
  const ytWrapper = ytContainer?.closest('.video-wrapper') as HTMLElement | null;
  if (!wantYouTube) exitYouTubeFullscreen();

  // Outside YouTube mode the wrapper is parked offscreen; keep it inert and
  // hidden from assistive technology until YouTube mode owns it again.
  if (ytWrapper) setYouTubeWrapperParked(ytWrapper, !wantYouTube);

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
