/** Coordinates app-owned reloads with a scrubbed, one-time claim held in RAM. */

type DocumentReloadRollback = () => void;
type DocumentReloadPreparation = () => DocumentReloadRollback;

interface ClaimGuardState {
  preparation: DocumentReloadPreparation;
  phase: 'safe' | 'deferred' | 'reloading' | 'released';
  mutationWaiters: Set<() => void>;
}

interface ReloadAttemptState {
  guard: ClaimGuardState | null;
  navigated: boolean;
  rollback: DocumentReloadRollback | null;
}

interface PendingClaimReloadGuard {
  /** Fence reloads before invoking a mutation whose commit result may be unknown. */
  fenceOutcomeUnknownMutation(): Promise<void>;
  /** The lazy room gate failed before mutation; replay is safe after a reload. */
  restoreAfterLazyFeatureFailure(): void;
  /** The flow ended definitively; queued reloads continue without the claim. */
  release(): void;
}

interface DocumentReloadAttempt {
  /** Restore a safe pending claim at the last possible moment, then navigate. */
  navigate(action: () => void): void;
  /** Roll back a restored fragment when the current document remains active. */
  recover(): void;
}

let pendingClaimGuard: ClaimGuardState | null = null;
let activeReloadAttempt: ReloadAttemptState | null = null;
const queuedReloads: Array<(attempt: DocumentReloadAttempt) => void> = [];

function rollbackAttempt(attempt: ReloadAttemptState): void {
  const rollback = attempt.rollback;
  attempt.rollback = null;
  if (rollback) rollback();
}

function recoverAttempt(attempt: ReloadAttemptState): void {
  if (activeReloadAttempt !== attempt) return;
  try {
    rollbackAttempt(attempt);
  } finally {
    activeReloadAttempt = null;
    const guard = attempt.guard;
    if (guard && pendingClaimGuard === guard && guard.phase === 'reloading') {
      if (guard.mutationWaiters.size > 0) {
        guard.phase = 'deferred';
        const waiters = [...guard.mutationWaiters];
        guard.mutationWaiters.clear();
        for (const resolve of waiters) resolve();
      } else {
        guard.phase = 'safe';
      }
    }
    flushReloadQueue();
  }
}

function flushReloadQueue(): void {
  if (activeReloadAttempt) return;
  if (pendingClaimGuard?.phase === 'deferred') return;
  const start = queuedReloads.shift();
  if (!start) return;

  const guard = pendingClaimGuard?.phase === 'safe' ? pendingClaimGuard : null;
  if (guard) guard.phase = 'reloading';
  const attempt: ReloadAttemptState = { guard, navigated: false, rollback: null };
  activeReloadAttempt = attempt;
  const publicAttempt: DocumentReloadAttempt = {
    navigate(action) {
      if (activeReloadAttempt !== attempt || attempt.navigated) return;
      attempt.navigated = true;
      try {
        if (guard && pendingClaimGuard === guard && guard.phase === 'reloading') {
          attempt.rollback = guard.preparation();
        }
        action();
      } catch (error) {
        recoverAttempt(attempt);
        throw error;
      }
    },
    recover: () => recoverAttempt(attempt),
  };

  try {
    start(publicAttempt);
  } catch (error) {
    recoverAttempt(attempt);
    throw error;
  }
}

function createGuardFacade(guard: ClaimGuardState): PendingClaimReloadGuard {
  return {
    async fenceOutcomeUnknownMutation() {
      if (pendingClaimGuard !== guard || guard.phase === 'released') return;
      if (guard.phase === 'safe') {
        guard.phase = 'deferred';
        return;
      }
      if (guard.phase === 'deferred') return;
      await new Promise<void>((resolve) => guard.mutationWaiters.add(resolve));
    },
    restoreAfterLazyFeatureFailure() {
      if (pendingClaimGuard !== guard || guard.phase === 'released') return;
      if (guard.phase === 'deferred') guard.phase = 'safe';
      flushReloadQueue();
    },
    release() {
      if (pendingClaimGuard !== guard || guard.phase === 'released') return;
      pendingClaimGuard = null;
      guard.phase = 'released';
      guard.mutationWaiters.forEach((resolve) => resolve());
      guard.mutationWaiters.clear();
      try {
        if (activeReloadAttempt?.guard === guard) rollbackAttempt(activeReloadAttempt);
      } finally {
        flushReloadQueue();
      }
    },
  };
}

/** Register the sole document-scoped claim that may survive a safe reload. */
export function registerPendingClaimReloadPreparation(
  preparation: DocumentReloadPreparation,
): PendingClaimReloadGuard {
  const predecessor = pendingClaimGuard;
  if (predecessor) {
    predecessor.phase = 'released';
    predecessor.mutationWaiters.forEach((resolve) => resolve());
    predecessor.mutationWaiters.clear();
    if (activeReloadAttempt?.guard === predecessor) rollbackAttempt(activeReloadAttempt);
  }
  const guard: ClaimGuardState = {
    preparation,
    phase: 'safe',
    mutationWaiters: new Set(),
  };
  pendingClaimGuard = guard;

  return createGuardFacade(guard);
}

/** Queue an app-owned hard reload until an outcome-unknown claim mutation ends. */
export function requestDocumentReload(start: (attempt: DocumentReloadAttempt) => void): void {
  queuedReloads.push(start);
  flushReloadQueue();
}

/** @internal Exact active claim guard, captured by the flow that consumed it. */
export function capturePendingClaimReloadGuard(): PendingClaimReloadGuard | null {
  // Registration returns methods with identity-sensitive closures, so expose a
  // fresh facade only by remembering it on the state without storing secrets.
  const guard = pendingClaimGuard;
  if (!guard) return null;
  return createGuardFacade(guard);
}

/** @internal Test-only cleanup for module-scoped coordination state. */
export function __resetDocumentReloadForTests(): void {
  if (activeReloadAttempt) rollbackAttempt(activeReloadAttempt);
  pendingClaimGuard?.mutationWaiters.forEach((resolve) => resolve());
  pendingClaimGuard = null;
  activeReloadAttempt = null;
  queuedReloads.length = 0;
}
