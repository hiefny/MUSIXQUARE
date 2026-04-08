/**
 * MUSIXQUARE 3.0 — YouTube Player
 *
 * Module coordinator: stopYouTubeMode, initYouTube (bus event wiring),
 * and re-exports from sub-modules.
 *
 * Sub-modules:
 *   _state.ts    — Shared module state (getters/setters)
 *   iframe.ts    — IFrame API loading, player creation, UI loop
 *   handlers.ts  — Protocol message handlers
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, APP_STATE } from '../core/constants.ts';
import { clearManagedTimer } from '../core/timers.ts';
import { setAppState } from '../player/transport.ts';
import { broadcast, safeSend, sendToHost } from '../network/peer.ts';
import { getHostNow } from '../network/shared-clock.ts';

const SCHEDULE_AHEAD_MS = 200;
import { registerHandlers } from '../network/protocol.ts';
import { fetchYouTubePreview, extractYouTubeVideoId, extractYouTubePlaylistId, fetchOEmbedTitle, fetchPlaylistSubTitles } from './search.ts';
import type { PlaylistItem } from '../types/index.ts';

// ─── Sub-module imports ────────────────────────────────────────────

import {
  getYouTubePlayer, setYouTubePlayer,
  isYtLoadInProgress, setYtLoadInProgress,
  getYtScope, setYtScope,
  setCachedYtDuration,
  setYtAutoplayIntent,
  setYouTubeSubIndex,
  updateSubItemIds,
} from './_state.ts';

import { loadYouTubeVideo, refreshYouTubeDisplay, markYtStateBroadcast } from './iframe.ts';

import {
  handleYouTubePlay,
  handleRequestYouTubePlay,
  handleRequestYouTubePause,
  handleRequestYouTubeToggle,
  handleRequestYouTubeSubSeek,
  handleRequestYouTubePlaylistInfo,
} from './handlers.ts';
import { showToast } from '../ui/toast.ts';

declare const YT: any;

// ─── Re-exports ────────────────────────────────────────────────────
// External modules (e.g. sync.ts) import { getYouTubePlayer } from './player.ts'

export { getYouTubePlayer } from './_state.ts';
export { loadYouTubeVideo } from './iframe.ts';

// ─── Stop YouTube Mode ─────────────────────────────────────────────

export function stopYouTubeMode(): void {
  getYtScope()?.dispose();
  setYtScope(null);
  setYtLoadInProgress(false);
  setCachedYtDuration(0); // Reset duration cache
  setYouTubeSubIndex(-1);

  // Only broadcast YOUTUBE_STOP when actually leaving YouTube mode
  // (prevents spurious stop from stopAllMedia→stopYouTubeMode inside loadYouTubeVideo
  //  which would kill the guest's YouTube player right after YOUTUBE_PLAY)
  const currentState = getState('appState');
  const wasInYouTube = currentState === APP_STATE.PLAYING_YOUTUBE;

  if (wasInYouTube) {
    setAppState(APP_STATE.IDLE);
  }

  clearManagedTimer('youtubeUILoop');
  clearManagedTimer('youtubeSyncLoop');

  clearManagedTimer('yt-load-timeout');

  const player = getYouTubePlayer();
  if (player) {
    try {
      log.debug('[YouTube] Destroying player instance...');
      player.stopVideo();
      if (typeof player.destroy === 'function') player.destroy();
    } catch (e: unknown) {
      log.debug('[YouTube] Cleanup error (non-critical):', (e as Error).message);
    }
    setYouTubePlayer(null);
  }

  const container = document.getElementById('youtube-player-container');
  if (container) container.innerHTML = '';

  // Remove iOS sync overlay if present (prevents orphaned overlay on mode exit)
  const iosOverlay = document.getElementById('youtube-ios-sync-overlay');
  if (iosOverlay) iosOverlay.remove();

  const videoEl = document.getElementById('main-video') as HTMLVideoElement | null;
  if (videoEl) {
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.style.display = 'none';
    videoEl.load();
  }

  const fsBtn = document.querySelector('.fullscreen-btn') as HTMLElement | null;
  if (fsBtn) {
    fsBtn.style.removeProperty('display');
    fsBtn.style.display = '';
  }

  // Notify guests to stop YouTube (Host only) — only when actually leaving YouTube mode
  if (wasInYouTube) {
    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      broadcast({ type: MSG.YOUTUBE_STOP });
    }
  }

  log.debug('[YouTube] Mode stopped');
}

// ─── Init ──────────────────────────────────────────────────────────

export function initYouTube(): void {
  registerHandlers({
    [MSG.YOUTUBE_PLAY]: handleYouTubePlay,
    [MSG.REQUEST_YOUTUBE_PLAY]: handleRequestYouTubePlay,
    [MSG.REQUEST_YOUTUBE_PAUSE]: handleRequestYouTubePause,
    [MSG.REQUEST_YOUTUBE_TOGGLE]: handleRequestYouTubeToggle,
    [MSG.REQUEST_YOUTUBE_SUB_SEEK]: handleRequestYouTubeSubSeek,
    [MSG.REQUEST_YOUTUBE_PLAYLIST_INFO]: handleRequestYouTubePlaylistInfo,
  });

  // Bus event handlers from other modules
  bus.on('youtube:stop-mode', () => stopYouTubeMode());

  bus.on('youtube:load', (videoId, playlistId, autoplay, subIndex) => {
    loadYouTubeVideo(videoId as string, playlistId as string | null, autoplay as boolean, subIndex ?? 0);
  });

  bus.on('youtube:toggle-play', () => {
    if (isYtLoadInProgress()) {
      log.debug('[YouTube] Load already in progress, ignoring toggle');
      return;
    }

    const hostConn = getState('network.hostConn');
    const isOperator = getState('network.isOperator');

    if (hostConn && isOperator) {
      // OP sends toggle request — let host decide based on ITS player state
      // (Guest's local player may be desynchronized from host due to ads/buffering)
      safeSend(hostConn, { type: MSG.REQUEST_YOUTUBE_TOGGLE });
      return;
    }

    // Non-OP guest: no toggle permission
    if (hostConn) return;

    // Host direct — broadcast IMMEDIATELY, then control iframe
    const player = getYouTubePlayer();
    if (!player) return;
    try {
      const state = player.getPlayerState();
      const currentTime = player.getCurrentTime?.() || 0;
      if (state === YT.PlayerState.PLAYING) {
        broadcast({
          type: MSG.YOUTUBE_STATE,
          state: 2, // PAUSED
          time: currentTime,
          subIndex: player.getPlaylistIndex?.() ?? -1,
          videoId: player.getVideoData?.()?.video_id || '',
          hostPlayAt: getHostNow() + SCHEDULE_AHEAD_MS,
        });
        player.pauseVideo();
      } else {
        broadcast({
          type: MSG.YOUTUBE_STATE,
          state: 1, // PLAYING
          time: currentTime,
          subIndex: player.getPlaylistIndex?.() ?? -1,
          videoId: player.getVideoData?.()?.video_id || '',
          hostPlayAt: getHostNow() + SCHEDULE_AHEAD_MS,
        });
        player.playVideo();
      }
      markYtStateBroadcast(); // Prevent duplicate from onStateChange
    } catch (e) {
      log.error('[YouTube] Toggle play error:', e);
    }
  });

  bus.on('youtube:auto-play', () => {
    const player = getYouTubePlayer();
    if (player?.playVideo) {
      setYtAutoplayIntent(true); // Prevent onStateChange PLAYING handler from pausing back
      player.playVideo();
      bus.emit('youtube:broadcast-sync');
    }
  });

  bus.on('youtube:get-position', (callback) => {
    if (typeof callback === 'function') {
      try {
        const player = getYouTubePlayer();
        const pos = player?.getCurrentTime?.() ?? 0;
        callback(Number.isFinite(pos) && pos >= 0 ? pos : 0);
      } catch {
        callback(0);
      }
    }
  });

  bus.on('youtube:stop-playback', () => {
    const player = getYouTubePlayer();
    if (!player) return;
    try {
      player.stopVideo();
      try { player.seekTo(0, true); } catch { /* noop */ }
      broadcast({ type: MSG.YOUTUBE_STATE, state: -1, time: 0 });
    } catch (e) {
      log.error('[YouTube] Stop error:', e);
    }
  });

  bus.on('youtube:skip-time', (seconds) => {
    const player = getYouTubePlayer();
    if (!player) return;
    try {
      const current = player.getCurrentTime();
      const duration = player.getDuration();
      let target = current + seconds;
      if (target < 0) target = 0;
      if (target > duration) target = duration;
      // Broadcast BEFORE seek — guests react instantly
      markYtStateBroadcast();
      const hostConn = getState('network.hostConn');
      if (!hostConn) {
        broadcast({
          type: MSG.YOUTUBE_STATE,
          state: player.getPlayerState(),
          time: target,
          subIndex: player.getPlaylistIndex?.() ?? -1,
          videoId: player.getVideoData?.()?.video_id || '',
          hostPlayAt: getHostNow() + SCHEDULE_AHEAD_MS,
        });
      }
      player.seekTo(target, true);
    } catch (e) {
      log.error('[YouTube] Skip time error:', e);
    }
  });

  // YouTube seek from seek bar
  bus.on('youtube:seek-to', (seconds) => {
    const player = getYouTubePlayer();
    if (!player?.seekTo || !Number.isFinite(seconds)) return;
    try {
      const hostConn = getState('network.hostConn');
      if (!hostConn) {
        // Broadcast BEFORE seek — guests react instantly
      markYtStateBroadcast();
        broadcast({
          type: MSG.YOUTUBE_STATE,
          state: player.getPlayerState?.() ?? 1,
          time: seconds,
          subIndex: player.getPlaylistIndex?.() ?? -1,
          videoId: player.getVideoData?.()?.video_id || '',
          hostPlayAt: getHostNow() + SCHEDULE_AHEAD_MS,
        });
      }
      player.seekTo(seconds, true);
    } catch (e) {
      log.error('[YouTube] Seek error:', e);
    }
  });

  bus.on('youtube:try-next-internal', (callback) => {
    const player = getYouTubePlayer();
    if (!player?.getPlaylist || typeof callback !== 'function') { callback(false); return; }
    try {
      const ids = player.getPlaylist() || [];
      const idx = player.getPlaylistIndex();
      if (ids.length > 0 && idx < ids.length - 1) {
        player.nextVideo();
        const nextIdx = idx + 1;
        setYouTubeSubIndex(nextIdx);
        broadcast({ type: MSG.YOUTUBE_STATE, state: 1, time: 0, subIndex: nextIdx });
        callback(true);
        return;
      }
    } catch { /* noop */ }
    callback(false);
  });

  bus.on('youtube:try-prev-internal', (callback) => {
    const player = getYouTubePlayer();
    if (!player || typeof callback !== 'function') { callback(false); return; }
    try {
      const currentTime = player.getCurrentTime();
      if (currentTime > 3) {
        player.seekTo(0, true);
        broadcast({ type: MSG.YOUTUBE_STATE, state: player.getPlayerState(), time: 0 });
        callback(true);
        return;
      }
      const ids = player.getPlaylist?.() || [];
      const idx = player.getPlaylistIndex?.() ?? -1;
      if (ids.length > 0 && idx > 0) {
        player.previousVideo();
        const prevIdx = idx - 1;
        setYouTubeSubIndex(prevIdx);
        broadcast({ type: MSG.YOUTUBE_STATE, state: 1, time: 0, subIndex: prevIdx });
        callback(true);
        return;
      }
    } catch { /* noop */ }
    callback(false);
  });

  bus.on('youtube:broadcast-sync', () => {
    // Imported dynamically to avoid circular deps
    import('./sync.ts').then(mod => mod.broadcastYouTubeSync());
  });

  // YouTube preview (from URL input)
  bus.on('youtube:preview', (url) => {
    fetchYouTubePreview(url || '');
  });

  /**
   * Shared helper: add a YouTube entry to the playlist, broadcast, load, and fetch title.
   * Used by both `youtube:load-from-input` and `youtube:load-from-chat`.
   */
  function _addYouTubeToPlaylist(
    videoId: string | null,
    playlistId: string | null,
    title: string,
    url: string,
  ): void {
    const playlist = getState('playlist.items') || [];
    const newTrack: PlaylistItem = {
      type: 'youtube',
      name: title,
      title: title,
      videoId: videoId || null,
      playlistId: playlistId || null,
    };
    const updatedPlaylist = [...playlist, newTrack];
    setState('playlist.items', updatedPlaylist);
    const newIndex = updatedPlaylist.length - 1;
    const currentState = getState('appState');
    const isIdle = currentState === APP_STATE.IDLE;
    const shouldPlayNow = isIdle;

    if (shouldPlayNow) {
      setState('player.currentTrackMeta', newTrack);
      // Load YouTube — sets currentTrackIndex AFTER stopAllMedia to avoid
      // a window where index points to new track while old media is active.
      loadYouTubeVideo(videoId, playlistId, true);
      setState('playlist.currentTrackIndex', newIndex);
    } else {
      showToast(t('youtube.added_to_playlist'));
    }

    // Broadcast playlist update + YouTube command to peers (Host only)
    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      const metaList = updatedPlaylist.map(item => ({
        type: item.type,
        name: item.name,
        title: item.title || item.name,
        videoId: item.videoId || null,
        playlistId: item.playlistId || null,
      }));
      broadcast({ type: MSG.PLAYLIST_UPDATE, list: metaList });

      if (shouldPlayNow) {
        broadcast({
          type: MSG.YOUTUBE_PLAY,
          videoId,
          playlistId,
          index: newIndex,
          autoplay: true,
        });
      }
    }

    // Fetch title in background and update — capture the expected videoId/playlistId
    // to guard against stale playlist index if the playlist changes before fetch resolves
    const expectedVideoId = videoId;
    const expectedPlaylistId = playlistId;
    fetchOEmbedTitle(url).then(fetchedTitle => {
      if (!fetchedTitle) return;
      const currentPlaylist = getState('playlist.items') || [];
      // Verify the item at newIndex still matches what we expect
      const item = currentPlaylist[newIndex];
      if (item && item.videoId === expectedVideoId && item.playlistId === expectedPlaylistId) {
        const updated = [...currentPlaylist];
        updated[newIndex] = { ...updated[newIndex], name: fetchedTitle, title: fetchedTitle };
        setState('playlist.items', updated);
        setState('player.currentTrackMeta', updated[newIndex]);

        // Broadcast updated title to peers (Host only)
        if (!hostConn) {
          const metaList = updated.map(it => ({
            type: it.type,
            name: it.name,
            title: it.title || it.name,
            videoId: it.videoId || null,
            playlistId: it.playlistId || null,
          }));
          broadcast({ type: MSG.PLAYLIST_UPDATE, list: metaList });
        }
      }
    }).catch(e => log.warn('[YouTube] Title fetch handler error:', e));
  }

  // YouTube load from input field
  bus.on('youtube:load-from-input', () => {
    const input = document.getElementById('youtube-url-input') as HTMLElement | null;
    if (!input) return;
    const url = (input.textContent || '').trim();
    if (!url) {
      showToast(t('youtube.enter_link_toast'));
      return;
    }

    const videoId = extractYouTubeVideoId(url);
    const playlistId = extractYouTubePlaylistId(url);

    if (!videoId && !playlistId) {
      showToast(t('youtube.not_valid_link'));
      return;
    }

    // Get title from preview UI BEFORE hiding it (innerText returns '' for hidden elements)
    const previewTitle = document.getElementById('youtube-preview-title');
    const titleText = previewTitle?.textContent?.trim() || url;

    // Close the overlay + reset preview UI
    const overlay = document.getElementById('youtube-url-overlay');
    if (overlay) overlay.classList.remove('active');
    input.textContent = '';
    const previewEl = document.getElementById('youtube-preview');
    if (previewEl) previewEl.style.display = 'none';
    const statusEl = document.getElementById('youtube-preview-status');
    if (statusEl) { statusEl.style.display = ''; statusEl.textContent = t('youtube.enter_link_prompt'); }
    const playBtnEl = document.getElementById('youtube-play-btn') as HTMLButtonElement | null;
    if (playBtnEl) playBtnEl.disabled = true;

    _addYouTubeToPlaylist(videoId, playlistId, titleText, url);
  });

  // YouTube refresh display (from tab switch)
  bus.on('youtube:refresh-display', () => {
    refreshYouTubeDisplay();
  });

  // YouTube set volume (from audio engine)
  bus.on('youtube:set-volume', (volumePercent) => {
    const player = getYouTubePlayer();
    if (player?.setVolume && Number.isFinite(volumePercent)) {
      player.setVolume(volumePercent);
    }
  });

  // YouTube sub-item seek (from playlist-view sub-item click)
  bus.on('youtube:sub-seek', (playlistIdx, subIdx, isCurrent) => {
    const player = getYouTubePlayer();
    if (!player) return;

    if (isCurrent) {
      // Same playlist — just jump to sub-index
      if (player.playVideoAt) {
        player.playVideoAt(subIdx);
        setYouTubeSubIndex(subIdx);
        broadcast({
          type: MSG.YOUTUBE_STATE,
          state: 1,
          time: 0,
          subIndex: subIdx,
        });
      }
    } else {
      // Different playlist item — load it with the target sub-index
      bus.emit('playlist:play-track', playlistIdx, subIdx);
    }
  });

  // Populate sub-items when expanding a YouTube playlist entry
  bus.on('youtube:populate-sub-items', (playlistId, _playlistIdx) => {
    if (!playlistId) return;

    let ids: string[] = [];
    const player = getYouTubePlayer();

    // 1. Try to get IDs from current player if it matches the requested playlist
    const playlist = getState('playlist.items') || [];
    const currentTrackIndex = getState('playlist.currentTrackIndex');
    const currentItem = playlist[currentTrackIndex];

    if (player?.getPlaylist && currentItem?.playlistId === playlistId) {
      try {
        ids = player.getPlaylist() || [];
      } catch { /* YouTube player may not be ready */ }
    }

    // 2. Initial map setup
    if (ids.length > 0) {
      const subMap = getState('youtube.subItemsMap') || {};
      if (!subMap[playlistId]?.ids?.length) {
        updateSubItemIds(playlistId, ids);
      }
    }

    // 3. Trigger background title fetcher (All roles)
    const currentSubMap = getState('youtube.subItemsMap') || {};
    if (currentSubMap[playlistId]?.ids?.length > 0) {
      fetchPlaylistSubTitles(playlistId, currentSubMap[playlistId].ids);
    }

    // 4. Guest: Request info from Host if sub-item data is missing
    const hostConn = getState('network.hostConn');
    if (hostConn) {
      if (!currentSubMap[playlistId] || !currentSubMap[playlistId].ids || currentSubMap[playlistId].ids.length === 0) {
        sendToHost({ type: MSG.REQUEST_YOUTUBE_PLAYLIST_INFO, playlistId });
      }
    }
  });

  // YouTube load from chat message link
  bus.on('youtube:load-from-chat', (url) => {
    if (!url) return;

    // Host-only guard
    const hostConn = getState('network.hostConn');
    if (hostConn) {
      showToast(t('toast.host_only_youtube'));
      return;
    }

    const videoId = extractYouTubeVideoId(url);
    const playlistId = extractYouTubePlaylistId(url);
    if (!videoId && !playlistId) {
      showToast(t('youtube.invalid_link'));
      return;
    }

    // Close chat drawer if open
    bus.emit('ui:close-chat-drawer');

    _addYouTubeToPlaylist(videoId, playlistId, url, url);
  });

  // Host: Send YouTube state to newly connected peer (late-join bootstrap)
  bus.on('network:peer-connected', (conn) => {
    if (!conn?.open) return;

    // Only Host bootstraps guests
    const hostConn = getState('network.hostConn');
    if (hostConn) return;

    const currentState = getState('appState');
    if (currentState !== APP_STATE.PLAYING_YOUTUBE) return;

    const playlist = getState('playlist.items') || [];
    const currentTrackIndex = getState('playlist.currentTrackIndex');
    const item = playlist[currentTrackIndex];

    if (!item || item.type !== 'youtube') return;

    const player = getYouTubePlayer();

    try {
      let ytTime = 0;
      let ytState = 2; // paused

      try {
        if (player?.getCurrentTime) ytTime = player.getCurrentTime();
        if (player?.getPlayerState) ytState = player.getPlayerState();
      } catch { /* best-effort */ }

      const autoplay = (ytState === 1);
      const currentSubIndex = getState('youtube.currentSubIndex') ?? -1;
      const subIdx = (currentSubIndex >= 0) ? currentSubIndex : 0;

      // Send YouTube play command so guest enters YouTube mode
      conn.send({
        type: MSG.YOUTUBE_PLAY,
        videoId: item.videoId || null,
        playlistId: item.playlistId || null,
        name: item.name || item.title,
        index: currentTrackIndex,
        autoplay,
        subIndex: subIdx,
      });

      // Also send an immediate sync frame
      conn.send({
        type: MSG.YOUTUBE_SYNC,
        time: ytTime,
        state: ytState,
        subIndex: subIdx,
      });

      log.debug('[YouTube] Bootstrap: sent YouTube state to new peer');
    } catch (e) {
      log.warn('[YouTube] Bootstrap send failed:', e);
    }
  });

  log.info('[YouTube] Player initialized');
}
