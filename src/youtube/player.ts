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
import { clearManagedTimer, setManagedTimer, getManagedTimer } from '../core/timers.ts';
import { setAppState } from '../player/transport.ts';
import { broadcast, safeSend, sendToHost } from '../network/peer.ts';
import { getHostNow } from '../network/shared-clock.ts';
import {
  YT_AUTO_SYNC_MS,
  STAGE2_RENDEZVOUS_BROADCAST_MS,
  TRACK_TRANSITION_RENDEZVOUS_MS,
  PLAYLIST_MAX_ITEMS,
  PREV_TRACK_RESTART_THRESHOLD_SEC,
  BROADCAST_SYNC_MIN_INTERVAL_MS,
} from './constants.ts';

// YouTube rendezvous-autoplay flag: set by any caller that loaded a track
// with autoplay=false but wants playback to start once the player (or its
// async load) is ready. Consumed by two paths:
//   1. 'youtube:player-ready' (new player instance just initialized)
//   2. iframe.ts onStateChange PLAYING branch (existing player, async
//      loadPlaylist/loadVideoById completed)
// Both route through 'youtube:auto-play' → scheduleYtAutoSync so the 1-sec
// rendezvous countdown keeps host/guest aligned instead of each device
// running its own autoplay timing.
let _pendingAutoSyncOnReady = false;
export function setPendingAutoSyncOnReady(v: boolean): void { _pendingAutoSyncOnReady = v; }
export function getPendingAutoSyncOnReady(): boolean { return _pendingAutoSyncOnReady; }
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
  isYtIndexing,
  setYtIndexing,
  setYtIndexingCallback,
} from './_state.ts';

import { loadYouTubeVideo, refreshYouTubeDisplay, markYtStateBroadcast } from './iframe.ts';
import { showLoader } from '../ui/toast.ts';

import {
  handleYouTubePlay,
  handleRequestYouTubePlay,
  handleRequestYouTubePause,
  handleRequestYouTubeToggle,
  handleRequestYouTubeSubSeek,
  handleRequestYouTubePlaylistInfo,
} from './handlers.ts';
import { broadcastYouTubeSync, resetYouTubeSyncState } from './sync.ts';
import { showToast } from '../ui/toast.ts';

import type { YTNamespace } from './_state.ts';
declare const YT: YTNamespace;

// ─── Re-exports ────────────────────────────────────────────────────
// External modules (e.g. sync.ts) import { getYouTubePlayer } from './player.ts'

export { getYouTubePlayer } from './_state.ts';
export { loadYouTubeVideo } from './iframe.ts';

// ─── YouTube Auto-Sync (SharedClock) ──────────────────────────────
// Every play/seek action delays 1s so all devices start simultaneously.

/**
 * Immediate host action followed by a 2-second delayed rendezvous sync.
 * Provides instant responsiveness for the host and immediate reaction for guests,
 * with a precision "catch-up" (rendezvous) occurring 2 seconds later.
 */
export function scheduleYtAutoSync(
  targetTime: number,
  overrides?: { subIndex?: number; videoId?: string; skipSeek?: boolean; rendezvousDelayMs?: number; state?: number },
): void {
  const player = getYouTubePlayer();
  if (!player) return;

  const targetState = overrides?.state ?? 1; // Default to PLAYING
  const subIndex = overrides?.subIndex ?? getState('youtube.currentSubIndex') ?? -1;
  const videoId = (overrides?.videoId ?? player.getVideoData?.()?.video_id) || '';

  // 1. Host: Execute action immediately
  if (!overrides?.skipSeek && targetTime >= 0) {
    player.seekTo(targetTime, true);
  }
  if (targetState === 1) {
    setYtAutoplayIntent(true);
    player.playVideo?.();
  } else if (targetState === 2) {
    player.pauseVideo?.();
  }

  // 2. Broadcast Stage 1: Immediate Reaction
  // Guests will perform a rough seek/play to minimize initial lag.
  markYtStateBroadcast();
  broadcast({
    type: MSG.YOUTUBE_STATE,
    state: targetState,
    time: targetTime,
    subIndex,
    videoId,
    hostPlayAt: 0,
    hostClock: getHostNow(),
    title: player.getVideoData?.()?.title || '',
  });

  // 3. Broadcast Stage 2: Precision Rendezvous (Fixed delay)
  // Ensures all guests reach perfect alignment regardless of buffering speed.
  const waitMs = overrides?.rendezvousDelayMs ?? STAGE2_RENDEZVOUS_BROADCAST_MS;
  clearManagedTimer('yt-auto-sync');
  setManagedTimer('yt-auto-sync', () => {
    const p = getYouTubePlayer();
    if (!p) return;

    markYtStateBroadcast();
    broadcastYouTubeSync(true);
    log.debug(`[YouTube] Sync: Mandatory precision rendezvous sent after ${waitMs}ms`);
  }, waitMs);
}

/** Cancel any pending auto-sync (e.g. user paused during rendezvous). */
export function cancelYtAutoSync(): void {
  clearManagedTimer('yt-auto-sync');
  clearManagedTimer('yt-sync-grace');
  bus.emit('youtube:sync-loading', false);
}

// ─── Stop YouTube Mode ─────────────────────────────────────────────

export function stopYouTubeMode(): void {
  getYtScope()?.dispose();
  setYtScope(null);
  setYtLoadInProgress(false);
  setCachedYtDuration(0); // Reset duration cache
  const currentState = getState('appState');
  const wasInYouTube = currentState === APP_STATE.PLAYING_YOUTUBE;
  // Preservation: do not reset sub-index to -1 if we are or will be in YouTube mode.
  // This prevents clobbering the sub-index 0 set during the indexing callback.
  if (!wasInYouTube && currentState !== APP_STATE.IDLE && !isYtIndexing() && !isYtLoadInProgress()) {
    setYouTubeSubIndex(-1);
  }
  _pendingAutoSyncOnReady = false; // Clear pending URL-input sync if any

  // Only leave YouTube mode (set appState to IDLE) when we're actually
  // leaving — avoids spurious transitions from stopAllMedia→stopYouTubeMode
  // inside loadYouTubeVideo which would kill the guest's YouTube player
  // right after YOUTUBE_PLAY.
  if (wasInYouTube) {
    setAppState(APP_STATE.IDLE);
  }

  clearManagedTimer('youtubeUILoop');
  clearManagedTimer('youtubeSyncLoop');
  clearManagedTimer('yt-first-track-fisher');
  clearManagedTimer('yt-playlist-snapshot');
  cancelYtAutoSync(); // Clear pending auto-sync timer + loading state

  // M2: Clear the guest-side yt-clock-action timer (scheduled by
  // handleYouTubeState for delayed play/pause). Without this, the timer
  // fires after the player is destroyed and calls playVideo/pauseVideo
  // on a null player, producing console errors and orphaned toasts.
  clearManagedTimer('yt-clock-action');
  clearManagedTimer('yt-seek-play');
  clearManagedTimer('yt-guest-ended-fallback');

  clearManagedTimer('yt-load-timeout');
  clearManagedTimer('yt-mix-snapshot');
  clearManagedTimer('yt-refresh-display');

  // Disconnect relay upstream so stale relay doesn't pump chunks when
  // switching to file mode. Guest-only — host doesn't have upstreamDataConn.
  const upstreamDataConn = getState('relay.upstreamDataConn');
  if (upstreamDataConn) {
    try { upstreamDataConn.close(); } catch { /* noop */ }
    setState('relay.upstreamDataConn', null);
  }

  // Full reset of guest-side sync module state (rendezvous flag, host
  // snapshot, drift-correction cooldown, ad detection, rendezvous timers).
  // Without this, a mid-rendezvous mode exit would leak timers, leave
  // rendezvousInProgress=true (blocking next rendezvous), leave
  // autoSyncUntil pinned to a future timestamp (blocking drift correction),
  // and leave lastHostSnapshot pointing to stale host-clock data.
  // Static import is safe: sync.ts does not import from player.ts.
  resetYouTubeSyncState();

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

  // Notify guests to stop YouTube (Host only) — only when actually leaving YouTube mode
  if (wasInYouTube) {
    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      broadcast({ type: MSG.YOUTUBE_STOP });
    }
  }

  log.debug('[YouTube] Mode stopped');
}

// ─── Sub-Video Navigation Helper ───────────────────────────────────

/**
 * Single-video navigation using the host-snapshotted subItemsMap.
 * Never calls `playVideoAt` — the iframe's playlist engine is what OOMs on
 * 200+ item playlists, so we keep the iframe on one video at a time.
 *
 * If the subItemsMap is empty, tries emergency population from
 * `player.getPlaylist()` so that fast Next/Prev clicks work before the
 * background snapshot/fetcher fires.
 */
function navigateSubVideo(
  direction: 1 | -1,
  callback: (success: boolean) => void,
): void {
  const player = getYouTubePlayer();
  if (!player?.loadVideoById) { callback(false); return; }

  try {
    const currentTrack = (getState('playlist.items') || [])[getState('playlist.currentTrackIndex')];
    const pid = currentTrack?.playlistId as string;
    if (!pid) { callback(false); return; }

    let subData = (getState('youtube.subItemsMap') || {})[pid];

    if ((!subData || !subData.ids.length) && player.getPlaylist) {
      const rawIds = player.getPlaylist() || [];
      if (rawIds.length > 0) {
        const ids = rawIds.slice(0, PLAYLIST_MAX_ITEMS);
        updateSubItemIds(pid, ids);
        subData = { ids, titles: [] }; // Locally use for this tick
      }
    }

    const idx = getState('youtube.currentSubIndex') ?? -1;
    const targetIdx = idx + direction;
    let inBounds = direction === 1
      ? (idx >= 0 && !!subData?.ids && idx < subData.ids.length - 1)
      : (idx > 0 && !!subData?.ids);

    // Fallback: about to fall off the end forward, but the iframe may have
    // lazily populated more items since the initial indexing snapshot.
    // Re-read getPlaylist() and retry if the cached list was truncated.
    if (!inBounds && direction === 1 && player.getPlaylist) {
      try {
        const freshIds = (player.getPlaylist() || []).slice(0, PLAYLIST_MAX_ITEMS);
        if (freshIds.length > (subData?.ids?.length ?? 0)) {
          log.info(`[YouTube] navigate refresh: ${subData?.ids?.length ?? 0} -> ${freshIds.length} items`);
          updateSubItemIds(pid, freshIds);
          subData = { ids: freshIds, titles: subData?.titles || [] };
          inBounds = idx >= 0 && idx < freshIds.length - 1;
        }
      } catch (e) { log.debug('[YouTube] navigate refresh error:', e); }
    }

    if (inBounds && subData?.ids) {
      const targetVideoId = subData.ids[targetIdx];
      setYouTubeSubIndex(targetIdx);
      player.loadVideoById(targetVideoId);
      scheduleYtAutoSync(0, { subIndex: targetIdx, videoId: targetVideoId, skipSeek: true });
      callback(true);
      return;
    }
  } catch (e) {
    log.debug(`[YouTube] navigate ${direction === 1 ? 'next' : 'prev'} error:`, e);
  }
  callback(false);
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

    // Host direct
    const player = getYouTubePlayer();
    if (!player) return;
    try {
      const state = player.getPlayerState();
      const currentTime = player.getCurrentTime?.() || 0;
      if (state === YT.PlayerState.PLAYING) {
        // PAUSE: immediate, no delay
        cancelYtAutoSync();
        markYtStateBroadcast();
        broadcast({
          type: MSG.YOUTUBE_STATE,
          state: 2, // PAUSED
          time: currentTime,
          subIndex: getState('youtube.currentSubIndex') ?? -1,
          videoId: player.getVideoData?.()?.video_id || '',
          hostClock: getHostNow(),
        });
        player.pauseVideo();
        markYtStateBroadcast();
      } else {
        // PLAY: 1s auto-sync delay
        scheduleYtAutoSync(currentTime);
      }
    } catch (e) {
      log.error('[YouTube] Toggle play error:', e);
    }
  });

  bus.on('youtube:auto-play', () => {
    const player = getYouTubePlayer();
    if (player?.playVideo) {
      // Flip intent BEFORE scheduleYtAutoSync so its final playVideo()
      // doesn't get caught by onStateChange's pause-back guard (the guard
      // was armed by loadYouTubeVideo's autoplay=false default).
      setYtAutoplayIntent(true);
      // Use scheduleYtAutoSync instead of raw playVideo so this path
      // (auto-play after track load or end-of-video auto-advance) goes
      // through the same 2-stage rendezvous broadcast as every other
      // host-initiated YouTube play, keeping guests aligned instead of
      // forcing drift correction to clean up afterwards.
      //
      // skipSeek:true — the freshly loaded video is already at position 0,
      // so seekTo(0) would be a wasted round-trip (and may trigger an
      // unwanted BUFFERING transition on CUED players).
      // playTrack already waited ~1s (or on_ready took at least ~1s), so
      // STAGE2_RENDEZVOUS_BROADCAST_MS (2s) leaves ~3s total safe delay.
      scheduleYtAutoSync(0, { skipSeek: true, rendezvousDelayMs: STAGE2_RENDEZVOUS_BROADCAST_MS });
    }
  });

  // YouTube sub-video auto-advance inside a playlist: iframe.ts's
  // updateYouTubeUI detects the sub-index transition and emits this event
  // (ENDED does not fire for intra-playlist boundaries, so the normal
  // playlist:next-track path is bypassed). We re-apply the 1-sec rendezvous
  // sync here so guests stay aligned across the sub-video boundary.
  bus.on('youtube:sub-video-advanced', () => {
    const player = getYouTubePlayer();
    if (!player?.playVideo) return;

    // Force-pause the host regardless of current state. At the moment of
    // detection the player may be in BUFFERING or PLAYING; we want it
    // paused so the 1-sec countdown has a clean starting point. pauseVideo
    // on a non-playing player is a safe no-op per YT IFrame API.
    try { player.pauseVideo?.(); } catch { /* noop */ }

    // Capture the position the new sub-video has reached so guests seek
    // to the same spot instead of jumping back to 0. getCurrentTime on a
    // just-advanced sub-video is usually a very small value but not always
    // exactly 0 (YouTube may have buffered a few frames ahead).
    const currentTime = (() => {
      try { return player.getCurrentTime?.() || 0; } catch { return 0; }
    })();

    // M7: Explicitly extract the new videoId from the playlist array instead of
    // relying on player.getVideoData() inside scheduleYtAutoSync. The IFrame API
    // updates getPlaylistIndex() slightly before getVideoData(), causing the host
    // to accidentally broadcast the OLD video's ID with the NEW subIndex. Guests
    // receiving the old ID interpret it as a mismatch, explicitly load the OLD
    // video via loadVideoById(), and wait 3s at the start of the previous track.
    let nextIdx = -1;
    let nextVideoId: string | undefined;
    try {
      nextIdx = player.getPlaylistIndex?.() ?? -1;
      const pList = player.getPlaylist?.() || [];
      if (nextIdx >= 0 && nextIdx < pList.length) {
        nextVideoId = pList[nextIdx];
      }
    } catch { /* noop */ }

    // Fallback: the native IFrame API occasionally returns an empty list
    // from getPlaylist() when idle. Pull the cached IDs from our scraped map.
    if (!nextVideoId && nextIdx > 0) {
      const currentTrack = (getState('playlist.items') || [])[getState('playlist.currentTrackIndex')];
      const pid = currentTrack?.playlistId;
      if (pid) {
        const subMap = getState('youtube.subItemsMap') || {};
        nextVideoId = subMap[pid]?.ids?.[nextIdx];
        log.debug(`[YouTube] Auto-advance cache fallback for index ${nextIdx} -> ${nextVideoId}`);
      }
    }

    // Hijack native auto-advance: load the next videoId via loadVideoById
    // and broadcast sync immediately, skipping the 3s scheduleYtAutoSync
    // delay used for host-initiated transitions.
    if (nextVideoId && nextIdx > 0) {
      log.debug('[YouTube] Hijacking native auto-advance');
      setYouTubeSubIndex(nextIdx); // update highlight immediately
      player.loadVideoById?.(nextVideoId);

      // Broadcast new video + index to guests without the usual 3s delay.
      broadcastYouTubeSync(true);
      return;
    }

    setYtAutoplayIntent(true); // avoid pause-back guard firing post-sync
    // skipSeek:true — host is already at currentTime after the force-pause,
    // re-seeking would only introduce an extra BUFFERING round-trip.
    // 3s countdown for track transitions — guest needs time to load the
    // new video via loadVideoById before the synchronized play fires.
    scheduleYtAutoSync(currentTime, {
      subIndex: nextIdx !== -1 ? nextIdx : undefined,
      videoId: nextVideoId,
      skipSeek: true,
      rendezvousDelayMs: TRACK_TRANSITION_RENDEZVOUS_MS,
    });
  });

  // URL-input path: the player finished initializing — if _addYouTubeToPlaylist
  // set the pending flag, kick off the 1-sec rendezvous sync now. This replaces
  // the old autoplay=true raw-play path so guests stay aligned on first load.
  bus.on('youtube:player-ready', () => {
    if (!_pendingAutoSyncOnReady) return;
    _pendingAutoSyncOnReady = false;
    // Route through youtube:auto-play so we share the same code path as
    // the post-autoPlayTimer flow in playTrack (scheduleYtAutoSync with
    // skipSeek + autoplayIntent flip).
    bus.emit('youtube:auto-play');
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
    if (player?.pauseVideo) {
      const time = player.getCurrentTime?.() || 0;
      scheduleYtAutoSync(time, { state: 2 });
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

      const hostConn = getState('network.hostConn');
      if (!hostConn) {
        const state = player.getPlayerState?.() ?? -1;
        // See youtube:seek-to for why we need the midSync check — a pending
        // yt-auto-sync stage-2 delay (or the post-playVideo grace window)
        // keeps the player PAUSED while logically we are still in a play
        // session, so a bare seek during that window would skip re-syncing
        // and let the stale target's playVideo fire.
        const midSync = !!getManagedTimer('yt-auto-sync') || !!getManagedTimer('yt-sync-grace');
        if (state === 1 || midSync) {
          // Playing (or mid-rendezvous / grace) → (re)schedule auto-sync
          scheduleYtAutoSync(target);
        } else {
          // Actually paused by user → seek immediately, no delay
          markYtStateBroadcast();
          broadcast({
            type: MSG.YOUTUBE_STATE,
            state: 2,
            time: target,
            subIndex: getState('youtube.currentSubIndex') ?? -1,
            videoId: player.getVideoData?.()?.video_id || '',
            hostClock: getHostNow(),
          });
          player.seekTo(target, true);
          markYtStateBroadcast();
        }
      } else {
        player.seekTo(target, true);
      }
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
        const state = player.getPlayerState?.() ?? -1;
        // Mid-sync detection — two phases:
        //   - yt-auto-sync: stage-2 rendezvous delay before playVideo()
        //   - yt-sync-grace: 500ms after playVideo() while YouTube IFrame
        //     finishes its async PAUSED→PLAYING state transition
        // Both are treated as "effectively playing" so a seek landing in
        // either window (re)schedules a fresh sync instead of slipping
        // through as a bare seek+state=2 while the player's reported
        // state is still lying about being PAUSED.
        const midSync = !!getManagedTimer('yt-auto-sync') || !!getManagedTimer('yt-sync-grace');
        if (state === 1 || midSync) {
          // Playing (or mid-sync countdown / grace) → (re)schedule auto-sync.
          // scheduleYtAutoSync clears any pending yt-auto-sync up-front,
          // so the old countdown is naturally superseded.
          scheduleYtAutoSync(seconds);
        } else {
          // Actually paused by user → seek immediately, no delay
          markYtStateBroadcast();
          broadcast({
            type: MSG.YOUTUBE_STATE,
            state: 2,
            time: seconds,
            subIndex: getState('youtube.currentSubIndex') ?? -1,
            videoId: player.getVideoData?.()?.video_id || '',
            hostClock: getHostNow(),
          });
          player.seekTo(seconds, true);
          markYtStateBroadcast();
        }
      } else {
        player.seekTo(seconds, true);
      }
    } catch (e) {
      log.error('[YouTube] Seek error:', e);
    }
  });

  bus.on('youtube:try-next-internal', (callback) => {
    if (typeof callback !== 'function') return;
    navigateSubVideo(1, callback);
  });

  bus.on('youtube:try-prev-internal', (callback) => {
    if (typeof callback !== 'function') return;
    const player = getYouTubePlayer();
    if (!player) { callback(false); return; }

    // Special "restart" case: if we've played past the threshold, prev
    // restarts the current track instead of jumping to the previous sub-video.
    try {
      if (player.getCurrentTime() > PREV_TRACK_RESTART_THRESHOLD_SEC) {
        scheduleYtAutoSync(0);
        callback(true);
        return;
      }
    } catch (e) { log.debug('[YouTube] try-prev time read error:', e); }

    navigateSubVideo(-1, callback);
  });

  // Broadcast throttle: prevents spam if the event is ever emitted rapidly.
  // The heartbeat loop already self-throttles at HEARTBEAT_INTERVAL_MS (3s),
  // but this floor defends against manual/programmatic emits.
  let _lastBroadcastSyncAt = 0;
  bus.on('youtube:broadcast-sync', () => {
    const now = Date.now();
    if (now - _lastBroadcastSyncAt < BROADCAST_SYNC_MIN_INTERVAL_MS) {
      log.debug('[YouTube] broadcast-sync throttled');
      return;
    }
    _lastBroadcastSyncAt = now;
    broadcastYouTubeSync(false);
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
    
    // Safety: If this is a playlist load but we have a videoId (resolved from indexing),
    // force single-video mode to bypass the risky native playlist engine entirely.
    const finalVideoId = videoId;
    let finalPlaylistId = playlistId;
    if (finalVideoId && finalPlaylistId) {
       finalPlaylistId = null; 
       log.debug(`[YouTube Index-Add] Forcing single-video mode for playlist ${playlistId} starting with ${videoId}`);
    }

    const newTrack: PlaylistItem = {
      type: 'youtube',
      name: title,
      title: title,
      videoId: finalVideoId || null,
      playlistId: playlistId || null,
      isExpanded: !!playlistId, // Auto-expand playlist items
    };
    const updatedPlaylist = [...playlist, newTrack];
    setState('playlist.items', updatedPlaylist);
    const newIndex = updatedPlaylist.length - 1;

    // UI Triggers: Reveal the track list. 
    // Note: setYouTubeSubIndex(0) is now correctly restored inside the isIdle block
    // to avoid clobbering sub-indices of already-playing media.
    if (playlistId) {
      bus.emit('youtube:populate-sub-items', playlistId, newIndex);
    }

    if (playlistId) {
      const subMap = getState('youtube.subItemsMap') || {};
      const existingIds = subMap[playlistId]?.ids || [];
      // Only pre-populate if empty. Preserves indexed results if they already arrived.
      if (videoId && existingIds.length <= 1) {
        updateSubItemIds(playlistId, [videoId]);
      }
    }

    const currentState = getState('appState');
    const isIdle = (currentState === APP_STATE.IDLE || isYtIndexing());

    if (isIdle) {
      setState('player.isFirstTrackLoad', false);
      setState('player.currentTrackMeta', newTrack);
      setYouTubeSubIndex(0); // Moved back inside: only for new active tracks
      
      // Load YouTube with autoplay=FALSE for sync coordination.
      loadYouTubeVideo(finalVideoId, finalPlaylistId, false);
      _pendingAutoSyncOnReady = true;
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

      if (isIdle) {
        broadcast({
          type: MSG.YOUTUBE_PLAY,
          videoId,
          playlistId,
          index: newIndex,
          // autoplay=false: guest also loads without iframe auto-start and
          // waits for host's hostPlayAt broadcast from scheduleYtAutoSync.
          autoplay: false,
          subIndex: 0,
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
        if (!getState('network.hostConn')) {
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
    let playlistId = extractYouTubePlaylistId(url);

    // Filter out Mix playlists (RD...) if a video ID is present to avoid
    // unintentional addition of auto-generated lists (Single-track intent)
    if (videoId && playlistId && playlistId.startsWith('RD')) {
      playlistId = null;
    }

    if (!videoId && !playlistId) {
      showToast(t('youtube.invalid_link'));
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

    // Index-before-Add flow for new playlists
    const subMap = getState('youtube.subItemsMap') || {};
    if (playlistId && !subMap[playlistId]?.ids?.length) {
       log.info(`[YouTube Index] New playlist detected: ${playlistId}. Starting sequential indexing...`);
       showLoader(true, t('youtube.indexing_playlist'));
       
       setYtIndexing(true);
       setYtIndexingCallback((ids) => {
          showLoader(false);
          if (!ids || ids.length === 0) {
             showToast(t('youtube.fetch_failed'));
             return;
          }
          log.info(`[YouTube Index] Indexing complete! Captured ${ids.length} items. Adding to queue.`);
          updateSubItemIds(playlistId!, ids);
          
          _addYouTubeToPlaylist(ids[0], playlistId, titleText, url);
          
          // Force highlight and expansion of the first track with a small delay
          // to ensure the UI has finished adding the item to the DOM.
          setManagedTimer('yt-playlist-indexed-highlight', () => {
            const currentPlaylist = getState('playlist.items');
            const actualIdx = currentPlaylist.findIndex(t => t.playlistId === playlistId);
            if (actualIdx !== -1) {
              const updated = [...currentPlaylist];
              updated[actualIdx] = { ...updated[actualIdx], isExpanded: true };
              setState('playlist.items', updated);
              setYouTubeSubIndex(0);
              bus.emit('youtube:populate-sub-items', playlistId!, actualIdx);
            }
          }, 250);
       });
       
       // Trigger the player to index (via cuePlaylist in iframe.ts)
       loadYouTubeVideo(videoId, playlistId, false);
    } else {
       _addYouTubeToPlaylist(videoId, playlistId, titleText, url);
    }
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
    if (!player?.loadVideoById) return;

    if (isCurrent) {
      // Same playlist — single-video mode: resolve the videoId from our
      // host-snapshotted subItemsMap and loadVideoById directly. We don't
      // call playVideoAt because that uses the iframe's playlist engine,
      // which is exactly what we want to stop using on large playlists.
      const currentTrack = (getState('playlist.items') || [])[getState('playlist.currentTrackIndex')];
      const subMap = getState('youtube.subItemsMap') || {};
      const ids = subMap[currentTrack?.playlistId as string]?.ids || [];
      const targetVideoId = ids[subIdx];
      if (!targetVideoId) {
        log.warn(`[YouTube] sub-seek: no videoId at subIdx=${subIdx} in subItemsMap`);
        return;
      }
      player.loadVideoById(targetVideoId);
      setYouTubeSubIndex(subIdx);

      // Pre-emptive title update for instant UI feedback
      const cachedTitle = subMap[currentTrack.playlistId as string]?.titles?.[subIdx];
      if (cachedTitle) {
        const meta = getState('player.currentTrackMeta');
        if (meta) setState('player.currentTrackMeta', { ...meta, title: cachedTitle });
      }

      // Prioritize fetching title for the newly selected index (if missing)
      if (currentTrack.playlistId && ids.length > 0) {
        fetchPlaylistSubTitles(currentTrack.playlistId as string, ids);
      }
      scheduleYtAutoSync(0, {
        subIndex: subIdx,
        videoId: targetVideoId,
        skipSeek: true,
        rendezvousDelayMs: TRACK_TRANSITION_RENDEZVOUS_MS,
      });
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
        const rawIds = player.getPlaylist() || [];
        if (rawIds.length > PLAYLIST_MAX_ITEMS) {
          showToast(t('youtube.playlist_truncated'));
        }
        ids = rawIds.slice(0, PLAYLIST_MAX_ITEMS);
      } catch (e) { log.debug('[YouTube] getPlaylist() not ready:', e); }
    }

    // 2. Initial map setup
    if (ids.length > 0) {
      const subMap = getState('youtube.subItemsMap') || {};
      if (!subMap[playlistId]?.ids?.length) {
        updateSubItemIds(playlistId, ids);
      }
    }

    // 3. Trigger background title fetcher (All roles)
    // Full fetch when user explicitly expands the sub-playlist UI
    const currentSubMap = getState('youtube.subItemsMap') || {};
    if (currentSubMap[playlistId]?.ids?.length > 0) {
      fetchPlaylistSubTitles(playlistId, currentSubMap[playlistId].ids, { fullFetch: true });
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
    let playlistId = extractYouTubePlaylistId(url);

    // Filter out Mix playlists (RD...) if a video ID is present
    if (videoId && playlistId && playlistId.startsWith('RD')) {
      playlistId = null;
    }

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
      } catch (e) { log.debug('[YouTube] late-join state read:', e); }

      const autoplay = (ytState === 1);
      const currentSubIndex = getState('youtube.currentSubIndex') ?? -1;
      const subIdx = (currentSubIndex >= 0) ? currentSubIndex : 0;

      // Single-video bootstrap: resolve the videoId the host is currently
      // playing and send THAT as the videoId. Never send the full ID array
      // as playlistId (guest's iframe would build a 200+ item playlist
      // engine and OOM). The original playlistId (string) is still sent
      // for UI context (so the guest knows this video belongs to a
      // playlist), and the host follows up with YOUTUBE_PLAYLIST_INFO to
      // populate the guest's subItemsMap for navigation.
      const subMap = getState('youtube.subItemsMap') || {};
      const hostIds = subMap[item.playlistId as string]?.ids;
      const resolvedVideoId =
        (hostIds && hostIds[subIdx]) ||
        player?.getVideoData?.()?.video_id ||
        item.videoId ||
        null;
      const currentVideoId = resolvedVideoId || '';

      safeSend(conn, {
        type: MSG.YOUTUBE_PLAY,
        videoId: resolvedVideoId,
        // Pass the playlistId string (PL/RD) for UI context only — the guest
        // does NOT load by it. handleYouTubePlay treats videoId as primary
        // when both are present (single-video mode).
        playlistId: item.playlistId || null,
        name: item.name || item.title,
        index: currentTrackIndex,
        autoplay,
        subIndex: subIdx,
      });

      // Also send YOUTUBE_PLAYLIST_INFO so the guest has the sub-items map
      // for navigation (next/prev/sub-seek) and title display.
      if (hostIds && hostIds.length > 0) {
        const titles = subMap[item.playlistId as string]?.titles || [];
        safeSend(conn, {
          type: MSG.YOUTUBE_PLAYLIST_INFO,
          playlistId: item.playlistId as string,
          ids: hostIds,
          titles,
        });
      }

      // Send sync frame immediately. Single-video mode means the guest does
      // a quick loadVideoById (no async playlist engine load), so there's no
      // need to delay. Use YOUTUBE_STATE (with hostPlayAt) whenever host is
      // playing — even at ytTime === 0 — so the guest's auto-sync path
      // handles pause → seek → timed play correctly for a rendezvous-aligned
      // start. YOUTUBE_SYNC suffices only when host is paused.
      // NOTE: only the late-joining conn receives this — existing guests are
      // NOT disturbed (no broadcast, no host pause).
      if (autoplay) {
        safeSend(conn, {
          type: MSG.YOUTUBE_STATE,
          state: 1,
          time: ytTime,
          subIndex: subIdx,
          videoId: currentVideoId,
          hostPlayAt: getHostNow() + YT_AUTO_SYNC_MS,
          hostClock: getHostNow(),
        });
      } else {
        // Host paused — simple sync frame is fine
        safeSend(conn, {
          type: MSG.YOUTUBE_SYNC,
          time: ytTime,
          state: ytState,
          subIndex: subIdx,
          videoId: currentVideoId,
          hostClock: getHostNow(),
        });
      }

      log.debug('[YouTube] Bootstrap: sent YouTube state to new peer');
    } catch (e) {
      log.warn('[YouTube] Bootstrap send failed:', e);
    }
  });

  log.info('[YouTube] Player initialized');
}
