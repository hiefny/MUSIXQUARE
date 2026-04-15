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
import { clearManagedTimer, setManagedTimer, getManagedTimer } from '../core/timers.ts';
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
  isYtIndexing, setYtIndexing,
  getYtIndexingCallback, setYtIndexingCallback,
  getYtAutoplayIntent, setYtAutoplayIntent,
  getCachedYtDuration, setCachedYtDuration,
  getCachedYtPlaylistIdx, setCachedYtPlaylistIdx,
  setYouTubeSubIndex,
  updateSubItemIds,
  setSubItemsData,
} from './_state.ts';
import { showToast, showLoader } from '../ui/toast.ts';
import { fetchPlaylistSubTitles } from './search.ts';
import { resetYouTubeSyncState, suppressDriftUntil, guestRendezvousSync } from './sync.ts';
import { getPendingAutoSyncOnReady, setPendingAutoSyncOnReady } from './player.ts';
import { getHostNow } from '../network/shared-clock.ts';
import {
  UI_LOOP_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  STATE_BROADCAST_DEDUP_MS,
  LOAD_DRIFT_SUPPRESS_MS,
  IOS_WATCHDOG_MS,
  CRASH_FAIL_THRESHOLD,
  SCRIPT_LOAD_TIMEOUT_MS,
  REFRESH_DISPLAY_DELAY_MS,
  GUEST_ENDED_FALLBACK_MS,
  PLAYLIST_MAX_ITEMS,
  PLAYLIST_SNAPSHOT_DELAY_MS,
  FIRST_TRACK_FISHER_INTERVAL_MS,
  FIRST_TRACK_FISHER_MAX_POLLS,
  VIDEO_DATA_POLL_EVERY_NTH_TICK,
  DURATION_CACHE_EPSILON,
} from './constants.ts';

import type { YTNamespace } from './_state.ts';
declare const YT: YTNamespace;

// ─── Iframe Runtime State ─────────────────────────────────────────
// All mutable iframe-layer module state in one place. Previously scattered
// as individual `let` bindings; grouping them exposes the full set of
// stateful fields the UI loop and onStateChange handlers touch.

interface IframeRuntime {
  /** Tracks the last known YouTube video title to detect changes. */
  lastVideoTitle: string;
  /**
   * The videoId the duration cache is currently valid for. Needed because
   * player.getDuration() can return the OLD video's duration briefly after
   * loadVideoById — the "lock on first valid read" pattern would otherwise
   * cache the stale value and never update for subsequent videos. Cleared
   * on loadYouTubeVideo / stopYouTubeMode so the next poll refreshes.
   */
  lastDurationVideoId: string;
  /** Rolling counter 0..VIDEO_DATA_POLL_EVERY_NTH_TICK-1; getVideoData()
   *  only fires when this wraps to 0. */
  videoDataPollCount: number;
  /** Cooldown timestamp: prevents duplicate broadcasts from UI + onStateChange. */
  lastStateBroadcast: number;
  /** Last broadcast player state (for state-aware dedup). */
  lastBroadcastState: number;
  /** Consecutive getCurrentTime() failures — trips the crash-recovery rebuild. */
  crashFailCount: number;
  /** Last playlist index that was preempted for auto-advance. Prevents infinite looping within 0.8s */
  lastPreemptIdx: number;
  /** True if we are intercepting a native playlist load via cuePlaylist purely to scrape IDs. */
  isScrapingPlaylist: boolean;
  /** The playlistId currently being indexed/scraped. */
  indexingPlaylistId: string | null;
}

const _ifr: IframeRuntime = {
  lastVideoTitle: '',
  lastDurationVideoId: '',
  videoDataPollCount: 0,
  lastStateBroadcast: 0,
  lastBroadcastState: -1,
  crashFailCount: 0,
  lastPreemptIdx: -1,
  isScrapingPlaylist: false,
  indexingPlaylistId: null,
};

export function markYtStateBroadcast(): void { _ifr.lastStateBroadcast = Date.now(); }

// ─── Load YouTube Video ────────────────────────────────────────────

export function loadYouTubeVideo(
  videoId: string | null,
  playlistId: string | null = null,
  autoplay = true,
  subIndex = 0,
): void {
  const indexing = isYtIndexing();
  if (indexing) _ifr.indexingPlaylistId = playlistId;
  else _ifr.indexingPlaylistId = null;

  // Reset pre-empt guard on every new load. The guard compares against
  // the iframe's current playlistIdx; if the value is stale from a prior
  // playlist (e.g. lastPreemptIdx=9 then switching to a new playlist
  // that happens to land on index 9), pre-empt would incorrectly block.
  _ifr.lastPreemptIdx = -1;

  const player = getYouTubePlayer();

  // YouTube-to-YouTube transition: reuse the existing player instance
  // instead of destroying and recreating the iframe. On iOS, recreating
  // the iframe resets the user gesture — requiring a tap to play again.
  // loadVideoById/loadPlaylist on the same player preserves the gesture.
  const isYouTubeToYouTube = player?.loadVideoById && getState('appState') === APP_STATE.PLAYING_YOUTUBE;

  if (isYouTubeToYouTube) {
    log.debug('[YouTube] YouTube-to-YouTube transition — reusing player, skipping stop-all-media');
    try { player!.stopVideo?.(); } catch { /* noop */ }
    // Light cleanup: reset sync state without destroying the player
    clearManagedTimer('yt-clock-action');
    clearManagedTimer('yt-auto-sync');
    clearManagedTimer('yt-sync-grace');
    resetYouTubeSyncState();

    // Restart UI loop if it was cleared by the ENDED handler.
    // The ENDED→playTrack→loadYouTubeVideo path clears youtubeUILoop
    // in onStateChange(ENDED), but the YT-to-YT reuse path skips
    // onYouTubePlayerReady (which normally starts the loop).
    if (!getManagedTimer('youtubeUILoop')) {
      setManagedTimer('youtubeUILoop', updateYouTubeUI, UI_LOOP_INTERVAL_MS, { interval: true });
    }
    // Same for host sync loop
    const hostConn = getState('network.hostConn');
    if (!hostConn && !getManagedTimer('youtubeSyncLoop')) {
      setManagedTimer('youtubeSyncLoop', () => {
        bus.emit('youtube:broadcast-sync');
      }, HEARTBEAT_INTERVAL_MS, { interval: true });
    }
  } else {
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
  }
  setEngineMode('youtube');

  setCachedYtDuration(0); // Reset duration cache for new video
  _ifr.lastDurationVideoId = ''; // Force duration re-read on next updateYouTubeUI tick
  _ifr.lastStateBroadcast = 0; // Allow immediate first broadcast for new session
  _ifr.lastBroadcastState = -1; // Reset so first state is never treated as duplicate
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
      createYouTubePlayer(videoId, playlistId, autoplay, subIndex);
    };
  } else {
    createYouTubePlayer(videoId, playlistId, autoplay, subIndex);
  }

  // Safety timeout
  setManagedTimer('yt-load-timeout', () => {
    if (getCurrentSessionId() === sessionId && !scope.aborted && !getYouTubePlayer()) {
      log.warn('[YouTube] Load timeout triggered.');
      setYtLoadInProgress(false);
      showLoader(false);
      showToast(t('youtube.load_timeout'));
    }
  }, SCRIPT_LOAD_TIMEOUT_MS);

  bus.emit('ui:play-btn-state', true);

  // Keep fullscreen button visible in YouTube mode — the button targets
  // .video-wrapper which contains the YouTube iframe container, so
  // Fullscreen API works correctly for both local video and YouTube.

  setManagedTimer('yt-refresh-display', () => refreshYouTubeDisplay(), REFRESH_DISPLAY_DELAY_MS);
  log.debug('[YouTube] Loaded:', videoId || playlistId, 'autoplay:', autoplay);
}

// ─── Create YouTube Player (IFrame) ────────────────────────────────

function createYouTubePlayer(
  videoId: string | null,
  playlistId: string | null = null,
  autoplay = true,
  subIndex = 0,
): void {
  const indexing = isYtIndexing();
  const currentState = getState('appState');
  if (currentState !== APP_STATE.PLAYING_YOUTUBE && !indexing) {
    log.warn('[YouTube] createYouTubePlayer aborted - not in PLAYING_YOUTUBE state');
    setYtLoadInProgress(false);
    // Clear any stale indexing intent from an aborted new-playlist flow.
    // Without this, _isYtIndexing stays pinned true and the next Add-playlist
    // attempt short-circuits (the pending callback would also fire with the
    // wrong playlist's IDs).
    if (indexing) {
      setYtIndexing(false);
      setYtIndexingCallback(null);
      showLoader(false);
    }
    return;
  }

  // Set autoplay intent BEFORE any player API call — onStateChange
  // checks this flag to pause-back if autoplay was not requested.
  // Fixes: loadPlaylist() is async, so pauseVideo() on UNSTARTED is a no-op.
  setYtAutoplayIntent(autoplay);

  // Reset sub-index cache so the sub-video auto-advance detector (in
  // updateYouTubeUI) doesn't mistake the initial index of a freshly loaded
  // track for a mid-playlist transition. The cache is populated on the
  // first updateYouTubeUI tick after the player becomes ready.
  setCachedYtPlaylistIdx(-1);
  _ifr.lastPreemptIdx = -1;

  const hostConn = getState('network.hostConn');
  const needsScrape = (!hostConn && playlistId !== null);

  if (needsScrape) {
    _ifr.isScrapingPlaylist = true;
    setYtLoadInProgress(true);
    showToast(t('youtube.loading_large_playlist'));
  } else {
    _ifr.isScrapingPlaylist = false;
  }

  const existingPlayer = getYouTubePlayer();
  if (existingPlayer?.loadVideoById) {
    log.debug('[YouTube] Re-using existing player instance');
    try {
      if ((needsScrape || indexing) && playlistId) {
        existingPlayer.cuePlaylist({ list: playlistId, listType: 'playlist', index: subIndex, startSeconds: 0 });
      } else if (playlistId) {
        existingPlayer.loadPlaylist({ list: playlistId, listType: 'playlist', index: subIndex, startSeconds: 0 });
      } else if (videoId) {
        existingPlayer.loadVideoById(videoId);
      }
      // Note: pauseVideo() removed — handled by onStateChange via _ytAutoplayIntent flag.
      // loadPlaylist() is async; pauseVideo() on UNSTARTED player is a no-op.
      if (!needsScrape) {
        setYouTubeSubIndex(subIndex);
        setYtLoadInProgress(false);
      }

      // Suppress heartbeat state-sync for 5s after loading a new video.
      // Without this, the host's heartbeat (state:1 from the PREVIOUS video)
      // arrives before YOUTUBE_STATE and wakes the guest via state-sync
      // (hostState=1, ytState≠1 → playVideo), causing the guest to play
      // from position 0 while the host is still loading.
      if (!autoplay) {
        suppressDriftUntil(LOAD_DRIFT_SUPPRESS_MS);
      }
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
    playerVars.listType = 'playlist';
    playerVars.list = playlistId;
    playerVars.index = subIndex;
    if (needsScrape || indexing) playerVars.autoplay = 0;
  }

  const playerOptions: Record<string, any> = {
    width: '100%',
    height: '100%',
    playerVars,
    events: {
      onReady: onYouTubePlayerReady,
      onStateChange: onYouTubePlayerStateChange,
      onError: onYouTubePlayerError,
    },
  };

  if (videoId) playerOptions.videoId = videoId;

  setYouTubePlayer(new YT.Player('youtube-player', playerOptions));
  setYouTubeSubIndex(subIndex);

  // A11y: add title to iframe once YouTube API creates it
  requestAnimationFrame(() => {
    const iframe = document.querySelector('#youtube-player-container iframe') as HTMLIFrameElement | null;
    if (iframe) iframe.title = 'YouTube video player';
  });
}

// ─── Player Events ─────────────────────────────────────────────────

function onYouTubePlayerReady(): void {
  setYtLoadInProgress(false);
  log.debug('[YouTube] Player ready');

  const currentState = getState('appState');
  const indexing = isYtIndexing();
  if (currentState !== APP_STATE.PLAYING_YOUTUBE && !indexing) {
    log.debug('[YouTube] onPlayerReady skipped - mode changed');
    return;
  }

  const player = getYouTubePlayer();
  const indexingPid = _ifr.indexingPlaylistId;
  if (indexing && indexingPid && player?.cuePlaylist) {
    const subIndex = getState('youtube.currentSubIndex') ?? 0;
    player.cuePlaylist({ list: indexingPid, listType: 'playlist', index: subIndex, startSeconds: 0 });
    // Don't start loops or sync yet
    return;
  }

  const currentTrack = getState('player.currentTrackMeta');
  const pid = currentTrack?.playlistId as string;

  // ── Playlist Snapshot & Sync (Host Only) ──
  const hostConn = getState('network.hostConn');
  if (!hostConn && pid) {
    if (_ifr.isScrapingPlaylist && player?.cuePlaylist) {
      log.debug('[YouTube] Cueing playlist for backend scrape...', pid);
      const subIndex = getState('youtube.currentSubIndex') ?? 0;
      player.cuePlaylist({ list: pid, listType: 'playlist', index: subIndex, startSeconds: 0 });
    }

    if (player?.getPlaylist) {
      log.debug('[YouTube] Scheduling host-side playlist snapshot:', pid);
      setManagedTimer('yt-playlist-snapshot', () => _triggerPlaylistSnapshot(pid), PLAYLIST_SNAPSHOT_DELAY_MS);

      // Aggressive First-Track Fisher: Poll fast to catch the first video ID.
      // Makes the 1st track highlight appear almost instantly even without a v= parameter.
      let fisherCount = 0;
      setManagedTimer('yt-first-track-fisher', () => {
        try {
          const p = getYouTubePlayer();
          const vid = p?.getVideoData?.()?.video_id;
          if (vid) {
            const subMap = getState('youtube.subItemsMap') || {};
            const existing = subMap[pid]?.ids || [];
            // Only update if we don't have IDs yet, or if it's currently a single-track list
            if (existing.length <= 1) {
              updateSubItemIds(pid, [vid]);
            }
            clearManagedTimer('yt-first-track-fisher');
          }
        } catch { /* ignore */ }
        if (++fisherCount > FIRST_TRACK_FISHER_MAX_POLLS) clearManagedTimer('yt-first-track-fisher');
      }, FIRST_TRACK_FISHER_INTERVAL_MS, { interval: true });
    }
  }

  // Start UI update loop
  clearManagedTimer('youtubeUILoop');
  setManagedTimer('youtubeUILoop', updateYouTubeUI, UI_LOOP_INTERVAL_MS, { interval: true });

  // Only Host runs sync loop
  clearManagedTimer('youtubeSyncLoop');
  if (!hostConn) {
    setManagedTimer('youtubeSyncLoop', () => {
      bus.emit('youtube:broadcast-sync');
    }, HEARTBEAT_INTERVAL_MS, { interval: true });
  }

  // Apply volume
  bus.emit('audio:apply-youtube-volume');

  // Notify anyone waiting for the player to become usable (e.g. the URL
  // input path in player.ts that wants to trigger a 1-sec rendezvous sync
  // as soon as the freshly created player instance is ready).
  bus.emit('youtube:player-ready');
}

/**
 * Poll player.getPlaylist() until the returned ID count stabilizes, then
 * fire the indexing callback with the final list. Used instead of reading
 * getPlaylist() exactly once at CUED, because YouTube populates the list
 * lazily on large playlists.
 */
const INDEXING_POLL_INTERVAL_MS = 300;
const INDEXING_POLL_MAX_ATTEMPTS = 15; // ~4.5s ceiling

function _pollIndexingPlaylist(prevCount: number, attempts: number): void {
  const player = getYouTubePlayer();
  if (!player?.getPlaylist) {
    // Player gone — abandon indexing without invoking the callback
    setYtIndexing(false);
    setYtIndexingCallback(null);
    return;
  }
  const ids = player.getPlaylist() || [];
  const stabilized = ids.length > 0 && ids.length === prevCount;
  const giveUp = attempts >= INDEXING_POLL_MAX_ATTEMPTS;
  if (stabilized || giveUp) {
    log.debug(`[YouTube] Indexing settled at ${ids.length} items after ${attempts} polls`);
    const cb = getYtIndexingCallback();
    // Do NOT clear indexing state before the callback runs. The callback
    // triggers loadYouTubeVideo -> stopYouTubeMode, which relies on
    // isYtIndexing() to avoid clobbering the sub-index.
    if (cb) cb(ids);
    setYtIndexing(false);
    setYtIndexingCallback(null);
    return;
  }
  setManagedTimer(
    'yt-indexing-poll',
    () => _pollIndexingPlaylist(ids.length, attempts + 1),
    INDEXING_POLL_INTERVAL_MS,
  );
}

function onYouTubePlayerError(event: { data: number }): void {
  log.error('[YouTube] Player error:', event.data);
  setYtLoadInProgress(false);
  showLoader(false);
  showToast(t('youtube.load_fail'));

  // Indexing in progress when the player errors out (e.g. invalid playlistId,
  // error 150): drop the callback and clear the flag so a subsequent
  // Add-playlist attempt for a different ID doesn't fire the stale callback
  // and corrupt the cached sub-items.
  if (isYtIndexing()) {
    setYtIndexing(false);
    setYtIndexingCallback(null);
  }
}

function onYouTubePlayerStateChange(event: { data: number }): void {
  const currentState = getState('appState');
  const indexing = isYtIndexing();
  if (currentState !== APP_STATE.PLAYING_YOUTUBE && !indexing) return;

  const player = getYouTubePlayer();
  if (!player) return; // Player destroyed during async state transition
  const state = event.data;

  if (state === YT.PlayerState.PLAYING) {
    // Host: If playlist sub-item data is still missing, attempt immediate snapshot.
    // This allows immediate Next/Prev navigation and highlights as soon as playback starts.
    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      const currentTrack = (getState('playlist.items') || [])[getState('playlist.currentTrackIndex')];
      const pid = currentTrack?.playlistId;
      const subMap = getState('youtube.subItemsMap') || {};
      if (pid && (!subMap[pid] || !subMap[pid].ids.length)) {
        log.debug('[YouTube] Playback started — triggering immediate playlist snapshot');
        _triggerPlaylistSnapshot(pid);
      }
    }

    // Pause-back if autoplay was not intended (e.g. loadPlaylist async path).
    if (!getYtAutoplayIntent()) {
      player?.pauseVideo?.();
      showLoader(false);
      // Existing-player async load completed — if a caller (URL-input or
      // playTrack) armed the rendezvous flag, consume it now so autoplay
      // kicks in without waiting for another 'youtube:player-ready' (which
      // only fires on brand-new player instances).
      if (getPendingAutoSyncOnReady()) {
        setPendingAutoSyncOnReady(false);
        bus.emit('youtube:auto-play');
      }
      return; // Don't broadcast or update UI yet
    }
    showYouTubeSyncOverlay(false);
    showLoader(false);
    bus.emit('ui:update-play-state', true);
  } else if (state === YT.PlayerState.PAUSED) {
    showLoader(false);
    bus.emit('ui:update-play-state', false);
  } else if (state === YT.PlayerState.CUED) {
    if (indexing) {
      log.debug('[YouTube] CUED during indexing — polling for full list');
      // YouTube populates getPlaylist() lazily for large playlists — a
      // 100-track list commonly returns ~10 items on the first read after
      // CUED. Firing the callback immediately would cache a truncated list
      // and the playlist would "end" at sub-video 10. Poll until the count
      // stabilizes (same count twice in a row) or a safety ceiling.
      _pollIndexingPlaylist(-1, 0);
      return;
    }

    const hostConn = getState('network.hostConn');
    if (!hostConn && _ifr.isScrapingPlaylist) {
      log.debug('[YouTube] CUED during scrape — extracting IDs without playing');
      _ifr.isScrapingPlaylist = false;

      const ids = player.getPlaylist() || [];
      if (ids.length > 0) {
        const currentTrack = (getState('playlist.items') || [])[getState('playlist.currentTrackIndex')];
        const pid = currentTrack?.playlistId;
        const subIdx = getState('youtube.currentSubIndex') ?? 0;

        if (pid) updateSubItemIds(pid, ids);
        log.debug('[YouTube] Scrape captured IDs — switching to single-video mode');

        setYouTubeSubIndex(subIdx);
        player.loadVideoById(ids[subIdx] || ids[0], 0);

        if (getYtAutoplayIntent()) player.playVideo();
      } else {
        log.warn('[YouTube] Scrape returned empty list — falling back to native playback');
        if (getYtAutoplayIntent()) player.playVideo();
      }
    }
    return;
  } else if (state === YT.PlayerState.ENDED) {
    // Host: clear ALL loops and advance
    // Guest: keep youtubeUILoop alive — the iframe may auto-advance to the
    // next sub-video in a playlist, and updateYouTubeUI's guest auto-advance
    // suppression (pause + wait for host) needs the loop running to detect
    // the sub-index change. Only clear the sync broadcast loop (host-only).
    clearManagedTimer('youtubeSyncLoop');

    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      // Host: skip IDLE state transition to prevent UI flash — next-track
      // will call stopAllMedia({ silent: true }) which handles state internally.
      //
      // Single-video mode: try to advance to the next sub-video within the
      // current YouTube playlist first (via loadVideoById, using snapshotted
      // subItemsMap). Only fall back to the MUSIXQUARE queue's next track
      // when we've reached the end of the sub-items list.
      let advanced = false;
      bus.emit('youtube:try-next-internal', (ok: boolean) => { advanced = ok; });
      if (advanced) {
        log.debug('[YouTube] Ended, advancing to next sub-video...');
        // Keep youtubeUILoop alive — loadVideoById fired by try-next keeps the
        // player alive and the UI loop needs to keep tracking the new video.
        return;
      }
      clearManagedTimer('youtubeUILoop');
      log.debug('[YouTube] Ended, playing next track...');
      bus.emit('playlist:next-track');
    } else {
      // Guest: DON'T go IDLE immediately — host is about to send YOUTUBE_STATE
      // with the next video. If we set IDLE now, handleYouTubeState() would
      // drop the message (appState !== PLAYING_YOUTUBE guard). Wait up to 5s
      // for the host's next-track command; fall back to IDLE if nothing arrives.
      log.debug('[YouTube] Guest: video ended — waiting for host next-track');
      setManagedTimer('yt-guest-ended-fallback', () => {
        // Host never sent next track (e.g. playlist truly ended) — clean up
        clearManagedTimer('youtubeUILoop');
        if (getState('appState') === APP_STATE.PLAYING_YOUTUBE) {
          log.debug('[YouTube] Guest: no next-track from host — going IDLE');
          setAppState(APP_STATE.IDLE);
          bus.emit('youtube:stop-mode');
        }
      }, GUEST_ENDED_FALLBACK_MS);
    }
    return; // Don't broadcast ENDED — guest handles locally, prevents race with next-track
  }

  // Host broadcasts state to guests (skip if UI already broadcast within 300ms)
  const hostConn = getState('network.hostConn');
  const now = Date.now();
  // CRITICAL: also skip while a scheduled sync countdown (yt-auto-sync) or
  // its post-playVideo grace window (yt-sync-grace) is active. During that
  // window the player transitions PAUSED → BUFFERING → PLAYING (pause,
  // seek, wait, play) and onStateChange fires for each transition. If the
  // 300ms UI-dedupe cooldown elapses during this ~1s+ window, onStateChange
  // will broadcast an auxiliary YOUTUBE_STATE{state:2, no hostPlayAt} for
  // the transient PAUSED state — which the guest interprets as "host paused"
  // and cancels its pending yt-clock-action, leaving guest paused while
  // host resumes at the end of the countdown. scheduleYtAutoSync already
  // broadcasts the authoritative state+hostPlayAt at the start of its
  // sequence, so suppressing these in-flight auxiliary broadcasts is safe.
  const syncInFlight = !!getManagedTimer('yt-auto-sync') || !!getManagedTimer('yt-sync-grace');
  // State-aware cooldown: only suppress if same state was broadcast within 300ms.
  // The old time-only cooldown swallowed legitimate state changes (e.g., rapid
  // pause→play within 300ms), leaving guests stuck in the old state for 3s
  // until the next heartbeat corrected it.
  const isDuplicateState = (state === _ifr.lastBroadcastState) && (now - _ifr.lastStateBroadcast < STATE_BROADCAST_DEDUP_MS);
  if (!hostConn && player?.getCurrentTime && !syncInFlight && !isDuplicateState) {
    _ifr.lastStateBroadcast = now;
    _ifr.lastBroadcastState = state;
    broadcast({
      type: MSG.YOUTUBE_STATE,
      state,
      time: player.getCurrentTime(),
      subIndex: getState('youtube.currentSubIndex') ?? -1,
      videoId: player.getVideoData?.()?.video_id || '',
      title: player.getVideoData?.()?.title || '',
      hostClock: getHostNow(),
    });
  }
}

// ─── YouTube UI Update Loop ────────────────────────────────────────

function updateYouTubeUI(): void {
  const player = getYouTubePlayer();
  const currentState = getState('appState');
  if (!player || currentState !== APP_STATE.PLAYING_YOUTUBE || !player.getCurrentTime) return;

  // Crash detection: if getCurrentTime() throws repeatedly, the iframe
  // process has died (sad face icon). YouTube API events stop firing
  // entirely, so onError never triggers. Detect via polling and recover.
  let currentTime: number;
  try {
    currentTime = player.getCurrentTime();
    _ifr.crashFailCount = 0; // Reset on success
  } catch {
    _ifr.crashFailCount++;
    if (_ifr.crashFailCount >= CRASH_FAIL_THRESHOLD) {
      log.error(`[YouTube] iframe unresponsive (${_ifr.crashFailCount} failures) — rebuilding player`);
      _ifr.crashFailCount = 0;

      // Reset guestPlayLatency — the last calibration before the crash may
      // have been measured against a dying iframe (stale getCurrentTime),
      // producing a corrupted EMA value that persists across reloads and
      // permanently biases all future rendezvous sync.
      setState('youtube.guestPlayLatency', 0);
      try { localStorage.removeItem('musixquare-yt-play-latency'); } catch { /* noop */ }

      // Capture current state for recovery
      const videoId = getState('player.currentTrackMeta')?.videoId as string || '';
      const playlistId = getState('player.currentTrackMeta')?.playlistId as string || '';
      const subIndex = getState('youtube.currentSubIndex') ?? 0;
      // Destroy dead player and rebuild
      try { player.destroy?.(); } catch { /* already dead */ }
      setYouTubePlayer(null);
      const container = document.getElementById('youtube-player-container');
      if (container) container.innerHTML = '<div id="youtube-player"></div>';
      showToast(t('youtube.load_fail'));
      // Reload the same video
      if (videoId || playlistId) {
        loadYouTubeVideo(videoId || null, playlistId || null, true, subIndex);
      }
    }
    return;
  }

  try {
    const rawDuration = player.getDuration?.() || 0;
    const playlistIdx = player.getPlaylistIndex?.() ?? -1;
    const state = player.getPlayerState?.() ?? -1;

    // iOS watchdog: only trigger on UNSTARTED (-1), not CUED (5)
    // state=5 (CUED) is a normal pre-play state, not a playback failure
    if (IS_IOS && state === -1) {
      if (!getYtIOSWatchdog()) setYtIOSWatchdog(Date.now());
      if (Date.now() - getYtIOSWatchdog()! > IOS_WATCHDOG_MS) {
        showYouTubeSyncOverlay(true);
      }
    } else if (state === 1 || state === 2) {
      // Only clear watchdog on definitively successful states (PLAYING/PAUSED).
      // Clearing on BUFFERING(3) would reset the timer if a stuck player
      // briefly flickers through BUFFERING during initialization.
      setYtIOSWatchdog(null);
    }

    // Pre-empt slow native auto-advance. When the iframe's native playlist
    // engine is active (playlistIdx !== -1), its automatic transition to
    // the next video can stall for several seconds on large playlists.
    // Intercepting 0.5~0.8s before the track ends lets us swap to
    // single-video mode ourselves and keep guests in sync.
    const hostConn = getState('network.hostConn');
    if (!hostConn && playlistIdx !== -1 && state === 1 && _ifr.lastPreemptIdx !== playlistIdx) {
      const timeRemaining = rawDuration - currentTime;
      if (rawDuration > 0 && timeRemaining <= 0.8 && timeRemaining > 0) {
        log.debug(`[YouTube] Pre-empting native auto-advance (remaining: ${timeRemaining.toFixed(2)}s)`);
        _ifr.lastPreemptIdx = playlistIdx;
        bus.emit('youtube:try-next-internal', () => { });
        return;
      }
    }

    // Reset cache when playlist sub-index changes (= different video)
    let subIndexJustChanged = false;
    if (playlistIdx !== getCachedYtPlaylistIdx()) {
      subIndexJustChanged = true;
      const prevIdx = getCachedYtPlaylistIdx();
      setCachedYtPlaylistIdx(playlistIdx);
      setCachedYtDuration(0);
      _ifr.lastVideoTitle = '';
      _ifr.lastDurationVideoId = ''; // Force videoId re-read on next getVideoData poll

      // Arm the counter so (N+1) % N === 0 on the NEXT tick → getVideoData
      // fires immediately after a sub-index change instead of waiting for
      // the usual ~5s cadence. `- 1` keeps this correct if N ever changes.
      _ifr.videoDataPollCount = VIDEO_DATA_POLL_EVERY_NTH_TICK - 1;

      const hostConn = getState('network.hostConn');

      // ── Guest-side: suppress independent auto-advance ──────────────
      // YouTube iframe auto-advances to the next video in a playlist
      // independently on each device. In a Mix (RD...) playlist, the order
      // is personalized per device, so the guest's "next" video is likely
      // DIFFERENT from the host's. If we let the guest play freely,
      // videoId mismatch detection (handleYouTubeSync, 3s heartbeat)
      // eventually corrects it via loadVideoById, but this causes 3-6s
      // of the guest playing the wrong video from position 0.
      //
      // Fix: immediately pause the guest and let the host's YOUTUBE_STATE
      // (which arrives with the correct videoId and hostPlayAt within ~1s)
      // drive the transition. This eliminates the wrong-video window.
      if (hostConn && prevIdx !== -1 && playlistIdx >= 0) {
        log.info(`[YouTube] Guest: suppressing auto-advance ${prevIdx} → ${playlistIdx} — pausing, waiting for host command`);
        try { player.pauseVideo?.(); } catch { /* noop */ }
        // Do NOT return here — fall through so title, duration, and seekbar
        // UI updates still run. The pause is enough to suppress playback;
        // returning early would freeze the UI on the previous track's metadata.
      }

      // ── Host-side: sub-video auto-advance detection ────────────────
      // YouTube IFrame auto-advances between sub-videos in a playlist
      // WITHOUT firing an ENDED event, so our ENDED → playlist:next-track
      // path never runs and guests diverge until drift correction catches
      // up. Detect the transition here and schedule an auto-sync (pause
      // host briefly, broadcast hostPlayAt, resume everyone simultaneously).
      if (!hostConn
        && prevIdx !== -1
        && playlistIdx >= 0
        && !getManagedTimer('yt-auto-sync')
        && !getManagedTimer('yt-sync-grace')
      ) {
        log.debug(`[YouTube] Sub-video auto-advance detected: ${prevIdx} → ${playlistIdx} (state=${state}), applying 1-sec sync`);
        bus.emit('youtube:sub-video-advanced');
      }

      // Pre-emptive title update from subItemsMap (if available) for instant feedback
      const currentTrack = (getState('playlist.items') || [])[getState('playlist.currentTrackIndex')];
      if (currentTrack?.playlistId && playlistIdx >= 0) {
        const subMap = getState('youtube.subItemsMap') || {};
        const cachedTitle = subMap[currentTrack.playlistId]?.titles?.[playlistIdx];
        if (cachedTitle) {
          const currentMeta = getState('player.currentTrackMeta') || currentTrack;
          setState('player.currentTrackMeta', { ...currentMeta, title: cachedTitle });
          _ifr.lastVideoTitle = cachedTitle;
        }
      }
    }

    // Update track title and videoId cache.
    // getVideoData() is an expensive cross-iframe call. Only call it when
    // the sub-index changed (detected above) or every Nth tick as a
    // fallback for non-playlist single videos. Legacy v1 never called
    // getVideoData() during polling, and the current version's 2x/second
    // calls were a major contributor to iframe memory pressure and crashes.
    _ifr.videoDataPollCount = (_ifr.videoDataPollCount + 1) % VIDEO_DATA_POLL_EVERY_NTH_TICK;
    const shouldPollVideoData = subIndexJustChanged
      ? false  // sub-index branch above already ran; title was set from subItemsMap
      : (_ifr.videoDataPollCount === 0); // every Nth tick for title/videoId sync

    let currentVideoId = _ifr.lastDurationVideoId; // reuse cached value by default
    if (shouldPollVideoData && player.getVideoData) {
      const vData = player.getVideoData();
      if (vData?.title && vData.title !== _ifr.lastVideoTitle) {
        _ifr.lastVideoTitle = vData.title;
        const currentMeta = getState('player.currentTrackMeta');
        if (currentMeta) {
          setState('player.currentTrackMeta', { ...currentMeta, title: vData.title });
        }
      }
      currentVideoId = vData?.video_id || '';

      // Invalidate duration cache when videoId changes
      if (currentVideoId && currentVideoId !== _ifr.lastDurationVideoId) {
        if (_ifr.lastDurationVideoId !== '') {
          setCachedYtDuration(0);
        }
        _ifr.lastDurationVideoId = currentVideoId;
      }
    }

    // Commit the latest rawDuration whenever it diverges meaningfully from
    // the cache. The old "lock on first valid read" pattern was fragile: a
    // transitional poll could land on (new videoId, stale rawDuration) or
    // (stale videoId, stale rawDuration) and permanently pin the cache to
    // the previous video's duration. Re-reading every poll is cheap, and
    // a small threshold keeps the emit quiet when rawDuration is stable.
    if (rawDuration > 0 && Math.abs(rawDuration - getCachedYtDuration()) > DURATION_CACHE_EPSILON) {
      setCachedYtDuration(rawDuration);
    }

    const cachedDuration = getCachedYtDuration();
    // Always emit time-update even when duration is 0 (new video loading).
    // Without this, the seekbar freezes on the previous track's position
    // until getDuration() returns a valid value for the new video.
    // The seekbar handler (ui:time-update) guards on `duration > 0` for
    // slider.max, so a 0 duration just means the thumb won't move but
    // the current time text still updates.
    {
      const displayDuration = cachedDuration > 0 ? cachedDuration : rawDuration;
      bus.emit('ui:time-update', fmtTime(currentTime), fmtTime(displayDuration), currentTime, displayDuration);
    }
  } catch {
    // Player not ready
  }
}

// ─── iOS Play-Gate Overlay ─────────────────────────────────────────
// iOS WebKit blocks iframe-embedded YouTube from autoplaying without a
// direct tap inside the iframe region. This overlay detects when the
// player has been stuck at UNSTARTED(-1) for >3s (see updateYouTubeUI)
// and prompts the user to tap — the tap satisfies iOS gesture, unlocks
// the video element, and (for guests) immediately triggers a one-shot
// rendezvous sync so playback starts aligned with the host instead of
// starting from position 0 and relying on coarse drift correction.

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
        if (!player?.playVideo) return;

        // CRITICAL: flip autoplay intent to `true` BEFORE any player API
        // call. Reason:
        //
        //   loadYouTubeVideo() earlier set _ytAutoplayIntent=false (because
        //   host broadcasts YOUTUBE_PLAY with autoplay:false). The pause-back
        //   guard in onYouTubePlayerStateChange relies on this flag to revert
        //   any accidental PLAYING transition back to PAUSED.
        //
        //   Without flipping it here, the rendezvous's legitimate
        //   scheduled playVideo() (fired ~1.5s later) causes a PLAYING
        //   event that the guard interprets as "not intended" and pauses
        //   back — leaving the user staring at a paused player until the
        //   autoSync cooldown expires and drift correction force-plays.
        //
        //   User explicitly tapping the overlay IS the play intent, so
        //   flipping the flag here is semantically correct.
        setYtAutoplayIntent(true);

        // Step 1 — satisfy iOS user-gesture requirement SYNCHRONOUSLY.
        // Once the <video> element has received a user-initiated play() inside
        // this gesture window, subsequent programmatic play/pause/seek calls
        // (including those inside setManagedTimer) work without re-gesturing.
        try {
          player.playVideo();
          // Immediately pause to prevent an audible blip from position 0
          // before rendezvous takes over. Pause does not revoke the unlock.
          player.pauseVideo?.();
        } catch (e) {
          log.debug('[YouTube iOS gate] prime play/pause threw:', e);
        }

        showYouTubeSyncOverlay(false);

        // Step 2 — decide fallback path. Guest → rendezvous (aligned start).
        // Host/standalone → plain playVideo (no external reference to follow).
        const hostConn = getState('network.hostConn');
        if (hostConn) {
          try {
            guestRendezvousSync();
          } catch (err) {
            log.warn('[YouTube iOS gate] rendezvous failed, falling back to plain play:', err);
            try { player.playVideo(); } catch { /* noop */ }
          }
        } else {
          try { player.playVideo(); } catch { /* noop */ }
        }
      };
      overlay.innerHTML = `
        <div style="background:var(--primary);color:white;padding:12px 24px;border-radius:100px;font-weight:bold;font-size:14px;box-shadow:0 4px 15px rgba(0,0,0,0.3);display:flex;align-items:center;gap:8px;">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M8 5v14l11-7z"/></svg>
          ${t('youtube.tap_to_play')}
        </div>
      `;
      const wrapper = document.querySelector('.video-wrapper');
      if (wrapper) wrapper.appendChild(overlay);
    }
    overlay.style.display = 'flex';
  } else if (overlay) {
    overlay.remove();
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

/**
 * Snapshot the resolved videoId list from the YouTube player's internal queue.
 * This is the ONLY way to get the correct list for RD (Mixes) and also
 * allows us to bypass the IFrame's OOM-prone playlist engine for PL-type lists.
 *
 * Retry counts are tracked per-playlistId so concurrent snapshots of
 * different playlists don't share/clobber each other's attempt state.
 */
const SNAPSHOT_MAX_RETRIES = 20;
const _snapshotRetryCounts = new Map<string, number>();

function _triggerPlaylistSnapshot(pid: string, isRetry = false): void {
  if (!isRetry) _snapshotRetryCounts.set(pid, 0);

  try {
    const player = getYouTubePlayer();
    if (!player?.getPlaylist) return;

    const subMap = getState('youtube.subItemsMap') || {};
    const existingIds = subMap[pid]?.ids || [];

    const ids = (player.getPlaylist() || []).slice(0, PLAYLIST_MAX_ITEMS);

    // YouTube's player sometimes returns a placeholder single-item list
    // before the real playlist has fully resolved. If we don't already
    // have a full list cached, retry until we get 2+ items (or give up).
    if (!Array.isArray(ids) || ids.length === 0 || (ids.length === 1 && existingIds.length <= 1)) {
      const attempts = _snapshotRetryCounts.get(pid) ?? 0;
      if (attempts < SNAPSHOT_MAX_RETRIES) {
        _snapshotRetryCounts.set(pid, attempts + 1);
        log.debug(`[YouTube Snapshot] Empty/single list for ${pid}, retrying (${attempts + 1}/${SNAPSHOT_MAX_RETRIES})`);
        setManagedTimer(`yt-snapshot-retry-${pid}`, () => _triggerPlaylistSnapshot(pid, true), 1000);
      } else {
        log.warn(`[YouTube Snapshot] Gave up on ${pid} after ${SNAPSHOT_MAX_RETRIES} retries`);
        _snapshotRetryCounts.delete(pid);
      }
      return;
    }

    // CRITICAL: If the player is in single-video mode (loadVideoById), getPlaylist()
    // often returns an array of length 1. Do not overwrite our full list with this.
    if (existingIds.length > 1 && ids.length <= 1) {
      log.debug('[YouTube Snapshot] Ignoring skewed snapshot (single-video mode):', pid);
      _snapshotRetryCounts.delete(pid);
      return;
    }

    _snapshotRetryCounts.delete(pid);
    log.info(`[YouTube Snapshot] Captured ${ids.length} items:`, pid);

    // Preserve any titles already fetched or cached
    const existingTitles = subMap[pid]?.titles || [];
    const titles = ids.map((_, idx) => existingTitles[idx] || '');

    setSubItemsData(pid, ids, titles);

    // Broadcast to guests so they use this static list for sub-navigation
    broadcast({
      type: MSG.YOUTUBE_PLAYLIST_INFO,
      playlistId: pid,
      ids,
      titles
    });

    // Start fetching titles in the background
    fetchPlaylistSubTitles(pid, ids);

    // Clear any pending snapshot timers as we just finished it
    clearManagedTimer('yt-playlist-snapshot');
  } catch (e) {
    log.warn('[YouTube Snapshot] Error:', e);
  }
}
