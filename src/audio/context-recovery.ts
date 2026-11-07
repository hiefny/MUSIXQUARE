// Resource owner: RO-01 (the AudioContext running state; target single owner).
/**
 * Recover the shared Web Audio output after an OS-level interruption.
 *
 * Ordinary suspended/interrupted contexts may auto-resume. A WebKit context
 * whose state says `running` while its clock is frozen follows a stricter
 * three-step protocol: finish one native suspend, resume synchronously from a
 * trusted gesture, then commit only after a clock probe succeeds.
 */

import { bus } from '../core/events.ts';
import { PLAYBACK_STATE } from '../core/constants.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { delay } from '../core/timers.ts';
import type { ResidentFile } from '../types/index.ts';
import {
  captureLocalFileOutputIdentity,
  localFileOutputIdentitiesEqual,
  type LocalFileOutputIdentity,
} from '../player/local-file-output-identity.ts';
import { AUDIO_SUSPEND_PREPARE_DEADLINE_MS, isAudioContextPrepared } from './context-protocol.ts';
import {
  armForegroundAudioContextClockHealthCheck,
  bindAudioContextStateDispatch,
  consumeForegroundAudioContextClockHealthCheck,
  getPendingForegroundAudioContextClockHealthCheck,
  isForegroundAudioContextRestartHolding,
  isForegroundAudioContextRestartOwned,
  probeAudioContextHealth,
  reparkForegroundAudioContextRestartAfterResume,
  requestAudioContextResume,
  requestAudioContextSuspend,
  requestRetiredAudioContextSuspendCleanup,
  type AudioContextResumeFlight,
  type AudioContextSuspendRequest,
} from './context.ts';
import {
  CONTEXT_RECOVERED_REJOINS,
  DEADLINE_AUTO_RESUME,
  DEADLINE_GESTURE_RESUME,
  DEADLINE_SCOPE_PREPARE,
  DEADLINE_SCOPE_WATCHDOG,
  RESUME_AUTO,
  RESUME_PLAY_GESTURE,
  TAPS_REFUSED,
  countAudioRecovery,
  countAudioRecoveryPhase,
  raceAudioRecoveryDeadline,
  registerAudioRecoveryOwner,
} from './output-recovery-counters.ts';

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

interface PlaybackIdentity {
  mode: RejoinMode;
  roomKind: 'standard' | 'pro';
  roomId: string | null;
  roomEpoch: number;
  queueItemId: string | null;
  residentFile: ResidentFile | null;
  demoOutput: LocalFileOutputIdentity | null;
}

interface ContextResumeResult {
  running: boolean;
  rejoinEmitted: boolean;
}

type AudioContextRecoveryEscalationResult = 'rejected' | 'prepared' | 'preparing';

type AudioContextHealth = Awaited<ReturnType<typeof probeAudioContextHealth>>;

/** The caller of the playback scope's gesture recovery, as its second step reads it. */
interface PendingInterruptionGestureCaller {
  /** The first step's answer, or the recovery dialog's race standing in for it. */
  readonly running: boolean;
  /** The caller still acts for this gesture. */
  readonly isCurrent: () => boolean;
  /** Called with the probe's answer when the output is unhealthy, before anything escalates. */
  readonly unhealthy?: (health: AudioContextHealth) => void;
  /** Media Session: this PLAY clears a local pause on the same mode (owner answer Q12, 7B-6). */
  readonly clearsLocalPause?: () => boolean;
  /** false verifies only: the dialog's failed-PLAY retry cancels the attempt itself (RO-37). */
  readonly commit?: boolean;
}

/**
 * How the gesture recovery ended: its resume did not reach running; the
 * caller or the attempt is no longer current, or no running attempt is left
 * to verify; a stale attempt was retired (7B-6) and the caller rejoins
 * itself; the probe gave no verdict on the clock; a frozen clock was
 * escalated; a healthy clock was only verified; or the attempt committed.
 */
type PendingInterruptionGestureOutcome =
  | { readonly kind: 'not-running' | 'superseded' | 'stale-retired' | 'unverified' | 'verified' }
  | { readonly kind: 'escalated'; readonly escalation: AudioContextRecoveryEscalationResult }
  | { readonly kind: 'recovered'; readonly rejoinEmitted: boolean };

interface PendingContextRecovery {
  context: AudioContext;
  identity: PlaybackIdentity;
  bindingToken: object;
  attemptToken: object;
  generation: number;
  automaticResume: Promise<ContextResumeResult> | null;
  gestureResume: Promise<ContextResumeResult> | null;
  automaticHealthProbe: Promise<void> | null;
  /** Its latest recovery resume (context.ts, Phase 7 7B-5), while that may still promote it. */
  resume: AudioContextResumeFlight<ContextResumeResult> | null;
  completed: boolean;
  rejoinEmitted: boolean;
  cause: RecoveryCause;
  phase: RecoveryPhase;
  clockVerified: boolean;
  /** Its side of the context's one suspend ledger in context.ts (Phase 7 7B-4). */
  readonly suspend: AudioContextSuspendRequest;
  /** The suspend preparation the attempt waits for: true once parked for it, false when it lost. */
  preparation: Promise<boolean> | null;
  settlePreparation: ((prepared: boolean) => void) | null;
  prepareTimedOut: boolean;
  notifyWhenPrepared: boolean;
  preparedNotificationSent: boolean;
}

let pendingRecovery: PendingContextRecovery | null = null;
let activeRecoveryAttempt: PendingContextRecovery | null = null;
let activeBindingToken: object | null = null;
let recoveryGeneration = 0;

/** Every phase write of a playback-scope attempt goes through here (the /debug counts). */
function setRecoveryPhase(recovery: PendingContextRecovery, phase: RecoveryPhase): void {
  const from = recovery.phase;
  if (from === phase) return;
  recovery.phase = phase;
  countAudioRecoveryPhase(recovery, from, phase);
}

// Live suspend leases are the one ledger's, counted by context.ts (Phase 7 7B-4).
registerAudioRecoveryOwner(playbackScopeHolding);

/**
 * Holding (ownership record Decision 6; owner answer Q9, Phase 7 7B-3): a
 * recovery owner is parking the shared context for a local file's recovery
 * dialog, has parked it for that dialog's tap, or is resuming it from that
 * tap, for an attempt it still holds with a current identity. UI sounds ask
 * this first and, while it is true, make no sound and wake nothing, so the
 * tap resumes a parked context. Reads the play-request owner's answer when
 * it is called, never at module evaluation.
 */
export function isAudioOutputRecoveryHolding(): boolean {
  return playbackScopeHolding() || isForegroundAudioContextRestartHolding();
}

/**
 * This owner's part: a file attempt it still holds, for the playing item, in
 * a phase before its tap's resume has landed (its suspend lease serves it
 * only while it prepares the suspend). Never an OS interruption waiting for
 * its automatic resume, and never a YouTube attempt: no dialog asks for that
 * tap, so holding it could silence UI sounds until the next lock-screen PLAY.
 */
function playbackScopeHolding(): boolean {
  const recovery = pendingRecovery;
  return Boolean(
    recovery &&
    recoveryStillOwnsAttempt(recovery) &&
    recovery.identity.mode === 'file' &&
    (recovery.phase === 'preparing-suspend' ||
      recovery.phase === 'awaiting-gesture' ||
      recovery.phase === 'gesture-resuming') &&
    identityStillCurrent(recovery.identity),
  );
}

function activePlaybackIdentity(): PlaybackIdentity | null {
  if (!getState('setup.sessionStarted') || getState('playback.activity') !== 'playing') {
    return null;
  }
  const mode = getState('playback.mode');
  if (mode !== 'file' && mode !== 'youtube') return null;
  const demoOutput =
    mode === 'file' && getState('demo.active') ? captureLocalFileOutputIdentity() : null;
  if (mode === 'file' && getState('demo.active') && !demoOutput) return null;
  const room = getState('room.context');
  return {
    mode,
    roomKind: room.kind,
    roomId: room.roomId,
    roomEpoch: room.epoch,
    queueItemId: demoOutput ? null : getState('playlist.currentQueueItemId'),
    residentFile: mode === 'file' ? getState('files.current') : null,
    demoOutput,
  };
}

function identitiesEqual(left: PlaybackIdentity, right: PlaybackIdentity): boolean {
  return (
    left.mode === right.mode &&
    left.roomKind === right.roomKind &&
    left.roomId === right.roomId &&
    left.roomEpoch === right.roomEpoch &&
    left.queueItemId === right.queueItemId &&
    left.residentFile === right.residentFile &&
    (left.demoOutput
      ? !!right.demoOutput && localFileOutputIdentitiesEqual(left.demoOutput, right.demoOutput)
      : right.demoOutput === null)
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
  setRecoveryPhase(recovery, 'cancelled');
  recovery.resume?.drop();
  recovery.resume = null;
  if (pendingRecovery === recovery) pendingRecovery = null;
  if (activeRecoveryAttempt === recovery) activeRecoveryAttempt = null;
  if (recovery.generation === recoveryGeneration) recoveryGeneration += 1;
}

function settleSuspendPreparation(recovery: PendingContextRecovery, prepared: boolean): void {
  const settle = recovery.settlePreparation;
  recovery.preparation = null;
  recovery.settlePreparation = null;
  settle?.(prepared);
}

/**
 * This owner's answers to the suspend ledger in context.ts (RO-01, Phase 7
 * 7B-4). A retired attempt answers as not waiting, so a lease it held ends
 * for nobody. After two lost suspends the attempt gives up and arms the next
 * PLAY's clock check; a later request taking its place retires it.
 */
function scopeSuspendRequest(attempt: () => PendingContextRecovery): AudioContextSuspendRequest {
  const preparing = (): boolean => {
    const recovery = attempt();
    return (
      recoveryStillOwnsAttempt(recovery) &&
      recovery.phase === 'preparing-suspend' &&
      identityStillCurrent(recovery.identity)
    );
  };
  const lost = (): void => {
    const recovery = attempt();
    if (recoveryStillOwnsAttempt(recovery)) retireRecovery(recovery);
    settleSuspendPreparation(recovery, false);
  };
  return {
    suspendPrepareAttempts: 0,
    suspendLease: null,
    watchdogSlot: DEADLINE_SCOPE_WATCHDOG,
    preparing,
    takesLateSuspend: preparing,
    parked: () => {
      const recovery = attempt();
      setRecoveryPhase(recovery, 'awaiting-gesture');
      if (recovery.prepareTimedOut || recovery.notifyWhenPrepared) emitPreparedRecovery(recovery);
      settleSuspendPreparation(recovery, true);
    },
    lost,
    stale: lost,
    exhausted: () => {
      const recovery = attempt();
      retireRecovery(recovery);
      settleSuspendPreparation(recovery, false);
      armForegroundAudioContextClockHealthCheck(recovery.context);
    },
    retrying: () => {
      // The original caller has already crossed its bounded preparation
      // window. A concrete state for its next suspend must therefore notify
      // the UI even when the first arm did not request eager notification.
      attempt().prepareTimedOut = true;
    },
  };
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
    resume: null,
    completed: false,
    rejoinEmitted: false,
    cause,
    phase: cause === 'background-clock-stalled' ? 'preparing-suspend' : 'awaiting-resume',
    clockVerified: false,
    suspend: scopeSuspendRequest(() => recovery),
    preparation: null,
    settlePreparation: null,
    prepareTimedOut: false,
    notifyWhenPrepared: false,
    preparedNotificationSent: false,
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
      prepareStalledRecovery(recovery, { notifyWhenPrepared: true }).catch((error) => {
        log.warn('[Audio] Failed to adopt prepared recovery after a retired suspend', error);
      });
    }
    return;
  }
  if (!isAudioContextPrepared(context)) return;

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
  setRecoveryPhase(recovery, 'awaiting-gesture');
  recovery.notifyWhenPrepared = true;
  emitPreparedRecovery(recovery);
}

async function prepareStalledRecovery(
  recovery: PendingContextRecovery,
  options: { notifyWhenPrepared?: boolean } = {},
): Promise<boolean> {
  if (!recoveryStillOwnsAttempt(recovery)) return false;
  recovery.notifyWhenPrepared ||= options.notifyWhenPrepared === true;

  if (isAudioContextPrepared(recovery.context)) {
    setRecoveryPhase(recovery, 'awaiting-gesture');
    if (recovery.notifyWhenPrepared) emitPreparedRecovery(recovery);
    return true;
  }

  setRecoveryPhase(recovery, 'preparing-suspend');
  recovery.clockVerified = false;
  recovery.prepareTimedOut = false;
  recovery.preparedNotificationSent = false;

  // The context's one suspend ledger (context.ts, Phase 7 7B-4): a late fence
  // keeps this attempt waiting for its next suspend, a lease in flight is
  // taken over (the earlier attempt on it retires), otherwise one fresh
  // native suspend.
  const preparation =
    recovery.preparation ??
    (recovery.preparation = new Promise<boolean>((resolve) => {
      recovery.settlePreparation = resolve;
    }));
  requestAudioContextSuspend(recovery.context, recovery.suspend);

  const outcome = await raceAudioRecoveryDeadline(
    DEADLINE_SCOPE_PREPARE,
    preparation.then((prepared) => ({ type: 'settled' as const, prepared })),
    delay(AUDIO_SUSPEND_PREPARE_DEADLINE_MS).then(() => ({ type: 'timeout' as const })),
  );
  if (outcome.type === 'timeout') {
    if (
      recoveryStillOwnsAttempt(recovery) &&
      recovery.phase === 'preparing-suspend' &&
      recovery.preparation === preparation
    ) {
      recovery.prepareTimedOut = true;
    }
    return false;
  }
  return Boolean(
    outcome.prepared &&
    recoveryStillOwnsAttempt(recovery) &&
    (recovery.phase as RecoveryPhase) === 'awaiting-gesture' &&
    isAudioContextPrepared(recovery.context),
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
    document.visibilityState !== 'visible' ||
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
        setRecoveryPhase(recovery, 'preparing-suspend');
        await prepareStalledRecovery(recovery, { notifyWhenPrepared: true });
        return;
      }
      if (health.reason === 'not-running') {
        setRecoveryPhase(recovery, 'awaiting-resume');
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
  setRecoveryPhase(recovery, 'completed');
  if (!identityStillCurrent(recovery.identity)) return false;
  recovery.rejoinEmitted = true;
  countAudioRecovery(CONTEXT_RECOVERED_REJOINS);
  bus.emit('playback:local-output-rejoin', {
    reason: 'audio-context-recovered',
    mode: recovery.identity.mode,
  });
  return true;
}

function contextResumeResult(recovery: PendingContextRecovery): ContextResumeResult {
  const rejoinEmitted = completeRunningRecovery(recovery);
  return { running: String(recovery.context.state) === 'running', rejoinEmitted };
}

/**
 * A retired attempt's resume brought the context to running. A newer
 * identity may already have prepared this same context for its trusted
 * gesture: the old resume cannot promote it, but its concrete running state
 * must not silently undo the newer attempt's suspension.
 */
function handleRetiredResumeLanding(recovery: PendingContextRecovery): void {
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
      prepareStalledRecovery(successor, { notifyWhenPrepared: true }).catch((error) => {
        log.warn('[Audio] Successor stalled recovery preparation failed', error);
      });
    }
    return;
  }
  setRecoveryPhase(successor, 'awaiting-clock-verification');
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
    setRecoveryPhase(recovery, source === 'automatic' ? 'automatic-resuming' : 'gesture-resuming');
    recovery.clockVerified = false;
  }
  const reportBlockedDemoResume = (): void => {
    // Demo has no resident queue file, so its semantic interruption owner must
    // surface a failed automatic resume instead of leaving the app inspector
    // waiting on this pending attempt forever. Hidden attempts stay quiet.
    if (
      source === 'automatic' &&
      recovery.identity.demoOutput &&
      document.visibilityState === 'visible' &&
      isAudioContextPrepared(recovery.context)
    ) {
      emitUnhealthyRecovery(recovery, 'context-not-running');
    }
  };

  // The one recovery resume in context.ts (Phase 7 7B-5, C1-I12), with this
  // owner's step rules; a newer resume of the same attempt replaces an older
  // one's promotion.
  recovery.resume?.drop();
  const flight = requestAudioContextResume(recovery.context, {
    resumeSlot: source === 'gesture' ? RESUME_PLAY_GESTURE : RESUME_AUTO,
    deadlineSlot: source === 'gesture' ? DEADLINE_GESTURE_RESUME : DEADLINE_AUTO_RESUME,
    holds: () => recoveryStillOwnsAttempt(recovery),
    promoted: (callerWaits) => {
      setRecoveryPhase(recovery, 'awaiting-clock-verification');
      recovery.clockVerified = false;
      // A gesture caller probes its own token while its flight is open. Once
      // the resume deadline has returned it running:false, this late
      // `running` has no other prober, so the owner verifies it (fix lane G7).
      if (source === 'automatic' || !callerWaits) scheduleAutomaticClockVerification(recovery);
    },
    // After the deadline a clock-stalled attempt still parked waits for its
    // gesture again; otherwise the attempt waits for a resume.
    missed: () =>
      setRecoveryPhase(
        recovery,
        recovery.cause === 'background-clock-stalled' && isAudioContextPrepared(recovery.context)
          ? 'awaiting-gesture'
          : 'awaiting-resume',
      ),
    landed: () => handleRetiredResumeLanding(recovery),
    result: (outcome) => {
      reportBlockedDemoResume();
      return outcome === 'refused'
        ? { running: false, rejoinEmitted: false }
        : contextResumeResult(recovery);
    },
  });
  recovery.resume = flight;
  const operation = flight.settled.finally(() => {
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
  return recovery.phase === 'awaiting-gesture' && isAudioContextPrepared(recovery.context);
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
 * The gesture recovery's own observation (ownership record Decision 5, Phase
 * 7 7C-1), at the moment its callers read the clock requirement before: a
 * running state-interruption attempt still waiting for its resume moves to
 * clock verification. No query changes the owner's state.
 */
function observeRunningInterruption(): void {
  const recovery = pendingRecovery;
  if (
    recovery &&
    recovery.cause === 'state-interruption' &&
    String(recovery.context.state) === 'running' &&
    (recovery.phase === 'awaiting-resume' || recovery.phase === 'automatic-resuming')
  ) {
    // Some WebKit revisions update `state` without delivering statechange in
    // time. Promote only to provisional verification; never commit here.
    setRecoveryPhase(recovery, 'awaiting-clock-verification');
    recovery.clockVerified = false;
  }
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

/**
 * The playback scope's trusted gesture, first step (RO-01, Phase 7 7C-1; one
 * owner sequence in two steps while the recovery dialog races the resume
 * alone, until 7C-2): resume the pending attempt synchronously inside the
 * caller's activation, a clock-stalled one only when its exact native
 * preparation is complete. Its answer settles by the resume deadline; the
 * caller hands it to finishPendingInterruptionRecoveryFromGesture.
 */
export function beginPendingInterruptionRecoveryFromGesture(): Promise<ContextResumeResult> {
  const recovery = pendingRecovery;
  if (!recovery) {
    return Promise.resolve({ running: false, rejoinEmitted: false });
  }
  if (recovery.cause === 'background-clock-stalled') {
    if (!recoveryCanAcceptGesture(recovery)) {
      countAudioRecovery(TAPS_REFUSED);
      return Promise.resolve({ running: false, rejoinEmitted: false });
    }
    return resumeContext(recovery, 'gesture');
  }
  if (String(recovery.context.state) === 'running') {
    setRecoveryPhase(recovery, 'awaiting-clock-verification');
    recovery.clockVerified = false;
    return Promise.resolve(contextResumeResult(recovery));
  }
  return resumeContext(recovery, 'gesture');
}

/** Commit any recovery only after its exact foreground clock probe passes. */
function confirmPendingAudioContextRecoveryHealth(attemptToken: object): ContextResumeResult {
  const recovery = pendingRecovery;
  if (
    !recovery ||
    recovery.attemptToken !== attemptToken ||
    !recoveryStillOwnsAttempt(recovery) ||
    recovery.phase !== 'awaiting-clock-verification' ||
    !identityStillCurrent(recovery.identity) ||
    String(recovery.context.state) !== 'running'
  ) {
    return { running: false, rejoinEmitted: false };
  }
  setRecoveryPhase(recovery, 'awaiting-clock-verification');
  recovery.clockVerified = true;
  const foregroundCheck = getPendingForegroundAudioContextClockHealthCheck();
  if (foregroundCheck?.context === recovery.context) {
    consumeForegroundAudioContextClockHealthCheck(foregroundCheck.token);
  }
  const rejoinEmitted = completeRunningRecovery(recovery);
  return {
    running: String(recovery.context.state) === 'running',
    rejoinEmitted,
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
 * A trusted PLAY resumed the context for this exact file attempt, but the
 * attempt's output no longer plays (a local PAUSE stopped it), so it can never
 * prove its clock (owner answer Q12, C1-I5 lock-screen pause, Phase 7 7B-6).
 * Retire it and arm the next PLAY's clock check in its place, as an attempt
 * that gives up does, unless one is pending for this context already (the
 * hidden boundary's keeps its continuity). The PLAY then rejoins the room
 * itself. true when the attempt was retired here.
 */
function retireStalePendingAudioContextRecovery(attemptToken: object): boolean {
  const recovery = pendingRecovery;
  if (
    !recovery ||
    recovery.attemptToken !== attemptToken ||
    !recoveryStillOwnsAttempt(recovery) ||
    recovery.identity.mode !== 'file' ||
    recovery.phase !== 'awaiting-clock-verification' ||
    String(recovery.context.state) !== 'running' ||
    identityStillCurrent(recovery.identity)
  ) {
    return false;
  }
  retireRecovery(recovery);
  if (getPendingForegroundAudioContextClockHealthCheck()?.context !== recovery.context) {
    armForegroundAudioContextClockHealthCheck(recovery.context);
  }
  return true;
}

/**
 * Escalate only the exact provisional state-interruption whose trusted PLAY
 * probe proved the native clock is frozen. Preparation retains the same token;
 * the recovery event is emitted only after suspend/interrupted is concrete.
 */
async function escalatePendingAudioContextRecoveryToClockStalled(
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
    if (recovery.phase === 'awaiting-gesture' && isAudioContextPrepared(recovery.context)) {
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
  setRecoveryPhase(recovery, 'preparing-suspend');
  await prepareStalledRecovery(recovery, { notifyWhenPrepared: true });
  if (
    recoveryStillOwnsAttempt(recovery) &&
    (recovery.phase as RecoveryPhase) === 'awaiting-gesture' &&
    isAudioContextPrepared(recovery.context)
  ) {
    return 'prepared';
  }
  return recoveryStillOwnsAttempt(recovery) &&
    (recovery.phase as RecoveryPhase) === 'preparing-suspend'
    ? 'preparing'
    : 'rejected';
}

/**
 * The playback scope's trusted gesture, second step (RO-01, Phase 7 7C-1),
 * for the recovery dialog and a Media Session PLAY alike. A resume that did
 * not reach running is let go: the owner verifies a late running state
 * itself (fix lane G7). Otherwise the owner observes the running attempt,
 * probes the clock of this exact attempt, and escalates a frozen clock to a
 * prepared stalled recovery or commits a healthy one with its one rejoin.
 * With no running attempt to verify, a PLAY that clears a local pause
 * retires the stale attempt (7B-6). The caller's currency is read before the
 * requirement, inside the probe and after it, never after the commit.
 */
export async function finishPendingInterruptionRecoveryFromGesture(
  attemptToken: object,
  caller: PendingInterruptionGestureCaller,
): Promise<PendingInterruptionGestureOutcome> {
  if (!caller.running) return { kind: 'not-running' };
  if (!caller.isCurrent() || !isAudioContextInterruptionAttemptCurrent(attemptToken)) {
    return { kind: 'superseded' };
  }
  observeRunningInterruption();
  const recovery = pendingRecovery;
  const requirementIsCurrent = (): boolean =>
    !!recovery &&
    recoveryStillOwnsAttempt(recovery) &&
    recovery.phase === 'awaiting-clock-verification' &&
    String(recovery.context.state) === 'running' &&
    identityStillCurrent(recovery.identity);
  if (!recovery || recovery.attemptToken !== attemptToken || !requirementIsCurrent()) {
    return caller.clearsLocalPause?.() && retireStalePendingAudioContextRecovery(attemptToken)
      ? { kind: 'stale-retired' }
      : { kind: 'superseded' };
  }
  const health = await probeAudioContextHealth({
    attemptResume: false,
    context: recovery.context,
    isCurrent: () => caller.isCurrent() && requirementIsCurrent(),
  });
  if (!health.healthy) {
    caller.unhealthy?.(health);
    if (health.reason !== 'clock-stalled') return { kind: 'unverified' };
  }
  if (!caller.isCurrent() || !requirementIsCurrent()) return { kind: 'superseded' };
  if (!health.healthy) {
    return {
      kind: 'escalated',
      escalation: await escalatePendingAudioContextRecoveryToClockStalled(attemptToken),
    };
  }
  if (caller.commit === false) return { kind: 'verified' };
  const confirmed = confirmPendingAudioContextRecoveryHealth(attemptToken);
  return confirmed.running
    ? { kind: 'recovered', rejoinEmitted: confirmed.rejoinEmitted }
    : { kind: 'superseded' };
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
  if (recovery.phase === 'awaiting-gesture' && isAudioContextPrepared(context)) {
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
  let hiddenContinuityCaptured = false;
  const bindingToken = {};
  activeBindingToken = bindingToken;
  if (pendingRecovery) retireRecovery(pendingRecovery);
  activeRecoveryAttempt = null;
  const retireSupersededDemoOutput = (): void => {
    if (disposed || activeBindingToken !== bindingToken) return;
    const recovery = activeRecoveryAttempt;
    if (recovery?.identity.demoOutput && !identityStillCurrent(recovery.identity)) {
      // Retire even a completed gesture token so it cannot retain the previous
      // demo's decoded PCM after exit or carry a late resume into its successor.
      retireRecovery(recovery);
    }
  };
  const disposeDemoIdentityObservers = [
    bus.on('player:buffer-changed', retireSupersededDemoOutput),
    bus.on('state:demo.active', retireSupersededDemoOutput),
    bus.on('state:demo.currentTrackIndex', retireSupersededDemoOutput),
    bus.on('state:playback.activity', retireSupersededDemoOutput),
    bus.on('state:playback.mode', retireSupersededDemoOutput),
    bus.on('state:room.context', retireSupersededDemoOutput),
    bus.on('state:setup.sessionStarted', retireSupersededDemoOutput),
  ];

  const continueRecoveryInForeground = (recovery: PendingContextRecovery): void => {
    if (
      disposed ||
      activeBindingToken !== bindingToken ||
      document.visibilityState !== 'visible' ||
      !recoveryStillOwnsAttempt(recovery) ||
      !identityStillCurrent(recovery.identity)
    ) {
      return;
    }
    if (
      recovery.cause === 'state-interruption' &&
      recovery.phase === 'awaiting-resume' &&
      isAudioContextPrepared(context)
    ) {
      resumeContext(recovery, 'automatic').catch((error) => {
        log.warn('[Audio] Foreground automatic resume failed', error);
      });
      return;
    }
    // Either cause: a running attempt that could not prove its clock while
    // hidden has no other prober on return (fix lane G7). A stalled attempt is
    // never resumed here; only its trusted gesture resumes it.
    if (recovery.phase === 'awaiting-clock-verification' && String(context.state) === 'running') {
      scheduleAutomaticClockVerification(recovery);
    }
  };

  const captureHiddenContinuityIncident = (): void => {
    if (hiddenContinuityCaptured) return;
    const existingForegroundCheck = getPendingForegroundAudioContextClockHealthCheck();
    if (
      existingForegroundCheck?.context === context &&
      isForegroundAudioContextRestartOwned(context)
    ) {
      // A prepared/gesture-verifying restart owns this token. Replacing it at
      // a second hidden boundary would cancel the trusted recovery attempt.
      foregroundHealthToken = existingForegroundCheck.token;
      hiddenContinuityCaptured = true;
      return;
    }
    foregroundHealthToken = armForegroundAudioContextClockHealthCheck(context, {
      captureHiddenContinuity: true,
    });
    hiddenContinuityCaptured = foregroundHealthToken !== null;
  };

  const handleVisibilityChange = (): void => {
    if (disposed || activeBindingToken !== bindingToken) return;
    if (document.visibilityState === 'hidden') {
      // Capture the physical Web Audio clock at the actual hidden boundary.
      // The earlier app-level resume listener can then inspect this exact
      // incident on `visible`, independent of listener registration order.
      captureHiddenContinuityIncident();
      observedHidden = true;
      return;
    }
    if (!observedHidden || document.visibilityState !== 'visible') return;
    observedHidden = false;
    hiddenContinuityCaptured = false;
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
        if (recovery.phase === 'automatic-resuming') {
          // A hidden iOS resume may leave its native Promise unresolved until
          // after the page is visible again. Follow the bounded flight rather
          // than abandoning foreground recovery in `automatic-resuming`.
          // Once its deadline settles the phase, retry a still-prepared
          // context or begin the foreground-only clock proof.
          const hiddenResume = recovery.automaticResume;
          if (hiddenResume) {
            hiddenResume
              .then(() => continueRecoveryInForeground(recovery))
              .catch((error) => log.warn('[Audio] Hidden resume follow-up failed', error));
          }
        } else {
          continueRecoveryInForeground(recovery);
        }
      } else {
        continueRecoveryInForeground(recovery);
      }
      return;
    }
    const existingForegroundCheck = getPendingForegroundAudioContextClockHealthCheck();
    if (existingForegroundCheck?.context === context) {
      // A token captured on `hidden` owns this same visibility incident. Do
      // not replace it with a visible-only token and discard its continuity
      // evidence merely because this listener runs after the app guard.
      foregroundHealthToken = existingForegroundCheck.token;
    } else {
      // Binding can be installed while already hidden, so retain a visible
      // fallback for that bootstrap edge even though it has no hidden sample.
      foregroundHealthToken = armForegroundAudioContextClockHealthCheck(context);
    }
  };

  /** A suspended or interrupted context that no suspend lease or fence waits for. */
  const handleInterruption = (state: string): void => {
    const identity = activePlaybackIdentity();
    let recovery = pendingRecovery?.context === context ? pendingRecovery : null;
    if (recovery && identity && !identitiesEqual(recovery.identity, identity)) {
      retireRecovery(recovery);
      recovery = null;
    }

    if (recovery?.cause === 'background-clock-stalled') {
      recovery.clockVerified = false;
      setRecoveryPhase(recovery, 'awaiting-gesture');
      emitPreparedRecovery(recovery);
      return;
    }

    if (identity && !recovery) {
      recovery = createRecovery(context, identity, bindingToken, 'state-interruption');
    }

    log.info(`[Audio] AudioContext ${state}: auto-resuming`);
    if (recovery) {
      // An active local-file output is allowed to keep its native audio
      // session alive while iOS moves the page to the background. Calling
      // resume() here is deliberately best-effort and synchronous with the
      // native statechange; health proof, UI, and room rejoin remain gated
      // by scheduleAutomaticClockVerification() until foreground. YouTube
      // and idle contexts have no Web Audio output to preserve and must not
      // manufacture a hidden resume.
      const canAttemptHiddenFileResume =
        document.visibilityState === 'hidden' &&
        identity?.mode === 'file' &&
        getState('playback.lifecycle') === PLAYBACK_STATE.PLAYING;
      if (
        (document.visibilityState === 'visible' || canAttemptHiddenFileResume) &&
        !recovery.gestureResume
      ) {
        resumeContext(recovery, 'automatic').catch((error) => {
          log.warn('[Audio] State-change automatic resume failed', error);
        });
      }
    } else if (document.visibilityState === 'visible' && !resumeWithoutPlayback) {
      countAudioRecovery(RESUME_AUTO);
      const operation = context
        .resume()
        .catch((error) => log.debug('[Audio] Auto-resume failed', error))
        .finally(() => {
          if (resumeWithoutPlayback === operation) resumeWithoutPlayback = null;
        });
      resumeWithoutPlayback = operation;
    }
  };

  /**
   * First in the context's one dispatcher (context.ts). A parked state that
   * the suspend ledger or a play-request restart keeps goes to them next.
   */
  const judgeStateChange = (ledgerKeepsState: boolean): void => {
    if (disposed || activeBindingToken !== bindingToken) return;
    const state = String(context.state);
    // WebKit does not guarantee visibilitychange is delivered before the
    // native AudioContext interruption. Remember the hidden interval from
    // either signal so the matching visible event cannot be discarded.
    if (document.visibilityState === 'hidden') {
      captureHiddenContinuityIncident();
      observedHidden = true;
    }
    if (ledgerKeepsState) return;

    if (state === 'suspended' || state === 'interrupted') {
      handleInterruption(state);
      return;
    }

    if (state === 'closed') {
      if (pendingRecovery?.context === context) retireRecovery(pendingRecovery);
      if (activeRecoveryAttempt?.context === context) activeRecoveryAttempt = null;
      if (activeBindingToken === bindingToken) activeBindingToken = null;
      return;
    }

    // A play-request attempt waiting for its tap is parked again on this edge
    // by its own owner, the same rule as this scope's below (C1-I13 a, Phase
    // 7 7B-2): every context has this binding, so it hands the edge over.
    if (state === 'running') reparkForegroundAudioContextRestartAfterResume(context);
    const recovery = pendingRecovery?.context === context ? pendingRecovery : null;
    if (state === 'running' && recovery) {
      // Its own resume, the deadline passed or not, is promoted by the
      // dispatcher's last part next (C1-I12, Phase 7 7B-5): a late gesture
      // resume is not an outside resume to undo, and is verified (G7).
      if (recovery.resume?.active()) return;
      if (
        recovery.phase === 'gesture-resuming' ||
        recovery.phase === 'awaiting-clock-verification'
      ) {
        setRecoveryPhase(recovery, 'awaiting-clock-verification');
        return;
      }
      if (recovery.cause === 'background-clock-stalled' && recovery.phase === 'awaiting-gesture') {
        // A late automatic resume undid the prepared suspension before the
        // user tapped. Re-establish the suspension; do not let resume() become
        // a no-op inside the eventual trusted activation.
        prepareStalledRecovery(recovery, { notifyWhenPrepared: true }).catch((error) => {
          log.warn('[Audio] Failed to restore prepared recovery after late resume', error);
        });
        return;
      }
      setRecoveryPhase(recovery, 'awaiting-clock-verification');
      recovery.clockVerified = false;
      scheduleAutomaticClockVerification(recovery);
    }
  };

  /**
   * A suspend landed inside the late fence that no attempt waits for. A local
   * file is adopted for its recovery dialog once the retired suspend is
   * undone, and with nothing playing it is only undone. Other playback
   * (YouTube) has no dialog, so it is the interruption it would be outside
   * the fence (owner answer Q6, Phase 7 7B-4).
   */
  const takeLateSuspend = (): boolean => {
    if (disposed || activeBindingToken !== bindingToken) return false;
    const identity = activePlaybackIdentity();
    if (identity && identity.mode !== 'file') handleInterruption(String(context.state));
    else requestRetiredAudioContextSuspendCleanup(context);
    return true;
  };

  const disposeStateDispatch = bindAudioContextStateDispatch(context, {
    judge: judgeStateChange,
    adoptRetiredSuspend: () => adoptRetiredSuspendForCurrentPlayback(context, bindingToken),
    takeLateSuspend,
  });
  document.addEventListener('visibilitychange', handleVisibilityChange);
  return () => {
    disposed = true;
    for (const dispose of disposeDemoIdentityObservers) dispose();
    if (foregroundHealthToken) {
      consumeForegroundAudioContextClockHealthCheck(foregroundHealthToken);
      foregroundHealthToken = null;
    }
    if (pendingRecovery?.context === context) retireRecovery(pendingRecovery);
    if (activeRecoveryAttempt?.context === context) activeRecoveryAttempt = null;
    if (activeBindingToken === bindingToken) activeBindingToken = null;
    disposeStateDispatch();
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}
