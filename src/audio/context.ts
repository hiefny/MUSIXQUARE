/**
 * MUSIXQUARE — AudioContext Singleton
 *
 * Owns the lazily created native AudioContext shared by all audio modules.
 */

import { log } from '../core/log.ts';
import { delay } from '../core/timers.ts';
import {
  AUDIO_CLOCK_MIN_ADVANCE_SECONDS,
  AUDIO_CLOCK_SAMPLE_MS,
  AUDIO_LATE_SUSPEND_FENCE_MS,
  AUDIO_RECOVERY_RESUME_DEADLINE_MS,
  AUDIO_RESUME_DEADLINE_MS,
  AUDIO_RETIRED_SUSPEND_CLEANUP_DEADLINE_MS,
  AUDIO_SUSPEND_MAX_ATTEMPTS,
  AUDIO_SUSPEND_PREPARE_DEADLINE_MS,
  AUDIO_SUSPEND_WATCHDOG_MS,
  isAudioContextPrepared,
} from './context-protocol.ts';
import {
  DEADLINE_ENSURE_RUNNING,
  DEADLINE_LATE_SUSPEND_FENCE,
  DEADLINE_PLAY_REQUEST_PREPARE,
  DEADLINE_PLAY_REQUEST_RESUME,
  DEADLINE_PLAY_REQUEST_WATCHDOG,
  DEADLINE_PROBE,
  DEADLINE_RETIRE_CLEANUP,
  DEADLINES_WATCHED,
  RESUME_ENSURE_RUNNING,
  RESUME_PLAY_REQUEST,
  RESUME_PROBE,
  RESUME_RETIRE,
  TAPS_REFUSED,
  countAudioRecovery,
  countAudioRecoveryPhase,
  countAudioSuspend,
  raceAudioRecoveryDeadline,
  registerAudioRecoveryOwner,
} from './output-recovery-counters.ts';

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
  /** Its side of the context's one suspend ledger (Phase 7 7B-4). */
  readonly suspend: AudioContextSuspendRequest;
  gestureResume: Promise<ForegroundAudioContextRestartResumeResult> | null;
  /** Its gesture's recovery resume, while that may still promote it (Phase 7 7B-5). */
  resume: AudioContextResumeFlight<ForegroundAudioContextRestartResumeResult> | null;
  resolvePrepared: (prepared: boolean) => void;
  readonly whenPrepared: Promise<boolean>;
  preparedSettled: boolean;
  reprepare: ForegroundRestartReprepare | null;
  /**
   * A recovery dialog has taken it (claimForegroundAudioContextRestartForDialog).
   * Only then does the owner park it again after an outside resume and hold
   * the context for its tap: a notice that never became a dialog leaves an
   * attempt no tap can serve.
   */
  dialog: boolean;
  /** Why it ended, read when its phase becomes 'cancelled'. */
  end: ForegroundRestartEnd;
  requirementWait: ForegroundRestartRequirementWait | null;
}

/** A parked attempt being parked again after an outside resume (Phase 7 7B-2). */
interface ForegroundRestartReprepare {
  readonly parked: Promise<boolean>;
  readonly settle: (parked: boolean) => void;
}

/**
 * How a play-request attempt ends before its clock check: retired by its
 * owner (its foreground incident consumed elsewhere, its suspend lost),
 * cancelled by a caller that retires its token, or superseded by a newer
 * foreground incident or restart attempt.
 */
type ForegroundRestartEnd = 'retired' | 'cancelled' | 'superseded';

type ForegroundRestartRequirementOutcome = 'promoted' | ForegroundRestartEnd;

/** The recovery dialog's wait for the attempt's clock requirement (Phase 7 7B-5). */
interface ForegroundRestartRequirementWait {
  readonly settled: Promise<ForegroundRestartRequirementOutcome>;
  readonly settle: (outcome: ForegroundRestartRequirementOutcome) => void;
}

/**
 * One recovery attempt's side of a context's suspend ledger (RO-01, Phase 7
 * 7B-4): the play-request restart in this file and the playback scope's
 * attempt in context-recovery.ts. The ledger keeps one lease and one
 * late-suspend fence per context, so one native suspend at a time; it counts
 * the attempt's suspends and asks the attempt's owner, through these
 * callbacks, about everything that concerns the attempt itself.
 */
export interface AudioContextSuspendRequest {
  /** Native suspends the ledger started for this attempt (AUDIO_SUSPEND_MAX_ATTEMPTS at most). */
  suspendPrepareAttempts: number;
  /** The lease it waits on now; only the ledger sets it. */
  suspendLease: AudioContextSuspendLease | null;
  /** The deadline slot (output-recovery-counters.ts) its lease watchdog counts. */
  readonly watchdogSlot: number;
  /** Current and still waiting for its suspend, so a landed suspend parks the context for it. */
  readonly preparing: () => boolean;
  /** A suspend that lands inside the late fence parks the context for it. */
  readonly takesLateSuspend: () => boolean;
  /** The context is parked for it. */
  readonly parked: () => void;
  /** Its lease ended for nobody, or a later request took its place: the attempt retires. */
  readonly lost: () => void;
  /** It no longer waited when its lease watchdog or the late fence ran out. */
  readonly stale: () => void;
  /** Its two suspends were lost. */
  readonly exhausted: () => void;
  /** Its suspend was lost; the next one waits for the late fence to close. */
  readonly retrying: () => void;
}

interface AudioContextSuspendLease {
  readonly context: AudioContext;
  owner: AudioContextSuspendRequest | null;
  settled: boolean;
  abandoned: boolean;
  nativeResolvedWithoutPrepared: boolean;
  watchdogToken: object | null;
  /** Its first owner's slot, counted when no owner is left at its watchdog. */
  readonly watchdogSlot: number;
}

/** The 250 ms after a lease was given up, in which its suspend may still land. */
interface AudioContextLateSuspendFence {
  /** The attempt whose next suspend waits for the fence to close. */
  successor: AudioContextSuspendRequest | null;
}

/** The playback scope's binding (context-recovery.ts) in a context's dispatcher. */
interface AudioContextStateBinding {
  /**
   * First in every dispatch. `ledgerKeepsState` is true for a parked state
   * that a live lease, the late fence or a play-request restart owns, which
   * the dispatch hands to them next.
   */
  readonly judge: (ledgerKeepsState: boolean) => void;
  /** After the retired-suspend cleanup: adopt a context it left parked, or re-park a woken one. */
  readonly adoptRetiredSuspend: () => void;
  /**
   * A suspend landed inside the late fence with no attempt to take it. True
   * when the binding handled it: as an interruption, as outside the fence,
   * for playback that has no recovery dialog; otherwise by undoing it.
   */
  readonly takeLateSuspend: () => boolean;
}

/**
 * One recovery attempt's side of a native resume (RO-01, Phase 7 7B-5): the
 * play-request restart's gesture resume in this file and the playback
 * scope's gesture and automatic resumes in context-recovery.ts go through
 * one implementation, requestAudioContextResume. These callbacks are each
 * owner's own step rules.
 */
interface AudioContextResumeRequest<Result> {
  /** Its count slot and its deadline's (output-recovery-counters.ts), by owner and source. */
  readonly resumeSlot: number;
  readonly deadlineSlot: number;
  /** The owner still holds the attempt. */
  readonly holds: () => boolean;
  /**
   * The context runs for this resume: the attempt goes on to its clock check.
   * `callerWaits` is false once the deadline has answered the caller, so no
   * caller checks this late running state (fix lane G7).
   */
  readonly promoted: (callerWaits: boolean) => void;
  /** The deadline passed, or the resume was refused, without the context running. */
  readonly missed: () => void;
  /** The resume brought the context to running for an attempt it no longer promotes. */
  readonly landed: () => void;
  /**
   * What the caller gets: at the deadline the context runs ('running') or
   * not ('not-running'), the native resume was refused ('refused'), or the
   * owner no longer held the attempt ('lost').
   */
  readonly result: (outcome: 'running' | 'not-running' | 'refused' | 'lost') => Result;
}

/** A recovery resume in flight, as its owner keeps it. */
export interface AudioContextResumeFlight<Result> {
  /** Settles at the deadline, or when the native resume is refused. */
  readonly settled: Promise<Result>;
  /** Until the running state promotes it, it is refused, or its owner drops it. */
  readonly active: () => boolean;
  /** The owner retired or replaced its attempt: the resume promotes nothing any more. */
  readonly drop: () => void;
}

/** A recovery resume the dispatcher's last part promotes on `running`. */
interface AudioContextResumeEntry {
  readonly context: AudioContext;
  readonly request: AudioContextResumeRequest<unknown>;
  active: boolean;
  callerWaits: boolean;
}

/** A context's one statechange listener and the parts it calls in its fixed order. */
interface AudioContextStateDispatcher {
  binding: AudioContextStateBinding | null;
  /** Recovery resumes in flight, both owners' (Phase 7 7B-5). */
  readonly resumes: Set<AudioContextResumeEntry>;
  listening: boolean;
  readonly listener: () => void;
}

let pendingForegroundClockHealthIncident: ForegroundClockHealthIncident | null = null;
let pendingForegroundRestartAttempt: ForegroundRestartAttempt | null = null;
let foregroundRestartGeneration = 0;
/** The suspend ledger: one lease and one late fence per context (RO-01, Phase 7 7B-4). */
const suspendLeases = new WeakMap<AudioContext, AudioContextSuspendLease>();
const lateSuspendFences = new WeakMap<AudioContext, AudioContextLateSuspendFence>();
const stateDispatchers = new WeakMap<AudioContext, AudioContextStateDispatcher>();
const retiredSuspendCleanupFlights = new WeakMap<AudioContext, Promise<void>>();

/**
 * Every phase write of a play-request restart goes through here: the /debug
 * counts; a re-park's promise, which settles once the attempt leaves
 * preparing-suspend (true when it is parked for its gesture again); and the
 * dialog's wait for the clock requirement, which settles when the attempt
 * is promoted or ends (Phase 7 7B-5).
 */
function setRestartPhase(attempt: ForegroundRestartAttempt, phase: ForegroundRestartPhase): void {
  const from = attempt.phase;
  if (from === phase) return;
  attempt.phase = phase;
  countAudioRecoveryPhase(attempt, from, phase);
  const reprepare = attempt.reprepare;
  if (reprepare && phase !== 'preparing-suspend') {
    attempt.reprepare = null;
    reprepare.settle(phase === 'awaiting-gesture');
  }
  const wait = attempt.requirementWait;
  if (wait && (phase === 'awaiting-clock-verification' || phase === 'cancelled')) {
    attempt.requirementWait = null;
    wait.settle(phase === 'cancelled' ? attempt.end : 'promoted');
  }
}

// The ledger's live lease on a context (one at most since Phase 7 7B-4).
registerAudioRecoveryOwner(isForegroundAudioContextRestartHolding, (context) =>
  liveSuspendLease(context) ? 1 : 0,
);

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
  stateDispatchers.get(context)?.binding?.adoptRetiredSuspend();
}

/**
 * Seat the playback scope's binding first in this context's one statechange
 * dispatcher (RO-01, Phase 7 7B-4): it judges every change before the
 * suspend lease, the late fence and the play-request resume promotion, and
 * it may adopt an orphaned physical suspension after best-effort cleanup
 * fails. The disposer removes exactly this seat, so disposing an older
 * engine can never touch its successor's.
 */
export function bindAudioContextStateDispatch(
  context: AudioContext,
  binding: AudioContextStateBinding,
): () => void {
  const dispatcher = stateDispatcherFor(context);
  const seat: AudioContextStateBinding = { ...binding };
  dispatcher.binding = seat;
  syncStateDispatcher(context);
  return () => {
    if (dispatcher.binding !== seat) return;
    dispatcher.binding = null;
    syncStateDispatcher(context);
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
    !isAudioContextPrepared(context) ||
    isForegroundAudioContextRestartOwned(context) ||
    retiredSuspendCleanupFlights.has(context)
  ) {
    return;
  }

  let nativeResume: Promise<void>;
  countAudioRecovery(RESUME_RETIRE);
  try {
    nativeResume = context.resume();
  } catch (error) {
    nativeResume = Promise.reject(error);
  }
  const cleanupSettled = nativeResume.then(
    () => undefined,
    () => undefined,
  );
  const operation = raceAudioRecoveryDeadline(
    DEADLINE_RETIRE_CLEANUP,
    cleanupSettled,
    delay(AUDIO_RETIRED_SUSPEND_CLEANUP_DEADLINE_MS),
  )
    .then(() => {
      if (document.visibilityState === 'visible' && isAudioContextPrepared(context)) {
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

// ── The suspend ledger and the statechange dispatcher (RO-01, Phase 7 7B-4) ──
// Both recovery owners park the context through one lease and one
// late-suspend fence per context, and every statechange reaches them
// through one listener per context, in the fixed order binding, lease,
// fence, resume promotion. The lease watchdog and the fence time the
// suspend itself (AUDIO_SUSPEND_WATCHDOG_MS, AUDIO_LATE_SUSPEND_FENCE_MS), so
// either owner's second suspend comes after the fence; what an attempt does
// when its suspend is lost stays its owner's choice.

function liveSuspendLease(context: AudioContext): AudioContextSuspendLease | null {
  const lease = suspendLeases.get(context);
  return lease && !lease.settled && !lease.abandoned ? lease : null;
}

function stateDispatcherFor(context: AudioContext): AudioContextStateDispatcher {
  const existing = stateDispatchers.get(context);
  if (existing) return existing;
  const dispatcher: AudioContextStateDispatcher = {
    binding: null,
    resumes: new Set(),
    listening: false,
    listener: () => dispatchAudioContextState(context, dispatcher),
  };
  stateDispatchers.set(context, dispatcher);
  return dispatcher;
}

/** One listener per context, there exactly while it has a part to call. */
function syncStateDispatcher(context: AudioContext): void {
  const dispatcher = stateDispatchers.get(context);
  const needed = Boolean(
    dispatcher?.binding ||
    dispatcher?.resumes.size ||
    liveSuspendLease(context) ||
    lateSuspendFences.has(context),
  );
  if (needed) {
    const active = dispatcher ?? stateDispatcherFor(context);
    if (active.listening) return;
    active.listening = true;
    context.addEventListener('statechange', active.listener);
  } else if (dispatcher?.listening) {
    dispatcher.listening = false;
    context.removeEventListener('statechange', dispatcher.listener);
  }
}

/**
 * Every statechange of a context, in one fixed order (a behaviour change of
 * Phase 7 7B-4: the order no longer follows which listener was added first):
 * the binding's judgement, the suspend lease, the late-suspend fence, the
 * recovery resumes' promotion (either owner's since Phase 7 7B-5). Each part
 * is the one present when the change arrived, as a listener added during a
 * dispatch hears only the next change.
 */
function dispatchAudioContextState(
  context: AudioContext,
  dispatcher: AudioContextStateDispatcher,
): void {
  const binding = dispatcher.binding;
  const lease = liveSuspendLease(context);
  const fence = lateSuspendFences.get(context) ?? null;
  const resumes = [...dispatcher.resumes];
  binding?.judge(
    isAudioContextPrepared(context) &&
      (lease !== null || fence !== null || isForegroundAudioContextRestartOwned(context)),
  );
  if (lease) {
    if (isAudioContextPrepared(context)) settleSuspendLease(lease);
    else if (String(context.state) === 'closed') settleSuspendLease(lease, true);
  }
  if (fence && lateSuspendFences.get(context) === fence) handleLateSuspend(context, fence);
  for (const entry of resumes) {
    if (entry.active && String(context.state) === 'running' && entry.request.holds()) {
      promoteRecoveryResume(entry);
    }
  }
}

/**
 * Park the context for this attempt's gesture (RO-01, Phase 7 7B-4). Both
 * recovery owners ask here, so a context has one lease and one native
 * suspend in flight. Inside a late fence the attempt waits for the fence to
 * close; with a lease in flight it takes that lease over. Either way an
 * earlier attempt in that place retires: the later request stays (owner
 * answer Q6). Otherwise a fresh lease starts one native suspend.
 */
export function requestAudioContextSuspend(
  context: AudioContext,
  request: AudioContextSuspendRequest,
): void {
  const fence = lateSuspendFences.get(context);
  if (fence) {
    const previous = fence.successor;
    fence.successor = request;
    if (previous && previous !== request) previous.lost();
    return;
  }
  const lease = liveSuspendLease(context);
  if (lease) {
    const previous = lease.owner;
    lease.owner = request;
    request.suspendLease = lease;
    if (previous && previous !== request) {
      if (previous.suspendLease === lease) previous.suspendLease = null;
      previous.lost();
    }
    return;
  }
  createSuspendLease(context, request);
}

function createSuspendLease(context: AudioContext, owner: AudioContextSuspendRequest): void {
  const lease: AudioContextSuspendLease = {
    context,
    owner,
    settled: false,
    abandoned: false,
    nativeResolvedWithoutPrepared: false,
    watchdogToken: null,
    watchdogSlot: owner.watchdogSlot,
  };
  owner.suspendLease = lease;
  owner.suspendPrepareAttempts += 1;
  suspendLeases.set(context, lease);
  syncStateDispatcher(context);
  watchSuspendLease(lease);

  let nativeSuspend: Promise<void>;
  countAudioSuspend(context, owner.suspendPrepareAttempts);
  try {
    nativeSuspend = context.suspend();
  } catch (error) {
    log.debug('[Audio] Failed to park the context for a gesture resume', error);
    settleSuspendLease(lease, true);
    return;
  }
  void nativeSuspend.then(
    () => {
      if (isAudioContextPrepared(context)) settleSuspendLease(lease);
      else if (!lease.settled && !lease.abandoned) {
        lease.nativeResolvedWithoutPrepared = true;
      }
      // Otherwise retain the lease: a delayed WebKit statechange may still
      // land after this Promise and must remain token fenced.
    },
    (error: unknown) => {
      log.debug('[Audio] Failed to park the context for a gesture resume', error);
      settleSuspendLease(lease, true);
    },
  );
}

function settleSuspendLease(lease: AudioContextSuspendLease, forceFailure = false): void {
  if (lease.settled || lease.abandoned) return;
  const prepared = isAudioContextPrepared(lease.context);
  // A resolved suspend Promise while state is still running is inconclusive.
  // Keep the lease because a delayed WebKit statechange may still land; only
  // a rejection or close forces an unprepared terminal result.
  if (!prepared && !forceFailure && String(lease.context.state) !== 'closed') return;

  lease.settled = true;
  lease.watchdogToken = null;
  if (suspendLeases.get(lease.context) === lease) suspendLeases.delete(lease.context);
  syncStateDispatcher(lease.context);
  const owner = lease.owner;
  lease.owner = null;
  if (prepared && owner && owner.suspendLease === lease && owner.preparing()) {
    owner.suspendLease = null;
    owner.parked();
    return;
  }
  if (owner?.suspendLease === lease) owner.suspendLease = null;
  owner?.lost();
  if (prepared) requestRetiredAudioContextSuspendCleanup(lease.context);
}

/** End a lease that did not settle; returns the attempt it served. */
function abandonSuspendLease(
  lease: AudioContextSuspendLease,
  installLateFence: boolean,
): AudioContextSuspendRequest | null {
  if (lease.settled || lease.abandoned) return null;
  lease.abandoned = true;
  lease.settled = true;
  lease.watchdogToken = null;
  if (suspendLeases.get(lease.context) === lease) suspendLeases.delete(lease.context);
  const owner = lease.owner;
  lease.owner = null;
  if (owner?.suspendLease === lease) owner.suspendLease = null;
  if (installLateFence) installLateSuspendFence(lease.context);
  syncStateDispatcher(lease.context);
  return owner;
}

function watchSuspendLease(lease: AudioContextSuspendLease): void {
  if (lease.settled || lease.abandoned || lease.watchdogToken) return;
  const watchdogToken = {};
  lease.watchdogToken = watchdogToken;
  countAudioRecovery(DEADLINES_WATCHED);
  delay(AUDIO_SUSPEND_WATCHDOG_MS)
    .then(() => {
      if (lease.settled || lease.abandoned || lease.watchdogToken !== watchdogToken) return;
      countAudioRecovery(lease.owner?.watchdogSlot ?? lease.watchdogSlot);
      if (isAudioContextPrepared(lease.context)) {
        settleSuspendLease(lease);
        return;
      }
      if (String(lease.context.state) === 'closed') {
        settleSuspendLease(lease, true);
        return;
      }
      // The attempt keeps its identity (and the play-request its
      // whenPrepared). The late fence either hands an old physical suspend
      // to it or, once the old operation's bounded quarantine closes, starts
      // one fresh native suspend for it: never two in flight.
      const owner = abandonSuspendLease(lease, true);
      if (!owner?.preparing()) {
        owner?.stale();
        return;
      }
      if (owner.suspendPrepareAttempts >= AUDIO_SUSPEND_MAX_ATTEMPTS) {
        owner.exhausted();
        return;
      }
      owner.retrying();
      requestAudioContextSuspend(lease.context, owner);
    })
    .catch((error) => log.warn('[Audio] Suspend lease watchdog failed', error));
}

function installLateSuspendFence(context: AudioContext): void {
  const fence: AudioContextLateSuspendFence = {
    successor: lateSuspendFences.get(context)?.successor ?? null,
  };
  lateSuspendFences.set(context, fence);
  syncStateDispatcher(context);
  countAudioRecovery(DEADLINES_WATCHED);
  delay(AUDIO_LATE_SUSPEND_FENCE_MS)
    .then(() => {
      if (lateSuspendFences.get(context) !== fence) return;
      countAudioRecovery(DEADLINE_LATE_SUSPEND_FENCE);
      const successor = fence.successor;
      clearLateSuspendFence(context);
      if (!successor) return;
      if (successor.preparing()) requestAudioContextSuspend(context, successor);
      else successor.stale();
    })
    .catch((error) => log.warn('[Audio] Late suspend fence failed', error));
}

function clearLateSuspendFence(context: AudioContext): void {
  if (lateSuspendFences.delete(context)) syncStateDispatcher(context);
}

/** A parked state inside the late fence: the attempt waiting there takes it, else the binding judges it. */
function handleLateSuspend(context: AudioContext, fence: AudioContextLateSuspendFence): void {
  if (!isAudioContextPrepared(context)) return;
  const fenced = fence.successor;
  clearLateSuspendFence(context);
  const pending = pendingForegroundRestartAttempt;
  const successor = fenced ?? (pending?.context === context ? pending.suspend : null);
  if (successor?.takesLateSuspend()) {
    // The old operation cannot commit anything by itself, but its concrete
    // suspended state is exactly the safe precondition the waiting attempt
    // needs. Hand the physical state to it instead of resume -> suspend
    // self-quarantining in a loop.
    if (successor.suspendLease) settleSuspendLease(successor.suspendLease);
    else successor.parked();
    return;
  }
  fenced?.stale();
  // No attempt takes it. The binding judges what it is: an interruption,
  // as outside the fence, for playback that has no recovery dialog;
  // otherwise the retired suspend is undone.
  if (stateDispatchers.get(context)?.binding?.takeLateSuspend()) return;
  requestRetiredAudioContextSuspendCleanup(context);
}

// ── The recovery resume (RO-01, Phase 7 7B-5, C1-I12) ──
// One implementation of an attempt's native resume for both owners: the
// play-request restart's gesture resume and the playback scope's gesture
// and automatic resumes. Their step rules (after the deadline, on a late
// running state, for the attempt after a retired one) stay each owner's.

/**
 * Resume the context for a recovery attempt. The native resume() is issued
 * synchronously, inside the caller's activation, and raced with
 * AUDIO_RECOVERY_RESUME_DEADLINE_MS. The context running for it promotes the
 * attempt once, from the native promise or from the dispatcher's last part,
 * the deadline passed or not, so its owner hears its own late resume as its
 * own and not as an outside one.
 */
export function requestAudioContextResume<Result>(
  context: AudioContext,
  request: AudioContextResumeRequest<Result>,
): AudioContextResumeFlight<Result> {
  const entry: AudioContextResumeEntry = { context, request, active: true, callerWaits: true };
  stateDispatcherFor(context).resumes.add(entry);
  syncStateDispatcher(context);
  let nativeResume: Promise<void>;
  countAudioRecovery(request.resumeSlot);
  try {
    nativeResume = context.resume();
  } catch (error) {
    nativeResume = Promise.reject(error);
  }
  void nativeResume.then(
    () => landRecoveryResume(entry),
    () => undefined,
  );
  const settled = raceAudioRecoveryDeadline(
    request.deadlineSlot,
    nativeResume,
    delay(AUDIO_RECOVERY_RESUME_DEADLINE_MS),
  )
    .then(() => {
      let outcome: 'running' | 'not-running' | 'lost' = 'lost';
      if (request.holds()) {
        if (String(context.state) === 'running') {
          landRecoveryResume(entry);
          outcome = 'running';
        } else {
          request.missed();
          outcome = 'not-running';
        }
      }
      entry.callerWaits = false;
      return request.result(outcome);
    })
    .catch((error: unknown) => {
      log.debug('[Audio] Recovery resume failed', error);
      entry.callerWaits = false;
      if (request.holds()) request.missed();
      dropRecoveryResume(entry);
      return request.result('refused');
    });
  return {
    settled,
    active: () => entry.active,
    drop: () => dropRecoveryResume(entry),
  };
}

/**
 * A recovery resume settled with the context running: it promotes its
 * attempt, or else its owner's rule for the attempt after a retired one acts.
 */
function landRecoveryResume(entry: AudioContextResumeEntry): void {
  if (String(entry.context.state) !== 'running') return;
  if (entry.active && entry.request.holds()) promoteRecoveryResume(entry);
  else entry.request.landed();
}

function promoteRecoveryResume(entry: AudioContextResumeEntry): void {
  dropRecoveryResume(entry);
  entry.request.promoted(entry.callerWaits);
}

function dropRecoveryResume(entry: AudioContextResumeEntry): void {
  if (!entry.active) return;
  entry.active = false;
  if (stateDispatchers.get(entry.context)?.resumes.delete(entry)) {
    syncStateDispatcher(entry.context);
  }
}

/** The context is parked for this attempt: it waits for its gesture. */
function parkForegroundRestart(attempt: ForegroundRestartAttempt): void {
  setRestartPhase(attempt, 'awaiting-gesture');
  if (!attempt.preparedSettled) {
    attempt.preparedSettled = true;
    attempt.resolvePrepared(true);
  }
}

function startFreshForegroundSuspend(attempt: ForegroundRestartAttempt): void {
  if (!foregroundRestartStillCurrent(attempt) || attempt.phase !== 'preparing-suspend') return;
  requestAudioContextSuspend(attempt.context, attempt.suspend);
}

/**
 * Something resumed the context an attempt had parked for its gesture: park
 * the same attempt again, with the same suspend budget (C1-I13 a, Phase 7
 * 7B-2). A recovery dialog whose tap meets this re-park waits on `parked`.
 */
function reparkForegroundRestart(attempt: ForegroundRestartAttempt): void {
  let settle!: (parked: boolean) => void;
  const parked = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  attempt.reprepare = { parked, settle };
  setRestartPhase(attempt, 'preparing-suspend');
  startFreshForegroundSuspend(attempt);
}

function retireForegroundRestartAttempt(
  attempt: ForegroundRestartAttempt,
  restorePrepared = true,
  end: ForegroundRestartEnd = 'retired',
): void {
  if (attempt.phase === 'cancelled' || attempt.phase === 'completed') return;
  const shouldRestore = restorePrepared && isAudioContextPrepared(attempt.context);
  const { suspend } = attempt;
  attempt.resume?.drop();
  attempt.resume = null;
  if (suspend.suspendLease?.nativeResolvedWithoutPrepared) {
    abandonSuspendLease(suspend.suspendLease, true);
  }
  attempt.end = end;
  setRestartPhase(attempt, 'cancelled');
  if (!attempt.preparedSettled) {
    attempt.preparedSettled = true;
    attempt.resolvePrepared(false);
  }
  if (suspend.suspendLease?.owner === suspend) suspend.suspendLease.owner = null;
  suspend.suspendLease = null;
  if (pendingForegroundRestartAttempt === attempt) pendingForegroundRestartAttempt = null;
  if (attempt.generation === foregroundRestartGeneration) foregroundRestartGeneration += 1;
  if (shouldRestore) requestRetiredAudioContextSuspendCleanup(attempt.context);
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
    // What this owner does with the ledger's answers: after two lost
    // suspends, or when a later request takes its place, the attempt retires
    // without restoring the parked context (the next owner parks it anyway).
    suspend: {
      suspendPrepareAttempts: 0,
      suspendLease: null,
      watchdogSlot: DEADLINE_PLAY_REQUEST_WATCHDOG,
      preparing: () =>
        foregroundRestartStillCurrent(attempt) && attempt.phase === 'preparing-suspend',
      takesLateSuspend: () =>
        foregroundRestartStillCurrent(attempt) &&
        (attempt.phase === 'preparing-suspend' || attempt.phase === 'awaiting-gesture'),
      parked: () => parkForegroundRestart(attempt),
      lost: () => {
        if (foregroundRestartStillCurrent(attempt)) retireForegroundRestartAttempt(attempt, false);
      },
      stale: () => undefined,
      exhausted: () => retireForegroundRestartAttempt(attempt, false),
      retrying: () => undefined,
    },
    gestureResume: null,
    resume: null,
    resolvePrepared,
    whenPrepared,
    preparedSettled: false,
    reprepare: null,
    dialog: false,
    end: 'retired',
    requirementWait: null,
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

/**
 * Holding (ownership record Decision 6, Phase 7 7B-3): the current attempt
 * is parking the context for its dialog's tap, parked for the tap of a
 * dialog that has taken it, or resuming it from that tap. An attempt parked
 * with no dialog (its notice never became one) holds nothing. A play-request
 * attempt is always a local file's, and its suspend lease and late-suspend
 * fence serve it only while it prepares the suspend. The playback-scope
 * owner asks it for UI sounds (isAudioOutputRecoveryHolding), and the
 * /debug sync counts ask it.
 */
export function isForegroundAudioContextRestartHolding(): boolean {
  const attempt = pendingForegroundRestartAttempt;
  return Boolean(
    attempt &&
    foregroundRestartStillCurrent(attempt) &&
    (attempt.phase === 'preparing-suspend' ||
      (attempt.phase === 'awaiting-gesture' && attempt.dialog) ||
      attempt.phase === 'gesture-resuming'),
  );
}

/**
 * The recovery dialog takes this exact attempt when it shows its request
 * (app.ts). From then on the owner parks the attempt again after an outside
 * resume (C1-I13 a, Phase 7 7B-2) and holds the context for its tap (7B-3);
 * the dialog's close retires it, or shows the same request again. An attempt
 * whose notice never became a dialog (the page was hidden, the PLAY was
 * replaced, a forced update was pending) is left to the next PLAY's clock
 * check, as before 7B-2. true when the current attempt has that token.
 */
export function claimForegroundAudioContextRestartForDialog(attemptToken: object): boolean {
  const attempt = pendingForegroundRestartAttempt;
  if (
    !attempt ||
    attempt.attemptToken !== attemptToken ||
    !foregroundRestartStillCurrent(attempt)
  ) {
    return false;
  }
  attempt.dialog = true;
  return true;
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
    retireForegroundRestartAttempt(pendingForegroundRestartAttempt, false, 'superseded');
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
    retireForegroundRestartAttempt(attempt, false, 'superseded');
    attempt = null;
  }
  if (!attempt) attempt = createForegroundRestartAttempt(incident);
  if (!foregroundRestartStillCurrent(attempt)) return null;
  if (attempt.phase === 'gesture-resuming' || attempt.phase === 'awaiting-clock-verification') {
    return null;
  }

  if (isAudioContextPrepared(attempt.context)) {
    attempt.suspend.suspendLease = null;
    parkForegroundRestart(attempt);
  } else if (attempt.phase !== 'preparing-suspend') {
    return null;
  }

  if (attempt.phase === 'preparing-suspend') {
    const lease = liveSuspendLease(attempt.context);
    if (lease?.nativeResolvedWithoutPrepared) {
      // An inconclusive suspend in flight, of this attempt or of another
      // owner's: the next one waits behind its late fence, and the attempt
      // it served retires (the later request stays, owner answer Q6).
      const previous = abandonSuspendLease(lease, true);
      if (previous && previous !== attempt.suspend) previous.lost();
      if (attempt.suspend.suspendPrepareAttempts >= AUDIO_SUSPEND_MAX_ATTEMPTS) {
        retireForegroundRestartAttempt(attempt, false);
        return null;
      }
    }
    // A late fence keeps it waiting for its next suspend; a lease in flight
    // (either owner's) is taken over; otherwise one fresh native suspend.
    startFreshForegroundSuspend(attempt);
  }

  const whenPrepared = attempt.whenPrepared;
  const initial = await raceAudioRecoveryDeadline(
    DEADLINE_PLAY_REQUEST_PREPARE,
    whenPrepared.then((prepared): 'prepared' | 'stale' => (prepared ? 'prepared' : 'stale')),
    delay(AUDIO_SUSPEND_PREPARE_DEADLINE_MS).then(() => 'preparing' as const),
  );
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

/**
 * A retired attempt's gesture resume can physically undo a successor's
 * prepared suspension. It may not promote that successor; put the successor
 * back through a fresh suspend lease instead.
 */
function reparkSuccessorAfterRetiredResume(attempt: ForegroundRestartAttempt): void {
  const successor = pendingForegroundRestartAttempt;
  if (
    successor &&
    successor !== attempt &&
    successor.context === attempt.context &&
    foregroundRestartStillCurrent(successor) &&
    successor.phase === 'awaiting-gesture'
  ) {
    reparkForegroundRestart(successor);
  }
}

/**
 * The binding's `running` statechange (context-recovery.ts): something
 * outside this owner (the OS, ensureRunning, a UI sound) resumed a context
 * whose play-request attempt waits for the tap of a dialog that has taken
 * it. Park the same attempt again at once, as the playback scope
 * re-suspends its own (C1-I13 a, Phase 7 7B-2), so the gesture resumes a
 * parked context instead of finding it running. The attempt's own gesture
 * resume, still unsettled after its deadline, is promoted by the
 * dispatcher's last part instead. An attempt no dialog has taken is not
 * parked again: no tap can come for it, and the resume stands for whoever
 * made it (a PLAY's ensureRunning, whose clock check then decides).
 */
export function reparkForegroundAudioContextRestartAfterResume(context: AudioContext): void {
  const attempt = pendingForegroundRestartAttempt;
  if (
    attempt?.context === context &&
    attempt.phase === 'awaiting-gesture' &&
    attempt.dialog &&
    attempt.resume?.active() !== true &&
    foregroundRestartStillCurrent(attempt)
  ) {
    reparkForegroundRestart(attempt);
  }
}

/**
 * Asked by the recovery dialog when its tap meets this exact attempt being
 * parked again (its preparation reads not current until then). The promise
 * settles once: true when the same attempt is parked for its gesture again,
 * false when it retired first. The dialog keeps the attempt for it and shows
 * the same request again; null means no re-park, and the dialog retires the
 * attempt as before (C1-I13 a, Phase 7 7B-2).
 */
export function whenForegroundAudioContextRestartReprepared(
  attemptToken: object,
): Promise<boolean> | null {
  const attempt = pendingForegroundRestartAttempt;
  return attempt?.attemptToken === attemptToken ? (attempt.reprepare?.parked ?? null) : null;
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
    !isAudioContextPrepared(attempt.context)
  ) {
    countAudioRecovery(TAPS_REFUSED);
    return Promise.resolve({ running: false, requiresClockVerification: false });
  }
  if (attempt.gestureResume) return attempt.gestureResume;

  setRestartPhase(attempt, 'gesture-resuming');
  attempt.resume?.drop();
  // The one recovery resume (Phase 7 7B-5), with this owner's step rules.
  const flight = requestAudioContextResume(attempt.context, {
    resumeSlot: RESUME_PLAY_REQUEST,
    deadlineSlot: DEADLINE_PLAY_REQUEST_RESUME,
    holds: () => foregroundRestartStillCurrent(attempt),
    // Running is only provisional: the dialog's clock probe must pass before
    // commit, and this owner runs none of its own (K-I12-a).
    promoted: () => setRestartPhase(attempt, 'awaiting-clock-verification'),
    // After the deadline it waits for its gesture again while the context is
    // parked, otherwise for a suspend with no lease.
    missed: () =>
      setRestartPhase(
        attempt,
        isAudioContextPrepared(attempt.context) ? 'awaiting-gesture' : 'preparing-suspend',
      ),
    landed: () => reparkSuccessorAfterRetiredResume(attempt),
    result: (outcome) => ({
      running: outcome === 'running',
      requiresClockVerification: outcome === 'running',
    }),
  });
  attempt.resume = flight;
  const operation = flight.settled.finally(() => {
    if (attempt.gestureResume === operation) attempt.gestureResume = null;
  });
  attempt.gestureResume = operation;
  return operation;
}

/**
 * The recovery dialog's wait after its tap for this attempt's clock
 * requirement (Phase 7 7B-5, owner answer Q7, in place of a 50 ms poll). It
 * settles once: 'promoted' when the gesture's resume brings the context to
 * running for the attempt (its requirement is then exposed), 'cancelled'
 * when a caller retires its token, 'superseded' when a newer foreground
 * incident or restart attempt takes its place, 'retired' when its owner ends
 * it (its incident consumed elsewhere, its suspend lost) or it is gone
 * already. It does not settle by itself while the attempt waits: the
 * dialog's own limit, AbortSignal and currency end that wait.
 */
export function whenForegroundAudioContextRestartClockRequirement(
  attemptToken: object,
): Promise<ForegroundRestartRequirementOutcome> {
  const attempt = pendingForegroundRestartAttempt;
  if (
    !attempt ||
    attempt.attemptToken !== attemptToken ||
    !foregroundRestartStillCurrent(attempt)
  ) {
    return Promise.resolve('retired');
  }
  if (attempt.phase === 'awaiting-clock-verification') return Promise.resolve('promoted');
  if (!attempt.requirementWait) {
    let settle!: (outcome: ForegroundRestartRequirementOutcome) => void;
    const settled = new Promise<ForegroundRestartRequirementOutcome>((resolve) => {
      settle = resolve;
    });
    attempt.requirementWait = { settled, settle };
  }
  return attempt.requirementWait.settled;
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
  setRestartPhase(attempt, 'completed');
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
  retireForegroundRestartAttempt(attempt, true, 'cancelled');
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
    countAudioRecovery(RESUME_ENSURE_RUNNING);
    // Add a race to prevent hanging on browsers that don't resolve resume() without a gesture
    await raceAudioRecoveryDeadline(
      DEADLINE_ENSURE_RUNNING,
      ctx.resume(),
      delay(AUDIO_RESUME_DEADLINE_MS),
    );
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
 * Every caller chooses whether a context that is not running is resumed
 * first (`attemptResume`); there is no default resume.
 */
export async function probeAudioContextHealth(options: {
  attemptResume: boolean;
  isCurrent?: () => boolean;
  context?: AudioContext;
}): Promise<AudioContextHealthResult> {
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

  if (String(ctx.state) !== 'running' && options.attemptResume) {
    countAudioRecovery(RESUME_PROBE);
    try {
      await raceAudioRecoveryDeadline(
        DEADLINE_PROBE,
        ctx.resume(),
        delay(AUDIO_RESUME_DEADLINE_MS),
      );
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
