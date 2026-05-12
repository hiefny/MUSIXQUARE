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
import { MSG } from '../core/constants.ts';
import { clearManagedTimer, getManagedTimer, setManagedTimer } from '../core/timers.ts';
import { BlobURLManager } from '../core/blob-manager.ts';
import { initAudio, getWidener } from '../audio/engine.ts';
import { isSystemAudioActive, stopSystemAudioCapture } from '../audio/system-capture.ts';
import {
  getPlaybackOwnership,
  getPlaybackModeActivity,
  isExternalOwner,
  isPlaybackPausedOrPendingFile,
  isPlaybackIdleCompat,
  isPlaybackIdleCompatModeActivity,
  isSystemAudioOwner,
  isYouTubeOwner,
  setPlaybackFilePaused,
  setPlaybackFilePlaying,
  setPlaybackIdle,
  isPlaybackPlayingFile,
  isPlaybackPlayingSystemAudio,
} from './ownership.ts';
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

// ─── Playback Mode Helpers ────────────────────────────────────────

function isCompatIdle(): boolean {
  return isPlaybackIdleCompat();
}

function isFileTransportInactive(): boolean {
  const playback = getPlaybackModeActivity();
  return isPlaybackIdleCompatModeActivity(playback) || isPlaybackPausedOrPendingFile(playback);
}

function isFilePlaybackPlaying(): boolean {
  return isPlaybackPlayingFile(getPlaybackModeActivity());
}

function isSystemAudioPlaying(): boolean {
  return isPlaybackPlayingSystemAudio(getPlaybackModeActivity());
}

// ─── Track Position ────────────────────────────────────────────────

let _offsetResetQueued = false;

export function getTrackPosition(): number {
  const ownership = getPlaybackOwnership();
  const pausedAt = getState('player.pausedAt') || 0;

  // System audio: no meaningful position (live stream)
  if (ownership.owner === 'system-audio') return 0;

  // YouTube mode: delegated via synchronous callback
  if (ownership.owner === 'youtube') {
    let ytPos = 0;
    bus.emit('youtube:get-position', (pos: number) => {
      ytPos = pos;
    });
    return ytPos;
  }

  if (isFileTransportInactive()) return pausedAt;

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

export function stopAllMedia(opts?: { silent?: boolean; cancelInFlight?: boolean }): void {
  const wasInYouTube = isYouTubeOwner();

  if (opts?.cancelInFlight) {
    incrementLoadToken();
  }

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

  // silent=true usually suppresses the IDLE flash while another audio track
  // is taking over. YouTube is the exception: leaving playback mode at
  // YouTube blocks file lifecycle transitions and play(), so clear the mode
  // after stopYouTubeMode has had a chance to broadcast YOUTUBE_STOP.
  if (opts?.silent && wasInYouTube && isYouTubeOwner()) {
    setPlaybackIdle();
  }

  // silent=true: suppress IDLE flash when play() will immediately follow (e.g. track change)
  if (!opts?.silent && !isCompatIdle()) {
    setPlaybackIdle();
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
    // silent=true is the track-change / preload-swap / system-audio-swap path
    // (a PLAY follows shortly). No silent flag means a deliberate terminal
    // stop (stopPlayback, error path, end-of-track-without-next).
    broadcast({ type: MSG.PAUSE, time: 0, reason: opts?.silent ? 'transition' : 'stop' });
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
  if (isYouTubeOwner()) {
    bus.emit('youtube:seek-to', time);
    return;
  }

  // System audio: no seek (live stream)
  if (isSystemAudioOwner()) return;

  // Host: playing → seek + broadcast
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  if (isFilePlaybackPlaying()) {
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
        // Reset playback to IDLE to prevent stuck "playing" UI.
        if (!isCompatIdle()) {
          setPlaybackIdle();
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
  // racing with the watchdog's stopPlayerNode + semantic IDLE write.
  const myLoadToken = getLoadToken();
  log.debug(`[Play] Stage 1: Validating state (offset: ${offset})`);

  if (isExternalOwner()) {
    log.warn('[Audio] Blocked play() call while an external playback mode is active');
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
  // create an AudioBufferSourceNode and mark file playback as playing,
  // overwriting PLAYING_YOUTUBE — causing double-audio and a broken UI
  // state that requires a page reload.
  if (isExternalOwner()) {
    log.warn('[Audio] Aborted play() - app switched to an external mode during async init');
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
  if (isExternalOwner()) {
    log.warn('[Audio] Aborted play() - app switched to an external mode during initAudio');
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
