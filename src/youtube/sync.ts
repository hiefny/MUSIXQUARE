/**
 * MUSIXQUARE 2.0 — YouTube Sync
 * Extracted from original app.js lines 11568-11688
 *
 * Manages: YouTube state broadcasting (Host), sync reception (Guest),
 * sub-index tracking, drift correction.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, APP_STATE } from '../core/constants.ts';
import { broadcast } from '../network/peer.ts';
import { registerHandlers } from '../network/protocol.ts';
import { getYouTubePlayer } from './player.ts';
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
        setState('youtube.currentSubIndex', sIdx);

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
                  subMap[pid] = { ids, titles: subMap[pid]?.titles || [] };
                  setState('youtube.subItemsMap', { ...subMap });
                }
              }
            } catch { /* noop */ }
          }

          // Get current video title
          if (player.getVideoData) {
            const vData = player.getVideoData();
            if (vData?.title) {
              const subMap = getState('youtube.subItemsMap') || {};
              if (!subMap[pid]) subMap[pid] = { ids: [], titles: [] };
              if (subMap[pid].titles[sIdx] !== vData.title) {
                subMap[pid].titles[sIdx] = vData.title;
                setState('youtube.subItemsMap', { ...subMap });
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

        bus.emit('ui:update-playlist');
        bus.emit('player:metadata-update', playlist[currentTrackIndex]);
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
const _HOST_AD_STALE_THRESHOLD = 2; // 2 consecutive stale frames ≈ 6s

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
      if (_lastHostSyncTime !== null && Math.abs(hostTime - _lastHostSyncTime) < 0.5) {
        _hostTimeStaleCount++;
        if (_hostTimeStaleCount >= _HOST_AD_STALE_THRESHOLD) {
          if (!_hostAdPauseActive) {
            _hostAdPauseActive = true;
            if (player.pauseVideo) player.pauseVideo();
            bus.emit('ui:show-toast', '호스트가 광고를 보고 있는 것 같아요');
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
      setState('youtube.currentSubIndex', hostSubIndex);

      if (player.playVideoAt && player.getPlaylistIndex) {
        const ytPlaylist = player.getPlaylist?.() || [];
        if (hostSubIndex >= 0 && hostSubIndex < ytPlaylist.length && player.getPlaylistIndex() !== hostSubIndex) {
          player.playVideoAt(hostSubIndex);
        }
      }

      bus.emit('ui:update-playlist');
      const playlist = getState('playlist.items') || [];
      const currentTrackIndex = getState('playlist.currentTrackIndex');
      bus.emit('player:metadata-update', playlist[currentTrackIndex]);
    }

    // Drift correction
    const localOffset = getState('sync.localOffset') || 0;
    const autoSyncOffset = getState('sync.autoSyncOffset') || 0;
    const compensatedTime = hostTime + autoSyncOffset + localOffset;

    const currentTime = player.getCurrentTime();
    const drift = Math.abs(currentTime - compensatedTime);

    if (drift > 2 && player.seekTo) {
      log.debug(`[YouTube Sync] Drift ${drift.toFixed(1)}s, seeking to ${compensatedTime.toFixed(1)}s`);
      player.seekTo(compensatedTime, true);
    }

    // State sync
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
    const subIndex = data.subIndex as number | undefined;
    if (subIndex !== undefined && subIndex >= 0) {
      if (player.playVideoAt) {
        const currentIdx = player.getPlaylistIndex?.() ?? -1;
        if (currentIdx !== subIndex) {
          player.playVideoAt(subIndex);
          setState('youtube.currentSubIndex', subIndex);
        }
      }
    }

    if (state === 1 && player.playVideo) {
      if (player.seekTo) player.seekTo(time, true);
      player.playVideo();
    } else if (state === 2 && player.pauseVideo) {
      player.pauseVideo();
      if (player.seekTo) player.seekTo(time, true);
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

  const subMap = getState('youtube.subItemsMap') || {};
  if (!subMap[playlistId]) subMap[playlistId] = { ids: [], titles: [] };
  subMap[playlistId].titles[subIdx] = title;
  setState('youtube.subItemsMap', { ...subMap });

  bus.emit('ui:update-playlist');

  const playlist = getState('playlist.items') || [];
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const currentItem = playlist[currentTrackIndex];
  const currentSubIndex = getState('youtube.currentSubIndex') ?? -1;
  if (currentItem?.playlistId === playlistId && currentSubIndex === subIdx) {
    bus.emit('player:metadata-update', currentItem);
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

  const subMap = getState('youtube.subItemsMap') || {};
  subMap[playlistId] = { ids: ids || [], titles: titles || [] };
  setState('youtube.subItemsMap', { ...subMap });
  bus.emit('ui:update-playlist');

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
  }
  bus.emit('player:stop-all-media');
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

  log.info('[YouTube Sync] Initialized');
}
