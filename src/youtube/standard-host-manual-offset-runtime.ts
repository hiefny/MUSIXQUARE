/**
 * Deferred Standard-host YouTube manual-offset transaction.
 *
 * The eager gate reserves authority before loading this module. This runtime
 * owns every fire-and-forget iframe command, observation, and rollback until
 * the matching lease commits or is synchronously invalidated.
 */

import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState, setState } from '../core/state.ts';
import { clearManagedTimer, getManagedTimer, setManagedTimer } from '../core/timers.ts';
import { getRoomContext } from '../rooms/authority.ts';
import { fmtTime } from '../player/transport.ts';
import { isPlaybackModeYouTube } from '../player/ownership.ts';
import { getCurrentQueueItemId, getQueueItemById } from '../player/queue-model.ts';
import { getYouTubePlayer, setYtAutoplayIntent } from './_state.ts';
import type { YouTubePlayerInstance } from './_state.ts';
import {
  beginProCoordinatorYouTubeNudge,
  clearProCoordinatorYouTubeNudgeAnchor,
  isStandardHostYouTubeManualOffsetEndpoint,
  PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER,
  resolveProCoordinatorYouTubeTarget,
  shouldNeutralizeStandardHostYouTubeOffsetAtEnd,
  toCanonicalYouTubeTime,
} from './local-offset.ts';
import type {
  StandardHostManualOffsetLease,
  StandardHostManualOffsetRuntimeHooks,
} from './standard-host-manual-offset-gate.ts';

const VERIFY_TIMER = 'yt-standard-host-offset-verify';
const VERIFY_INTERVAL_MS = 100;
const APPLY_TIMEOUT_MS = 3_000;
const ROLLBACK_TIMEOUT_MS = 3_000;
const GATE_TTL_MS = 7_000;
const TARGET_TOLERANCE_SEC = 0.025;
const RETRY_INTERVAL_MS = 500;
const ROLLBACK_STABLE_MS = 500;

interface StandardHostManualOffsetIdentity {
  player: YouTubePlayerInstance;
  endpointIdentity: `standard-host:${string}`;
  queueItemId: string;
  subIndex: number;
  videoId: string;
}

interface StandardHostManualOffsetTransaction extends StandardHostManualOffsetIdentity {
  lease: StandardHostManualOffsetLease;
  phase: 'apply' | 'rollback';
  phaseStartedAt: number;
  requestedOffset: number;
  duration: number;
  playing: boolean;
  requiresPlaylistDetach: boolean;
  detachIssued: boolean;
  lastCommandAt: number;
  reloadAttempted: boolean;
  targetObservedSince: number;
  targetObservationCount: number;
  lastObservedResidual: number | null;
  commandIssued: boolean;
  commandBaselineOffset: number;
  seekObserved: boolean;
}

let transaction: StandardHostManualOffsetTransaction | null = null;

function getStandardHostEndpointIdentity(): `standard-host:${string}` | null {
  if (!isStandardHostYouTubeManualOffsetEndpoint()) return null;
  const room = getRoomContext();
  return `standard-host:${getState('network.sessionCode')}:${room.roomId ?? ''}:${room.epoch}`;
}

function clearTransactionRuntime(): void {
  transaction = null;
  clearManagedTimer(VERIFY_TIMER);
  clearManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER);
  clearProCoordinatorYouTubeNudgeAnchor();
}

function cancelForMediaTransition(): void {
  transaction = null;
  clearManagedTimer(VERIFY_TIMER);
}

function runtimeHooks(): StandardHostManualOffsetRuntimeHooks {
  return {
    cancelForMediaTransition,
    repairAfterTimerCleanup() {
      const active = transaction;
      if (!active || !active.lease.isCurrent()) return;
      if (!getManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER)) {
        armGate(active);
        scheduleVerification(active);
      }
    },
    reset: clearTransactionRuntime,
  };
}

function getExpectedVideoId(queueItemId: string, subIndex: number): string {
  const queueItem = queueItemId ? getQueueItemById(queueItemId) : null;
  const playlistId = (queueItem?.playlistId as string | null | undefined) || '';
  if (playlistId) return getState('youtube.subItemsMap')[playlistId]?.ids?.[subIndex] ?? '';
  return (queueItem?.videoId as string | null | undefined) ?? '';
}

function readIdentity(player: YouTubePlayerInstance): StandardHostManualOffsetIdentity | null {
  const endpointIdentity = getStandardHostEndpointIdentity();
  if (!endpointIdentity) return null;
  const queueItemId = getCurrentQueueItemId() || '';
  const subIndex = getState('youtube.currentSubIndex') ?? -1;
  const expectedVideoId = getExpectedVideoId(queueItemId, subIndex);
  const liveVideoId = player.getVideoData?.()?.video_id || '';
  if (!queueItemId || !expectedVideoId || liveVideoId !== expectedVideoId) return null;
  return { player, endpointIdentity, queueItemId, subIndex, videoId: liveVideoId };
}

function hasHardIdentityData(active: StandardHostManualOffsetTransaction): boolean {
  if (getYouTubePlayer() !== active.player) return false;
  if (getStandardHostEndpointIdentity() !== active.endpointIdentity) return false;
  if (getCurrentQueueItemId() !== active.queueItemId) return false;
  if ((getState('youtube.currentSubIndex') ?? -1) !== active.subIndex) return false;
  return getExpectedVideoId(active.queueItemId, active.subIndex) === active.videoId;
}

function hasHardIdentity(active: StandardHostManualOffsetTransaction): boolean {
  return active.lease.isCurrent() && hasHardIdentityData(active);
}

function hasLiveVideoIdentity(active: StandardHostManualOffsetTransaction): boolean {
  return active.player.getVideoData?.()?.video_id === active.videoId;
}

function isSettledPlayerState(
  active: StandardHostManualOffsetTransaction,
  playerState: number,
): boolean {
  return active.playing ? playerState === 1 : playerState === 2 || playerState === 5;
}

function emitDisplay(canonicalTime: number, duration: number): void {
  bus.emit('sync:display-update');
  bus.emit('ui:time-update', fmtTime(canonicalTime), fmtTime(duration), canonicalTime, duration);
}

function finish(
  active: StandardHostManualOffsetTransaction,
  requestedOffset: number,
  appliedOffset: number,
  canonicalTime: number,
  duration: number,
): void {
  if (transaction !== active || !active.lease.isCurrent()) return;
  clearTransactionRuntime();
  active.lease.commit(() => {
    setState('sync.youtubeLocalOffset', requestedOffset);
    // Input limits constrain the requested nudge, not the measured seek
    // latency. Clamping this residual would move the room's canonical clock.
    setState('sync.youtubeCoordinatorAppliedOffset', appliedOffset);
    emitDisplay(canonicalTime, duration);
  });
}

function abortForIdentityChange(active: StandardHostManualOffsetTransaction): void {
  if (transaction !== active || !active.lease.isCurrent()) return;
  clearTransactionRuntime();
  active.lease.commit(() => {
    setState('sync.youtubeLocalOffset', 0);
    setState('sync.youtubeCoordinatorAppliedOffset', 0);
    // Replacement media owns its own time UI; avoid a fabricated 0:00 flash.
    bus.emit('sync:display-update');
  });
}

function armGate(active: StandardHostManualOffsetTransaction): void {
  setManagedTimer(
    PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER,
    () => {
      if (transaction !== active || !active.lease.isCurrent()) {
        clearProCoordinatorYouTubeNudgeAnchor();
        return;
      }
      // Re-arm before reading the anchor after a throttled event loop. The
      // gate never opens merely because its ordinary deadline was delayed.
      armGate(active);
      if (active.phase === 'apply') beginRollback(active, 'gate-timeout');
      else scheduleVerification(active);
    },
    GATE_TTL_MS,
  );
}

function scheduleVerification(active: StandardHostManualOffsetTransaction): void {
  setManagedTimer(VERIFY_TIMER, () => verify(active), VERIFY_INTERVAL_MS);
}

function issueCommand(active: StandardHostManualOffsetTransaction, localTarget: number): void {
  const player = active.player;
  const localTime = player.getCurrentTime();
  active.commandIssued = true;
  active.commandBaselineOffset = localTime - toCanonicalYouTubeTime(localTime, active.duration);
  active.seekObserved = false;
  active.targetObservedSince = 0;
  active.targetObservationCount = 0;
  active.lastObservedResidual = null;
  active.lastCommandAt = Date.now();
  if (active.requiresPlaylistDetach && !active.detachIssued) {
    active.detachIssued = true;
    if (active.playing) {
      setYtAutoplayIntent(true);
      player.loadVideoById(active.videoId, localTarget);
    } else if (player.cueVideoById) {
      player.cueVideoById(active.videoId, localTarget);
    } else {
      player.loadVideoById(active.videoId, localTarget);
      player.pauseVideo?.();
    }
    return;
  }
  player.seekTo(localTarget, true);
}

function beginRollback(active: StandardHostManualOffsetTransaction, reason: string): void {
  if (transaction !== active || !active.lease.isCurrent()) return;
  const shouldSupersedeDetachWithReload = active.requiresPlaylistDetach && active.detachIssued;
  active.phase = 'rollback';
  active.phaseStartedAt = Date.now();
  active.requestedOffset = 0;
  active.requiresPlaylistDetach = false;
  active.detachIssued = false;
  active.reloadAttempted = false;
  active.targetObservedSince = 0;
  active.targetObservationCount = 0;
  active.lastObservedResidual = null;
  active.seekObserved = false;
  setState('sync.youtubeLocalOffset', 0);
  bus.emit('sync:display-update');
  armGate(active);

  if (!hasHardIdentity(active)) {
    abortForIdentityChange(active);
    return;
  }

  try {
    if (!hasLiveVideoIdentity(active)) {
      scheduleVerification(active);
      return;
    }
    const duration = active.player.getDuration?.() || active.duration;
    const localTime = active.player.getCurrentTime();
    const canonicalTime = toCanonicalYouTubeTime(localTime, duration);
    active.commandBaselineOffset = localTime - canonicalTime;
    if (shouldSupersedeDetachWithReload) {
      active.reloadAttempted = true;
      if (active.playing) {
        setYtAutoplayIntent(true);
        active.player.loadVideoById(active.videoId, canonicalTime);
      } else if (active.player.cueVideoById) {
        active.player.cueVideoById(active.videoId, canonicalTime);
      } else {
        active.player.loadVideoById(active.videoId, canonicalTime);
        active.player.pauseVideo?.();
      }
    } else {
      active.player.seekTo(canonicalTime, true);
    }
    active.lastCommandAt = Date.now();
    log.debug(`[YouTube Sync] Standard-host manual offset rollback (${reason})`);
  } catch (error) {
    log.debug('[YouTube Sync] Standard-host rollback seek deferred:', error);
  }
  verify(active);
}

function verify(active: StandardHostManualOffsetTransaction): void {
  if (transaction !== active || !active.lease.isCurrent()) return;
  if (!hasHardIdentity(active) || !isPlaybackModeYouTube()) {
    abortForIdentityChange(active);
    return;
  }

  try {
    const player = active.player;
    const duration = player.getDuration?.() || active.duration;
    const localTime = player.getCurrentTime();
    const canonicalTime = toCanonicalYouTubeTime(localTime, duration);
    const playerState = player.getPlayerState?.() ?? -1;
    const elapsedMs = Date.now() - active.phaseStartedAt;
    const liveVideoIdentityReady = hasLiveVideoIdentity(active);
    const residualOffset = localTime - canonicalTime;
    // seekTo is asynchronous. A BUFFERING observation or a changed local
    // timeline shows that the command is being processed; sending another
    // seek every 500ms would keep interrupting that same seek.
    if (
      liveVideoIdentityReady &&
      (playerState === 3 ||
        Math.abs(residualOffset - active.commandBaselineOffset) > TARGET_TOLERANCE_SEC)
    ) {
      active.seekObserved = true;
    }

    if (active.phase === 'apply') {
      const target = resolveProCoordinatorYouTubeTarget(
        canonicalTime,
        active.requestedOffset,
        duration,
      );
      if (
        shouldNeutralizeStandardHostYouTubeOffsetAtEnd(
          target.localTime,
          target.canonicalTime,
          duration,
          target.effectiveOffset,
        )
      ) {
        beginRollback(active, 'end-boundary');
        return;
      }

      const playlistDetached = !active.requiresPlaylistDetach || player.getPlaylistIndex?.() === -1;
      // Reusing an older in-flight detach avoids overlapping loads, but its
      // eventual landing does not apply a newer slider value. Issue that
      // value once the intended video is observable and the detach finishes.
      if (
        !active.commandIssued &&
        liveVideoIdentityReady &&
        (!active.detachIssued || playlistDetached) &&
        elapsedMs < APPLY_TIMEOUT_MS
      ) {
        issueCommand(active, target.localTime);
        scheduleVerification(active);
        return;
      }
      const settled =
        active.commandIssued &&
        liveVideoIdentityReady &&
        playlistDetached &&
        Number.isFinite(residualOffset) &&
        isSettledPlayerState(active, playerState);
      const targetObserved =
        settled &&
        (Math.abs(localTime - target.localTime) <= TARGET_TOLERANCE_SEC || active.seekObserved);
      if (targetObserved) {
        // A real iframe loses time while seeking and need not land within
        // 25ms of a moving wall-clock target. Verify a stable observed offset
        // instead, and publish that physical offset rather than inventing the
        // requested one. Compare with the start of the observation window so
        // a frozen PLAYING getter cannot look like steady playback.
        if (
          active.lastObservedResidual === null ||
          Math.abs(residualOffset - active.lastObservedResidual) > TARGET_TOLERANCE_SEC
        ) {
          active.lastObservedResidual = residualOffset;
          active.targetObservedSince = Date.now();
          active.targetObservationCount = 1;
        } else {
          active.targetObservationCount += 1;
        }
        if (
          active.targetObservationCount >= 2 &&
          Date.now() - active.targetObservedSince >= ROLLBACK_STABLE_MS
        ) {
          finish(
            active,
            active.requestedOffset,
            localTime - canonicalTime,
            canonicalTime,
            duration,
          );
          return;
        }
        if (elapsedMs >= APPLY_TIMEOUT_MS) {
          beginRollback(active, 'apply-unstable');
          return;
        }
        scheduleVerification(active);
        return;
      }
      active.targetObservedSince = 0;
      active.targetObservationCount = 0;
      active.lastObservedResidual = null;

      if (elapsedMs >= APPLY_TIMEOUT_MS) {
        beginRollback(active, 'apply-unverified');
        return;
      }
      if (
        liveVideoIdentityReady &&
        playlistDetached &&
        !active.seekObserved &&
        Date.now() - active.lastCommandAt >= RETRY_INTERVAL_MS
      ) {
        issueCommand(active, target.localTime);
      }
      scheduleVerification(active);
      return;
    }

    const rollbackResidualIsZero = Math.abs(residualOffset) <= TARGET_TOLERANCE_SEC;
    if (liveVideoIdentityReady && Number.isFinite(residualOffset)) {
      const sameResidual =
        active.lastObservedResidual !== null &&
        Math.abs(residualOffset - active.lastObservedResidual) <= TARGET_TOLERANCE_SEC;
      if (sameResidual) active.targetObservationCount += 1;
      else {
        active.lastObservedResidual = residualOffset;
        active.targetObservedSince = Date.now();
        active.targetObservationCount = 1;
      }

      const stableWindowStart = rollbackResidualIsZero
        ? active.targetObservedSince
        : Math.max(active.targetObservedSince, active.phaseStartedAt + ROLLBACK_TIMEOUT_MS);
      if (
        active.targetObservationCount >= 2 &&
        Date.now() - stableWindowStart >= ROLLBACK_STABLE_MS
      ) {
        // A failed corrective command may leave a real residual. Recording only
        // a post-timeout stable residual preserves the canonical wire.
        finish(active, 0, rollbackResidualIsZero ? 0 : residualOffset, canonicalTime, duration);
        return;
      }
    } else {
      active.targetObservedSince = 0;
      active.targetObservationCount = 0;
      active.lastObservedResidual = null;
    }

    if (
      liveVideoIdentityReady &&
      Number.isFinite(residualOffset) &&
      (rollbackResidualIsZero ||
        (active.playing && active.seekObserved && isSettledPlayerState(active, playerState))) &&
      active.targetObservationCount >= 2
    ) {
      scheduleVerification(active);
      return;
    }

    if (
      liveVideoIdentityReady &&
      elapsedMs < ROLLBACK_TIMEOUT_MS &&
      Date.now() - active.lastCommandAt >= RETRY_INTERVAL_MS
    ) {
      if (!active.reloadAttempted && elapsedMs >= ROLLBACK_TIMEOUT_MS / 2) {
        active.reloadAttempted = true;
        if (active.playing) {
          setYtAutoplayIntent(true);
          player.loadVideoById(active.videoId, canonicalTime);
        } else if (player.cueVideoById) {
          player.cueVideoById(active.videoId, canonicalTime);
        } else {
          player.loadVideoById(active.videoId, canonicalTime);
          player.pauseVideo?.();
        }
      } else {
        player.seekTo(canonicalTime, true);
      }
      active.lastCommandAt = Date.now();
    }
    scheduleVerification(active);
  } catch (error) {
    log.debug('[YouTube Sync] Standard-host offset verification deferred:', error);
    const elapsedMs = Date.now() - active.phaseStartedAt;
    if (active.phase === 'apply' && elapsedMs >= APPLY_TIMEOUT_MS) {
      beginRollback(active, 'verification-error');
    } else {
      // An unreadable iframe cannot safely release the room broadcast gate.
      scheduleVerification(active);
    }
  }
}

function begin(lease: StandardHostManualOffsetLease): void {
  const player = lease.player;
  const previous = transaction;
  const duration = player.getDuration?.() || 0;
  const samePendingMedia = previous && hasHardIdentityData(previous);
  const playerState = player.getPlayerState?.() ?? -1;
  // A second +/- click can arrive while the first seek reports BUFFERING.
  // Preserve the transaction's intent instead of changing it to PAUSED.
  const playing = samePendingMedia
    ? previous.playing
    : playerState === 1 || (playerState === 3 && getState('playback.activity') === 'playing');
  const localTime = player.getCurrentTime();
  if (!Number.isFinite(localTime)) throw new Error('YouTube local position is unavailable');
  const canonicalTime = beginProCoordinatorYouTubeNudge(localTime, duration, playing);
  const requestedTarget = resolveProCoordinatorYouTubeTarget(
    canonicalTime,
    lease.requestedOffsetSeconds,
    duration,
  );
  const target = shouldNeutralizeStandardHostYouTubeOffsetAtEnd(
    requestedTarget.localTime,
    requestedTarget.canonicalTime,
    duration,
    requestedTarget.effectiveOffset,
  )
    ? resolveProCoordinatorYouTubeTarget(canonicalTime, 0, duration)
    : requestedTarget;
  const liveIdentity = readIdentity(player);
  const identity =
    liveIdentity ??
    (previous && hasHardIdentityData(previous)
      ? {
          player: previous.player,
          endpointIdentity: previous.endpointIdentity,
          queueItemId: previous.queueItemId,
          subIndex: previous.subIndex,
          videoId: previous.videoId,
        }
      : null);
  const inheritedPendingIdentity = !liveIdentity && identity !== null;

  if (!identity) {
    clearTransactionRuntime();
    lease.commit(() => {
      setState('sync.youtubeLocalOffset', lease.priorRequestedOffset);
      setState('sync.youtubeCoordinatorAppliedOffset', lease.priorAppliedOffset);
      bus.emit('sync:display-update');
    });
    return;
  }

  const nativePlaylistIndex = player.getPlaylistIndex?.();
  const queueItem = getQueueItemById(identity.queueItemId);
  const selectionIsPlaylist = !!queueItem?.playlistId;
  const canReusePendingDetach = !!(
    previous &&
    previous.phase === 'apply' &&
    previous.requiresPlaylistDetach &&
    previous.detachIssued &&
    previous.player === player &&
    previous.endpointIdentity === identity.endpointIdentity &&
    previous.queueItemId === identity.queueItemId &&
    previous.subIndex === identity.subIndex &&
    previous.videoId === identity.videoId &&
    typeof nativePlaylistIndex === 'number' &&
    nativePlaylistIndex >= 0
  );
  const now = Date.now();
  const next: StandardHostManualOffsetTransaction = {
    ...identity,
    lease,
    phase: 'apply',
    phaseStartedAt: now,
    requestedOffset: target.requestedOffset,
    duration,
    playing,
    requiresPlaylistDetach:
      canReusePendingDetach ||
      (target.requestedOffset !== 0 &&
        nativePlaylistIndex !== -1 &&
        (selectionIsPlaylist ||
          (typeof nativePlaylistIndex === 'number' && nativePlaylistIndex >= 0))),
    detachIssued: canReusePendingDetach,
    lastCommandAt: canReusePendingDetach ? (previous?.lastCommandAt ?? now) : 0,
    reloadAttempted: false,
    targetObservedSince: 0,
    targetObservationCount: 0,
    lastObservedResidual: null,
    commandIssued: false,
    commandBaselineOffset: localTime - canonicalTime,
    seekObserved: false,
  };
  transaction = next;
  if (!lease.bindRuntimeHooks(runtimeHooks())) {
    clearTransactionRuntime();
    return;
  }
  setState('sync.youtubeLocalOffset', target.requestedOffset);
  bus.emit('sync:display-update');
  armGate(next);

  try {
    if (!canReusePendingDetach && !inheritedPendingIdentity) issueCommand(next, target.localTime);
    verify(next);
  } catch (error) {
    log.debug('[YouTube Sync] Standard-host local apply failed:', error);
    beginRollback(next, 'command-error');
  }
}

/** Entry called by the eager lease only after the chunk is available. */
export function beginStandardHostManualOffsetTransaction(
  lease: StandardHostManualOffsetLease,
): void {
  if (!lease.isCurrent()) return;
  const priorTransaction = transaction;
  try {
    begin(lease);
  } catch (error) {
    // A getter can fail before any iframe command. Preserve an older in-flight
    // transaction exactly; otherwise restore the verified boundary and release.
    if (priorTransaction && transaction === priorTransaction) {
      lease.restorePrevious(() => {
        setState('sync.youtubeLocalOffset', lease.priorRequestedOffset);
        setState('sync.youtubeCoordinatorAppliedOffset', lease.priorAppliedOffset);
        bus.emit('sync:display-update');
      });
      return;
    }
    clearTransactionRuntime();
    lease.commit(() => {
      setState('sync.youtubeLocalOffset', lease.priorRequestedOffset);
      setState('sync.youtubeCoordinatorAppliedOffset', lease.priorAppliedOffset);
      bus.emit('sync:display-update');
    });
    log.debug('[YouTube Sync] Standard-host local nudge skipped:', error);
  }
}
