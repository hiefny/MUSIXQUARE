/**
 * MUSIXQUARE 2.0 — YouTube Player
 * Extracted from original app.js lines 11313-11788
 *
 * Manages: YouTube IFrame API, player lifecycle, state changes,
 * UI loop, stopYouTubeMode.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, APP_STATE } from '../core/constants.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { broadcast, safeSend, sendToHost } from '../network/peer.ts';
import { registerHandlers, verifyOperator } from '../network/protocol.ts';
import { IS_IOS } from '../core/platform.ts';
import { fmtTime } from '../player/playback.ts';
import { setEngineMode } from '../player/video.ts';
import { fetchYouTubePreview, extractYouTubeVideoId, extractYouTubePlaylistId, fetchOEmbedTitle, fetchPlaylistSubTitles } from './search.ts';
import type { DataConnection, PlaylistItem } from '../types/index.ts';

 
declare const YT: any;
 

// ─── Module State ──────────────────────────────────────────────────

 
let _youtubePlayer: any = null;
let _currentYouTubeSessionId = 0;
let _ytScriptLoading = false;
let _ytLoadTimeout: ReturnType<typeof setTimeout> | null = null;
let _ytIOSWatchdog: number | null = null;

 
export function getYouTubePlayer(): any {
  return _youtubePlayer;
}

// ─── Load YouTube Video ────────────────────────────────────────────

export function loadYouTubeVideo(
  videoId: string | null,
  playlistId: string | null = null,
  autoplay = true,
  subIndex = 0,
): void {
  _cachedYtDuration = 0; // Reset duration cache for new video
  _currentYouTubeSessionId++;
  const currentSessionId = _currentYouTubeSessionId;

  bus.emit('player:stop-all-media');
  setEngineMode('youtube');

  bus.emit('ui:show-toast', 'YouTube 같이 보기 - 고급 오디오 효과가 비활성화됩니다');

  const wrapper = document.querySelector('.video-wrapper');
  if (!wrapper) {
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

  if (!_youtubePlayer) {
    container.innerHTML = '<div id="youtube-player"></div>';
  }

  const w = window as unknown as Record<string, unknown>;
  if (!w.YT || !(w.YT as Record<string, unknown>).Player) {
    if (!_ytScriptLoading) {
      _ytScriptLoading = true;
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.onload = () => log.debug('[YouTube] API script loaded');
      tag.onerror = () => {
        log.error('[YouTube] Failed to load API script');
        _ytScriptLoading = false;
        bus.emit('ui:show-toast', 'YouTube API 로드 실패. 인터넷 연결 확인!');
      };
      document.head.appendChild(tag);
    }
    w.onYouTubeIframeAPIReady = () => {
      (w as Record<string, boolean>).isYouTubeAPIReady = true;
      initYouTubePlayer(videoId, playlistId, autoplay, subIndex);
    };
  } else {
    initYouTubePlayer(videoId, playlistId, autoplay, subIndex);
  }

  // Safety timeout
  if (_ytLoadTimeout) clearTimeout(_ytLoadTimeout);
  _ytLoadTimeout = setTimeout(() => {
    if (_currentYouTubeSessionId === currentSessionId && !_youtubePlayer) {
      log.warn('[YouTube] Load timeout triggered.');
      bus.emit('ui:show-loader', false);
      bus.emit('ui:show-toast', 'YouTube 로드 시간 초과. 다시 시도해주세요.');
    }
  }, 15000);

  bus.emit('ui:play-btn-state', true);

  const fsBtn = document.querySelector('.fullscreen-btn') as HTMLElement | null;
  if (fsBtn) fsBtn.style.setProperty('display', 'none', 'important');

  setTimeout(() => refreshYouTubeDisplay(), 500);
  log.debug('[YouTube] Loaded:', videoId || playlistId, 'autoplay:', autoplay);
}

// ─── Init YouTube Player (IFrame) ──────────────────────────────────

function initYouTubePlayer(
  videoId: string | null,
  playlistId: string | null = null,
  autoplay = true,
  subIndex = 0,
): void {
  const currentState = getState<string>('appState');
  if (currentState !== APP_STATE.PLAYING_YOUTUBE) {
    log.warn('[YouTube] initYouTubePlayer aborted - not in PLAYING_YOUTUBE state');
    return;
  }

  if (_youtubePlayer?.loadVideoById) {
    log.debug('[YouTube] Re-using existing player instance');
    try {
      if (playlistId) {
        _youtubePlayer.loadPlaylist({ list: playlistId, listType: 'playlist', index: subIndex, startSeconds: 0 });
      } else if (videoId) {
        _youtubePlayer.loadVideoById(videoId);
      }
      if (!autoplay) _youtubePlayer.pauseVideo();
      return;
    } catch (e) {
      log.warn('[YouTube] Failed to reuse player, recreating...', e);
      const container = document.getElementById('youtube-player-container');
      if (container) container.innerHTML = '<div id="youtube-player"></div>';
    }
  }

   
  const playerVars: Record<string, any> = {
    autoplay: autoplay ? 1 : 0,
    controls: 1,
    rel: 0,
    modestbranding: 1,
    playsinline: 1,
    origin: window.location.origin,
  };

  if (playlistId) {
    playerVars.listType = 'playlist';
    playerVars.list = playlistId;
    playerVars.index = subIndex;
  }

   
  const playerOptions: Record<string, any> = {
    width: '100%',
    height: '100%',
    playerVars,
    events: {
      onReady: onYouTubePlayerReady,
      onStateChange: onYouTubePlayerStateChange,
    },
  };

  if (videoId) playerOptions.videoId = videoId;

  _youtubePlayer = new YT.Player('youtube-player', playerOptions);
}

// ─── Player Events ─────────────────────────────────────────────────

function onYouTubePlayerReady(): void {
  log.debug('[YouTube] Player ready');

  const currentState = getState<string>('appState');
  if (currentState !== APP_STATE.PLAYING_YOUTUBE) {
    log.debug('[YouTube] onPlayerReady skipped - mode changed');
    return;
  }

  // Start UI update loop
  clearManagedTimer('youtubeUILoop');
  setManagedTimer('youtubeUILoop', updateYouTubeUI, 500, { interval: true });

  // Only Host runs sync loop
  clearManagedTimer('youtubeSyncLoop');
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (!hostConn) {
    setManagedTimer('youtubeSyncLoop', () => {
      bus.emit('youtube:broadcast-sync');
    }, 3000, { interval: true });
  }

  // Apply volume
  bus.emit('audio:apply-youtube-volume');
}

function onYouTubePlayerStateChange(event: { data: number }): void {
  const currentState = getState<string>('appState');
  if (currentState !== APP_STATE.PLAYING_YOUTUBE) return;

  const state = event.data;

  if (state === YT.PlayerState.PLAYING) {
    showYouTubeSyncOverlay(false);
    bus.emit('ui:update-play-state', true);
  } else if (state === YT.PlayerState.PAUSED) {
    bus.emit('ui:update-play-state', false);
  } else if (state === YT.PlayerState.ENDED) {
    setState('appState', APP_STATE.IDLE);
    bus.emit('player:state-changed', APP_STATE.IDLE);
    clearManagedTimer('youtubeUILoop');

    const hostConn = getState<DataConnection | null>('network.hostConn');
    if (!hostConn) {
      log.debug('[YouTube] Ended, playing next track...');
      bus.emit('playlist:next-track');
    }
  }

  // Host broadcasts state to guests
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (!hostConn && _youtubePlayer?.getCurrentTime) {
    broadcast({
      type: MSG.YOUTUBE_STATE,
      state,
      time: _youtubePlayer.getCurrentTime(),
      subIndex: _youtubePlayer.getPlaylistIndex?.() ?? -1,
    });
  }
}

// ─── YouTube UI Update Loop ────────────────────────────────────────

/**
 * Duration cache — locks after first valid read.
 * Reset only on explicit video change (load, stop, playlist index change).
 * Prevents YouTube API's getDuration() float jitter from flickering the UI.
 */
let _cachedYtDuration = 0;
let _cachedYtPlaylistIdx = -1;

function updateYouTubeUI(): void {
  const currentState = getState<string>('appState');
  if (!_youtubePlayer || currentState !== APP_STATE.PLAYING_YOUTUBE || !_youtubePlayer.getCurrentTime) return;

  try {
    const currentTime = _youtubePlayer.getCurrentTime();
    const rawDuration = _youtubePlayer.getDuration?.() || 0;
    const playlistIdx = _youtubePlayer.getPlaylistIndex?.() ?? -1;
    const state = _youtubePlayer.getPlayerState?.() ?? -1;

    // iOS watchdog
    if (IS_IOS && (state === 5 || state === -1)) {
      if (!_ytIOSWatchdog) _ytIOSWatchdog = Date.now();
      if (Date.now() - _ytIOSWatchdog > 3000) {
        showYouTubeSyncOverlay(true);
      }
    } else {
      _ytIOSWatchdog = null;
    }

    // Reset cache when playlist sub-index changes (= different video)
    if (playlistIdx !== _cachedYtPlaylistIdx) {
      _cachedYtPlaylistIdx = playlistIdx;
      _cachedYtDuration = 0;
    }

    // Lock duration on first valid read — stays locked until video changes
    if (rawDuration > 0 && _cachedYtDuration === 0) {
      _cachedYtDuration = rawDuration;
    }

    if (_cachedYtDuration > 0) {
      bus.emit('ui:time-update', fmtTime(currentTime), fmtTime(_cachedYtDuration), currentTime, _cachedYtDuration);
    }
  } catch {
    // Player not ready
  }
}

// ─── iOS Sync Overlay ──────────────────────────────────────────────

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
        if (_youtubePlayer?.playVideo) {
          _youtubePlayer.playVideo();
          showYouTubeSyncOverlay(false);
        }
      };
      overlay.innerHTML = `
        <div style="background:var(--primary);color:white;padding:12px 24px;border-radius:100px;font-weight:bold;font-size:14px;box-shadow:0 4px 15px rgba(0,0,0,0.3);display:flex;align-items:center;gap:8px;">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M8 5v14l11-7z"/></svg>
          TAP TO SYNC VIDEO
        </div>
      `;
      const wrapper = document.querySelector('.video-wrapper');
      if (wrapper) wrapper.appendChild(overlay);
    }
    overlay.style.display = 'flex';
  } else if (overlay) {
    overlay.style.display = 'none';
    _ytIOSWatchdog = null;
  }
}

// ─── Refresh Display Hack ──────────────────────────────────────────

function refreshYouTubeDisplay(): void {
  const container = document.getElementById('youtube-player-container');
  const currentState = getState<string>('appState');
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

// ─── Stop YouTube Mode ─────────────────────────────────────────────

export function stopYouTubeMode(): void {
  _cachedYtDuration = 0; // Reset duration cache

  // Always transition to IDLE — state may already have been changed (e.g. by ENDED handler)
  const currentState = getState<string>('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    setState('appState', APP_STATE.IDLE);
    bus.emit('player:state-changed', APP_STATE.IDLE);
  }

  clearManagedTimer('youtubeUILoop');
  clearManagedTimer('youtubeSyncLoop');

  if (_ytLoadTimeout) {
    clearTimeout(_ytLoadTimeout);
    _ytLoadTimeout = null;
  }

  if (_youtubePlayer) {
    try {
      log.debug('[YouTube] Destroying player instance...');
      _youtubePlayer.stopVideo();
      if (typeof _youtubePlayer.destroy === 'function') _youtubePlayer.destroy();
    } catch (e: unknown) {
      log.debug('[YouTube] Cleanup error (non-critical):', (e as Error).message);
    }
    _youtubePlayer = null;
  }

  const container = document.getElementById('youtube-player-container');
  if (container) container.innerHTML = '';

  const videoEl = document.getElementById('main-video') as HTMLVideoElement | null;
  if (videoEl) {
    videoEl.pause();
    videoEl.src = '';
    videoEl.style.display = 'none';
    videoEl.load();
  }

  const fsBtn = document.querySelector('.fullscreen-btn') as HTMLElement | null;
  if (fsBtn) {
    fsBtn.style.removeProperty('display');
    fsBtn.style.display = '';
  }

  // Notify guests to stop YouTube (Host only)
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (!hostConn) {
    broadcast({ type: MSG.YOUTUBE_STOP });
  }

  bus.emit('ui:update-playlist');
  log.debug('[YouTube] Mode stopped');
}

// ─── Network Handlers ──────────────────────────────────────────────

function handleYouTubePlay(data: Record<string, unknown>): void {
  const videoId = data.videoId as string | null;
  const playlistId = data.playlistId as string | null;
  const index = data.index as number | undefined;
  const autoplay = data.autoplay as boolean | undefined;
  const subIndex = data.subIndex as number | undefined;

  if (!videoId && !playlistId) {
    log.warn('[YouTube] handleYouTubePlay: no videoId or playlistId');
    return;
  }

  if (index !== undefined) {
    setState('playlist.currentTrackIndex', index);
  }

  loadYouTubeVideo(videoId, playlistId, autoplay ?? false, subIndex ?? 0);
}

function handleRequestYouTubePlay(_data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) return; // Only Host

  if (!verifyOperator(conn)) {
    log.warn(`[YouTube] Rejected request-youtube-play from non-OP: ${conn?.peer}`);
    return;
  }

  if (_youtubePlayer?.playVideo) {
    _youtubePlayer.playVideo();
    broadcast({
      type: MSG.YOUTUBE_STATE,
      state: 1,
      time: _youtubePlayer.getCurrentTime?.() || 0,
    });
  }
}

function handleRequestYouTubePause(_data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn)) {
    log.warn(`[YouTube] Rejected request-youtube-pause from non-OP: ${conn?.peer}`);
    return;
  }

  if (_youtubePlayer?.pauseVideo) {
    _youtubePlayer.pauseVideo();
    broadcast({
      type: MSG.YOUTUBE_STATE,
      state: 2,
      time: _youtubePlayer.getCurrentTime?.() || 0,
    });
  }
}

function handleRequestYouTubeSubSeek(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn)) {
    log.warn(`[YouTube] Rejected request-youtube-sub-seek from non-OP: ${conn?.peer}`);
    return;
  }

  const subIdx = data.subIdx as number;
  if (_youtubePlayer?.playVideoAt && typeof subIdx === 'number') {
    _youtubePlayer.playVideoAt(subIdx);
  }
}

/**
 * Host responds to Guest's request for YouTube playlist sub-item data.
 * Sends cached IDs and titles from subItemsMap.
 */
function handleRequestYouTubePlaylistInfo(data: Record<string, unknown>, conn?: DataConnection): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) return; // Only Host handles this

  const pid = data.playlistId as string;
  if (!pid || !conn) return;

  const subMap = getState<Record<string, { ids: string[]; titles: string[] }>>('youtube.subItemsMap') || {};
  if (subMap[pid]) {
    safeSend(conn, {
      type: MSG.YOUTUBE_PLAYLIST_INFO,
      playlistId: pid,
      ids: subMap[pid].ids || [],
      titles: subMap[pid].titles || [],
    });
  }
}

// ─── Init ──────────────────────────────────────────────────────────

export function initYouTube(): void {
  registerHandlers({
    [MSG.YOUTUBE_PLAY]: handleYouTubePlay,
    [MSG.REQUEST_YOUTUBE_PLAY]: handleRequestYouTubePlay,
    [MSG.REQUEST_YOUTUBE_PAUSE]: handleRequestYouTubePause,
    [MSG.REQUEST_YOUTUBE_SUB_SEEK]: handleRequestYouTubeSubSeek,
    [MSG.REQUEST_YOUTUBE_PLAYLIST_INFO]: handleRequestYouTubePlaylistInfo,
  });

  // Bus event handlers from other modules
  bus.on('youtube:stop-mode', (() => stopYouTubeMode()) as (...args: unknown[]) => void);

  bus.on('youtube:load', ((...args: unknown[]) => {
    const [videoId, playlistId, autoplay] = args;
    loadYouTubeVideo(videoId as string, playlistId as string | null, autoplay as boolean);
  }) as (...args: unknown[]) => void);

  bus.on('youtube:toggle-play', (() => {
    const hostConn = getState<DataConnection | null>('network.hostConn');
    const isOperator = getState<boolean>('network.isOperator');

    if (hostConn && isOperator) {
      // OP requests
      try {
        const state = _youtubePlayer?.getPlayerState?.();
        if (state === YT.PlayerState.PLAYING) {
          hostConn.send({ type: MSG.REQUEST_YOUTUBE_PAUSE });
        } else {
          hostConn.send({ type: MSG.REQUEST_YOUTUBE_PLAY });
        }
      } catch (e) {
        log.error('[YouTube] OP toggle error:', e);
      }
      return;
    }

    // Host direct
    if (!_youtubePlayer) return;
    try {
      const state = _youtubePlayer.getPlayerState();
      if (state === YT.PlayerState.PLAYING) {
        _youtubePlayer.pauseVideo();
        broadcast({ type: MSG.YOUTUBE_STATE, state: 2, time: _youtubePlayer.getCurrentTime() });
      } else {
        _youtubePlayer.playVideo();
        broadcast({ type: MSG.YOUTUBE_STATE, state: 1, time: _youtubePlayer.getCurrentTime() });
      }
    } catch (e) {
      log.error('[YouTube] Toggle play error:', e);
    }
  }) as (...args: unknown[]) => void);

  bus.on('youtube:auto-play', (() => {
    if (_youtubePlayer?.playVideo) {
      _youtubePlayer.playVideo();
      bus.emit('youtube:broadcast-sync');
    }
  }) as (...args: unknown[]) => void);

  bus.on('youtube:get-position', ((...args: unknown[]) => {
    const cb = args[0] as (pos: number) => void;
    if (typeof cb === 'function') {
      try {
        const pos = _youtubePlayer?.getCurrentTime?.() ?? 0;
        cb(typeof pos === 'number' && isFinite(pos) && pos >= 0 ? pos : 0);
      } catch {
        cb(0);
      }
    }
  }) as (...args: unknown[]) => void);

  bus.on('youtube:stop-playback', (() => {
    if (!_youtubePlayer) return;
    try {
      _youtubePlayer.stopVideo();
      try { _youtubePlayer.seekTo(0, true); } catch { /* noop */ }
      broadcast({ type: MSG.YOUTUBE_STATE, state: 2, time: 0 });
    } catch (e) {
      log.error('[YouTube] Stop error:', e);
    }
  }) as (...args: unknown[]) => void);

  bus.on('youtube:skip-time', ((...args: unknown[]) => {
    const sec = Number(args[0]) || 0;
    if (!_youtubePlayer) return;
    try {
      const current = _youtubePlayer.getCurrentTime();
      const duration = _youtubePlayer.getDuration();
      let target = current + sec;
      if (target < 0) target = 0;
      if (target > duration) target = duration;
      _youtubePlayer.seekTo(target, true);
      broadcast({ type: MSG.YOUTUBE_STATE, state: _youtubePlayer.getPlayerState(), time: target });
    } catch (e) {
      log.error('[YouTube] Skip time error:', e);
    }
  }) as (...args: unknown[]) => void);

  // YouTube seek from seek bar
  bus.on('youtube:seek-to', ((...args: unknown[]) => {
    const time = Number(args[0]);
    if (!_youtubePlayer?.seekTo || !Number.isFinite(time)) return;
    try {
      _youtubePlayer.seekTo(time, true);
      const hostConn = getState<DataConnection | null>('network.hostConn');
      if (!hostConn) {
        broadcast({
          type: MSG.YOUTUBE_STATE,
          state: _youtubePlayer.getPlayerState?.() ?? 1,
          time,
        });
      }
    } catch (e) {
      log.error('[YouTube] Seek error:', e);
    }
  }) as (...args: unknown[]) => void);

  bus.on('youtube:try-next-internal', ((...args: unknown[]) => {
    const cb = args[0] as (success: boolean) => void;
    if (!_youtubePlayer?.getPlaylist || typeof cb !== 'function') { cb(false); return; }
    try {
      const ids = _youtubePlayer.getPlaylist() || [];
      const idx = _youtubePlayer.getPlaylistIndex();
      if (ids.length > 0 && idx < ids.length - 1) {
        _youtubePlayer.nextVideo();
        cb(true);
        return;
      }
    } catch { /* noop */ }
    cb(false);
  }) as (...args: unknown[]) => void);

  bus.on('youtube:try-prev-internal', ((...args: unknown[]) => {
    const cb = args[0] as (success: boolean) => void;
    if (!_youtubePlayer || typeof cb !== 'function') { cb(false); return; }
    try {
      const currentTime = _youtubePlayer.getCurrentTime();
      if (currentTime > 3) {
        _youtubePlayer.seekTo(0, true);
        broadcast({ type: MSG.YOUTUBE_STATE, state: _youtubePlayer.getPlayerState(), time: 0 });
        cb(true);
        return;
      }
      const ids = _youtubePlayer.getPlaylist?.() || [];
      const idx = _youtubePlayer.getPlaylistIndex?.() ?? -1;
      if (ids.length > 0 && idx > 0) {
        _youtubePlayer.previousVideo();
        cb(true);
        return;
      }
    } catch { /* noop */ }
    cb(false);
  }) as (...args: unknown[]) => void);

  bus.on('youtube:broadcast-sync', (() => {
    // Imported dynamically to avoid circular deps
    import('./sync.ts').then(mod => mod.broadcastYouTubeSync());
  }) as (...args: unknown[]) => void);

  // YouTube preview (from URL input)
  bus.on('youtube:preview', ((...args: unknown[]) => {
    const url = args[0] as string;
    fetchYouTubePreview(url || '');
  }) as (...args: unknown[]) => void);

  // YouTube load from input field
  bus.on('youtube:load-from-input', (() => {
    const input = document.getElementById('youtube-url-input') as HTMLInputElement | null;
    if (!input) return;
    const url = input.value.trim();
    if (!url) {
      bus.emit('ui:show-toast', 'YouTube 링크를 입력하세요');
      return;
    }

    const videoId = extractYouTubeVideoId(url);
    const playlistId = extractYouTubePlaylistId(url);

    if (!videoId && !playlistId) {
      bus.emit('ui:show-toast', '유효한 YouTube 링크가 아닙니다');
      return;
    }

    // Close the overlay + reset preview UI
    const overlay = document.getElementById('youtube-url-overlay');
    if (overlay) overlay.classList.remove('active');
    input.value = '';
    const previewEl = document.getElementById('youtube-preview');
    if (previewEl) previewEl.style.display = 'none';
    const statusEl = document.getElementById('youtube-preview-status');
    if (statusEl) { statusEl.style.display = ''; statusEl.textContent = '링크를 입력하면 미리보기가 표시됩니다'; }
    const playBtn = document.getElementById('youtube-play-btn') as HTMLButtonElement | null;
    if (playBtn) playBtn.disabled = true;

    // Add YouTube entry to playlist
    const playlist = getState<PlaylistItem[]>('playlist.items') || [];

    // Get title from preview UI or use URL
    const previewTitle = document.getElementById('youtube-preview-title');
    const titleText = previewTitle?.innerText?.trim() || url;

    const newTrack: PlaylistItem = {
      type: 'youtube',
      name: titleText,
      title: titleText,
      videoId: videoId || undefined,
      playlistId: playlistId || undefined,
    };

    playlist.push(newTrack);
    setState('playlist.items', playlist);
    const newIndex = playlist.length - 1;
    setState('playlist.currentTrackIndex', newIndex);
    bus.emit('ui:update-playlist');
    bus.emit('player:metadata-update', newTrack);

    // Broadcast playlist update + YouTube command to peers
    const hostConn = getState<DataConnection | null>('network.hostConn');
    if (!hostConn) {
      const metaList = playlist.map(item => ({
        type: item.type,
        name: item.name,
        title: item.title || item.name,
        videoId: item.videoId || null,
        playlistId: item.playlistId || null,
      }));
      broadcast({ type: MSG.PLAYLIST_UPDATE, list: metaList });
      broadcast({
        type: MSG.YOUTUBE_PLAY,
        videoId,
        playlistId,
        index: newIndex,
        autoplay: true,
      });
    }

    loadYouTubeVideo(videoId, playlistId, true);

    // Fetch title in background and update
    fetchOEmbedTitle(url).then(title => {
      if (!title) return;
      const currentPlaylist = getState<PlaylistItem[]>('playlist.items') || [];
      if (currentPlaylist[newIndex]) {
        const updated = [...currentPlaylist];
        updated[newIndex] = { ...updated[newIndex], name: title, title: title };
        setState('playlist.items', updated);
        bus.emit('ui:update-playlist');
        bus.emit('player:metadata-update', updated[newIndex]);
      }
    });
  }) as (...args: unknown[]) => void);

  // Sync nudge for YouTube (adjust playback position by ms delta)
  bus.on('sync:youtube-nudge', ((...args: unknown[]) => {
    const ms = Number(args[0]);
    if (!_youtubePlayer?.seekTo || !Number.isFinite(ms)) return;
    try {
      const current = _youtubePlayer.getCurrentTime();
      _youtubePlayer.seekTo(current + (ms / 1000), true);
    } catch (e) {
      log.error('[YouTube] Nudge error:', e);
    }
  }) as (...args: unknown[]) => void);

  // YouTube refresh display (from tab switch)
  bus.on('youtube:refresh-display', (() => {
    refreshYouTubeDisplay();
  }) as (...args: unknown[]) => void);

  // YouTube set volume (from audio engine)
  bus.on('youtube:set-volume', ((...args: unknown[]) => {
    const vol = Number(args[0]);
    if (_youtubePlayer?.setVolume && Number.isFinite(vol)) {
      _youtubePlayer.setVolume(vol);
    }
  }) as (...args: unknown[]) => void);

  // YouTube sub-item seek (from playlist-view sub-item click)
  bus.on('youtube:sub-seek', ((...args: unknown[]) => {
    const playlistIdx = Number(args[0]);
    const subIdx = Number(args[1]);
    const isCurrent = args[2] as boolean;

    if (!_youtubePlayer) return;

    if (isCurrent) {
      // Same playlist — just jump to sub-index
      if (_youtubePlayer.playVideoAt) {
        _youtubePlayer.playVideoAt(subIdx);
        broadcast({
          type: MSG.YOUTUBE_STATE,
          state: 1,
          time: 0,
          subIndex: subIdx,
        });
      }
    } else {
      // Different playlist item — load it first, then sub-seek
      bus.emit('playlist:play-track', playlistIdx);
      // The sub-index will be picked up after loadYouTubeVideo
    }
  }) as (...args: unknown[]) => void);

  // Populate sub-items when expanding a YouTube playlist entry
  bus.on('youtube:populate-sub-items', ((...args: unknown[]) => {
    const playlistId = args[0] as string;
    if (!playlistId) return;

    let ids: string[] = [];

    // 1. Try to get IDs from current player if it matches the requested playlist
    const playlist = getState<PlaylistItem[]>('playlist.items') || [];
    const currentTrackIndex = getState<number>('playlist.currentTrackIndex');
    const currentItem = playlist[currentTrackIndex];

    if (_youtubePlayer?.getPlaylist && currentItem?.playlistId === playlistId) {
      try {
        ids = _youtubePlayer.getPlaylist() || [];
      } catch { /* YouTube player may not be ready */ }
    }

    // 2. Initial map setup
    const subMap = getState<Record<string, { ids: string[]; titles: string[] }>>('youtube.subItemsMap') || {};
    if (ids.length > 0) {
      if (!subMap[playlistId]) {
        subMap[playlistId] = { ids, titles: [] };
      } else if (!subMap[playlistId].ids || subMap[playlistId].ids.length === 0) {
        subMap[playlistId].ids = ids;
      }
      setState('youtube.subItemsMap', { ...subMap });
    }

    // 3. Trigger background title fetcher (All roles)
    const currentSubMap = getState<Record<string, { ids: string[]; titles: string[] }>>('youtube.subItemsMap') || {};
    if (currentSubMap[playlistId]?.ids?.length > 0) {
      fetchPlaylistSubTitles(playlistId, currentSubMap[playlistId].ids);
    }

    // 4. Guest: Request info from Host if sub-item data is missing
    const hostConn = getState<DataConnection | null>('network.hostConn');
    if (hostConn) {
      if (!currentSubMap[playlistId] || !currentSubMap[playlistId].ids || currentSubMap[playlistId].ids.length === 0) {
        sendToHost({ type: MSG.REQUEST_YOUTUBE_PLAYLIST_INFO, playlistId });
      }
    }

    bus.emit('ui:update-playlist');
  }) as (...args: unknown[]) => void);

  // YouTube load from chat message link
  bus.on('youtube:load-from-chat', ((...args: unknown[]) => {
    const url = args[0] as string;
    if (!url) return;

    // Host-only guard
    const hostConn = getState<DataConnection | null>('network.hostConn');
    if (hostConn) {
      bus.emit('ui:show-toast', '방장만 유튜브 링크를 추가할 수 있어요.');
      return;
    }

    const videoId = extractYouTubeVideoId(url);
    const playlistId = extractYouTubePlaylistId(url);
    if (!videoId && !playlistId) {
      bus.emit('ui:show-toast', '유효하지 않은 YouTube 링크');
      return;
    }

    // Close chat drawer if open
    bus.emit('ui:close-chat-drawer');

    // Add YouTube entry to playlist
    const playlist = getState<PlaylistItem[]>('playlist.items') || [];
    const newTrack: PlaylistItem = {
      type: 'youtube',
      name: url,
      title: url,
      videoId: videoId || undefined,
      playlistId: playlistId || undefined,
    };
    playlist.push(newTrack);
    setState('playlist.items', playlist);
    const newIndex = playlist.length - 1;
    setState('playlist.currentTrackIndex', newIndex);
    bus.emit('ui:update-playlist');
    bus.emit('player:metadata-update', newTrack);

    // hostConn is already confirmed null from guard above — we are Host
    const metaList = playlist.map(item => ({
      type: item.type,
      name: item.name,
      title: item.title || item.name,
      videoId: item.videoId || null,
      playlistId: item.playlistId || null,
    }));
    broadcast({ type: MSG.PLAYLIST_UPDATE, list: metaList });
    broadcast({
      type: MSG.YOUTUBE_PLAY,
      videoId,
      playlistId,
      index: newIndex,
      autoplay: true,
    });

    loadYouTubeVideo(videoId, playlistId, true);

    // Fetch title in background
    fetchOEmbedTitle(url).then(title => {
      if (!title) return;
      const currentPlaylist = getState<PlaylistItem[]>('playlist.items') || [];
      if (currentPlaylist[newIndex]) {
        const updated = [...currentPlaylist];
        updated[newIndex] = { ...updated[newIndex], name: title, title: title };
        setState('playlist.items', updated);
        bus.emit('ui:update-playlist');
        bus.emit('player:metadata-update', updated[newIndex]);
      }
    });
  }) as (...args: unknown[]) => void);

  // Host: Send YouTube state to newly connected peer (late-join bootstrap)
  bus.on('network:peer-connected', ((...args: unknown[]) => {
    const conn = args[0] as DataConnection | null;
    if (!conn?.open) return;

    // Only Host bootstraps guests
    const hostConn = getState<DataConnection | null>('network.hostConn');
    if (hostConn) return;

    const currentState = getState<string>('appState');
    if (currentState !== APP_STATE.PLAYING_YOUTUBE) return;

    const playlist = getState<PlaylistItem[]>('playlist.items') || [];
    const currentTrackIndex = getState<number>('playlist.currentTrackIndex');
    const item = playlist[currentTrackIndex];

    if (!item || item.type !== 'youtube') return;

    try {
      let ytTime = 0;
      let ytState = 2; // paused

      try {
        if (_youtubePlayer?.getCurrentTime) ytTime = _youtubePlayer.getCurrentTime();
        if (_youtubePlayer?.getPlayerState) ytState = _youtubePlayer.getPlayerState();
      } catch { /* best-effort */ }

      const autoplay = (ytState === 1);
      const currentSubIndex = getState<number>('youtube.currentSubIndex') ?? -1;
      const subIdx = (currentSubIndex >= 0) ? currentSubIndex : 0;

      // Send YouTube play command so guest enters YouTube mode
      conn.send({
        type: MSG.YOUTUBE_PLAY,
        videoId: item.videoId || null,
        playlistId: item.playlistId || null,
        name: item.name || item.title,
        index: currentTrackIndex,
        autoplay,
        subIndex: subIdx,
      });

      // Also send an immediate sync frame
      conn.send({
        type: MSG.YOUTUBE_SYNC,
        time: ytTime,
        state: ytState,
        subIndex: subIdx,
      });

      log.debug('[YouTube] Bootstrap: sent YouTube state to new peer');
    } catch (e) {
      log.warn('[YouTube] Bootstrap send failed:', e);
    }
  }) as (...args: unknown[]) => void);

  log.info('[YouTube] Player initialized');
}
