/** Evidence-based local Web Audio health checks for foreground recovery. */

import { getState } from '../core/state.ts';
import type { ResidentFile } from '../types/index.ts';
import { getRoomContext } from '../rooms/authority.ts';
import { getCurrentAudioBuffer } from '../player/_state.ts';
import { isFilePipelineBusyForPlay } from '../player/transport.ts';
import { isPlaybackPlayingFile } from '../player/ownership.ts';
import {
  armPendingAudioContextRecoveryFromBackground,
  cancelPendingAudioContextRecovery,
  confirmPendingAudioContextRecoveryHealth,
  getPendingAudioContextClockHealthRequirement,
  getPendingAudioContextRecoveryAttemptForHealth,
} from './context-recovery.ts';
import {
  consumeForegroundAudioContextClockHealthCheck,
  getExistingAudioContext,
  getPendingForegroundAudioContextClockHealthCheck,
  isForegroundAudioContextRestartOwned,
  probeAudioContextHealth,
  type AudioContextHealthReason,
} from './context.ts';

interface LocalFileOutputIdentity {
  readonly roomKind: 'standard' | 'pro';
  readonly roomId: string | null;
  readonly roomEpoch: number;
  readonly queueItemId: string;
  readonly buffer: AudioBuffer;
  readonly resident: ResidentFile;
}

interface BackgroundFileOutputHealth {
  readonly status: 'not-applicable' | 'healthy' | 'needs-gesture' | 'stale';
  readonly reason: AudioContextHealthReason | null;
}

function captureIdentity(): LocalFileOutputIdentity | null {
  if (
    !getState('setup.sessionStarted') ||
    !isPlaybackPlayingFile() ||
    isFilePipelineBusyForPlay()
  ) {
    return null;
  }
  const queueItemId = getState('playlist.currentQueueItemId');
  const buffer = getCurrentAudioBuffer();
  const resident = getState('files.current');
  if (!queueItemId || !buffer || !resident || resident.queueItemId !== queueItemId) {
    return null;
  }
  const room = getRoomContext();
  return {
    roomKind: room.kind,
    roomId: room.roomId,
    roomEpoch: room.epoch,
    queueItemId,
    buffer,
    resident,
  };
}

function identityStillCurrent(identity: LocalFileOutputIdentity): boolean {
  const room = getRoomContext();
  return Boolean(
    document.visibilityState === 'visible' &&
    getState('setup.sessionStarted') &&
    isPlaybackPlayingFile() &&
    !isFilePipelineBusyForPlay() &&
    room.kind === identity.roomKind &&
    room.roomId === identity.roomId &&
    room.epoch === identity.roomEpoch &&
    getState('playlist.currentQueueItemId') === identity.queueItemId &&
    getState('files.current') === identity.resident &&
    getCurrentAudioBuffer() === identity.buffer,
  );
}

/**
 * A native `running` state is not enough on iOS: verify that currentTime moves.
 * Identity changes make the sample stale rather than a recovery incident.
 */
export async function inspectBackgroundFileOutput(): Promise<BackgroundFileOutputHealth> {
  const identity = captureIdentity();
  if (!identity) return { status: 'not-applicable', reason: null };

  const context = getExistingAudioContext();
  if (!context) return { status: 'needs-gesture', reason: 'not-created' };
  // A generic foreground restart has exclusive ownership from suspend
  // preparation through post-gesture verification. In particular, do not let
  // this background inspector auto-resume a context intentionally parked for
  // the next trusted PLAY gesture.
  if (isForegroundAudioContextRestartOwned(context)) {
    return { status: 'stale', reason: 'superseded' };
  }
  const priorAttempt = getPendingAudioContextRecoveryAttemptForHealth();
  const recoveryRequirement = getPendingAudioContextClockHealthRequirement();
  const foregroundRequirement = getPendingForegroundAudioContextClockHealthCheck();

  const health = await probeAudioContextHealth({
    attemptResume: true,
    context,
    isCurrent: () =>
      identityStillCurrent(identity) &&
      (!foregroundRequirement || foregroundRequirement.isCurrent()) &&
      (!recoveryRequirement || recoveryRequirement.isCurrent()),
  });
  if (
    health.reason === 'hidden' ||
    health.reason === 'superseded' ||
    health.reason === 'inconclusive'
  ) {
    if (foregroundRequirement && health.reason !== 'inconclusive') {
      consumeForegroundAudioContextClockHealthCheck(foregroundRequirement.token);
    }
    if (
      health.reason === 'superseded' &&
      priorAttempt &&
      (!identityStillCurrent(identity) ||
        (recoveryRequirement !== null && !recoveryRequirement.isCurrent()))
    ) {
      cancelPendingAudioContextRecovery(priorAttempt);
    }
    return { status: 'stale', reason: health.reason };
  }
  if (health.healthy && identityStillCurrent(identity)) {
    const currentRecoveryRequirement = getPendingAudioContextClockHealthRequirement();
    if (currentRecoveryRequirement?.attemptToken === priorAttempt) {
      confirmPendingAudioContextRecoveryHealth(currentRecoveryRequirement.attemptToken);
    } else if (priorAttempt) {
      cancelPendingAudioContextRecovery(priorAttempt);
    }
    if (foregroundRequirement) {
      consumeForegroundAudioContextClockHealthCheck(foregroundRequirement.token);
    }
    return { status: 'healthy', reason: health.reason };
  }
  if (!identityStillCurrent(identity)) {
    if (foregroundRequirement) {
      consumeForegroundAudioContextClockHealthCheck(foregroundRequirement.token);
    }
    if (priorAttempt) cancelPendingAudioContextRecovery(priorAttempt);
    return { status: 'stale', reason: 'superseded' };
  }

  const cause =
    health.reason === 'clock-stalled' ? 'background-clock-stalled' : 'state-interruption';
  const attempt = await armPendingAudioContextRecoveryFromBackground(context, cause);
  if (!attempt || !identityStillCurrent(identity)) {
    if (attempt) cancelPendingAudioContextRecovery(attempt);
    return { status: 'stale', reason: 'superseded' };
  }
  return { status: 'needs-gesture', reason: health.reason };
}
