/**
 * MUSIXQUARE 3.0 — Playback Transport
 *
 * Manages: play/pause/stop/seek, Tone.js BufferSource lifecycle,
 * video sync, track position calculation.
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, APP_STATE } from '../core/constants.ts';
import { clearManagedTimer, getManagedTimer, setManagedTimer } from '../core/timers.ts';
import { BlobURLManager } from '../core/blob-manager.ts';
import { initAudio, getWidener } from '../audio/engine.ts';
import { getVideoElement, isIdleOrPaused, isMediaVideo } from './video.ts';
import { broadcast, sendToHost } from '../network/peer.ts';
import { isGuestBlocked } from '../network/guards.ts';
import { requestGlobalResyncDelayed } from '../network/sync.ts';

import {
  getPlayerNode, setPlayerNode,
  getCurrentAudioBuffer,
  getLoadToken,
  isPlayLocked, setPlayLocked,
  getPendingPlayTime, setPendingPlayTime,
  setPlayPreloadedInProgress,
  getLoadScope, setLoadScope,
} from './_state.ts';

import { getAudioContext, getCurrentTime, ensureRunning } from '../audio/context.ts';

// ─── Format Helpers ────────────────────────────────────────────────

export function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

// ─── App State Helper ─────────────────────────────────────────────

/**
 * Central function: update appState + emit player:state-changed.
 * All code paths that change the app state MUST use this instead of
 * calling setState('appState') directly.
 */
export function setAppState(newState: string): void {
  setState('appState', newState);
  bus.emit('player:state-changed', newState);
}

// ─── Track Position ────────────────────────────────────────────────

export function getTrackPosition(): number {
  const currentState = getState('appState');
  const pausedAt = getState('player.pausedAt') || 0;

  if (isIdleOrPaused(currentState)) return pausedAt;

  // YouTube mode: delegated via synchronous callback
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    let ytPos = 0;
    bus.emit('youtube:get-position', (pos: number) => { ytPos = pos; });
    return ytPos;
  }

  const _currentAudioBuffer = getCurrentAudioBuffer();
  const videoElement = getVideoElement();
  const duration = (_currentAudioBuffer && Number.isFinite(_currentAudioBuffer.duration))
    ? _currentAudioBuffer.duration
    : (videoElement && Number.isFinite(videoElement.duration) ? videoElement.duration : 0);

  let pos = 0;
  const startedAt = getState('player.startedAt') || 0;
  const localOffset = getState('sync.localOffset') || 0;
  const autoSyncOffset = getState('sync.autoSyncOffset') || 0;

  const startedAtValid = typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt !== 0;
  if (startedAtValid && getCurrentTime() > 0) {
    const combinedOffset = localOffset + autoSyncOffset;
    // Guard: schedule offset reset if combined drift exceeds 30 seconds.
    // 30s is unreachable in normal usage (adjustSync = ±0.1s per click).
    // Only fires on genuine bugs (e.g. corrupted autoSyncOffset).
    // Deferred to avoid setState inside a getter (side-effect in read path).
    if (Math.abs(combinedOffset) > 30) {
      log.warn(`[Sync] Offset divergence detected: local=${localOffset.toFixed(3)}, auto=${autoSyncOffset.toFixed(3)}, combined=${combinedOffset.toFixed(3)}s — resetting`);
      queueMicrotask(() => {
        // Read current offsets at execution time (may have changed since queued)
        const lo = getState('sync.localOffset') || 0;
        const ao = getState('sync.autoSyncOffset') || 0;
        const drift = lo + ao;
        setState('sync.localOffset', 0);
        setState('sync.autoSyncOffset', 0);
        // Recalculate startedAt to remove the encoded offset — prevents position
        // jump on next getTrackPosition() call after offsets are zeroed.
        const sa = getState('player.startedAt');
        if (sa) setState('player.startedAt', sa - drift);
      });
      pos = getCurrentTime() - startedAt;
    } else {
      pos = (getCurrentTime() - startedAt) + combinedOffset;
    }
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
  const _playerNode = getPlayerNode();
  if (_playerNode) {
    try {
      _playerNode.stop();
      _playerNode.disconnect();
    } catch (e) {
      log.warn('Error stopping playerNode:', e);
    } finally {
      setPlayerNode(null);
    }
  }
}

// ─── Stop All Media ────────────────────────────────────────────────

export function stopAllMedia(opts?: { silent?: boolean }): void {
  getLoadScope()?.dispose();
  setLoadScope(null);
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
  clearManagedTimer('ended-advance-retry');
  clearManagedTimer('ended-advance-next');
  setPendingPlayTime(undefined);
  setPlayPreloadedInProgress(false);

  // silent=true: suppress IDLE flash when play() will immediately follow (e.g. track change)
  if (!opts?.silent && getState('appState') !== APP_STATE.IDLE) {
    setAppState(APP_STATE.IDLE);
  }
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
  if (isPlayLocked()) {
    log.warn('[Play] Blocked: queuing play request');
    setPendingPlayTime(offset);
    return;
  }
  setPlayLocked(true);

  const lockStartTime = Date.now();
  setManagedTimer('navigator-lock-watchdog', () => {
    if (isPlayLocked()) {
      log.warn(`[Play] Lock Timeout: Forcing unlock after 15s (locked at ${new Date(lockStartTime).toISOString()})`);
      setPlayLocked(false);
      setPendingPlayTime(undefined);
      stopPlayerNode();
      // Reset appState to IDLE to prevent stuck "playing" UI
      if (getState('appState') !== APP_STATE.IDLE) {
        setAppState(APP_STATE.IDLE);
      }
    }
  }, 15000);

  try {
    await _internalPlay(offset);
  } finally {
    clearManagedTimer('navigator-lock-watchdog');
    setManagedTimer('playback-unlock-delay', () => {
      setPlayLocked(false);
      // Consume queued play request (e.g. sync correction that arrived during lock)
      const pendingTime = getPendingPlayTime();
      if (pendingTime !== undefined) {
        setPendingPlayTime(undefined);
        log.debug(`[Play] Consuming queued play request: ${pendingTime.toFixed(2)}s`);
        play(pendingTime);
      }
    }, 10);
  }
}

async function _internalPlay(offset: number): Promise<void> {
  setPendingPlayTime(undefined);
  log.debug(`[Play] Stage 1: Validating state (offset: ${offset})`);

  const currentState = getState('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    log.warn('[Audio] Blocked play() call while in YouTube mode');
    return;
  }

  log.debug('[Play] Stage 2: Resuming AudioContext');
  try { await ensureRunning(); } catch (e) { log.warn('Resume failed:', e); }

  const _currentAudioBuffer = getCurrentAudioBuffer();
  const videoElement = getVideoElement();
  const hasVideoSource = !!(videoElement?.src?.startsWith('blob:'));
  const hasBufferSource = !!_currentAudioBuffer;

  if (!hasVideoSource && !hasBufferSource) {
    log.warn('[Play] No media source available');
    return;
  }

  log.debug('[Play] Stage 3: Initializing audio engine');
  try {
    await initAudio();
  } catch (e) {
    log.error('[Audio] initAudio failed:', e);
    bus.emit('ui:show-toast', t('error.audio_engine_prepare'));
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
    if (safeOffset === duration) safeOffset = Math.max(0, duration - 0.1);
  }

  // Buffer Mode playback
  if (_currentAudioBuffer) {
    stopPlayerNode();
    const ctx = getAudioContext();
    const newNode = ctx.createBufferSource();
    newNode.buffer = _currentAudioBuffer;
    setPlayerNode(newNode);

    const isSurroundMode = getState('audio.isSurroundMode');
    const surroundChannelIndex = getState('audio.surroundChannelIndex');

    if (isSurroundMode) {
      bus.emit('audio:connect-surround', newNode, surroundChannelIndex);
      log.debug(`[BufferMode] Playing in 7.1 Surround (Ch: ${surroundChannelIndex})`);
    } else {
      const widener = getWidener();
      if (widener) newNode.connect(widener.input);
      log.debug('[BufferMode] Playing in Stereo');
    }

    const endedToken = getLoadToken();
    newNode.addEventListener('ended', () => {
      if (endedToken !== getLoadToken()) return;
      const state = getState('appState');
      if (state === APP_STATE.PLAYING_AUDIO || state === APP_STATE.PLAYING_VIDEO) {
        handleEnded();
      }
    });

    newNode.start(0, safeOffset);

    // Sync visuals (muted video)
    if (videoElement?.src) {
      videoElement.currentTime = safeOffset;
      videoElement.muted = true;
      videoElement.play().catch(() => { /* noop */ });
    }
  } else if (hasVideoSource && videoElement?.src) {
    // Video-only playback (no audio buffer) — play video with its own audio track
    videoElement.currentTime = safeOffset;
    videoElement.muted = false;
    videoElement.play().catch(() => { /* noop */ });
  }

  // Update timing
  // startedAt = wall-clock time when playback would have started from 0:00
  //   = now - playbackPosition + syncCorrection
  const localOffset = getState('sync.localOffset') || 0;
  const autoSyncOffset = getState('sync.autoSyncOffset') || 0;
  const combinedSyncOffset = localOffset + autoSyncOffset;
  const startedAt = getCurrentTime() - safeOffset + combinedSyncOffset;
  setState('player.startedAt', startedAt);
  setState('player.pausedAt', safeOffset);
  log.debug(`[BufferMode] Started at ${safeOffset}s (startedAt: ${startedAt})`);

  updatePlayState(true);

  const meta = getState('transfer.meta');
  const currentFileBlob = getState('files.currentFileBlob');
  const isVideo = isMediaVideo(currentFileBlob, meta);
  const newState = isVideo ? APP_STATE.PLAYING_VIDEO : APP_STATE.PLAYING_AUDIO;
  setAppState(newState);

  bus.emit('visualizer:start');
  if (isVideo) {
    bus.emit('worker:sync-command', { command: 'START_TIMER', id: 'video-sync', interval: 2000 });
  }
  bus.emit('ui:loop-start');
}

// ─── Pause ─────────────────────────────────────────────────────────

export function pause(forcedTime?: number): void {
  const currentState = getState('appState');
  if (isIdleOrPaused(currentState)) return;

  let pausePos: number;
  if (typeof forcedTime === 'number' && Number.isFinite(forcedTime) && forcedTime >= 0) {
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

  setAppState(APP_STATE.PAUSED);
  setState('player.pausedAt', pausePos);
  updatePlayState(false);
  bus.emit('ui:show-toast', t('common.pause'));
  bus.emit('worker:sync-command', { command: 'STOP_TIMER', id: 'video-sync' });
}

// ─── Handle Track Ended ────────────────────────────────────────────

export function handleEnded(): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Guests don't handle track-end

  const currentState = getState('appState');
  const _currentAudioBuffer = getCurrentAudioBuffer();
  const videoElement = getVideoElement();

  const hasBufferDuration = !!(_currentAudioBuffer &&
    Number.isFinite(_currentAudioBuffer.duration) && _currentAudioBuffer.duration > 0.1);

  const usesVideoElement = currentState === APP_STATE.PLAYING_VIDEO;
  if (!hasBufferDuration && usesVideoElement && videoElement && videoElement.readyState < 1) return;

  const duration = hasBufferDuration
    ? _currentAudioBuffer!.duration
    : (videoElement ? videoElement.duration : 0);

  if (!duration || !Number.isFinite(duration) || duration <= 0.1) return;
  if (isIdleOrPaused(currentState)) return;
  if (currentState === APP_STATE.PLAYING_YOUTUBE) return;

  const curr = getTrackPosition();
  const isSeeking = getState('player.isSeeking');
  if (isSeeking) {
    log.debug('[handleEnded] Ignoring end signal while seeking');
    return;
  }

  if (curr >= duration - 0.05) {
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
  if (isGuestBlocked()) return;

  const hostConn = getState('network.hostConn');
  const isOperator = getState('network.isOperator');
  const currentState = getState('appState');

  // YouTube mode
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    bus.emit('youtube:toggle-play');
    return;
  }

  const isActuallyPlaying = currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO;
  const pausedAt = getState('player.pausedAt') || 0;
  const currentTrackIndex = getState('playlist.currentTrackIndex');

  // Cancel pending auto-play (with user feedback)
  if (!hostConn && getManagedTimer('autoPlayTimer')) {
    clearManagedTimer('autoPlayTimer');
    bus.emit('ui:show-toast', t('toast.auto_play_canceled'));
  }
  clearManagedTimer('ended-advance-retry');
  clearManagedTimer('ended-advance-next');

  if (isActuallyPlaying) {
    if (!hostConn) {
      pause();
      broadcast({ type: MSG.PAUSE, time: getState('player.pausedAt') });
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
  if (isGuestBlocked()) return;

  const hostConn = getState('network.hostConn');
  const isOperator = getState('network.isOperator');
  if (hostConn && isOperator) {
    try { hostConn.send({ type: MSG.REQUEST_SEEK, time: 0 }); } catch { /* noop */ }
    try { hostConn.send({ type: MSG.REQUEST_PAUSE }); } catch { /* noop */ }
    bus.emit('ui:show-toast', t('toast.stop_sent'));
    return;
  }

  const currentState = getState('appState');
  if (currentState === APP_STATE.IDLE) return; // Nothing to stop

  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    // Set IDLE before stop-playback to prevent onYouTubePlayerStateChange ENDED
    // from triggering playlist:next-track (its guard checks appState !== PLAYING_YOUTUBE)
    setAppState(APP_STATE.IDLE);
    bus.emit('youtube:stop-playback');
    bus.emit('youtube:stop-mode');
    clearManagedTimer('autoPlayTimer');
    clearManagedTimer('ended-advance-retry');
    clearManagedTimer('ended-advance-next');
    setState('player.pausedAt', 0);
    updatePlayState(false);
    return;
  }

  stopAllMedia();
  bus.emit('ui:seek-reset');

  if (!hostConn) broadcast({ type: MSG.PAUSE, time: 0 });
  bus.emit('ui:show-toast', t('common.stop'));
}

// ─── Skip Time ─────────────────────────────────────────────────────

export function skipTime(sec: number): void {
  if (isGuestBlocked()) return;

  const hostConn = getState('network.hostConn');
  const isOperator = getState('network.isOperator');
  if (hostConn && isOperator) {
    sendToHost({ type: MSG.REQUEST_SKIP_TIME, sec });
    return;
  }

  const currentState = getState('appState');
  if (currentState === APP_STATE.IDLE) return;
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    bus.emit('youtube:skip-time', sec);
    return;
  }

  const _currentAudioBuffer = getCurrentAudioBuffer();
  const current = getTrackPosition();
  let target = current + sec;
  const videoElement = getVideoElement();
  const rawBufDur = _currentAudioBuffer?.duration;
  const duration = (rawBufDur != null && Number.isFinite(rawBufDur) && rawBufDur > 0)
    ? rawBufDur
    : (videoElement && Number.isFinite(videoElement.duration) ? videoElement.duration : 0);

  if (target < 0) target = 0;
  if (duration > 0 && target > duration) target = Math.max(0, duration - 0.1);

  const currentTrackIndex = getState('playlist.currentTrackIndex');
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
  const localOffset = getState('sync.localOffset') || 0;
  setState('sync.localOffset', localOffset + val);
  bus.emit('sync:display-update');

  const currentState = getState('appState');
  if (!isIdleOrPaused(currentState)) {
    play(getTrackPosition());
  }
  // Paused: localOffset is stored and applied on next play(pausedAt) via startedAt.
  // Don't modify pausedAt — it would cancel out the offset in startedAt calculation.
}

// ─── Check Video Sync ──────────────────────────────────────────────

export function checkVideoSync(): void {
  const currentState = getState('appState');
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
