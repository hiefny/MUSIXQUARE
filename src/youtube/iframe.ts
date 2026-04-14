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
  setYtAutoplayIntent,
  setCachedYtDuration,
  setYouTubeSubIndex,
  setSubItemsData,
} from './_state.ts';
import { showToast, showLoader } from '../ui/toast.ts';
import { fetchPlaylistSubTitles } from './search.ts';

declare const YT: any;

export let _lastYtStateBroadcast = 0;
export function markYtStateBroadcast(): void { _lastYtStateBroadcast = Date.now(); }

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

  setCachedYtDuration(0);
  _lastYtStateBroadcast = 0;
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

  // Legacy-style player reuse: loadPlaylist or loadVideoById directly.
  // No pause-back guard, no single-video enforcement — keep it simple.
  const existingPlayer = getYouTubePlayer();
  if (existingPlayer?.loadVideoById) {
    log.debug('[YouTube] Re-using existing player instance');
    try {
      if (playlistId) {
        if (Array.isArray(playlistId)) {
          existingPlayer.loadPlaylist(playlistId, subIndex, 0);
        } else {
          existingPlayer.loadPlaylist({ list: playlistId, listType: 'playlist', index: subIndex, startSeconds: 0 });
        }
      } else if (videoId) {
        existingPlayer.loadVideoById(videoId);
      }
      if (!autoplay && existingPlayer.pauseVideo) existingPlayer.pauseVideo();
      setYouTubeSubIndex(subIndex);
      setYtLoadInProgress(false);
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
    if (Array.isArray(playlistId)) {
      playerVars.playlist = playlistId.join(',');
    } else {
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

          // Switch to single-video mode: free YouTube's playlist engine
          // memory by loading just the current video. This prevents crashes
          // on 200+ item playlists. Position is near 0 (just started) so
          // the reset is harmless.
          const subIdx = getState('youtube.currentSubIndex') ?? 0;
          const currentId = ids[subIdx] || ids[0];
          if (currentId && freshPlayer.loadVideoById) {
            log.info(`[YouTube] Switching to single-video: ${currentId}`);
            freshPlayer.loadVideoById(currentId);
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
  if (!player) return;
  const state = event.data;

  // Legacy-style: simple state handling, no pause-back guard
  if (state === YT.PlayerState.PLAYING) {
    showYouTubeSyncOverlay(false);
    showLoader(false);
    bus.emit('ui:update-play-state', true);
  } else if (state === YT.PlayerState.PAUSED) {
    bus.emit('ui:update-play-state', false);
  } else if (state === YT.PlayerState.ENDED) {
    clearManagedTimer('youtubeUILoop');
    clearManagedTimer('youtubeSyncLoop');

    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      log.debug('[YouTube] Ended, playing next track...');
      bus.emit('playlist:next-track');
    } else {
      // Guest: wait for host's command
      log.debug('[YouTube] Guest: video ended — waiting for host');
      setManagedTimer('yt-guest-ended-fallback', () => {
        if (getState('appState') === APP_STATE.PLAYING_YOUTUBE) {
          setAppState(APP_STATE.IDLE);
          bus.emit('youtube:stop-mode');
        }
      }, 5_000);
    }
    return;
  }

  // Host broadcasts state to guests (legacy: simple 300ms dedup)
  const hostConn = getState('network.hostConn');
  if (!hostConn && player?.getCurrentTime) {
    const now = Date.now();
    if (now - _lastYtStateBroadcast > 300) {
      _lastYtStateBroadcast = now;
      broadcast({
        type: MSG.YOUTUBE_STATE,
        state,
        time: player.getCurrentTime(),
        subIndex: player.getPlaylistIndex?.() ?? -1,
        videoId: player.getVideoData?.()?.video_id || '',
      });
    }
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

    // iOS watchdog
    if (IS_IOS && state === -1) {
      if (!getYtIOSWatchdog()) setYtIOSWatchdog(Date.now());
      if (Date.now() - getYtIOSWatchdog()! > 3000) {
        showYouTubeSyncOverlay(true);
      }
    } else {
      setYtIOSWatchdog(null);
    }

    // Sub-index tracking (legacy style: poll getPlaylistIndex)
    if (player.getPlaylistIndex) {
      const playlistIdx = player.getPlaylistIndex();
      const cachedIdx = getState('youtube.currentSubIndex') ?? -1;
      if (playlistIdx >= 0 && playlistIdx !== cachedIdx) {
        setYouTubeSubIndex(playlistIdx);
        setCachedYtDuration(0);
        // Host: emit sub-video-advanced for sync
        const hostConn = getState('network.hostConn');
        if (!hostConn && cachedIdx !== -1) {
          bus.emit('youtube:sub-video-advanced');
        }
      }
    }

    // Legacy-style seekbar update: just emit current time + duration
    if (rawDuration > 0) {
      bus.emit('ui:time-update', fmtTime(currentTime), fmtTime(rawDuration), currentTime, rawDuration);
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
