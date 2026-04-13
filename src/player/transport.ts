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
import type { AppStateValue } from '../core/constants.ts';
import { clearManagedTimer, getManagedTimer, setManagedTimer } from '../core/timers.ts';
import { BlobURLManager } from '../core/blob-manager.ts';
import { initAudio, getWidener } from '../audio/engine.ts';
import { isSystemAudioActive, stopSystemAudioCapture } from '../audio/system-capture.ts';
import { getVideoElement, isIdleOrPaused, isMediaVideo } from './video.ts';
import { broadcast, sendToHost } from '../network/peer.ts';
import { isGuestBlocked } from '../network/guards.ts';
import { getHostNow } from '../network/shared-clock.ts';

/** Schedule playback slightly in the future so the message arrives before play time */
const SCHEDULE_AHEAD_MS = 200;

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
import { showToast } from '../ui/toast.ts';

// ─── Format Helpers ────────────────────────────────────────────────

export function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

// ─── App State Helper ─────────────────────────────────────────────

/**
 * Central function: update appState.
 * Subscribers listen via bus.on('state:appState', ...).
 */
export function setAppState(newState: AppStateValue): void {
  setState('appState', newState);
}

// ─── Track Position ────────────────────────────────────────────────

let _offsetResetQueued = false;

export function getTrackPosition(): number {
  const currentState = getState('appState');
  const pausedAt = getState('player.pausedAt') || 0;

  if (isIdleOrPaused(currentState)) return pausedAt;

  // System audio: no meaningful position (live stream)
  if (currentState === APP_STATE.PLAYING_SYSTEM_AUDIO) return 0;

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

  const startedAtValid = typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt !== 0;
  if (startedAtValid && getCurrentTime() > 0) {
    // Guard: schedule offset reset if drift exceeds 30 seconds.
    // 30s is unreachable in normal usage (adjustSync = ±0.1s per click).
    // Deferred to avoid setState inside a getter (side-effect in read path).
    // _offsetResetQueued prevents duplicate microtasks when getTrackPosition()
    // is called multiple times in the same frame (seek bar, sync, broadcast).
    if (Math.abs(localOffset) > 30 && !_offsetResetQueued) {
      _offsetResetQueued = true;
      log.warn(`[Sync] Offset divergence detected: local=${localOffset.toFixed(3)}s — resetting`);
      queueMicrotask(() => {
        _offsetResetQueued = false;
        const lo = getState('sync.localOffset') || 0;
        setState('sync.localOffset', 0);
        // Recalculate startedAt to remove the encoded offset — prevents position
        // jump on next getTrackPosition() call after offset is zeroed.
        const sa = getState('player.startedAt');
        if (sa) setState('player.startedAt', sa - lo);
      });
      pos = getCurrentTime() - startedAt;
    } else {
      pos = (getCurrentTime() - startedAt) + localOffset;
    }
  } else if (videoElement?.src && videoElement.readyState >= 1) {
    pos = videoElement.currentTime;
  }

  if (isNaN(pos)) pos = 0;
  // If audio is scheduled but hasn't started yet, return the target offset
  if (pos < 0) pos = getState('player.pausedAt') || 0;
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
  // Stop system audio if active (without recursive loop — cleanup only disconnects nodes)
  if (isSystemAudioActive()) {
    bus.emit('system-audio:force-stop');
  }

  getLoadScope()?.dispose();
  setLoadScope(null);
  const videoElement = getVideoElement();

  // 1. Stop video
  if (videoElement) {
    videoElement.pause();
    videoElement.removeAttribute('src');
    videoElement.load();
  }

  try { BlobURLManager.revoke(); } catch (e) { log.debug('[Transport] BlobURL revoke:', e); }
  try { BlobURLManager.flushDeferred('stopAllMedia'); } catch (e) { log.debug('[Transport] BlobURL flush:', e); }

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

  // Stop background sync timers
  bus.emit('worker:sync-command', { command: 'STOP_TIMER', id: 'video-sync' });

  // Stop player node
  stopPlayerNode();

  // Reset master clock
  setState('player.startedAt', 0);
  setState('player.pausedAt', 0);

  // Stop seekbar animation (silent mode leaves appState as PLAYING,
  // but audio is stopped — rAF must not interpolate stale positions)
  bus.emit('ui:seek-reset');
}

// ─── Seek ──────────────────────────────────────────────────────────

/**
 * Unified seek handler. Replaces player:seek + player:seek-to-time events.
 * Handles all roles (host, OP guest, regular guest) and modes (audio, video, YouTube).
 */
export function seekTo(time: number): void {
  const hostConn = getState('network.hostConn');
  const isOperator = getState('network.isOperator');

  // Guest (non-OP): blocked
  if (hostConn && !isOperator) return;

  // OP guest: request host to seek
  if (hostConn && isOperator) {
    sendToHost({ type: MSG.REQUEST_SEEK, time });
    return;
  }

  // Cancel pending auto-play on manual interaction (Host only)
  if (!hostConn && getManagedTimer('autoPlayTimer')) {
    clearManagedTimer('autoPlayTimer');
    showToast(t('toast.auto_play_canceled'));
  }

  // YouTube mode
  const currentState = getState('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    bus.emit('youtube:seek-to', time);
    return;
  }

  // System audio: no seek (live stream)
  if (currentState === APP_STATE.PLAYING_SYSTEM_AUDIO) return;

  // Host: playing → seek + broadcast
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO) {
    play(time);
    broadcast({ type: MSG.PLAY, time, index: currentTrackIndex, hostPlayAt: getHostNow() + SCHEDULE_AHEAD_MS });
  } else {
    // Paused: update position + broadcast
    setState('player.pausedAt', time);
    const videoElement = getVideoElement();
    if (videoElement) try { videoElement.currentTime = time; } catch (e) { log.debug('[Transport] seek while paused:', e); }
    broadcast({ type: MSG.PAUSE, time, index: currentTrackIndex });
  }
}

// ─── Play ──────────────────────────────────────────────────────────

export async function play(offset: number, scheduleDelay = 0): Promise<void> {
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
    await _internalPlay(offset, scheduleDelay);
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

async function _internalPlay(offset: number, scheduleDelay = 0): Promise<void> {
  setPendingPlayTime(undefined);
  log.debug(`[Play] Stage 1: Validating state (offset: ${offset})`);

  const currentState = getState('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    log.warn('[Audio] Blocked play() call while in YouTube mode');
    return;
  }

  log.debug('[Play] Stage 2: Resuming AudioContext');
  try { await ensureRunning(); } catch (e) { log.warn('Resume failed:', e); }

  // ── Post-await mode re-check ──────────────────────────────────────
  // While we awaited ensureRunning/initAudio, the user may have switched
  // to YouTube mode. Without this guard, _internalPlay continues to
  // create an AudioBufferSourceNode and calls setAppState(PLAYING_AUDIO),
  // overwriting PLAYING_YOUTUBE — causing double-audio and a broken UI
  // state that requires a page reload.
  if (getState('appState') === APP_STATE.PLAYING_YOUTUBE) {
    log.warn('[Audio] Aborted play() — app switched to YouTube mode during async init');
    return;
  }

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
    showToast(t('error.audio_engine_prepare'));
    return;
  }

  // Re-check after second async gap (initAudio)
  if (getState('appState') === APP_STATE.PLAYING_YOUTUBE) {
    log.warn('[Audio] Aborted play() — app switched to YouTube mode during initAudio');
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

    // scheduleDelay > 0: Web Audio hardware-timed start (sub-ms precision)
    // scheduleDelay = 0: immediate start (host or local play)
    const startWhen = scheduleDelay > 0 ? ctx.currentTime + scheduleDelay : 0;
    newNode.start(startWhen, safeOffset);

    // Sync visuals (muted video)
    if (videoElement?.src) {
      videoElement.currentTime = safeOffset;
      videoElement.muted = true;
      videoElement.play().catch(() => { /* noop */ });
    }
  } else if (hasVideoSource && videoElement?.src) {
    // Video-only playback (no audio buffer) — play video with its own audio track
    // Video-only: scheduleDelay not applicable (upstream uses setTimeout fallback)
    videoElement.currentTime = safeOffset;
    videoElement.muted = false;
    videoElement.play().catch(() => { /* noop */ });
  }

  // Update timing
  // startedAt = wall-clock time when playback would have started from 0:00
  //   = now - playbackPosition + syncCorrection
  const localOffset = getState('sync.localOffset') || 0;
  const startedAt = getCurrentTime() + scheduleDelay - safeOffset + localOffset;
  setState('player.startedAt', startedAt);
  setState('player.pausedAt', safeOffset);
  log.debug(`[BufferMode] Started at ${safeOffset}s (startedAt: ${startedAt})`);

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
    try { videoElement.pause(); } catch (e) { log.debug('[Transport] video pause:', e); }
    try { videoElement.currentTime = pausePos; } catch (e) { log.debug('[Transport] video seek on pause:', e); }
  }

  setAppState(APP_STATE.PAUSED);
  setState('player.pausedAt', pausePos);
  showToast(t('common.pause'));
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
  if (currentState === APP_STATE.PLAYING_SYSTEM_AUDIO) return;

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

  // System audio: ignore play/pause toggle (use "공유 중지" button instead)
  if (currentState === APP_STATE.PLAYING_SYSTEM_AUDIO) return;

  const isActuallyPlaying = currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO;
  const pausedAt = getState('player.pausedAt') || 0;
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const playlistItems = getState('playlist.items') || [];

  // Deselected state (e.g. after end-of-playlist reset): no track is selected
  // but the playlist is non-empty. Pressing play should restart from track 0
  // rather than silently resuming the stale audio buffer with "미디어 없음"
  // still showing in the title.
  if (!isActuallyPlaying && currentTrackIndex === -1 && playlistItems.length > 0) {
    if (!hostConn) {
      void import('./playlist.ts').then(mod => mod.playTrack(0));
    } else if (isOperator) {
      sendToHost({ type: MSG.REQUEST_TRACK_CHANGE, index: 0 });
    }
    return;
  }

  // Cancel pending auto-play (with user feedback)
  if (!hostConn && getManagedTimer('autoPlayTimer')) {
    clearManagedTimer('autoPlayTimer');
    showToast(t('toast.auto_play_canceled'));
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
      broadcast({ type: MSG.PLAY, time: pausedAt, index: currentTrackIndex, hostPlayAt: getHostNow() + SCHEDULE_AHEAD_MS });
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
    try { hostConn.send({ type: MSG.REQUEST_SEEK, time: 0 }); } catch (e) { log.debug('[Transport] send REQUEST_SEEK:', e); }
    try { hostConn.send({ type: MSG.REQUEST_PAUSE }); } catch (e) { log.debug('[Transport] send REQUEST_PAUSE:', e); }
    showToast(t('toast.stop_sent'));
    return;
  }

  const currentState = getState('appState');
  if (currentState === APP_STATE.IDLE) return; // Nothing to stop

  if (currentState === APP_STATE.PLAYING_SYSTEM_AUDIO) {
    stopSystemAudioCapture();
    return;
  }

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
    return;
  }

  stopAllMedia();
  bus.emit('ui:seek-reset');

  if (!hostConn) broadcast({ type: MSG.PAUSE, time: 0 });
  showToast(t('common.stop'));
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

  // Cancel pending auto-play on manual interaction (Host only)
  if (!hostConn && getManagedTimer('autoPlayTimer')) {
    clearManagedTimer('autoPlayTimer');
    showToast(t('toast.auto_play_canceled'));
  }

  const currentState = getState('appState');
  if (currentState === APP_STATE.IDLE) return;
  if (currentState === APP_STATE.PLAYING_SYSTEM_AUDIO) return; // No skip on live stream
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
    broadcast({ type: MSG.PLAY, time: target, index: currentTrackIndex, hostPlayAt: getHostNow() + SCHEDULE_AHEAD_MS });
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
      videoElement.play().catch(e => { log.debug('[Transport] video kickstart:', e); });
    }

    videoElement.currentTime = targetTime;
  }
}
