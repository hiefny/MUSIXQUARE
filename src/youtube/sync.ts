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
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { getHostNow } from '../network/shared-clock.ts';
import { fmtTime } from '../player/transport.ts';
import { broadcast } from '../network/peer.ts';
import { registerHandlers } from '../network/protocol.ts';
import { getYouTubePlayer, setYouTubeSubIndex, updateSubItemIds, updateSubItemTitle, setSubItemsData } from './_state.ts';
import { fetchPlaylistSubTitles } from './search.ts';
import { showToast } from '../ui/toast.ts';

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
      }
    }

    // Include current video ID for Mix playlist sync
    const videoId = player.getVideoData?.()?.video_id || '';

    broadcast({
      type: MSG.YOUTUBE_SYNC,
      time: currentTime,
      state,
      subIndex: getState('youtube.currentSubIndex') ?? -1,
      videoId,
    });
  } catch (e) {
    log.error('[YouTube Sync] broadcast error:', e);
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

// ─── Auto-Sync Cooldown ──────────────────────────────────────────
// During auto-sync wait, suppress drift correction from handleYouTubeSync

let _autoSyncUntil = 0;
const _mixReloadedIds = new Set<string>(); // Track which Mix IDs already reloaded (prevent 3s loop)

// ─── Handle YouTube Sync (Guest) ──────────────────────────────────

function handleYouTubeSync(data: Record<string, unknown>): void {
  const player = getYouTubePlayer();
  const currentState = getState('appState');
  if (!player || currentState !== APP_STATE.PLAYING_YOUTUBE || !player.getCurrentTime) return;

  // Skip during auto-sync cooldown (prevents drift correction from fighting scheduled play)
  if (Date.now() < _autoSyncUntil) return;

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
            showToast(t('toast.host_ad'));
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

    // Video ID sync — fixes YouTube Mix (each device has different playlist order)
    const hostVideoId = (data.videoId as string) || '';
    if (hostVideoId && player.getVideoData) {
      const guestVideoId = player.getVideoData()?.video_id || '';
      if (guestVideoId && hostVideoId !== guestVideoId) {
        log.info(`[YouTube Sync] Video mismatch: guest=${guestVideoId}, host=${hostVideoId} — loading host video`);
        if (player.loadVideoById) {
          player.loadVideoById(hostVideoId);
        }
        // Update sub-index from host
        if (hostSubIndex !== undefined && hostSubIndex !== -1) {
          setYouTubeSubIndex(hostSubIndex);
        }
        return; // Skip drift correction — new video is loading
      }
    }

    // Sub-index change (non-Mix playlists: same order on all devices)
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
            log.warn('[YouTube Sync] playVideoAt failed, rolling back sub-index:', e);
            setYouTubeSubIndex(currentSubIndex);
          }
        }
      }
    }

    // Drift correction
    const localOffset = getState('sync.localOffset') || 0;
    const rawCompensatedTime = hostTime + localOffset;
    // Drift correction (skip if duration not loaded yet)
    const duration = (player.getDuration && player.getDuration()) || 0;
    if (duration > 0) {
      const compensatedTime = Math.max(0, Math.min(rawCompensatedTime, duration));
      const currentTime = player.getCurrentTime();
      const drift = Math.abs(currentTime - compensatedTime);

      if (drift > 3 && player.seekTo) {
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

  const state = Number(data.state);

  // PAUSE/STOP always takes priority — cancel any pending auto-sync
  if (state === 2 || state === 0 || state === -1) {
    _autoSyncUntil = 0;
    clearManagedTimer('yt-clock-action');
    bus.emit('youtube:sync-loading', false);
  }

  // Skip during auto-sync cooldown (prevents drift correction from fighting scheduled play)
  if (Date.now() < _autoSyncUntil) return;

  // Skip state sync while host is likely watching an ad
  if (_hostAdPauseActive) return;

  try {
    const time = Number(data.time) || 0;

    // Video ID sync — fixes Mix playlists where sub-index = different video
    let subIndexChanged = false;
    const hostVideoId = (data.videoId as string) || '';
    const subIndex = data.subIndex as number | undefined;

    if (hostVideoId && player.getVideoData) {
      const guestVideoId = player.getVideoData()?.video_id || '';
      if (guestVideoId && hostVideoId !== guestVideoId && player.loadVideoById) {
        log.info(`[YouTube State] Video mismatch — loading ${hostVideoId}`);
        player.loadVideoById(hostVideoId);
        if (subIndex !== undefined) setYouTubeSubIndex(subIndex);
        subIndexChanged = true;
      }
    }

    // Fallback: sub-index based (regular playlists)
    if (!subIndexChanged && subIndex !== undefined && subIndex >= 0) {
      if (player.playVideoAt) {
        const currentIdx = player.getPlaylistIndex?.() ?? -1;
        if (currentIdx !== subIndex) {
          player.playVideoAt(subIndex);
          setYouTubeSubIndex(subIndex);
          subIndexChanged = true;
        }
      }
    }

    // SharedClock: schedule YouTube action at host-specified time
    const hostPlayAt = Number(data.hostPlayAt) || 0;
    const duration = player.getDuration?.() || 0;

    if (hostPlayAt > 0) {
      const waitMs = Math.max(0, hostPlayAt - getHostNow());

      if (waitMs > 300 && waitMs < 3000 && state === 1) {
        // ── Auto-sync path: significant wait (>300ms) + play command ──
        // 1. Pause immediately for clean sync
        if (player.pauseVideo) player.pauseVideo();

        // 2. Seek to target position (while paused = in-buffer, no rebuffer)
        if (!subIndexChanged && player.seekTo) player.seekTo(time, true);

        // 3. Update seekbar immediately
        if (time > 0 && duration > 0) {
          bus.emit('ui:time-update', fmtTime(time), fmtTime(duration), time, duration);
        }

        // 4. Suppress drift correction during wait
        _autoSyncUntil = Date.now() + waitMs + 1500;

        // 5. Show sync loading state on guest
        bus.emit('youtube:sync-loading', true);
        showToast(t('toast.yt_sync_start'));

        // 6. Play at scheduled time
        setManagedTimer('yt-clock-action', () => {
          if (player.playVideo) player.playVideo();
          bus.emit('youtube:sync-loading', false);
          showToast(t('toast.yt_sync_done'));
        }, waitMs);

        log.debug(`[YouTube State] Auto-sync: pause+seek, play in ${waitMs}ms`);
      } else if (waitMs > 0 && waitMs <= 300) {
        // Short wait (≤300ms) — schedule without pause (minor timing correction)
        const compensatedTime = time + (waitMs / 1000);
        if (compensatedTime > 0 && duration > 0) {
          bus.emit('ui:time-update', fmtTime(compensatedTime), fmtTime(duration), compensatedTime, duration);
        }
        setManagedTimer('yt-clock-action', () => {
          if (state === 1 && player.playVideo) {
            if (!subIndexChanged && player.seekTo) player.seekTo(compensatedTime, true);
            player.playVideo();
          } else if (state === 2 && player.pauseVideo) {
            player.pauseVideo();
            if (player.seekTo) player.seekTo(compensatedTime, true);
          }
        }, waitMs);
      } else {
        // No wait or out of range — execute immediately
        executeImmediate(player, state, time, duration, subIndexChanged);
      }
    } else {
      // No hostPlayAt — execute immediately (pause, stop, etc.)
      executeImmediate(player, state, time, duration, subIndexChanged);
    }

    if (state === 0 || state === -1) {
      if (player.stopVideo) player.stopVideo();
    }
  } catch (e) {
    log.error('[YouTube State] Error:', e);
  }
}

/** Immediate action helper (no SharedClock delay). */
function executeImmediate(
  player: any, state: number, time: number, duration: number, subIndexChanged: boolean,
): void {
  if (time > 0 && duration > 0) {
    bus.emit('ui:time-update', fmtTime(time), fmtTime(duration), time, duration);
  }
  if (state === 1 && player.playVideo) {
    if (!subIndexChanged && player.seekTo) player.seekTo(time, true);
    player.playVideo();
  } else if (state === 2 && player.pauseVideo) {
    player.pauseVideo();
    if (player.seekTo) player.seekTo(time, true);
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
    setState('player.currentTrackMeta', { ...currentItem, title: title });
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

  // If this is a YouTube Mix (RD...) and we are currently playing it,
  // force a reload ONCE using the static ID list to match the Host's sequence.
  if (playlistId.startsWith('RD')) {
    const currentPlaylist = getState('playlist.items')?.[getState('playlist.currentTrackIndex')]?.playlistId;
    if (currentPlaylist === playlistId && !_mixReloadedIds.has(playlistId)) {
      _mixReloadedIds.add(playlistId);
      log.info('[YouTube Mix] Forcing guest reload (once) with host-snapshot IDs:', playlistId);
      const subIndex = getState('youtube.currentSubIndex') ?? 0;
      import('./iframe.ts').then(mod => {
        mod.loadYouTubeVideo(null, ids, true, subIndex);
      });
    }
  }

  // Guest can also fetch missing titles in background
  if (ids && ids.length > 0) {
    fetchPlaylistSubTitles(playlistId, ids);
  }
}

// ─── Handle YouTube Stop ──────────────────────────────────────────

function handleYouTubeStop(): void {
  log.debug('[Guest] Received youtube-stop, switching to local mode');
  resetAdDetection();
  clearManagedTimer('yt-clock-action');
  bus.emit('youtube:sync-loading', false);
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
  bus.on('youtube:load', () => {
    resetAdDetection();
    _mixReloadedIds.clear();
  });

  log.info('[YouTube Sync] Initialized');
}
