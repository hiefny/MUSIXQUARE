/**
 * MUSIXQUARE 3.0 — Playback Engine (Coordinator)
 *
 * Orchestrates: protocol handler registration, bus event wiring.
 * Re-exports all public API from sub-modules.
 *
 * Sub-modules:
 *   _state.ts    — shared module state (leaf node)
 *   transport.ts — play/pause/stop/seek, track position
 *   decode.ts    — file loading, decoding, guest finalization
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, APP_STATE } from '../core/constants.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { getVideoElement } from './video.ts';
import { readFileFromOpfs } from '../storage/opfs.ts';
import { unicastFile } from '../storage/transfer.ts';
import { unicastPreload } from '../storage/preload.ts';
import { broadcast, sendToHost, isRemoteGuest, hasActiveRelay } from '../network/peer.ts';
import { requestGlobalResyncDelayed } from '../network/sync.ts';
import { registerHandlers, verifyOperator } from '../network/protocol.ts';
import { getSurroundSplitter } from '../audio/engine.ts';
import type { DataConnection } from '../types/index.ts';

import {
  getCurrentAudioBuffer,
  getPlayerNode,
  incrementLoadToken,
  getPendingPlayTime, setPendingPlayTime,
  isPlayPreloadedInProgress,
} from './_state.ts';

import {
  play, pause, stopAllMedia,
  getTrackPosition, checkVideoSync, handleEnded,
  skipTime,
} from './transport.ts';

import {
  loadPreloadedTrack,
  clearPreviousTrackState, finalizeGuestFile,
} from './decode.ts';

// ─── Re-exports ────────────────────────────────────────────────────
// All public API re-exported so external imports from './playback.ts' keep working.

export {
  // _state.ts
  getCurrentAudioBuffer, setCurrentAudioBuffer,
  incrementLoadToken, getLoadToken,
  setPendingPlayTime, getPendingPlayTime,
} from './_state.ts';

export {
  // transport.ts
  fmtTime, getTrackPosition, updatePlayState, stopPlayerNode,
  stopAllMedia, play, pause, handleEnded,
  togglePlay, stopPlayback, skipTime, adjustSync, checkVideoSync,
} from './transport.ts';

export {
  // decode.ts
  loadAndBroadcastFile, loadPreloadedTrack,
} from './decode.ts';

// ─── Network Message Handlers ──────────────────────────────────────

function handlePlayMsg(data: Record<string, unknown>): void {
  const time = Number(data.time) || 0;
  const incomingIndex = data.index != null ? Number(data.index) : undefined;

  // Guard: If loadPreloadedTrack is in progress, queue the play time
  if (isPlayPreloadedInProgress()) {
    setPendingPlayTime(time);
    log.debug(`[Guest] Preload in progress, queuing play time: ${time}`);
    return;
  }

  // Index-mismatch recovery: Host sent PLAY for a different track
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  if (incomingIndex !== undefined && incomingIndex !== currentTrackIndex) {
    log.warn(`[Guest] Index mismatch: current=${currentTrackIndex}, play=${incomingIndex}`);
    setPendingPlayTime(time);
    setState('playlist.currentTrackIndex', incomingIndex);
    bus.emit('ui:update-playlist');

    // Check if preloaded track matches
    const nextFileBlob = getState('preload.nextFileBlob');
    const nextTrackIndex = getState('preload.nextTrackIndex');
    if (nextFileBlob && nextTrackIndex === incomingIndex) {
      log.debug(`[Guest] Found preloaded track for index ${incomingIndex}`);
      const newToken = incrementLoadToken();
      loadPreloadedTrack(incomingIndex, newToken);
      return;
    }

    // No preload — request file from host (transport guard)
    if (isRemoteGuest() && !hasActiveRelay()) {
      const playlist = getState('playlist.items') || [];
      const name = playlist[incomingIndex]?.name || '';
      bus.emit('player:metadata-update', {
        type: 'file',
        title: t('toast.same_wifi_file_title'),
        name,
        videoId: null,
        playlistId: null,
      });
      bus.emit('ui:show-loader', false);
      log.info('[Guest] Remote guest — skipping file request (TURN billing prevention)');
      return;
    }
    const playlist = getState('playlist.items') || [];
    const name = playlist[incomingIndex]?.name || '';
    sendToHost({ type: MSG.REQUEST_CURRENT_FILE, name, index: incomingIndex, reason: 'index_mismatch' });
    return;
  }

  // Stale audio guard: verify loaded file matches expected name
  const meta = getState('transfer.meta');
  const playlist = getState('playlist.items') || [];
  const expectedName = (data.name as string) || playlist[currentTrackIndex]?.name || '';
  const loadedName = (meta?.name as string) || '';
  if (expectedName && loadedName && expectedName !== loadedName) {
    log.warn(`[Guest] Stale audio detected: loaded=${loadedName}, expected=${expectedName}`);
    setPendingPlayTime(time);
    return;
  }

  if (getCurrentAudioBuffer() || getVideoElement()?.src) {
    play(time);
  } else {
    // Remote guest: no file will arrive, show guide (transport guard)
    if (isRemoteGuest() && !hasActiveRelay()) {
      const playlist2 = getState('playlist.items') || [];
      bus.emit('player:metadata-update', {
        type: 'file',
        title: t('toast.same_wifi_file_title'),
        name: playlist2[currentTrackIndex]?.name || '',
        videoId: null,
        playlistId: null,
      });
      bus.emit('ui:show-loader', false);
      log.info('[Guest] Remote guest — no file will arrive, showing guide');
      return;
    }
    setPendingPlayTime(time);
    log.debug(`[Guest] Storing pending play time: ${time}`);
  }
}

function handlePauseMsg(data: Record<string, unknown>): void {
  const time = Number(data.time) || 0;
  pause(time);
}

function handleRequestPlay(data: Record<string, unknown>, conn: DataConnection): void {
  // Host handles OP's request to play
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only Host executes

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playback] Rejected request-play from non-OP: ${conn?.peer}`);
    return;
  }

  clearManagedTimer('autoPlayTimer');
  const pausedAt = getState('player.pausedAt') || 0;
  const time = Number(data.time) || pausedAt;
  const currentTrackIndex = getState('playlist.currentTrackIndex');

  play(time);
  broadcast({ type: MSG.PLAY, time, index: currentTrackIndex });
  requestGlobalResyncDelayed();
}

function handleRequestPause(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playback] Rejected request-pause from non-OP: ${conn?.peer}`);
    return;
  }

  clearManagedTimer('autoPlayTimer');
  pause();
  broadcast({ type: MSG.PAUSE, time: getState('player.pausedAt') });
}

function handleRequestSeek(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playback] Rejected request-seek from non-OP: ${conn?.peer}`);
    return;
  }

  const time = Number(data.time) || 0;
  const currentState = getState('appState');
  const currentTrackIndex = getState('playlist.currentTrackIndex');

  // YouTube seek
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    bus.emit('youtube:seek-to', time);
    return;
  }

  if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO) {
    play(time);
    broadcast({ type: MSG.PLAY, time, index: currentTrackIndex });
  } else {
    setState('player.pausedAt', time);
    const videoElement = getVideoElement();
    if (videoElement) try { videoElement.currentTime = time; } catch { /* noop */ }
    broadcast({ type: MSG.PAUSE, time });
  }
  requestGlobalResyncDelayed();
}

function handleRequestSkipTime(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playback] Rejected request-skip-time from non-OP: ${conn?.peer}`);
    return;
  }

  const sec = Number(data.sec) || 0;
  skipTime(sec);
}

// ─── Init ──────────────────────────────────────────────────────────

export function initPlayback(): void {
  registerHandlers({
    [MSG.PLAY]: handlePlayMsg,
    [MSG.PAUSE]: handlePauseMsg,
    [MSG.REQUEST_PLAY]: handleRequestPlay,
    [MSG.REQUEST_PAUSE]: handleRequestPause,
    [MSG.REQUEST_SEEK]: handleRequestSeek,
    [MSG.REQUEST_SKIP_TIME]: handleRequestSkipTime,
  });

  // Video sync timer tick
  bus.on('worker:timer-tick', (id) => {
    if (id === 'video-sync') checkVideoSync();
  });

  // Stop all media (called from youtube player before loading)
  bus.on('player:stop-all-media', () => {
    stopAllMedia();
  });

  // Replay current track from start (repeat-one: guest already has file)
  bus.on('playback:replay-current', () => {
    if (getCurrentAudioBuffer() || getVideoElement()?.src) {
      log.debug('[Guest] Replaying current track from start');
      play(0);
      // Auto-sync 1s later to align with host
      const hostConn = getState('network.hostConn');
      if (hostConn?.open) {
        setManagedTimer('playback-repeat-auto-sync', () => bus.emit('sync:auto-sync'), 1000);
      }
    }
  });

  // Sync: provide current track position via callback pattern
  bus.on('sync:get-position', (callback) => {
    if (typeof callback === 'function') {
      callback(getTrackPosition());
    }
  });

  // Sync: handle sync response from host (apply time + play/pause)
  bus.on('sync:response', (hostTime, isPlaying, oneWayLatency) => {
    const localOffset = getState('sync.localOffset') || 0;
    // oneWayLatency는 extrapolatedTime 계산에 이미 반영됨 (elapsed에서 rtt/2 차감)
    // 여기서 또 더하면 이중 보정 → 게스트가 호스트보다 앞서감
    const compensatedTime = hostTime + localOffset;

    if (isPlaying) {
      if (getCurrentAudioBuffer() || getVideoElement()?.src) {
        play(compensatedTime);
      } else {
        setState('player.pausedAt', compensatedTime);
        log.debug('[Sync] Host playing but no audio data yet, storing position');
      }
    } else {
      if (getPendingPlayTime() !== undefined) {
        setState('player.pausedAt', compensatedTime);
        log.debug('[Sync] Host paused, keeping pending play');
        return;
      }
      stopAllMedia();
      setState('player.pausedAt', compensatedTime);
    }

    const rttLabel = oneWayLatency > 0 ? ` (+${Math.round(oneWayLatency * 1000)}ms ${t('toast.sync_correction')})` : '';
    bus.emit('ui:show-toast', `${t('toast.sync_done')}${rttLabel}`);
  });

  // Disconnect playerNode from surround splitter (called when surround mode turns off)
  bus.on('audio:disconnect-surround', () => {
    const _playerNode = getPlayerNode();
    if (_playerNode) {
      try { _playerNode.disconnect(getSurroundSplitter()!); } catch { /* may not be connected */ }
    }
  });

  // Surround mode toggled during playback: restart at current position
  bus.on('audio:surround-toggled', () => {
    const currentState = getState('appState');
    if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO) {
      play(getTrackPosition());
    }
  });

  // Safety polling: periodically check if track ended (called from UI loop)
  bus.on('player:check-ended', () => {
    handleEnded();
  });

  // Clear previous track state (called from transfer module during track switch)
  bus.on('storage:clear-previous-track', (context) => {
    clearPreviousTrackState(context);
  });

  // OPFS file ready: finalize guest download processing
  bus.on('opfs:file-ready', async (filename, _sessionId, isPreload) => {
    if (isPreload) {
      // Preload files are handled by preload module via storage:preload-file-ready
      bus.emit('storage:preload-file-ready', filename, _sessionId);
      return;
    }

    // Only guest processes OPFS files (Host loads directly)
    const hostConn = getState('network.hostConn');
    if (!hostConn) return;

    const file = await readFileFromOpfs(filename, false);
    if (!file) {
      log.error('[Playback] Failed to read OPFS file:', filename);
      bus.emit('ui:show-loader', false);
      return;
    }

    await finalizeGuestFile(file);
  });

  // Use preloaded track (skip download, decode from preload cache)
  bus.on('storage:use-preloaded', (index, name) => {
    log.debug(`[Playback] Using preloaded track for index: ${index} (${name})`);
    setState('transfer.skipIncomingFile', true);
    setState('transfer.waitingForPreload', true);

    // Try to activate immediately if blob is already available
    const nextFileBlob = getState('preload.nextFileBlob');
    if (nextFileBlob) {
      setState('transfer.waitingForPreload', false);
      const newToken = incrementLoadToken();
      loadPreloadedTrack(index, newToken);
    } else {
      // Blob not ready yet — set watchdog, will be triggered by opfs:file-ready preload path
      log.debug('[Playback] Preload blob not ready yet, waiting...');

      const PRELOAD_WATCHDOG_MS = 10_000;
      setManagedTimer('preload-blob-watchdog', () => {
        if (!getState('transfer.waitingForPreload')) return;
        log.warn('[Preload] Preloaded blob not available within timeout');
        setState('transfer.waitingForPreload', false);
        setState('transfer.skipIncomingFile', false);
        bus.emit('ui:show-loader', false);
        // Fallback: request file from host
        const hostConn = getState('network.hostConn');
        if (hostConn?.open) {
          bus.emit('ui:show-loader', true, t('transfer.file_requesting'));
          sendToHost({
            type: MSG.REQUEST_DATA_RECOVERY,
            nextChunk: 0,
            fileName: name,
            index,
          });
        }
      }, PRELOAD_WATCHDOG_MS);

      // Clear watchdog if blob arrives in time (waitingForPreload set to false)
      const _unsubWatchdog = bus.on('state:transfer.waitingForPreload', (val: unknown) => {
        if (val === false) {
          clearManagedTimer('preload-blob-watchdog');
          _unsubWatchdog();
        }
      });
    }
  });

  // Transfer progress (update loader UI)
  bus.on('storage:transfer-progress', (progress, _total) => {
    bus.emit('ui:show-loader', true, t('toast.receiving_pct', { pct: String(progress) }));
    bus.emit('ui:update-loader', progress);
  });

  // Host: Send playback state + current file to newly connected peer (late-join bootstrap)
  bus.on('network:peer-connected', (conn) => {
    if (!conn?.open) return;

    // Only Host bootstraps guests
    const hostConn = getState('network.hostConn');
    if (hostConn) return;

    const currentState = getState('appState');
    const currentTrackIndex = getState('playlist.currentTrackIndex');
    const playlist = getState('playlist.items') || [];

    // Send current file to late-joining guest (if local file is loaded)
    if (currentTrackIndex >= 0 && playlist[currentTrackIndex]) {
      const item = playlist[currentTrackIndex] as unknown as Record<string, unknown>;
      if (item.type !== 'youtube') {
        const currentFileBlob = getState('files.currentFileBlob');
        const currentSessionId = getState('transfer.currentSessionId');
        if (currentFileBlob) {
          unicastFile(conn, currentFileBlob, 0, currentSessionId)
            .catch((e: unknown) => log.error('[Host] unicastFile for late joiner failed', e));
        }

        // Also send preloaded next track
        const nextFileBlob = getState('preload.nextFileBlob');
        const nextMeta = getState('preload.meta');
        const nextTrackIndex = getState('preload.nextTrackIndex');
        if (nextFileBlob && nextMeta && nextTrackIndex >= 0) {
          const preloadSid = (nextMeta.sessionId as number) || 0;
          unicastPreload(conn, nextFileBlob, nextTrackIndex, preloadSid)
            .catch((e: unknown) => log.error('[Host] unicastPreload for late joiner failed', e));
        }
      }
    }

    // Send playback state (time-sync for late joiners)
    try {
      const nowPos = getTrackPosition();

      if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO) {
        const item = (playlist[currentTrackIndex] as unknown as Record<string, unknown>) || {};
        const itemName = (item.name || (item.file as File | undefined)?.name || null) as string | null;
        conn.send({
          type: MSG.PLAY,
          time: nowPos,
          index: currentTrackIndex,
          name: itemName,
          state: currentState,
          timestamp: Date.now(),
        });
      } else if (currentState !== APP_STATE.PLAYING_YOUTUBE) {
        // IDLE or PAUSED: Send pause to sync position
        conn.send({
          type: MSG.PAUSE,
          time: nowPos,
          index: currentTrackIndex,
          state: currentState,
          timestamp: Date.now(),
        });
      }
      // YouTube state is handled by youtube/player.ts bootstrap
      log.debug('[Playback] Bootstrap: sent playback state to new peer');
    } catch (e) {
      log.warn('[Playback] Bootstrap send failed:', e);
    }
  });

  log.info('[Playback] Engine initialized');
}
