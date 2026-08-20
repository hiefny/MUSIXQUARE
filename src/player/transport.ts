/**
 * MUSIXQUARE — Playback Transport
 *
 * Manages: play/pause/stop/seek, native Web Audio API buffer lifecycle,
 * supported playback-mode routing, and track position calculation.
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MANUAL_SYNC_OFFSET_LIMIT_SEC, MSG, PLAYBACK_STATE } from '../core/constants.ts';
import { clearManagedTimer, delay, getManagedTimer, setManagedTimer } from '../core/timers.ts';
import { IS_WINDOWS } from '../core/platform.ts';
import { getFilePlaybackDestination, initAudio } from '../audio/engine.ts';
import { isSystemAudioCaptureActive } from '../audio/system-audio-policy.ts';
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
import { getCurrentQueueItemId } from './queue-model.ts';
import { cancelProRoomPlaylistFileResolution } from '../pro-room/media-hooks.ts';
import {
  isProPlaybackAuthorityToken,
  routeProPlaybackCommand,
  type ProPlaybackCommitRequest,
} from '../pro-room/playback-authority-hooks.ts';
import { isProRoomTrackChangeIntentPending } from './track-change-intent.ts';
import { hasRoomCapability, isActiveStandardRoomCoordinator } from '../rooms/authority.ts';
import { loadPlaylistModule } from './playlist-loader.ts';

/** Lead time for a host command to reach guests before the shared start. */
const SCHEDULE_AHEAD_MS = 200;

/** Calibrated output advance for Windows local-file playback. */
const WINDOWS_LOCAL_FILE_OUTPUT_ADVANCE_SEC = 0.02;

/**
 * A standard-room host may move only its local AudioBuffer output while the
 * room clock remains canonical. AudioBufferSourceNode.onended then belongs to
 * the shifted local output, not to the room timeline, so natural advancement
 * needs an independent, identity-fenced canonical deadline.
 */
const STANDARD_FILE_CANONICAL_END_TIMER = 'standard-file-canonical-end';
const CANONICAL_END_EPSILON_SEC = 0.005;

// The play lock is page-global, so every timer/finally that releases it must
// prove it still belongs to the invocation that claimed it. A load epoch
// cannot serve this purpose: stopAllMedia({silent:true}) deliberately does not
// advance that epoch, while it still tears down the play-lock tuple.
let playInvocationGeneration = 0;

// A play invocation owns the page-global lock until its async setup settles,
// but PAUSE must be able to revoke the pending node start without stealing
// that lock ownership (otherwise the invocation's finally cannot unlock it).
// Keep this semantic fence separate from playInvocationGeneration.
let playStartFence = 0;

/**
 * Latest deferred node-start intent.
 *
 * `playback.pendingPlayTime` remains the cross-module pipeline mailbox used by
 * decode/fetch completion. A play-lock deferral needs more information than
 * that legacy scalar: its authority predicate and absolute scheduling
 * deadline must survive the current lock owner.
 */
interface PendingPlayIntent {
  readonly offset: number;
  readonly scheduleDelay: number;
  readonly scheduleDeadlineMs?: number;
  readonly shouldApply?: () => boolean;
}

let pendingPlayIntent: PendingPlayIntent | null = null;

function queuePendingPlayIntent(intent: PendingPlayIntent): void {
  pendingPlayIntent = intent;
  setPendingPlayTime(intent.offset);
}

function clearPendingPlayIntent(): void {
  pendingPlayIntent = null;
  setPendingPlayTime(undefined);
}

function takePendingPlayIntent(): PendingPlayIntent | null {
  const intent = pendingPlayIntent;
  pendingPlayIntent = null;
  // A decode/preload completion may have published a newer scalar mailbox
  // while this lock owner was awaiting AudioContext setup. Only consume the
  // legacy mirror when this unlock actually owns a typed lock intent.
  if (intent) setPendingPlayTime(undefined);
  return intent;
}

function claimPlayInvocation(): number {
  playInvocationGeneration += 1;
  return playInvocationGeneration;
}

function invalidatePlayInvocation(): void {
  playInvocationGeneration += 1;
}

function isCurrentPlayInvocation(invocation: number): boolean {
  return invocation === playInvocationGeneration;
}

function revokeInFlightPlayStart(): void {
  playStartFence += 1;
}

function getPlatformLocalFileOutputOffset(): number {
  return IS_WINDOWS ? WINDOWS_LOCAL_FILE_OUTPUT_ADVANCE_SEC : 0;
}

function getEffectiveLocalFileOutputOffset(): number {
  return (getState('sync.localOffset') || 0) + getPlatformLocalFileOutputOffset();
}

export function isFilePipelineBusyForPlay(): boolean {
  const lifecycle = getState('playback.lifecycle');
  return (
    lifecycle === PLAYBACK_STATE.DOWNLOADING ||
    lifecycle === PLAYBACK_STATE.AWAITING_PRELOAD ||
    lifecycle === PLAYBACK_STATE.DECODING
  );
}

import {
  getPlayerNode,
  setPlayerNode,
  getCurrentAudioBuffer,
  getCurrentLoadEpoch,
  isCurrentLoadEpoch,
  newLoadEpoch,
  incrementLoadSessionId,
  isPlayLocked,
  setPlayLocked,
  setPendingPlayTime,
  setPlayPreloadedInProgress,
  setCurrentAudioBuffer,
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

interface StopMediaOptions {
  readonly silent?: boolean;
  readonly cancelInFlight?: boolean;
  readonly clearBuffer?: boolean;
}

// ─── Track Position ────────────────────────────────────────────────

let _offsetResetQueued = false;

function readTrackPosition(repairOutOfRangeOffset: boolean): number {
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
  const manualOffset = getState('sync.localOffset') || 0;
  const localOffset = getEffectiveLocalFileOutputOffset();

  const startedAtValid =
    typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt !== 0;
  if (startedAtValid && getCurrentTime() > 0) {
    // Recover an out-of-range manual offset asynchronously so this getter does
    // not write state during a read.
    // _offsetResetQueued prevents duplicate microtasks when getTrackPosition()
    // is called multiple times in the same frame (seek bar, sync, broadcast).
    if (repairOutOfRangeOffset && Math.abs(manualOffset) > 30 && !_offsetResetQueued) {
      _offsetResetQueued = true;
      log.warn(`[Sync] Offset divergence detected: local=${manualOffset.toFixed(3)}s — resetting`);
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

export function getTrackPosition(): number {
  return readTrackPosition(true);
}

/**
 * Read the current logical position without scheduling the transport's
 * out-of-range offset repair. Diagnostics use this so observation cannot
 * mutate or mask the state that caused a sync incident.
 */
export function peekTrackPosition(): number {
  return readTrackPosition(false);
}

// ─── Play State UI ─────────────────────────────────────────────────

export function updatePlayState(playing: boolean): void {
  bus.emit('ui:update-play-state', playing);
}

// ─── Stop Player Node ──────────────────────────────────────────────

/**
 * Stop and release the active source node.
 *
 * A retired AudioBufferSourceNode can keep its AudioBuffer and callback
 * closures reachable until the rendering engine releases it, notably on
 * WebKit. Disconnect and stop first, clear onended, and best-effort clear the
 * buffer reference. Engines that reject a post-start buffer assignment throw
 * InvalidStateError, which teardown intentionally ignores.
 */
export function stopPlayerNode(): void {
  // Clear this before the node lookup: a superseded play can leave a deadline
  // behind even when WebKit has already released the concrete source node.
  clearManagedTimer(STANDARD_FILE_CANONICAL_END_TIMER);
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
    node.buffer = null;
  } catch {
    /* InvalidStateError on spec-strict engines — ignore */
  }
  setPlayerNode(null);
}

function armStandardFileCanonicalEnd(
  node: AudioBufferSourceNode,
  buffer: AudioBuffer,
  loadEpoch: number,
  queueItemId: string | null,
  delaySeconds: number,
): void {
  if (!isActiveStandardRoomCoordinator()) return;
  if (!Number.isFinite(buffer.duration) || buffer.duration <= 0.1) return;

  const isCurrentOccurrence = (): boolean =>
    isActiveStandardRoomCoordinator() &&
    isCurrentLoadEpoch(loadEpoch) &&
    getPlayerNode() === node &&
    getCurrentAudioBuffer() === buffer &&
    getCurrentQueueItemId() === queueItemId &&
    isFilePlaybackPlaying() &&
    !isExternalOwner() &&
    !getState('player.isSeeking');

  const checkCanonicalEnd = (): void => {
    if (!isCurrentOccurrence()) return;

    const remainingSeconds = buffer.duration - getTrackPosition();
    if (remainingSeconds <= CANONICAL_END_EPSILON_SEC) {
      handleEnded();
      return;
    }

    // AudioContext.currentTime freezes while Safari suspends audio in the
    // background. Re-check against that canonical clock instead of treating a
    // wall-clock timeout as an end signal. The short upper bound also makes a
    // resumed context converge without a stale long-lived timer.
    setManagedTimer(
      STANDARD_FILE_CANONICAL_END_TIMER,
      checkCanonicalEnd,
      Math.max(25, Math.min(1_000, remainingSeconds * 1_000)),
    );
  };

  setManagedTimer(
    STANDARD_FILE_CANONICAL_END_TIMER,
    checkCanonicalEnd,
    Math.max(0, delaySeconds * 1_000),
  );
}

// ─── Stop All Media ────────────────────────────────────────────────

function stopAllMediaLegacy(opts: StopMediaOptions = {}): void {
  const queueItemId = getCurrentQueueItemId();
  const wasInYouTube = isYouTubeOwner();
  const wasPreparingFile = isFilePipelineBusyForPlay();
  if (opts?.cancelInFlight) {
    newLoadEpoch();
    incrementLoadSessionId();
    cancelProRoomPlaylistFileResolution();
  }

  // Stop system audio if active (without recursive loop — cleanup only disconnects nodes)
  if (isSystemAudioCaptureActive()) {
    bus.emit('system-audio:force-stop');
  }

  // Stop YouTube. Propagate silent so stopYouTubeMode skips the
  // IDLE bounce when the caller is mid-transition to PLAYING_AUDIO (avoids
  // a brief body.mode-youtube → no-mode → mode-audio flash on YT→Local).
  bus.emit('youtube:stop-mode', { silent: !!opts?.silent });

  // Clear pending triggers.
  clearManagedTimer('preloadScheduleTimer');
  clearManagedTimer('autoPlayTimer');
  clearManagedTimer('ended-advance-retry');
  clearManagedTimer('ended-advance-next');
  // A deferred same-file replay must not survive into a replacement buffer.
  clearManagedTimer('playback-replay-defer');
  // Reset the play lock, watchdog, deferred play, and preload-activation flag
  // as one teardown unit. _internalPlay and preload activation finishers are
  // idempotent if they later observe this reset.
  invalidatePlayInvocation();
  clearManagedTimer('navigator-lock-watchdog');
  clearManagedTimer('playback-unlock-delay');
  setPlayLocked(false);
  clearPendingPlayIntent();
  setPlayPreloadedInProgress(false);

  // silent=true usually suppresses the IDLE flash while another audio track
  // is taking over. YouTube is the exception: leaving playback mode at
  // YouTube blocks file lifecycle transitions and play(), so clear the mode
  // after stopYouTubeMode has had a chance to broadcast YOUTUBE_STOP.
  if (opts?.silent && wasInYouTube && isYouTubeOwner()) {
    setPlaybackIdle();
  }

  // cancelInFlight is an authoritative teardown, including the PRO R2 fetch
  // phase that precedes ordinary decode. A silent external-mode takeover must
  // release the file-only lifecycle as well as aborting its bytes.
  if (opts?.silent && opts.cancelInFlight && wasPreparingFile) {
    setPlaybackIdle();
  }

  // silent=true: suppress IDLE flash when play() will immediately follow (e.g. track change)
  if (!opts?.silent && !isCompatIdle()) {
    setPlaybackIdle();
  }

  // Stop player node
  stopPlayerNode();
  if (opts?.clearBuffer) setCurrentAudioBuffer(null);

  // Reset master clock
  setState('player.startedAt', 0);
  setState('player.pausedAt', 0);

  // Reset the seekbar even for silent transitions; the position loop does not
  // repaint while file playback is pending.
  bus.emit('ui:seek-reset');

  // A host mirrors the stop so guests do not continue the previous track while
  // a replacement is prepared. Guest-side callers never broadcast.
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    // silent=true is the track-change / preload-swap / system-audio-swap path
    // (a PLAY follows shortly). No silent flag means a deliberate terminal
    // stop (stopPlayback, error path, end-of-track-without-next).
    broadcast({
      type: MSG.PAUSE,
      time: 0,
      queueItemId,
      reason: opts?.silent ? 'transition' : 'stop',
    });
  }
  bus.emit('visualizer:fade-out');
}

export function stopAllMedia(opts: StopMediaOptions = {}): void {
  stopAllMediaLegacy(opts);
}

/**
 * Ordered variant for cross-mode transitions. Teardown executes synchronously;
 * the Promise-shaped API keeps callers simple at asynchronous ownership seams.
 */
export async function stopAllMediaAsync(options: StopMediaOptions = {}): Promise<boolean> {
  stopAllMediaLegacy(options);
  return true;
}

// ─── Seek ──────────────────────────────────────────────────────────

/**
 * Unified seek handler for every role and supported playback mode.
 */
export function seekTo(time: number): void {
  if (isGuestBlocked()) return;
  const hostConn = getState('network.hostConn');
  const canControlPlayback = hasRoomCapability('playback.control');
  const queueItemId = getCurrentQueueItemId();

  if (
    !isSystemAudioOwner() &&
    routeProPlaybackCommand(
      {
        kind: 'seek',
        queueItemId,
        positionSeconds: Number.isFinite(time) ? Math.max(0, time) : 0,
      },
      {
        wasPlaying: getState('playback.activity') === 'playing',
      },
    )
  ) {
    return;
  }

  // OP guest: request host to seek
  if (hostConn && canControlPlayback) {
    if (queueItemId) sendToHost({ type: MSG.REQUEST_SEEK, time, queueItemId });
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

  // A busy file pipeline still holds the previous track's buffer. Ignore seek;
  // decode completion owns playback for the newly selected track.
  if (isFilePipelineBusyForPlay()) {
    log.debug('[Seek] Ignoring seek while file pipeline is preparing');
    return;
  }

  // Host: playing → seek + broadcast
  if (isFilePlaybackPlaying()) {
    if (!queueItemId) return;
    play(time);
    broadcast({
      type: MSG.PLAY,
      time,
      queueItemId,
      hostPlayAt: getHostNow() + SCHEDULE_AHEAD_MS,
    });
  } else {
    // Paused: update position + broadcast
    setState('player.pausedAt', time);
    broadcast({ type: MSG.PAUSE, time, queueItemId, reason: 'seek' });
  }
}

// ─── Play ──────────────────────────────────────────────────────────

export async function play(
  offset: number,
  scheduleDelay = 0,
  scheduleDeadlineMs?: number,
  shouldApply?: () => boolean,
): Promise<void> {
  if (shouldApply?.() === false) return;
  if (isPlayLocked()) {
    log.warn('[Play] Blocked: queuing play request');
    queuePendingPlayIntent({ offset, scheduleDelay, scheduleDeadlineMs, shouldApply });
    return;
  }
  // Source-level guard for callers that reach play during a file load. The
  // resident buffer belongs to the previous track, so queue the requested time
  // for the pipeline-completion path instead of starting stale audio.
  if (isFilePipelineBusyForPlay()) {
    log.warn('[Play] Deferred: file pipeline busy — queuing as pendingPlayTime');
    // Decode/fetch completion owns this legacy cross-module mailbox. It cannot
    // preserve callable authority predicates, so keep it separate from the
    // play-lock mailbox and let the pipeline's queue/session fences decide
    // whether it is still current.
    pendingPlayIntent = null;
    setPendingPlayTime(offset);
    return;
  }
  // A stale unlock callback should already be owner-gated, but clearing it at
  // claim time also keeps the named timer registry aligned with the lock.
  clearManagedTimer('playback-unlock-delay');
  const myPlayInvocation = claimPlayInvocation();
  const myPlayStartFence = playStartFence;
  setPlayLocked(true);

  const lockStartTime = Date.now();
  setManagedTimer(
    'navigator-lock-watchdog',
    () => {
      if (isCurrentPlayInvocation(myPlayInvocation) && isPlayLocked()) {
        log.warn(
          `[Play] Lock Timeout: Forcing unlock after 15s (locked at ${new Date(lockStartTime).toISOString()})`,
        );
        // Invalidate before releasing the tuple. The wedged invocation can
        // still resume later, but its finally must not touch a newer owner.
        invalidatePlayInvocation();
        // Reset the lock, deferred play, source node, load epoch, and semantic
        // playback state together. Clear pendingPlayTime before unlocking so
        // the queued-request consumer observes a consistent empty mailbox.
        setPlayLocked(false);
        clearPendingPlayIntent();
        stopPlayerNode();
        // Allocate a new load epoch so any in-flight _internalPlay aborts at
        // its next await checkpoint instead of overwriting the post-watchdog
        // IDLE state with PLAYING_AUDIO and starting a phantom
        // AudioBufferSourceNode.
        // Guest finalization intentionally ignores this epoch and checks its
        // own load/transfer session ownership instead.
        newLoadEpoch();
        // Reset playback to IDLE to prevent stuck "playing" UI.
        if (!isCompatIdle()) {
          setPlaybackIdle();
        }
      }
    },
    15000,
  );

  try {
    await _internalPlay(offset, scheduleDelay, scheduleDeadlineMs, shouldApply, myPlayStartFence);
  } finally {
    if (isCurrentPlayInvocation(myPlayInvocation)) {
      clearManagedTimer('navigator-lock-watchdog');
      setManagedTimer(
        'playback-unlock-delay',
        () => {
          if (!isCurrentPlayInvocation(myPlayInvocation)) return;
          invalidatePlayInvocation();
          setPlayLocked(false);
          // Consume queued play request (e.g. sync correction that arrived during lock)
          const pendingIntent = takePendingPlayIntent();
          if (pendingIntent) {
            if (pendingIntent.shouldApply?.() === false) {
              log.debug('[Play] Dropping superseded queued play request');
              return;
            }
            log.debug(`[Play] Consuming queued play request: ${pendingIntent.offset.toFixed(2)}s`);
            void play(
              pendingIntent.offset,
              pendingIntent.scheduleDelay,
              pendingIntent.scheduleDeadlineMs,
              pendingIntent.shouldApply,
            );
          }
        },
        10,
      );
    }
  }
}

async function _internalPlay(
  offset: number,
  scheduleDelay = 0,
  scheduleDeadlineMs?: number,
  shouldApply?: () => boolean,
  expectedPlayStartFence = playStartFence,
): Promise<void> {
  clearPendingPlayIntent();
  // Snapshot the load epoch at entry. If the play()-level watchdog fires
  // (or another path allocates a new epoch, e.g. track switch), every await
  // checkpoint below will see a superseded epoch and abort cleanly instead
  // of racing with the watchdog's stopPlayerNode + semantic IDLE write.
  const myLoadEpoch = getCurrentLoadEpoch();
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

  if (shouldApply?.() === false || expectedPlayStartFence !== playStartFence) return;

  if (!isCurrentLoadEpoch(myLoadEpoch)) {
    log.warn('[Play] Aborted — load epoch superseded during ensureRunning');
    return;
  }

  // ── Post-await mode re-check ──────────────────────────────────────
  // Another playback mode may have taken ownership during asynchronous audio
  // setup, so validate again before creating a file source node.
  if (isExternalOwner()) {
    log.warn('[Audio] Aborted play() - app switched to an external mode during async init');
    return;
  }

  const _currentAudioBuffer = getCurrentAudioBuffer();
  const hasBufferSource = !!_currentAudioBuffer;

  if (!hasBufferSource) {
    log.warn('[Play] No media source available');
    // Surface an empty playlist instead of silently ignoring Play.
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

  if (shouldApply?.() === false || expectedPlayStartFence !== playStartFence) return;

  if (!isCurrentLoadEpoch(myLoadEpoch)) {
    log.warn('[Play] Aborted — load epoch superseded during initAudio');
    return;
  }

  // Re-check after second async gap (initAudio)
  if (isExternalOwner()) {
    log.warn('[Audio] Aborted play() - app switched to an external mode during initAudio');
    return;
  }

  const ctx = getAudioContext();

  // 1. Get the current output sync offset (manual nudge + hidden platform compensation)
  const localOffset = getEffectiveLocalFileOutputOffset();

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

  // Authority commits carry an absolute participant-local deadline. Audio
  // setup above can itself await; recomputing the remaining lead here keeps
  // that setup latency from being added a second time. Existing callers keep
  // their established relative-delay behavior.
  const effectiveScheduleDelay = Number.isFinite(scheduleDeadlineMs)
    ? Math.max(0, (Number(scheduleDeadlineMs) - performance.now()) / 1000)
    : scheduleDelay;
  if (Number.isFinite(scheduleDeadlineMs)) {
    safeOffset += Math.max(0, performance.now() - Number(scheduleDeadlineMs)) / 1_000;
    if (duration > 0) safeOffset = Math.max(0, Math.min(duration - 0.001, safeOffset));
  }

  if (shouldApply?.() === false || expectedPlayStartFence !== playStartFence) return;

  // Buffer Mode playback
  let startedSourceNode: AudioBufferSourceNode | null = null;
  const standardHostOwnsCanonicalEnd = isActiveStandardRoomCoordinator();
  if (_currentAudioBuffer) {
    stopPlayerNode();
    const newNode = ctx.createBufferSource();
    newNode.buffer = _currentAudioBuffer;
    setPlayerNode(newNode);
    startedSourceNode = newNode;

    const isSurroundMode = getState('audio.isSurroundMode');
    const surroundChannelIndex = getState('audio.surroundChannelIndex');

    if (isSurroundMode) {
      // The audio graph owns a stable route, so the source node itself
      // never changes routing ownership when the selected channel changes.
      bus.emit('audio:connect-surround', surroundChannelIndex);
      log.debug(`[BufferMode] Playing in 7.1 Surround (Ch: ${surroundChannelIndex})`);
    } else {
      log.debug('[BufferMode] Playing in Stereo');
    }

    // Every backend connects exactly once to the stable route input. Surround
    // changes only rewire nodes downstream of that input, so toggling a role
    // never recreates or restarts this source.
    const destination = getFilePlaybackDestination();
    if (destination) newNode.connect(destination);

    // Use the onended slot because stopPlayerNode clears that exact callback.
    // addEventListener + `onended = null` would leave the closure (and its
    // captured load epoch) attached to retired WebKit source nodes.
    newNode.onended = () => {
      if (!isCurrentLoadEpoch(myLoadEpoch)) return;
      // For an active standard host the local source may end on either side
      // of the room boundary. Even a tiny positive offset (including the
      // Windows output compensation) falls inside handleEnded's tolerance,
      // so the canonical deadline must be the sole natural-end owner.
      if (standardHostOwnsCanonicalEnd) return;
      if (isFilePlaybackPlaying()) {
        handleEnded();
      }
    };

    // Determine the exact audio-context time to start
    const startWhen = effectiveScheduleDelay > 0 ? ctx.currentTime + effectiveScheduleDelay : 0;

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
  const startedAt = getCurrentTime() + effectiveScheduleDelay - safeOffset + localOffset;
  setState('player.startedAt', startedAt);
  setState('player.pausedAt', safeOffset);
  log.debug(`[BufferMode] Started at ${safeOffset}s (startedAt: ${startedAt})`);

  setPlaybackFilePlaying();

  if (startedSourceNode && _currentAudioBuffer) {
    armStandardFileCanonicalEnd(
      startedSourceNode,
      _currentAudioBuffer,
      myLoadEpoch,
      getCurrentQueueItemId(),
      effectiveScheduleDelay + Math.max(0, duration - safeOffset),
    );
  }

  if (!getState('network.hostConn')) {
    transition({
      type: 'PLAY',
      time: safeOffset,
      queueItemId: getCurrentQueueItemId(),
      sameTrack: true,
    });
  }

  bus.emit('visualizer:start');
  bus.emit('ui:loop-start');
}

// ─── Pause ─────────────────────────────────────────────────────────

export function pause(
  forcedTime?: number,
  opts?: { holdVisualizer?: boolean; showToast?: boolean },
): void {
  // PAUSE is newer than any node start waiting behind the play lock. Revoke
  // the complete intent before checking concrete media ownership so a late
  // unlock cannot resurrect audio after an authoritative pause.
  clearPendingPlayIntent();
  revokeInFlightPlayStart();
  if (isFileTransportInactive()) return;

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
  // Publish the exact pause position before the activity transition. Seekbar
  // observers run synchronously from that transition and must never repaint a
  // previous pause position for one frame.
  setState('player.pausedAt', pausePos);
  setPlaybackFilePaused();

  if (!getState('network.hostConn')) {
    transition({
      type: 'PAUSE',
      time: pausePos,
      queueItemId: getCurrentQueueItemId(),
      endOfPlaylist: false,
    });
  }

  if (opts?.showToast ?? true) {
    showToast(t('common.pause'));
  }
}

// ─── Handle Track Ended ────────────────────────────────────────────

let proAuthorityFileCommitGeneration = 0;

/** Apply a revision-validated PRO commit to the resident AudioBuffer. */
export async function applyProPlaybackFileCommit(
  request: Readonly<ProPlaybackCommitRequest>,
): Promise<boolean> {
  if (
    !isProPlaybackAuthorityToken(request.authority) ||
    request.state === 'idle' ||
    !request.queueItemId ||
    getState('room.context').kind !== 'pro' ||
    getCurrentQueueItemId() !== request.queueItemId ||
    getState('files.current')?.queueItemId !== request.queueItemId ||
    !getCurrentAudioBuffer()
  ) {
    return false;
  }
  const generation = ++proAuthorityFileCommitGeneration;
  const isCurrentAuthority = () =>
    generation === proAuthorityFileCommitGeneration && request.isCurrent?.() !== false;

  const positionSeconds = Number.isFinite(request.positionSeconds)
    ? Math.max(0, request.positionSeconds)
    : 0;
  const delayMs = Number.isFinite(request.scheduleDelayMs)
    ? Math.max(0, Math.min(30_000, request.scheduleDelayMs))
    : 0;

  if (request.state === 'playing') {
    const scheduleDeadlineMs = performance.now() + delayMs;
    await play(positionSeconds, delayMs / 1000, scheduleDeadlineMs, isCurrentAuthority);
    return (
      isCurrentAuthority() &&
      getCurrentQueueItemId() === request.queueItemId &&
      getState('playback.activity') === 'playing'
    );
  }

  // The scheduled pause may intentionally wait for its rendezvous instant,
  // but an older queued play must not become audible during that wait.
  clearPendingPlayIntent();

  if (delayMs > 0) await delay(delayMs);
  if (
    !isCurrentAuthority() ||
    getState('room.context').kind !== 'pro' ||
    getCurrentQueueItemId() !== request.queueItemId ||
    getState('files.current')?.queueItemId !== request.queueItemId
  ) {
    return false;
  }

  stopPlayerNode();
  setState('player.pausedAt', positionSeconds);
  setPlaybackFilePaused();
  transition({
    type: 'PAUSE',
    time: positionSeconds,
    queueItemId: request.queueItemId,
    endOfPlaylist: false,
  });
  const duration = getCurrentAudioBuffer()?.duration ?? 0;
  bus.emit(
    'ui:time-update',
    fmtTime(positionSeconds),
    fmtTime(duration),
    positionSeconds,
    duration,
  );
  bus.emit('ui:update-play-state', false);
  return true;
}

export function handleEnded(): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Guests don't handle track-end

  const _currentAudioBuffer = getCurrentAudioBuffer();

  const hasBufferDuration = !!(
    _currentAudioBuffer &&
    Number.isFinite(_currentAudioBuffer.duration) &&
    _currentAudioBuffer.duration > 0.1
  );

  const duration = hasBufferDuration ? _currentAudioBuffer!.duration : 0;
  if (!duration || !Number.isFinite(duration) || duration <= 0.1) return;
  if (isFileTransportInactive()) return;
  if (isExternalOwner()) return;

  const curr = getTrackPosition();
  const isSeeking = getState('player.isSeeking');
  if (isSeeking) {
    log.debug('[handleEnded] Ignoring end signal while seeking');
    return;
  }

  const endEpsilon = isActiveStandardRoomCoordinator() ? CANONICAL_END_EPSILON_SEC : 0.05;
  if (curr >= duration - endEpsilon) {
    log.debug(`Track ended at ${curr.toFixed(2)}s / ${duration.toFixed(2)}s`);
    const queueItemId = getCurrentQueueItemId();
    if (
      queueItemId &&
      routeProPlaybackCommand({
        kind: 'ended',
        queueItemId,
        positionSeconds: curr,
        observedPositionSeconds: curr,
        durationSeconds: duration,
        mediaKind: 'file',
      })
    ) {
      return;
    }
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

  const wasPlaying = getState('playback.activity') === 'playing';
  const playlistItems = getState('playlist.items') || [];
  const currentQueueItemId = getCurrentQueueItemId();

  if (
    !wasPlaying &&
    playlistItems.length === 0 &&
    !currentQueueItemId &&
    !isSystemAudioOwner() &&
    !isYouTubeOwner()
  ) {
    showToast(t('toast.add_media_to_play'));
    bus.emit('ui:reveal-media-source');
    return;
  }

  if (
    !isSystemAudioOwner() &&
    routeProPlaybackCommand(
      {
        kind: wasPlaying ? 'pause' : 'play',
        queueItemId: getCurrentQueueItemId(),
        positionSeconds: getTrackPosition(),
      },
      { wasPlaying },
    )
  ) {
    return;
  }

  // A PRO member can request a persistent row while its own R2 preparation is
  // still pending. Until an authoritative selection/prepare arrives,
  // the local owner may still be the previous YouTube row; never let Play
  // toggle that stale owner during this request gap.
  if (isProRoomTrackChangeIntentPending()) {
    log.debug('[Play] Ignoring toggle while a PRO track change is pending');
    return;
  }

  const hostConn = getState('network.hostConn');
  const canControlPlayback = hasRoomCapability('playback.control');

  // YouTube mode
  if (isYouTubeOwner()) {
    bus.emit('youtube:toggle-play');
    return;
  }

  // System audio: ignore play/pause toggle (use "공유 중지" button instead)
  if (isSystemAudioOwner()) return;

  // During download/decode, the resident AudioBuffer may still belong to the
  // previous track. Ignore play until the file pipeline reaches a playable state.
  if (isFilePipelineBusyForPlay()) {
    log.debug('[Play] Ignoring toggle while file pipeline is preparing');
    return;
  }

  const isActuallyPlaying = isFilePlaybackPlaying();
  const pausedAt = getState('player.pausedAt') || 0;

  // Deselected state (e.g. after end-of-playlist reset): no track is selected
  // but the playlist is non-empty. Pressing play should restart from track 0
  // rather than silently resuming the stale audio buffer with "미디어 없음"
  // still showing in the title.
  if (!isActuallyPlaying && !currentQueueItemId && playlistItems.length > 0) {
    const firstItem = playlistItems[0];
    const firstQueueItemId = firstItem?.queueItemId;
    if (!firstQueueItemId) return;
    if (!hostConn) {
      void loadPlaylistModule()
        .then((mod) => mod.playTrack(firstQueueItemId))
        .catch((error) => {
          log.warn('[Play] Failed to restart the first playlist item:', error);
          showToast(t('error.network_generic'));
        });
    } else if (canControlPlayback) {
      sendToHost({ type: MSG.REQUEST_TRACK_CHANGE, queueItemId: firstQueueItemId });
    }
    return;
  }

  // A failed/purged file fetch must never broadcast PLAY for a queue ID whose
  // resident PCM is missing (the previous buffer may have belonged to another
  // row). On the local-authority path, treat Play as an explicit retry of the
  // selected row; standard-room guests continue to request playback below.
  if (!hostConn && !isActuallyPlaying && currentQueueItemId) {
    const selectedItem = playlistItems.find((item) => item.queueItemId === currentQueueItemId);
    const resident = getState('files.current');
    if (
      selectedItem?.type === 'file' &&
      (!getCurrentAudioBuffer() || resident?.queueItemId !== currentQueueItemId)
    ) {
      void loadPlaylistModule()
        .then((mod) => mod.playTrack(currentQueueItemId))
        .catch((error) => {
          log.warn('[Play] Failed to retry the selected playlist item:', error);
          showToast(t('error.network_generic'));
        });
      return;
    }
  }

  // A natural track end stops playback immediately, then playlist.ts advances
  // on a short managed timer. On slower devices a file can be appended and play
  // tapped while the selected queue ID and resident AudioBuffer still belong
  // to the ended occurrence. Honor the tap as "advance now" instead of replaying it.
  if (!hostConn && !isActuallyPlaying && getManagedTimer('ended-advance-next')) {
    void loadPlaylistModule()
      .then((mod) => mod.playNextTrack())
      .catch((error) => {
        log.warn('[Play] Failed to advance the playlist after track end:', error);
        showToast(t('error.network_generic'));
      });
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
      broadcast({
        type: MSG.PAUSE,
        time: getState('player.pausedAt'),
        queueItemId: currentQueueItemId,
        reason: 'pause',
      });
    } else if (canControlPlayback) {
      if (currentQueueItemId) {
        sendToHost({ type: MSG.REQUEST_PAUSE, queueItemId: currentQueueItemId });
      }
    }
  } else {
    if (!hostConn) {
      if (!currentQueueItemId) return;
      play(pausedAt);
      broadcast({
        type: MSG.PLAY,
        time: pausedAt,
        queueItemId: currentQueueItemId,
        hostPlayAt: getHostNow() + SCHEDULE_AHEAD_MS,
      });
    } else if (canControlPlayback) {
      if (currentQueueItemId) {
        sendToHost({ type: MSG.REQUEST_PLAY, time: pausedAt, queueItemId: currentQueueItemId });
      }
    }
  }
}

// ─── Stop Playback ─────────────────────────────────────────────────

export function stopPlayback(): void {
  if (isGuestBlocked()) return;

  const hostConn = getState('network.hostConn');
  const canControlPlayback = hasRoomCapability('playback.control');
  if (hostConn && canControlPlayback) {
    const queueItemId = getCurrentQueueItemId();
    if (!queueItemId) return;
    try {
      hostConn.send({ type: MSG.REQUEST_SEEK, time: 0, queueItemId });
    } catch (e) {
      log.debug('[Transport] send REQUEST_SEEK:', e);
    }
    try {
      hostConn.send({ type: MSG.REQUEST_PAUSE, queueItemId });
    } catch (e) {
      log.debug('[Transport] send REQUEST_PAUSE:', e);
    }
    showToast(t('toast.stop_sent'));
    return;
  }

  const wasCompatIdle = isCompatIdle();

  if (!wasCompatIdle && isSystemAudioPlaying()) {
    bus.emit('system-audio:stop');
    return;
  }

  if (
    !wasCompatIdle &&
    routeProPlaybackCommand({
      kind: 'stop',
      queueItemId: getCurrentQueueItemId(),
      positionSeconds: 0,
    })
  ) {
    return;
  }

  if (wasCompatIdle) return; // Nothing to stop

  if (isYouTubeOwner()) {
    // Broadcast before clearing local ownership; stopYouTubeMode cannot infer
    // the prior mode after setPlaybackIdle, and guests need the explicit stop.
    const queueItemId = getCurrentQueueItemId();
    if (!hostConn && queueItemId) broadcast({ type: MSG.YOUTUBE_STOP, queueItemId });
    // Set IDLE before stop-playback to prevent onYouTubePlayerStateChange ENDED
    // from triggering playlist:next-track (its guard checks YouTube playback mode).
    // Do NOT reorder the idle write after the emits — that re-opens the
    // stopVideo()→ENDED→next-track advance race this ordering suppresses.
    setPlaybackIdle();
    bus.emit('youtube:stop-playback');
    bus.emit('youtube:stop-mode');
    clearManagedTimer('autoPlayTimer');
    clearManagedTimer('ended-advance-retry');
    clearManagedTimer('ended-advance-next');
    setState('player.pausedAt', 0);
    return;
  }

  stopAllMedia({ cancelInFlight: true });
  bus.emit('ui:seek-reset');

  if (!hostConn) {
    broadcast({ type: MSG.PAUSE, time: 0, queueItemId: getCurrentQueueItemId(), reason: 'stop' });
  }
  showToast(t('common.stop'));
}

// ─── Skip Time ─────────────────────────────────────────────────────

export function skipTime(sec: number): void {
  if (isGuestBlocked()) return;

  const hostConn = getState('network.hostConn');
  const canControlPlayback = hasRoomCapability('playback.control');
  const queueItemId = getCurrentQueueItemId();
  if (hostConn && canControlPlayback) {
    if (queueItemId) sendToHost({ type: MSG.REQUEST_SKIP_TIME, sec, queueItemId });
    return;
  }

  // Cancel pending auto-play on manual interaction (Host only)
  if (!hostConn && getManagedTimer('autoPlayTimer')) {
    clearManagedTimer('autoPlayTimer');
    showToast(t('toast.auto_play_canceled'));
  }

  if (isCompatIdle()) return;
  if (isSystemAudioOwner()) return; // No skip on live stream
  const requestedSkipTarget = Math.max(0, getTrackPosition() + (Number.isFinite(sec) ? sec : 0));
  if (
    routeProPlaybackCommand(
      {
        kind: 'seek',
        queueItemId,
        positionSeconds: requestedSkipTarget,
      },
      {
        wasPlaying: getState('playback.activity') === 'playing',
      },
    )
  ) {
    return;
  }
  if (isYouTubeOwner()) {
    bus.emit('youtube:skip-time', sec);
    return;
  }

  // Ignore skip requests while the resident buffer belongs to a prior track.
  if (isFilePipelineBusyForPlay()) {
    log.debug('[Skip] Ignoring skip while file pipeline is preparing');
    return;
  }

  const _currentAudioBuffer = getCurrentAudioBuffer();
  const current = getTrackPosition();
  let target = current + sec;
  const rawBufDur = _currentAudioBuffer?.duration;
  const duration = rawBufDur != null && Number.isFinite(rawBufDur) && rawBufDur > 0 ? rawBufDur : 0;

  if (target < 0) target = 0;
  if (duration > 0 && target > duration) target = Math.max(0, duration - 0.1);

  const isPlaying = isFilePlaybackPlaying();

  if (isPlaying) {
    if (!queueItemId) return;
    play(target);
    broadcast({
      type: MSG.PLAY,
      time: target,
      queueItemId,
      hostPlayAt: getHostNow() + SCHEDULE_AHEAD_MS,
    });
  } else {
    setState('player.pausedAt', target);
    broadcast({ type: MSG.PAUSE, time: target, queueItemId, reason: 'seek' });
  }
}

// ─── Adjust Sync ───────────────────────────────────────────────────

/**
 * How long to wait after the last nudge click before re-playing the audio.
 *
 * Each nudge updates sync.localOffset immediately, then a short debounce
 * rebuilds the AudioBufferSourceNode once for the burst. Reading the track
 * position at timer fire avoids replaying a click-time position that became
 * stale while the play lock was held.
 */
const NUDGE_REPLAY_DEBOUNCE_MS = 60;

function clampManualSyncOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MANUAL_SYNC_OFFSET_LIMIT_SEC, Math.min(MANUAL_SYNC_OFFSET_LIMIT_SEC, value));
}

export function setLocalManualSyncOffset(nextOffset: number): number {
  const prevOffset = getState('sync.localOffset') || 0;
  const next = clampManualSyncOffset(nextOffset);
  if (next === prevOffset) return next;

  setState('sync.localOffset', next);

  // Keep the logical track position stable when changing only the manual
  // output offset. The fresh play() below will rebuild the audio node at the
  // new audible offset; this prevents the UI/sync position from jumping by
  // the same delta before that replay lands.
  if (!isFileTransportInactive()) {
    const startedAt = getState('player.startedAt');
    if (typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt !== 0) {
      setState('player.startedAt', startedAt + (next - prevOffset));
    }
  }

  return next;
}

export function adjustSync(val: number): void {
  const localOffset = getState('sync.localOffset') || 0;
  setLocalManualSyncOffset(localOffset + val);
  bus.emit('sync:display-update');

  if (isFileTransportInactive()) {
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
      // Re-check playback state at fire time — user may have paused during the burst.
      if (isFileTransportInactive()) return;
      play(getTrackPosition());
    },
    NUDGE_REPLAY_DEBOUNCE_MS,
  );
}
