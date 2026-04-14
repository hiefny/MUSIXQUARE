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
import { getYouTubePlayer, setYouTubeSubIndex, updateSubItemTitle, setSubItemsData, setYtAutoplayIntent } from './_state.ts';
import { fetchPlaylistSubTitles } from './search.ts';
import { showToast } from '../ui/toast.ts';

// ─── Broadcast YouTube Sync (Host) ────────────────────────────────

export function broadcastYouTubeSync(): void {
  const player = getYouTubePlayer();
  const hostConn = getState('network.hostConn');
  if (!player || hostConn || !player.getCurrentTime) return;

  // Suppress heartbeat while auto-sync countdown is active.
  // During the countdown the host is paused+seeking — getCurrentTime()
  // may return a stale (pre-seek) value. Broadcasting that stale position
  // causes ALL guests' drift correction to undo the seek, even though
  // they already received the correct position via YOUTUBE_STATE.
  if (getManagedTimer('yt-auto-sync') || getManagedTimer('yt-sync-grace')) return;

  try {
    const currentTime = player.getCurrentTime();
    const state = player.getPlayerState ? player.getPlayerState() : -1;

    // Single-video mode: subItemsMap is the source of truth for sub-index.
    // No getPlaylistIndex/getPlaylist polling needed — sub-video sequencing
    // is driven by ENDED events in iframe.ts.
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

/** Suppress drift correction + state sync for the given duration.
 *  Called from iframe.ts after loadVideoById/loadPlaylist to prevent
 *  heartbeat state-sync from waking the guest prematurely. */
export function suppressDriftUntil(ms: number): void {
  // Use Math.max to never shorten an existing suppression window.
  // handleYouTubeState may have set a longer window (waitMs + 1500)
  // that this async call from iframe.ts must not overwrite.
  _autoSyncUntil = Math.max(_autoSyncUntil, Date.now() + ms);
}

// ─── Host Position Snapshot Cache (Guest-side) ───────────────────
// Updated on every MSG.YOUTUBE_SYNC heartbeat (~3s interval on host).
// Consumed by guestRendezvousSync() to extrapolate host's current position
// using the shared clock. hostClockAt is in host-clock milliseconds so
// extrapolation composes directly with getHostNow().

interface HostPositionSnapshot {
  hostClockAt: number; // host-clock ms when snapshot was taken
  hostPosition: number; // video position (seconds)
  hostState: number; // YT PlayerState (1=playing, 2=paused, ...)
  _videoId?: string; // video ID at snapshot time (for calibration cross-check)
}
let _lastHostSnapshot: HostPositionSnapshot | null = null;

function updateHostSnapshot(hostTime: number, hostState: number, hostClock?: number): void {
  const player = getYouTubePlayer();
  _lastHostSnapshot = {
    hostClockAt: hostClock ?? getHostNow(),
    hostPosition: hostTime,
    hostState,
    _videoId: player?.getVideoData?.()?.video_id || '',
  };
}

// ─── Rendezvous Sync State (Guest-side) ──────────────────────────

let _rendezvousInProgress = false;
let _lastRendezvousAt = 0; // Cooldown to prevent rapid-fire (YouTube API crash)

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
    const hostClock = Number(data.hostClock) || undefined;

    // Cache latest host position for rendezvous sync extrapolation
    updateHostSnapshot(hostTime, hostState, hostClock);

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
        // Skip if another handler already initiated a load
        if (Date.now() < _autoSyncUntil) {
          log.debug('[YouTube Sync] Video mismatch but load in progress — skipping');
          return;
        }
        // Single-video mode: just load the correct video directly.
        // No playlist engine, no escalation — loadVideoById is lightweight.
        log.info(`[YouTube Sync] Video mismatch: guest=${guestVideoId}, host=${hostVideoId} — loading via loadVideoById`);
        if (player.loadVideoById) {
          player.loadVideoById(hostVideoId);
          if (hostSubIndex !== undefined && hostSubIndex !== -1) {
            setYouTubeSubIndex(hostSubIndex);
          }
        }
        _autoSyncUntil = Date.now() + 5000;
        return;
      }
    }

    // Sub-index change (tracking only — no playVideoAt in single-video mode)
    const currentSubIndex = getState('youtube.currentSubIndex') ?? -1;
    if (hostSubIndex !== undefined && hostSubIndex !== -1 && hostSubIndex !== currentSubIndex) {
      log.debug(`[YouTube Sync] Sub-index change: ${currentSubIndex} -> ${hostSubIndex}`);
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

      if (drift > 3 && player.seekTo) {
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
  if (_rendezvousInProgress || now - _lastRendezvousAt < 3000) {
    log.debug('[Rendezvous] Debounced — in progress or cooldown');
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

  const guestPlayLatency = getState('youtube.guestPlayLatency') ?? 0;
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
  _lastRendezvousAt = Date.now();
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

    if (outOfTime || bufferChecks > 100) {
      log.warn(`[Rendezvous] Buffer gate timeout after ${bufferChecks} checks — aborting`);
      showToast(t('toast.yt_rendezvous_timeout'));
      finishRendezvous();
      return;
    }

    setManagedTimer('yt-rendezvous-buffer', checkBuffer, 50);
  };

  setManagedTimer('yt-rendezvous-buffer', checkBuffer, 50);
}

function scheduleRendezvousPlay(
  playCallAtHostClock: number,
  targetPosition: number,
  snapshot: HostPositionSnapshot,
): void {
  const waitMs = Math.max(0, playCallAtHostClock - getHostNow());
  log.debug(`[Rendezvous] Scheduling playVideo in ${waitMs.toFixed(0)}ms`);

  setManagedTimer('yt-rendezvous-play', () => {
    if (!_rendezvousInProgress) return; // cancelled during wait
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
      _rendezvousInProgress = false;
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

        // Outlier rejection: if drift exceeds 2 seconds, the measurement is
        // likely from a transitional state (buffering, seek in progress, ad).
        // Applying it to the EMA would corrupt guestPlayLatency for 7-10
        // subsequent rendezvous attempts. Skip silently.
        if (Math.abs(driftMs) > 2000) {
          log.debug(`[Rendezvous] Calibration skipped — drift ${driftMs.toFixed(0)}ms exceeds 2s outlier threshold`);
          return;
        }

        // Positive drift (guest ahead) means playVideo() fired too early → our L_play
        // estimate was too HIGH → DECREASE it. Hence minus sign.
        const current = getState('youtube.guestPlayLatency') ?? 0;
        const LR = 0.3;
        const nextRaw = current - driftMs * LR;
        const next = Math.round(Math.max(0, Math.min(600, nextRaw)));
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

/**
 * Full reset of all guest-side YouTube sync module state. Called from
 * stopYouTubeMode so a mid-sync mode exit (user navigated away, mode
 * switch, session leave) doesn't leave stale flags/timers/snapshots
 * that could block the next YouTube session's first rendezvous or let
 * drift correction fight a countdown that no longer exists.
 *
 * What gets reset:
 *   - _rendezvousInProgress → false (unblocks guestRendezvousSync re-entry)
 *   - _autoSyncUntil → 0 (re-enables drift correction immediately on next load)
 *   - _lastHostSnapshot → null (next rendezvous must wait for a fresh host pong)
 *   - _mixReloadedIds cleared (Mix reload suppression doesn't carry over)
 *   - resetAdDetection() for host-ad pause tracking
 *   - all yt-rendezvous-* timers cleared (buffer / play / calibrate)
 *   - youtube:sync-loading overlay hidden
 */
export function resetYouTubeSyncState(): void {
  _rendezvousInProgress = false;
  _autoSyncUntil = 0;
  _lastHostSnapshot = null;
  _mixReloadedIds.clear();
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
    _autoSyncUntil = 0;
    clearManagedTimer('yt-clock-action');
    bus.emit('youtube:sync-loading', false);
    cancelGuestRendezvous(); // Host paused/stopped while guest was rendezvousing
  }

  // "Last action wins": ALWAYS cancel any pending scheduled action from a
  // previous host command before processing this one. Without this, a rapid
  // seek / play / seek sequence on the host would get processed as the very
  // first command on the guest while subsequent commands fell into an early
  // return (we used to skip this function entirely during _autoSyncUntil,
  // which caused the guest to honour only the earliest scheduled play and
  // drop every later host-initiated state change until the cooldown expired).
  //
  // The _autoSyncUntil cooldown is kept ONLY for handleYouTubeSync (the 3s
  // periodic drift-correction broadcast) — its intent was to prevent drift
  // correction from fighting a scheduled play, not to block explicit host
  // actions. Explicit host actions (YOUTUBE_STATE) should always override.
  clearManagedTimer('yt-clock-action');

  // M1: Cancel any in-progress guest rendezvous when a new host PLAY arrives.
  // Without this, a pending yt-rendezvous-play timer fires alongside the
  // yt-clock-action timer, causing a double playVideo() desync.
  if (state === 1 && _rendezvousInProgress) {
    cancelGuestRendezvous();
  }

  // Skip state sync while host is likely watching an ad
  if (_hostAdPauseActive) return;

  try {
    const time = Number(data.time) || 0;

    // Update host snapshot from explicit commands — not just heartbeats.
    // Without this, host seek/play commands don't update the snapshot,
    // so rendezvous pressed within 3s of a seek uses pre-seek position.
    updateHostSnapshot(time, state);

    // Video ID sync — fixes Mix playlists where sub-index = different video
    let subIndexChanged = false;
    const hostVideoId = (data.videoId as string) || '';
    const subIndex = data.subIndex as number | undefined;

    if (hostVideoId && player.getVideoData) {
      const guestVideoId = player.getVideoData()?.video_id || '';
      if (guestVideoId && hostVideoId !== guestVideoId) {
        // Single-video mode: just load the correct video directly.
        log.info(`[YouTube State] Video mismatch — loading ${hostVideoId}`);
        if (player.loadVideoById) {
          player.loadVideoById(hostVideoId);
          if (subIndex !== undefined) setYouTubeSubIndex(subIndex);
          subIndexChanged = true;
        }
        // Schedule play using hostPlayAt for synchronized start
        const mismatchHostPlayAt = Number(data.hostPlayAt) || 0;
        if (mismatchHostPlayAt > 0 && isClockCalibrated()) {
          const waitForPlay = Math.max(500, mismatchHostPlayAt - getHostNow());
          _autoSyncUntil = Date.now() + waitForPlay + 3000;
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
          _autoSyncUntil = Date.now() + 5000;
        }
        return;
      }
    }

    // Track sub-index from host (no playVideoAt — single-video mode)
    if (!subIndexChanged && subIndex !== undefined && subIndex >= 0) {
      setYouTubeSubIndex(subIndex);
    }

    // SharedClock: schedule YouTube action at host-specified time
    const hostPlayAt = Number(data.hostPlayAt) || 0;
    const duration = player.getDuration?.() || 0;

    if (hostPlayAt > 0 && isClockCalibrated()) {
      const waitMs = Math.max(0, hostPlayAt - getHostNow());

      if (waitMs > 300 && waitMs < 3000 && state === 1) {
        // ── Auto-sync path: significant wait (>300ms) + play command ──
        // 1. Pause immediately for clean sync
        if (player.pauseVideo) player.pauseVideo();

        // 2. Seek to target position (while paused = in-buffer, no rebuffer)
        if (!subIndexChanged && player.seekTo) player.seekTo(time, true);

        // 3. Update seekbar immediately
        if (time >= 0 && duration >= 0) {
          bus.emit('ui:time-update', fmtTime(time), fmtTime(duration), time, duration);
        }

        // 4. Suppress drift correction during wait
        _autoSyncUntil = Date.now() + waitMs + 1500;

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
      } else if (waitMs > 0 && waitMs <= 300) {
        // Short wait (≤300ms) — schedule with brief pause-seek-play
        // M6: clamp to [0, duration] to avoid seeking past the end which
        // triggers a premature ENDED event and track-advance on the guest.
        const rawCompensated = time + (waitMs / 1000);
        const compensatedTime = duration > 0 ? Math.max(0, Math.min(rawCompensated, duration)) : rawCompensated;
        if (compensatedTime >= 0 && duration >= 0) {
          bus.emit('ui:time-update', fmtTime(compensatedTime), fmtTime(duration), compensatedTime, duration);
        }
        _autoSyncUntil = Date.now() + 3000;
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
              }, 150);
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

    if (state === 0 || state === -1) {
      if (player.stopVideo) player.stopVideo();
    }
  } catch (e) {
    log.error('[YouTube State] Error:', e);
  }
}

/** Immediate action helper (no SharedClock delay).
 *  Suppresses drift correction briefly so the next heartbeat
 *  doesn't overwrite the seek with a stale position. */
function executeImmediate(
  player: any, state: number, time: number, duration: number, subIndexChanged: boolean,
): void {
  // Clear any orphaned scheduled action — this immediate command supersedes it
  clearManagedTimer('yt-clock-action');
  if (time >= 0 && duration >= 0) {
    bus.emit('ui:time-update', fmtTime(time), fmtTime(duration), time, duration);
  }

  // Suppress drift correction while YouTube buffers the seek.
  _autoSyncUntil = Date.now() + 3000;

  if (state === 1 && player.playVideo) {
    if (!subIndexChanged && player.seekTo) {
      // Pause-seek-play: seek while paused, then play after 150ms.
      // Uses a SEPARATE timer name so a new YOUTUBE_STATE arriving during
      // the 150ms gap doesn't cancel the pending playVideo without
      // scheduling a replacement (yt-clock-action is cleared at the top
      // of handleYouTubeState, but yt-seek-play is not).
      player.pauseVideo?.();
      player.seekTo(time, true);
      setManagedTimer('yt-seek-play', () => {
        const p = getYouTubePlayer();
        if (p?.playVideo) { setYtAutoplayIntent(true); p.playVideo(); }
      }, 150);
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

  // Single-video mode: no playlist reload needed. Guest just stores the
  // sub-item IDs for sequencing — the host sends the correct videoId
  // via YOUTUBE_STATE for each track change.

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
    _autoSyncUntil = 0;
    resetAdDetection();
    _mixReloadedIds.clear();
  });

  log.info('[YouTube Sync] Initialized');
}
