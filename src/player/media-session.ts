/**
 * MUSIXQUARE — Media Session API
 *
 * Manages: System media controls (lock screen, notification area),
 * track metadata display.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import type { PlaybackActivityValue } from '../core/constants.ts';
import { togglePlay, stopPlayback, skipTime } from './transport.ts';
import {
  isPlaybackIdle,
  isPlaybackModeYouTube,
  isPlaybackPlayingFile,
} from './ownership.ts';
import type { PlaylistItem } from '../types/index.ts';

function isPlaybackActivityValue(value: unknown): value is PlaybackActivityValue {
  return value === 'idle' || value === 'paused' || value === 'playing' || value === 'pending';
}

function mediaSessionStateFromActivity(
  activity: PlaybackActivityValue,
): MediaSessionPlaybackState {
  if (activity === 'playing') return 'playing';
  if (activity === 'paused') return 'paused';
  return 'none';
}

// ─── Metadata Update ───────────────────────────────────────────────

export function updateMediaSessionMetadata(item: Partial<PlaylistItem> | null): void {
  if (!('mediaSession' in navigator) || !item) return;

  let title = item.name || item.title || 'Unknown Track';
  const artist = item.type === 'youtube' ? 'YouTube' : 'MUSIXQUARE';
  let artwork: MediaImage[] = [];

  if (item.type === 'youtube') {
    const currentYouTubeSubIndex = getState('youtube.currentSubIndex') ?? -1;
    if (item.playlistId && currentYouTubeSubIndex !== -1) {
      const subMap = getState('youtube.subItemsMap') || {};
      const subData = subMap[item.playlistId];
      if (
        subData?.titles &&
        currentYouTubeSubIndex >= 0 &&
        currentYouTubeSubIndex < subData.titles.length &&
        subData.titles[currentYouTubeSubIndex]
      ) {
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

  /** Non-OP guest: block track changes & seek, but ALLOW play/pause.
   *  Users must always be able to pause from lock screen / hardware buttons. */
  const isPlaybackBlocked = (): boolean => {
    const hostConn = getState('network.hostConn');
    const isOperator = getState('network.isOperator');
    return !!(hostConn && !isOperator);
  };

  navigator.mediaSession.setActionHandler('play', () => {
    if (isPlaybackModeYouTube()) {
      togglePlay();
      return;
    }
    const currentTrackIndex = getState('playlist.currentTrackIndex');
    if (isPlaybackIdle()) {
      // Try to play from current playlist position instead of blocking
      if (currentTrackIndex >= 0) {
        bus.emit('playlist:play-track', currentTrackIndex);
      }
      return;
    }
    // Already playing — bail. Some BT/headphone wrappers can re-fire 'play'
    // even while playbackState='playing', and a togglePlay here would pause
    // the music after the user pressed play. Mirrors the 'pause' handler
    // below which guards the symmetric case.
    if (isPlaybackPlayingFile()) return;
    if (currentTrackIndex >= 0) {
      togglePlay();
    }
  });

  navigator.mediaSession.setActionHandler('pause', () => {
    if (isPlaybackPlayingFile() || isPlaybackModeYouTube()) togglePlay();
  });

  navigator.mediaSession.setActionHandler('previoustrack', () => {
    if (isPlaybackBlocked()) return;
    bus.emit('playlist:prev-track');
  });

  navigator.mediaSession.setActionHandler('nexttrack', () => {
    if (isPlaybackBlocked()) return;
    bus.emit('playlist:next-track');
  });

  navigator.mediaSession.setActionHandler('seekbackward', (details) => {
    if (isPlaybackBlocked()) return;
    skipTime(-(details.seekOffset || 10));
  });

  navigator.mediaSession.setActionHandler('seekforward', (details) => {
    if (isPlaybackBlocked()) return;
    skipTime(details.seekOffset || 10);
  });

  try {
    navigator.mediaSession.setActionHandler('stop', () => {
      if (isPlaybackBlocked()) return;
      stopPlayback();
    });
  } catch (e: unknown) {
    log.debug('[MediaSession] Handler setup skipped:', (e as Error).message);
  }

  // Listen for metadata updates via state subscription
  bus.on('state:player.currentTrackMeta', () => {
    const meta = getState('player.currentTrackMeta');
    updateMediaSessionMetadata(meta ?? null);
  });

  // Update lock screen metadata when YouTube sub-video changes (playlist auto-advance)
  bus.on('state:youtube.currentSubIndex', () => {
    const meta = getState('player.currentTrackMeta');
    if (meta && isPlaybackModeYouTube()) {
      updateMediaSessionMetadata(meta);
    }
  });

  // !! CRITICAL — DO NOT REMOVE
  // Sync playbackState with playback activity. This explicitly tells the OS
  // that media is playing, which has a crucial side effect on iOS PWA:
  // iOS keeps the AudioContext alive in the background when
  // playbackState === 'playing', enabling background audio playback.
  // Without this, iOS suspends the AudioContext when the app goes to
  // the background or the screen turns off, killing audio immediately.
  // (Tone.js / Web Audio apps need this because the browser can't
  // infer playback state from an <audio> element.)
  bus.on('state:playback.activity', (activity) => {
    if (!('mediaSession' in navigator)) return;
    if (!isPlaybackActivityValue(activity)) return;
    navigator.mediaSession.playbackState = mediaSessionStateFromActivity(activity);
  });

  log.info('[MediaSession] Initialized');
}
