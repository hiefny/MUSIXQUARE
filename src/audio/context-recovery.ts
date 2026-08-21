/**
 * Recover the shared Web Audio output after an OS-level interruption.
 *
 * Ordinary suspended/interrupted contexts may auto-resume. A WebKit context
 * whose state says `running` while its clock is frozen follows a stricter
 * three-step protocol: finish one native suspend, resume synchronously from a
 * trusted gesture, then commit only after a clock probe succeeds.
 */

import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { delay } from '../core/timers.ts';
import type { ResidentFile } from '../types/index.ts';
import {
  armForegroundAudioContextClockHealthCheck,
  bindRetiredAudioContextSuspendRecovery,
  consumeForegroundAudioContextClockHealthCheck,
  getPendingForegroundAudioContextClockHealthCheck,
  isForegroundAudioContextRestartSuspendOwned,
  probeAudioContextHealth,
  requestRetiredAudioContextSuspendCleanup,
  restartAudioContextFromGesture,
} from './context.ts';

type RejoinMode = 'file' | 'youtube';
type RecoveryCause = 'state-interruption' | 'background-clock-stalled';
type RecoveryPhase =
  | 'awaiting-resume'
  | 'automatic-resuming'
  | 'preparing-suspend'
  | 'awaiting-gesture'
  | 'gesture-resuming'
  | 'awaiting-clock-verification'
  | 'completed'
  | 'cancelled';

const SUSPEND_PREPARE_DEADLINE_MS = 500;
const SUSPEND_WATCHDOG_MS = SUSPEND_PREPARE_DEADLINE_MS + 250;
const MAX_SEMANTIC_SUSPEND_ATTEMPTS = 2;
const RESUME_DEADLINE_MS = 750;

interface PlaybackIdentity {
  mode: RejoinMode;
  roomKind: 'standard' | 'pro';
  roomId: string | null;
  roomEpoch: number;
  queueItemId: string | null;
  residentFile: ResidentFile | null;
}

interface ContextResumeResult {
  running: boolean;
  rejoinEmitted: boolean;
  fallbackEligible: boolean;
}

interface PendingAudioContextClockHealthRequirement {
  readonly context: AudioContext;
  readonly attemptToken: object;
  readonly isCurrent: () => boolean;
}

type AudioContextRecoveryEscalationResult = 'rejected' | 'prepared' | 'preparing';

interface SuspendLease {
  readonly context: AudioContext;
  owner: PendingContextRecovery | null;
  settled: boolean;
  lateStateFenceToken: object | null;
  removeStateListener: () => void;
  readonly result: Promise<boolean>;
  resolve: (prepared: boolean) => void;
}

interface PendingContextRecovery {
  context: AudioContext;
  identity: PlaybackIdentity;
  bindingToken: object;
  attemptToken: object;
  generation: number;
  automaticResume: Promise<ContextResumeResult> | null;
  gestureResume: Promise<ContextResumeResult> | null;
  automaticHealthProbe: Promise<void> | null;
  activeResumeToken: object | null;
  completed: boolean;
  rejoinEmitted: boolean;
  fallbackClaimed: boolean;
  cause: RecoveryCause;
  phase: RecoveryPhase;
  clockVerified: boolean;
  suspendLease: SuspendLease | null;
  prepareTimedOut: boolean;
  notifyWhenPrepared: boolean;
  preparedNotificationSent: boolean;
  suspendPrepareAttempts: number;
}

let pendingRecovery: PendingContextRecovery | null = null;
let activeRecoveryAttempt: PendingContextRecovery | null = null;
let activeBindingToken: object | null = null;
let recoveryGeneration = 0;
const suspendLeases = new WeakMap<AudioContext, SuspendLease>();

function isPreparedState(context: AudioContext): boolean {
  const state = String(context.state);
  return state === 'suspended' || state === 'interrupted';
}

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
    residentFile: mode === 'file' ? getState('files.current') : null,
  };
}

function identitiesEqual(left: PlaybackIdentity, right: PlaybackIdentity): boolean {
  return (
    left.mode === right.mode &&
    left.roomKind === right.roomKind &&
    left.roomId === right.roomId &&
    left.roomEpoch === right.roomEpoch &&
    left.queueItemId === right.queueItemId &&
    left.residentFile === right.residentFile
  );
}

function identityStillCurrent(identity: PlaybackIdentity): boolean {
  const current = activePlaybackIdentity();
  return !!current && identitiesEqual(current, identity);
}

function recoveryStillOwnsAttempt(recovery: PendingContextRecovery): boolean {
  return Boolean(
    pendingRecovery === recovery &&
    activeBindingToken === recovery.bindingToken &&
    recovery.generation === recoveryGeneration &&
    recovery.phase !== 'cancelled' &&
    recovery.phase !== 'completed',
  );
}

function retireRecovery(recovery: PendingContextRecovery): void {
  if (recovery.phase === 'cancelled') return;
  recovery.phase = 'cancelled';
  recovery.activeResumeToken = null;
  if (recovery.suspendLease?.owner === recovery) recovery.suspendLease.owner = null;
  recovery.suspendLease = null;
  if (pendingRecovery === recovery) pendingRecovery = null;
  if (activeRecoveryAttempt === recovery) activeRecoveryAttempt = null;
  if (recovery.generation === recoveryGeneration) recoveryGeneration += 1;
}

function createRecovery(
  context: AudioContext,
  identity: PlaybackIdentity,
  bindingToken: object,
  cause: RecoveryCause,
): PendingContextRecovery {
  const recovery: PendingContextRecovery = {
    context,
    identity,
    bindingToken,
    attemptToken: {},
    generation: ++recoveryGeneration,
    automaticResume: null,
    gestureResume: null,
    automaticHealthProbe: null,
    activeResumeToken: null,
    completed: false,
    rejoinEmitted: false,
    fallbackClaimed: false,
    cause,
    phase: cause === 'background-clock-stalled' ? 'preparing-suspend' : 'awaiting-resume',
    clockVerified: false,
    suspendLease: null,
    prepareTimedOut: false,
    notifyWhenPrepared: false,
    preparedNotificationSent: false,
    suspendPrepareAttempts: 0,
  };
  pendingRecovery = recovery;
  activeRecoveryAttempt = recovery;
  return recovery;
}

function emitPreparedRecovery(recovery: PendingContextRecovery): void {
  if (
    recovery.preparedNotificationSent ||
    !recoveryStillOwnsAttempt(recovery) ||
    recovery.phase !== 'awaiting-gesture' ||
    !identityStillCurrent(recovery.identity)
  ) {
    return;
  }
  recovery.preparedNotificationSent = true;
  bus.emit('audio:output-recovery-needed', {
    reason: 'clock-stalled',
    source: 'background-resume',
    queueItemId: recovery.identity.queueItemId,
    isCurrent: () => recoveryStillOwnsAttempt(recovery) && identityStillCurrent(recovery.identity),
  });
}

function adoptRetiredSuspendForCurrentPlayback(context: AudioContext, bindingToken: object): void {
  if (activeBindingToken !== bindingToken || document.visibilityState !== 'visible') {
    return;
  }

  let recovery = pendingRecovery?.context === context ? pendingRecovery : null;
  if (String(context.state) === 'running') {
    if (
      recovery &&
      recoveryStillOwnsAttempt(recovery) &&
      identityStillCurrent(recovery.identity) &&
      recovery.cause === 'background-clock-stalled' &&
      recovery.phase === 'awaiting-gesture'
    ) {
      void prepareStalledRecovery(recovery, { notifyWhenPrepared: true });
    }
    return;
  }
  if (!isPreparedState(context)) return;

  const identity = activePlaybackIdentity();
  if (!identity || identity.mode !== 'file') return;
  if (
    recovery &&
    (!recoveryStillOwnsAttempt(recovery) || !identitiesEqual(recovery.identity, identity))
  ) {
    retireRecovery(recovery);
    recovery = null;
  }
  if (!recovery) {
    recovery = createRecovery(context, identity, bindingToken, 'background-clock-stalled');
  }

  const foregroundCheck = getPendingForegroundAudioContextClockHealthCheck();
  if (foregroundCheck?.context === context) {
    consumeForegroundAudioContextClockHealthCheck(foregroundCheck.token);
  }
  recovery.cause = 'background-clock-stalled';
  recovery.clockVerified = false;
  recovery.suspendLease = null;
  recovery.phase = 'awaiting-gesture';
  recovery.notifyWhenPrepared = true;
  emitPreparedRecovery(recovery);
}

function settleSuspendLease(lease: SuspendLease, error?: unknown): void {
  if (lease.settled) return;
  lease.settled = true;
  lease.lateStateFenceToken = null;
  lease.removeStateListener();
  if (suspendLeases.get(lease.context) === lease) suspendLeases.delete(lease.context);

  const owner = lease.owner;
  lease.owner = null;
  const prepared = isPreparedState(lease.context);
  let preparedForOwner = false;

  if (
    owner &&
    recoveryStillOwnsAttempt(owner) &&
    owner.suspendLease === lease &&
    owner.phase === 'preparing-suspend' &&
    identityStillCurrent(owner.identity) &&
    prepared
  ) {
    owner.suspendLease = null;
    owner.phase = 'awaiting-gesture';
    preparedForOwner = true;
    if (owner.prepareTimedOut || owner.notifyWhenPrepared) emitPreparedRecovery(owner);
  } else {
    if (owner?.suspendLease === lease) owner.suspendLease = null;
    if (owner && recoveryStillOwnsAttempt(owner)) retireRecovery(owner);
    if (prepared) requestRetiredAudioContextSuspendCleanup(lease.context);
  }

  if (error !== undefined && !prepared) {
    log.debug('[Audio] Failed to prepare stalled context for gesture resume', error);
  }
  lease.resolve(preparedForOwner);
}

function detachInconclusiveSuspendLease(lease: SuspendLease): PendingContextRecovery | null {
  if (lease.settled) return null;
  lease.settled = true;
  lease.lateStateFenceToken = null;
  lease.removeStateListener();
  if (suspendLeases.get(lease.context) === lease) suspendLeases.delete(lease.context);
  const owner = lease.owner;
  lease.owner = null;
  if (owner?.suspendLease === lease) owner.suspendLease = null;
  lease.resolve(false);
  return owner;
}

function watchSuspendLease(lease: SuspendLease): void {
  if (lease.settled || lease.lateStateFenceToken) return;
  const fenceToken = {};
  lease.lateStateFenceToken = fenceToken;
  void delay(SUSPEND_WATCHDOG_MS).then(() => {
    if (lease.settled || lease.lateStateFenceToken !== fenceToken) {
      return;
    }
    if (isPreparedState(lease.context)) {
      settleSuspendLease(lease);
      return;
    }
    if (String(lease.context.state) === 'closed') {
      settleSuspendLease(lease, new Error('AudioContext closed during late suspend fence'));
      return;
    }

    const owner = detachInconclusiveSuspendLease(lease);
    if (
      !owner ||
      !recoveryStillOwnsAttempt(owner) ||
      owner.phase !== 'preparing-suspend' ||
      !identityStillCurrent(owner.identity)
    ) {
      if (owner && recoveryStillOwnsAttempt(owner)) retireRecovery(owner);
      return;
    }

    if (owner.suspendPrepareAttempts >= MAX_SEMANTIC_SUSPEND_ATTEMPTS) {
      const context = owner.context;
      retireRecovery(owner);
      armForegroundAudioContextClockHealthCheck(context);
      return;
    }

    // The original caller has already crossed its bounded preparation window.
    // A concrete state from this fresh exact lease must therefore notify the
    // UI even when the first arm did not request eager notification.
    owner.prepareTimedOut = true;
    createSuspendLease(owner.context, owner);
  });
}

function createSuspendLease(context: AudioContext, owner: PendingContextRecovery): SuspendLease {
  let resolve!: (prepared: boolean) => void;
  const result = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  const handleStateChange = (): void => {
    if (lease.settled) return;
    const state = String(context.state);
    if (isPreparedState(context)) settleSuspendLease(lease);
    else if (state === 'closed') {
      settleSuspendLease(lease, new Error('AudioContext closed during suspend preparation'));
    }
  };
  const lease: SuspendLease = {
    context,
    owner,
    settled: false,
    lateStateFenceToken: null,
    removeStateListener: () => context.removeEventListener('statechange', handleStateChange),
    result,
    resolve,
  };
  owner.suspendLease = lease;
  owner.suspendPrepareAttempts += 1;
  suspendLeases.set(context, lease);
  context.addEventListener('statechange', handleStateChange);
  watchSuspendLease(lease);

  let nativeSuspend: Promise<void>;
  try {
    nativeSuspend = context.suspend();
  } catch (error) {
    settleSuspendLease(lease, error);
    return lease;
  }
  void nativeSuspend.then(
    () => {
      if (isPreparedState(context)) settleSuspendLease(lease);
    },
    (error) => settleSuspendLease(lease, error),
  );
  return lease;
}

async function prepareStalledRecovery(
  recovery: PendingContextRecovery,
  options: { notifyWhenPrepared?: boolean } = {},
): Promise<boolean> {
  if (!recoveryStillOwnsAttempt(recovery)) return false;
  recovery.notifyWhenPrepared ||= options.notifyWhenPrepared === true;

  if (isPreparedState(recovery.context)) {
    recovery.phase = 'awaiting-gesture';
    if (recovery.notifyWhenPrepared) emitPreparedRecovery(recovery);
    return true;
  }

  recovery.phase = 'preparing-suspend';
  recovery.clockVerified = false;
  recovery.prepareTimedOut = false;
  recovery.preparedNotificationSent = false;

  let lease = suspendLeases.get(recovery.context);
  if (!lease || lease.settled) {
    lease = createSuspendLease(recovery.context, recovery);
  } else {
    if (lease.owner && lease.owner !== recovery) retireRecovery(lease.owner);
    lease.owner = recovery;
    recovery.suspendLease = lease;
  }

  const outcome = await Promise.race([
    lease.result.then((prepared) => ({ type: 'settled' as const, prepared })),
    delay(SUSPEND_PREPARE_DEADLINE_MS).then(() => ({ type: 'timeout' as const })),
  ]);
  if (outcome.type === 'timeout') {
    if (
      recoveryStillOwnsAttempt(recovery) &&
      recovery.phase === 'preparing-suspend' &&
      recovery.suspendLease === lease
    ) {
      recovery.prepareTimedOut = true;
    }
    return false;
  }
  return Boolean(
    outcome.prepared &&
    recoveryStillOwnsAttempt(recovery) &&
    (recovery.phase as RecoveryPhase) === 'awaiting-gesture' &&
    isPreparedState(recovery.context),
  );
}

function emitUnhealthyRecovery(
  recovery: PendingContextRecovery,
  reason: 'context-not-running' | 'clock-stalled',
): void {
  if (!recoveryStillOwnsAttempt(recovery) || !identityStillCurrent(recovery.identity)) return;
  bus.emit('audio:output-recovery-needed', {
    reason,
    source: 'background-resume',
    queueItemId: recovery.identity.queueItemId,
    isCurrent: () => recoveryStillOwnsAttempt(recovery) && identityStillCurrent(recovery.identity),
  });
}

/**
 * A native statechange to `running` is provisional on WebKit. Automatic
 * recovery owns its own exact probe; gesture recovery leaves the same token
 * for the dialog/PLAY caller so it can preserve transient activation.
 */
function scheduleAutomaticClockVerification(recovery: PendingContextRecovery): void {
  if (
    recovery.automaticHealthProbe ||
    !recoveryStillOwnsAttempt(recovery) ||
    recovery.phase !== 'awaiting-clock-verification'
  ) {
    return;
  }
  const attemptToken = recovery.attemptToken;
  const operation = probeAudioContextHealth({
    attemptResume: false,
    context: recovery.context,
    isCurrent: () =>
      recoveryStillOwnsAttempt(recovery) &&
      recovery.attemptToken === attemptToken &&
      recovery.phase === 'awaiting-clock-verification' &&
      identityStillCurrent(recovery.identity),
  })
    .then(async (health) => {
      if (
        !recoveryStillOwnsAttempt(recovery) ||
        recovery.attemptToken !== attemptToken ||
        recovery.phase !== 'awaiting-clock-verification'
      ) {
        return;
      }
      if (!identityStillCurrent(recovery.identity) || health.reason === 'superseded') {
        retireRecovery(recovery);
        return;
      }
      if (health.healthy) {
        confirmPendingAudioContextRecoveryHealth(attemptToken);
        return;
      }
      if (health.reason === 'clock-stalled') {
        recovery.cause = 'background-clock-stalled';
        recovery.phase = 'preparing-suspend';
        await prepareStalledRecovery(recovery, { notifyWhenPrepared: true });
        return;
      }
      if (health.reason === 'not-running') {
        recovery.phase = 'awaiting-resume';
        emitUnhealthyRecovery(recovery, 'context-not-running');
      }
      // `hidden` and `inconclusive` preserve the provisional token. The next
      // exact foreground/PLAY probe may resolve it; neither is proof of harm.
    })
    .catch((error) => log.debug('[Audio] Automatic recovery clock probe failed', error))
    .finally(() => {
      if (recovery.automaticHealthProbe === operation) recovery.automaticHealthProbe = null;
    });
  recovery.automaticHealthProbe = operation;
}

function completeRunningRecovery(recovery: PendingContextRecovery): boolean {
  if (recovery.completed) return recovery.rejoinEmitted;
  if (
    !recoveryStillOwnsAttempt(recovery) ||
    !recovery.clockVerified ||
    recovery.phase !== 'awaiting-clock-verification' ||
    String(recovery.context.state) !== 'running'
  ) {
    return false;
  }
  pendingRecovery = null;
  recovery.completed = true;
  recovery.phase = 'completed';
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

function handleNativeResumeSettlement(
  recovery: PendingContextRecovery,
  resumeToken: object,
  source: 'automatic' | 'gesture',
): void {
  if (String(recovery.context.state) !== 'running') return;
  if (recoveryStillOwnsAttempt(recovery) && recovery.activeResumeToken === resumeToken) {
    recovery.activeResumeToken = null;
    recovery.phase = 'awaiting-clock-verification';
    recovery.clockVerified = false;
    if (source === 'automatic') scheduleAutomaticClockVerification(recovery);
    return;
  }

  // A retired native resume may settle after a newer identity has already
  // prepared this same context for its trusted gesture. It cannot promote A,
  // but its concrete running state must not silently undo B's suspension.
  const successor = pendingRecovery;
  if (
    !successor ||
    successor === recovery ||
    successor.context !== recovery.context ||
    !recoveryStillOwnsAttempt(successor) ||
    !identityStillCurrent(successor.identity)
  ) {
    return;
  }
  if (successor.cause === 'background-clock-stalled') {
    if (successor.phase === 'awaiting-gesture' || successor.phase === 'preparing-suspend') {
      void prepareStalledRecovery(successor, { notifyWhenPrepared: true });
    }
    return;
  }
  successor.phase = 'awaiting-clock-verification';
  successor.clockVerified = false;
  scheduleAutomaticClockVerification(successor);
}

function resumeContext(
  recovery: PendingContextRecovery,
  source: 'automatic' | 'gesture',
): Promise<ContextResumeResult> {
  const slot = source === 'automatic' ? 'automaticResume' : 'gestureResume';
  const existing = recovery[slot];
  if (existing) return existing;

  if (recoveryStillOwnsAttempt(recovery)) {
    recovery.phase = source === 'automatic' ? 'automatic-resuming' : 'gesture-resuming';
    recovery.clockVerified = false;
  }
  const resumeToken = {};
  recovery.activeResumeToken = resumeToken;

  let nativeResume: Promise<void>;
  try {
    nativeResume =
      source === 'gesture'
        ? restartAudioContextFromGesture(recovery.context)
        : recovery.context.resume();
  } catch (error) {
    nativeResume = Promise.reject(error);
  }
  void nativeResume.then(
    () => handleNativeResumeSettlement(recovery, resumeToken, source),
    () => undefined,
  );

  const operation = Promise.race([nativeResume, delay(RESUME_DEADLINE_MS)])
    .then(() => {
      if (recoveryStillOwnsAttempt(recovery)) {
        if (String(recovery.context.state) === 'running') {
          handleNativeResumeSettlement(recovery, resumeToken, source);
        } else {
          recovery.phase =
            recovery.cause === 'background-clock-stalled' && isPreparedState(recovery.context)
              ? 'awaiting-gesture'
              : 'awaiting-resume';
        }
      }
      return contextResumeResult(recovery, source);
    })
    .catch((error) => {
      log.debug(`[Audio] ${source} resume failed`, error);
      if (recoveryStillOwnsAttempt(recovery)) {
        recovery.phase =
          recovery.cause === 'background-clock-stalled' && isPreparedState(recovery.context)
            ? 'awaiting-gesture'
            : 'awaiting-resume';
      }
      if (recovery.activeResumeToken === resumeToken) recovery.activeResumeToken = null;
      return { running: false, rejoinEmitted: false, fallbackEligible: false };
    })
    .finally(() => {
      if (recovery[slot] === operation) recovery[slot] = null;
    });
  recovery[slot] = operation;
  return operation;
}

function recoveryCanAcceptGesture(recovery: PendingContextRecovery): boolean {
  if (recovery.cause !== 'background-clock-stalled') {
    return (
      recovery.phase === 'awaiting-resume' ||
      recovery.phase === 'automatic-resuming' ||
      recovery.phase === 'gesture-resuming' ||
      recovery.phase === 'awaiting-clock-verification'
    );
  }
  return recovery.phase === 'awaiting-gesture' && isPreparedState(recovery.context);
}

export function hasPendingAudioContextInterruption(mode?: RejoinMode): boolean {
  return Boolean(
    pendingRecovery &&
    (mode === undefined || pendingRecovery.identity.mode === mode) &&
    pendingRecovery.phase !== 'cancelled' &&
    pendingRecovery.phase !== 'completed',
  );
}

/** Opaque identity for the exact interruption that a trusted PLAY may resume. */
export function getPendingAudioContextInterruptionAttempt(): object | null {
  return pendingRecovery && recoveryCanAcceptGesture(pendingRecovery)
    ? pendingRecovery.attemptToken
    : null;
}

/** Includes a still-preparing attempt so a healthy probe can retire it exactly. */
export function getPendingAudioContextRecoveryAttemptForHealth(): object | null {
  return pendingRecovery?.attemptToken ?? null;
}

/**
 * Expose a one-time, exact probe requirement only after native resume reached
 * `running`. Callers must probe with `attemptResume: false`, then confirm or
 * cancel this same token. Ordinary PLAY has no work when this returns null.
 */
export function getPendingAudioContextClockHealthRequirement(): PendingAudioContextClockHealthRequirement | null {
  const recovery = pendingRecovery;
  if (
    recovery &&
    recovery.cause === 'state-interruption' &&
    String(recovery.context.state) === 'running' &&
    (recovery.phase === 'awaiting-resume' || recovery.phase === 'automatic-resuming')
  ) {
    // Some WebKit revisions update `state` without delivering statechange in
    // time. Promote only to provisional verification; never commit here.
    recovery.phase = 'awaiting-clock-verification';
    recovery.clockVerified = false;
  }
  if (
    !recovery ||
    recovery.phase !== 'awaiting-clock-verification' ||
    String(recovery.context.state) !== 'running'
  ) {
    return null;
  }
  return {
    context: recovery.context,
    attemptToken: recovery.attemptToken,
    isCurrent: () =>
      recoveryStillOwnsAttempt(recovery) &&
      recovery.phase === 'awaiting-clock-verification' &&
      String(recovery.context.state) === 'running' &&
      identityStillCurrent(recovery.identity),
  };
}

export function isAudioContextInterruptionAttemptCurrent(attemptToken: object): boolean {
  const recovery = activeRecoveryAttempt;
  return Boolean(
    recovery &&
    recovery.attemptToken === attemptToken &&
    recovery.phase !== 'cancelled' &&
    activeBindingToken === recovery.bindingToken &&
    recovery.generation === recoveryGeneration,
  );
}

/** Retry an OS recovery only when its exact native preparation is complete. */
export function resumePendingAudioContextInterruptionFromGesture(): Promise<ContextResumeResult> {
  const recovery = pendingRecovery;
  if (!recovery) {
    return Promise.resolve({ running: false, rejoinEmitted: false, fallbackEligible: false });
  }
  if (recovery.cause === 'background-clock-stalled') {
    if (!recoveryCanAcceptGesture(recovery)) {
      return Promise.resolve({ running: false, rejoinEmitted: false, fallbackEligible: false });
    }
    return resumeContext(recovery, 'gesture');
  }
  if (String(recovery.context.state) === 'running') {
    recovery.phase = 'awaiting-clock-verification';
    recovery.clockVerified = false;
    return Promise.resolve(contextResumeResult(recovery, 'gesture'));
  }
  return resumeContext(recovery, 'gesture');
}

/** Commit any recovery only after its exact foreground clock probe passes. */
export function confirmPendingAudioContextRecoveryHealth(
  attemptToken: object,
): ContextResumeResult {
  const recovery = pendingRecovery;
  if (
    !recovery ||
    recovery.attemptToken !== attemptToken ||
    !recoveryStillOwnsAttempt(recovery) ||
    recovery.phase !== 'awaiting-clock-verification' ||
    !identityStillCurrent(recovery.identity) ||
    String(recovery.context.state) !== 'running'
  ) {
    return { running: false, rejoinEmitted: false, fallbackEligible: false };
  }
  recovery.phase = 'awaiting-clock-verification';
  recovery.clockVerified = true;
  const foregroundCheck = getPendingForegroundAudioContextClockHealthCheck();
  if (foregroundCheck?.context === recovery.context) {
    consumeForegroundAudioContextClockHealthCheck(foregroundCheck.token);
  }
  const rejoinEmitted = completeRunningRecovery(recovery);
  return {
    running: String(recovery.context.state) === 'running',
    rejoinEmitted,
    fallbackEligible: false,
  };
}

/** Drop only the exact superseded recovery attempt. */
export function cancelPendingAudioContextRecovery(attemptToken: object): boolean {
  const recovery = pendingRecovery;
  if (!recovery || recovery.attemptToken !== attemptToken) return false;
  retireRecovery(recovery);
  return true;
}

/**
 * Escalate only the exact provisional state-interruption whose trusted PLAY
 * probe proved the native clock is frozen. Preparation retains the same token;
 * the recovery event is emitted only after suspend/interrupted is concrete.
 */
export async function escalatePendingAudioContextRecoveryToClockStalled(
  attemptToken: object,
): Promise<AudioContextRecoveryEscalationResult> {
  const recovery = pendingRecovery;
  if (
    !recovery ||
    recovery.attemptToken !== attemptToken ||
    !recoveryStillOwnsAttempt(recovery) ||
    !identityStillCurrent(recovery.identity)
  ) {
    return 'rejected';
  }
  if (recovery.cause === 'background-clock-stalled') {
    if (recovery.phase === 'awaiting-gesture' && isPreparedState(recovery.context)) {
      return 'prepared';
    }
    return recovery.phase === 'preparing-suspend' ? 'preparing' : 'rejected';
  }
  if (
    recovery.phase !== 'awaiting-clock-verification' ||
    String(recovery.context.state) !== 'running'
  ) {
    return 'rejected';
  }

  recovery.cause = 'background-clock-stalled';
  recovery.clockVerified = false;
  recovery.phase = 'preparing-suspend';
  await prepareStalledRecovery(recovery, { notifyWhenPrepared: true });
  if (
    recoveryStillOwnsAttempt(recovery) &&
    (recovery.phase as RecoveryPhase) === 'awaiting-gesture' &&
    isPreparedState(recovery.context)
  ) {
    return 'prepared';
  }
  return recoveryStillOwnsAttempt(recovery) &&
    (recovery.phase as RecoveryPhase) === 'preparing-suspend'
    ? 'preparing'
    : 'rejected';
}

/**
 * Arm identity-fenced recovery. A stalled running context exposes its token to
 * the UI only after the native suspend has concretely taken effect.
 */
export async function armPendingAudioContextRecoveryFromBackground(
  context: AudioContext,
  cause: RecoveryCause = 'background-clock-stalled',
): Promise<object | null> {
  const identity = activePlaybackIdentity();
  const bindingToken = activeBindingToken;
  if (!identity || identity.mode !== 'file' || !bindingToken) return null;

  let recovery = pendingRecovery;
  if (
    recovery &&
    (recovery.context !== context ||
      recovery.cause !== cause ||
      !identitiesEqual(recovery.identity, identity))
  ) {
    retireRecovery(recovery);
    recovery = null;
  }
  if (!recovery) recovery = createRecovery(context, identity, bindingToken, cause);

  if (cause !== 'background-clock-stalled') return recovery.attemptToken;
  if (recovery.phase === 'awaiting-gesture' && isPreparedState(context)) {
    return recovery.attemptToken;
  }
  if (recovery.phase === 'gesture-resuming' || recovery.phase === 'awaiting-clock-verification') {
    return null;
  }

  const prepared = await prepareStalledRecovery(recovery);
  return prepared && recoveryStillOwnsAttempt(recovery) ? recovery.attemptToken : null;
}

/** Bind one context and return an exact disposer for engine re-initialization. */
export function bindAudioContextInterruptionRecovery(context: AudioContext): () => void {
  let disposed = false;
  let resumeWithoutPlayback: Promise<void> | null = null;
  let observedHidden = document.visibilityState === 'hidden';
  let foregroundHealthToken: object | null = null;
  const bindingToken = {};
  activeBindingToken = bindingToken;
  const disposeRetiredSuspendRecovery = bindRetiredAudioContextSuspendRecovery(
    context,
    (orphanedContext) => adoptRetiredSuspendForCurrentPlayback(orphanedContext, bindingToken),
  );
  if (pendingRecovery) retireRecovery(pendingRecovery);
  activeRecoveryAttempt = null;

  const handleVisibilityChange = (): void => {
    if (disposed || activeBindingToken !== bindingToken) return;
    if (document.visibilityState === 'hidden') {
      observedHidden = true;
      return;
    }
    if (!observedHidden || document.visibilityState !== 'visible') return;
    observedHidden = false;
    let recovery = pendingRecovery?.context === context ? pendingRecovery : null;
    if (
      recovery &&
      (!recoveryStillOwnsAttempt(recovery) || !identityStillCurrent(recovery.identity))
    ) {
      retireRecovery(recovery);
      recovery = null;
    }
    if (recovery && recoveryStillOwnsAttempt(recovery) && identityStillCurrent(recovery.identity)) {
      const foregroundCheck = getPendingForegroundAudioContextClockHealthCheck();
      if (foregroundCheck?.context === context) {
        consumeForegroundAudioContextClockHealthCheck(foregroundCheck.token);
        if (foregroundHealthToken === foregroundCheck.token) foregroundHealthToken = null;
      }
      if (recovery.cause === 'state-interruption') {
        if (recovery.phase === 'awaiting-resume' && isPreparedState(context)) {
          void resumeContext(recovery, 'automatic');
        } else if (
          recovery.phase === 'awaiting-clock-verification' &&
          String(context.state) === 'running'
        ) {
          scheduleAutomaticClockVerification(recovery);
        }
      }
      return;
    }
    foregroundHealthToken = armForegroundAudioContextClockHealthCheck(context);
  };

  const handleStateChange = (): void => {
    if (disposed || activeBindingToken !== bindingToken) return;
    const state = String(context.state);
    if (
      (state === 'suspended' || state === 'interrupted') &&
      isForegroundAudioContextRestartSuspendOwned(context)
    ) {
      return;
    }
    const suspendLease = suspendLeases.get(context);
    if (suspendLease && (isPreparedState(context) || state === 'closed')) {
      settleSuspendLease(
        suspendLease,
        state === 'closed'
          ? new Error('AudioContext closed during suspend preparation')
          : undefined,
      );
      return;
    }

    if (state === 'suspended' || state === 'interrupted') {
      const identity = activePlaybackIdentity();
      let recovery = pendingRecovery?.context === context ? pendingRecovery : null;
      if (recovery && identity && !identitiesEqual(recovery.identity, identity)) {
        retireRecovery(recovery);
        recovery = null;
      }

      if (recovery?.cause === 'background-clock-stalled') {
        recovery.clockVerified = false;
        recovery.phase = 'awaiting-gesture';
        emitPreparedRecovery(recovery);
        return;
      }

      if (identity && !recovery) {
        recovery = createRecovery(context, identity, bindingToken, 'state-interruption');
      }

      log.info(`[Audio] AudioContext ${state} — auto-resuming`);
      if (recovery) {
        if (document.visibilityState === 'visible' && !recovery.gestureResume) {
          void resumeContext(recovery, 'automatic');
        }
      } else if (document.visibilityState === 'visible' && !resumeWithoutPlayback) {
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
      if (pendingRecovery?.context === context) retireRecovery(pendingRecovery);
      if (activeRecoveryAttempt?.context === context) activeRecoveryAttempt = null;
      if (activeBindingToken === bindingToken) activeBindingToken = null;
      return;
    }

    const recovery = pendingRecovery?.context === context ? pendingRecovery : null;
    if (state === 'running' && recovery) {
      if (
        recovery.phase === 'gesture-resuming' ||
        recovery.phase === 'awaiting-clock-verification'
      ) {
        recovery.phase = 'awaiting-clock-verification';
        return;
      }
      if (recovery.cause === 'background-clock-stalled' && recovery.phase === 'awaiting-gesture') {
        // A late automatic resume undid the prepared suspension before the
        // user tapped. Re-establish the suspension; do not let resume() become
        // a no-op inside the eventual trusted activation.
        void prepareStalledRecovery(recovery, { notifyWhenPrepared: true });
        return;
      }
      recovery.phase = 'awaiting-clock-verification';
      recovery.clockVerified = false;
      scheduleAutomaticClockVerification(recovery);
    }
  };

  context.addEventListener('statechange', handleStateChange);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  return () => {
    disposed = true;
    disposeRetiredSuspendRecovery();
    if (foregroundHealthToken) {
      consumeForegroundAudioContextClockHealthCheck(foregroundHealthToken);
      foregroundHealthToken = null;
    }
    if (pendingRecovery?.context === context) retireRecovery(pendingRecovery);
    if (activeRecoveryAttempt?.context === context) activeRecoveryAttempt = null;
    if (activeBindingToken === bindingToken) activeBindingToken = null;
    context.removeEventListener('statechange', handleStateChange);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}
