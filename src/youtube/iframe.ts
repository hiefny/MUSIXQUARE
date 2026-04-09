/**
 * MUSIXQUARE 3.0 — YouTube IFrame API
 *
 * Manages: IFrame API script loading, player creation/destruction,
 * player event callbacks, UI update loop, iOS sync overlay,
 * display refresh hack.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState, setState } from '../core/state.ts';
import { APP_STATE, MSG } from '../core/constants.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { broadcast } from '../network/peer.ts';
import { IS_IOS } from '../core/platform.ts';
import { fmtTime } from '../player/transport.ts';
import { setAppState } from '../player/transport.ts';
import { setEngineMode } from '../player/video.ts';
import {
  getYouTubePlayer, setYouTubePlayer,
  getCurrentSessionId, incrementSessionId,
  isYtScriptLoading, setYtScriptLoading,
  getYtIOSWatchdog, setYtIOSWatchdog,
  replaceYtScope,
  isYtLoadInProgress, setYtLoadInProgress,
  getYtAutoplayIntent, setYtAutoplayIntent,
  getCachedYtDuration, setCachedYtDuration,
  getCachedYtPlaylistIdx, setCachedYtPlaylistIdx,
  setYouTubeSubIndex,
  setSubItemsData,
} from './_state.ts';
import { showToast, showLoader } from '../ui/toast.ts';
import { fetchPlaylistSubTitles } from './search.ts';

declare const YT: any;

/** Tracks the last known YouTube video title to detect changes */
let _lastYtVideoTitle = '';
export let _lastYtStateBroadcast = 0; // Cooldown to prevent duplicate broadcasts from UI + onStateChange
export function markYtStateBroadcast(): void { _lastYtStateBroadcast = Date.now(); }

// ─── Load YouTube Video ────────────────────────────────────────────

export function loadYouTubeVideo(
  videoId: string | null,
  playlistId: string | string[] | null = null,
  autoplay = true,
  subIndex = 0,
): void {
  const player = getYouTubePlayer();

  // Guard: destroy previous player to prevent concurrent player instances
  if (isYtLoadInProgress() && player) {
    try {
      player.stopVideo?.();
      if (typeof player.destroy === 'function') player.destroy();
    } catch { /* best-effort cleanup */ }
    setYouTubePlayer(null);
    const container = document.getElementById('youtube-player-container');
    if (container) container.innerHTML = '<div id="youtube-player"></div>';
  }
  // Stop existing media BEFORE creating new scope/session — otherwise
  // stopYouTubeMode() (triggered by player:stop-all-media) disposes the
  // new scope immediately, causing the first-ever IFrame API load to abort.
  bus.emit('player:stop-all-media');
  setEngineMode('youtube');

  setCachedYtDuration(0); // Reset duration cache for new video
  const sessionId = incrementSessionId();
  const scope = replaceYtScope();
  setYtLoadInProgress(true);

  showToast(t('youtube.effects_disabled'));

  const wrapper = document.querySelector('.video-wrapper');
  if (!wrapper) {
    setYtLoadInProgress(false);
    log.warn('[YouTube] .video-wrapper not found');
    return;
  }

  let container = document.getElementById('youtube-player-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'youtube-player-container';
    container.style.cssText = 'width:100%; height:100%; position:relative;';
    wrapper.appendChild(container);
  }

  if (!getYouTubePlayer()) {
    container.innerHTML = '<div id="youtube-player"></div>';
  }

  const w = window as unknown as Record<string, unknown>;
  if (!w.YT || !(w.YT as Record<string, unknown>).Player) {
    if (!isYtScriptLoading() && !document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      setYtScriptLoading(true);
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.onload = () => { setYtScriptLoading(false); log.debug('[YouTube] API script loaded'); };
      tag.onerror = () => {
        log.error('[YouTube] Failed to load API script');
        setYtScriptLoading(false);
        setYtLoadInProgress(false);
        tag.remove(); // Remove broken script tag so retry can re-insert
        showToast(t('youtube.load_fail'));
      };
      document.head.appendChild(tag);
    }
    w.onYouTubeIframeAPIReady = () => {
      (w as Record<string, boolean>).isYouTubeAPIReady = true;
      // Guard: skip if a timeout already cancelled this load session
      if (getCurrentSessionId() !== sessionId || scope.aborted) {
        log.debug('[YouTube] onYouTubeIframeAPIReady skipped — session changed');
        setYtLoadInProgress(false);
        return;
      }
      createYouTubePlayer(videoId, playlistId as string | string[] | null, autoplay, subIndex);
    };
  } else {
    createYouTubePlayer(videoId, playlistId as string | string[] | null, autoplay, subIndex);
  }

  // Safety timeout
  setManagedTimer('yt-load-timeout', () => {
    if (getCurrentSessionId() === sessionId && !scope.aborted && !getYouTubePlayer()) {
      log.warn('[YouTube] Load timeout triggered.');
      setYtLoadInProgress(false);
      showLoader(false);
      showToast(t('youtube.load_timeout'));
    }
  }, 15000);

  bus.emit('ui:play-btn-state', true);

  const fsBtn = document.querySelector('.fullscreen-btn') as HTMLElement | null;
  if (fsBtn) fsBtn.style.setProperty('display', 'none', 'important');

  setManagedTimer('yt-refresh-display', () => refreshYouTubeDisplay(), 500);
  log.debug('[YouTube] Loaded:', videoId || playlistId, 'autoplay:', autoplay);
}

// ─── Create YouTube Player (IFrame) ────────────────────────────────

function createYouTubePlayer(
  videoId: string | null,
  playlistId: string | string[] | null = null,
  autoplay = true,
  subIndex = 0,
): void {
  const currentState = getState('appState');
  if (currentState !== APP_STATE.PLAYING_YOUTUBE) {
    log.warn('[YouTube] createYouTubePlayer aborted - not in PLAYING_YOUTUBE state');
    setYtLoadInProgress(false);
    return;
  }

  // Set autoplay intent BEFORE any player API call — onStateChange
  // checks this flag to pause-back if autoplay was not requested.
  // Fixes: loadPlaylist() is async, so pauseVideo() on UNSTARTED is a no-op.
  setYtAutoplayIntent(autoplay);

  const existingPlayer = getYouTubePlayer();
  if (existingPlayer?.loadVideoById) {
    log.debug('[YouTube] Re-using existing player instance');
    try {
      if (playlistId) {
        if (Array.isArray(playlistId)) {
          existingPlayer.loadPlaylist(playlistId, subIndex, 0);
        } else {
          existingPlayer.loadPlaylist({ list: playlistId, listType: 'playlist', index: subIndex, startSeconds: 0 });
        }
      } else if (videoId) {
        existingPlayer.loadVideoById(videoId);
      }
      // Note: pauseVideo() removed — handled by onStateChange via _ytAutoplayIntent flag.
      // loadPlaylist() is async; pauseVideo() on UNSTARTED player is a no-op.
      setYouTubeSubIndex(subIndex);
      setYtLoadInProgress(false);
      return;
    } catch (e) {
      log.warn('[YouTube] Failed to reuse player, recreating...', e);
      try { existingPlayer.destroy(); } catch { /* best-effort */ }
      setYouTubePlayer(null);
      const container = document.getElementById('youtube-player-container');
      if (container) container.innerHTML = '<div id="youtube-player"></div>';
    }
  }

  const playerVars: Record<string, any> = {
    autoplay: autoplay ? 1 : 0,
    controls: 0,
    rel: 0,
    modestbranding: 1,
    playsinline: 1,
    origin: window.location.origin,
  };

  if (playlistId) {
    if (Array.isArray(playlistId)) {
      playerVars.playlist = playlistId.join(',');
    } else {
      playerVars.listType = 'playlist';
      playerVars.list = playlistId;
      playerVars.index = subIndex;
    }
  }

  const playerOptions: Record<string, any> = {
    width: '100%',
    height: '100%',
    playerVars,
    events: {
      onReady: () => onYouTubePlayerReady(playlistId),
      onStateChange: onYouTubePlayerStateChange,
      onError: onYouTubePlayerError,
    },
  };

  if (videoId) playerOptions.videoId = videoId;

  setYouTubePlayer(new YT.Player('youtube-player', playerOptions));

  // A11y: add title to iframe once YouTube API creates it
  requestAnimationFrame(() => {
    const iframe = document.querySelector('#youtube-player-container iframe') as HTMLIFrameElement | null;
    if (iframe) iframe.title = 'YouTube video player';
  });
}

// ─── Player Events ─────────────────────────────────────────────────

function onYouTubePlayerReady(playlistId: string | string[] | null = null): void {
  setYtLoadInProgress(false);
  log.debug('[YouTube] Player ready');

  const currentState = getState('appState');
  if (currentState !== APP_STATE.PLAYING_YOUTUBE) {
    log.debug('[YouTube] onPlayerReady skipped - mode changed');
    return;
  }

  const player = getYouTubePlayer();

  // ── YouTube Mix (RD...) Snapshot & Sync (Host Only) ──
  const hostConn = getState('network.hostConn');
  if (!hostConn && typeof playlistId === 'string' && playlistId.startsWith('RD') && player?.getPlaylist) {
    const mixId = playlistId; // Captured for closure
    log.debug('[YouTube Mix] Detected dynamic mix, scheduling host-side snapshot...');
    // Wait a few seconds for YouTube to populate the internal playlist IDs
    setManagedTimer('yt-mix-snapshot', () => {
      try {
        const ids = player.getPlaylist();
        if (Array.isArray(ids) && ids.length > 0) {
          log.info(`[YouTube Mix] Snapshotting ${ids.length} items for sync:`, mixId);
          // Snapshot IDs and clear titles (let fetchPlaylistSubTitles fill them)
          const titles = new Array(ids.length).fill('');
          setSubItemsData(mixId, ids, titles);
          
          // Broadcast to all guests so they use this static list instead of generating their own
          broadcast({
            type: MSG.YOUTUBE_PLAYLIST_INFO,
            playlistId: mixId,
            ids,
            titles
          });

          // Trigger background oEmbed title fetching
          fetchPlaylistSubTitles(mixId, ids);
        }
      } catch (e) {
        log.warn('[YouTube Mix] Snapshot failed:', e);
      }
    }, 3000);
  }

  // Start UI update loop
  clearManagedTimer('youtubeUILoop');
  setManagedTimer('youtubeUILoop', updateYouTubeUI, 500, { interval: true });

  // Only Host runs sync loop
  clearManagedTimer('youtubeSyncLoop');
  if (!hostConn) {
    setManagedTimer('youtubeSyncLoop', () => {
      bus.emit('youtube:broadcast-sync');
    }, 3000, { interval: true });
  }

  // Apply volume
  bus.emit('audio:apply-youtube-volume');
}

function onYouTubePlayerError(event: { data: number }): void {
  log.error('[YouTube] Player error:', event.data);
  setYtLoadInProgress(false);
  showLoader(false);
  showToast(t('youtube.load_fail'));
}

function onYouTubePlayerStateChange(event: { data: number }): void {
  const currentState = getState('appState');
  if (currentState !== APP_STATE.PLAYING_YOUTUBE) return;

  const player = getYouTubePlayer();
  const state = event.data;

  if (state === YT.PlayerState.PLAYING) {
    // Pause-back if autoplay was not intended (e.g. loadPlaylist async path).
    // Reset flag after firing so subsequent user-initiated plays work normally.
    if (!getYtAutoplayIntent()) {
      setYtAutoplayIntent(true);
      player?.pauseVideo?.();
      return; // Don't broadcast or update UI — we're reverting to paused
    }
    showYouTubeSyncOverlay(false);
    bus.emit('ui:update-play-state', true);
  } else if (state === YT.PlayerState.PAUSED) {
    bus.emit('ui:update-play-state', false);
  } else if (state === YT.PlayerState.ENDED) {
    clearManagedTimer('youtubeUILoop');
    clearManagedTimer('youtubeSyncLoop');

    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      // Host: skip IDLE state transition to prevent UI flash — next-track
      // will call stopAllMedia({ silent: true }) which handles state internally.
      log.debug('[YouTube] Ended, playing next track...');
      bus.emit('playlist:next-track');
    } else {
      // Guest: set IDLE and clean up orphaned player
      setAppState(APP_STATE.IDLE);
      bus.emit('youtube:stop-mode');
    }
    return; // Don't broadcast ENDED — guest handles locally, prevents race with next-track
  }

  // Host broadcasts state to guests (skip if UI already broadcast within 300ms)
  const hostConn = getState('network.hostConn');
  const now = Date.now();
  if (!hostConn && player?.getCurrentTime && now - _lastYtStateBroadcast > 300) {
    _lastYtStateBroadcast = now;
    broadcast({
      type: MSG.YOUTUBE_STATE,
      state,
      time: player.getCurrentTime(),
      subIndex: player.getPlaylistIndex?.() ?? -1,
      videoId: player.getVideoData?.()?.video_id || '',
    });
  }
}

// ─── YouTube UI Update Loop ────────────────────────────────────────

function updateYouTubeUI(): void {
  const player = getYouTubePlayer();
  const currentState = getState('appState');
  if (!player || currentState !== APP_STATE.PLAYING_YOUTUBE || !player.getCurrentTime) return;

  try {
    const currentTime = player.getCurrentTime();
    const rawDuration = player.getDuration?.() || 0;
    const playlistIdx = player.getPlaylistIndex?.() ?? -1;
    const state = player.getPlayerState?.() ?? -1;

    // iOS watchdog: only trigger on UNSTARTED (-1), not CUED (5)
    // state=5 (CUED) is a normal pre-play state, not a playback failure
    if (IS_IOS && state === -1) {
      if (!getYtIOSWatchdog()) setYtIOSWatchdog(Date.now());
      if (Date.now() - getYtIOSWatchdog()! > 3000) {
        showYouTubeSyncOverlay(true);
      }
    } else {
      setYtIOSWatchdog(null);
    }

    // Reset cache when playlist sub-index changes (= different video)
    if (playlistIdx !== getCachedYtPlaylistIdx()) {
      setCachedYtPlaylistIdx(playlistIdx);
      setCachedYtDuration(0);
      _lastYtVideoTitle = ''; // Reset title cache to force update on index change

      // Pre-emptive title update from subItemsMap (if available) for instant feedback
      const currentTrack = (getState('playlist.items') || [])[getState('playlist.currentTrackIndex')];
      if (currentTrack?.playlistId && playlistIdx >= 0) {
        const subMap = getState('youtube.subItemsMap') || {};
        const cachedTitle = subMap[currentTrack.playlistId]?.titles?.[playlistIdx];
        if (cachedTitle) {
          const currentMeta = getState('player.currentTrackMeta') || {};
          setState('player.currentTrackMeta', { ...currentMeta, title: cachedTitle });
          _lastYtVideoTitle = cachedTitle;
        }
      }
    }

    // Update track title whenever YouTube video title changes
    if (player.getVideoData) {
      const vData = player.getVideoData();
      if (vData?.title && vData.title !== _lastYtVideoTitle) {
        _lastYtVideoTitle = vData.title;
        const currentMeta = getState('player.currentTrackMeta') || {};
        setState('player.currentTrackMeta', { ...currentMeta, title: vData.title });
      }
    }

    // Lock duration on first valid read — stays locked until video changes
    if (rawDuration > 0 && getCachedYtDuration() === 0) {
      setCachedYtDuration(rawDuration);
    }

    const cachedDuration = getCachedYtDuration();
    if (cachedDuration > 0) {
      bus.emit('ui:time-update', fmtTime(currentTime), fmtTime(cachedDuration), currentTime, cachedDuration);
    }
  } catch {
    // Player not ready
  }
}

// ─── iOS Sync Overlay ──────────────────────────────────────────────

function showYouTubeSyncOverlay(show: boolean): void {
  const overlayId = 'youtube-ios-sync-overlay';
  let overlay = document.getElementById(overlayId);

  if (show) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = overlayId;
      overlay.style.cssText = `
        position:absolute;top:0;left:0;width:100%;height:100%;
        background:rgba(0,0,0,0.6);display:flex;align-items:center;
        justify-content:center;z-index:100;cursor:pointer;
        backdrop-filter:blur(4px);animation:fadeIn 0.3s ease-out;
      `;
      overlay.onclick = () => {
        const player = getYouTubePlayer();
        if (player?.playVideo) {
          player.playVideo();
          showYouTubeSyncOverlay(false);
        }
      };
      overlay.innerHTML = `
        <div style="background:var(--primary);color:white;padding:12px 24px;border-radius:100px;font-weight:bold;font-size:14px;box-shadow:0 4px 15px rgba(0,0,0,0.3);display:flex;align-items:center;gap:8px;">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M8 5v14l11-7z"/></svg>
          ${t('youtube.tap_to_sync')}
        </div>
      `;
      const wrapper = document.querySelector('.video-wrapper');
      if (wrapper) wrapper.appendChild(overlay);
    }
    overlay.style.display = 'flex';
  } else if (overlay) {
    overlay.style.display = 'none';
    setYtIOSWatchdog(null);
  }
}

// ─── Refresh Display Hack ──────────────────────────────────────────

export function refreshYouTubeDisplay(): void {
  const container = document.getElementById('youtube-player-container');
  const currentState = getState('appState');
  if (!container || currentState !== APP_STATE.PLAYING_YOUTUBE) return;

  log.debug('[YouTube] Refreshing display to prevent black screen...');
  const iframe = container.querySelector('iframe');

  container.style.display = 'none';
  void container.offsetHeight; // Force reflow
  container.style.display = 'block';

  if (iframe) {
    iframe.style.visibility = 'hidden';
    void iframe.offsetHeight;
    iframe.style.visibility = 'visible';
  }

  window.dispatchEvent(new Event('resize'));
}
