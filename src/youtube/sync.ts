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
import { setManagedTimer } from '../core/timers.ts';
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

// ─── Handle YouTube Sync (Guest) ──────────────────────────────────

function handleYouTubeSync(data: Record<string, unknown>): void {
  const player = getYouTubePlayer();
  const currentState = getState('appState');
  if (!player || currentState !== APP_STATE.PLAYING_YOUTUBE || !player.getCurrentTime) return;

  // Skip during precision sync cooldown
  if (Date.now() < _precisionSyncUntil) return;

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
    const autoSyncOffset = getState('sync.autoSyncOffset') || 0;
    const rawCompensatedTime = hostTime + autoSyncOffset + localOffset;
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

  // Skip during precision sync cooldown (prevents double-seek)
  if (Date.now() < _precisionSyncUntil) return;

  // Skip state sync while host is likely watching an ad
  if (_hostAdPauseActive) return;

  try {
    const state = Number(data.state);
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

    const executeAction = (waitMs: number) => {
      const compensatedTime = time + (waitMs / 1000);

      // Update seekbar immediately
      if (compensatedTime > 0 && duration > 0) {
        bus.emit('ui:time-update', fmtTime(compensatedTime), fmtTime(duration), compensatedTime, duration);
      }

      if (state === 1 && player.playVideo) {
        if (!subIndexChanged && player.seekTo) player.seekTo(compensatedTime, true);
        player.playVideo();
      } else if (state === 2 && player.pauseVideo) {
        player.pauseVideo();
        if (player.seekTo) player.seekTo(compensatedTime, true);
      }
    };

    if (hostPlayAt > 0) {
      const waitMs = Math.max(0, hostPlayAt - getHostNow());
      if (waitMs > 0 && waitMs < 2000) {
        setManagedTimer('yt-clock-action', () => executeAction(waitMs), waitMs);
      } else {
        executeAction(0);
      }
    } else {
      executeAction(0);
    }

    if (state === 0 || state === -1) {
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
  const currentState = getState('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    bus.emit('youtube:stop-mode');
    bus.emit('player:stop-all-media');
  }
}

// ─── Precision Sync (Host) ────────────────────────────────────────

const PULSE_COUNT = 3;
const PULSE_INTERVAL = 300;  // ms between pulses
const PLAY_DELAY = 1000;     // ms after last pulse → play

// Host: track active timers to prevent accumulation on rapid taps
let _hostPulseInterval: ReturnType<typeof setInterval> | null = null;
let _hostPlayTimeout: ReturnType<typeof setTimeout> | null = null;

function startPrecisionSync(): void {
  const player = getYouTubePlayer();
  if (!player || !player.getCurrentTime) return;

  // Cancel any in-progress sync
  if (_hostPulseInterval) { clearInterval(_hostPulseInterval); _hostPulseInterval = null; }
  if (_hostPlayTimeout) { clearTimeout(_hostPlayTimeout); _hostPlayTimeout = null; }

  // 1. Pause all devices
  player.pauseVideo();
  broadcast({ type: MSG.YOUTUBE_SYNC_PREPARE });

  // 2. Seek to rounded-down second (e.g. 16:44 → 16:00)
  // Paused state → seekTo won't auto-play on mobile
  // Recently played position → still in buffer → no rebuffering
  const currentTime = player.getCurrentTime();
  const seekTime = Math.floor(currentTime);
  player.seekTo(seekTime, true);
  broadcast({ type: MSG.YOUTUBE_SYNC_SEEK, time: seekTime });

  showToast(t('toast.youtube_syncing'));

  // 3. Send 3 pulses at 300ms intervals
  let pulsesSent = 0;
  _hostPulseInterval = setInterval(() => {
    pulsesSent++;
    broadcast({
      type: MSG.YOUTUBE_SYNC_PULSE,
      seq: pulsesSent,
      hostTs: Date.now(),
    });
    log.debug(`[YT PrecisionSync] Pulse ${pulsesSent}/${PULSE_COUNT}`);

    if (pulsesSent >= PULSE_COUNT) {
      if (_hostPulseInterval) { clearInterval(_hostPulseInterval); _hostPulseInterval = null; }

      // 4. After PLAY_DELAY: play from the seeked position
      _hostPlayTimeout = setTimeout(() => {
        _hostPlayTimeout = null;
        _precisionSyncUntil = Date.now() + 3000;
        player.playVideo();
        log.info(`[YT PrecisionSync] Host play at ${seekTime}s`);
      }, PLAY_DELAY);
    }
  }, PULSE_INTERVAL);
}

// ─── Precision Sync (Guest) ───────────────────────────────────────

let _syncPulses: { seq: number; hostTs: number; receivedAt: number }[] = [];
let _syncSeekTime = 0;
let _precisionSyncUntil = 0;
const _mixReloadedIds = new Set<string>(); // Track which Mix IDs already reloaded (prevent 3s loop)
let _guestPlayTimeout: ReturnType<typeof setTimeout> | null = null;

function handleSyncPrepare(): void {
  // Pause + reset state
  const player = getYouTubePlayer();
  if (player?.pauseVideo) player.pauseVideo();
  _syncPulses = [];
  if (_guestPlayTimeout) { clearTimeout(_guestPlayTimeout); _guestPlayTimeout = null; }
  showToast(t('toast.youtube_syncing'));
  log.debug('[YT PrecisionSync] Guest: paused, waiting for seek + pulses');
}

function handleSyncSeek(data: Record<string, unknown>): void {
  // Seek while paused — won't auto-play, position is in buffer
  const player = getYouTubePlayer();
  _syncPulses = [];
  if (_guestPlayTimeout) { clearTimeout(_guestPlayTimeout); _guestPlayTimeout = null; }
  _syncSeekTime = Number(data.time) || 0;
  if (player?.seekTo) player.seekTo(_syncSeekTime, true);
  log.debug(`[YT PrecisionSync] Guest: seeked to ${_syncSeekTime}s (paused)`);
}

function handleSyncPulse(data: Record<string, unknown>): void {
  const player = getYouTubePlayer();
  if (!player) return;

  const seq = Number(data.seq) || 0;
  const receivedAt = Date.now();

  _syncPulses.push({ seq, hostTs: 0, receivedAt });
  log.debug(`[YT PrecisionSync] Guest: pulse ${seq}`);

  if (seq >= PULSE_COUNT) {
    // Use last pulse's arrival time as anchor (guest clock only — no cross-clock issues)
    const lastPulseReceived = _syncPulses[_syncPulses.length - 1].receivedAt;

    // Compensate for one-way latency using existing RTT measurement
    const rtt = getState('sync.lastLatencyMs') || 0;
    const halfRtt = rtt / 2;

    // Guest seeks at: lastPulseReceived + PLAY_DELAY - halfRtt
    const waitMs = Math.max(0, (lastPulseReceived + PLAY_DELAY - halfRtt) - Date.now());

    log.info(`[YT PrecisionSync] Guest: rtt=${rtt}ms, halfRtt=${halfRtt}ms, wait=${waitMs}ms`);

    _guestPlayTimeout = setTimeout(() => {
      _guestPlayTimeout = null;
      _precisionSyncUntil = Date.now() + 3000;
      if (player.playVideo) player.playVideo();
      log.info(`[YT PrecisionSync] Guest: play at ${_syncSeekTime}s`);
    }, waitMs);

    _syncPulses = [];
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
    [MSG.YOUTUBE_SYNC_PREPARE]: handleSyncPrepare,
    [MSG.YOUTUBE_SYNC_SEEK]: handleSyncSeek,
    [MSG.YOUTUBE_SYNC_PULSE]: handleSyncPulse,
  });

  // Host: precision sync trigger
  bus.on('youtube:precision-sync', () => {
    startPrecisionSync();
  });

  // Reset ad detection when guest reconnects (receives new YouTube session)
  bus.on('youtube:load', () => {
    resetAdDetection();
    _mixReloadedIds.clear();
  });

  log.info('[YouTube Sync] Initialized');
}
