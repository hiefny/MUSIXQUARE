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
  getYtAutoplayIntent, setYtAutoplayIntent,
  getCachedYtDuration, setCachedYtDuration,
  setYouTubeSubIndex,
  setSubItemsData,
} from './_state.ts';
import { showToast, showLoader } from '../ui/toast.ts';
import { fetchPlaylistSubTitles } from './search.ts';

declare const YT: any;

/** Tracks the last known YouTube video title to detect changes */
let _lastYtVideoTitle = '';
/**
 * Tracks the YouTube videoId that the duration cache is currently valid for.
 * Needed because player.getDuration() can return the OLD video's duration
 * briefly after loadVideoById — the "lock on first valid read" pattern would
 * otherwise cache the stale value and never update for subsequent videos.
 * Cleared on loadYouTubeVideo / stopYouTubeMode so the next poll refreshes.
 */
let _lastDurationVideoId = '';
let _videoDataPollCount = 0;
export let _lastYtStateBroadcast = 0; // Cooldown to prevent duplicate broadcasts from UI + onStateChange
let _lastYtBroadcastState = -1; // Last broadcast player state (for state-aware dedup)
export function markYtStateBroadcast(): void { _lastYtStateBroadcast = Date.now(); }

// ─── Helpers ──────────────────────────────────────────────────────

/** Resolve a single video ID from the various parameter combinations.
 *  In single-video mode we never pass arrays to YouTube's loadPlaylist —
 *  instead we pick the one video at `subIndex` from the array. */
function _resolveSingleVideoId(
  videoId: string | null,
  playlistId: string | string[] | null,
  subIndex: number,
): string | null {
  if (videoId) return videoId;
  if (Array.isArray(playlistId) && playlistId.length > 0) {
    return playlistId[Math.min(subIndex, playlistId.length - 1)] || playlistId[0];
  }
  // String playlistId (e.g. 'PLxxx', 'RDxxx') — we can't resolve a single
  // video from this without the YouTube API. Return null; the caller will
  // fall through to creating a new player with the playlistId in playerVars
  // (initial load only — subsequent loads use subItemsMap IDs).
  return null;
}

// ─── Load YouTube Video ────────────────────────────────────────────

export function loadYouTubeVideo(
  videoId: string | null,
  playlistId: string | string[] | null = null,
  autoplay = true,
  subIndex = 0,
): void {
  const player = getYouTubePlayer();

  // YouTube-to-YouTube transition: reuse the existing player instance
  // instead of destroying and recreating the iframe. On iOS, recreating
  // the iframe resets the user gesture — requiring a tap to play again.
  // loadVideoById/loadPlaylist on the same player preserves the gesture.
  const isYouTubeToYouTube = player?.loadVideoById && getState('appState') === APP_STATE.PLAYING_YOUTUBE;

  if (isYouTubeToYouTube) {
    log.debug('[YouTube] YouTube-to-YouTube transition — reusing player, skipping stop-all-media');
    try { player!.stopVideo?.(); } catch { /* noop */ }
    showLoader(true, t('youtube.playing_in_3s'));
    // Light cleanup: reset sync state without destroying the player
    clearManagedTimer('yt-clock-action');
    clearManagedTimer('yt-auto-sync');
    clearManagedTimer('yt-sync-grace');
    import('./sync.ts').then(mod => mod.resetYouTubeSyncState()).catch(() => { /* noop */ });

    // Restart UI loop if it was cleared by the ENDED handler.
    // The ENDED→playTrack→loadYouTubeVideo path clears youtubeUILoop
    // in onStateChange(ENDED), but the YT-to-YT reuse path skips
    // onYouTubePlayerReady (which normally starts the loop).
    if (!getManagedTimer('youtubeUILoop')) {
      setManagedTimer('youtubeUILoop', updateYouTubeUI, 500, { interval: true });
    }
    // Same for host sync loop
    const hostConn = getState('network.hostConn');
    if (!hostConn && !getManagedTimer('youtubeSyncLoop')) {
      setManagedTimer('youtubeSyncLoop', () => {
        bus.emit('youtube:broadcast-sync');
      }, 3000, { interval: true });
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
  _lastDurationVideoId = ''; // Force duration re-read on next updateYouTubeUI tick
  _lastYtStateBroadcast = 0; // Allow immediate first broadcast for new session
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
      createYouTubePlayer(videoId, playlistId as string | string[] | null, autoplay, subIndex);
    };
  } else {
    createYouTubePlayer(videoId, playlistId as string | string[] | null, autoplay, subIndex);
  }

  // Safety timeout
  setManagedTimer('yt-load-timeout', () => {
    if (getCurrentSessionId() === sessionId && !scope.aborted && !getYouTubePlayer()) {
      log.warn('[YouTube] Load timeout triggered.');
      setYtLoadInProgress(false);
      showLoader(false);
      showToast(t('youtube.load_timeout'));
    }
  }, 15000);

  bus.emit('ui:play-btn-state', true);

  // Keep fullscreen button visible in YouTube mode — the button targets
  // .video-wrapper which contains the YouTube iframe container, so
  // Fullscreen API works correctly for both local video and YouTube.

  setManagedTimer('yt-refresh-display', () => refreshYouTubeDisplay(), 500);
  log.debug('[YouTube] Loaded:', videoId || playlistId, 'autoplay:', autoplay);
}

// ─── Create YouTube Player (IFrame) ────────────────────────────────

function createYouTubePlayer(
  videoId: string | null,
  playlistId: string | string[] | null = null,
  autoplay = true,
  subIndex = 0,
): void {
  const currentState = getState('appState');
  if (currentState !== APP_STATE.PLAYING_YOUTUBE) {
    log.warn('[YouTube] createYouTubePlayer aborted - not in PLAYING_YOUTUBE state');
    setYtLoadInProgress(false);
    return;
  }

  // Set autoplay intent BEFORE any player API call — onStateChange
  // checks this flag to pause-back if autoplay was not requested.
  // Fixes: loadPlaylist() is async, so pauseVideo() on UNSTARTED is a no-op.
  setYtAutoplayIntent(autoplay);

  const existingPlayer = getYouTubePlayer();
  if (existingPlayer?.loadVideoById) {
    log.debug('[YouTube] Re-using existing player instance');
    try {
      // Single-video mode: always load exactly ONE video via loadVideoById.
      // Never use loadPlaylist — YouTube's internal playlist engine scales
      // memory with playlist size and crashes on 100+ items on mobile.
      const resolvedId = _resolveSingleVideoId(videoId, playlistId, subIndex);
      if (resolvedId) {
        existingPlayer.loadVideoById(resolvedId);
      } else {
        log.warn('[YouTube] Could not resolve single videoId — no video to load');
      }
      // Note: pauseVideo() removed — handled by onStateChange via _ytAutoplayIntent flag.
      // loadPlaylist() is async; pauseVideo() on UNSTARTED player is a no-op.
      setYouTubeSubIndex(subIndex);
      setYtLoadInProgress(false);

      // Suppress heartbeat state-sync for 5s after loading a new video.
      // Without this, the host's heartbeat (state:1 from the PREVIOUS video)
      // arrives before YOUTUBE_STATE and wakes the guest via state-sync
      // (hostState=1, ytState≠1 → playVideo), causing the guest to play
      // from position 0 while the host is still loading.
      if (!autoplay) {
        import('./sync.ts').then(mod => { mod.suppressDriftUntil(5000); }).catch(() => { /* noop */ });
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

  // Single-video mode: resolve to a single videoId when possible.
  // YouTube's internal playlist engine scales memory with playlist size
  // and crashes on 100+ items — avoid it wherever we can.
  if (playlistId) {
    if (Array.isArray(playlistId)) {
      // ID array from subItemsMap — pick the one video at subIndex
      const resolved = playlistId[Math.min(subIndex, playlistId.length - 1)] || playlistId[0];
      if (resolved) videoId = resolved;
      playlistId = null; // don't pass array to playerVars
    } else if (videoId) {
      // String playlistId + videoId: HOST initial load uses playerVars.list
      // to discover playlist IDs via getPlaylist(). Guests never reach here
      // because playlist.ts resolves to single videoId before broadcasting.
      const hostConn = getState('network.hostConn');
      if (!hostConn) {
        // Host: use playlist loading for ID discovery, then switch to single-video
        playerVars.listType = 'playlist';
        playerVars.list = playlistId;
        playerVars.index = subIndex;
      }
      // Guest: ignore playlistId, just use videoId (already set)
    } else {
      // String playlistId without videoId — rare edge case.
      // Must use playlist engine (no other way to resolve first video).
      playerVars.listType = 'playlist';
      playerVars.list = playlistId;
      playerVars.index = subIndex;
    }
  }

  const playerOptions: Record<string, any> = {
    width: '100%',
    height: '100%',
    playerVars,
    events: {
      onReady: () => onYouTubePlayerReady(playlistId),
      onStateChange: onYouTubePlayerStateChange,
      onError: onYouTubePlayerError,
    },
  };

  if (videoId) playerOptions.videoId = videoId;

  setYouTubePlayer(new YT.Player('youtube-player', playerOptions));

  // A11y: add title to iframe once YouTube API creates it
  requestAnimationFrame(() => {
    const iframe = document.querySelector('#youtube-player-container iframe') as HTMLIFrameElement | null;
    if (iframe) iframe.title = 'YouTube video player';
  });
}

// ─── Player Events ─────────────────────────────────────────────────

function onYouTubePlayerReady(playlistId: string | string[] | null = null): void {
  setYtLoadInProgress(false);
  log.debug('[YouTube] Player ready');

  const currentState = getState('appState');
  if (currentState !== APP_STATE.PLAYING_YOUTUBE) {
    log.debug('[YouTube] onPlayerReady skipped - mode changed');
    return;
  }

  const player = getYouTubePlayer();

  // ── Playlist Snapshot & Sync (Host Only) ──
  // In single-video mode, we need subItemsMap populated for ALL playlist
  // types (Mix RD, regular PL) so try-next/prev-internal can find sub-videos.
  const hostConn = getState('network.hostConn');
  if (!hostConn && typeof playlistId === 'string' && player?.getPlaylist) {
    const snapshotId = playlistId;
    log.debug('[YouTube] Scheduling playlist snapshot for subItemsMap...');
    // Wait a few seconds for YouTube to populate the internal playlist IDs
    setManagedTimer('yt-mix-snapshot', () => {
      try {
        const freshPlayer = getYouTubePlayer();
        if (!freshPlayer?.getPlaylist) return;
        const ids = freshPlayer.getPlaylist();
        if (Array.isArray(ids) && ids.length > 0) {
          log.info(`[YouTube] Snapshotting ${ids.length} items for subItemsMap:`, snapshotId);
          const titles = new Array(ids.length).fill('');
          setSubItemsData(snapshotId, ids, titles);

          // Set initial sub-index if not already set
          const currentSub = getState('youtube.currentSubIndex') ?? -1;
          if (currentSub < 0) {
            const currentIdx = freshPlayer.getPlaylistIndex?.() ?? 0;
            setYouTubeSubIndex(currentIdx >= 0 ? currentIdx : 0);
          }

          broadcast({
            type: MSG.YOUTUBE_PLAYLIST_INFO,
            playlistId: snapshotId,
            ids,
            titles
          });

          fetchPlaylistSubTitles(snapshotId, ids);

          // Switch to single-video mode: load just the current video via
          // loadVideoById, freeing YouTube's internal playlist engine memory.
          // All subsequent navigation uses subItemsMap + loadVideoById.
          const subIdx = getState('youtube.currentSubIndex') ?? 0;
          const currentVideoId = ids[subIdx] || ids[0];
          if (currentVideoId && freshPlayer.loadVideoById) {
            log.debug(`[YouTube] Switching to single-video mode: ${currentVideoId}`);
            freshPlayer.loadVideoById(currentVideoId);
          }
        }
      } catch (e) {
        log.warn('[YouTube] Playlist snapshot failed:', e);
      }
    }, 3000);
  }

  // Start UI update loop
  clearManagedTimer('youtubeUILoop');
  setManagedTimer('youtubeUILoop', updateYouTubeUI, 500, { interval: true });

  // Only Host runs sync loop
  clearManagedTimer('youtubeSyncLoop');
  if (!hostConn) {
    setManagedTimer('youtubeSyncLoop', () => {
      bus.emit('youtube:broadcast-sync');
    }, 3000, { interval: true });
  }

  // Apply volume
  bus.emit('audio:apply-youtube-volume');

  // Notify anyone waiting for the player to become usable (e.g. the URL
  // input path in player.ts that wants to trigger a 1-sec rendezvous sync
  // as soon as the freshly created player instance is ready).
  bus.emit('youtube:player-ready');
}

function onYouTubePlayerError(event: { data: number }): void {
  log.error('[YouTube] Player error:', event.data);
  setYtLoadInProgress(false);
  showLoader(false);
  showToast(t('youtube.load_fail'));
}

function onYouTubePlayerStateChange(event: { data: number }): void {
  const currentState = getState('appState');
  if (currentState !== APP_STATE.PLAYING_YOUTUBE) return;

  const player = getYouTubePlayer();
  if (!player) return; // Player destroyed during async state transition
  const state = event.data;

  if (state === YT.PlayerState.PLAYING) {
    // Pause-back if autoplay was not intended (e.g. loadPlaylist async path).
    // Do NOT reset intent to true here — loadPlaylist() is async and can fire
    // multiple PLAYING events (BUFFERING→PLAYING, internal restart). Resetting
    // on the first one lets the second slip through, causing the guest to play
    // before the host's scheduleYtAutoSync countdown completes.
    // Intent is set to true by scheduleYtAutoSync callers (youtube:auto-play,
    // youtube:sub-video-advanced, etc.) when they're ready for playback.
    if (!getYtAutoplayIntent()) {
      player?.pauseVideo?.();
      showLoader(false);
      // The video loaded and started playing (loadPlaylist async completion).
      // If autoPlayTimer is still pending, fire it NOW — the video is ready.
      // This replaces time-based guessing (1s delay) with event-based detection:
      // YouTube tells us it's ready by firing PLAYING, so we can proceed.
      if (getManagedTimer('autoPlayTimer')) {
        clearManagedTimer('autoPlayTimer');
        bus.emit('youtube:auto-play');
      }
      return; // Don't broadcast or update UI — we're reverting to paused
    }
    showYouTubeSyncOverlay(false);
    showLoader(false);
    bus.emit('ui:update-play-state', true);
  } else if (state === YT.PlayerState.PAUSED) {
    showLoader(false);
    bus.emit('ui:update-play-state', false);
  } else if (state === YT.PlayerState.ENDED) {
    clearManagedTimer('youtubeSyncLoop');

    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      // Host: check if there's a next sub-video in subItemsMap.
      // In single-video mode, ENDED fires at every sub-video boundary
      // (YouTube can't auto-advance without its playlist engine).
      const currentTrack = (getState('playlist.items') || [])[getState('playlist.currentTrackIndex')];
      const subMap = getState('youtube.subItemsMap') || {};
      const subData = subMap[currentTrack?.playlistId as string];
      const currentSubIdx = getState('youtube.currentSubIndex') ?? -1;

      if (subData?.ids && currentSubIdx >= 0 && currentSubIdx < subData.ids.length - 1) {
        // More sub-videos available — load next one
        const nextIdx = currentSubIdx + 1;
        const nextVideoId = subData.ids[nextIdx];
        log.debug(`[YouTube] Sub-video ended, advancing to sub ${nextIdx}: ${nextVideoId}`);
        setYouTubeSubIndex(nextIdx);
        setCachedYtDuration(0);
        _lastYtVideoTitle = '';
        _lastDurationVideoId = '';

        // Update title from cache if available
        const cachedTitle = subData.titles?.[nextIdx];
        if (cachedTitle) {
          const currentMeta = getState('player.currentTrackMeta') || {};
          setState('player.currentTrackMeta', { ...currentMeta, title: cachedTitle });
        }

        // Load next sub-video and sync with guests.
        // Do NOT set autoplayIntent=true here — loadVideoById may trigger
        // PLAYING, and the pause-back guard must catch it so the guest
        // doesn't start before the 3s countdown completes.
        // scheduleYtAutoSync sets intent=true right before its final playVideo.
        const pl = getYouTubePlayer();
        if (pl?.loadVideoById) {
          setYtAutoplayIntent(false);
          pl.loadVideoById(nextVideoId);
          import('./sync.ts').then(mod => mod.suppressDriftUntil(3000)).catch(() => {});
          import('../youtube/player.ts').then(mod => {
            setYtAutoplayIntent(true);
            mod.scheduleYtAutoSync(0, { subIndex: nextIdx, videoId: nextVideoId, skipSeek: true, countdownMs: 3000 });
          }).catch(() => {});
        }
      } else {
        // No more sub-videos — advance MUSIXQUARE playlist
        clearManagedTimer('youtubeUILoop');
        log.debug('[YouTube] Ended, playing next track...');
        bus.emit('playlist:next-track');
      }
    } else {
      // Guest: wait for host's next command (YOUTUBE_STATE with next video).
      log.debug('[YouTube] Guest: video ended — waiting for host next-track');
      setManagedTimer('yt-guest-ended-fallback', () => {
        if (getState('appState') === APP_STATE.PLAYING_YOUTUBE) {
          log.debug('[YouTube] Guest: no next-track from host — going IDLE');
          setAppState(APP_STATE.IDLE);
          bus.emit('youtube:stop-mode');
        }
      }, 5_000);
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
  const isDuplicateState = (state === _lastYtBroadcastState) && (now - _lastYtStateBroadcast < 300);
  if (!hostConn && player?.getCurrentTime && !syncInFlight && !isDuplicateState) {
    _lastYtStateBroadcast = now;
    _lastYtBroadcastState = state;
    broadcast({
      type: MSG.YOUTUBE_STATE,
      state,
      time: player.getCurrentTime(),
      subIndex: getState('youtube.currentSubIndex') ?? -1,
      videoId: player.getVideoData?.()?.video_id || '',
    });
  }
}

// ─── YouTube UI Update Loop ────────────────────────────────────────

let _ytCrashFailCount = 0;
const YT_CRASH_THRESHOLD = 6; // 6 consecutive failures × 500ms = 3s unresponsive

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
    _ytCrashFailCount = 0; // Reset on success
  } catch {
    _ytCrashFailCount++;
    if (_ytCrashFailCount >= YT_CRASH_THRESHOLD) {
      log.error(`[YouTube] iframe unresponsive (${_ytCrashFailCount} failures) — rebuilding player`);
      _ytCrashFailCount = 0;

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
    const state = player.getPlayerState?.() ?? -1;

    // iOS watchdog: only trigger on UNSTARTED (-1), not CUED (5)
    if (IS_IOS && state === -1) {
      if (!getYtIOSWatchdog()) setYtIOSWatchdog(Date.now());
      if (Date.now() - getYtIOSWatchdog()! > 3000) {
        showYouTubeSyncOverlay(true);
      }
    } else {
      setYtIOSWatchdog(null);
    }

    // Single-video mode: no playlist index polling needed.
    // Sub-video sequencing is driven by ENDED events, not getPlaylistIndex.

    // Update track title and videoId cache.
    // getVideoData() is an expensive cross-iframe call. Only call it when
    // the sub-index changed (detected above) or every ~5 seconds (10th tick)
    // as a fallback for non-playlist single videos. Legacy v1 never called
    // getVideoData() during polling, and the current version's 2x/second
    // calls were a major contributor to iframe memory pressure and crashes.
    _videoDataPollCount = (_videoDataPollCount + 1) % 10;
    const shouldPollVideoData = _videoDataPollCount === 0; // every 10th tick (~5s)

    let currentVideoId = _lastDurationVideoId; // reuse cached value by default
    if (shouldPollVideoData && player.getVideoData) {
      const vData = player.getVideoData();
      if (vData?.title && vData.title !== _lastYtVideoTitle) {
        _lastYtVideoTitle = vData.title;
        const currentMeta = getState('player.currentTrackMeta') || {};
        setState('player.currentTrackMeta', { ...currentMeta, title: vData.title });
      }
      currentVideoId = vData?.video_id || '';

      // Invalidate duration cache when videoId changes
      if (currentVideoId && currentVideoId !== _lastDurationVideoId) {
        if (_lastDurationVideoId !== '') {
          setCachedYtDuration(0);
        }
        _lastDurationVideoId = currentVideoId;
      }
    }

    // Commit the latest rawDuration whenever it diverges meaningfully from
    // the cache. The old "lock on first valid read" pattern was fragile: a
    // transitional poll could land on (new videoId, stale rawDuration) or
    // (stale videoId, stale rawDuration) and permanently pin the cache to
    // the previous video's duration. Re-reading every poll is cheap, and
    // a small threshold keeps the emit quiet when rawDuration is stable.
    if (rawDuration > 0 && Math.abs(rawDuration - getCachedYtDuration()) > 0.05) {
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
          // Dynamic import to avoid circular iframe↔sync dependency
          import('./sync.ts').then(mod => mod.guestRendezvousSync()).catch(err => {
            log.warn('[YouTube iOS gate] rendezvous failed, falling back to plain play:', err);
            try { player.playVideo(); } catch { /* noop */ }
          });
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
    overlay.style.display = 'none';
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
