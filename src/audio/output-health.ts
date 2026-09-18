/** Evidence-based local Web Audio health checks for foreground recovery. */

import { getState } from '../core/state.ts';
import { getPlayerNode } from '../player/_state.ts';
import {
  captureLocalFileOutputIdentity,
  isLocalFileOutputIdentityCurrent,
  type LocalFileOutputIdentity,
} from '../player/local-file-output-identity.ts';
import { isFilePipelineBusyForPlay, isFileSourceNodeUsable } from '../player/transport.ts';
import { isPlaybackPlayingFile } from '../player/ownership.ts';
import {
  armPendingAudioContextRecoveryFromBackground,
  cancelPendingAudioContextRecovery,
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

interface LocalFileOutputSample {
  readonly playback: LocalFileOutputIdentity;
  readonly source: AudioBufferSourceNode | null;
}

const BACKGROUND_FILE_OUTPUT_CONTINUITY_TOLERANCE_SECONDS = 0.25;

interface BackgroundFileOutputHealth {
  readonly status: 'not-applicable' | 'healthy' | 'needs-gesture' | 'stale';
  readonly reason: AudioContextHealthReason | null;
  /** The caller still owns one participant-local output rebuild. */
  readonly rejoinRequired: boolean;
  /** Semantic AudioContext recovery already published that rebuild. */
  readonly rejoinEmitted: boolean;
  /** Exact physical source sampled by this inspection is still installed. */
  readonly isCurrent: (() => boolean) | null;
  /** Room/queue/buffer identity still matches, independent of an owned rebuild. */
  readonly isPlaybackCurrent: (() => boolean) | null;
}

const NO_REJOIN = {
  rejoinRequired: false,
  rejoinEmitted: false,
  isCurrent: null,
  isPlaybackCurrent: null,
} as const;

function captureIdentity(): LocalFileOutputSample | null {
  if (
    !getState('setup.sessionStarted') ||
    !isPlaybackPlayingFile() ||
    isFilePipelineBusyForPlay()
  ) {
    return null;
  }
  const playback = captureLocalFileOutputIdentity();
  return playback ? { playback, source: getPlayerNode() } : null;
}

function playbackIdentityStillCurrent(identity: LocalFileOutputSample): boolean {
  return Boolean(
    document.visibilityState === 'visible' &&
    getState('setup.sessionStarted') &&
    isPlaybackPlayingFile() &&
    !isFilePipelineBusyForPlay() &&
    isLocalFileOutputIdentityCurrent(identity.playback),
  );
}

function identityStillCurrent(identity: LocalFileOutputSample): boolean {
  return playbackIdentityStillCurrent(identity) && getPlayerNode() === identity.source;
}

/**
 * A native `running` state is not enough on iOS: verify that currentTime moves.
 * Identity changes make the sample stale rather than a recovery incident.
 */
export async function inspectBackgroundFileOutput(): Promise<BackgroundFileOutputHealth> {
  const identity = captureIdentity();
  if (!identity) return { status: 'not-applicable', reason: null, ...NO_REJOIN };

  const context = getExistingAudioContext();
  if (!context) return { status: 'needs-gesture', reason: 'not-created', ...NO_REJOIN };
  // A generic foreground restart has exclusive ownership from suspend
  // preparation through post-gesture verification. In particular, do not let
  // this background inspector auto-resume a context intentionally parked for
  // the next trusted PLAY gesture.
  if (isForegroundAudioContextRestartOwned(context)) {
    return { status: 'stale', reason: 'superseded', ...NO_REJOIN };
  }
  const contextWasRunning = String(context.state) === 'running';
  // Native state-interruption recovery owns its exact resume and clock proof.
  // The visibility guard must not run a competing 180 ms sample or publish a
  // second app-level rebuild for that semantic attempt.
  if (getPendingAudioContextRecoveryAttemptForHealth()) {
    return { status: 'stale', reason: 'superseded', ...NO_REJOIN };
  }
  const foregroundRequirement = getPendingForegroundAudioContextClockHealthCheck();

  const health = await probeAudioContextHealth({
    attemptResume: true,
    context,
    isCurrent: () =>
      identityStillCurrent(identity) &&
      (!foregroundRequirement || foregroundRequirement.isCurrent()),
  });
  if (
    health.reason === 'hidden' ||
    health.reason === 'superseded' ||
    health.reason === 'inconclusive'
  ) {
    if (foregroundRequirement && health.reason !== 'inconclusive') {
      consumeForegroundAudioContextClockHealthCheck(foregroundRequirement.token);
    }
    return { status: 'stale', reason: health.reason, ...NO_REJOIN };
  }
  if (health.healthy && identityStillCurrent(identity)) {
    if (getPendingAudioContextRecoveryAttemptForHealth()) {
      // A statechange during the async sample created a successor owner. Its
      // automatic probe is the only operation allowed to commit that attempt.
      return { status: 'stale', reason: 'superseded', ...NO_REJOIN };
    }
    // Read exact hidden-boundary evidence before either recovery owner consumes
    // the one-shot foreground token. A context can report `running` and pass
    // this foreground sample even though its clock was frozen while hidden.
    const hiddenContinuityGapSeconds =
      foregroundRequirement?.getHiddenContinuityGapSeconds() ?? null;
    const hiddenContinuityLost = Boolean(
      hiddenContinuityGapSeconds !== null &&
      hiddenContinuityGapSeconds > BACKGROUND_FILE_OUTPUT_CONTINUITY_TOLERANCE_SECONDS,
    );
    const physicalSourceInvalid = !isFileSourceNodeUsable(
      identity.source,
      identity.playback.buffer,
    );
    if (foregroundRequirement) {
      consumeForegroundAudioContextClockHealthCheck(foregroundRequirement.token);
    }
    return {
      status: 'healthy',
      reason: health.reason,
      rejoinRequired: !contextWasRunning || hiddenContinuityLost || physicalSourceInvalid,
      rejoinEmitted: false,
      isCurrent: () => identityStillCurrent(identity),
      isPlaybackCurrent: () => playbackIdentityStillCurrent(identity),
    };
  }
  if (!identityStillCurrent(identity)) {
    if (foregroundRequirement) {
      consumeForegroundAudioContextClockHealthCheck(foregroundRequirement.token);
    }
    return { status: 'stale', reason: 'superseded', ...NO_REJOIN };
  }

  if (getPendingAudioContextRecoveryAttemptForHealth()) {
    return { status: 'stale', reason: 'superseded', ...NO_REJOIN };
  }

  const cause =
    health.reason === 'clock-stalled' ? 'background-clock-stalled' : 'state-interruption';
  const attempt = await armPendingAudioContextRecoveryFromBackground(context, cause);
  if (!attempt || !identityStillCurrent(identity)) {
    if (attempt) cancelPendingAudioContextRecovery(attempt);
    return { status: 'stale', reason: 'superseded', ...NO_REJOIN };
  }
  return { status: 'needs-gesture', reason: health.reason, ...NO_REJOIN };
}
