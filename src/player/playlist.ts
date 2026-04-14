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
import { play, pause, stopAllMedia, getTrackPosition } from './transport.ts';
import { loadAndBroadcastFile, loadPreloadedTrack } from './decode.ts';
import { incrementLoadToken, getCurrentAudioBuffer, setCurrentAudioBuffer } from './_state.ts';
import { getVideoElement } from './video.ts';

import { schedulePreload, cancelPreloadTransfer } from '../storage/preload.ts';
import {
  setEQ, setPreamp, setStereoWidth, setVirtualBass, setReverbParam,
} from '../audio/effects.ts';
import { postWorkerCommand } from '../storage/opfs.ts';
import { broadcast, sendToHost } from '../network/peer.ts';
import { isGuestBlocked } from '../network/guards.ts';
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

  const hostConn = getState('network.hostConn');

  // ─── Fast Path: Host re-clicks currently-playing local file ─────────
  // Skip full reload/rebroadcast/preload-reset. Just reset position to 0
  // and restart after the standard 3s delay. Guests get a FILE_PREPARE
  // with autoPlayDelayMs which routes through their same-file replay
  // branch — no re-download.
  const _currentIdx = getState('playlist.currentTrackIndex');
  const _item = playlist[index];
  const _isSameTrack = index === _currentIdx;
  const _hasAudioLoaded = !!(getCurrentAudioBuffer() || getVideoElement()?.src);
  const _isLocalFileTrack = !!_item && _item.type !== 'youtube' && !!_item.file;

  if (!hostConn && _isSameTrack && _hasAudioLoaded && _isLocalFileTrack) {
    log.debug('[Host] Same-track re-click — fast replay path (no redecode/rebroadcast)');

    const file = _item.file!;
    const sessionId = getState('transfer.currentSessionId') || nextSessionId();
    const isFirstTrackLoad = getState('player.isFirstTrackLoad');
    const autoPlayDelayMs = isFirstTrackLoad ? 0 : 3000;

    // Tell guests via FILE_PREPARE → their same-file branch emits
    // playback:replay-current(delayMs), which defers play(0) accordingly.
    broadcast({
      type: MSG.FILE_PREPARE,
      name: file.name,
      index,
      sessionId,
      mime: file.type,
      autoPlayDelayMs,
    });

    // Reset host position to 0 and wait, mirroring the normal branch's UX
    pause(0);
    setState('player.pausedAt', 0);

    if (isFirstTrackLoad) {
      setState('player.isFirstTrackLoad', false);
    } else {
      showToast(t('toast.playing_in_3s'));
    }

    setManagedTimer('autoPlayTimer', () => {
      play(0);
      broadcast({ type: MSG.PLAY, time: 0, index, name: file.name });
    }, autoPlayDelayMs);

    return;
  }

  // Cancel in-flight preload (only for non-fast-path — fast path preserves
  // the preload cache since the next track is unchanged)
  setState('preload.isPreloading', false);

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
      // Skip stopAllMedia for YouTube→YouTube transitions — loadYouTubeVideo
      // reuses the existing player instance, preserving the iOS user gesture.
      // Destroying the iframe forces a "tap to play" on mobile.
      const isYtToYt = getState('appState') === APP_STATE.PLAYING_YOUTUBE;
      if (!isYtToYt) stopAllMedia({ silent: true }); // suppress IDLE flash — youtube:load follows

      // For Mix playlists (RD...), send the host's cached static ID array
      // instead of the playlistId. YouTube Mixes are personalized per device —
      // sending the raw playlistId makes the guest load a different video order,
      // requiring an expensive reload via _mixReloadedIds. Static IDs avoid that.
      const isMix = typeof item.playlistId === 'string' && (item.playlistId as string).startsWith('RD');
      const subMap = getState('youtube.subItemsMap') || {};
      const hostIds = subMap[item.playlistId as string]?.ids;
      const useStaticIds = isMix && hostIds && hostIds.length > 0;

      const playVideoId = useStaticIds ? null : (item.videoId ?? null);
      const playPlaylistId = useStaticIds ? hostIds : (item.playlistId ?? null);

      broadcast({
        type: MSG.YOUTUBE_PLAY,
        videoId: playVideoId,
        playlistId: playPlaylistId,
        name: item.name || item.title,
        index,
        autoplay: false,
      });

      // Also send YOUTUBE_PLAYLIST_INFO so guests have the sub-items map
      if (hostIds && hostIds.length > 0) {
        const titles = subMap[item.playlistId as string]?.titles || [];
        broadcast({
          type: MSG.YOUTUBE_PLAYLIST_INFO,
          playlistId: item.playlistId as string,
          ids: hostIds,
          titles,
        });
      }

      const isFirstTrackLoad = getState('player.isFirstTrackLoad');
      // If we're already in YouTube mode (YT-to-YT transition via ENDED),
      // this is NOT a first load — always auto-play regardless of the flag.
      const isAlreadyYt = getState('appState') === APP_STATE.PLAYING_YOUTUBE;
      if (isFirstTrackLoad && !isAlreadyYt) {
        setState('player.isFirstTrackLoad', false);
        bus.emit('youtube:load', item.videoId ?? null, item.playlistId ?? null, false, subIndex ?? 0);
        showToast(t('youtube.ready'));
      } else {
        if (isFirstTrackLoad) setState('player.isFirstTrackLoad', false);
        bus.emit('youtube:load', item.videoId ?? null, item.playlistId ?? null, false, subIndex ?? 0);
        showToast(t('youtube.playing_in_3s'));
        setManagedTimer('autoPlayTimer', () => {
          bus.emit('youtube:auto-play');
        }, 1000);
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

    const isFirstTrackLoad = getState('player.isFirstTrackLoad');
    // Tell guests how long the host will wait before actually calling play(0).
    // Guests on the "same-file replay" path use this to defer their own
    // play(0), otherwise they ghost-play for 3s while the host is still
    // waiting on its autoPlayTimer.
    const autoPlayDelayMs = isFirstTrackLoad ? 0 : 3000;

    broadcast({
      type: MSG.FILE_PREPARE,
      name: file.name,
      index,
      sessionId,
      mime: file.type,
      autoPlayDelayMs,
    });
    await loadAndBroadcastFile(file, sessionId, myLoadToken);

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
      }, autoPlayDelayMs);
    }
  }
}

// ─── End Of Playlist Handler ───────────────────────────────────────

/**
 * Uniform cleanup path for "playlist finished, nothing should be selected".
 *
 * Clears track meta, audio buffer, and resets currentTrackIndex to -1 so the
 * UI state ("미디어 없음") is internally consistent with transport state.
 * Broadcasts MSG.PAUSE{endOfPlaylist:true} so guests mirror the reset.
 *
 * Why clear currentAudioBuffer + reset currentTrackIndex:
 * - Before this fix, stopAllMedia left the decoded AudioBuffer resident and
 *   currentTrackIndex still pointed at the last track. Pressing play would
 *   silently resume the last track's audio while the title stayed "미디어
 *   없음" — an inconsistent phantom state. With this cleanup, togglePlay
 *   detects the deselected state (currentTrackIndex === -1) and redirects
 *   to playTrack(0), giving a clean "restart from top" UX.
 */
function handleEndOfPlaylist(reason: string): void {
  log.debug(`[Host] End of playlist: ${reason}. Resetting to deselected state.`);
  stopAllMedia();
  setCurrentAudioBuffer(null);
  setState('player.currentTrackMeta', null);
  setState('playlist.currentTrackIndex', -1);
  setState('player.pausedAt', 0);
  broadcast({ type: MSG.PAUSE, time: 0, endOfPlaylist: true });
  showToast(t('toast.playlist_ended'));
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
  const repeatMode = getState('playlist.repeatMode') || 0;

  // YouTube: Repeat-one restarts current video via auto-sync (before try-next)
  if (currentState === APP_STATE.PLAYING_YOUTUBE && repeatMode === 2) {
    bus.emit('youtube:seek-to', 0);
    return;
  }

  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    let handled = false;
    bus.emit('youtube:try-next-internal', (success: boolean) => { handled = success; });
    if (handled) return;
  }

  const playlist = getState('playlist.items') || [];
  const currentTrackIndex = getState('playlist.currentTrackIndex');
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
        handleEndOfPlaylist('single-track-shuffle');
        return;
      }
      nextIndex = 0;
    } else if (
      nextTrackIndex !== -1 &&
      nextTrackIndex !== currentTrackIndex &&
      nextTrackIndex < playlist.length &&
      // Validate preloaded index still points to the expected track —
      // playlist mutations (remove/reorder) can shift positions.
      playlist[nextTrackIndex] != null
    ) {
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
        handleEndOfPlaylist('sequential-end');
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
    // Mirror host's empty-playlist reset: clear track meta so the title
    // display reverts to "미디어 없음" instead of lingering on the last
    // played track. clearPreviousTrackState doesn't touch player.currentTrackMeta,
    // so we clear it explicitly here.
    setState('player.currentTrackMeta', null);
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

  // Auto-play first added file if nothing is playing AND no track has been
  // selected yet. The `currentIndex < 0` guard prevents a race when multiple
  // files are uploaded sequentially: playTrack(0) sets currentTrackIndex = 0
  // synchronously (line 228), but its async audio decode keeps appState as
  // IDLE until decode + play() complete. Without the guard, each subsequent
  // upload also sees IDLE and calls playTrack(N), overwriting the index to
  // the last uploaded track — so clicking "next" immediately overflows the
  // playlist boundary into handleEndOfPlaylist (currentTrackIndex = -1).
  const currentState = getState('appState');
  const currentIndex = getState('playlist.currentTrackIndex');
  if (currentState === APP_STATE.IDLE && currentIndex < 0) {
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
