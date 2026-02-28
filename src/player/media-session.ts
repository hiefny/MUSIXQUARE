/**
 * MUSIXQUARE 2.0 — Media Session API
 * Extracted from original app.js lines 3710-3825
 *
 * Manages: System media controls (lock screen, notification area),
 * track metadata display.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { APP_STATE } from '../core/constants.ts';
import { togglePlay, stopPlayback, skipTime } from './playback.ts';
import { isIdleOrPaused } from './video.ts';
import type { PlaylistItem } from '../types/index.ts';

// ─── Metadata Update ───────────────────────────────────────────────

export function updateMediaSessionMetadata(item: PlaylistItem | null): void {
  if (!('mediaSession' in navigator) || !item) return;

  let title = item.name || item.title || 'Unknown Track';
  const artist = item.type === 'youtube' ? 'YouTube' : 'MUSIXQUARE';
  let artwork: MediaImage[] = [];

  if (item.type === 'youtube') {
    const currentYouTubeSubIndex = getState('youtube.currentSubIndex') ?? -1;
    if (item.playlistId && currentYouTubeSubIndex !== -1) {
      const subMap = getState('youtube.subItemsMap') || {};
      const subData = subMap[item.playlistId];
      if (subData?.titles && currentYouTubeSubIndex >= 0 && currentYouTubeSubIndex < subData.titles.length && subData.titles[currentYouTubeSubIndex]) {
        title = subData.titles[currentYouTubeSubIndex];
      } else {
        title = `${item.title || 'Playlist'} (${currentYouTubeSubIndex + 1})`;
      }
    }

    const thumb = item.thumbnail;
    if (thumb) {
      artwork = [{ src: thumb, sizes: '480x360', type: 'image/jpeg' }];
    }
  } else {
    artwork = [{ src: 'favicon.svg', sizes: '512x512', type: 'image/svg+xml' }];
  }

  navigator.mediaSession.metadata = new MediaMetadata({
    title,
    artist,
    album: 'MUSIXQUARE',
    artwork,
  });
}

// ─── Init ──────────────────────────────────────────────────────────

export function initMediaSession(): void {
  if (!('mediaSession' in navigator)) return;
  log.debug('[MediaSession] Initializing action handlers...');

  const isBlocked = (): boolean => {
    const hostConn = getState('network.hostConn');
    const isOperator = getState('network.isOperator');
    return !!(hostConn && !isOperator);
  };

  navigator.mediaSession.setActionHandler('play', () => {
    if (isBlocked()) return;
    const currentState = getState('appState');
    if (currentState === APP_STATE.PLAYING_YOUTUBE) {
      togglePlay();
      return;
    }
    const currentTrackIndex = getState('playlist.currentTrackIndex');
    if (currentTrackIndex >= 0 && currentState !== APP_STATE.IDLE) {
      togglePlay();
    }
  });

  navigator.mediaSession.setActionHandler('pause', () => {
    if (isBlocked()) return;
    const currentState = getState('appState');
    if (!isIdleOrPaused(currentState)) togglePlay();
  });

  navigator.mediaSession.setActionHandler('previoustrack', () => {
    if (isBlocked()) return;
    bus.emit('playlist:prev-track');
  });

  navigator.mediaSession.setActionHandler('nexttrack', () => {
    if (isBlocked()) return;
    bus.emit('playlist:next-track');
  });

  navigator.mediaSession.setActionHandler('seekbackward', (details) => {
    if (isBlocked()) return;
    skipTime(-(details.seekOffset || 10));
  });

  navigator.mediaSession.setActionHandler('seekforward', (details) => {
    if (isBlocked()) return;
    skipTime(details.seekOffset || 10);
  });

  try {
    navigator.mediaSession.setActionHandler('stop', () => {
      stopPlayback();
    });
  } catch (e: unknown) {
    log.debug('[MediaSession] Handler setup skipped:', (e as Error).message);
  }

  // Listen for metadata update events from playlist module
  bus.on('player:metadata-update', (item: PlaylistItem) => {
    updateMediaSessionMetadata(item);
  });

  log.info('[MediaSession] Initialized');
}
