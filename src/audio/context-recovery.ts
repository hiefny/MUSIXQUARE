/**
 * Recover the shared Web Audio output after an OS-level interruption.
 *
 * AirPods/headset removal and mobile audio-route changes can suspend or
 * interrupt AudioContext without issuing a Media Session pause command. The
 * recovery intent stays armed until the context is physically `running` (or
 * is disposed/closed), so a rejected automatic resume can be retried from the
 * next trusted Media Session play gesture.
 */

import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';

type RejoinMode = 'file' | 'youtube';

interface PlaybackIdentity {
  mode: RejoinMode;
  roomKind: 'standard' | 'pro';
  roomId: string | null;
  roomEpoch: number;
  queueItemId: string | null;
}

interface PendingContextRecovery {
  context: AudioContext;
  identity: PlaybackIdentity;
  bindingToken: object;
  attemptToken: object;
  generation: number;
  automaticResume: Promise<ContextResumeResult> | null;
  gestureResume: Promise<ContextResumeResult> | null;
  completed: boolean;
  rejoinEmitted: boolean;
  fallbackClaimed: boolean;
}

interface ContextResumeResult {
  running: boolean;
  rejoinEmitted: boolean;
  fallbackEligible: boolean;
}

let pendingRecovery: PendingContextRecovery | null = null;
let activeRecoveryAttempt: PendingContextRecovery | null = null;
let activeBindingToken: object | null = null;
let recoveryGeneration = 0;

function activePlaybackIdentity(): PlaybackIdentity | null {
  if (!getState('setup.sessionStarted') || getState('playback.activity') !== 'playing') {
    return null;
  }
  const mode = getState('playback.mode');
  if (mode !== 'file' && mode !== 'youtube') return null;
  const room = getState('room.context');
  return {
    mode,
    roomKind: room.kind,
    roomId: room.roomId,
    roomEpoch: room.epoch,
    queueItemId: getState('playlist.currentQueueItemId'),
  };
}

function identityStillCurrent(identity: PlaybackIdentity): boolean {
  const current = activePlaybackIdentity();
  return !!(
    current &&
    current.mode === identity.mode &&
    current.roomKind === identity.roomKind &&
    current.roomId === identity.roomId &&
    current.roomEpoch === identity.roomEpoch &&
    current.queueItemId === identity.queueItemId
  );
}

function completeRunningRecovery(recovery: PendingContextRecovery): boolean {
  if (recovery.completed) return recovery.rejoinEmitted;
  if (
    pendingRecovery !== recovery ||
    activeBindingToken !== recovery.bindingToken ||
    recovery.generation !== recoveryGeneration ||
    String(recovery.context.state) !== 'running'
  ) {
    return false;
  }
  pendingRecovery = null;
  recovery.completed = true;
  if (!identityStillCurrent(recovery.identity)) return false;
  recovery.rejoinEmitted = true;
  bus.emit('playback:local-output-rejoin', {
    reason: 'audio-context-recovered',
    mode: recovery.identity.mode,
  });
  return true;
}

function contextResumeResult(
  recovery: PendingContextRecovery,
  source: 'automatic' | 'gesture',
): ContextResumeResult {
  const rejoinEmitted = completeRunningRecovery(recovery);
  const running = String(recovery.context.state) === 'running';
  const fallbackEligible = Boolean(
    source === 'gesture' &&
    running &&
    recovery.completed &&
    !recovery.rejoinEmitted &&
    !recovery.fallbackClaimed &&
    activeBindingToken === recovery.bindingToken &&
    recovery.generation === recoveryGeneration,
  );
  if (fallbackEligible) recovery.fallbackClaimed = true;
  return { running, rejoinEmitted, fallbackEligible };
}

function resumeContext(
  recovery: PendingContextRecovery,
  source: 'automatic' | 'gesture',
): Promise<ContextResumeResult> {
  const slot = source === 'automatic' ? 'automaticResume' : 'gestureResume';
  const existing = recovery[slot];
  if (existing) return existing;

  // Calling resume() happens synchronously before the first await. For the
  // gesture path this preserves the browser's transient user activation.
  const operation = recovery.context
    .resume()
    .then(() => contextResumeResult(recovery, source))
    .catch((error) => {
      log.debug(`[Audio] ${source} resume failed`, error);
      // Deliberately retain pendingRecovery. The next Media Session PLAY is a
      // new trusted gesture and must be allowed to retry.
      return { running: false, rejoinEmitted: false, fallbackEligible: false };
    })
    .finally(() => {
      if (recovery[slot] === operation) recovery[slot] = null;
    });
  recovery[slot] = operation;
  return operation;
}

export function hasPendingAudioContextInterruption(mode?: RejoinMode): boolean {
  return !!pendingRecovery && (mode === undefined || pendingRecovery.identity.mode === mode);
}

/** Opaque identity for the exact interruption that a trusted PLAY may resume. */
export function getPendingAudioContextInterruptionAttempt(): object | null {
  return pendingRecovery?.attemptToken || null;
}

/**
 * Whether an in-flight Media Session continuation still belongs to the active
 * context binding. A running statechange can complete pendingRecovery before
 * resume() settles, so this deliberately outlives the pending slot until a
 * new interruption or binding supersedes it.
 */
export function isAudioContextInterruptionAttemptCurrent(attemptToken: object): boolean {
  const recovery = activeRecoveryAttempt;
  return Boolean(
    recovery &&
    recovery.attemptToken === attemptToken &&
    activeBindingToken === recovery.bindingToken &&
    recovery.generation === recoveryGeneration,
  );
}

/** Retry a rejected OS auto-resume inside a trusted Media Session PLAY. */
export function resumePendingAudioContextInterruptionFromGesture(): Promise<ContextResumeResult> {
  const recovery = pendingRecovery;
  if (!recovery) {
    return Promise.resolve({ running: false, rejoinEmitted: false, fallbackEligible: false });
  }
  if (String(recovery.context.state) === 'running') {
    return Promise.resolve(contextResumeResult(recovery, 'gesture'));
  }
  return resumeContext(recovery, 'gesture');
}

/** Bind one context and return an exact disposer for engine re-initialization. */
export function bindAudioContextInterruptionRecovery(context: AudioContext): () => void {
  let disposed = false;
  let resumeWithoutPlayback: Promise<void> | null = null;
  const bindingToken = {};
  activeBindingToken = bindingToken;
  if (pendingRecovery) pendingRecovery = null;
  activeRecoveryAttempt = null;

  const handleStateChange = (): void => {
    if (disposed) return;
    const state = String(context.state);

    if (state === 'suspended' || state === 'interrupted') {
      const identity = activePlaybackIdentity();
      if (identity && pendingRecovery?.context !== context) {
        pendingRecovery = {
          context,
          identity,
          bindingToken,
          attemptToken: {},
          generation: ++recoveryGeneration,
          automaticResume: null,
          gestureResume: null,
          completed: false,
          rejoinEmitted: false,
          fallbackClaimed: false,
        };
        activeRecoveryAttempt = pendingRecovery;
      }

      log.info(`[Audio] AudioContext ${state} — auto-resuming`);
      const recovery = pendingRecovery?.context === context ? pendingRecovery : null;
      if (recovery) {
        void resumeContext(recovery, 'automatic');
      } else if (!resumeWithoutPlayback) {
        // Preserve the previous initial-context behavior without arming a
        // later playback seek or issuing duplicate resume calls.
        const operation = context
          .resume()
          .catch((error) => log.debug('[Audio] Auto-resume failed', error))
          .finally(() => {
            if (resumeWithoutPlayback === operation) resumeWithoutPlayback = null;
          });
        resumeWithoutPlayback = operation;
      }
      return;
    }

    if (state === 'closed') {
      if (pendingRecovery?.context === context) pendingRecovery = null;
      if (activeRecoveryAttempt?.context === context) activeRecoveryAttempt = null;
      if (activeBindingToken === bindingToken) activeBindingToken = null;
      return;
    }

    if (state === 'running' && pendingRecovery?.context === context) {
      completeRunningRecovery(pendingRecovery);
    }
  };

  context.addEventListener('statechange', handleStateChange);
  return () => {
    disposed = true;
    if (pendingRecovery?.context === context) pendingRecovery = null;
    if (activeRecoveryAttempt?.context === context) activeRecoveryAttempt = null;
    if (activeBindingToken === bindingToken) activeBindingToken = null;
    context.removeEventListener('statechange', handleStateChange);
  };
}
