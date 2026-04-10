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

// ─── Host Position Snapshot Cache (Guest-side) ───────────────────
// Updated on every MSG.YOUTUBE_SYNC heartbeat (~3s interval on host).
// Consumed by guestRendezvousSync() to extrapolate host's current position
// using the shared clock. hostClockAt is in host-clock milliseconds so
// extrapolation composes directly with getHostNow().

interface HostPositionSnapshot {
  hostClockAt: number; // host-clock ms when snapshot was taken (≈ getHostNow() at receive)
  hostPosition: number; // video position (seconds)
  hostState: number; // YT PlayerState (1=playing, 2=paused, ...)
}
let _lastHostSnapshot: HostPositionSnapshot | null = null;

function updateHostSnapshot(hostTime: number, hostState: number): void {
  _lastHostSnapshot = {
    hostClockAt: getHostNow(),
    hostPosition: hostTime,
    hostState,
  };
}

// ─── Rendezvous Sync State (Guest-side) ──────────────────────────

let _rendezvousInProgress = false;

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

    // Cache latest host position for rendezvous sync extrapolation
    updateHostSnapshot(hostTime, hostState);

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

// ─── Guest Rendezvous Sync ────────────────────────────────────────
/**
 * Guest-initiated precise re-alignment, SMPTE slave-sync style.
 *
 * Unlike the host-side countdown (`scheduleYtAutoSync`), this does NOT
 * disturb the host or other guests. The guest pre-seeks to a future host
 * position (host_pos_now + margin), pauses until buffer is ready, then
 * fires `playVideo()` at precisely the moment that guest's audible output
 * will coincide with the host reaching that same position.
 *
 * Timing math:
 *   target_pos  = host_pos_extrapolated(now) + margin
 *   T_host_reach_target = hostClockAt_snapshot
 *                       + (target_pos - hostPosition_snapshot) * 1000
 *   playCallAt  = T_host_reach_target - guestPlayLatency
 *   -> guest_audible = playCallAt + guestPlayLatency = T_host_reach_target
 *      which is exactly when host is at target_pos ✓
 *
 * After play starts, drift vs. extrapolated host position is measured
 * and `youtube.guestPlayLatency` is nudged via EMA for next-call convergence.
 *
 * Called by the sync button handler when role=guest in YouTube mode.
 */
export function guestRendezvousSync(): void {
  const player = getYouTubePlayer();
  const currentState = getState('appState');
  if (!player || currentState !== APP_STATE.PLAYING_YOUTUBE) {
    showToast(t('toast.sync_not_available'));
    return;
  }
  if (!player.getCurrentTime || !player.seekTo || !player.pauseVideo || !player.playVideo) {
    showToast(t('toast.yt_rendezvous_no_data'));
    return;
  }

  // Debounce re-entry
  if (_rendezvousInProgress) {
    log.debug('[Rendezvous] Already in progress — ignoring');
    return;
  }

  // Need a fresh-enough host snapshot (≤10s old)
  if (!_lastHostSnapshot || (getHostNow() - _lastHostSnapshot.hostClockAt) > 10_000) {
    showToast(t('toast.yt_rendezvous_no_data'));
    return;
  }

  const snapshot = _lastHostSnapshot;

  // If host is paused, there's no playback to rendezvous with — just align position
  if (snapshot.hostState !== 1) {
    try {
      player.seekTo(snapshot.hostPosition, true);
      player.pauseVideo();
    } catch { /* noop */ }
    showToast(t('toast.yt_rendezvous_host_paused'));
    return;
  }

  // Clear any lingering timers from a prior attempt
  clearManagedTimer('yt-rendezvous-buffer');
  clearManagedTimer('yt-rendezvous-play');
  clearManagedTimer('yt-rendezvous-calibrate');

  const guestPlayLatency = getState('youtube.guestPlayLatency') ?? 200;
  const MARGIN_SEC = 1.5; // headroom for seek + buffer + network jitter

  // Extrapolate host's current position
  const nowHost = getHostNow();
  const hostPosNow = snapshot.hostPosition + (nowHost - snapshot.hostClockAt) / 1000;
  const targetPosition = hostPosNow + MARGIN_SEC;

  // Host-clock instant when host's audible playback will reach targetPosition
  const tHostReachTarget = nowHost + MARGIN_SEC * 1000;
  // Guest should call playVideo() guestPlayLatency ms before that
  const playCallAtHostClock = tHostReachTarget - guestPlayLatency;

  log.debug(`[Rendezvous] Start: hostPosNow=${hostPosNow.toFixed(2)}s target=${targetPosition.toFixed(2)}s L_play=${guestPlayLatency}ms`);

  _rendezvousInProgress = true;
  _autoSyncUntil = Date.now() + MARGIN_SEC * 1000 + 2000; // suppress drift fighter
  bus.emit('youtube:sync-loading', true);
  showToast(t('toast.yt_rendezvous_start'));

  // Step 1: seek to target + pause (stays paused while buffer fills)
  try {
    player.pauseVideo();
    player.seekTo(targetPosition, true);
  } catch (e) {
    log.warn('[Rendezvous] seek/pause threw:', e);
    finishRendezvous();
    return;
  }

  // Step 2: buffer gate — poll player state until PAUSED (2) or CUED (5)
  // YT states: -1=unstarted 0=ended 1=playing 2=paused 3=buffering 5=cued
  const bufferDeadline = getHostNow() + MARGIN_SEC * 1000 - 150;
  let bufferChecks = 0;

  const checkBuffer = (): void => {
    if (!_rendezvousInProgress) return; // cancelled
    bufferChecks++;
    let pState = -1;
    try { pState = player.getPlayerState?.() ?? -1; } catch { /* noop */ }

    const bufferReady = pState === 2 || pState === 5;
    const outOfTime = getHostNow() > bufferDeadline;

    if (bufferReady) {
      log.debug(`[Rendezvous] Buffer ready after ${bufferChecks} checks (state=${pState})`);
      scheduleRendezvousPlay(player, playCallAtHostClock, targetPosition, snapshot);
      return;
    }

    if (outOfTime || bufferChecks > 40) {
      log.warn('[Rendezvous] Buffer gate timeout — aborting');
      showToast(t('toast.yt_rendezvous_timeout'));
      finishRendezvous();
      return;
    }

    setManagedTimer('yt-rendezvous-buffer', checkBuffer, 50);
  };

  setManagedTimer('yt-rendezvous-buffer', checkBuffer, 50);
}

function scheduleRendezvousPlay(
  player: any,
  playCallAtHostClock: number,
  targetPosition: number,
  snapshot: HostPositionSnapshot,
): void {
  const waitMs = Math.max(0, playCallAtHostClock - getHostNow());
  log.debug(`[Rendezvous] Scheduling playVideo in ${waitMs.toFixed(0)}ms`);

  setManagedTimer('yt-rendezvous-play', () => {
    if (!_rendezvousInProgress) return; // cancelled during wait
    try {
      player.playVideo();
    } catch (e) {
      log.warn('[Rendezvous] playVideo threw:', e);
      finishRendezvous();
      return;
    }
    bus.emit('youtube:sync-loading', false);
    showToast(t('toast.yt_rendezvous_done'));

    // Step 3: self-calibrate guestPlayLatency from measured drift (~800ms later)
    setManagedTimer('yt-rendezvous-calibrate', () => {
      _rendezvousInProgress = false;
      try {
        const guestPos = player.getCurrentTime?.() ?? 0;
        // Re-extrapolate host position using the SAME snapshot (drift-free baseline)
        const hostPosNowMeasured =
          snapshot.hostPosition + (getHostNow() - snapshot.hostClockAt) / 1000;
        const driftSec = guestPos - hostPosNowMeasured; // + = guest ahead, − = guest behind
        const driftMs = driftSec * 1000;

        // Positive drift (guest ahead) means playVideo() fired too early → our L_play
        // estimate was too HIGH → DECREASE it. Hence minus sign.
        const current = getState('youtube.guestPlayLatency') ?? 200;
        const LR = 0.3;
        const nextRaw = current - driftMs * LR;
        const next = Math.round(Math.max(50, Math.min(600, nextRaw)));
        if (next !== current) setState('youtube.guestPlayLatency', next);

        log.debug(
          `[Rendezvous] Calibrate: drift=${driftMs.toFixed(0)}ms, L_play ${current} → ${next} (target=${targetPosition.toFixed(2)}s measured=${guestPos.toFixed(2)}s)`,
        );
      } catch (e) {
        log.debug('[Rendezvous] Calibration skipped:', e);
      }
    }, 800);
  }, waitMs);
}

function finishRendezvous(): void {
  _rendezvousInProgress = false;
  _autoSyncUntil = 0;
  clearManagedTimer('yt-rendezvous-buffer');
  clearManagedTimer('yt-rendezvous-play');
  bus.emit('youtube:sync-loading', false);
}

/**
 * Cancel any in-progress rendezvous sync. Called when the host takes a
 * disruptive action (pause/seek/video-change) during the guest's wait.
 */
export function cancelGuestRendezvous(): void {
  if (!_rendezvousInProgress) return;
  log.debug('[Rendezvous] Cancelled');
  clearManagedTimer('yt-rendezvous-calibrate');
  finishRendezvous();
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
    cancelGuestRendezvous(); // Host paused/stopped while guest was rendezvousing
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
  _autoSyncUntil = 0;
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
    _autoSyncUntil = 0;
    resetAdDetection();
    _mixReloadedIds.clear();
  });

  log.info('[YouTube Sync] Initialized');
}
