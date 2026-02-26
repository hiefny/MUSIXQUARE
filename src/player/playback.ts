/**
 * MUSIXQUARE 2.0 — Playback Engine
 * Extracted from original app.js lines 4401-5056, 4544-4700, 10470-10607
 *
 * Manages: play/pause/stop/seek, Tone.js BufferSource lifecycle,
 * video sync, track position calculation, file loading/decoding.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, APP_STATE, TRANSFER_STATE } from '../core/constants.ts';
import { clearManagedTimer, getManagedTimer } from '../core/timers.ts';
import { BlobURLManager } from '../core/blob-manager.ts';
import { initAudio, getWidener } from '../audio/engine.ts';
import { getVideoElement, isIdleOrPaused, isMediaVideo, setEngineMode } from './video.ts';
import { postWorkerCommand, cleanupOPFSInWorker, readFileFromOpfs } from '../storage/opfs.ts';
import { broadcastFile, unicastFile } from '../storage/transfer.ts';
import { schedulePreload, unicastPreload } from '../storage/preload.ts';
import { broadcast, sendToHost } from '../network/peer.ts';
import { requestGlobalResyncDelayed } from '../network/sync.ts';
import { registerHandlers, validateMessage, verifyOperator } from '../network/protocol.ts';
import type { DataConnection, PlaylistItem } from '../types/index.ts';

 
declare const Tone: any;
 

// ─── Module-local State ────────────────────────────────────────────

 
let _playerNode: any = null;
let _currentAudioBuffer: AudioBuffer | null = null;
let _currentLoadToken = 0;
let _activeLoadSessionId = 0;
let _isPlayLocked = false;
let _pendingPlayTime: number | undefined;
let _playPreloadedInProgress = false;
let _lastClearedTrackName = '';

// ─── Getters ───────────────────────────────────────────────────────

export function getCurrentAudioBuffer(): AudioBuffer | null {
  return _currentAudioBuffer;
}

export function setCurrentAudioBuffer(buf: AudioBuffer | null): void {
  _currentAudioBuffer = buf;
}

export function incrementLoadToken(): number {
  return ++_currentLoadToken;
}

export function getLoadToken(): number {
  return _currentLoadToken;
}

export function setPendingPlayTime(time: number | undefined): void {
  _pendingPlayTime = time;
}

export function getPendingPlayTime(): number | undefined {
  return _pendingPlayTime;
}

// ─── Format Helpers ────────────────────────────────────────────────

export function fmtTime(s: number): string {
  if (isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

// ─── Track Position ────────────────────────────────────────────────

export function getTrackPosition(): number {
  const currentState = getState<string>('appState');
  const pausedAt = getState<number>('player.pausedAt') || 0;

  if (isIdleOrPaused(currentState)) return pausedAt;

  // YouTube mode: delegated via synchronous callback
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    let ytPos = 0;
    bus.emit('youtube:get-position', (pos: number) => { ytPos = pos; });
    return ytPos;
  }

  const videoElement = getVideoElement();
  const duration = (_currentAudioBuffer && Number.isFinite(_currentAudioBuffer.duration))
    ? _currentAudioBuffer.duration
    : (videoElement && Number.isFinite(videoElement.duration) ? videoElement.duration : 0);

  let pos = 0;
  const startedAt = getState<number>('player.startedAt') || 0;
  const localOffset = getState<number>('sync.localOffset') || 0;
  const autoSyncOffset = getState<number>('sync.autoSyncOffset') || 0;

  const startedAtValid = typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0;
  if (startedAtValid && typeof Tone !== 'undefined' && Tone?.now) {
    pos = (Tone.now() - startedAt) + localOffset + autoSyncOffset;
  } else if (videoElement?.src && videoElement.readyState >= 1) {
    pos = videoElement.currentTime;
  }

  if (isNaN(pos)) pos = 0;
  if (pos < 0) pos = 0;
  if (duration > 0 && pos > duration) pos = duration;

  return pos;
}

// ─── Play State UI ─────────────────────────────────────────────────

export function updatePlayState(playing: boolean): void {
  bus.emit('ui:update-play-state', playing);
}

// ─── Stop Player Node ──────────────────────────────────────────────

export function stopPlayerNode(): void {
  if (_playerNode) {
    try {
      _playerNode.onended = null;
      _playerNode.stop();
      _playerNode.disconnect();
      _playerNode.dispose();
    } catch (e) {
      log.warn('Error stopping/disposing playerNode:', e);
    } finally {
      _playerNode = null;
    }
  }
}

// ─── Stop All Media ────────────────────────────────────────────────

export function stopAllMedia(): void {
  const videoElement = getVideoElement();

  // 1. Stop video
  if (videoElement) {
    videoElement.pause();
    videoElement.removeAttribute('src');
    videoElement.load();
  }

  try { BlobURLManager.revoke(); } catch { /* noop */ }
  try { BlobURLManager.flushDeferred('stopAllMedia'); } catch { /* noop */ }

  // 2. Stop YouTube
  bus.emit('youtube:stop-mode');

  // 3. Clear pending triggers
  clearManagedTimer('preloadScheduleTimer');
  clearManagedTimer('autoPlayTimer');
  _pendingPlayTime = undefined;

  setState('appState', APP_STATE.IDLE);
  bus.emit('player:state-changed', APP_STATE.IDLE);
  updatePlayState(false);

  // Stop background sync timers
  bus.emit('worker:sync-command', { command: 'STOP_TIMER', id: 'video-sync' });

  // Stop player node
  stopPlayerNode();

  // Reset master clock
  setState('player.startedAt', 0);
  setState('player.pausedAt', 0);
}

// ─── Play ──────────────────────────────────────────────────────────

export async function play(offset: number): Promise<void> {
  if (_isPlayLocked) {
    log.warn('[Play] Blocked: queuing play request');
    _pendingPlayTime = offset;
    return;
  }
  _isPlayLocked = true;

  const lockWatchdog = setTimeout(() => {
    if (_isPlayLocked) {
      log.warn('[Play] Lock Timeout: Forcing unlock after 5s');
      _isPlayLocked = false;
    }
  }, 5000);

  try {
    await _internalPlay(offset);
  } finally {
    clearTimeout(lockWatchdog);
    setTimeout(() => { _isPlayLocked = false; }, 10);
  }
}

async function _internalPlay(offset: number): Promise<void> {
  _pendingPlayTime = undefined;

  const currentState = getState<string>('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    log.warn('[Audio] Blocked play() call while in YouTube mode');
    return;
  }

  if (typeof Tone === 'undefined' || !Tone?.context) {
    log.error('[Audio] Tone.js not loaded');
    bus.emit('ui:show-toast', '오디오 엔진이 아직 준비되지 않았어요.');
    return;
  }

  if (Tone.context.state !== 'running') {
    try { await Tone.context.resume(); } catch (e) { log.warn('Resume failed:', e); }
  }

  const videoElement = getVideoElement();
  const hasVideoSource = !!(videoElement?.src?.startsWith('blob:'));
  const hasBufferSource = !!_currentAudioBuffer;

  if (!hasVideoSource && !hasBufferSource) {
    log.warn('[Play] No media source available');
    return;
  }

  try {
    await initAudio();
  } catch (e) {
    log.error('[Audio] initAudio failed:', e);
    bus.emit('ui:show-toast', '오디오 엔진을 준비하지 못했어요');
    return;
  }

  // Sanitize offset
  let safeOffset = Number(offset);
  if (!Number.isFinite(safeOffset) || safeOffset < 0) safeOffset = 0;
  const duration = (_currentAudioBuffer && Number.isFinite(_currentAudioBuffer.duration))
    ? _currentAudioBuffer.duration
    : (videoElement && Number.isFinite(videoElement.duration) ? videoElement.duration : 0);
  if (duration > 0) {
    if (safeOffset > duration) safeOffset = duration;
    if (safeOffset === duration) safeOffset = Math.max(0, duration - 0.001);
  }

  // Buffer Mode playback
  if (_currentAudioBuffer) {
    stopPlayerNode();
    _playerNode = new Tone.BufferSource(_currentAudioBuffer);

    const isSurroundMode = getState<boolean>('audio.isSurroundMode');
    const surroundChannelIndex = getState<number>('audio.surroundChannelIndex');

    if (isSurroundMode) {
      bus.emit('audio:connect-surround', _playerNode, surroundChannelIndex);
      log.debug(`[BufferMode] Playing in 7.1 Surround (Ch: ${surroundChannelIndex})`);
    } else {
      const widener = getWidener();
      if (widener) _playerNode.connect(widener);
      log.debug('[BufferMode] Playing in Stereo');
    }

    const endedToken = _currentLoadToken;
    _playerNode.onended = () => {
      if (endedToken !== _currentLoadToken) return;
      const state = getState<string>('appState');
      if (state === APP_STATE.PLAYING_AUDIO || state === APP_STATE.PLAYING_VIDEO) {
        handleEnded();
      }
    };

    _playerNode.start(Tone.now(), safeOffset);

    // Sync visuals (muted video)
    if (videoElement?.src) {
      videoElement.currentTime = safeOffset;
      videoElement.muted = true;
      videoElement.volume = 0;
      videoElement.play().catch(() => { /* noop */ });
    }
  }

  // Update timing
  const localOffset = getState<number>('sync.localOffset') || 0;
  const autoSyncOffset = getState<number>('sync.autoSyncOffset') || 0;
  const startedAt = Tone.now() - (safeOffset - (localOffset + autoSyncOffset));
  setState('player.startedAt', startedAt);
  setState('player.pausedAt', safeOffset);
  log.debug(`[BufferMode] Started at ${safeOffset}s (startedAt: ${startedAt})`);

  updatePlayState(true);

  const meta = getState<Record<string, unknown>>('transfer.meta');
  const currentFileBlob = getState<Blob | null>('files.currentFileBlob');
  const isVideo = isMediaVideo(currentFileBlob, meta);
  const newState = isVideo ? APP_STATE.PLAYING_VIDEO : APP_STATE.PLAYING_AUDIO;
  setState('appState', newState);
  bus.emit('player:state-changed', newState);

  bus.emit('visualizer:start');
  if (isVideo) {
    bus.emit('worker:sync-command', { command: 'START_TIMER', id: 'video-sync', interval: 2000 });
  }
  bus.emit('ui:loop-start');
}

// ─── Pause ─────────────────────────────────────────────────────────

export function pause(forcedTime?: number): void {
  const currentState = getState<string>('appState');
  if (isIdleOrPaused(currentState)) return;

  let pausePos: number;
  if (typeof forcedTime === 'number' && isFinite(forcedTime) && forcedTime >= 0) {
    pausePos = forcedTime;
  } else {
    pausePos = getTrackPosition();
  }

  stopPlayerNode();

  const videoElement = getVideoElement();
  if (videoElement) {
    try { videoElement.pause(); } catch { /* noop */ }
    try { videoElement.currentTime = pausePos; } catch { /* noop */ }
  }

  setState('appState', APP_STATE.PAUSED);
  setState('player.pausedAt', pausePos);
  bus.emit('player:state-changed', APP_STATE.PAUSED);
  updatePlayState(false);
  bus.emit('ui:show-toast', '일시정지');
  bus.emit('worker:sync-command', { command: 'STOP_TIMER', id: 'video-sync' });
}

// ─── Handle Track Ended ────────────────────────────────────────────

function handleEnded(): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) return; // Guests don't handle track-end

  const currentState = getState<string>('appState');
  const videoElement = getVideoElement();

  const hasBufferDuration = !!(_currentAudioBuffer &&
    Number.isFinite(_currentAudioBuffer.duration) && _currentAudioBuffer.duration > 0.5);

  const usesVideoElement = currentState === APP_STATE.PLAYING_VIDEO || currentState === APP_STATE.PLAYING_AUDIO;
  if (!hasBufferDuration && usesVideoElement && videoElement && videoElement.readyState < 1) return;

  const duration = hasBufferDuration
    ? _currentAudioBuffer!.duration
    : (videoElement ? videoElement.duration : 0);

  if (!duration || !Number.isFinite(duration) || duration <= 0.5) return;
  if (isIdleOrPaused(currentState)) return;
  if (currentState === APP_STATE.PLAYING_YOUTUBE) return;

  const curr = getTrackPosition();
  const isSeeking = getState<boolean>('player.isSeeking');
  if (isSeeking) {
    log.debug('[handleEnded] Ignoring end signal while seeking');
    return;
  }

  if (curr >= duration - 0.2) {
    log.debug(`Track ended at ${curr.toFixed(2)}s / ${duration.toFixed(2)}s`);
    stopAllMedia();
    setState('player.pausedAt', 0);
    bus.emit('ui:seek-reset');

    // Auto-advance via playlist module
    bus.emit('player:ended');
  }
}

// ─── Toggle Play ───────────────────────────────────────────────────

export function togglePlay(): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  const isOperator = getState<boolean>('network.isOperator');
  if (hostConn && !isOperator) {
    bus.emit('ui:show-toast', '호스트만 조작할 수 있어요');
    return;
  }

  const currentState = getState<string>('appState');

  // YouTube mode
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    bus.emit('youtube:toggle-play');
    return;
  }

  const isActuallyPlaying = currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO;
  const pausedAt = getState<number>('player.pausedAt') || 0;
  const currentTrackIndex = getState<number>('playlist.currentTrackIndex');

  // Cancel pending auto-play (with user feedback)
  if (!hostConn && getManagedTimer('autoPlayTimer')) {
    clearManagedTimer('autoPlayTimer');
    bus.emit('ui:show-toast', '자동 재생을 취소했어요');
  }

  if (isActuallyPlaying) {
    if (!hostConn) {
      pause();
      broadcast({ type: MSG.PAUSE, time: getState<number>('player.pausedAt') });
    } else if (isOperator) {
      sendToHost({ type: MSG.REQUEST_PAUSE });
    }
  } else {
    if (!hostConn) {
      play(pausedAt);
      broadcast({ type: MSG.PLAY, time: pausedAt, index: currentTrackIndex });
      requestGlobalResyncDelayed();
    } else if (isOperator) {
      sendToHost({ type: MSG.REQUEST_PLAY, time: pausedAt });
    }
  }
}

// ─── Stop Playback ─────────────────────────────────────────────────

export function stopPlayback(): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  const isOperator = getState<boolean>('network.isOperator');

  if (hostConn && !isOperator) {
    bus.emit('ui:show-toast', '호스트만 조작할 수 있어요');
    return;
  }

  if (hostConn && isOperator) {
    try { hostConn.send({ type: MSG.REQUEST_SEEK, time: 0 }); } catch { /* noop */ }
    try { hostConn.send({ type: MSG.REQUEST_PAUSE }); } catch { /* noop */ }
    bus.emit('ui:show-toast', '정지 요청을 보냈어요');
    return;
  }

  const currentState = getState<string>('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    bus.emit('youtube:stop-playback');
    setState('player.pausedAt', 0);
    updatePlayState(false);
    return;
  }

  stopAllMedia();
  bus.emit('ui:seek-reset');

  if (!hostConn) broadcast({ type: MSG.PAUSE, time: 0 });
  bus.emit('ui:show-toast', '정지');
}

// ─── Skip Time ─────────────────────────────────────────────────────

export function skipTime(sec: number): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  const isOperator = getState<boolean>('network.isOperator');

  if (hostConn && !isOperator) {
    bus.emit('ui:show-toast', '호스트만 조작할 수 있어요');
    return;
  }

  if (hostConn && isOperator) {
    sendToHost({ type: MSG.REQUEST_SKIP_TIME, sec });
    return;
  }

  const currentState = getState<string>('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    bus.emit('youtube:skip-time', sec);
    return;
  }

  const current = getTrackPosition();
  let target = current + sec;
  const videoElement = getVideoElement();
  const duration = (_currentAudioBuffer?.duration)
    ?? (videoElement && isFinite(videoElement.duration) ? videoElement.duration : 0);

  if (target < 0) target = 0;
  if (duration > 0 && target > duration) target = Math.max(0, duration - 0.001);

  const currentTrackIndex = getState<number>('playlist.currentTrackIndex');
  const isPlaying = currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO;

  if (isPlaying) {
    play(target);
    broadcast({ type: MSG.PLAY, time: target, index: currentTrackIndex });
    requestGlobalResyncDelayed();
  } else {
    setState('player.pausedAt', target);
    broadcast({ type: MSG.PAUSE, time: target });
  }
}

// ─── Adjust Sync ───────────────────────────────────────────────────

export function adjustSync(val: number): void {
  const localOffset = getState<number>('sync.localOffset') || 0;
  setState('sync.localOffset', localOffset + val);
  bus.emit('sync:display-update');

  const currentState = getState<string>('appState');
  if (!isIdleOrPaused(currentState)) {
    play(getTrackPosition());
  } else {
    const pausedAt = getState<number>('player.pausedAt') || 0;
    setState('player.pausedAt', pausedAt + val);
  }
}

// ─── Check Video Sync ──────────────────────────────────────────────

export function checkVideoSync(): void {
  const currentState = getState<string>('appState');
  if (isIdleOrPaused(currentState) || currentState === APP_STATE.PLAYING_YOUTUBE) return;

  const videoElement = getVideoElement();
  if (!videoElement?.src) return;

  const targetTime = getTrackPosition();
  const actualTime = videoElement.currentTime;
  const drift = Math.abs(actualTime - targetTime);

  if (drift > 0.3) {
    if (videoElement.seeking) return;
    log.debug(`[SyncCheck] Correcting video drift: ${drift.toFixed(3)}s`);

    if (drift >= 1.9 && videoElement.paused) {
      log.warn('[SyncCheck] Video appears frozen. Attempting kickstart...');
      videoElement.play().catch(() => { /* noop */ });
    }

    videoElement.currentTime = targetTime;
  }
}

// ─── Load And Broadcast File (Host) ────────────────────────────────

export async function loadAndBroadcastFile(
  file: File,
  sessionId: number | null = null,
  _skipTabSync = false,
  loadToken?: number,
): Promise<void> {
  _activeLoadSessionId++;
  const myLoadId = _activeLoadSessionId;
  const myToken = loadToken ?? _currentLoadToken;

  bus.emit('ui:show-loader', true, `준비 중: ${file.name}`);
  stopAllMedia();

  try {
    await initAudio();
    if (Tone.context.state === 'suspended') await Tone.start();

    const url = BlobURLManager.create(file) || '';
    setState('files.currentFileBlob', file);

    log.debug('[BufferMode] Decoding audio for high-precision sync...');
    bus.emit('ui:show-toast', '고정밀 동기화: 오디오를 준비하고 있어요…');

    // Decode audio
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await Tone.context.decodeAudioData(arrayBuffer);

    // Re-verify after async decode
    if (loadToken !== undefined && _currentLoadToken !== myToken) {
      if (myLoadId === _activeLoadSessionId) {
        log.warn('[Load] Token mismatch after decode. Aborting stale load.');
        bus.emit('ui:show-loader', false);
      }
      return;
    }

    // Dispose old buffer
    if (_currentAudioBuffer) {
      _currentAudioBuffer = null;
    }

    if (myLoadId !== _activeLoadSessionId) {
      log.debug('[Load] Stale loading session detected. Aborting.');
      return;
    }

    // Load into state
    _currentAudioBuffer = audioBuffer;
    log.debug(`[BufferMode] Loaded ${audioBuffer.duration.toFixed(2)}s into RAM.`);

    // Emit duration immediately from decoded buffer (primary source)
    if (audioBuffer.duration && isFinite(audioBuffer.duration)) {
      bus.emit('ui:duration-update', audioBuffer.duration);
    }

    // Visual sync
    const videoElement = getVideoElement();
    if (videoElement) {
      videoElement.src = url;
      videoElement.muted = true;
    }

    const currentTrackIndex = getState<number>('playlist.currentTrackIndex');
    setState('transfer.meta', { name: file.name, type: file.type, index: currentTrackIndex });

    bus.emit('ui:update-playlist');

    if (videoElement) {
      const onMetaLoaded = () => {
        videoElement.removeEventListener('loadedmetadata', onMetaLoaded);
        if (myLoadId !== _activeLoadSessionId) return;
        const dur = _currentAudioBuffer ? _currentAudioBuffer.duration : videoElement.duration;
        if (dur && isFinite(dur)) {
          bus.emit('ui:duration-update', dur);
        }
        BlobURLManager.confirm();
      };
      videoElement.addEventListener('loadedmetadata', onMetaLoaded);
      videoElement.load();
    }

    // Enable play button
    const hostConn = getState<DataConnection | null>('network.hostConn');
    const isOperator = getState<boolean>('network.isOperator');
    bus.emit('ui:play-btn-state', !(hostConn && !isOperator));

    // Broadcast file to peers
    const connectedPeers = getState<unknown[]>('network.connectedPeers') || [];
    if (connectedPeers.length > 0 && sessionId) {
      bus.emit('ui:show-toast', '파일을 보내고 있어요…');
      broadcastFile(file, sessionId);
    }

    if (!hostConn) {
      schedulePreload();
    }
  } catch (err: unknown) {
    log.error(err);
    bus.emit('ui:show-toast', `Load Failed: ${(err as Error).message}`);
  } finally {
    if (myLoadId === _activeLoadSessionId) {
      bus.emit('ui:show-loader', false);
      setState('player.pausedAt', 0);
      updatePlayState(false);
    }

    const hostConn = getState<DataConnection | null>('network.hostConn');
    const isOperator = getState<boolean>('network.isOperator');
    bus.emit('ui:play-btn-state', !hostConn || isOperator);
  }
}

// ─── Load Preloaded Track ──────────────────────────────────────────

export async function loadPreloadedTrack(
  expectedIndex?: number,
  loadToken?: number,
): Promise<void> {
  const nextMeta = getState<Record<string, unknown> | null>('preload.meta');
  const currentTrackIndex = getState<number>('playlist.currentTrackIndex');
  const targetIndex = expectedIndex ?? (nextMeta?.index as number) ?? currentTrackIndex;
  const myToken = loadToken ?? _currentLoadToken;
  const localBlob = getState<Blob | null>('preload.nextFileBlob');
  const localMeta = nextMeta ? { ...nextMeta } : null;

  if (!localBlob) {
    log.warn('[Preload] No preloaded blob found in cache!');
    return;
  }

  _playPreloadedInProgress = true;

  try {
    await initAudio();

    if (expectedIndex !== undefined && currentTrackIndex !== -1 && currentTrackIndex !== targetIndex) {
      log.warn(`[Preload] Index mismatch! Expected ${targetIndex}, current is ${currentTrackIndex}. Aborting.`);
      _pendingPlayTime = undefined;
      return;
    }

    // Dispose old buffer
    if (_currentAudioBuffer) {
      _currentAudioBuffer = null;
    }

    log.debug('[Preload] Decoding audio for Buffer Mode...');
    bus.emit('ui:show-toast', '오디오 디코딩 중...');

    const arrayBuffer = await localBlob.arrayBuffer();
    const audioBuffer = await Tone.context.decodeAudioData(arrayBuffer);

    // Re-verify after async decode
    if (loadToken !== undefined && _currentLoadToken !== myToken) {
      log.warn('[Preload] Token mismatch after decode. Discarding.');
      return;
    }
    if (expectedIndex !== undefined && currentTrackIndex !== -1 &&
        getState<number>('playlist.currentTrackIndex') !== targetIndex) {
      log.warn('[Preload] Track changed during decode. Discarding.');
      return;
    }

    const activeMeta = localMeta || getState<Record<string, unknown>>('transfer.meta');

    // Update global state
    setState('files.currentFileBlob', localBlob);
    setState('transfer.meta', activeMeta);
    _currentAudioBuffer = audioBuffer;
    log.debug(`[BufferMode] Preloaded ${audioBuffer.duration.toFixed(2)}s decoded.`);

    const isVideo = isMediaVideo(localBlob, activeMeta);
    setEngineMode(isVideo ? 'video' : 'buffer');

    // Visual sync
    const url = BlobURLManager.create(localBlob) || '';
    const videoElement = getVideoElement();
    if (videoElement) {
      videoElement.src = url;
      videoElement.muted = true;
    }

    const dur = audioBuffer.duration;
    if (isFinite(dur)) {
      bus.emit('ui:duration-update', dur);
    }
    BlobURLManager.confirm();

    if (videoElement) videoElement.load();

    // Clear preload state
    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    setState('preload.nextTrackIndex', -1);
    log.debug('[Preload] Safe clear: nextFileBlob moved to current.');

    // Reset transfer guards
    setState('transfer.skipIncomingFile', true);
    setState('transfer.waitingForPreload', false);
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');
    clearManagedTimer('preloadWatchdog');

    // Request sync from host after settle
    const hostConn = getState<DataConnection | null>('network.hostConn');
    if (hostConn?.open) {
      setTimeout(() => {
        sendToHost({ type: MSG.GET_SYNC_TIME });
      }, 500);
    }

    _playPreloadedInProgress = false;

    // Consume pending play time
    const localOffset = getState<number>('sync.localOffset') || 0;
    const autoSyncOffset = getState<number>('sync.autoSyncOffset') || 0;
    if (hostConn && _pendingPlayTime !== undefined) {
      const target = _pendingPlayTime + localOffset + autoSyncOffset;
      log.debug(`[Preload] Found pending play time, starting at ${target.toFixed(2)}s`);
      play(target);
      _pendingPlayTime = undefined;
    }

  } catch (e: unknown) {
    _playPreloadedInProgress = false;
    log.error('[Preload] Activation failed:', e);
    bus.emit('ui:show-toast', '프리로드 재생 실패 - 다시 로드합니다');

    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    setState('preload.nextTrackIndex', -1);
    setState('transfer.skipIncomingFile', false);
    setState('transfer.waitingForPreload', false);
    clearManagedTimer('preloadWatchdog');

    // Request recovery from host
    const playlist = getState<unknown[]>('playlist.items') || [];
    const meta = getState<Record<string, unknown>>('transfer.meta');
    const idx = getState<number>('playlist.currentTrackIndex');
    const name = (playlist[idx] as Record<string, string>)?.name || (meta?.name as string) || '';
    sendToHost({ type: MSG.REQUEST_CURRENT_FILE, name, index: idx, reason: 'preload_activation_failed' });
  }
}

// ─── Network Message Handlers ──────────────────────────────────────

function handlePlayMsg(data: Record<string, unknown>): void {
  const time = Number(data.time) || 0;
  const incomingIndex = data.index as number | undefined;

  // Guard: If loadPreloadedTrack is in progress, queue the play time
  if (_playPreloadedInProgress) {
    _pendingPlayTime = time;
    log.debug(`[Guest] Preload in progress, queuing play time: ${time}`);
    return;
  }

  // Index-mismatch recovery: Host sent PLAY for a different track
  const currentTrackIndex = getState<number>('playlist.currentTrackIndex');
  if (incomingIndex !== undefined && incomingIndex !== currentTrackIndex) {
    log.warn(`[Guest] Index mismatch: current=${currentTrackIndex}, play=${incomingIndex}`);
    _pendingPlayTime = time;
    setState('playlist.currentTrackIndex', incomingIndex);
    bus.emit('ui:update-playlist');

    // Check if preloaded track matches
    const nextFileBlob = getState<Blob | null>('preload.nextFileBlob');
    const nextTrackIndex = getState<number>('preload.nextTrackIndex');
    if (nextFileBlob && nextTrackIndex === incomingIndex) {
      log.debug(`[Guest] Found preloaded track for index ${incomingIndex}`);
      _currentLoadToken++;
      loadPreloadedTrack(incomingIndex, _currentLoadToken);
      return;
    }

    // No preload — request file from host
    const playlist = getState<PlaylistItem[]>('playlist.items') || [];
    const name = playlist[incomingIndex]?.name || '';
    sendToHost({ type: MSG.REQUEST_CURRENT_FILE, name, index: incomingIndex, reason: 'index_mismatch' });
    return;
  }

  // Stale audio guard: verify loaded file matches expected name
  const meta = getState<Record<string, unknown>>('transfer.meta');
  const playlist = getState<PlaylistItem[]>('playlist.items') || [];
  const expectedName = (data.name as string) || playlist[currentTrackIndex]?.name || '';
  const loadedName = (meta?.name as string) || '';
  if (expectedName && loadedName && expectedName !== loadedName) {
    log.warn(`[Guest] Stale audio detected: loaded=${loadedName}, expected=${expectedName}`);
    _pendingPlayTime = time;
    return;
  }

  if (_currentAudioBuffer || getVideoElement()?.src) {
    play(time);
  } else {
    _pendingPlayTime = time;
    log.debug(`[Guest] Storing pending play time: ${time}`);
  }
}

function handlePauseMsg(data: Record<string, unknown>): void {
  const time = Number(data.time) || 0;
  pause(time);
}

function handleRequestPlay(data: Record<string, unknown>, conn: DataConnection): void {
  // Host handles OP's request to play
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) return; // Only Host executes

  if (!verifyOperator(conn)) {
    log.warn(`[Playback] Rejected request-play from non-OP: ${conn?.peer}`);
    return;
  }

  clearManagedTimer('autoPlayTimer');
  const pausedAt = getState<number>('player.pausedAt') || 0;
  const time = Number(data.time) || pausedAt;
  const currentTrackIndex = getState<number>('playlist.currentTrackIndex');

  play(time);
  broadcast({ type: MSG.PLAY, time, index: currentTrackIndex });
  requestGlobalResyncDelayed();
}

function handleRequestPause(_data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn)) {
    log.warn(`[Playback] Rejected request-pause from non-OP: ${conn?.peer}`);
    return;
  }

  clearManagedTimer('autoPlayTimer');
  pause();
  broadcast({ type: MSG.PAUSE, time: getState<number>('player.pausedAt') });
}

function handleRequestSeek(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn)) {
    log.warn(`[Playback] Rejected request-seek from non-OP: ${conn?.peer}`);
    return;
  }

  const time = Number(data.time) || 0;
  const currentState = getState<string>('appState');
  const currentTrackIndex = getState<number>('playlist.currentTrackIndex');

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
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn)) {
    log.warn(`[Playback] Rejected request-skip-time from non-OP: ${conn?.peer}`);
    return;
  }

  const sec = Number(data.sec) || 0;
  skipTime(sec);
}

function handleForceSyncPlay(data: Record<string, unknown>): void {
  const t = Number(data.time) || 0;
  bus.emit('ui:show-toast', `Host 강제 동기화: ${fmtTime(t)}`);
  play(t);
}

// ─── Status Sync (Late Joiner / Reconnect Full State Sync) ─────────

async function handleStatusSync(data: Record<string, unknown>): Promise<void> {
  if (!validateMessage(data, ['playlistMeta', 'currentTrackIndex'])) return;

  const playlistMeta = data.playlistMeta as Array<Record<string, unknown>>;
  const hostTrackIndex = Number(data.currentTrackIndex);
  const currentState = getState<string>('appState');
  const playlist = getState<PlaylistItem[]>('playlist.items') || [];

  // Empty playlist — clear local state
  if (!playlistMeta || playlistMeta.length === 0) {
    if (playlist.length === 0 && currentState === APP_STATE.IDLE) return;
    log.debug('[StatusSync] Received empty playlist, clearing local state');
    setState('playlist.items', []);
    setState('playlist.currentTrackIndex', -1);
    bus.emit('ui:update-playlist');
    stopAllMedia();
    return;
  }

  // Sync repeat/shuffle modes (silent = no toast)
  if (data.repeatMode !== undefined) {
    const current = getState<number>('playlist.repeatMode') || 0;
    if (Number(data.repeatMode) !== current) {
      bus.emit('playlist:set-repeat-mode', Number(data.repeatMode), false);
    }
  }
  if (data.isShuffle !== undefined) {
    const current = getState<boolean>('playlist.isShuffle');
    if (!!data.isShuffle !== current) {
      bus.emit('playlist:set-shuffle', !!data.isShuffle, false);
    }
  }

  // Sync playlist structure if different
  const isPlaylistDifferent = playlist.length !== playlistMeta.length ||
    playlist.some((it, i) => it.name !== (playlistMeta[i]?.name as string));
  if (isPlaylistDifferent) {
    log.debug('[StatusSync] Playlist out of sync, updating...');
    setState('playlist.items', playlistMeta as unknown as PlaylistItem[]);
    bus.emit('ui:update-playlist');
  }

  // Sync track index — trigger recovery if needed
  const currentTrackIndex = getState<number>('playlist.currentTrackIndex');
  if (hostTrackIndex !== -1 && hostTrackIndex !== currentTrackIndex) {
    log.debug(`[StatusSync] Index mismatch: Host(${hostTrackIndex}) vs Me(${currentTrackIndex}). Correcting...`);

    stopAllMedia();
    setState('playlist.currentTrackIndex', hostTrackIndex);
    bus.emit('ui:update-playlist');

    const updatedPlaylist = getState<PlaylistItem[]>('playlist.items') || [];
    const item = updatedPlaylist[hostTrackIndex];

    if (item && item.type !== 'youtube') {
      const currentFileBlob = getState<Blob | null>('files.currentFileBlob');
      const hasBlob = !!(currentFileBlob && currentFileBlob.size > 0);
      const nextFileBlob = getState<Blob | null>('preload.nextFileBlob');
      const nextMeta = getState<Record<string, unknown> | null>('preload.meta');
      const isPreloaded = !!(nextFileBlob && nextMeta &&
        ((nextMeta.index as number) === hostTrackIndex || (nextMeta.name as string) === item.name));

      // If preloaded, use immediately
      if (!hasBlob && isPreloaded) {
        log.debug('[StatusSync] Required track found in preload cache. Activating...');
        _currentLoadToken++;
        await loadPreloadedTrack(hostTrackIndex, _currentLoadToken);
        return;
      }

      // Track missing — request recovery from host
      const meta = getState<Record<string, unknown>>('transfer.meta');
      const isWrongBlob = hasBlob && meta && (meta.name as string) !== item.name;
      if (!hasBlob || isWrongBlob) {
        log.debug('[StatusSync] Current track missing, requesting from host:', item.name);
        bus.emit('ui:show-loader', true, `파일 동기화 중: ${item.name}`);

        if (currentState === APP_STATE.PLAYING_YOUTUBE) {
          bus.emit('youtube:stop-mode');
        }

        const hostConn = getState<DataConnection | null>('network.hostConn');
        if (hostConn?.open) {
          const jitter = Math.random() * 1000 + 200;
          setTimeout(() => {
            const alreadyGotIt = getState<Blob | null>('files.currentFileBlob') ||
              getState<Blob | null>('preload.nextFileBlob');
            const idx = getState<number>('playlist.currentTrackIndex');
            if (idx === hostTrackIndex && !alreadyGotIt) {
              sendToHost({
                type: MSG.REQUEST_DATA_RECOVERY,
                nextChunk: 0,
                fileName: item.name,
                index: hostTrackIndex,
              });
            } else if (alreadyGotIt) {
              log.debug('[StatusSync] Aborting recovery: file arrived during jitter');
              bus.emit('ui:show-loader', false);
            }
          }, jitter);
        }
      }
    } else if (item && item.type === 'youtube') {
      if (currentState !== APP_STATE.PLAYING_YOUTUBE && item.videoId) {
        log.debug('[StatusSync] Switching to YouTube mode for late-joiner sync');
        bus.emit('youtube:load', item.videoId, item.playlistId || null, true, 0);
      }
    }
  }
}

// ─── Clear Previous Track State ────────────────────────────────────

function clearPreviousTrackState(reason = ''): void {
  log.debug(`[State Clear] Clearing previous track state. Reason: ${reason}`);

  // Edge Case: skip redundant clears for same track
  const playlist = getState<PlaylistItem[]>('playlist.items') || [];
  const currentTrackIndex = getState<number>('playlist.currentTrackIndex');
  const meta = getState<Record<string, unknown>>('transfer.meta');
  const trackName = playlist[currentTrackIndex]?.name || (meta?.name as string) || '';
  if (reason === 'redundant-sync' && trackName && _lastClearedTrackName === trackName) {
    log.debug(`[State Clear] Skipping redundant clear for: ${trackName}`);
    return;
  }
  _lastClearedTrackName = trackName;

  // Stop timers
  clearManagedTimer('chunkWatchdog');
  clearManagedTimer('prepareWatchdog');

  // Reset transfer state
  setState('transfer.receivedCount', 0);
  setState('transfer.meta', {});
  setState('files.currentFileBlob', null);

  if (reason === 'redundant-sync') return;

  // CRITICAL: Clear audio buffer to prevent previous track from replaying
  if (_currentAudioBuffer) {
    log.debug('[State Clear] Clearing currentAudioBuffer');
    _currentAudioBuffer = null;
  }
  stopPlayerNode();
  setState('transfer.skipIncomingFile', false);
  _pendingPlayTime = undefined;

  // Reset state to IDLE
  const currentState = getState<string>('appState');
  if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO || currentState === APP_STATE.PAUSED) {
    setState('appState', APP_STATE.IDLE);
    bus.emit('player:state-changed', APP_STATE.IDLE);
  }

  // Clear preload ack tracking
  const ackSent = getState<Set<number>>('preload.ackSent');
  if (ackSent) ackSent.clear();

  BlobURLManager.revoke();

  const videoElement = getVideoElement();
  if (videoElement) {
    videoElement.pause();
    videoElement.src = '';
    videoElement.load();
  }
  try { BlobURLManager.flushDeferred('clearPreviousTrackState'); } catch { /* noop */ }

  // Physically delete OLD current file from OPFS
  const opfsFilename = getState<{ name: string | null }>('files.currentFileOpfs');
  if (opfsFilename.name) {
    const nextMeta = getState<Record<string, unknown> | null>('preload.meta');
    const isActuallyChanging = opfsFilename.name !== nextMeta?.name;
    if (isActuallyChanging) {
      postWorkerCommand({ command: 'OPFS_RESET', isPreload: false });
      cleanupOPFSInWorker(opfsFilename.name, false);
      setState('files.currentFileOpfs', { name: null });
    }
  }
}

// ─── Finalize Guest File (after OPFS download) ────────────────────

async function finalizeGuestFile(file: File | Blob): Promise<void> {
  log.debug('[Guest] Finalizing with Buffer Mode...');
  bus.emit('ui:show-loader', true, '오디오 메모리 로드 중...');

  try {
    await initAudio();
    if (Tone.context.state === 'suspended') await Tone.start();

    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await Tone.context.decodeAudioData(arrayBuffer);

    if (_currentAudioBuffer) {
      _currentAudioBuffer = null;
    }
    _currentAudioBuffer = audioBuffer;

    const meta = getState<Record<string, unknown>>('transfer.meta');
    const isVideo = isMediaVideo(file, meta);
    setEngineMode(isVideo ? 'video' : 'buffer');

    setState('files.currentFileBlob', file);

    const url = BlobURLManager.create(file) || '';
    const videoElement = getVideoElement();
    if (videoElement) {
      videoElement.src = url;
      videoElement.muted = true;
    }

    if (audioBuffer.duration && isFinite(audioBuffer.duration)) {
      bus.emit('ui:duration-update', audioBuffer.duration);
    }
    BlobURLManager.confirm();

    if (videoElement) {
      const onMetaLoaded = () => {
        videoElement.removeEventListener('loadedmetadata', onMetaLoaded);
        const dur = _currentAudioBuffer ? _currentAudioBuffer.duration : videoElement.duration;
        if (dur && isFinite(dur)) bus.emit('ui:duration-update', dur);
      };
      videoElement.addEventListener('loadedmetadata', onMetaLoaded);
      videoElement.load();
    }

    // Reset guards
    setState('transfer.state', TRANSFER_STATE.READY);
    setState('transfer.skipIncomingFile', false);
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');

    // Consume pending play time
    const hostConn = getState<DataConnection | null>('network.hostConn');
    if (hostConn && _pendingPlayTime !== undefined) {
      const localOffset = getState<number>('sync.localOffset') || 0;
      const autoSyncOffset = getState<number>('sync.autoSyncOffset') || 0;
      const target = _pendingPlayTime + localOffset + autoSyncOffset;
      log.debug(`[Guest] Found pending play time after download, starting at ${target.toFixed(2)}s`);
      play(target);
      _pendingPlayTime = undefined;
    }

    bus.emit('ui:play-btn-state', true);
  } catch (err: unknown) {
    log.error('[Guest] Decoding failed', err);
    bus.emit('ui:show-toast', '오디오 디코딩 실패! 다시 요청합니다.');

    const currentTrackIndex = getState<number>('playlist.currentTrackIndex');
    const playlist = getState<PlaylistItem[]>('playlist.items') || [];
    const name = playlist[currentTrackIndex]?.name || '';
    sendToHost({ type: MSG.REQUEST_CURRENT_FILE, name, index: currentTrackIndex, reason: 'decoding_failed' });
  } finally {
    bus.emit('ui:show-loader', false);
  }
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
    [MSG.FORCE_SYNC_PLAY]: handleForceSyncPlay,
    [MSG.STATUS_SYNC]: handleStatusSync,
  });

  // Video sync timer tick
  bus.on('worker:timer-tick', ((...args: unknown[]) => {
    if (args[0] === 'video-sync') checkVideoSync();
  }) as (...args: unknown[]) => void);

  // Stop all media (called from youtube player before loading)
  bus.on('player:stop-all-media', (() => {
    stopAllMedia();
  }) as (...args: unknown[]) => void);

  // Sync: provide current track position via callback pattern
  bus.on('sync:get-position', ((...args: unknown[]) => {
    const callback = args[0] as ((pos: number) => void) | undefined;
    if (typeof callback === 'function') {
      callback(getTrackPosition());
    }
  }) as (...args: unknown[]) => void);

  // Sync: handle sync response from host (apply time + play/pause)
  bus.on('sync:response', ((...args: unknown[]) => {
    const hostTime = Number(args[0]) || 0;
    const isPlaying = args[1] as boolean;
    const oneWayLatency = Number(args[2]) || 0;

    const localOffset = getState<number>('sync.localOffset') || 0;
    const compensatedTime = hostTime + oneWayLatency + localOffset;

    if (isPlaying) {
      if (_currentAudioBuffer || getVideoElement()?.src) {
        play(compensatedTime);
      } else {
        setState('player.pausedAt', compensatedTime);
        log.debug('[Sync] Host playing but no audio data yet, storing position');
      }
    } else {
      if (_pendingPlayTime !== undefined) {
        setState('player.pausedAt', compensatedTime);
        log.debug('[Sync] Host paused, keeping pending play');
        return;
      }
      stopAllMedia();
      setState('player.pausedAt', compensatedTime);
    }

    // RTT 보정 비활성화 — 로컬 네트워크 전용이라 보정 시 오히려 어긋남
    // const usePingCompensation = getState<boolean>('sync.usePingCompensation');
    // const lastLatencyMs = getState<number>('sync.lastLatencyMs') || 0;
    // if (usePingCompensation) {
    //   bus.emit('ui:show-toast', `자동 싱크 보정 완료, +${Math.round(lastLatencyMs / 2)}ms`);
    // }
    bus.emit('ui:show-toast', '직접 동기화 완료 (로컬 네트워크)');
  }) as (...args: unknown[]) => void);

  // Sync: apply nudge offset by re-seeking
  bus.on('sync:nudge-apply', ((..._args: unknown[]) => {
    const currentState = getState<string>('appState');
    if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO) {
      play(getTrackPosition());
    }
  }) as (...args: unknown[]) => void);

  // Surround mode toggled during playback: restart at current position
  bus.on('audio:surround-toggled', (() => {
    const currentState = getState<string>('appState');
    if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO) {
      play(getTrackPosition());
    }
  }) as (...args: unknown[]) => void);

  // Safety polling: periodically check if track ended (called from UI loop)
  bus.on('player:check-ended', (() => {
    handleEnded();
  }) as (...args: unknown[]) => void);

  // Clear previous track state (called from transfer module during track switch)
  bus.on('storage:clear-previous-track', ((...args: unknown[]) => {
    const reason = (args[0] as string) || '';
    clearPreviousTrackState(reason);
  }) as (...args: unknown[]) => void);

  // OPFS file ready: finalize guest download processing
  bus.on('opfs:file-ready', (async (...args: unknown[]) => {
    const filename = args[0] as string;
    const _sessionId = args[1] as number;
    const isPreload = args[2] as boolean;

    if (isPreload) {
      // Preload files are handled by preload module via storage:preload-file-ready
      bus.emit('storage:preload-file-ready', filename, _sessionId);
      return;
    }

    // Only guest processes OPFS files (Host loads directly)
    const hostConn = getState<DataConnection | null>('network.hostConn');
    if (!hostConn) return;

    const file = await readFileFromOpfs(filename, false);
    if (!file) {
      log.error('[Playback] Failed to read OPFS file:', filename);
      bus.emit('ui:show-loader', false);
      return;
    }

    await finalizeGuestFile(file);
  }) as (...args: unknown[]) => void);

  // Use preloaded track (skip download, decode from preload cache)
  bus.on('storage:use-preloaded', ((...args: unknown[]) => {
    const index = args[0] as number;
    const _name = args[1] as string;

    log.debug(`[Playback] Using preloaded track for index: ${index} (${_name})`);
    setState('transfer.skipIncomingFile', true);
    setState('transfer.waitingForPreload', true);

    // Try to activate immediately if blob is already available
    const nextFileBlob = getState<Blob | null>('preload.nextFileBlob');
    if (nextFileBlob) {
      setState('transfer.waitingForPreload', false);
      _currentLoadToken++;
      loadPreloadedTrack(index, _currentLoadToken);
    } else {
      // Blob not ready yet — set watchdog, will be triggered by opfs:file-ready preload path
      log.debug('[Playback] Preload blob not ready yet, waiting...');
    }
  }) as (...args: unknown[]) => void);

  // Transfer progress (update loader UI)
  bus.on('storage:transfer-progress', ((...args: unknown[]) => {
    const percent = args[0] as number;
    bus.emit('ui:show-loader', true, `수신 중... ${percent}%`);
    bus.emit('ui:update-loader', percent);
  }) as (...args: unknown[]) => void);

  // Host: Send playback state + current file to newly connected peer (late-join bootstrap)
  bus.on('network:peer-connected', ((...args: unknown[]) => {
    const conn = args[0] as DataConnection | null;
    if (!conn?.open) return;

    // Only Host bootstraps guests
    const hostConn = getState<DataConnection | null>('network.hostConn');
    if (hostConn) return;

    const currentState = getState<string>('appState');
    const currentTrackIndex = getState<number>('playlist.currentTrackIndex');
    const playlist = getState<unknown[]>('playlist.items') || [];

    // Send current file to late-joining guest (if local file is loaded)
    if (currentTrackIndex >= 0 && playlist[currentTrackIndex]) {
      const item = playlist[currentTrackIndex] as Record<string, unknown>;
      if (item.type !== 'youtube') {
        const currentFileBlob = getState<Blob | null>('files.currentFileBlob');
        const currentSessionId = getState<number>('transfer.currentSessionId');
        if (currentFileBlob) {
          unicastFile(conn, currentFileBlob, 0, currentSessionId)
            .catch((e: unknown) => log.error('[Host] unicastFile for late joiner failed', e));
        }

        // Also send preloaded next track
        const nextFileBlob = getState<Blob | null>('preload.nextFileBlob');
        const nextMeta = getState<Record<string, unknown> | null>('preload.meta');
        const nextTrackIndex = getState<number>('preload.nextTrackIndex');
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
        const item = (playlist[currentTrackIndex] as Record<string, unknown>) || {};
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
  }) as (...args: unknown[]) => void);

  log.info('[Playback] Engine initialized');
}
