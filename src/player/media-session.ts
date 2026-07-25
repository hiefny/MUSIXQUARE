/**
 * MUSIXQUARE — Media Session API
 *
 * Manages: System media controls (lock screen, notification area),
 * track metadata display.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MSG, type PlaybackActivityValue } from '../core/constants.ts';
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
import type { PlaylistItem } from '../types/index.ts';
import { getTrackDisplayTitle } from './track-display.ts';
import { getRoomContext, hasRoomCapability } from '../rooms/authority.ts';
import { routeProPlaybackCommand } from '../pro-room/playback-authority-hooks.ts';
import { isLocalYouTubePaused } from '../youtube/_state.ts';
import {
  hasPendingAudioContextInterruption,
  resumePendingAudioContextInterruptionFromGesture,
} from '../audio/context-recovery.ts';

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

  let title = getTrackDisplayTitle(item, 'Unknown Track');
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

  type YouTubeMediaSessionAction = 'play' | 'pause';
  type YouTubeStableActivity = 'playing' | 'paused';

  // Some OS/headphone controls are applied to the YouTube iframe before the
  // top-level Media Session callback runs. Preserve that exact paused<->playing
  // edge briefly so the callback can still promote it to room authority.
  const PREAPPLIED_YOUTUBE_ACTION_WINDOW_MS = 2_500;
  let observedPlaybackMode = getState('playback.mode');
  let observedPlaybackActivity = getState('playback.activity');
  let recentYouTubeTransition: {
    from: YouTubeStableActivity;
    to: YouTubeStableActivity;
    at: number;
    consumed: boolean;
  } | null = null;
  let lastRoutedYouTubeAction: {
    action: YouTubeMediaSessionAction;
    at: number;
  } | null = null;

  bus.on('state:playback.mode', () => {
    observedPlaybackMode = getState('playback.mode');
    if (observedPlaybackMode !== 'youtube') recentYouTubeTransition = null;
  });

  bus.on('state:playback.activity', () => {
    const nextMode = getState('playback.mode');
    const nextActivity = getState('playback.activity');
    const previousStableActivity =
      observedPlaybackActivity === 'playing' || observedPlaybackActivity === 'paused'
        ? observedPlaybackActivity
        : null;
    const nextStableActivity =
      nextActivity === 'playing' || nextActivity === 'paused' ? nextActivity : null;

    if (
      nextMode === 'youtube' &&
      observedPlaybackMode === 'youtube' &&
      previousStableActivity &&
      nextStableActivity &&
      previousStableActivity !== nextStableActivity
    ) {
      recentYouTubeTransition = {
        from: previousStableActivity,
        to: nextStableActivity,
        at: Date.now(),
        consumed: false,
      };
    }

    observedPlaybackMode = nextMode;
    observedPlaybackActivity = nextActivity;
  });

  const markRoutedYouTubeAction = (action: YouTubeMediaSessionAction): void => {
    lastRoutedYouTubeAction = { action, at: Date.now() };
  };

  const consumePreappliedYouTubeAction = (action: YouTubeMediaSessionAction): boolean => {
    const desiredActivity: YouTubeStableActivity = action === 'play' ? 'playing' : 'paused';
    const priorActivity: YouTubeStableActivity = action === 'play' ? 'paused' : 'playing';
    if (
      getState('playback.mode') !== 'youtube' ||
      getState('playback.activity') !== desiredActivity
    ) {
      return false;
    }

    const transition = recentYouTubeTransition;
    const now = Date.now();
    if (
      !transition ||
      transition.consumed ||
      transition.from !== priorActivity ||
      transition.to !== desiredActivity ||
      now < transition.at ||
      now - transition.at > PREAPPLIED_YOUTUBE_ACTION_WINDOW_MS
    ) {
      return false;
    }

    transition.consumed = true;
    return !(
      lastRoutedYouTubeAction?.action === action &&
      now >= lastRoutedYouTubeAction.at &&
      now - lastRoutedYouTubeAction.at <= PREAPPLIED_YOUTUBE_ACTION_WINDOW_MS
    );
  };

  const getYouTubePosition = (): number => {
    let positionSeconds = 0;
    bus.emit('youtube:get-position', (position) => {
      if (Number.isFinite(position)) positionSeconds = Math.max(0, position);
    });
    return positionSeconds;
  };

  const requestAuthoritativeYouTubeAction = (action: YouTubeMediaSessionAction): void => {
    const queueItemId = getCurrentQueueItemId();
    if (!queueItemId) return;

    const positionSeconds = getYouTubePosition();
    const room = getRoomContext();
    if (room.kind === 'pro') {
      routeProPlaybackCommand(
        {
          kind: action,
          queueItemId,
          positionSeconds,
        },
        { wasPlaying: action === 'pause' },
      );
      return;
    }

    const hostConn = getState('network.hostConn');
    if (hostConn) {
      if (!hasRoomCapability('playback.control') || hostConn.open !== true) return;
      try {
        if (action === 'play') {
          hostConn.send({ type: MSG.REQUEST_YOUTUBE_PLAY, queueItemId });
        } else {
          hostConn.send({ type: MSG.REQUEST_YOUTUBE_PAUSE, queueItemId });
        }
      } catch (error) {
        log.warn(`[MediaSession] Failed to relay YouTube ${action} intent`, error);
      }
      return;
    }

    // Standard-room host: reuse the existing scheduled YouTube authority path.
    // PLAY therefore receives the precision rendezvous that a raw iframe
    // PLAYING transition cannot provide; PAUSE also cancels any pending PLAY.
    bus.emit('youtube:auto-play', {
      targetTime: positionSeconds,
      skipSeek: false,
      zeroStart: action === 'play' && positionSeconds <= 0.12,
      state: action === 'play' ? 1 : 2,
    });
  };

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

  navigator.mediaSession.setActionHandler('play', () => {
    if (isPlaybackModeYouTube()) {
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
      if (isPlaybackPlayingYouTube()) {
        if (!consumePreappliedYouTubeAction('play')) return;
        markRoutedYouTubeAction('play');
        requestAuthoritativeYouTubeAction('play');
        return;
      }
      markRoutedYouTubeAction('play');
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

  navigator.mediaSession.setActionHandler('pause', () => {
    if (isPlaybackModeYouTube()) {
      if (isNonOperatorGuest()) {
        if (isLocalYouTubePaused()) return;
        bus.emit('youtube:set-local-paused', true);
        return;
      }
      if (!isPlaybackPlayingYouTube()) {
        if (!consumePreappliedYouTubeAction('pause')) return;
        markRoutedYouTubeAction('pause');
        requestAuthoritativeYouTubeAction('pause');
        return;
      }
      markRoutedYouTubeAction('pause');
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
