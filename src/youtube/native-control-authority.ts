/**
 * Promotes unowned YouTube iframe play/pause observations to room authority.
 *
 * iOS may route AirPods/lock-screen controls to the iframe's own media session
 * and never call the top-level navigator.mediaSession handler. This runtime
 * instruments application-issued playVideo()/pauseVideo() calls and treats only
 * the remaining stable transitions as native iframe controls.
 */

import { MSG, type PlaybackActivityValue } from '../core/constants.ts';
import { bus, createBusScope, type BusScope } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { getPlaylistSubItems } from './queue-manifest.ts';
import { clearManagedTimer, getManagedTimer, setManagedTimer } from '../core/timers.ts';
import { safeSend } from '../network/peer.ts';
import { getCurrentQueueItemId, getQueueItemById } from '../player/queue-model.ts';
import { isPlaybackActivityValue } from '../player/ownership.ts';
import { routeProPlaybackCommand } from '../pro-room/playback-authority-hooks.ts';
import { getRoomContext, hasRoomCapability } from '../rooms/authority.ts';
import type { QueueItemId } from '../types/index.ts';
import {
  getYouTubePlayer,
  getCurrentSessionId,
  getYtAutoplayIntent,
  isYtIndexing,
  isYtLoadInProgress,
  isYtPrimeBouncePending,
  isYtPriming,
  setLocalYouTubePaused,
  setYtAutoplayIntent,
  type YouTubePlayerInstance,
} from './_state.ts';
import {
  isStandardHostYouTubeLocalStartPending,
  PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER,
  toCanonicalYouTubeTime,
} from './local-offset.ts';
import { isStandardHostManualOffsetTransactionPending } from './standard-host-manual-offset-gate.ts';
import {
  classifyYouTubeStableStateOrigin,
  clearYouTubeStableControlExpectations,
  expectYouTubeStableActivity,
  instrumentYouTubeStableControls,
  canObserveYouTubeNativeSeek,
  getYouTubeControlRevision,
  isYouTubeProgrammaticSeekPending,
  observeYouTubeProgrammaticSeekState,
  type YouTubeStableActivity,
} from './native-control-origin.ts';
import {
  decideNativeYouTubeControlRoute,
  type NativeYouTubeMediaAction,
} from './native-control-policy.ts';
import { getLocalYouTubeAudibleOutputDelayMs } from './play-latency.ts';

const RECENT_NATIVE_ACTION_MS = 2_500;
const LOCAL_REJOIN_FALLBACK_MS = 250;
const LOCAL_REJOIN_TIMER = 'yt-native-control-local-rejoin';

interface RecentNativeAction {
  action: NativeYouTubeMediaAction;
  queueItemId: QueueItemId;
  handledAt: number;
}

interface PendingLocalRejoin {
  player: YouTubePlayerInstance;
  queueItemId: QueueItemId;
}

let scope: BusScope | null = null;
let previousActivity: PlaybackActivityValue = getState('playback.activity');
let recentNativeAction: RecentNativeAction | null = null;
let pendingLocalRejoin: PendingLocalRejoin | null = null;
interface PositionSample {
  player: YouTubePlayerInstance;
  queueItemId: QueueItemId;
  sessionId: number;
  videoId: string;
  subIndex: number | null;
  revision: number;
  position: number;
  duration: number;
  state: number;
  manualOffset: number;
  outputOffset: number;
  connection: object;
  at: number;
  wallAt: number;
}
let positionSample: PositionSample | null = null;
let nativeSeek: { player: YouTubePlayerInstance; state: number; expiresAt: number } | null = null;
let seekFeedback: { player: YouTubePlayerInstance; state: number } | null = null;
let hostAdActive = false;

function resetNativeSeekObservation(): void {
  positionSample = null;
  nativeSeek = null;
  seekFeedback = null;
}

function handleNativeSeekWindowBlur(): void {
  // Focusing a child iframe blurs this window while the document stays focused.
  if (!document.hasFocus()) resetNativeSeekObservation();
}

export function setYouTubeNativeControlHostAdActive(active: boolean): void {
  if (hostAdActive !== active) positionSample = null;
  hostAdActive = active;
}

function stableActivity(value: PlaybackActivityValue): YouTubeStableActivity | null {
  if (value === 'playing' || value === 'paused') return value;
  return null;
}

function mediaAction(activity: YouTubeStableActivity): NativeYouTubeMediaAction {
  return activity === 'playing' ? 'play' : 'pause';
}

function ensureCurrentPlayerInstrumented(): boolean {
  const player = getYouTubePlayer();
  if (!player) return false;
  const supported = instrumentYouTubeStableControls(player);
  if (!supported) {
    log.debug('[YouTube Native Control] Stable player methods are not instrumentable');
  }
  return supported;
}

function handlePlayerReady(): void {
  const player = getYouTubePlayer();
  if (!player || !ensureCurrentPlayerInstrumented()) return;
  expectYouTubeStableActivity(player, getYtAutoplayIntent() ? 'playing' : 'paused');
}

function hasProtectedTransitionOwner(): boolean {
  // A seek can emit stable callbacks without another playVideo/pauseVideo
  // command. While synchronization owns that seek, unmatched callbacks are
  // operation output, not fresh OS/headset input. Use the active owner rather
  // than synthetic seek expectations that could swallow a later real PAUSE.
  return (
    isYtLoadInProgress() ||
    isYtIndexing() ||
    isYtPriming() ||
    isYtPrimeBouncePending() ||
    isStandardHostYouTubeLocalStartPending() ||
    isStandardHostManualOffsetTransactionPending() ||
    [
      PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER,
      'yt-auto-sync',
      'yt-clock-action',
      'yt-seek-play',
      'yt-rendezvous-buffer',
      'yt-rendezvous-play',
      'yt-rendezvous-calibrate',
    ].some((name) => getManagedTimer(name) !== null)
  );
}

function resolveIntendedVideoId(queueItemId: QueueItemId): string | null {
  const item = getQueueItemById(queueItemId);
  if (!item || item.type !== 'youtube') return null;
  const subIndex = getState('youtube.currentSubIndex') ?? 0;
  if (item.playlistId) {
    const ids = getPlaylistSubItems(item)?.ids;
    const subVideoId = ids?.[subIndex];
    if (subVideoId) return subVideoId;
    if (subIndex > 0) return null;
  }
  return item.videoId || null;
}

function playerMatchesCurrentOccurrence(
  player: YouTubePlayerInstance,
  queueItemId: QueueItemId,
): boolean {
  let liveVideoId: string;
  try {
    liveVideoId = player.getVideoData?.()?.video_id || '';
  } catch {
    return false;
  }
  const intendedVideoId = resolveIntendedVideoId(queueItemId);
  return !(liveVideoId && intendedVideoId && liveVideoId !== intendedVideoId);
}

/**
 * Preserve a trusted OS/headset PLAY long enough for room authority
 * to observe and promote it. Canonical pause commands deliberately leave
 * `ytAutoplayIntent=false`; without this pre-guard seam the iframe's
 * PLAYING callback immediately pauses back before playback activity can
 * reach the native-control authority listener.
 *
 * Only an unmatched native transition from the exact current iframe and
 * queue occurrence may cross the guard. Application-owned play/load/cue
 * transitions retain the existing pause-back behaviour.
 */
export function preserveNativeControllerPlayBeforeAutoplayGuard(
  player: YouTubePlayerInstance,
): boolean {
  if (
    getYtAutoplayIntent() ||
    getState('playback.mode') !== 'youtube' ||
    (getRoomContext().kind === 'standard' &&
      !!getState('network.hostConn') &&
      !getState('network.hostConn')?.open) ||
    !hasRoomCapability('playback.control') ||
    getYouTubePlayer() !== player ||
    !canObserveYouTubeNativeSeek(player) ||
    (seekFeedback?.player === player && seekFeedback.state === 1) ||
    hasProtectedTransitionOwner()
  ) {
    return false;
  }

  const queueItemId = getCurrentQueueItemId();
  if (!queueItemId || !playerMatchesCurrentOccurrence(player, queueItemId)) return false;
  if (classifyYouTubeStableStateOrigin(player, 'playing') !== 'native') return false;

  setYtAutoplayIntent(true);
  log.info('[YouTube Native Control] Preserved native controller PLAY through autoplay guard');
  return true;
}

export function observeYouTubeNativeControlState(
  player: YouTubePlayerInstance,
  state: number,
): void {
  seekFeedback = null;
  const programmatic = observeYouTubeProgrammaticSeekState(player, state);
  const nativePending = nativeSeek?.player === player && performance.now() <= nativeSeek.expiresAt;
  const nativePositionChange = observeYouTubeNativeControlPosition(player, programmatic);
  if (programmatic || nativePending || nativePositionChange) seekFeedback = { player, state };
  // Preserve this callback's origin above before relinquishing the operation.
  if ((nativePending || nativePositionChange) && state === nativeSeek?.state) nativeSeek = null;
}

/** There is no cross-origin iframe seek event. Keep a recent baseline before
 * the first click enters the iframe, but only promote a jump while that exact
 * visible iframe has focus. Ambiguous gaps/ads/owned operations reset the
 * baseline instead of moving the room. The UI tick passes its shared
 * getVideoData() reader as `videoDataSource`, so a tick reads the iframe once. */
export function observeYouTubeNativeControlPosition(
  player: YouTubePlayerInstance,
  programmaticCallback = false,
  videoDataSource: Pick<YouTubePlayerInstance, 'getVideoData'> = player,
): boolean {
  const hostConn = getState('network.hostConn');
  if (
    getRoomContext().kind !== 'standard' ||
    !hostConn?.open ||
    !hasRoomCapability('playback.control') ||
    getYouTubePlayer() !== player ||
    getState('playback.mode') !== 'youtube' ||
    document.hidden ||
    !document.hasFocus() ||
    hostAdActive ||
    hasProtectedTransitionOwner() ||
    !canObserveYouTubeNativeSeek(player) ||
    programmaticCallback ||
    isYouTubeProgrammaticSeekPending(player)
  ) {
    positionSample = null;
    return false;
  }
  try {
    const queueItemId = getCurrentQueueItemId();
    const videoId = videoDataSource.getVideoData?.()?.video_id || '';
    const state = player.getPlayerState();
    const position = player.getCurrentTime();
    const duration = player.getDuration();
    if (
      !queueItemId ||
      !videoId ||
      // playerMatchesCurrentOccurrence() without a second getVideoData() read.
      (resolveIntendedVideoId(queueItemId) || videoId) !== videoId ||
      ![1, 2, 3].includes(state) ||
      !Number.isFinite(position) ||
      !Number.isFinite(duration) ||
      duration <= 0
    ) {
      positionSample = null;
      return false;
    }
    const previous = positionSample;
    const manualOffset = getState('sync.youtubeLocalOffset') || 0;
    const stableState = state === 3 ? (previous?.state ?? 3) : state;
    const sample: PositionSample = {
      player,
      queueItemId,
      sessionId: getCurrentSessionId(),
      videoId,
      subIndex: getState('youtube.currentSubIndex'),
      revision: getYouTubeControlRevision(player),
      position,
      duration,
      state: stableState,
      manualOffset,
      outputOffset:
        manualOffset + (stableState === 1 ? getLocalYouTubeAudibleOutputDelayMs() / 1000 : 0),
      connection: hostConn,
      at: performance.now(),
      wallAt: Date.now(),
    };
    positionSample = sample;
    if (
      !previous ||
      previous.player !== player ||
      previous.connection !== hostConn ||
      previous.queueItemId !== queueItemId ||
      previous.sessionId !== sample.sessionId ||
      previous.videoId !== videoId ||
      previous.subIndex !== sample.subIndex ||
      previous.revision !== sample.revision ||
      previous.manualOffset !== manualOffset ||
      Math.abs(previous.duration - duration) > 0.5 ||
      ![1, 2].includes(previous.state)
    )
      return false;
    const elapsed = sample.at - previous.at;
    if (elapsed < 0 || elapsed > 1_500 || Math.abs(sample.wallAt - previous.wallAt - elapsed) > 50)
      return false;
    const expected = previous.position + (previous.state === 1 ? elapsed / 1000 : 0);
    if (Math.abs(position - expected) <= 1.5) return false;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLIFrameElement) || !focused.closest('#youtube-player-container'))
      return false;
    // Keep this participant's manual/Android output lead out of room time.
    // Use the pre-jump stable sample, not a transient seek PAUSED callback.
    const target = Math.max(0, Math.min(position - previous.outputOffset, duration));
    nativeSeek =
      state === previous.state
        ? null
        : { player, state: previous.state, expiresAt: performance.now() + 1_000 };
    setLocalYouTubePaused(false);
    const sent = safeSend(hostConn, { type: MSG.REQUEST_SEEK, time: target, queueItemId });
    if (!sent) nativeSeek = null;
    else log.info('[YouTube Native Control] Requested standard-room seek');
    return sent;
  } catch {
    positionSample = null;
    return false;
  }
}

function readCanonicalPosition(player: YouTubePlayerInstance): number {
  try {
    const current = player.getCurrentTime?.() || 0;
    const duration = player.getDuration?.() || 0;
    return toCanonicalYouTubeTime(current, duration);
  } catch {
    return 0;
  }
}

function rememberNativeAction(action: NativeYouTubeMediaAction, queueItemId: QueueItemId): void {
  recentNativeAction = { action, queueItemId, handledAt: Date.now() };
}

function flushPendingLocalRejoin(): void {
  const pending = pendingLocalRejoin;
  pendingLocalRejoin = null;
  clearManagedTimer(LOCAL_REJOIN_TIMER);
  if (!pending) return;
  if (
    getState('playback.mode') !== 'youtube' ||
    getCurrentQueueItemId() !== pending.queueItemId ||
    getYouTubePlayer() !== pending.player
  ) {
    return;
  }
  bus.emit('youtube:set-local-paused', false, 'media-session-play');
}

function queueLocalRejoin(player: YouTubePlayerInstance, queueItemId: QueueItemId): void {
  setLocalYouTubePaused(true);
  pendingLocalRejoin = { player, queueItemId };
  try {
    player.pauseVideo?.();
  } catch (error) {
    log.debug('[YouTube Native Control] Corrective local pause failed', error);
  }
  clearManagedTimer(LOCAL_REJOIN_TIMER);
  setManagedTimer(LOCAL_REJOIN_TIMER, flushPendingLocalRejoin, LOCAL_REJOIN_FALLBACK_MS);
}

function routeNativeAction(
  player: YouTubePlayerInstance,
  action: NativeYouTubeMediaAction,
  previous: YouTubeStableActivity,
  queueItemId: QueueItemId,
): void {
  const room = getRoomContext();
  const hostConn = getState('network.hostConn');
  const route = decideNativeYouTubeControlRoute({
    action,
    roomKind: room.kind,
    canControlPlayback: hasRoomCapability('playback.control'),
    hasStandardHostConnection: !!hostConn,
  });
  const positionSeconds = readCanonicalPosition(player);
  rememberNativeAction(action, queueItemId);

  if (route === 'local-pause') {
    setLocalYouTubePaused(true);
    log.info('[YouTube Native Control] Applied endpoint-local pause');
    return;
  }
  if (route === 'local-rejoin') {
    queueLocalRejoin(player, queueItemId);
    log.info('[YouTube Native Control] Rejoining endpoint to room authority');
    return;
  }

  setLocalYouTubePaused(false);

  if (route === 'pro-controller') {
    if (action === 'play') {
      // The iframe is already playing under a trusted OS media gesture.
      // Keep it alive while the server establishes the canonical timeline;
      // pausing first makes iOS reject the later asynchronous playVideo().
      routeProPlaybackCommand({ kind: 'play', queueItemId, positionSeconds });
    } else {
      routeProPlaybackCommand(
        { kind: 'pause', queueItemId, positionSeconds },
        { wasPlaying: previous === 'playing' },
      );
    }
    log.info(`[YouTube Native Control] Routed ${action} through PRO authority`);
    return;
  }

  if (route === 'standard-controller') {
    if (!hostConn?.open) return;
    const sent = safeSend(hostConn, {
      type: action === 'play' ? MSG.REQUEST_YOUTUBE_PLAY : MSG.REQUEST_YOUTUBE_PAUSE,
      queueItemId,
    });
    if (!sent && action === 'play') {
      // Fail closed only when the request could not leave this endpoint. A
      // successfully sent OS PLAY must remain audible so iOS keeps the trusted
      // media gesture alive until the host's synchronized command arrives.
      try {
        player.pauseVideo?.();
      } catch (error) {
        log.debug('[YouTube Native Control] Failed to restore pause after send failure', error);
      }
    }
    log.info(`[YouTube Native Control] Requested standard-room ${action}`);
    return;
  }

  bus.emit('youtube:auto-play', {
    targetTime: positionSeconds,
    skipSeek: false,
    zeroStart: action === 'play' && positionSeconds <= 0.12,
    state: action === 'play' ? 1 : 2,
  });
  log.info(`[YouTube Native Control] Promoted host ${action} to room rendezvous`);
}

function handlePlaybackActivity(nextActivity: unknown): void {
  if (!isPlaybackActivityValue(nextActivity)) return;
  const previous = stableActivity(previousActivity);
  previousActivity = nextActivity;
  const next = stableActivity(nextActivity);
  if (getState('playback.mode') !== 'youtube' || !previous || !next || previous === next) return;

  const player = getYouTubePlayer();
  const queueItemId = getCurrentQueueItemId();
  if (!player || !queueItemId) return;
  // An uninstrumentable seek method cannot distinguish correction feedback
  // from iframe input. Keep the app's explicit controls as the safe path.
  if (!canObserveYouTubeNativeSeek(player)) return;

  const origin = classifyYouTubeStableStateOrigin(player, next);
  if (origin === 'programmatic') {
    if (next === 'paused' && pendingLocalRejoin?.player === player) flushPendingLocalRejoin();
    return;
  }
  if (seekFeedback?.player === player && seekFeedback.state === (next === 'playing' ? 1 : 2))
    return;
  if (origin === 'unsupported' || hasProtectedTransitionOwner()) return;
  if (!playerMatchesCurrentOccurrence(player, queueItemId)) return;

  routeNativeAction(player, mediaAction(next), previous, queueItemId);
}

export function initYouTubeNativeControlAuthority(): void {
  scope?.dispose();
  scope = createBusScope();
  previousActivity = getState('playback.activity');
  recentNativeAction = null;
  pendingLocalRejoin = null;
  positionSample = null;
  nativeSeek = null;
  seekFeedback = null;
  hostAdActive = false;
  document.removeEventListener('visibilitychange', resetNativeSeekObservation);
  document.addEventListener('visibilitychange', resetNativeSeekObservation);
  window.removeEventListener('blur', handleNativeSeekWindowBlur);
  window.addEventListener('blur', handleNativeSeekWindowBlur);
  clearManagedTimer(LOCAL_REJOIN_TIMER);

  scope.on('youtube:player-ready', handlePlayerReady);
  scope.on('youtube:set-local-paused', (paused) => {
    if (!paused) return;
    pendingLocalRejoin = null;
    clearManagedTimer(LOCAL_REJOIN_TIMER);
  });
  scope.on('state:playback.mode', () => {
    positionSample = null;
    nativeSeek = null;
    seekFeedback = null;
    const player = getYouTubePlayer();
    if (getState('playback.mode') !== 'youtube') {
      clearYouTubeStableControlExpectations(player);
      pendingLocalRejoin = null;
      recentNativeAction = null;
      clearManagedTimer(LOCAL_REJOIN_TIMER);
    } else {
      ensureCurrentPlayerInstrumented();
    }
    previousActivity = getState('playback.activity');
  });
  scope.on('state:playlist.currentQueueItemId', () => {
    positionSample = null;
    nativeSeek = null;
    seekFeedback = null;
    clearYouTubeStableControlExpectations(getYouTubePlayer());
  });
  scope.on('state:sync.youtubeLocalOffset', () => {
    resetNativeSeekObservation();
    clearYouTubeStableControlExpectations(getYouTubePlayer());
  });
  scope.on('state:playback.activity', handlePlaybackActivity);
  ensureCurrentPlayerInstrumented();
}

export function shouldIgnoreRecentNativeYouTubeMediaAction(
  action: NativeYouTubeMediaAction,
): boolean {
  const recent = recentNativeAction;
  if (!recent) return false;
  if (
    Date.now() - recent.handledAt > RECENT_NATIVE_ACTION_MS ||
    recent.queueItemId !== getCurrentQueueItemId()
  ) {
    recentNativeAction = null;
    return false;
  }
  return recent.action === action;
}
