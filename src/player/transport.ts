/**
 * MUSIXQUARE — Playback Transport
 *
 * Manages: play/pause/stop/seek, native Web Audio API buffer lifecycle,
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
import { isIdleOrPaused } from './video.ts';
import { broadcast, sendToHost } from '../network/peer.ts';
import { isGuestBlocked } from '../network/guards.ts';
import { getHostNow } from '../network/shared-clock.ts';

/** Schedule playback slightly in the future so the message arrives before play time */
const SCHEDULE_AHEAD_MS = 200;

import {
  getPlayerNode,
  setPlayerNode,
  getCurrentAudioBuffer,
  getLoadToken,
  incrementLoadToken,
  isPlayLocked,
  setPlayLocked,
  getPendingPlayTime,
  setPendingPlayTime,
  setPlayPreloadedInProgress,
} from './_state.ts';

import { getAudioContext, getCurrentTime, ensureRunning } from '../audio/context.ts';
import { showToast } from '../ui/toast.ts';
import { transition } from './lifecycle.ts';

// ─── Format Helpers ────────────────────────────────────────────────

export function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return '0:00';
  const total = Math.max(0, Math.floor(s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const ss = sec < 10 ? `0${sec}` : `${sec}`;
  // Hours segment only appears at ≥1h — keeps short tracks as "m:ss"
  // (the vast majority) and promotes long tracks (podcasts, DJ sets,
  // multi-hour YouTube livestreams) to "h:mm:ss" with a zero-padded
  // minutes field so the digit count is stable inside that hour.
  if (h > 0) {
    const mm = m < 10 ? `0${m}` : `${m}`;
    return `${h}:${mm}:${ss}`;
  }
  return `${m}:${ss}`;
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
    bus.emit('youtube:get-position', (pos: number) => {
      ytPos = pos;
    });
    return ytPos;
  }

  const _currentAudioBuffer = getCurrentAudioBuffer();
  const duration =
    _currentAudioBuffer && Number.isFinite(_currentAudioBuffer.duration)
      ? _currentAudioBuffer.duration
      : 0;

  let pos = 0;
  const startedAt = getState('player.startedAt') || 0;
  const localOffset = getState('sync.localOffset') || 0;

  const startedAtValid =
    typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt !== 0;
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
      pos = getCurrentTime() - startedAt + localOffset;
    }
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

/**
 * Stop and release the active source node.
 *
 * iOS WebKit retention quirk
 * ──────────────────────────
 * `setPlayerNode(null)` drops the JS reference to the AudioBufferSourceNode,
 * but the node still holds `.buffer` referencing its AudioBuffer (Web Audio
 * spec makes `buffer` set-once, so we can't reassign). On iOS during active
 * playback the audio rendering thread is lazy about reclaiming retired
 * nodes, so the old node + its ~80 MB AudioBuffer linger until JSC GC. Five
 * track switches in a row stack ~400 MB of invisible RAM that never shows
 * up in `[Audio]` (we only count the *current* buffer) — which is the
 * shape of the iOS-only crash beta-tester confirmed.
 *
 * Mitigations applied here, all best-effort:
 *
 *   - `disconnect()` before `stop()` — order helps iOS realise the node
 *     is leaving the graph synchronously, before the rendering thread
 *     queues another frame.
 *   - Try to assign `buffer = null` and an empty `onended`. Safari has
 *     historically accepted post-start `buffer` writes despite spec
 *     saying it should throw `InvalidStateError`; if it accepts, the
 *     node→buffer back-reference dies immediately. Chrome / spec-strict
 *     engines throw and we ignore.
 *   - Clear `onended` so any closure captured there (and whatever it
 *     transitively holds) is eligible for collection straight away.
 */
export function stopPlayerNode(): void {
  const node = getPlayerNode();
  if (!node) return;
  try {
    node.disconnect();
  } catch (e) {
    log.debug('disconnect node:', e);
  }
  try {
    node.stop();
  } catch (e) {
    log.debug('stop node:', e);
  }
  try {
    node.onended = null;
  } catch {
    /* ignore */
  }
  try {
    (node as unknown as { buffer: AudioBuffer | null }).buffer = null;
  } catch {
    /* InvalidStateError on spec-strict engines — ignore */
  }
  setPlayerNode(null);
}

// ─── Stop All Media ────────────────────────────────────────────────

export function stopAllMedia(opts?: { silent?: boolean }): void {
  // Stop system audio if active (without recursive loop — cleanup only disconnects nodes)
  if (isSystemAudioActive()) {
    bus.emit('system-audio:force-stop');
  }

  try {
    BlobURLManager.revoke();
  } catch (e) {
    log.debug('[Transport] BlobURL revoke:', e);
  }
  try {
    BlobURLManager.flushDeferred('stopAllMedia');
  } catch (e) {
    log.debug('[Transport] BlobURL flush:', e);
  }

  // 2. Stop YouTube — propagate silent flag so stopYouTubeMode skips the
  // IDLE bounce when the caller is mid-transition to PLAYING_AUDIO (avoids
  // a brief body.mode-youtube → no-mode → mode-audio flash on YT→Local).
  bus.emit('youtube:stop-mode', { silent: !!opts?.silent });

  // 3. Clear pending triggers
  clearManagedTimer('preloadScheduleTimer');
  clearManagedTimer('autoPlayTimer');
  clearManagedTimer('ended-advance-retry');
  clearManagedTimer('ended-advance-next');
  // Guest-side deferred replay (FILE_PREPARE same-file with autoPlayDelayMs).
  // Without this, a host's same-track re-click followed by a different track
  // leaves the deferred replay timer alive — it fires after the new track's
  // buffer has been swapped in and plays the new audio from 0:00 while the
  // host is still preparing its own playback.
  clearManagedTimer('playback-replay-defer');
  // Release the play-lock + cancel its watchdog. _internalPlay's finally
  // also unlocks (idempotent), but if stopAllMedia is called *during* its
  // await window — e.g. user mashes Next while a track decode is in flight
  // — the lock would otherwise stay held until the 15s watchdog fires.
  // pendingPlayTime is cleared right after, so the queued-request consumer
  // in _internalPlay's finally sees a consistent (no pending) state.
  clearManagedTimer('navigator-lock-watchdog');
  setPlayLocked(false);
  setPendingPlayTime(undefined);
  setPlayPreloadedInProgress(false);

  // silent=true: suppress IDLE flash when play() will immediately follow (e.g. track change)
  if (!opts?.silent && getState('appState') !== APP_STATE.IDLE) {
    setAppState(APP_STATE.IDLE);
  }

  // Stop player node
  stopPlayerNode();

  // Reset master clock
  setState('player.startedAt', 0);
  setState('player.pausedAt', 0);

  // Always reset the seekbar on stop. The silent guard used to skip this
  // to avoid a 0:00 flash during track change, since the rAF loop would
  // re-paint the thumb between the stop and the next loop-start. After
  // c80abcc the rAF loop skips thumb updates outside PLAYING_AUDIO, so
  // it no longer produces that flash on its own — but it also no longer
  // clears the stale thumb position. Without this emit, switching tracks
  // mid-playback leaves the previous track's position painted on the
  // seekbar throughout the new track's decode. The seek-reset handler
  // sets slider.value = 0 directly, which is now the only path that
  // clears stale thumb during a silent transition.
  bus.emit('ui:seek-reset');

  // Mirror the stop on guests. Without this, a host-side stopAllMedia
  // ({silent:true}) — used by every track-change / preload-swap /
  // system-audio-swap path — leaves guests still playing the previous
  // track via SharedClock for the duration of the host's autoPlayDelay
  // window (~3s). The host's player.startedAt resets locally but isn't
  // broadcast, so guests interpret the wall clock as "host is replaying
  // the previous track from 0:00" until MSG.PLAY arrives. handleEnded
  // and stopPlayback already emit their own MSG.PAUSE — those are
  // explicit terminal stops, not the silent transition path. Duplicate
  // PAUSEs from those callers are no-ops on guests.
  //
  // Host-only: stopAllMedia is also called from system-audio-guest.ts
  // on the guest side, and guests must not broadcast playback state.
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    broadcast({ type: MSG.PAUSE, time: 0, reason: 'stop' });
  }
  bus.emit('visualizer:fade-out');
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
  if (currentState === APP_STATE.PLAYING_AUDIO) {
    play(time);
    broadcast({
      type: MSG.PLAY,
      time,
      index: currentTrackIndex,
      hostPlayAt: getHostNow() + SCHEDULE_AHEAD_MS,
    });
  } else {
    // Paused: update position + broadcast
    setState('player.pausedAt', time);
    broadcast({ type: MSG.PAUSE, time, index: currentTrackIndex, reason: 'seek' });
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
  setManagedTimer(
    'navigator-lock-watchdog',
    () => {
      if (isPlayLocked()) {
        log.warn(
          `[Play] Lock Timeout: Forcing unlock after 15s (locked at ${new Date(lockStartTime).toISOString()})`,
        );
        setPlayLocked(false);
        setPendingPlayTime(undefined);
        stopPlayerNode();
        // Bump the load token so any in-flight _internalPlay aborts at its
        // next await checkpoint instead of overwriting the post-watchdog IDLE
        // state with PLAYING_AUDIO and starting a phantom AudioBufferSourceNode.
        incrementLoadToken();
        // Reset appState to IDLE to prevent stuck "playing" UI
        if (getState('appState') !== APP_STATE.IDLE) {
          setAppState(APP_STATE.IDLE);
        }
      }
    },
    15000,
  );

  try {
    await _internalPlay(offset, scheduleDelay);
  } finally {
    clearManagedTimer('navigator-lock-watchdog');
    setManagedTimer(
      'playback-unlock-delay',
      () => {
        setPlayLocked(false);
        // Consume queued play request (e.g. sync correction that arrived during lock)
        const pendingTime = getPendingPlayTime();
        if (pendingTime !== undefined) {
          setPendingPlayTime(undefined);
          log.debug(`[Play] Consuming queued play request: ${pendingTime.toFixed(2)}s`);
          play(pendingTime);
        }
      },
      10,
    );
  }
}

async function _internalPlay(offset: number, scheduleDelay = 0): Promise<void> {
  setPendingPlayTime(undefined);
  // Snapshot the load token at entry. If the play()-level watchdog fires
  // (or another path bumps the token, e.g. track switch), every await
  // checkpoint below will see a mismatch and abort cleanly instead of
  // racing with the watchdog's stopPlayerNode + setAppState(IDLE).
  const myLoadToken = getLoadToken();
  log.debug(`[Play] Stage 1: Validating state (offset: ${offset})`);

  const currentState = getState('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    log.warn('[Audio] Blocked play() call while in YouTube mode');
    return;
  }

  log.debug('[Play] Stage 2: Resuming AudioContext');
  try {
    await ensureRunning();
  } catch (e) {
    log.warn('Resume failed:', e);
  }

  if (getLoadToken() !== myLoadToken) {
    log.warn('[Play] Aborted — load token bumped during ensureRunning');
    return;
  }

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
  const hasBufferSource = !!_currentAudioBuffer;

  if (!hasBufferSource) {
    log.warn('[Play] No media source available');
    // Surface the empty state to the user so the play button doesn't
    // silently no-op. Hits in two situations:
    //   - Fresh boot, user taps play before adding anything.
    //   - User cleared every track via the X button, then taps play.
    // The hint copy ("미디어를 추가해주세요.") matches the empty-list
    // placeholder shown in the playlist tab for a consistent UX.
    showToast(t('playlist.empty_hint'));
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

  if (getLoadToken() !== myLoadToken) {
    log.warn('[Play] Aborted — load token bumped during initAudio');
    return;
  }

  // Re-check after second async gap (initAudio)
  if (getState('appState') === APP_STATE.PLAYING_YOUTUBE) {
    log.warn('[Audio] Aborted play() — app switched to YouTube mode during initAudio');
    return;
  }

  // 1. Get the current manual sync offset (nudge) for both audio-engine and clock
  const localOffset = getState('sync.localOffset') || 0;

  // 2. Sanitize offset
  let safeOffset = Number(offset);
  if (!Number.isFinite(safeOffset) || safeOffset < 0) safeOffset = 0;
  const duration =
    _currentAudioBuffer && Number.isFinite(_currentAudioBuffer.duration)
      ? _currentAudioBuffer.duration
      : 0;
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

    newNode.addEventListener('ended', () => {
      if (myLoadToken !== getLoadToken()) return;
      const state = getState('appState');
      if (state === APP_STATE.PLAYING_AUDIO) {
        handleEnded();
      }
    });

    // Determine the exact audio-context time to start
    const startWhen = scheduleDelay > 0 ? ctx.currentTime + scheduleDelay : 0;

    // Apply manual nudge to the audible start position
    const nudgeOffset = safeOffset + localOffset;
    let finalStartPos = nudgeOffset;
    if (duration > 0) {
      finalStartPos = Math.max(0, Math.min(duration - 0.001, nudgeOffset));
    }

    newNode.start(startWhen, finalStartPos);
  }

  // Update timing
  // startedAt = wall-clock time when playback would have started from 0:00
  //   = now - playbackPosition + syncCorrection
  const startedAt = getCurrentTime() + scheduleDelay - safeOffset + localOffset;
  setState('player.startedAt', startedAt);
  setState('player.pausedAt', safeOffset);
  log.debug(`[BufferMode] Started at ${safeOffset}s (startedAt: ${startedAt})`);

  setAppState(APP_STATE.PLAYING_AUDIO);

  if (!getState('network.hostConn')) {
    transition({
      type: 'PLAY',
      time: safeOffset,
      index: getState('playlist.currentTrackIndex'),
      sameTrack: true,
    });
  }

  bus.emit('visualizer:start');
  bus.emit('ui:loop-start');
}

// ─── Pause ─────────────────────────────────────────────────────────

export function pause(forcedTime?: number, opts?: { holdVisualizer?: boolean }): void {
  const currentState = getState('appState');
  if (isIdleOrPaused(currentState)) return;

  let pausePos: number;
  if (typeof forcedTime === 'number' && Number.isFinite(forcedTime) && forcedTime >= 0) {
    pausePos = forcedTime;
  } else {
    pausePos = getTrackPosition();
  }

  stopPlayerNode();

  if (opts?.holdVisualizer ?? forcedTime === undefined) {
    bus.emit('visualizer:hold-frame');
  }
  setAppState(APP_STATE.PAUSED);
  setState('player.pausedAt', pausePos);

  if (!getState('network.hostConn')) {
    transition({ type: 'PAUSE', time: pausePos, endOfPlaylist: false });
  }

  showToast(t('common.pause'));
}

// ─── Handle Track Ended ────────────────────────────────────────────

export function handleEnded(): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Guests don't handle track-end

  const currentState = getState('appState');
  const _currentAudioBuffer = getCurrentAudioBuffer();

  const hasBufferDuration = !!(
    _currentAudioBuffer &&
    Number.isFinite(_currentAudioBuffer.duration) &&
    _currentAudioBuffer.duration > 0.1
  );

  const duration = hasBufferDuration ? _currentAudioBuffer!.duration : 0;
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

  const isActuallyPlaying = currentState === APP_STATE.PLAYING_AUDIO;
  const pausedAt = getState('player.pausedAt') || 0;
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const playlistItems = getState('playlist.items') || [];

  // Deselected state (e.g. after end-of-playlist reset): no track is selected
  // but the playlist is non-empty. Pressing play should restart from track 0
  // rather than silently resuming the stale audio buffer with "미디어 없음"
  // still showing in the title.
  if (!isActuallyPlaying && currentTrackIndex === -1 && playlistItems.length > 0) {
    if (!hostConn) {
      void import('./playlist.ts').then((mod) => mod.playTrack(0));
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
      broadcast({ type: MSG.PAUSE, time: getState('player.pausedAt'), reason: 'pause' });
    } else if (isOperator) {
      sendToHost({ type: MSG.REQUEST_PAUSE });
    }
  } else {
    if (!hostConn) {
      play(pausedAt);
      broadcast({
        type: MSG.PLAY,
        time: pausedAt,
        index: currentTrackIndex,
        hostPlayAt: getHostNow() + SCHEDULE_AHEAD_MS,
      });
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
    try {
      hostConn.send({ type: MSG.REQUEST_SEEK, time: 0 });
    } catch (e) {
      log.debug('[Transport] send REQUEST_SEEK:', e);
    }
    try {
      hostConn.send({ type: MSG.REQUEST_PAUSE });
    } catch (e) {
      log.debug('[Transport] send REQUEST_PAUSE:', e);
    }
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

  if (!hostConn) broadcast({ type: MSG.PAUSE, time: 0, reason: 'stop' });
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
  const rawBufDur = _currentAudioBuffer?.duration;
  const duration = rawBufDur != null && Number.isFinite(rawBufDur) && rawBufDur > 0 ? rawBufDur : 0;

  if (target < 0) target = 0;
  if (duration > 0 && target > duration) target = Math.max(0, duration - 0.1);

  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const isPlaying = currentState === APP_STATE.PLAYING_AUDIO;

  if (isPlaying) {
    play(target);
    broadcast({
      type: MSG.PLAY,
      time: target,
      index: currentTrackIndex,
      hostPlayAt: getHostNow() + SCHEDULE_AHEAD_MS,
    });
  } else {
    setState('player.pausedAt', target);
    broadcast({ type: MSG.PAUSE, time: target, reason: 'seek' });
  }
}

// ─── Adjust Sync ───────────────────────────────────────────────────

/**
 * How long to wait after the last nudge click before re-playing the audio.
 *
 * Why debounce: each nudge bumps sync.localOffset synchronously (so the
 * displayed value reacts instantly), but we also need to restart the
 * AudioBufferSourceNode so the actual audio jumps to the new offset
 * position. If the user mashes the button, a naïve "call play() per click"
 * runs into the play-lock queue — and that queue captures getTrackPosition()
 * at CLICK TIME. By the time the lock releases (100-300ms later) the
 * captured position is stale; playing from it drops the audio behind
 * wall-clock by the elapsed amount. Symptom: "reset doesn't line up".
 *
 * Instead, every click just updates localOffset + resets a 60ms timer.
 * The final timer firing reads a FRESH getTrackPosition() and calls
 * play() once. One node re-creation per burst, always at the right spot.
 */
const NUDGE_REPLAY_DEBOUNCE_MS = 60;

export function adjustSync(val: number): void {
  const localOffset = getState('sync.localOffset') || 0;
  setState('sync.localOffset', localOffset + val);
  bus.emit('sync:display-update');

  const currentState = getState('appState');
  if (isIdleOrPaused(currentState)) {
    // Paused: localOffset is stored and applied on next play(pausedAt) via
    // startedAt. Don't modify pausedAt — it would cancel out the offset.
    return;
  }

  // Debounce: coalesce bursts of rapid clicks into one re-play. getTrackPosition
  // is read inside the timer so it reflects the offset accumulated across the
  // entire burst, not just the first click.
  clearManagedTimer('sync-nudge-replay');
  setManagedTimer(
    'sync-nudge-replay',
    () => {
      // Re-check app state at fire time — user may have paused during the burst.
      if (isIdleOrPaused(getState('appState'))) return;
      play(getTrackPosition());
    },
    NUDGE_REPLAY_DEBOUNCE_MS,
  );
}
