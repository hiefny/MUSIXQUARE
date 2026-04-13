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
  getCachedYtPlaylistIdx, setCachedYtPlaylistIdx,
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
export let _lastYtStateBroadcast = 0; // Cooldown to prevent duplicate broadcasts from UI + onStateChange
export function markYtStateBroadcast(): void { _lastYtStateBroadcast = Date.now(); }

// ─── Load YouTube Video ────────────────────────────────────────────

export function loadYouTubeVideo(
  videoId: string | null,
  playlistId: string | string[] | null = null,
  autoplay = true,
  subIndex = 0,
): void {
  const player = getYouTubePlayer();

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

  // Reset sub-index cache so the sub-video auto-advance detector (in
  // updateYouTubeUI) doesn't mistake the initial index of a freshly loaded
  // track for a mid-playlist transition. The cache is populated on the
  // first updateYouTubeUI tick after the player becomes ready.
  setCachedYtPlaylistIdx(-1);

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
      // Note: pauseVideo() removed — handled by onStateChange via _ytAutoplayIntent flag.
      // loadPlaylist() is async; pauseVideo() on UNSTARTED player is a no-op.
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

  // ── YouTube Mix (RD...) Snapshot & Sync (Host Only) ──
  const hostConn = getState('network.hostConn');
  if (!hostConn && typeof playlistId === 'string' && playlistId.startsWith('RD') && player?.getPlaylist) {
    const mixId = playlistId; // Captured for closure
    log.debug('[YouTube Mix] Detected dynamic mix, scheduling host-side snapshot...');
    // Wait a few seconds for YouTube to populate the internal playlist IDs
    setManagedTimer('yt-mix-snapshot', () => {
      try {
        // Re-fetch player — original capture may be stale after 3s
        const freshPlayer = getYouTubePlayer();
        if (!freshPlayer?.getPlaylist) return;
        const ids = freshPlayer.getPlaylist();
        if (Array.isArray(ids) && ids.length > 0) {
          log.info(`[YouTube Mix] Snapshotting ${ids.length} items for sync:`, mixId);
          // Snapshot IDs and clear titles (let fetchPlaylistSubTitles fill them)
          const titles = new Array(ids.length).fill('');
          setSubItemsData(mixId, ids, titles);
          
          // Broadcast to all guests so they use this static list instead of generating their own
          broadcast({
            type: MSG.YOUTUBE_PLAYLIST_INFO,
            playlistId: mixId,
            ids,
            titles
          });

          // Trigger background oEmbed title fetching
          fetchPlaylistSubTitles(mixId, ids);
        }
      } catch (e) {
        log.warn('[YouTube Mix] Snapshot failed:', e);
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
    // Reset flag after firing so subsequent user-initiated plays work normally.
    if (!getYtAutoplayIntent()) {
      setYtAutoplayIntent(true);
      player?.pauseVideo?.();
      return; // Don't broadcast or update UI — we're reverting to paused
    }
    showYouTubeSyncOverlay(false);
    bus.emit('ui:update-play-state', true);
  } else if (state === YT.PlayerState.PAUSED) {
    bus.emit('ui:update-play-state', false);
  } else if (state === YT.PlayerState.ENDED) {
    clearManagedTimer('youtubeUILoop');
    clearManagedTimer('youtubeSyncLoop');

    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      // Host: skip IDLE state transition to prevent UI flash — next-track
      // will call stopAllMedia({ silent: true }) which handles state internally.
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
  if (!hostConn && player?.getCurrentTime && !syncInFlight && now - _lastYtStateBroadcast > 300) {
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

// ─── YouTube UI Update Loop ────────────────────────────────────────

function updateYouTubeUI(): void {
  const player = getYouTubePlayer();
  const currentState = getState('appState');
  if (!player || currentState !== APP_STATE.PLAYING_YOUTUBE || !player.getCurrentTime) return;

  try {
    const currentTime = player.getCurrentTime();
    const rawDuration = player.getDuration?.() || 0;
    const playlistIdx = player.getPlaylistIndex?.() ?? -1;
    const state = player.getPlayerState?.() ?? -1;

    // iOS watchdog: only trigger on UNSTARTED (-1), not CUED (5)
    // state=5 (CUED) is a normal pre-play state, not a playback failure
    if (IS_IOS && state === -1) {
      if (!getYtIOSWatchdog()) setYtIOSWatchdog(Date.now());
      if (Date.now() - getYtIOSWatchdog()! > 3000) {
        showYouTubeSyncOverlay(true);
      }
    } else {
      setYtIOSWatchdog(null);
    }

    // Reset cache when playlist sub-index changes (= different video)
    if (playlistIdx !== getCachedYtPlaylistIdx()) {
      const prevIdx = getCachedYtPlaylistIdx();
      setCachedYtPlaylistIdx(playlistIdx);
      setCachedYtDuration(0);
      _lastYtVideoTitle = ''; // Reset title cache to force update on index change

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
        return; // Skip rest of UI update — host command will handle everything
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
          const currentMeta = getState('player.currentTrackMeta') || {};
          setState('player.currentTrackMeta', { ...currentMeta, title: cachedTitle });
          _lastYtVideoTitle = cachedTitle;
        }
      }
    }

    // Update track title whenever YouTube video title changes
    let currentVideoId = '';
    if (player.getVideoData) {
      const vData = player.getVideoData();
      if (vData?.title && vData.title !== _lastYtVideoTitle) {
        _lastYtVideoTitle = vData.title;
        const currentMeta = getState('player.currentTrackMeta') || {};
        setState('player.currentTrackMeta', { ...currentMeta, title: vData.title });
      }
      currentVideoId = vData?.video_id || '';
    }

    // Invalidate the duration cache whenever the videoId changes. Without
    // this, `player.getDuration()` returning the OLD video's duration briefly
    // after `loadVideoById` would latch into the cache (via the "first valid
    // read" logic below) and never refresh for subsequent videos.
    //
    // Guard: empty currentVideoId means getVideoData has no data yet —
    // don't stomp state on an uninitialised poll.
    if (currentVideoId && currentVideoId !== _lastDurationVideoId) {
      if (_lastDurationVideoId !== '') {
        setCachedYtDuration(0); // force re-read on next valid rawDuration
      }
      _lastDurationVideoId = currentVideoId;
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
    if (cachedDuration > 0) {
      bus.emit('ui:time-update', fmtTime(currentTime), fmtTime(cachedDuration), currentTime, cachedDuration);
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
