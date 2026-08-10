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
import { togglePlay, stopPlayback, skipTime, pause } from './transport.ts';
import { setLocalFilePaused } from './_state.ts';
import {
  isPlaybackActivityValue,
  isPlaybackIdle,
  isPlaybackModeYouTube,
  isPlaybackPlayingFile,
  isPlaybackPlayingYouTube,
} from './ownership.ts';
import { getCurrentQueueItemId } from './queue-model.ts';
import type { TrackMeta } from '../types/index.ts';
import { getTrackDisplayTitle } from './track-display.ts';
import { getRoomContext, hasRoomCapability } from '../rooms/authority.ts';
import { isLocalYouTubePaused } from '../youtube/_state.ts';
import {
  hasPendingAudioContextInterruption,
  resumePendingAudioContextInterruptionFromGesture,
} from '../audio/context-recovery.ts';
import {
  initYouTubeNativeControlAuthority,
  shouldIgnoreRecentNativeYouTubeMediaAction,
} from '../youtube/native-control-authority.ts';
import { t } from '../i18n/index.ts';

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

function registerMediaSessionAction(
  action: MediaSessionAction,
  handler: MediaSessionActionHandler,
): void {
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch (error) {
    // Media Session implementations commonly expose only a subset of actions.
    // Isolate registration failures without masking exceptions thrown later by
    // a successfully-installed application handler.
    log.debug(`[MediaSession] ${action} action is unavailable:`, error);
  }
}

// ─── Metadata Update ───────────────────────────────────────────────

export function updateMediaSessionMetadata(item: Partial<TrackMeta> | null): void {
  if (!('mediaSession' in navigator)) return;
  if (!item) {
    navigator.mediaSession.metadata = null;
    return;
  }

  let title =
    item.systemAudioMode === 'receiving'
      ? t('system_audio.receiving')
      : item.systemAudioMode === 'sharing'
        ? t('system_audio.sharing')
        : getTrackDisplayTitle(item, t('common.unknown'));
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
        title = `${item.title || t('nav.playlist')} (${currentYouTubeSubIndex + 1})`;
      }
    }

    const thumb = item.thumbnail;
    if (thumb) {
      artwork = [{ src: thumb, sizes: '480x360', type: 'image/jpeg' }];
    }
  } else {
    artwork = [{ src: '/favicon.svg', sizes: '512x512', type: 'image/svg+xml' }];
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
  initYouTubeNativeControlAuthority();
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

  const requestLocalPlay = (mode: 'file' | 'youtube'): void => {
    const emitRejoin = (): void => {
      if (mode === 'youtube') {
        bus.emit('youtube:set-local-paused', false, 'media-session-play');
        return;
      }
      bus.emit('playback:local-output-rejoin', {
        reason: 'media-session-play',
        mode,
      });
    };

    if (!hasPendingAudioContextInterruption()) {
      emitRejoin();
      return;
    }
    void resumePendingAudioContextInterruptionFromGesture().then((result) => {
      // A successful context recovery emits its own identity-fenced rejoin.
      // If playback changed while the output was suspended, that old identity
      // is deliberately dropped and this trusted PLAY queries the *current*
      // room authority exactly once instead.
      if (result.running && !result.rejoinEmitted) emitRejoin();
    });
  };

  registerMediaSessionAction('play', () => {
    if (isPlaybackModeYouTube()) {
      if (shouldIgnoreRecentNativeYouTubeMediaAction('play')) return;
      if (hasPendingAudioContextInterruption() && isPlaybackPlayingYouTube()) {
        requestLocalPlay('youtube');
        return;
      }
      if (isNonOperatorGuest()) {
        // A play action is not a toggle. Rejoin from the authoritative room
        // timeline instead of resuming the iframe at its stale local time.
        // Ignore duplicate wrapper-generated PLAY events while already live.
        if (!isLocalYouTubePaused() && isPlaybackPlayingYouTube()) return;
        requestLocalPlay('youtube');
        return;
      }
      if (isPlaybackPlayingYouTube()) return;
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
    if (isPlaybackPlayingFile()) {
      if (hasPendingAudioContextInterruption()) requestLocalPlay('file');
      return;
    }
    if (currentQueueItemId) {
      if (isNonOperatorGuest()) {
        // Query the authoritative timeline even if a browser/OS suspension
        // lost the local-pause flag. A room-level pause remains paused because
        // this local-only path never manufactures a room PLAY command.
        requestLocalPlay('file');
        return;
      }
      togglePlay();
    }
  });

  registerMediaSessionAction('pause', () => {
    if (isPlaybackModeYouTube()) {
      if (shouldIgnoreRecentNativeYouTubeMediaAction('pause')) return;
      if (isNonOperatorGuest()) {
        if (isLocalYouTubePaused()) return;
        bus.emit('youtube:set-local-paused', true);
        return;
      }
      if (!isPlaybackPlayingYouTube()) return;
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

  registerMediaSessionAction('previoustrack', () => {
    if (isPlaybackBlocked()) return;
    bus.emit('playlist:prev-track');
  });

  registerMediaSessionAction('nexttrack', () => {
    if (isPlaybackBlocked()) return;
    bus.emit('playlist:next-track');
  });

  registerMediaSessionAction('seekbackward', (details) => {
    if (isPlaybackBlocked()) return;
    skipTime(-(details.seekOffset || 10));
  });

  registerMediaSessionAction('seekforward', (details) => {
    if (isPlaybackBlocked()) return;
    skipTime(details.seekOffset || 10);
  });

  registerMediaSessionAction('stop', () => {
    if (isPlaybackBlocked()) return;
    stopPlayback();
  });

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

  // Synthetic/fallback titles are locale-owned display text. Re-publish the
  // current canonical metadata when the user changes language so the OS lock
  // screen and notification do not retain the previous locale.
  bus.on('i18n:changed', () => {
    updateMediaSessionMetadata(getState('player.currentTrackMeta') ?? null);
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
