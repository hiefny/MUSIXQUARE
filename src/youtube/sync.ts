/**
 * MUSIXQUARE 3.0 — YouTube Sync
 *
 * Manages: YouTube state broadcasting (Host), sync reception (Guest),
 * sub-index tracking, drift correction.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, APP_STATE } from '../core/constants.ts';
import { broadcast } from '../network/peer.ts';
import { registerHandlers } from '../network/protocol.ts';
import { getYouTubePlayer, setYouTubeSubIndex, updateSubItemIds, updateSubItemTitle, setSubItemsData } from './_state.ts';
import { fetchPlaylistSubTitles } from './search.ts';

// ─── Broadcast YouTube Sync (Host) ────────────────────────────────

export function broadcastYouTubeSync(): void {
  const player = getYouTubePlayer();
  const hostConn = getState('network.hostConn');
  if (!player || hostConn || !player.getCurrentTime) return;

  try {
    const currentTime = player.getCurrentTime();
    const state = player.getPlayerState ? player.getPlayerState() : -1;

    // Sub-index tracking for playlists
    if (player.getPlaylistIndex) {
      const sIdx = player.getPlaylistIndex();
      const currentYouTubeSubIndex = getState('youtube.currentSubIndex') ?? -1;

      if (sIdx !== currentYouTubeSubIndex) {
        setYouTubeSubIndex(sIdx);

        const playlist = getState('playlist.items') || [];
        const currentTrackIndex = getState('playlist.currentTrackIndex');
        const currentItem = playlist[currentTrackIndex];

        if (currentItem?.playlistId) {
          const pid = currentItem.playlistId as string;

          // Get playlist IDs from player
          if (player.getPlaylist) {
            try {
              const ids = player.getPlaylist();
              if (ids?.length > 0) {
                const subMap = getState('youtube.subItemsMap') || {};
                if (!subMap[pid] || !subMap[pid].ids?.length) {
                  updateSubItemIds(pid, ids);
                }
              }
            } catch { /* noop */ }
          }

          // Get current video title
          if (player.getVideoData) {
            const vData = player.getVideoData();
            if (vData?.title) {
              const subMap = getState('youtube.subItemsMap') || {};
              const existingTitle = subMap[pid]?.titles?.[sIdx];
              if (existingTitle !== vData.title) {
                updateSubItemTitle(pid, sIdx, vData.title);
                broadcast({
                  type: MSG.YOUTUBE_SUB_TITLE_UPDATE,
                  playlistId: pid,
                  subIdx: sIdx,
                  title: vData.title,
                });
              }
            }
          }
        }

        setState('player.currentTrackMeta', playlist[currentTrackIndex]);
      }
    }

    broadcast({
      type: MSG.YOUTUBE_SYNC,
      time: currentTime,
      state,
      subIndex: getState('youtube.currentSubIndex') ?? -1,
    });
  } catch {
    // Player not ready
  }
}

// ─── Host Ad Detection (Guest-side) ──────────────────────────────

let _lastHostSyncTime: number | null = null;
let _hostTimeStaleCount = 0;
let _hostAdPauseActive = false;
const _HOST_AD_STALE_THRESHOLD = 3; // 3 consecutive stale frames ≈ 9s (reduces false positives from network jitter)

export function resetAdDetection(): void {
  _lastHostSyncTime = null;
  _hostTimeStaleCount = 0;
  _hostAdPauseActive = false;
}

// ─── Handle YouTube Sync (Guest) ──────────────────────────────────

function handleYouTubeSync(data: Record<string, unknown>): void {
  const player = getYouTubePlayer();
  const currentState = getState('appState');
  if (!player || currentState !== APP_STATE.PLAYING_YOUTUBE || !player.getCurrentTime) return;

  try {
    const hostTime = Number(data.time) || 0;
    const hostState = Number(data.state);
    const hostSubIndex = data.subIndex as number | undefined;

    // ── Host ad detection ──
    if (hostState === 1) {
      if (_lastHostSyncTime !== null && Math.abs(hostTime - _lastHostSyncTime) < 1.0) {
        _hostTimeStaleCount++;
        if (_hostTimeStaleCount >= _HOST_AD_STALE_THRESHOLD) {
          if (!_hostAdPauseActive) {
            _hostAdPauseActive = true;
            if (player.pauseVideo) player.pauseVideo();
            bus.emit('ui:show-toast', t('toast.host_ad'));
            log.debug('[YouTube Sync] Host ad detected — pausing guest');
          }
          _lastHostSyncTime = hostTime;
          return; // Skip drift correction while ad is playing
        }
      } else {
        // Host time is moving again
        if (_hostAdPauseActive) {
          _hostAdPauseActive = false;
          if (player.playVideo) player.playVideo();
          log.debug('[YouTube Sync] Host ad ended — resuming guest');
        }
        _hostTimeStaleCount = 0;
      }
      _lastHostSyncTime = hostTime;
    } else {
      // Host explicitly paused — reset ad detection
      _hostTimeStaleCount = 0;
      _lastHostSyncTime = null;
      if (_hostAdPauseActive) {
        _hostAdPauseActive = false;
      }
    }

    // Sub-index change
    const currentSubIndex = getState('youtube.currentSubIndex') ?? -1;
    if (hostSubIndex !== undefined && hostSubIndex !== -1 && hostSubIndex !== currentSubIndex) {
      log.debug(`[YouTube Sync] Sub-index change: ${currentSubIndex} -> ${hostSubIndex}`);
      setYouTubeSubIndex(hostSubIndex);

      if (player.playVideoAt && player.getPlaylistIndex) {
        const ytPlaylist = player.getPlaylist?.() || [];
        if (hostSubIndex >= 0 && hostSubIndex < ytPlaylist.length && player.getPlaylistIndex() !== hostSubIndex) {
          try {
            player.playVideoAt(hostSubIndex);
          } catch (e) {
            // Rollback state on failure to keep UI in sync with actual player
            log.warn('[YouTube Sync] playVideoAt failed, rolling back sub-index:', e);
            setYouTubeSubIndex(currentSubIndex);
          }
        }
      }

      const playlist = getState('playlist.items') || [];
      const currentTrackIndex = getState('playlist.currentTrackIndex');
      setState('player.currentTrackMeta', playlist[currentTrackIndex]);
    }

    // Drift correction
    const localOffset = getState('sync.localOffset') || 0;
    const autoSyncOffset = getState('sync.autoSyncOffset') || 0;
    const rawCompensatedTime = hostTime + autoSyncOffset + localOffset;
    // Drift correction (skip if duration not loaded yet)
    const duration = (player.getDuration && player.getDuration()) || 0;
    if (duration > 0) {
      const compensatedTime = Math.max(0, Math.min(rawCompensatedTime, duration));
      const currentTime = player.getCurrentTime();
      const drift = Math.abs(currentTime - compensatedTime);

      if (drift > 2 && player.seekTo) {
        log.debug(`[YouTube Sync] Drift ${drift.toFixed(1)}s, seeking to ${compensatedTime.toFixed(1)}s`);
        player.seekTo(compensatedTime, true);
      }
    }

    // State sync (always applied, even when duration not loaded)
    if (player.getPlayerState && player.playVideo && player.pauseVideo) {
      const ytState = player.getPlayerState();
      if (hostState === 1 && ytState !== 1) player.playVideo();
      else if (hostState === 2 && ytState !== 2) player.pauseVideo();
    }
  } catch (e) {
    log.error('[YouTube Sync] Error:', e);
  }
}

// ─── Handle YouTube State (Host→Guest broadcast) ──────────────────

function handleYouTubeState(data: Record<string, unknown>): void {
  const player = getYouTubePlayer();
  const currentState = getState('appState');
  if (!player || currentState !== APP_STATE.PLAYING_YOUTUBE) return;

  // Skip state sync while host is likely watching an ad
  if (_hostAdPauseActive) return;

  try {
    const state = Number(data.state);
    const time = Number(data.time) || 0;

    // Handle sub-index change from Host broadcast
    let subIndexChanged = false;
    const subIndex = data.subIndex as number | undefined;
    if (subIndex !== undefined && subIndex >= 0) {
      if (player.playVideoAt) {
        const currentIdx = player.getPlaylistIndex?.() ?? -1;
        if (currentIdx !== subIndex) {
          player.playVideoAt(subIndex);
          setYouTubeSubIndex(subIndex);
          subIndexChanged = true;
        }
      }
    }

    if (state === 1 && player.playVideo) {
      // Skip seek when sub-index just changed — new video starts at 0,
      // seekTo would apply to the old (briefly still loaded) video frame
      if (!subIndexChanged && player.seekTo) player.seekTo(time, true);
      player.playVideo();
    } else if (state === 2 && player.pauseVideo) {
      player.pauseVideo();
      if (player.seekTo) player.seekTo(time, true);
    } else if (state === 0 || state === -1) {
      // ENDED (0) or STOPPED (-1): stop guest YouTube player
      if (player.stopVideo) player.stopVideo();
    }
  } catch (e) {
    log.error('[YouTube State] Error:', e);
  }
}

// ─── Handle Sub Title Update ───────────────────────────────────────

function handleSubTitleUpdate(data: Record<string, unknown>): void {
  const playlistId = data.playlistId as string;
  const subIdx = data.subIdx as number;
  const title = data.title as string;

  if (!playlistId || subIdx === undefined || !title) return;

  updateSubItemTitle(playlistId, subIdx, title);

  const playlist = getState('playlist.items') || [];
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const currentItem = playlist[currentTrackIndex];
  const currentSubIndex = getState('youtube.currentSubIndex') ?? -1;
  if (currentItem?.playlistId === playlistId && currentSubIndex === subIdx) {
    setState('player.currentTrackMeta', currentItem);
  }
}

// ─── Handle YouTube Playlist Info (Host→Guest) ────────────────────

/**
 * Guest receives playlist sub-item data from Host.
 * Stores IDs and titles, then triggers background title fetcher
 * for any missing titles.
 */
function handleYouTubePlaylistInfo(data: Record<string, unknown>): void {
  const playlistId = data.playlistId as string;
  const ids = data.ids as string[];
  const titles = data.titles as string[];

  if (!playlistId) return;

  setSubItemsData(playlistId, ids, titles);

  // Guest can also fetch missing titles in background
  if (ids && ids.length > 0) {
    fetchPlaylistSubTitles(playlistId, ids);
  }
}

// ─── Handle YouTube Stop ──────────────────────────────────────────

function handleYouTubeStop(): void {
  log.debug('[Guest] Received youtube-stop, switching to local mode');
  resetAdDetection();
  const currentState = getState('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    bus.emit('youtube:stop-mode');
    bus.emit('player:stop-all-media');
  }
}

// ─── Init ──────────────────────────────────────────────────────────

export function initYouTubeSync(): void {
  registerHandlers({
    [MSG.YOUTUBE_SYNC]: handleYouTubeSync,
    [MSG.YOUTUBE_STATE]: handleYouTubeState,
    [MSG.YOUTUBE_SUB_TITLE_UPDATE]: handleSubTitleUpdate,
    [MSG.YOUTUBE_PLAYLIST_INFO]: handleYouTubePlaylistInfo,
    [MSG.YOUTUBE_STOP]: handleYouTubeStop,
  });

  // Reset ad detection when guest reconnects (receives new YouTube session)
  bus.on('youtube:load', () => resetAdDetection());

  log.info('[YouTube Sync] Initialized');
}
