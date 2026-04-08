/**
 * MUSIXQUARE 3.0 — Playlist Management
 *
 * Manages: playlist array, repeat/shuffle modes, playTrack,
 * playNextTrack, playPrevTrack, clearPreloadState.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, APP_STATE, DEMO_FILE_NAME } from '../core/constants.ts';
import { nextSessionId } from '../core/session.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { play, stopAllMedia, getTrackPosition } from './transport.ts';
import { loadAndBroadcastFile, loadPreloadedTrack } from './decode.ts';
import { incrementLoadToken } from './_state.ts';

import { schedulePreload, cancelPreloadTransfer } from '../storage/preload.ts';
import {
  setEQ, setPreamp, setStereoWidth, setVirtualBass, setReverbParam,
} from '../audio/effects.ts';
import { postWorkerCommand } from '../storage/opfs.ts';
import { broadcast, sendToHost } from '../network/peer.ts';
import { isGuestBlocked } from '../network/guards.ts';
// NTP resync removed — SharedClock handles sync
import { registerHandlers, verifyOperator } from '../network/protocol.ts';
import type { DataConnection, PlaylistItem } from '../types/index.ts';
import { showToast, showLoader, updateLoader } from '../ui/toast.ts';

// ─── Repeat / Shuffle ──────────────────────────────────────────────

export function toggleRepeat(): void {
  const hostConn = getState('network.hostConn');
  const isOperator = getState('network.isOperator');
  if (hostConn && !isOperator) return;
  const repeatMode = getState('playlist.repeatMode') || 0;
  const nextMode = (repeatMode + 1) % 3;
  setRepeatMode(nextMode);

  if (!hostConn) {
    broadcast({ type: MSG.REPEAT_MODE, value: nextMode });
  } else if (isOperator) {
    sendToHost({ type: MSG.REQUEST_SETTING, settingType: 'repeat-mode', value: nextMode });
  }
}

export function setRepeatMode(mode: number, notify = true): void {
  setState('playlist.repeatMode', mode);
  const btn = document.getElementById('btn-repeat');
  if (!btn) return;

  btn.classList.remove('active', 'active-one');
  if (mode === 1) {
    btn.classList.add('active');
    if (notify) showToast(t('playlist.repeat_all'));
  } else if (mode === 2) {
    btn.classList.add('active-one');
    if (notify) showToast(t('playlist.repeat_one'));
  } else {
    if (notify) showToast(t('playlist.repeat_off'));
  }
}

export function toggleShuffle(): void {
  const hostConn = getState('network.hostConn');
  const isOperator = getState('network.isOperator');
  if (hostConn && !isOperator) return;
  const isShuffle = getState('playlist.isShuffle');
  const nextShuffle = !isShuffle;
  setShuffle(nextShuffle);

  if (!hostConn) {
    broadcast({ type: MSG.SHUFFLE_MODE, value: nextShuffle });
  } else if (isOperator) {
    sendToHost({ type: MSG.REQUEST_SETTING, settingType: 'shuffle-mode', value: nextShuffle });
  }
}

export function setShuffle(enabled: boolean, notify = true): void {
  setState('playlist.isShuffle', enabled);
  const btn = document.getElementById('btn-shuffle');
  if (btn) btn.classList.toggle('active', enabled);
  if (notify) showToast(enabled ? t('playlist.shuffle_on') : t('playlist.shuffle_off'));
}

// ─── Clear Preload State ───────────────────────────────────────────

export function clearPreloadState(): void {
  const nextMeta = getState('preload.meta');
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const isNextTrackActive = nextMeta && (Number(nextMeta.index) === currentTrackIndex);

  // Cancel any in-flight backgroundTransfer to prevent stale preload data
  // from reaching guests after backward navigation (host-only).
  cancelPreloadTransfer();

  setState('preload.nextTrackIndex', -1);
  if (!isNextTrackActive) {
    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
  }
  setState('preload.isPreloading', false);

  // Host side: clear peers' preloadedIndexes cache — guests reset their OPFS
  // on track change, so the host must not assume they still have old files
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    const connectedPeers = getState('network.connectedPeers') || [];
    if (connectedPeers.length > 0 && connectedPeers.some(p => p.preloadedIndexes?.size > 0)) {
      const updatedPeers = connectedPeers.map(p =>
        p.preloadedIndexes?.size > 0
          ? { ...p, preloadedIndexes: new Set<number>() }
          : p,
      );
      setState('network.connectedPeers', updatedPeers);
    }
  }

  // Guest side
  postWorkerCommand({ command: 'OPFS_RESET', isPreload: true });
}

// ─── Play Track ────────────────────────────────────────────────────

export async function playTrack(index: number, subIndex?: number): Promise<void> {
  const playlist = getState('playlist.items') || [];
  if (index < 0 || index >= playlist.length) {
    if (playlist.length === 0) showToast(t('toast.no_tracks'));
    return;
  }

  clearManagedTimer('autoPlayTimer');
  clearManagedTimer('ended-advance-retry');
  clearManagedTimer('ended-advance-next');

  // Cancel in-flight preload
  setState('preload.isPreloading', false);

  const hostConn = getState('network.hostConn');

  // Auto-switch to Play tab (Host only)
  if (!hostConn) bus.emit('ui:switch-tab', 'play');

  const myLoadToken = incrementLoadToken();

  // Check if preloaded
  const nextTrackIndex = getState('preload.nextTrackIndex');
  const nextFileBlob = getState('preload.nextFileBlob');

  if (index === nextTrackIndex && nextFileBlob && !hostConn) {
    log.debug('[Host] Using Preloaded Track:', index);
    setState('playlist.currentTrackIndex', index);
    setState('player.currentTrackMeta', playlist[index]);

    // Advance session ID for recovery
    const nextMeta = getState('preload.meta');
    if (nextMeta?.sessionId && Number.isFinite(Number(nextMeta.sessionId))) {
      setState('transfer.currentSessionId', Number(nextMeta.sessionId));
    } else {
      setState('transfer.currentSessionId', nextSessionId());
    }

    stopAllMedia({ silent: true }); // suppress IDLE flash — play() follows immediately

    const item = playlist[index];
    const fileName = item?.file?.name || item?.name || `Track ${index}`;
    broadcast({ type: MSG.PLAY_PRELOADED, index, name: fileName, mime: item?.file?.type });

    await loadPreloadedTrack(index, myLoadToken);
    await play(0);
    broadcast({ type: MSG.PLAY, time: 0, index, name: fileName });
    // SharedClock handles sync
    schedulePreload();
    return;
  }

  clearPreloadState();
  setState('playlist.currentTrackIndex', index);

  const item = playlist[index];
  setState('player.currentTrackMeta', item);

  // YouTube
  if (item.type === 'youtube') {
    // Force-clear any stale audio preload state to prevent incorrect
    // preloaded file being used when switching back from YouTube to audio
    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    setState('preload.nextTrackIndex', -1);

    if (!hostConn) {
      stopAllMedia({ silent: true }); // suppress IDLE flash — youtube:load follows
      broadcast({
        type: MSG.YOUTUBE_PLAY,
        videoId: item.videoId,
        playlistId: item.playlistId,
        name: item.name || item.title,
        index,
        autoplay: false,
      });

      const isFirstTrackLoad = getState('player.isFirstTrackLoad');
      if (isFirstTrackLoad) {
        setState('player.isFirstTrackLoad', false);
        bus.emit('youtube:load', item.videoId ?? null, item.playlistId ?? null, false, subIndex ?? 0);
        showToast(t('youtube.ready'));
      } else {
        bus.emit('youtube:load', item.videoId ?? null, item.playlistId ?? null, false, subIndex ?? 0);
        showToast(t('youtube.playing_in_3s'));
        setManagedTimer('autoPlayTimer', () => {
          bus.emit('youtube:auto-play');
        }, 3000);
      }
    }
    return;
  }

  // Local file playback
  stopAllMedia({ silent: true }); // suppress IDLE flash — play() follows

  const file = item.file;
  if (!file) {
    log.warn('[Playlist] No file for track', index);
    return;
  }

  if (!hostConn) {
    const sessionId = nextSessionId();
    setState('transfer.currentSessionId', sessionId);

    broadcast({ type: MSG.FILE_PREPARE, name: file.name, index, sessionId, mime: file.type });
    await loadAndBroadcastFile(file, sessionId, false, myLoadToken);

    const isFirstTrackLoad = getState('player.isFirstTrackLoad');
    if (isFirstTrackLoad) {
      setState('player.isFirstTrackLoad', false);
      showToast(t('toast.file_ready'));
    } else {
      showToast(t('toast.playing_in_3s'));
      setManagedTimer('autoPlayTimer', () => {
        play(0);
        const currentIdx = getState('playlist.currentTrackIndex');
        broadcast({ type: MSG.PLAY, time: 0, index: currentIdx, name: file.name });
        // SharedClock handles sync
      }, 3000);
    }
  }
}

// ─── Play Next Track ───────────────────────────────────────────────

export function playNextTrack(): void {
  if (isGuestBlocked()) return;

  const hostConn = getState('network.hostConn');
  const isOperator = getState('network.isOperator');
  if (hostConn && isOperator) {
    sendToHost({ type: MSG.REQUEST_NEXT_TRACK });
    return;
  }

  // Host: YouTube internal navigation
  const currentState = getState('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    let handled = false;
    bus.emit('youtube:try-next-internal', (success: boolean) => { handled = success; });
    if (handled) return;
  }

  const playlist = getState('playlist.items') || [];
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const repeatMode = getState('playlist.repeatMode') || 0;
  const isShuffle = getState('playlist.isShuffle');
  const nextTrackIndex = getState('preload.nextTrackIndex');

  if (playlist.length === 0) return;

  let nextIndex: number;

  if (repeatMode === 2) {
    // Repeat-one: restart current track from 0 without full file reload.
    // The audio buffer / video element is still in memory — just seek + play.
    // Note: do NOT call stopAllMedia here — it destroys videoElement.src and
    // revokes blob URLs, preventing video playback from restarting.
    incrementLoadToken();
    play(0).catch(() => { /* noop */ });
    broadcast({ type: MSG.PLAY, time: 0, index: currentTrackIndex });
    // SharedClock handles sync
    return;
  } else if (isShuffle) {
    if (playlist.length === 1) {
      // Single-track + shuffle + repeat OFF → stop (same as sequential behavior)
      if (repeatMode === 0) {
        log.debug('[Host] Single track, shuffle ON, repeat OFF. Stopping.');
        stopAllMedia();
        setState('player.currentTrackMeta', null);
        broadcast({ type: MSG.PAUSE, time: 0 });
        showToast(t('toast.playlist_ended'));
        return;
      }
      nextIndex = 0;
    } else if (nextTrackIndex !== -1 && nextTrackIndex !== currentTrackIndex && nextTrackIndex < playlist.length) {
      nextIndex = nextTrackIndex;
    } else {
      do {
        nextIndex = Math.floor(Math.random() * playlist.length);
      } while (nextIndex === currentTrackIndex);
    }
  } else {
    nextIndex = currentTrackIndex + 1;
    if (nextIndex >= playlist.length) {
      if (repeatMode === 1) {
        nextIndex = 0;
      } else {
        log.debug('[Host] End of playlist reached (Repeat OFF). Stopping.');
        stopAllMedia();
        setState('player.currentTrackMeta', null);
        broadcast({ type: MSG.PAUSE, time: 0 });
        showToast(t('toast.playlist_ended'));
        return;
      }
    }
  }

  if (nextIndex !== -1) {
    playTrack(nextIndex);
  }
}

// ─── Play Previous Track ───────────────────────────────────────────

export function playPrevTrack(): void {
  if (isGuestBlocked()) return;

  const hostConn = getState('network.hostConn');
  const isOperator = getState('network.isOperator');
  if (hostConn && isOperator) {
    sendToHost({ type: MSG.REQUEST_PREV_TRACK });
    return;
  }

  const currentState = getState('appState');
  const currentTrackIndex = getState('playlist.currentTrackIndex');

  // YouTube mode
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    let handled = false;
    bus.emit('youtube:try-prev-internal', (success: boolean) => { handled = success; });
    if (handled) return;

    if (currentTrackIndex > 0) {
      playTrack(currentTrackIndex - 1);
    } else {
      const playlist = getState('playlist.items') || [];
      const repeatMode = getState('playlist.repeatMode') || 0;
      if (repeatMode === 1 && playlist.length > 1) {
        playTrack(playlist.length - 1);
      } else {
        playTrack(0);
      }
    }
    return;
  }

  // Local mode: restart if > 3s, else previous track
  const pos = getTrackPosition();
  if (pos > 3) {
    // Restart current track from the beginning
    play(0);
    broadcast({ type: MSG.PLAY, time: 0, index: currentTrackIndex });
    // SharedClock handles sync
    return;
  }

  if (currentTrackIndex > 0) {
    playTrack(currentTrackIndex - 1);
  } else {
    // At first track: wrap to last if repeat-all, otherwise restart
    const playlist = getState('playlist.items') || [];
    const repeatMode = getState('playlist.repeatMode') || 0;
    if (repeatMode === 1 && playlist.length > 1) {
      playTrack(playlist.length - 1);
    } else {
      // In IDLE state (after track ended + stopAllMedia), play(0) silently fails
      // because no media source is available, but broadcast still fires → host-guest desync.
      // Use playTrack to reload the file instead.
      const appState = getState('appState');
      if (appState === APP_STATE.IDLE) {
        playTrack(currentTrackIndex);
      } else {
        play(0);
        broadcast({ type: MSG.PLAY, time: 0, index: currentTrackIndex });
        // SharedClock handles sync
      }
    }
  }
}

// ─── Network Handlers ──────────────────────────────────────────────

function handleRepeatMode(data: Record<string, unknown>): void {
  const v = Number(data.value) || 0;
  setRepeatMode(Math.max(0, Math.min(2, v)));
}

function handleShuffleMode(data: Record<string, unknown>): void {
  setShuffle(!!data.value);
}

function handlePlaylistUpdate(data: Record<string, unknown>): void {
  // Backward-compat: legacy may send `playlist` instead of `list`
  const incoming = Array.isArray(data.list) ? data.list :
    (Array.isArray(data.playlist) ? data.playlist : null);
  if (!incoming) {
    setState('playlist.items', []);
    setState('playlist.currentTrackIndex', -1);
    stopAllMedia();
    clearPreloadState();
    return;
  }

  // Validate incoming array: reject oversized or malformed playlists
  if (incoming.length > 1000) {
    log.warn('[Playlist] Rejected oversized playlist update:', incoming.length);
    return;
  }
  // Validate individual items have expected properties
  const valid = incoming.every((item: unknown) =>
    item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string',
  );
  if (!valid) {
    log.warn('[Playlist] Rejected playlist with invalid items');
    return;
  }

  const prevLength = (getState('playlist.items') || []).length;
  setState('playlist.items', incoming);

  // Playlist emptied — stop media and clear ALL stale audio state on guest.
  // CRITICAL: must clear files.currentFileBlob and audio buffer, otherwise when
  // a new track is added at the same index, handleFilePrepare's same-track check
  // (isSameTrackByIndex) matches and the guest replays the old audio instead of
  // downloading the new file.
  if (incoming.length === 0 && prevLength > 0) {
    stopAllMedia();
    clearPreloadState();
    bus.emit('storage:clear-previous-track', 'playlist-emptied');
  }

  // Sync current track index from host (late-join bootstrap)
  let idx = getState('playlist.currentTrackIndex');
  if (typeof data.currentTrackIndex === 'number') {
    idx = data.currentTrackIndex;
  } else if (typeof data.index === 'number') {
    idx = data.index;
  }
  // Clamp to valid range
  if (idx >= incoming.length) idx = incoming.length - 1;
  if (idx < -1) idx = -1;
  if (idx === -1 && incoming.length > 0) idx = 0;
  setState('playlist.currentTrackIndex', idx);
}

function handleTrackChange(data: Record<string, unknown>, conn: DataConnection): void {
  // Host handles OP request
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playlist] Rejected request-track-change from non-OP: ${conn?.peer}`);
    return;
  }

  const index = Number(data.index);
  const playlist = getState('playlist.items') || [];
  if (!Number.isFinite(index) || index < 0 || index >= playlist.length) {
    log.warn(`[Playlist] Invalid track index: ${data.index}`);
    return;
  }
  playTrack(index);
}

function handleRequestNextTrack(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playlist] Rejected request-next-track from non-OP: ${conn?.peer}`);
    return;
  }
  playNextTrack();
}

function handleRequestPrevTrack(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playlist] Rejected request-prev-track from non-OP: ${conn?.peer}`);
    return;
  }
  playPrevTrack();
}

function handleRequestSetting(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playlist] Rejected request-setting from non-OP: ${conn?.peer}`);
    return;
  }

  const st = data.settingType as string;
  const val = data.value;
  switch (st) {
    case 'repeat-mode': {
      const mode = Number(val) || 0;
      setRepeatMode(mode);
      broadcast({ type: MSG.REPEAT_MODE, value: mode });
      break;
    }
    case 'shuffle-mode': {
      const enabled = !!val;
      setShuffle(enabled);
      broadcast({ type: MSG.SHUFFLE_MODE, value: enabled });
      break;
    }
    // ─── Audio Effect Settings (OP → Host apply + broadcast) ──
    case 'eq': {
      const band = parseInt(String(data.band), 10);
      const v = parseFloat(String(val));
      if (!Number.isFinite(band) || !Number.isFinite(v)) break;
      setEQ(band, v);
      broadcast({ type: MSG.EQ_UPDATE, band, value: v });
      break;
    }
    case MSG.PREAMP: {
      const v = parseFloat(String(val));
      if (!Number.isFinite(v)) break;
      setPreamp(v);
      broadcast({ type: MSG.PREAMP, value: v });
      break;
    }
    case 'stereo': {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setStereoWidth(v);
      broadcast({ type: MSG.STEREO_WIDTH, value: v });
      break;
    }
    case MSG.VBASS: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setVirtualBass(v);
      broadcast({ type: MSG.VBASS, value: v });
      break;
    }
    case MSG.REVERB: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setReverbParam('mix', v);
      broadcast({ type: MSG.REVERB, value: v });
      break;
    }
    case MSG.REVERB_TYPE: {
      // val is a string preset ('studio'/'arena'/'off') — apply locally on host + broadcast
      bus.emit('audio:reverb-type-change', String(val));
      break;
    }
    case MSG.REVERB_DECAY: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setReverbParam('decay', v);
      broadcast({ type: MSG.REVERB_DECAY, value: v });
      break;
    }
    case MSG.REVERB_PREDELAY: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setReverbParam('predelay', v);
      broadcast({ type: MSG.REVERB_PREDELAY, value: v });
      break;
    }
    case MSG.REVERB_LOWCUT: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setReverbParam('lowcut', v);
      broadcast({ type: MSG.REVERB_LOWCUT, value: v });
      break;
    }
    case MSG.REVERB_HIGHCUT: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setReverbParam('highcut', v);
      broadcast({ type: MSG.REVERB_HIGHCUT, value: v });
      break;
    }
  }
}

// ─── Load Demo Media ──────────────────────────────────────────────

async function loadDemoMedia(): Promise<void> {
  const hostConn = getState('network.hostConn');
  if (hostConn) {
    showToast(t('toast.host_only'));
    return;
  }

  try {
    showLoader(true, t('transfer.demo_loading_short'));
    updateLoader(0);

    const blob: Blob = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', DEMO_FILE_NAME, true);
      xhr.responseType = 'blob';

      xhr.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          updateLoader(percent);
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.response as Blob);
        } else {
          reject(new Error(`HTTP Error ${xhr.status}`));
        }
      };

      xhr.onerror = () => reject(new Error('Network Error'));
      xhr.timeout = 15000;
      xhr.ontimeout = () => reject(new Error('Request Timeout'));
      xhr.send();
    });

    const file = new File([blob], DEMO_FILE_NAME, { type: 'audio/mpeg' });

    const newTrack: PlaylistItem = {
      type: 'file',
      file,
      name: file.name,
      title: file.name.replace(/\.[^/.]+$/, ''),
      videoId: null,
      playlistId: null,
    };

    const playlist = [...(getState('playlist.items') || [])];
    playlist.push(newTrack);
    setState('playlist.items', playlist);

    const metaList = playlist.map(item => ({
      type: item.type,
      name: item.name,
      title: item.title || item.name,
      videoId: item.videoId || null,
      playlistId: item.playlistId || null,
    }));
    broadcast({ type: MSG.PLAYLIST_UPDATE, list: metaList });

    showToast(t('transfer.demo_loaded'));
    showLoader(false);

    playTrack(playlist.length - 1);
  } catch (e: unknown) {
    log.error('Demo load failed:', e);
    showToast(`${t('transfer.demo_load_fail')} ${(e as Error).message}`);
    showLoader(false);
  }
}

// ─── Handle Files Selected ────────────────────────────────────────

function handleFilesSelected(files: FileList | null): void {
  if (!files || files.length === 0) return;

  const hostConn = getState('network.hostConn');
  if (hostConn) {
    showToast(t('toast.host_only_file'));
    return;
  }

  const playlist = [...(getState('playlist.items') || [])];
  let addedCount = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) continue;

    const newTrack: PlaylistItem = {
      type: 'file',
      file,
      name: file.name,
      title: file.name.replace(/\.[^/.]+$/, ''),
      videoId: null,
      playlistId: null,
    };
    playlist.push(newTrack);
    addedCount++;
  }

  if (addedCount === 0) return;

  setState('playlist.items', playlist);

  const metaList = playlist.map(item => ({
    type: item.type,
    name: item.name,
    title: item.title || item.name,
    videoId: item.videoId || null,
    playlistId: item.playlistId || null,
  }));
  broadcast({ type: MSG.PLAYLIST_UPDATE, list: metaList });

  showToast(t('toast.added_tracks', { count: addedCount }));

  // Auto-play first added file if nothing is playing
  const currentState = getState('appState');
  if (currentState === APP_STATE.IDLE) {
    playTrack(playlist.length - addedCount);
  } else {
    // Already playing — preload next track for guests (covers end-of-playlist + file add case)
    schedulePreload(1000);
  }
}

// ─── Init ──────────────────────────────────────────────────────────

export function initPlaylist(): void {
  registerHandlers({
    [MSG.REPEAT_MODE]: handleRepeatMode,
    [MSG.SHUFFLE_MODE]: handleShuffleMode,
    [MSG.PLAYLIST_UPDATE]: handlePlaylistUpdate,
    [MSG.REQUEST_TRACK_CHANGE]: handleTrackChange,
    [MSG.REQUEST_NEXT_TRACK]: handleRequestNextTrack,
    [MSG.REQUEST_PREV_TRACK]: handleRequestPrevTrack,
    [MSG.REQUEST_SETTING]: handleRequestSetting,
  });

  // Handle track ended auto-advance (guarded against double-fire from overlapping timers)
  let _endedAdvanceToken = 0;
  bus.on('player:ended', () => {
    const hostConn = getState('network.hostConn');
    if (hostConn) return; // Only Host handles

    const token = ++_endedAdvanceToken;
    const repeatMode = getState('playlist.repeatMode') || 0;
    const currentTrackIndex = getState('playlist.currentTrackIndex');

    if (repeatMode === 2) {
      log.debug('Repeat One: Replaying current track...');
      setManagedTimer('ended-advance-retry', () => {
        if (token !== _endedAdvanceToken) return;
        // Reuse in-memory audio buffer — skip file re-transfer to guests.
        // Same optimized path as playNextTrack() repeat-one branch.
        incrementLoadToken();
        play(0).catch(() => { /* noop */ });
        broadcast({ type: MSG.PLAY, time: 0, index: currentTrackIndex });
        // SharedClock handles sync
      }, 300);
    } else {
      log.debug('Auto-advancing to next track...');
      setManagedTimer('ended-advance-next', () => { if (token === _endedAdvanceToken) playNextTrack(); }, 500);
    }
  });

  // Handle MediaSession navigation requests
  bus.on('playlist:prev-track', () => playPrevTrack());
  bus.on('playlist:next-track', () => playNextTrack());

  // Demo media loading
  bus.on('app:load-demo', () => {
    loadDemoMedia();
  });

  // File selection
  bus.on('app:files-selected', (files) => {
    handleFilesSelected(files);
  });

  // Play specific track from playlist view click
  bus.on('playlist:play-track', (index, subIndex) => {
    if (Number.isFinite(index) && index >= 0) playTrack(index, subIndex);
  });

  // Host: Remove track from playlist
  bus.on('playlist:remove-track', (index) => {
    const hostConn = getState('network.hostConn');
    if (hostConn) return; // Only host can remove

    const playlist = [...(getState('playlist.items') || [])];
    if (index < 0 || index >= playlist.length) return;

    const currentTrackIndex = getState('playlist.currentTrackIndex');
    const isCurrentTrack = (index === currentTrackIndex);

    // Remove the item
    playlist.splice(index, 1);
    setState('playlist.items', playlist);

    if (playlist.length === 0) {
      // Empty playlist — stop everything and clear all stale state
      stopAllMedia();
      clearPreloadState();
      setState('playlist.currentTrackIndex', -1);
      setState('player.currentTrackMeta', null);
      setState('files.currentFileBlob', null);
      setState('transfer.meta', {});
    } else if (isCurrentTrack) {
      // Was playing the removed track — play previous or adjusted index
      const newIdx = Math.min(index, playlist.length - 1);
      setState('playlist.currentTrackIndex', newIdx);
      playTrack(newIdx);
    } else if (index < currentTrackIndex) {
      // Removed before current — shift index down
      setState('playlist.currentTrackIndex', currentTrackIndex - 1);
    }

    // Invalidate preload if the removed track shifted/invalidated the preloaded index
    const preloadIdx = getState('preload.nextTrackIndex');
    if (preloadIdx >= 0 && (index <= preloadIdx || preloadIdx >= playlist.length)) {
      clearPreloadState();
      // Re-schedule preload for the correct next track
      if (playlist.length > 0) schedulePreload();
    }

    // Broadcast updated playlist to all guests
    const updatedPlaylist = getState('playlist.items') || [];
    const metaList = updatedPlaylist.map(item => ({
      type: item.type,
      name: item.name,
      title: item.title || item.name,
      videoId: item.videoId || null,
      playlistId: item.playlistId || null,
    }));
    broadcast({
      type: MSG.PLAYLIST_UPDATE,
      list: metaList,
      currentTrackIndex: getState('playlist.currentTrackIndex'),
    });
  });

  // Host: Send playlist state to newly connected peer (late-join bootstrap)
  bus.on('network:peer-connected', (conn) => {
    if (!conn?.open) return;

    // Only Host bootstraps guests
    const hostConn = getState('network.hostConn');
    if (hostConn) return;

    try {
      // Repeat mode
      const repeatMode = getState('playlist.repeatMode') || 0;
      conn.send({ type: MSG.REPEAT_MODE, value: repeatMode });

      // Shuffle mode
      const isShuffle = getState('playlist.isShuffle');
      conn.send({ type: MSG.SHUFFLE_MODE, value: isShuffle });

      // Full playlist metadata
      const playlist = getState('playlist.items') || [];
      const metaList = playlist.map(item => ({
        type: item.type,
        name: item.name,
        title: item.title || item.name,
        videoId: item.videoId || null,
        playlistId: item.playlistId || null,
      }));
      const currentTrackIndex = getState('playlist.currentTrackIndex');
      conn.send({ type: MSG.PLAYLIST_UPDATE, list: metaList, currentTrackIndex });

      log.debug('[Playlist] Bootstrap: sent playlist state to new peer');
    } catch (e) {
      log.warn('[Playlist] Bootstrap send failed:', e);
    }
  });

  log.info('[Playlist] Initialized');
}
