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
import { setManagedTimer, clearManagedTimer, getManagedTimer } from '../core/timers.ts';
import { getHostNow, isClockCalibrated } from '../network/shared-clock.ts';
import { fmtTime } from '../player/transport.ts';
import { broadcast } from '../network/peer.ts';
import { registerHandlers } from '../network/protocol.ts';
import { getYouTubePlayer, setYouTubeSubIndex, updateSubItemIds, updateSubItemTitle, setSubItemsData, setYtAutoplayIntent } from './_state.ts';
import type { YouTubePlayerInstance } from './_state.ts';
import { fetchPlaylistSubTitles } from './search.ts';
import { showToast } from '../ui/toast.ts';
import {
  PLAYLIST_MAX_ITEMS,
  DRIFT_SEEK_THRESHOLD_SEC,
  HOST_AD_STALE_THRESHOLD,
  HOST_AD_STALE_DIFF_SEC,
  POST_SCHEDULED_ACTION_COOLDOWN_MS,
  IMMEDIATE_ACTION_COOLDOWN_MS,
  LOAD_DRIFT_SUPPRESS_MS,
  SHORT_WAIT_THRESHOLD_MS,
  AUTO_SYNC_MAX_WAIT_MS,
  MISMATCH_MIN_WAIT_MS,
  SEEK_PLAY_GAP_MS,
  RENDEZVOUS_MARGIN_SEC,
  RENDEZVOUS_SNAPSHOT_MAX_AGE_MS,
  RENDEZVOUS_COOLDOWN_MS,
  RENDEZVOUS_BUFFER_CHECK_INTERVAL_MS,
  RENDEZVOUS_BUFFER_MAX_CHECKS,
  RENDEZVOUS_BUFFER_DEADLINE_OFFSET_MS,
  RENDEZVOUS_CALIBRATE_DELAY_MS,
  RENDEZVOUS_DRIFT_SUPPRESS_MS,
  LATENCY_EMA_RATE,
  LATENCY_CLAMP_MAX_MS,
  LATENCY_OUTLIER_REJECT_MS,
} from './constants.ts';

// ─── Broadcast YouTube Sync (Host) ────────────────────────────────

/**
 * Timestamp of the last manual broadcast (e.g. from the sub-video-advance
 * hijack path). The scheduled heartbeat loop can fire ~100ms later with the
 * same subIndex but a stale currentTime (the player is still buffering the
 * freshly loaded video), which makes guests rewind. Skip non-manual
 * broadcasts briefly after a manual one to let the player settle.
 */
const MANUAL_BROADCAST_DEDUP_MS = 500;
let _lastManualBroadcastAt = 0;

export function broadcastYouTubeSync(isManual = false): void {
  const player = getYouTubePlayer();
  const hostConn = getState('network.hostConn');
  if (!player || hostConn || !player.getCurrentTime) return;

  // Dedup heartbeats that immediately follow a manual broadcast. Manual
  // broadcasts always pass through (the caller explicitly asked for a
  // fresh sync).
  if (!isManual && Date.now() - _lastManualBroadcastAt < MANUAL_BROADCAST_DEDUP_MS) return;

  // Suppress heartbeat while auto-sync countdown is active.
  // During the countdown the host is paused+seeking — getCurrentTime()
  // may return a stale (pre-seek) value. Broadcasting that stale position
  // causes ALL guests' drift correction to undo the seek, even though
  // they already received the correct position via YOUTUBE_STATE.
  if (getManagedTimer('yt-auto-sync') || getManagedTimer('yt-sync-grace')) return;

  try {
    const currentTime = player.getCurrentTime();
    const state = player.getPlayerState ? player.getPlayerState() : -1;

    // Sub-index tracking for playlists
    if (player.getPlaylistIndex) {
      const sIdx = player.getPlaylistIndex();
      const currentYouTubeSubIndex = getState('youtube.currentSubIndex') ?? -1;

      // Only trust the IFrame's index if it's NOT -1 (single video mode).
      // When we use loadVideoById, the iframe loses its playlist context and 
      // returns -1 or undefined. Overwriting our managed index with undefined would break navigation.
      if (typeof sIdx === 'number' && sIdx !== -1 && sIdx !== currentYouTubeSubIndex) {
        setYouTubeSubIndex(sIdx);

        const playlist = getState('playlist.items') || [];
        const currentTrackIndex = getState('playlist.currentTrackIndex');
        const currentItem = playlist[currentTrackIndex];

        if (currentItem?.playlistId) {
          const pid = currentItem.playlistId as string;

          // Only update IDs if the player returns a substantial list (> 1).
          // Prevents the "1-item list poison" when in single-video mode.
          if (player.getPlaylist) {
            try {
              const rawIds = player.getPlaylist();
              if (Array.isArray(rawIds) && rawIds.length > 1) {
                const ids = rawIds.slice(0, PLAYLIST_MAX_ITEMS);
                const subMap = getState('youtube.subItemsMap') || {};
                if (!subMap[pid] || subMap[pid].ids.length !== ids.length) {
                  updateSubItemIds(pid, ids);
                }
              }
            } catch (e) { /* noop */ }
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
      // Host-side clock at the moment currentTime was read. Guests use
      // this for snapshot extrapolation instead of their own getHostNow()
      // at receive time, which is one-way-latency later and causes the
      // extrapolated position to be consistently behind by that latency.
      hostClock: getHostNow(),
      isManual,
      title: getState('player.currentTrackMeta')?.title,
    });
    if (isManual) _lastManualBroadcastAt = Date.now();
    log.debug(`[YouTube] Broadcast sync: t=${currentTime}, s=${state}${isManual ? ' (Manual)' : ''}`);
  } catch (e) {
    log.error('[YouTube Sync] broadcast error:', e);
  }
}

// ─── Guest-side Sync Runtime State ────────────────────────────────
// All mutable guest-side state in one place. Previously scattered as
// individual module-level `let` bindings — consolidated so that
// resetYouTubeSyncState() has a single source of truth, and new fields
// can be added without hunting through the file.

interface HostPositionSnapshot {
  hostClockAt: number; // host-clock ms when snapshot was taken
  hostPosition: number; // video position (seconds)
  hostState: number; // YT PlayerState (1=playing, 2=paused, ...)
  _videoId?: string; // video ID at snapshot time (for calibration cross-check)
}

interface GuestSyncRuntime {
  /** Last host position seen in a PLAYING heartbeat (null if host is paused). */
  lastHostSyncTime: number | null;
  /** Count of consecutive heartbeats with near-identical hostTime — used for ad detection. */
  hostTimeStaleCount: number;
  /** True while the guest is paused in response to a host-side ad. */
  hostAdPauseActive: boolean;
  /** Date.now() expiry: until this moment, drift correction is suppressed. */
  autoSyncUntil: number;
  /** Freshest host position snapshot — consumed by rendezvous extrapolation. */
  lastHostSnapshot: HostPositionSnapshot | null;
  /** True while a guest rendezvous is active (buffer wait → scheduled play). */
  rendezvousInProgress: boolean;
  /** Cooldown timestamp to prevent rapid-fire rendezvous (YouTube API crash). */
  lastRendezvousAt: number;
}

const _rt: GuestSyncRuntime = {
  lastHostSyncTime: null,
  hostTimeStaleCount: 0,
  hostAdPauseActive: false,
  autoSyncUntil: 0,
  lastHostSnapshot: null,
  rendezvousInProgress: false,
  lastRendezvousAt: 0,
};

export function resetAdDetection(): void {
  _rt.lastHostSyncTime = null;
  _rt.hostTimeStaleCount = 0;
  _rt.hostAdPauseActive = false;
}

/** Suppress drift correction + state sync for the given duration.
 *  Called from iframe.ts after loadVideoById/loadPlaylist to prevent
 *  heartbeat state-sync from waking the guest prematurely. */
export function suppressDriftUntil(ms: number): void {
  // Math.max never shortens an existing suppression window — handleYouTubeState
  // may have set a longer window (waitMs + POST_SCHEDULED_ACTION_COOLDOWN_MS)
  // that this async call from iframe.ts must not overwrite.
  _rt.autoSyncUntil = Math.max(_rt.autoSyncUntil, Date.now() + ms);
}

// Updated on every MSG.YOUTUBE_SYNC heartbeat (~HEARTBEAT_INTERVAL_MS).
// Consumed by guestRendezvousSync() to extrapolate host's current position
// using the shared clock. hostClockAt is in host-clock milliseconds so
// extrapolation composes directly with getHostNow().
function updateHostSnapshot(hostTime: number, hostState: number, hostClock?: number): void {
  const player = getYouTubePlayer();
  _rt.lastHostSnapshot = {
    hostClockAt: hostClock ?? getHostNow(),
    hostPosition: hostTime,
    hostState,
    _videoId: player?.getVideoData?.()?.video_id || '',
  };
}

// ─── Handle YouTube Sync (Guest) ──────────────────────────────────

function handleYouTubeSync(data: Record<string, unknown>): void {
  const player = getYouTubePlayer();
  const currentState = getState('appState');
  if (!player || currentState !== APP_STATE.PLAYING_YOUTUBE || !player.getCurrentTime) return;

  // Host is alive — cancel any pending guest-ENDED fallback. The 5s fallback
  // would otherwise drop the guest out of YouTube mode even though the host
  // is still broadcasting heartbeats for a freshly loaded next track.
  clearManagedTimer('yt-guest-ended-fallback');

  // Cache latest host position BEFORE the cooldown gate. The rendezvous
  // button needs a fresh snapshot to work, and the cooldown's purpose is
  // to suppress drift *correction*, not to freeze out snapshot updates.
  // Without this, a guest stuck in a long autoSyncUntil window sees every
  // heartbeat dropped and `guestRendezvousSync` reports "No host playback
  // data yet" for the full duration of the cooldown.
  const hostTime = Number(data.time) || 0;
  const hostState = Number(data.state);
  const hostSubIndex = data.subIndex as number | undefined;
  const hostClock = data.hostClock != null ? Number(data.hostClock) : undefined;
  updateHostSnapshot(hostTime, hostState, hostClock);

  const isManual = !!data.isManual;

  // Manual sync (Host clicks Sync button) ALWAYS bypasses the cooldown
  if (!isManual && Date.now() < _rt.autoSyncUntil) return;

  try {

    // If this is a manual sync request from the host, trigger precision rendezvous immediately
    if (isManual) {
      log.info('[YouTube Sync] Received manual sync request — triggering precision rendezvous');
      guestRendezvousSync();
      return;
    }

    // Apply title from host to maintain metadata sync (fixes "No Media" for late joiners)
    const hostTitle = data.title as string | undefined;
    if (hostTitle) {
      const currentMeta = getState('player.currentTrackMeta');
      if (currentMeta && currentMeta.title !== hostTitle) {
        setState('player.currentTrackMeta', { ...currentMeta, title: hostTitle });
      }
    }

    // ── Host ad detection ──
    if (hostState === 1) {
      if (_rt.lastHostSyncTime !== null && Math.abs(hostTime - _rt.lastHostSyncTime) < HOST_AD_STALE_DIFF_SEC) {
        _rt.hostTimeStaleCount++;
        if (_rt.hostTimeStaleCount >= HOST_AD_STALE_THRESHOLD) {
          if (!_rt.hostAdPauseActive) {
            _rt.hostAdPauseActive = true;
            if (player.pauseVideo) player.pauseVideo();
            showToast(t('toast.host_ad'));
            log.debug('[YouTube Sync] Host ad detected — pausing guest');
          }
          _rt.lastHostSyncTime = hostTime;
          return; // Skip drift correction while ad is playing
        }
      } else {
        // Host time is moving again
        if (_rt.hostAdPauseActive) {
          _rt.hostAdPauseActive = false;
          if (player.playVideo) player.playVideo();
          log.debug('[YouTube Sync] Host ad ended — resuming guest');
        }
        _rt.hostTimeStaleCount = 0;
      }
      _rt.lastHostSyncTime = hostTime;
    } else {
      // Host explicitly paused — reset ad detection
      _rt.hostTimeStaleCount = 0;
      _rt.lastHostSyncTime = null;
      if (_rt.hostAdPauseActive) {
        _rt.hostAdPauseActive = false;
      }
    }

    // Video ID sync — fixes videoId mismatch (YouTube Mix ordering, sub-advance, etc.)
    // Single-video mode: always drive guest via loadVideoById. We never call
    // playVideoAt / loadPlaylist — the iframe's playlist engine is what OOMs
    // on 200+ item playlists, so the guest stays on one video at a time.
    const hostVideoId = (data.videoId as string) || '';
    if (hostVideoId && player.getVideoData) {
      const guestVideoId = player.getVideoData()?.video_id || '';
      if (guestVideoId && hostVideoId !== guestVideoId) {
        // Skip if another handler (handleYouTubeState) already initiated a
        // video load — calling loadVideoById again would interrupt it,
        // resetting buffering and extending the transition window.
        if (Date.now() < _rt.autoSyncUntil) {
          log.debug('[YouTube Sync] Video mismatch detected but load already in progress — skipping');
          return;
        }
        log.info(`[YouTube Sync] Video mismatch: guest=${guestVideoId}, host=${hostVideoId} — loadVideoById`);
        if (player.loadVideoById) {
          player.loadVideoById(hostVideoId);
          if (hostSubIndex !== undefined && hostSubIndex !== -1) {
            setYouTubeSubIndex(hostSubIndex);
          }
        }
        _rt.autoSyncUntil = Date.now() + LOAD_DRIFT_SUPPRESS_MS;
        return;
      }
    }

    // Sub-index state alignment — videoId already matched above, so if the
    // subIndex tracked in state still differs we just need to update state
    // (no player call needed; iframe is already on the right videoId).
    const currentSubIndex = getState('youtube.currentSubIndex') ?? -1;
    if (hostSubIndex !== undefined && hostSubIndex !== -1 && hostSubIndex !== currentSubIndex) {
      log.debug(`[YouTube Sync] Sub-index state alignment: ${currentSubIndex} -> ${hostSubIndex}`);
      setYouTubeSubIndex(hostSubIndex);
    }

    // Drift correction — uses raw hostTime without the manual sync.localOffset.
    // M3: sync.localOffset is the user's manual Bluetooth speaker compensation
    // for local audio playback. Applying it to YouTube iframe drift correction
    // would permanently offset the guest by whatever the user set on the slider.
    const rawCompensatedTime = hostTime;
    // Drift correction (skip if duration not loaded yet)
    const duration = (player.getDuration && player.getDuration()) || 0;
    if (duration > 0) {
      const compensatedTime = Math.max(0, Math.min(rawCompensatedTime, duration));
      const currentTime = player.getCurrentTime();
      const drift = Math.abs(currentTime - compensatedTime);

      if (drift > DRIFT_SEEK_THRESHOLD_SEC && player.seekTo) {
        log.debug(`[YouTube Sync] Drift ${drift.toFixed(1)}s, seeking to ${compensatedTime.toFixed(1)}s`);
        player.seekTo(compensatedTime, true);
      }
    }

    // State sync (always applied, even when duration not loaded)
    if (player.getPlayerState && player.playVideo && player.pauseVideo) {
      const ytState = player.getPlayerState();
      if (hostState === 1 && ytState !== 1) { setYtAutoplayIntent(true); player.playVideo(); }
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

  // Debounce: cooldown prevents rapid-fire calls that crash YouTube iframe
  const now = Date.now();
  if (_rt.rendezvousInProgress || now - _rt.lastRendezvousAt < RENDEZVOUS_COOLDOWN_MS) {
    log.debug('[Rendezvous] Debounced — in progress or cooldown');
    return;
  }

  // Need a fresh-enough host snapshot
  if (!_rt.lastHostSnapshot || (getHostNow() - _rt.lastHostSnapshot.hostClockAt) > RENDEZVOUS_SNAPSHOT_MAX_AGE_MS) {
    showToast(t('toast.yt_rendezvous_no_data'));
    return;
  }

  const snapshot = _rt.lastHostSnapshot;

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

  const guestPlayLatency = getState('youtube.guestPlayLatency') ?? 0;

  // Extrapolate host's current position
  const nowHost = getHostNow();
  const hostPosNow = snapshot.hostPosition + (nowHost - snapshot.hostClockAt) / 1000;
  const targetPosition = hostPosNow + RENDEZVOUS_MARGIN_SEC;

  // Host-clock instant when host's audible playback will reach targetPosition
  const tHostReachTarget = nowHost + RENDEZVOUS_MARGIN_SEC * 1000;
  // Guest should call playVideo() guestPlayLatency ms before that
  const playCallAtHostClock = tHostReachTarget - guestPlayLatency;

  log.debug(`[Rendezvous] Start: hostPosNow=${hostPosNow.toFixed(2)}s target=${targetPosition.toFixed(2)}s L_play=${guestPlayLatency}ms`);

  _rt.rendezvousInProgress = true;
  _rt.lastRendezvousAt = Date.now();
  // Suppress drift fighter for MARGIN + RENDEZVOUS_DRIFT_SUPPRESS_MS
  _rt.autoSyncUntil = Date.now() + RENDEZVOUS_MARGIN_SEC * 1000 + RENDEZVOUS_DRIFT_SUPPRESS_MS;
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
  const bufferDeadline = getHostNow() + RENDEZVOUS_MARGIN_SEC * 1000 - RENDEZVOUS_BUFFER_DEADLINE_OFFSET_MS;
  let bufferChecks = 0;

  const checkBuffer = (): void => {
    if (!_rt.rendezvousInProgress) return; // cancelled
    // Re-fetch player — it may have been destroyed during the polling gap
    const p = getYouTubePlayer();
    if (!p) { finishRendezvous(); return; }
    bufferChecks++;
    let pState = -1;
    try { pState = p.getPlayerState?.() ?? -1; } catch { /* noop */ }

    const bufferReady = pState === 2 || pState === 5;
    const outOfTime = getHostNow() > bufferDeadline;

    if (bufferReady) {
      log.debug(`[Rendezvous] Buffer ready after ${bufferChecks} checks (state=${pState})`);
      scheduleRendezvousPlay(playCallAtHostClock, targetPosition, snapshot);
      return;
    }

    if (outOfTime || bufferChecks > RENDEZVOUS_BUFFER_MAX_CHECKS) {
      log.warn(`[Rendezvous] Buffer gate timeout after ${bufferChecks} checks — aborting`);
      showToast(t('toast.yt_rendezvous_timeout'));
      finishRendezvous();
      return;
    }

    setManagedTimer('yt-rendezvous-buffer', checkBuffer, RENDEZVOUS_BUFFER_CHECK_INTERVAL_MS);
  };

  setManagedTimer('yt-rendezvous-buffer', checkBuffer, RENDEZVOUS_BUFFER_CHECK_INTERVAL_MS);
}

function scheduleRendezvousPlay(
  playCallAtHostClock: number,
  targetPosition: number,
  snapshot: HostPositionSnapshot,
): void {
  const waitMs = Math.max(0, playCallAtHostClock - getHostNow());
  log.debug(`[Rendezvous] Scheduling playVideo in ${waitMs.toFixed(0)}ms`);

  setManagedTimer('yt-rendezvous-play', () => {
    if (!_rt.rendezvousInProgress) return; // cancelled during wait
    const p = getYouTubePlayer();
    if (!p) { finishRendezvous(); return; }
    try {
      setYtAutoplayIntent(true); // authorize this play past pause-back guard
      p.playVideo();
    } catch (e) {
      log.warn('[Rendezvous] playVideo threw:', e);
      finishRendezvous();
      return;
    }
    bus.emit('youtube:sync-loading', false);
    showToast(t('toast.yt_rendezvous_done'));

    // Step 3: self-calibrate guestPlayLatency from measured drift (~800ms later)
    setManagedTimer('yt-rendezvous-calibrate', () => {
      _rt.rendezvousInProgress = false;
      const pCal = getYouTubePlayer();
      if (!pCal) return; // player destroyed — skip calibration
      try {
        // Guard: skip calibration if the video changed during rendezvous.
        // A different video means guestPos and hostPosNowMeasured are from
        // different timelines — the resulting driftMs would be wildly wrong,
        // corrupting guestPlayLatency (EMA) for all future rendezvous.
        const currentVideoId = pCal.getVideoData?.()?.video_id || '';
        const snapshotVideoId = snapshot._videoId || '';
        if (snapshotVideoId && currentVideoId !== snapshotVideoId) {
          log.debug('[Rendezvous] Calibration skipped — video changed during rendezvous');
          return;
        }

        const guestPos = pCal.getCurrentTime?.() ?? 0;
        // Re-extrapolate host position using the SAME snapshot (drift-free baseline)
        const hostPosNowMeasured =
          snapshot.hostPosition + (getHostNow() - snapshot.hostClockAt) / 1000;
        const driftSec = guestPos - hostPosNowMeasured; // + = guest ahead, − = guest behind
        const driftMs = driftSec * 1000;

        // Outlier rejection: drift samples larger than
        // LATENCY_OUTLIER_REJECT_MS are likely from a transitional state
        // (buffering, seek in progress, ad). Applying them to the EMA
        // would corrupt guestPlayLatency for 7-10 subsequent rendezvous
        // attempts. Skip silently.
        if (Math.abs(driftMs) > LATENCY_OUTLIER_REJECT_MS) {
          log.debug(`[Rendezvous] Calibration skipped — drift ${driftMs.toFixed(0)}ms exceeds outlier threshold`);
          return;
        }

        // Positive drift (guest ahead) means playVideo() fired too early → our L_play
        // estimate was too HIGH → DECREASE it. Hence minus sign.
        const current = getState('youtube.guestPlayLatency') ?? 0;
        const nextRaw = current - driftMs * LATENCY_EMA_RATE;
        const next = Math.round(Math.max(0, Math.min(LATENCY_CLAMP_MAX_MS, nextRaw)));
        if (next !== current) {
          setState('youtube.guestPlayLatency', next);
          try {
            localStorage.setItem('musixquare-yt-play-latency', String(next));
          } catch { /* storage unavailable — in-memory only is fine */ }
        }

        log.debug(
          `[Rendezvous] Calibrate: drift=${driftMs.toFixed(0)}ms, L_play ${current} → ${next} (target=${targetPosition.toFixed(2)}s measured=${guestPos.toFixed(2)}s)`,
        );
      } catch (e) {
        log.debug('[Rendezvous] Calibration skipped:', e);
      }
    }, RENDEZVOUS_CALIBRATE_DELAY_MS);
  }, waitMs);
}

function finishRendezvous(): void {
  _rt.rendezvousInProgress = false;
  _rt.autoSyncUntil = 0;
  clearManagedTimer('yt-rendezvous-buffer');
  clearManagedTimer('yt-rendezvous-play');
  clearManagedTimer('yt-rendezvous-calibrate');
  bus.emit('youtube:sync-loading', false);
}

/**
 * Cancel any in-progress rendezvous sync. Called when the host takes a
 * disruptive action (pause/seek/video-change) during the guest's wait.
 */
export function cancelGuestRendezvous(): void {
  if (!_rt.rendezvousInProgress) return;
  log.debug('[Rendezvous] Cancelled');
  clearManagedTimer('yt-rendezvous-calibrate');
  finishRendezvous();
}

/**
 * Full reset of all guest-side YouTube sync module state. Called from
 * stopYouTubeMode so a mid-sync mode exit (user navigated away, mode
 * switch, session leave) doesn't leave stale flags/timers/snapshots
 * that could block the next YouTube session's first rendezvous or let
 * drift correction fight a countdown that no longer exists.
 *
 * What gets reset:
 *   - _rt.rendezvousInProgress → false (unblocks guestRendezvousSync re-entry)
 *   - _rt.autoSyncUntil → 0 (re-enables drift correction immediately on next load)
 *   - _rt.lastHostSnapshot → null (next rendezvous must wait for a fresh host pong)
 *   - resetAdDetection() for host-ad pause tracking
 *   - all yt-rendezvous-* timers cleared (buffer / play / calibrate)
 *   - youtube:sync-loading overlay hidden
 */
export function resetYouTubeSyncState(): void {
  _rt.rendezvousInProgress = false;
  _rt.lastRendezvousAt = 0;
  _rt.autoSyncUntil = 0;
  _rt.lastHostSnapshot = null;
  resetAdDetection();
  clearManagedTimer('yt-rendezvous-buffer');
  clearManagedTimer('yt-rendezvous-play');
  clearManagedTimer('yt-rendezvous-calibrate');
  bus.emit('youtube:sync-loading', false);
}

// ─── Handle YouTube State (Host→Guest broadcast) ──────────────────

function handleYouTubeState(data: Record<string, unknown>): void {
  const player = getYouTubePlayer();
  const currentState = getState('appState');
  if (!player || currentState !== APP_STATE.PLAYING_YOUTUBE) return;

  // Host sent a new command — cancel the guest ENDED fallback timer.
  // (Guest defers IDLE transition on video end to wait for this message.)
  clearManagedTimer('yt-guest-ended-fallback');

  // Guard against malformed or missing state field. Number(undefined) → NaN,
  // and `NaN === 1/2/0/-1` is always false, so a missing state would silently
  // fall through to the generic code path below with unpredictable behaviour.
  // Drop the message entirely if state isn't a finite YT player-state value.
  const state = Number(data.state);
  if (!Number.isFinite(state)) {
    log.warn('[YouTube State] Dropping message with invalid state:', data.state);
    return;
  }

  // PAUSE/STOP always takes priority — cancel any pending auto-sync
  if (state === 2 || state === 0 || state === -1) {
    _rt.autoSyncUntil = 0;
    clearManagedTimer('yt-clock-action');
    bus.emit('youtube:sync-loading', false);
    cancelGuestRendezvous(); // Host paused/stopped while guest was rendezvousing
  }

  // "Last action wins": ALWAYS cancel any pending scheduled action from a
  // previous host command before processing this one. Without this, a rapid
  // seek / play / seek sequence on the host would get processed as the very
  // first command on the guest while subsequent commands fell into an early
  // return (we used to skip this function entirely during _rt.autoSyncUntil,
  // which caused the guest to honour only the earliest scheduled play and
  // drop every later host-initiated state change until the cooldown expired).
  //
  // The _rt.autoSyncUntil cooldown is kept ONLY for handleYouTubeSync (the 3s
  // periodic drift-correction broadcast) — its intent was to prevent drift
  // correction from fighting a scheduled play, not to block explicit host
  // actions. Explicit host actions (YOUTUBE_STATE) should always override.
  clearManagedTimer('yt-clock-action');
  clearManagedTimer('yt-seek-play');

  // M1: Cancel any in-progress guest rendezvous when a new host PLAY arrives.
  // Without this, a pending yt-rendezvous-play timer fires alongside the
  // yt-clock-action timer, causing a double playVideo() desync.
  if (state === 1 && _rt.rendezvousInProgress) {
    cancelGuestRendezvous();
  }

  // Skip state sync while host is likely watching an ad
  if (_rt.hostAdPauseActive) return;

  try {
    const time = Number(data.time) || 0;

    // Update host snapshot from explicit commands — not just heartbeats.
    // Without this, host seek/play commands don't update the snapshot,
    // so rendezvous pressed within 3s of a seek uses pre-seek position.
    updateHostSnapshot(time, state);

    // Apply title from host to maintain metadata sync (fixes "No Media" during loading)
    const hostTitle = data.title as string | undefined;
    if (hostTitle) {
      const currentMeta = getState('player.currentTrackMeta');
      if (currentMeta && currentMeta.title !== hostTitle) {
        setState('player.currentTrackMeta', { ...currentMeta, title: hostTitle });
      }
    }

    // Video ID sync — fixes Mix playlists where sub-index = different video
    let subIndexChanged = false;
    const hostVideoId = (data.videoId as string) || '';
    const subIndex = data.subIndex as number | undefined;

    if (hostVideoId && player.getVideoData) {
      const guestVideoId = player.getVideoData()?.video_id || '';
      if (guestVideoId && hostVideoId !== guestVideoId) {
        // Single-video mode: loadVideoById directly. No playlist engine,
        // no escalation tiers — one videoId at a time keeps the iframe
        // within mobile memory limits.
        log.info(`[YouTube State] Video mismatch — guest=${guestVideoId}, host=${hostVideoId} — loadVideoById`);
        if (player.loadVideoById) {
          player.loadVideoById(hostVideoId);
          if (subIndex !== undefined && subIndex !== -1) {
            setYouTubeSubIndex(subIndex);
          }
          subIndexChanged = true;
        }
        // Schedule a delayed play using hostPlayAt so the guest starts at
        // the same time as the host, even though the video is reloading.
        // Without this, the guest only plays when heartbeat state-sync
        // wakes it 5+ seconds later with no countdown alignment.
        const mismatchHostPlayAt = Number(data.hostPlayAt) || 0;
        if (mismatchHostPlayAt > 0 && isClockCalibrated()) {
          const waitForPlay = Math.max(MISMATCH_MIN_WAIT_MS, mismatchHostPlayAt - getHostNow());
          _rt.autoSyncUntil = Date.now() + waitForPlay + IMMEDIATE_ACTION_COOLDOWN_MS;
          bus.emit('youtube:sync-loading', true);
          setManagedTimer('yt-clock-action', () => {
            const p = getYouTubePlayer();
            if (p?.playVideo) {
              setYtAutoplayIntent(true);
              p.playVideo();
            }
            bus.emit('youtube:sync-loading', false);
          }, waitForPlay);
        } else {
          _rt.autoSyncUntil = Date.now() + LOAD_DRIFT_SUPPRESS_MS;
        }
        return;
      }
    }

    // Sub-index state alignment — videoId already matched above, so just
    // update state if the tracked subIndex differs. No player call needed.
    if (!subIndexChanged && subIndex !== undefined && subIndex >= 0) {
      const currentTrack = (getState('playlist.items') || [])[getState('playlist.currentTrackIndex')];
      const isPlaylistTrack = !!currentTrack?.playlistId;
      const currentSubIndex = getState('youtube.currentSubIndex') ?? -1;
      if (isPlaylistTrack && currentSubIndex !== subIndex) {
        setYouTubeSubIndex(subIndex);
        subIndexChanged = true;
      }
    }

    // ENDED/UNSTARTED: stop immediately, skip all play/pause sync logic.
    // Without this, state=0 with non-zero hostPlayAt could fall into the
    // short-wait or executeImmediate paths, wastefully setting _rt.autoSyncUntil.
    if (state === 0 || state === -1) {
      if (player.stopVideo) player.stopVideo();
      return;
    }

    // SharedClock: schedule YouTube action at host-specified time
    const hostPlayAt = Number(data.hostPlayAt) || 0;
    const duration = player.getDuration?.() || 0;

    if (hostPlayAt > 0 && isClockCalibrated()) {
      const waitMs = Math.max(0, hostPlayAt - getHostNow());

      if (waitMs > SHORT_WAIT_THRESHOLD_MS && waitMs < AUTO_SYNC_MAX_WAIT_MS && state === 1) {
        // ── Auto-sync path: significant wait (>SHORT_WAIT_THRESHOLD_MS) + play command ──
        // 1. Pause immediately for clean sync
        if (player.pauseVideo) player.pauseVideo();

        // 2. Seek to target position (while paused = in-buffer, no rebuffer)
        if (!subIndexChanged && player.seekTo) player.seekTo(time, true);

        // 3. Update seekbar immediately
        if (time >= 0 && duration >= 0) {
          bus.emit('ui:time-update', fmtTime(time), fmtTime(duration), time, duration);
        }

        // 4. Suppress drift correction during wait
        _rt.autoSyncUntil = Date.now() + waitMs + POST_SCHEDULED_ACTION_COOLDOWN_MS;

        // 5. Show sync loading state on guest
        bus.emit('youtube:sync-loading', true);
        showToast(t('toast.yt_sync_start'));

        // 6. Play at scheduled time
        setManagedTimer('yt-clock-action', () => {
          const p = getYouTubePlayer();
          if (p?.playVideo) {
            setYtAutoplayIntent(true); // authorize this play past pause-back guard
            p.playVideo();
          }
          bus.emit('youtube:sync-loading', false);
          showToast(t('toast.yt_sync_done'));
        }, waitMs);

        log.debug(`[YouTube State] Auto-sync: pause+seek, play in ${waitMs}ms`);
      } else if (waitMs > 0 && waitMs <= SHORT_WAIT_THRESHOLD_MS) {
        // Short wait (≤SHORT_WAIT_THRESHOLD_MS) — schedule with brief pause-seek-play
        // M6: clamp to [0, duration] to avoid seeking past the end which
        // triggers a premature ENDED event and track-advance on the guest.
        const rawCompensated = time + (waitMs / 1000);
        const compensatedTime = duration > 0 ? Math.max(0, Math.min(rawCompensated, duration)) : rawCompensated;
        if (compensatedTime >= 0 && duration >= 0) {
          bus.emit('ui:time-update', fmtTime(compensatedTime), fmtTime(duration), compensatedTime, duration);
        }
        _rt.autoSyncUntil = Date.now() + IMMEDIATE_ACTION_COOLDOWN_MS;
        setManagedTimer('yt-clock-action', () => {
          const p = getYouTubePlayer();
          if (!p) return;
          if (state === 1 && p.playVideo) {
            // Pause-seek-play: same pattern as executeImmediate to avoid
            // seekTo+playVideo race on the YouTube iframe.
            if (!subIndexChanged && p.seekTo) {
              p.pauseVideo?.();
              p.seekTo(compensatedTime, true);
              setManagedTimer('yt-seek-play', () => {
                const p2 = getYouTubePlayer();
                if (p2?.playVideo) { setYtAutoplayIntent(true); p2.playVideo(); }
              }, SEEK_PLAY_GAP_MS);
            } else {
              setYtAutoplayIntent(true);
              p.playVideo();
            }
          } else if (state === 2 && p.pauseVideo) {
            p.pauseVideo();
            if (p.seekTo) p.seekTo(compensatedTime, true);
          }
        }, waitMs);
      } else {
        // No wait or out of range — execute immediately
        executeImmediate(player, state, time, duration, subIndexChanged);
      }
    } else {
      // No hostPlayAt, or clock uncalibrated (late-join, no pongs yet) — execute immediately.
      // An uncalibrated clock means getHostNow() returns raw Date.now() with zero offset,
      // making hostPlayAt-based countdown inaccurate. Immediate play is safe because the
      // periodic sync pong (1s interval) will calibrate and correct drift shortly after.
      if (hostPlayAt > 0) {
        log.warn('[YouTube State] SharedClock uncalibrated — ignoring hostPlayAt, executing immediately');
      }
      executeImmediate(player, state, time, duration, subIndexChanged);
    }

  } catch (e) {
    log.error('[YouTube State] Error:', e);
  }
}

/** Immediate action helper (no SharedClock delay).
 *  Suppresses drift correction briefly so the next heartbeat
 *  doesn't overwrite the seek with a stale position. */
function executeImmediate(
  player: YouTubePlayerInstance, state: number, time: number, duration: number, subIndexChanged: boolean,
): void {
  // Clear any orphaned scheduled action — this immediate command supersedes it
  clearManagedTimer('yt-clock-action');
  clearManagedTimer('yt-seek-play');
  if (time >= 0 && duration >= 0) {
    bus.emit('ui:time-update', fmtTime(time), fmtTime(duration), time, duration);
  }

  // Suppress drift correction while YouTube buffers the seek.
  _rt.autoSyncUntil = Date.now() + IMMEDIATE_ACTION_COOLDOWN_MS;

  if (state === 1 && player.playVideo) {
    if (!subIndexChanged && player.seekTo) {
      // Pause-seek-play: seek while paused, then play after SEEK_PLAY_GAP_MS.
      // Uses a SEPARATE timer name so a new YOUTUBE_STATE arriving during
      // the gap doesn't cancel the pending playVideo without scheduling
      // a replacement (yt-clock-action is cleared at the top of
      // handleYouTubeState, but yt-seek-play is not).
      player.pauseVideo?.();
      player.seekTo(time, true);
      setManagedTimer('yt-seek-play', () => {
        const p = getYouTubePlayer();
        if (p?.playVideo) { setYtAutoplayIntent(true); p.playVideo(); }
      }, SEEK_PLAY_GAP_MS);
    } else {
      setYtAutoplayIntent(true);
      player.playVideo();
    }
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

  if (!playlistId || !Number.isInteger(subIdx) || subIdx < 0 || !title) return;

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
  const ids = ((data.ids as string[]) || []).slice(0, PLAYLIST_MAX_ITEMS);
  const titles = ((data.titles as string[]) || []).slice(0, PLAYLIST_MAX_ITEMS);

  if (!playlistId) return;

  setSubItemsData(playlistId, ids, titles);

  // Guest can also fetch missing titles in background
  if (ids && ids.length > 0) {
    fetchPlaylistSubTitles(playlistId, ids);
  }
}

// ─── Handle YouTube Stop ──────────────────────────────────────────

function handleYouTubeStop(): void {
  _rt.autoSyncUntil = 0;
  log.debug('[Guest] Received youtube-stop, switching to local mode');
  resetAdDetection();
  clearManagedTimer('yt-clock-action');
  clearManagedTimer('yt-guest-ended-fallback');
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
    _rt.autoSyncUntil = 0;
    resetAdDetection();
  });

  log.info('[YouTube Sync] Initialized');
}
