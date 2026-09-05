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
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { safeSend } from '../network/peer.ts';
import { getCurrentQueueItemId, getQueueItemById } from '../player/queue-model.ts';
import { isPlaybackActivityValue } from '../player/ownership.ts';
import { routeProPlaybackCommand } from '../pro-room/playback-authority-hooks.ts';
import { getRoomContext, hasRoomCapability } from '../rooms/authority.ts';
import type { QueueItemId } from '../types/index.ts';
import {
  getYouTubePlayer,
  getYtAutoplayIntent,
  isYtIndexing,
  isYtLoadInProgress,
  isYtPrimeBouncePending,
  isYtPriming,
  setLocalYouTubePaused,
  setYtAutoplayIntent,
  type YouTubePlayerInstance,
} from './_state.ts';
import { toCanonicalYouTubeTime } from './local-offset.ts';
import {
  classifyYouTubeStableStateOrigin,
  clearYouTubeStableControlExpectations,
  expectYouTubeStableActivity,
  instrumentYouTubeStableControls,
  type YouTubeStableActivity,
} from './native-control-origin.ts';
import {
  decideNativeYouTubeControlRoute,
  type NativeYouTubeMediaAction,
} from './native-control-policy.ts';

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
  return isYtLoadInProgress() || isYtIndexing() || isYtPriming() || isYtPrimeBouncePending();
}

function resolveIntendedVideoId(queueItemId: QueueItemId): string | null {
  const item = getQueueItemById(queueItemId);
  if (!item || item.type !== 'youtube') return null;
  const subIndex = getState('youtube.currentSubIndex') ?? 0;
  if (item.playlistId) {
    const ids = getState('youtube.subItemsMap')?.[item.playlistId]?.ids;
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
 * Preserve a trusted OS/headset PLAY long enough for PRO room authority
 * to observe and promote it. PRO pause commits deliberately leave
 * `ytAutoplayIntent=false`; without this pre-guard seam the iframe's
 * PLAYING callback immediately pauses back before playback activity can
 * reach the native-control authority listener.
 *
 * Only an unmatched native transition from the exact current iframe and
 * queue occurrence may cross the guard. Application-owned play/load/cue
 * transitions retain the existing pause-back behaviour.
 */
export function preserveNativeProControllerPlayBeforeAutoplayGuard(
  player: YouTubePlayerInstance,
): boolean {
  if (
    getYtAutoplayIntent() ||
    getState('playback.mode') !== 'youtube' ||
    getRoomContext().kind !== 'pro' ||
    !hasRoomCapability('playback.control') ||
    getYouTubePlayer() !== player ||
    hasProtectedTransitionOwner()
  ) {
    return false;
  }

  const queueItemId = getCurrentQueueItemId();
  if (!queueItemId || !playerMatchesCurrentOccurrence(player, queueItemId)) return false;
  if (classifyYouTubeStableStateOrigin(player, 'playing') !== 'native') return false;

  setYtAutoplayIntent(true);
  log.info('[YouTube Native Control] Preserved native PRO PLAY through autoplay guard');
  return true;
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

  const origin = classifyYouTubeStableStateOrigin(player, next);
  if (origin === 'programmatic') {
    if (next === 'paused' && pendingLocalRejoin?.player === player) flushPendingLocalRejoin();
    return;
  }
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
  clearManagedTimer(LOCAL_REJOIN_TIMER);

  scope.on('youtube:player-ready', handlePlayerReady);
  scope.on('youtube:set-local-paused', (paused) => {
    if (!paused) return;
    pendingLocalRejoin = null;
    clearManagedTimer(LOCAL_REJOIN_TIMER);
  });
  scope.on('state:playback.mode', () => {
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
