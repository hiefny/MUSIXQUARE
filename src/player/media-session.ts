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
import { togglePlay, stopPlayback, skipTime, play, pause } from './transport.ts';
import { isLocalFilePaused, setLocalFilePaused } from './_state.ts';
import {
  isPlaybackActivityValue,
  isPlaybackIdle,
  isPlaybackModeYouTube,
  isPlaybackPlayingFile,
} from './ownership.ts';
import { getCurrentQueueItemId } from './queue-model.ts';
import type { PlaylistItem } from '../types/index.ts';
import { getRoomContext, hasRoomCapability } from '../rooms/authority.ts';

function mediaSessionStateFromActivity(activity: PlaybackActivityValue): MediaSessionPlaybackState {
  if (activity === 'playing') return 'playing';
  if (activity === 'paused') return 'paused';
  // 'pending' covers transient windows the user perceives as "about to resume":
  // file lifecycle DOWNLOADING/AWAITING_PRELOAD/DECODING, and the system-audio
  // guest placeholder before the WebRTC stream arrives. Mapping these to
  // 'paused' (not 'none') keeps iOS's AudioContext-alive hint on so a guest
  // mid-preload with the screen locked doesn't lose audio when playback
  // resumes. 'none' is reserved for the truly idle case.
  if (activity === 'pending') return 'paused';
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

  /** Non-OP guest: block room-level changes & seek, but allow local play/pause.
   *  Users must always be able to pause from lock screen / hardware buttons. */
  const isPlaybackBlocked = (): boolean => {
    if (getRoomContext().kind === 'pro') {
      return !hasRoomCapability('playback.control');
    }
    const hostConn = getState('network.hostConn');
    return !!(hostConn && !hasRoomCapability('playback.control'));
  };
  const isNonOperatorGuest = isPlaybackBlocked;

  navigator.mediaSession.setActionHandler('play', () => {
    if (isPlaybackModeYouTube()) {
      if (isNonOperatorGuest()) {
        bus.emit('youtube:local-toggle-play');
        return;
      }
      togglePlay();
      return;
    }
    const currentQueueItemId = getCurrentQueueItemId();
    if (isPlaybackIdle()) {
      if (isNonOperatorGuest()) return;
      // Try to play from current playlist position instead of blocking
      if (currentQueueItemId) {
        bus.emit('playlist:play-track', currentQueueItemId);
      }
      return;
    }
    // Already playing — bail. Some BT/headphone wrappers can re-fire 'play'
    // even while playbackState='playing', and a togglePlay here would pause
    // the music after the user pressed play. Mirrors the 'pause' handler
    // below which guards the symmetric case.
    if (isPlaybackPlayingFile()) return;
    if (currentQueueItemId) {
      if (isNonOperatorGuest()) {
        // Local resume is only valid when the pause was LOCAL (this guest
        // paused via lock screen / BT button while the host kept playing —
        // SYNC_PONG re-locks position after resume). If the flag is clear,
        // the pause is ROOM-level (host PAUSE cleared it in playback.ts):
        // a lone guest resuming would play solo in a multi-device room. The
        // room resumes via the host's next PLAY broadcast.
        if (!isLocalFilePaused()) return;
        // Clear the flag so the next SYNC_PONG re-locks this guest to the
        // host position (network/sync.ts).
        setLocalFilePaused(false);
        void play(getState('player.pausedAt') || 0);
        return;
      }
      togglePlay();
    }
  });

  navigator.mediaSession.setActionHandler('pause', () => {
    if (isPlaybackModeYouTube()) {
      if (isNonOperatorGuest()) {
        bus.emit('youtube:local-toggle-play');
        return;
      }
      togglePlay();
      return;
    }
    if (isPlaybackPlayingFile()) {
      if (isNonOperatorGuest()) {
        // Local pause: mark it so the host's SYNC_PONG bootstrap/drift in
        // network/sync.ts does not auto-resume this guest within ~1s.
        setLocalFilePaused(true);
        pause(undefined, { showToast: false });
        return;
      }
      togglePlay();
    }
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

  // Keep the Media Session state aligned with playback activity. Web Audio has
  // no media element from which the browser can infer this state; the explicit
  // value also allows iOS to preserve background playback for an active PWA.
  bus.on('state:playback.activity', (activity) => {
    if (!('mediaSession' in navigator)) return;
    if (!isPlaybackActivityValue(activity)) return;
    navigator.mediaSession.playbackState = mediaSessionStateFromActivity(activity);
  });

  log.info('[MediaSession] Initialized');
}
