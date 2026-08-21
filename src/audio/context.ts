/**
 * MUSIXQUARE — AudioContext Singleton
 *
 * Owns the lazily created native AudioContext shared by all audio modules.
 */

import { delay } from '../core/timers.ts';

let _ctx: AudioContext | null = null;
let foregroundClockHealthGeneration = 0;

interface ForegroundClockHealthIncident {
  readonly context: AudioContext;
  readonly token: object;
  readonly generation: number;
  /** Exact hidden-boundary samples for proving that the native clock continued. */
  readonly hiddenAtWallMs: number | null;
  readonly hiddenAtContextSeconds: number | null;
}

type ForegroundRestartPhase =
  | 'preparing-suspend'
  | 'awaiting-gesture'
  | 'gesture-resuming'
  | 'awaiting-clock-verification'
  | 'completed'
  | 'cancelled';

interface ForegroundRestartAttempt {
  readonly context: AudioContext;
  readonly checkToken: object;
  readonly attemptToken: object;
  readonly generation: number;
  phase: ForegroundRestartPhase;
  suspendLease: ForegroundSuspendLease | null;
  gestureResume: Promise<ForegroundAudioContextRestartResumeResult> | null;
  activeResumeToken: object | null;
  removeResumeStateListener: (() => void) | null;
  resolvePrepared: (prepared: boolean) => void;
  readonly whenPrepared: Promise<boolean>;
  preparedSettled: boolean;
  suspendPrepareAttempts: number;
}

interface ForegroundSuspendLease {
  readonly context: AudioContext;
  owner: ForegroundRestartAttempt | null;
  settled: boolean;
  abandoned: boolean;
  nativeResolvedWithoutPrepared: boolean;
  autoRotateToken: object | null;
  removeStateListener: () => void;
}

interface ForegroundLateSuspendFence {
  readonly context: AudioContext;
  readonly token: object;
  remove: () => void;
  successor: ForegroundRestartAttempt | null;
}

interface RetiredSuspendRecoveryBinding {
  readonly token: object;
  readonly recover: (context: AudioContext) => void;
}

let pendingForegroundClockHealthIncident: ForegroundClockHealthIncident | null = null;
let pendingForegroundRestartAttempt: ForegroundRestartAttempt | null = null;
let foregroundRestartGeneration = 0;
const foregroundSuspendLeases = new WeakMap<AudioContext, ForegroundSuspendLease>();
const foregroundLateSuspendFences = new WeakMap<AudioContext, ForegroundLateSuspendFence>();
const retiredSuspendRecoveryBindings = new WeakMap<AudioContext, RetiredSuspendRecoveryBinding>();
const retiredSuspendCleanupFlights = new WeakMap<AudioContext, Promise<void>>();

const AUDIO_RESUME_DEADLINE_MS = 500;
const AUDIO_CLOCK_SAMPLE_MS = 180;
const AUDIO_CLOCK_MIN_ADVANCE_SECONDS = 0.01;
const FOREGROUND_SUSPEND_PREPARE_DEADLINE_MS = 500;
const FOREGROUND_GESTURE_RESUME_DEADLINE_MS = 750;
const FOREGROUND_LATE_SUSPEND_FENCE_MS = 250;
const FOREGROUND_SUSPEND_WATCHDOG_MS =
  FOREGROUND_SUSPEND_PREPARE_DEADLINE_MS + FOREGROUND_LATE_SUSPEND_FENCE_MS;
const MAX_FOREGROUND_SUSPEND_ATTEMPTS = 2;
const RETIRED_SUSPEND_CLEANUP_DEADLINE_MS = 500;

export type AudioContextHealthReason =
  | 'healthy'
  | 'not-created'
  | 'not-running'
  | 'clock-stalled'
  | 'inconclusive'
  | 'hidden'
  | 'superseded';

interface AudioContextHealthResult {
  readonly healthy: boolean;
  readonly reason: AudioContextHealthReason;
  readonly state: string;
  readonly clockAdvanceSeconds: number | null;
}

interface ForegroundAudioContextClockHealthCheck {
  readonly context: AudioContext;
  readonly token: object;
  readonly isCurrent: () => boolean;
  /**
   * Wall time which was not matched by AudioContext.currentTime while hidden.
   * `null` means this token was armed as a visible fallback without a hidden
   * boundary, so callers must not infer an output discontinuity from it.
   */
  readonly getHiddenContinuityGapSeconds: () => number | null;
}

interface ForegroundAudioContextRestartPreparation {
  readonly status: 'prepared' | 'preparing';
  readonly attemptToken: object;
  readonly whenPrepared: Promise<boolean>;
  readonly isCurrent: () => boolean;
}

interface ForegroundAudioContextRestartResumeResult {
  readonly running: boolean;
  readonly requiresClockVerification: boolean;
}

interface ForegroundAudioContextRestartClockHealthRequirement {
  readonly context: AudioContext;
  readonly attemptToken: object;
  readonly isCurrent: () => boolean;
}

class AudioContextNotRunningError extends Error {
  constructor(readonly state: string) {
    super(`AudioContext did not enter running state (state: ${state})`);
    this.name = 'AudioContextNotRunningError';
  }
}

/**
 * Get or create the shared AudioContext.
 * Created lazily on first call (should be inside a user gesture handler).
 */
export function getAudioContext(): AudioContext {
  if (!_ctx) {
    _ctx = new AudioContext();
  }
  return _ctx;
}

/** Observe the singleton without creating an AudioContext outside a gesture. */
export function getExistingAudioContext(): AudioContext | null {
  return _ctx;
}

function isForegroundRestartPrepared(context: AudioContext): boolean {
  const state = String(context.state);
  return state === 'suspended' || state === 'interrupted';
}

function foregroundRestartStillCurrent(attempt: ForegroundRestartAttempt): boolean {
  const incident = pendingForegroundClockHealthIncident;
  return Boolean(
    pendingForegroundRestartAttempt === attempt &&
    incident?.token === attempt.checkToken &&
    incident.context === attempt.context &&
    attempt.generation === foregroundRestartGeneration &&
    attempt.phase !== 'cancelled' &&
    attempt.phase !== 'completed',
  );
}

function notifyRetiredSuspendRecovery(context: AudioContext): void {
  retiredSuspendRecoveryBindings.get(context)?.recover(context);
}

/**
 * Register the exact context binder that may adopt an orphaned physical
 * suspension after best-effort cleanup fails. Disposing an older engine can
 * never notify its successor through this token fence.
 */
export function bindRetiredAudioContextSuspendRecovery(
  context: AudioContext,
  recover: (context: AudioContext) => void,
): () => void {
  const binding: RetiredSuspendRecoveryBinding = { token: {}, recover };
  retiredSuspendRecoveryBindings.set(context, binding);
  return () => {
    if (retiredSuspendRecoveryBindings.get(context)?.token === binding.token) {
      retiredSuspendRecoveryBindings.delete(context);
    }
  };
}

/**
 * Undo a retired native suspend, but never swallow a context that WebKit keeps
 * parked. After a bounded cleanup attempt the current binder adopts the
 * concrete suspension into a fresh, identity-fenced gesture recovery.
 */
export function requestRetiredAudioContextSuspendCleanup(context: AudioContext): void {
  if (
    document.visibilityState !== 'visible' ||
    !isForegroundRestartPrepared(context) ||
    isForegroundAudioContextRestartOwned(context) ||
    retiredSuspendCleanupFlights.has(context)
  ) {
    return;
  }

  let nativeResume: Promise<void>;
  try {
    nativeResume = context.resume();
  } catch (error) {
    nativeResume = Promise.reject(error);
  }
  const cleanupSettled = nativeResume.then(
    () => undefined,
    () => undefined,
  );
  const operation = Promise.race([cleanupSettled, delay(RETIRED_SUSPEND_CLEANUP_DEADLINE_MS)])
    .then(() => {
      if (document.visibilityState === 'visible' && isForegroundRestartPrepared(context)) {
        notifyRetiredSuspendRecovery(context);
      }
    })
    .finally(() => {
      if (retiredSuspendCleanupFlights.get(context) === operation) {
        retiredSuspendCleanupFlights.delete(context);
      }
    });
  retiredSuspendCleanupFlights.set(context, operation);

  // WebKit may resolve resume() and switch to running without dispatching a
  // statechange. Always notify the exact current binding on native success so
  // an already-adopted gesture recovery can re-establish its suspension.
  void nativeResume.then(
    () => {
      if (document.visibilityState === 'visible') {
        notifyRetiredSuspendRecovery(context);
      }
    },
    () => undefined,
  );
}

function clearForegroundLateSuspendFence(context: AudioContext): void {
  const fence = foregroundLateSuspendFences.get(context);
  if (!fence) return;
  fence.remove();
  foregroundLateSuspendFences.delete(context);
}

function abandonForegroundSuspendLease(
  lease: ForegroundSuspendLease,
  installLateFence: boolean,
): void {
  if (lease.settled || lease.abandoned) return;
  lease.abandoned = true;
  lease.settled = true;
  lease.autoRotateToken = null;
  lease.removeStateListener();
  if (foregroundSuspendLeases.get(lease.context) === lease) {
    foregroundSuspendLeases.delete(lease.context);
  }
  if (lease.owner?.suspendLease === lease) lease.owner.suspendLease = null;
  lease.owner = null;
  if (installLateFence) installForegroundLateSuspendFence(lease.context);
}

function startFreshForegroundSuspend(attempt: ForegroundRestartAttempt): void {
  if (!foregroundRestartStillCurrent(attempt) || attempt.phase !== 'preparing-suspend') return;
  const lateFence = foregroundLateSuspendFences.get(attempt.context);
  if (lateFence) {
    lateFence.successor = attempt;
    return;
  }
  const existing = foregroundSuspendLeases.get(attempt.context);
  if (existing && !existing.settled) {
    existing.owner = attempt;
    attempt.suspendLease = existing;
    return;
  }
  createForegroundSuspendLease(attempt.context, attempt);
}

function handleForegroundLateSuspend(context: AudioContext, fenceToken: object): void {
  const fence = foregroundLateSuspendFences.get(context);
  if (!fence || fence.token !== fenceToken || !isForegroundRestartPrepared(context)) return;
  const fencedSuccessor = fence.successor;
  clearForegroundLateSuspendFence(context);

  const successor = fencedSuccessor ?? pendingForegroundRestartAttempt;
  if (
    successor &&
    successor.context === context &&
    foregroundRestartStillCurrent(successor) &&
    (successor.phase === 'preparing-suspend' || successor.phase === 'awaiting-gesture')
  ) {
    // The old operation cannot commit anything by itself, but its concrete
    // suspended state is exactly the safe precondition the current successor
    // needs. Hand the physical state to B instead of resume -> suspend
    // self-quarantining in a loop.
    if (successor.suspendLease) {
      settleForegroundSuspendLease(successor.suspendLease);
    } else {
      successor.phase = 'awaiting-gesture';
      if (!successor.preparedSettled) {
        successor.preparedSettled = true;
        successor.resolvePrepared(true);
      }
    }
    return;
  }

  requestRetiredAudioContextSuspendCleanup(context);
}

function installForegroundLateSuspendFence(context: AudioContext): void {
  clearForegroundLateSuspendFence(context);
  const token = {};
  const handleStateChange = (): void => handleForegroundLateSuspend(context, token);
  const fence: ForegroundLateSuspendFence = {
    context,
    token,
    remove: () => context.removeEventListener('statechange', handleStateChange),
    successor: null,
  };
  foregroundLateSuspendFences.set(context, fence);
  context.addEventListener('statechange', handleStateChange);
  void delay(FOREGROUND_LATE_SUSPEND_FENCE_MS).then(() => {
    if (foregroundLateSuspendFences.get(context) === fence) {
      const successor = fence.successor;
      clearForegroundLateSuspendFence(context);
      if (successor) startFreshForegroundSuspend(successor);
    }
  });
}

function retireForegroundRestartAttempt(
  attempt: ForegroundRestartAttempt,
  restorePrepared = true,
): void {
  if (attempt.phase === 'cancelled' || attempt.phase === 'completed') return;
  const shouldRestore = restorePrepared && isForegroundRestartPrepared(attempt.context);
  attempt.activeResumeToken = null;
  attempt.removeResumeStateListener?.();
  attempt.removeResumeStateListener = null;
  if (attempt.suspendLease?.nativeResolvedWithoutPrepared) {
    abandonForegroundSuspendLease(attempt.suspendLease, true);
  }
  attempt.phase = 'cancelled';
  if (!attempt.preparedSettled) {
    attempt.preparedSettled = true;
    attempt.resolvePrepared(false);
  }
  if (attempt.suspendLease?.owner === attempt) attempt.suspendLease.owner = null;
  attempt.suspendLease = null;
  if (pendingForegroundRestartAttempt === attempt) pendingForegroundRestartAttempt = null;
  if (attempt.generation === foregroundRestartGeneration) foregroundRestartGeneration += 1;
  if (shouldRestore) requestRetiredAudioContextSuspendCleanup(attempt.context);
}

function settleForegroundSuspendLease(lease: ForegroundSuspendLease, forceFailure = false): void {
  if (lease.settled || lease.abandoned) return;
  const prepared = isForegroundRestartPrepared(lease.context);
  // A resolved suspend Promise while state is still running is inconclusive.
  // Retain the exact listener because a delayed WebKit statechange may still
  // land; only a rejection/close forces an unprepared terminal result.
  if (!prepared && !forceFailure && String(lease.context.state) !== 'closed') return;

  lease.settled = true;
  lease.autoRotateToken = null;
  lease.removeStateListener();
  if (foregroundSuspendLeases.get(lease.context) === lease) {
    foregroundSuspendLeases.delete(lease.context);
  }
  const owner = lease.owner;
  lease.owner = null;
  if (
    prepared &&
    owner &&
    foregroundRestartStillCurrent(owner) &&
    owner.suspendLease === lease &&
    owner.phase === 'preparing-suspend'
  ) {
    owner.suspendLease = null;
    owner.phase = 'awaiting-gesture';
    if (!owner.preparedSettled) {
      owner.preparedSettled = true;
      owner.resolvePrepared(true);
    }
  } else {
    if (owner?.suspendLease === lease) owner.suspendLease = null;
    if (owner && foregroundRestartStillCurrent(owner)) retireForegroundRestartAttempt(owner);
    if (prepared) requestRetiredAudioContextSuspendCleanup(lease.context);
  }
}

function watchForegroundSuspendLease(lease: ForegroundSuspendLease): void {
  if (lease.settled || lease.abandoned || lease.autoRotateToken) return;
  const rotateToken = {};
  lease.autoRotateToken = rotateToken;
  void delay(FOREGROUND_SUSPEND_WATCHDOG_MS).then(() => {
    if (lease.settled || lease.abandoned || lease.autoRotateToken !== rotateToken) {
      return;
    }
    if (isForegroundRestartPrepared(lease.context)) {
      settleForegroundSuspendLease(lease);
      return;
    }
    if (String(lease.context.state) === 'closed') {
      settleForegroundSuspendLease(lease, true);
      return;
    }

    const owner = lease.owner;
    if (!owner || !foregroundRestartStillCurrent(owner) || owner.phase !== 'preparing-suspend') {
      abandonForegroundSuspendLease(lease, true);
      return;
    }
    if (owner.suspendPrepareAttempts >= MAX_FOREGROUND_SUSPEND_ATTEMPTS) {
      abandonForegroundSuspendLease(lease, true);
      retireForegroundRestartAttempt(owner, false);
      return;
    }

    // Preserve the same attempt/whenPrepared identity. The late fence either
    // hands an old physical suspend to this owner or starts one fresh native
    // suspend after the old operation's bounded quarantine closes.
    abandonForegroundSuspendLease(lease, true);
    startFreshForegroundSuspend(owner);
  });
}

function createForegroundSuspendLease(
  context: AudioContext,
  owner: ForegroundRestartAttempt,
): ForegroundSuspendLease {
  const handleStateChange = (): void => {
    if (lease.abandoned) return;
    if (isForegroundRestartPrepared(context)) settleForegroundSuspendLease(lease);
    else if (String(context.state) === 'closed') settleForegroundSuspendLease(lease, true);
  };
  const lease: ForegroundSuspendLease = {
    context,
    owner,
    settled: false,
    abandoned: false,
    nativeResolvedWithoutPrepared: false,
    autoRotateToken: null,
    removeStateListener: () => context.removeEventListener('statechange', handleStateChange),
  };
  owner.suspendLease = lease;
  owner.suspendPrepareAttempts += 1;
  foregroundSuspendLeases.set(context, lease);
  context.addEventListener('statechange', handleStateChange);
  watchForegroundSuspendLease(lease);

  let nativeSuspend: Promise<void>;
  try {
    nativeSuspend = context.suspend();
  } catch {
    settleForegroundSuspendLease(lease, true);
    return lease;
  }
  void nativeSuspend.then(
    () => {
      if (isForegroundRestartPrepared(context)) settleForegroundSuspendLease(lease);
      else if (!lease.settled && !lease.abandoned) {
        lease.nativeResolvedWithoutPrepared = true;
      }
      // Otherwise retain the state listener: a delayed WebKit statechange may
      // still land after this Promise and must remain token fenced.
    },
    () => settleForegroundSuspendLease(lease, true),
  );
  return lease;
}

function createForegroundRestartAttempt(
  incident: ForegroundClockHealthIncident,
): ForegroundRestartAttempt {
  let resolvePrepared!: (prepared: boolean) => void;
  const whenPrepared = new Promise<boolean>((resolve) => {
    resolvePrepared = resolve;
  });
  const attempt: ForegroundRestartAttempt = {
    context: incident.context,
    checkToken: incident.token,
    attemptToken: {},
    generation: ++foregroundRestartGeneration,
    phase: 'preparing-suspend',
    suspendLease: null,
    gestureResume: null,
    activeResumeToken: null,
    removeResumeStateListener: null,
    resolvePrepared,
    whenPrepared,
    preparedSettled: false,
    suspendPrepareAttempts: 0,
  };
  pendingForegroundRestartAttempt = attempt;
  return attempt;
}

/**
 * True while the exact foreground restart attempt owns this context. Other
 * health/recovery paths must defer instead of issuing a second native resume.
 */
export function isForegroundAudioContextRestartOwned(context: AudioContext): boolean {
  const attempt = pendingForegroundRestartAttempt;
  return Boolean(attempt && attempt.context === context && foregroundRestartStillCurrent(attempt));
}

/** Let the shared statechange binder defer to an exact generic restart owner. */
export function isForegroundAudioContextRestartSuspendOwned(context: AudioContext): boolean {
  const lease = foregroundSuspendLeases.get(context);
  return Boolean(
    isForegroundAudioContextRestartOwned(context) ||
    (lease && !lease.settled && !lease.abandoned) ||
    foregroundLateSuspendFences.has(context),
  );
}

/**
 * Mark one foreground transition for a clock check by the next local-file
 * PLAY. This is deliberately one-shot and independent of room/playback state:
 * ordinary PLAY calls see no requirement unless a real hidden -> visible
 * incident armed one.
 */
export function armForegroundAudioContextClockHealthCheck(
  context: AudioContext | null = _ctx,
  options: { captureHiddenContinuity?: boolean } = {},
): object | null {
  if (!context || String(context.state) === 'closed') return null;
  if (pendingForegroundRestartAttempt) {
    retireForegroundRestartAttempt(pendingForegroundRestartAttempt, false);
  }
  const incident: ForegroundClockHealthIncident = {
    context,
    token: {},
    generation: ++foregroundClockHealthGeneration,
    hiddenAtWallMs: options.captureHiddenContinuity === true ? Date.now() : null,
    hiddenAtContextSeconds:
      options.captureHiddenContinuity === true && Number.isFinite(context.currentTime)
        ? context.currentTime
        : null,
  };
  pendingForegroundClockHealthIncident = incident;
  return incident.token;
}

/** Peek without consuming so an async probe can carry an exact successor fence. */
export function getPendingForegroundAudioContextClockHealthCheck(): ForegroundAudioContextClockHealthCheck | null {
  const incident = pendingForegroundClockHealthIncident;
  if (!incident) return null;
  return {
    context: incident.context,
    token: incident.token,
    isCurrent: () =>
      pendingForegroundClockHealthIncident === incident &&
      foregroundClockHealthGeneration === incident.generation &&
      String(incident.context.state) !== 'closed',
    getHiddenContinuityGapSeconds: () => {
      if (
        pendingForegroundClockHealthIncident !== incident ||
        foregroundClockHealthGeneration !== incident.generation ||
        incident.hiddenAtWallMs === null ||
        incident.hiddenAtContextSeconds === null
      ) {
        return null;
      }
      const wallElapsedSeconds = Math.max(0, Date.now() - incident.hiddenAtWallMs) / 1_000;
      const contextElapsedSeconds = Math.max(
        0,
        incident.context.currentTime - incident.hiddenAtContextSeconds,
      );
      return Math.max(0, wallElapsedSeconds - contextElapsedSeconds);
    },
  };
}

/** Consume only the exact incident sampled by the caller. */
export function consumeForegroundAudioContextClockHealthCheck(token: object): boolean {
  const incident = pendingForegroundClockHealthIncident;
  if (!incident || incident.token !== token) return false;
  if (pendingForegroundRestartAttempt?.checkToken === token) {
    retireForegroundRestartAttempt(pendingForegroundRestartAttempt);
  }
  pendingForegroundClockHealthIncident = null;
  return true;
}

/**
 * Prepare an identity-less restart for a frozen clock discovered by the first
 * local-file PLAY after foreground. The initial call is bounded at 500 ms;
 * `whenPrepared` remains exact so a late native suspend can safely trigger the
 * recovery UI without granting an early gesture resume.
 */
export async function prepareForegroundAudioContextRestart(
  checkToken: object,
): Promise<ForegroundAudioContextRestartPreparation | null> {
  const incident = pendingForegroundClockHealthIncident;
  if (!incident || incident.token !== checkToken || String(incident.context.state) === 'closed') {
    return null;
  }

  let attempt = pendingForegroundRestartAttempt;
  if (attempt && attempt.checkToken !== checkToken) {
    retireForegroundRestartAttempt(attempt, false);
    attempt = null;
  }
  if (!attempt) attempt = createForegroundRestartAttempt(incident);
  if (!foregroundRestartStillCurrent(attempt)) return null;
  if (attempt.phase === 'gesture-resuming' || attempt.phase === 'awaiting-clock-verification') {
    return null;
  }

  if (isForegroundRestartPrepared(attempt.context)) {
    attempt.phase = 'awaiting-gesture';
    attempt.suspendLease = null;
    if (!attempt.preparedSettled) {
      attempt.preparedSettled = true;
      attempt.resolvePrepared(true);
    }
  } else if (attempt.phase !== 'preparing-suspend') {
    return null;
  }

  if (attempt.phase === 'preparing-suspend') {
    let lease = foregroundSuspendLeases.get(attempt.context) ?? null;
    if (lease?.nativeResolvedWithoutPrepared) {
      if (attempt.suspendPrepareAttempts >= MAX_FOREGROUND_SUSPEND_ATTEMPTS) {
        abandonForegroundSuspendLease(lease, true);
        retireForegroundRestartAttempt(attempt, false);
        return null;
      }
      abandonForegroundSuspendLease(lease, true);
      lease = null;
    }
    if (!lease || lease.settled) {
      startFreshForegroundSuspend(attempt);
    } else {
      if (lease.owner && lease.owner !== attempt) {
        retireForegroundRestartAttempt(lease.owner, false);
      }
      lease.owner = attempt;
      attempt.suspendLease = lease;
    }
  }

  const whenPrepared = attempt.whenPrepared;
  const initial = await Promise.race([
    whenPrepared.then((prepared): 'prepared' | 'stale' => (prepared ? 'prepared' : 'stale')),
    delay(FOREGROUND_SUSPEND_PREPARE_DEADLINE_MS).then(() => 'preparing' as const),
  ]);
  if (initial === 'stale' || !foregroundRestartStillCurrent(attempt)) return null;
  return {
    status: initial,
    attemptToken: attempt.attemptToken,
    whenPrepared,
    isCurrent: () =>
      foregroundRestartStillCurrent(attempt!) && attempt!.phase !== 'preparing-suspend',
  };
}

/**
 * Start an exact generic restart after a trusted, tokenless PLAY proves the
 * running native clock is frozen. Callers may show recovery UI immediately
 * only for `prepared`; `preparing` must await the exact `whenPrepared` fence.
 */
export async function prepareForegroundAudioContextRestartAfterClockStall(
  context: AudioContext,
): Promise<ForegroundAudioContextRestartPreparation | null> {
  const checkToken = armForegroundAudioContextClockHealthCheck(context);
  if (!checkToken) return null;
  const preparation = await prepareForegroundAudioContextRestart(checkToken);
  if (!preparation) consumeForegroundAudioContextClockHealthCheck(checkToken);
  return preparation;
}

function promoteForegroundRestartAfterNativeResume(
  attempt: ForegroundRestartAttempt,
  resumeToken: object,
): void {
  if (String(attempt.context.state) !== 'running') return;
  if (foregroundRestartStillCurrent(attempt) && attempt.activeResumeToken === resumeToken) {
    // A retry may have superseded the Promise token, but the exact recovery
    // attempt still owns the context. Running is only provisional here; the
    // caller must pass the clock probe before commit.
    attempt.phase = 'awaiting-clock-verification';
    attempt.activeResumeToken = null;
    attempt.removeResumeStateListener?.();
    attempt.removeResumeStateListener = null;
    return;
  }

  // A retired native resume can physically undo a successor's prepared
  // suspension. It may not promote that successor; put the successor back
  // through a fresh suspend lease instead.
  const successor = pendingForegroundRestartAttempt;
  if (
    successor &&
    successor !== attempt &&
    successor.context === attempt.context &&
    foregroundRestartStillCurrent(successor) &&
    successor.phase === 'awaiting-gesture'
  ) {
    successor.phase = 'preparing-suspend';
    startFreshForegroundSuspend(successor);
  }
}

/** Resume only an exact restart whose native suspend concretely completed. */
export function resumePreparedForegroundAudioContextRestartFromGesture(
  attemptToken: object,
): Promise<ForegroundAudioContextRestartResumeResult> {
  const attempt = pendingForegroundRestartAttempt;
  if (
    !attempt ||
    attempt.attemptToken !== attemptToken ||
    !foregroundRestartStillCurrent(attempt) ||
    attempt.phase !== 'awaiting-gesture' ||
    !isForegroundRestartPrepared(attempt.context)
  ) {
    return Promise.resolve({ running: false, requiresClockVerification: false });
  }
  if (attempt.gestureResume) return attempt.gestureResume;

  attempt.phase = 'gesture-resuming';
  const resumeToken = {};
  attempt.activeResumeToken = resumeToken;
  attempt.removeResumeStateListener?.();
  const handleResumeStateChange = (): void => {
    if (String(attempt.context.state) === 'running') {
      promoteForegroundRestartAfterNativeResume(attempt, resumeToken);
    }
  };
  attempt.context.addEventListener('statechange', handleResumeStateChange);
  attempt.removeResumeStateListener = () =>
    attempt.context.removeEventListener('statechange', handleResumeStateChange);
  let nativeResume: Promise<void>;
  try {
    nativeResume = attempt.context.resume();
  } catch (error) {
    nativeResume = Promise.reject(error);
  }
  void nativeResume.then(
    () => promoteForegroundRestartAfterNativeResume(attempt, resumeToken),
    () => undefined,
  );
  const operation = Promise.race([nativeResume, delay(FOREGROUND_GESTURE_RESUME_DEADLINE_MS)])
    .then(() => {
      if (!foregroundRestartStillCurrent(attempt)) {
        return { running: false, requiresClockVerification: false };
      }
      if (String(attempt.context.state) === 'running') {
        promoteForegroundRestartAfterNativeResume(attempt, resumeToken);
        return { running: true, requiresClockVerification: true };
      }
      attempt.phase = isForegroundRestartPrepared(attempt.context)
        ? 'awaiting-gesture'
        : 'preparing-suspend';
      return { running: false, requiresClockVerification: false };
    })
    .catch(() => {
      if (foregroundRestartStillCurrent(attempt)) {
        attempt.phase = isForegroundRestartPrepared(attempt.context)
          ? 'awaiting-gesture'
          : 'preparing-suspend';
      }
      if (attempt.activeResumeToken === resumeToken) {
        attempt.activeResumeToken = null;
        attempt.removeResumeStateListener?.();
        attempt.removeResumeStateListener = null;
      }
      return { running: false, requiresClockVerification: false };
    })
    .finally(() => {
      if (attempt.gestureResume === operation) attempt.gestureResume = null;
    });
  attempt.gestureResume = operation;
  return operation;
}

export function getPendingForegroundAudioContextRestartClockHealthRequirement(): ForegroundAudioContextRestartClockHealthRequirement | null {
  const attempt = pendingForegroundRestartAttempt;
  if (
    !attempt ||
    attempt.phase !== 'awaiting-clock-verification' ||
    String(attempt.context.state) !== 'running'
  ) {
    return null;
  }
  return {
    context: attempt.context,
    attemptToken: attempt.attemptToken,
    isCurrent: () =>
      foregroundRestartStillCurrent(attempt) &&
      attempt.phase === 'awaiting-clock-verification' &&
      String(attempt.context.state) === 'running',
  };
}

/** Commit only after the exact post-gesture clock probe reports healthy. */
export function confirmForegroundAudioContextRestartHealth(attemptToken: object): boolean {
  const attempt = pendingForegroundRestartAttempt;
  if (
    !attempt ||
    attempt.attemptToken !== attemptToken ||
    !foregroundRestartStillCurrent(attempt) ||
    attempt.phase !== 'awaiting-clock-verification' ||
    String(attempt.context.state) !== 'running'
  ) {
    return false;
  }
  attempt.phase = 'completed';
  pendingForegroundRestartAttempt = null;
  if (pendingForegroundClockHealthIncident?.token === attempt.checkToken) {
    pendingForegroundClockHealthIncident = null;
  }
  return true;
}

/** Retire only the exact generic restart and its originating foreground check. */
export function retireForegroundAudioContextRestart(attemptToken: object): boolean {
  const attempt = pendingForegroundRestartAttempt;
  if (!attempt || attempt.attemptToken !== attemptToken) return false;
  const checkToken = attempt.checkToken;
  retireForegroundRestartAttempt(attempt);
  if (pendingForegroundClockHealthIncident?.token === checkToken) {
    pendingForegroundClockHealthIncident = null;
  }
  return true;
}

/**
 * Return the current audio clock time, or zero before initialization.
 */
export function getCurrentTime(): number {
  return _ctx ? _ctx.currentTime : 0;
}

/**
 * Ensure the shared AudioContext is running.
 * Must be called from a user gesture on iOS/Safari.
 */
export async function ensureRunning(): Promise<void> {
  const ctx = getAudioContext();
  if (ctx.state !== 'running') {
    // Add a race to prevent hanging on browsers that don't resolve resume() without a gesture
    await Promise.race([ctx.resume(), delay(AUDIO_RESUME_DEADLINE_MS)]);
  }
  // A timeout is not a successful resume. Mobile WebKit can leave resume()
  // pending indefinitely after a page suspension, so every caller must gate
  // source creation on the native state rather than Promise.race settlement.
  if (String(ctx.state) !== 'running') throw new AudioContextNotRunningError(String(ctx.state));
}

async function sampleRunningClock(
  ctx: AudioContext,
  isCurrent: () => boolean,
): Promise<AudioContextHealthResult> {
  let totalAdvance = 0;
  for (let sample = 0; sample < 2; sample += 1) {
    if (String(document.visibilityState) === 'hidden') {
      return {
        healthy: false,
        reason: 'hidden',
        state: String(ctx.state),
        clockAdvanceSeconds: null,
      };
    }
    if (!isCurrent()) {
      return {
        healthy: false,
        reason: 'superseded',
        state: String(ctx.state),
        clockAdvanceSeconds: null,
      };
    }

    const startedAt = ctx.currentTime;
    const wallStartedAt = performance.now();
    await delay(AUDIO_CLOCK_SAMPLE_MS);
    if (!isCurrent()) {
      return {
        healthy: false,
        reason: 'superseded',
        state: String(ctx.state),
        clockAdvanceSeconds: null,
      };
    }
    if (String(document.visibilityState) === 'hidden') {
      return {
        healthy: false,
        reason: 'hidden',
        state: String(ctx.state),
        clockAdvanceSeconds: null,
      };
    }
    if (String(ctx.state) !== 'running') {
      return {
        healthy: false,
        reason: 'not-running',
        state: String(ctx.state),
        clockAdvanceSeconds: null,
      };
    }

    const wallElapsed = performance.now() - wallStartedAt;
    const advance = Math.max(0, ctx.currentTime - startedAt);
    totalAdvance += advance;
    // A throttled/early test timer is inconclusive rather than proof that the
    // native audio clock is dead.
    if (wallElapsed < AUDIO_CLOCK_SAMPLE_MS * 0.75) {
      return {
        healthy: false,
        reason: 'inconclusive',
        state: String(ctx.state),
        clockAdvanceSeconds: totalAdvance,
      };
    }
    if (advance >= AUDIO_CLOCK_MIN_ADVANCE_SECONDS) {
      return {
        healthy: true,
        reason: 'healthy',
        state: String(ctx.state),
        clockAdvanceSeconds: totalAdvance,
      };
    }
  }

  return {
    healthy: false,
    reason: 'clock-stalled',
    state: String(ctx.state),
    clockAdvanceSeconds: totalAdvance,
  };
}

/**
 * Verify that WebKit's native audio clock actually advances after foreground.
 * `state === "running"` alone is insufficient on affected iOS releases.
 */
export async function probeAudioContextHealth(
  options: {
    attemptResume?: boolean;
    isCurrent?: () => boolean;
    context?: AudioContext;
  } = {},
): Promise<AudioContextHealthResult> {
  const ctx = options.context ?? _ctx;
  if (!ctx) {
    return {
      healthy: true,
      reason: 'not-created',
      state: 'not-created',
      clockAdvanceSeconds: null,
    };
  }
  const isCurrent = options.isCurrent ?? (() => true);
  if (!isCurrent()) {
    return {
      healthy: false,
      reason: 'superseded',
      state: String(ctx.state),
      clockAdvanceSeconds: null,
    };
  }

  if (String(ctx.state) !== 'running' && options.attemptResume !== false) {
    try {
      await Promise.race([ctx.resume(), delay(AUDIO_RESUME_DEADLINE_MS)]);
    } catch {
      // The concrete state below is authoritative.
    }
  }
  if (String(ctx.state) !== 'running') {
    return {
      healthy: false,
      reason: 'not-running',
      state: String(ctx.state),
      clockAdvanceSeconds: null,
    };
  }
  return sampleRunningClock(ctx, isCurrent);
}

/**
 * Resume the shared context synchronously inside a trusted user gesture.
 * A running-but-frozen context is suspended before the dialog is shown, so
 * this function never spends the transient activation awaiting suspend().
 */
export function restartAudioContextFromGesture(context?: AudioContext): Promise<void> {
  const ctx = context ?? getAudioContext();
  try {
    return ctx.resume();
  } catch (error) {
    return Promise.reject(error);
  }
}
