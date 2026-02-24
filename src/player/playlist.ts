/**
 * MUSIXQUARE 2.0 — Playlist Management
 * Extracted from original app.js lines 3456-4062, 4272-4397
 *
 * Manages: playlist array, repeat/shuffle modes, playTrack,
 * playNextTrack, playPrevTrack, clearPreloadState.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, APP_STATE, DEMO_FILE_NAME, DEMO_TITLE } from '../core/constants.ts';
import { nextSessionId } from '../core/session.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import {
  play, stopAllMedia, loadAndBroadcastFile, loadPreloadedTrack,
  getTrackPosition, updatePlayState, incrementLoadToken,
} from './playback.ts';

import { schedulePreload } from '../storage/preload.ts';
import {
  setEQ, setPreamp, setStereoWidth, setVirtualBass, setReverbParam,
} from '../audio/effects.ts';
import { postWorkerCommand } from '../storage/opfs.ts';
import { broadcast } from '../network/peer.ts';
import { requestGlobalResyncDelayed } from '../network/sync.ts';
import { registerHandlers, verifyOperator } from '../network/protocol.ts';
import type { DataConnection, PlaylistItem } from '../types/index.ts';

// ─── Repeat / Shuffle ──────────────────────────────────────────────

export function toggleRepeat(): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  const isOperator = getState<boolean>('network.isOperator');
  if (hostConn && !isOperator) return;
  const repeatMode = getState<number>('playlist.repeatMode') || 0;
  const nextMode = (repeatMode + 1) % 3;
  setRepeatMode(nextMode);

  if (!hostConn) {
    broadcast({ type: MSG.REPEAT_MODE, value: nextMode });
  } else if (isOperator) {
    hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'repeat-mode', value: nextMode });
  }
}

export function setRepeatMode(mode: number, notify = true): void {
  setState('playlist.repeatMode', mode);
  const btn = document.getElementById('btn-repeat');
  if (!btn) return;

  btn.classList.remove('active', 'active-one');
  if (mode === 1) {
    btn.classList.add('active');
    if (notify) bus.emit('ui:show-toast', '반복 재생: 전체');
  } else if (mode === 2) {
    btn.classList.add('active-one');
    if (notify) bus.emit('ui:show-toast', '반복 재생: 한 곡');
  } else {
    if (notify) bus.emit('ui:show-toast', '반복 재생: 끔');
  }
}

export function toggleShuffle(): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  const isOperator = getState<boolean>('network.isOperator');
  if (hostConn && !isOperator) return;
  const isShuffle = getState<boolean>('playlist.isShuffle');
  const nextShuffle = !isShuffle;
  setShuffle(nextShuffle);

  if (!hostConn) {
    broadcast({ type: MSG.SHUFFLE_MODE, value: nextShuffle });
  } else if (isOperator) {
    hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'shuffle-mode', value: nextShuffle });
  }
}

export function setShuffle(enabled: boolean, notify = true): void {
  setState('playlist.isShuffle', enabled);
  const btn = document.getElementById('btn-shuffle');
  if (btn) btn.classList.toggle('active', enabled);
  if (notify) bus.emit('ui:show-toast', enabled ? '셔플: 켜짐' : '셔플: 꺼짐');
}

// ─── Clear Preload State ───────────────────────────────────────────

export function clearPreloadState(): void {
  const nextMeta = getState<Record<string, unknown> | null>('preload.meta');
  const currentTrackIndex = getState<number>('playlist.currentTrackIndex');
  const isNextTrackActive = nextMeta && (Number(nextMeta.index) === currentTrackIndex);

  setState('preload.nextTrackIndex', -1);
  if (!isNextTrackActive) {
    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
  }
  setState('preload.isPreloading', false);

  // Guest side
  postWorkerCommand({ command: 'OPFS_RESET', isPreload: true });
}

// ─── Play Track ────────────────────────────────────────────────────

export async function playTrack(index: number): Promise<void> {
  const playlist = getState<PlaylistItem[]>('playlist.items') || [];
  if (index < 0 || index >= playlist.length) return;

  clearManagedTimer('autoPlayTimer');

  // Cancel in-flight preload
  setState('preload.isPreloading', false);

  const hostConn = getState<DataConnection | null>('network.hostConn');

  // Auto-switch to Play tab (Host only)
  if (!hostConn) bus.emit('ui:switch-tab', 'play');

  const myLoadToken = incrementLoadToken();

  // Check if preloaded
  const nextTrackIndex = getState<number>('preload.nextTrackIndex');
  const nextFileBlob = getState<Blob | null>('preload.nextFileBlob');

  if (index === nextTrackIndex && nextFileBlob && !hostConn) {
    log.debug('[Host] Using Preloaded Track:', index);
    setState('playlist.currentTrackIndex', index);
    bus.emit('ui:update-playlist');
    bus.emit('player:metadata-update', playlist[index]);

    // Advance session ID for recovery
    const nextMeta = getState<Record<string, unknown> | null>('preload.meta');
    if (nextMeta?.sessionId && Number.isFinite(Number(nextMeta.sessionId))) {
      setState('transfer.currentSessionId', Number(nextMeta.sessionId));
    } else {
      setState('transfer.currentSessionId', nextSessionId());
    }

    stopAllMedia();

    const item = playlist[index];
    const fileName = item?.file?.name || item?.name || `Track ${index}`;
    broadcast({ type: MSG.PLAY_PRELOADED, index, name: fileName, mime: item?.file?.type });

    await loadPreloadedTrack(index, myLoadToken);
    await play(0);
    broadcast({ type: MSG.PLAY, time: 0, index, name: fileName });
    requestGlobalResyncDelayed();
    schedulePreload();
    return;
  }

  setState('playlist.currentTrackIndex', index);
  bus.emit('ui:update-playlist');

  const item = playlist[index];
  bus.emit('player:metadata-update', item);

  // YouTube
  if (item.type === 'youtube') {
    if (!hostConn) {
      stopAllMedia();
      broadcast({
        type: MSG.YOUTUBE_PLAY,
        videoId: item.videoId,
        playlistId: item.playlistId,
        name: item.name || item.title,
        index,
        autoplay: false,
      });

      const isFirstTrackLoad = getState<boolean>('player.isFirstTrackLoad');
      if (isFirstTrackLoad) {
        setState('player.isFirstTrackLoad', false);
        bus.emit('youtube:load', item.videoId, item.playlistId, false);
        bus.emit('ui:show-toast', 'YouTube가 준비됐어요! 재생 버튼을 눌러 보세요.');
      } else {
        bus.emit('youtube:load', item.videoId, item.playlistId, false);
        bus.emit('ui:show-toast', '3초 후 YouTube 재생...');
        setManagedTimer('autoPlayTimer', () => {
          bus.emit('youtube:auto-play');
        }, 3000);
      }
    }
    return;
  }

  // Local file playback
  stopAllMedia();

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

    const isFirstTrackLoad = getState<boolean>('player.isFirstTrackLoad');
    if (isFirstTrackLoad) {
      setState('player.isFirstTrackLoad', false);
      bus.emit('ui:show-toast', '파일이 준비됐어요! 재생 버튼을 눌러 보세요.');
    } else {
      bus.emit('ui:show-toast', '3초 후 재생 시작...');
      setManagedTimer('autoPlayTimer', () => {
        play(0);
        const currentIdx = getState<number>('playlist.currentTrackIndex');
        broadcast({ type: MSG.PLAY, time: 0, index: currentIdx, name: file.name });
        requestGlobalResyncDelayed();
      }, 3000);
    }
  }
}

// ─── Play Next Track ───────────────────────────────────────────────

export function playNextTrack(): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  const isOperator = getState<boolean>('network.isOperator');

  if (hostConn && !isOperator) {
    bus.emit('ui:show-toast', '호스트만 조작할 수 있어요');
    return;
  }

  if (hostConn && isOperator) {
    hostConn.send({ type: MSG.REQUEST_NEXT_TRACK });
    return;
  }

  // Host: YouTube internal navigation
  const currentState = getState<string>('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    let handled = false;
    bus.emit('youtube:try-next-internal', (success: boolean) => { handled = success; });
    if (handled) return;
  }

  const playlist = getState<PlaylistItem[]>('playlist.items') || [];
  const currentTrackIndex = getState<number>('playlist.currentTrackIndex');
  const repeatMode = getState<number>('playlist.repeatMode') || 0;
  const isShuffle = getState<boolean>('playlist.isShuffle');
  const nextTrackIndex = getState<number>('preload.nextTrackIndex');

  if (playlist.length === 0) return;

  let nextIndex = -1;

  if (repeatMode === 2) {
    nextIndex = currentTrackIndex;
  } else if (isShuffle) {
    if (playlist.length === 1) {
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
        broadcast({ type: MSG.PAUSE, time: 0 });
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
  const hostConn = getState<DataConnection | null>('network.hostConn');
  const isOperator = getState<boolean>('network.isOperator');

  if (hostConn && !isOperator) {
    bus.emit('ui:show-toast', '호스트만 조작할 수 있어요');
    return;
  }

  if (hostConn && isOperator) {
    hostConn.send({ type: MSG.REQUEST_PREV_TRACK });
    return;
  }

  const currentState = getState<string>('appState');
  const currentTrackIndex = getState<number>('playlist.currentTrackIndex');

  // YouTube mode
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    let handled = false;
    bus.emit('youtube:try-prev-internal', (success: boolean) => { handled = success; });
    if (handled) return;

    if (currentTrackIndex > 0) playTrack(currentTrackIndex - 1);
    else playTrack(0);
    return;
  }

  // Local mode: restart if > 3s, else previous track
  const pos = getTrackPosition();
  if (pos > 3) {
    play(0);
    broadcast({ type: MSG.PLAY, time: 0, index: currentTrackIndex });
    return;
  }

  if (currentTrackIndex > 0) playTrack(currentTrackIndex - 1);
  else playTrack(0);
}

// ─── Network Handlers ──────────────────────────────────────────────

function handleRepeatMode(data: Record<string, unknown>): void {
  setRepeatMode(Number(data.value) || 0);
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
    bus.emit('ui:update-playlist');
    return;
  }
  setState('playlist.items', incoming);

  // Sync current track index from host (late-join bootstrap)
  let idx = getState<number>('playlist.currentTrackIndex');
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

  bus.emit('ui:update-playlist');
}

function handleTrackChange(data: Record<string, unknown>, conn: DataConnection): void {
  // Host handles OP request
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn)) {
    log.warn(`[Playlist] Rejected request-track-change from non-OP: ${conn?.peer}`);
    return;
  }

  const index = Number(data.index);
  const playlist = getState<PlaylistItem[]>('playlist.items') || [];
  if (!Number.isFinite(index) || index < 0 || index >= playlist.length) {
    log.warn(`[Playlist] Invalid track index: ${data.index}`);
    return;
  }
  playTrack(index);
}

function handleRequestNextTrack(_data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn)) {
    log.warn(`[Playlist] Rejected request-next-track from non-OP: ${conn?.peer}`);
    return;
  }
  playNextTrack();
}

function handleRequestPrevTrack(_data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn)) {
    log.warn(`[Playlist] Rejected request-prev-track from non-OP: ${conn?.peer}`);
    return;
  }
  playPrevTrack();
}

function handleRequestSetting(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn)) {
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
      setEQ(band, v);
      broadcast({ type: MSG.EQ_UPDATE, band, value: v });
      break;
    }
    case MSG.PREAMP: {
      const v = parseFloat(String(val));
      setPreamp(v);
      broadcast({ type: MSG.PREAMP, value: v });
      break;
    }
    case 'stereo': {
      const v = Number(val);
      setStereoWidth(v);
      broadcast({ type: MSG.STEREO_WIDTH, value: v });
      break;
    }
    case MSG.VBASS: {
      const v = Number(val);
      setVirtualBass(v);
      broadcast({ type: MSG.VBASS, value: v });
      break;
    }
    case MSG.REVERB: {
      setReverbParam('mix', Number(val));
      broadcast({ type: MSG.REVERB, value: val });
      break;
    }
    case MSG.REVERB_TYPE: {
      // Reverb type preset handled via protocol handler, just broadcast
      broadcast({ type: MSG.REVERB_TYPE, value: val });
      break;
    }
    case MSG.REVERB_DECAY: {
      setReverbParam('decay', Number(val));
      broadcast({ type: MSG.REVERB_DECAY, value: val });
      break;
    }
    case MSG.REVERB_PREDELAY: {
      setReverbParam('predelay', Number(val));
      broadcast({ type: MSG.REVERB_PREDELAY, value: val });
      break;
    }
    case MSG.REVERB_LOWCUT: {
      setReverbParam('lowcut', Number(val));
      broadcast({ type: MSG.REVERB_LOWCUT, value: val });
      break;
    }
    case MSG.REVERB_HIGHCUT: {
      setReverbParam('highcut', Number(val));
      broadcast({ type: MSG.REVERB_HIGHCUT, value: val });
      break;
    }
  }
}

// ─── Load Demo Media ──────────────────────────────────────────────

async function loadDemoMedia(): Promise<void> {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) {
    bus.emit('ui:show-toast', 'Host만 실행할 수 있습니다.');
    return;
  }

  try {
    bus.emit('ui:show-loader', true, '데모 음원 로딩 중...');
    bus.emit('ui:update-loader', 0);

    const blob: Blob = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', DEMO_FILE_NAME, true);
      xhr.responseType = 'blob';

      xhr.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          bus.emit('ui:update-loader', percent);
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
      xhr.send();
    });

    const file = new File([blob], DEMO_FILE_NAME, { type: 'audio/mpeg' });

    const newTrack: PlaylistItem = {
      type: 'file',
      file,
      name: file.name,
      title: DEMO_TITLE,
    };

    const playlist = [...(getState<PlaylistItem[]>('playlist.items') || [])];
    playlist.push(newTrack);
    setState('playlist.items', playlist);
    bus.emit('ui:update-playlist');

    const metaList = playlist.map(item => ({
      type: item.type,
      name: item.name,
      title: item.title || item.name,
      videoId: item.videoId || null,
      playlistId: item.playlistId || null,
    }));
    broadcast({ type: MSG.PLAYLIST_UPDATE, list: metaList });

    bus.emit('ui:show-toast', '데모 음원 로드 완료. 재생을 시작합니다.');
    bus.emit('ui:show-loader', false);

    playTrack(playlist.length - 1);
  } catch (e: unknown) {
    log.error('Demo load failed:', e);
    bus.emit('ui:show-toast', `데모 로드 실패: ${(e as Error).message}`);
    bus.emit('ui:show-loader', false);
  }
}

// ─── Handle Files Selected ────────────────────────────────────────

function handleFilesSelected(files: FileList | null): void {
  if (!files || files.length === 0) return;

  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) {
    bus.emit('ui:show-toast', 'Host만 파일을 추가할 수 있습니다.');
    return;
  }

  const playlist = [...(getState<PlaylistItem[]>('playlist.items') || [])];
  let addedCount = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) continue;

    const newTrack: PlaylistItem = {
      type: 'file',
      file,
      name: file.name,
      title: file.name.replace(/\.[^/.]+$/, ''),
    };
    playlist.push(newTrack);
    addedCount++;
  }

  if (addedCount === 0) return;

  setState('playlist.items', playlist);
  bus.emit('ui:update-playlist');

  const metaList = playlist.map(item => ({
    type: item.type,
    name: item.name,
    title: item.title || item.name,
    videoId: item.videoId || null,
    playlistId: item.playlistId || null,
  }));
  broadcast({ type: MSG.PLAYLIST_UPDATE, list: metaList });

  bus.emit('ui:show-toast', `${addedCount}개 파일 추가됨`);

  // Auto-play first added file if nothing is playing
  const currentState = getState<string>('appState');
  if (currentState === APP_STATE.IDLE) {
    playTrack(playlist.length - addedCount);
  }
}

// ─── Init ──────────────────────────────────────────────────────────

export function initPlaylist(): void {
  registerHandlers({
    [MSG.REPEAT_MODE]: handleRepeatMode,
    [MSG.SHUFFLE_MODE]: handleShuffleMode,
    [MSG.PLAYLIST_UPDATE]: handlePlaylistUpdate,
    [MSG.PLAYLIST]: handlePlaylistUpdate, // Backward-compat alias
    [MSG.REQUEST_TRACK_CHANGE]: handleTrackChange,
    [MSG.REQUEST_NEXT_TRACK]: handleRequestNextTrack,
    [MSG.REQUEST_PREV_TRACK]: handleRequestPrevTrack,
    [MSG.REQUEST_SETTING]: handleRequestSetting,
  });

  // Handle track ended auto-advance
  bus.on('player:ended', () => {
    const hostConn = getState<DataConnection | null>('network.hostConn');
    if (hostConn) return; // Only Host handles

    const repeatMode = getState<number>('playlist.repeatMode') || 0;
    const currentTrackIndex = getState<number>('playlist.currentTrackIndex');

    if (repeatMode === 2) {
      log.debug('Repeat One: Replaying current track...');
      setTimeout(() => playTrack(currentTrackIndex), 300);
    } else {
      log.debug('Auto-advancing to next track...');
      setTimeout(() => playNextTrack(), 500);
    }
  });

  // Handle MediaSession navigation requests
  bus.on('playlist:prev-track', () => playPrevTrack());
  bus.on('playlist:next-track', () => playNextTrack());

  // Silent mode setters (for handleStatusSync — no toast, no broadcast)
  bus.on('playlist:set-repeat-mode', ((...args: unknown[]) => {
    const mode = Number(args[0]) || 0;
    const notify = args[1] !== false;
    setRepeatMode(mode, notify);
  }) as (...args: unknown[]) => void);

  bus.on('playlist:set-shuffle', ((...args: unknown[]) => {
    const notify = args[1] !== false;
    setShuffle(!!args[0], notify);
  }) as (...args: unknown[]) => void);

  // Demo media loading
  bus.on('app:load-demo', ((..._args: unknown[]) => {
    loadDemoMedia();
  }) as (...args: unknown[]) => void);

  // File selection
  bus.on('app:files-selected', ((...args: unknown[]) => {
    handleFilesSelected(args[0] as FileList | null);
  }) as (...args: unknown[]) => void);

  // Play specific track from playlist view click
  bus.on('playlist:play-track', ((...args: unknown[]) => {
    const index = Number(args[0]);
    if (Number.isFinite(index) && index >= 0) playTrack(index);
  }) as (...args: unknown[]) => void);

  // Play preloaded track (from storage/preload after successful preload)
  bus.on('storage:play-preloaded', ((...args: unknown[]) => {
    const index = Number(args[0]);
    if (Number.isFinite(index) && index >= 0) {
      playTrack(index);
    }
  }) as (...args: unknown[]) => void);

  // Host: Send playlist state to newly connected peer (late-join bootstrap)
  bus.on('network:peer-connected', ((...args: unknown[]) => {
    const conn = args[0] as DataConnection | null;
    if (!conn?.open) return;

    // Only Host bootstraps guests
    const hostConn = getState<DataConnection | null>('network.hostConn');
    if (hostConn) return;

    try {
      // Repeat mode
      const repeatMode = getState<number>('playlist.repeatMode') || 0;
      conn.send({ type: MSG.REPEAT_MODE, value: repeatMode });

      // Shuffle mode
      const isShuffle = getState<boolean>('playlist.isShuffle');
      conn.send({ type: MSG.SHUFFLE_MODE, value: isShuffle });

      // Full playlist metadata
      const playlist = getState<PlaylistItem[]>('playlist.items') || [];
      const metaList = playlist.map(item => ({
        type: item.type,
        name: item.name,
        title: item.title || item.name,
        videoId: item.videoId || null,
        playlistId: item.playlistId || null,
      }));
      conn.send({ type: MSG.PLAYLIST_UPDATE, list: metaList });

      log.debug('[Playlist] Bootstrap: sent playlist state to new peer');
    } catch (e) {
      log.warn('[Playlist] Bootstrap send failed:', e);
    }
  }) as (...args: unknown[]) => void);

  log.info('[Playlist] Initialized');
}
