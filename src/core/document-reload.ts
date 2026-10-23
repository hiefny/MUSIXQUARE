/**
 * The PRO claim fence: one scrubbed, one-time claim held in RAM may survive an
 * app-owned reload. The navigation owner (core/session-reset.ts) runs every
 * reload and its queue (C6-5); this module only decides whether a reload may
 * start now and restores the claim fragment for the length of the sink call.
 *
 * Phases of the current claim: 'safe' (a reload may carry it), 'deferred' (an
 * outcome-unknown claim mutation is in flight, so reloads wait), 'reloading'
 * (the owner's in-flight reload carries it) and 'released'. Leave navigations
 * never enter the fence.
 */

type ClaimRollback = () => void;
type ClaimPreparation = () => ClaimRollback;

interface ClaimGuardState {
  preparation: ClaimPreparation;
  phase: 'safe' | 'deferred' | 'reloading' | 'released';
  mutationWaiters: Set<() => void>;
}

/** The claim the owner's in-flight reload carries, and its rollback once restored. */
interface FencedReload {
  readonly guard: ClaimGuardState | null;
  rollback: ClaimRollback | null;
  ended: boolean;
}

interface PendingClaimReloadGuard {
  /** Fence reloads before invoking a mutation whose commit result may be unknown. */
  fenceOutcomeUnknownMutation(): Promise<void>;
  /** The lazy room gate failed before mutation; replay is safe after a reload. */
  restoreAfterLazyFeatureFailure(): void;
  /** The flow ended definitively; queued reloads continue without the claim. */
  release(): void;
}

/** The navigation owner's hold on the fence for one reload attempt. */
export interface ReloadFenceTicket {
  /** Restore a safe claim fragment at the last possible moment, inside the action. */
  restoreClaim(): void;
  /** The reload ended in this document: scrub the fragment, then reopen the fence. */
  end(): void;
}

let pendingClaimGuard: ClaimGuardState | null = null;
let fencedReload: FencedReload | null = null;
let fenceOpenHandler: (() => void) | null = null;

function rollbackFencedReload(reload: FencedReload): void {
  const rollback = reload.rollback;
  reload.rollback = null;
  if (rollback) rollback();
}

function endFencedReload(reload: FencedReload): void {
  if (reload.ended) return;
  reload.ended = true;
  try {
    rollbackFencedReload(reload);
  } finally {
    if (fencedReload === reload) fencedReload = null;
    const guard = reload.guard;
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
  }
}

/** Tell the owner that queued reloads may be able to start now. */
function reportFenceOpened(): void {
  fenceOpenHandler?.();
}

/**
 * The owner's port (core/session-reset.ts): run `handler` whenever the fence
 * opens, so reloads that waited behind it can start.
 */
export function setReloadFenceOpenHandler(handler: () => void): void {
  fenceOpenHandler = handler;
}

/** Whether reloads must wait: an outcome-unknown claim mutation is in flight. */
export function isReloadFenced(): boolean {
  return pendingClaimGuard?.phase === 'deferred';
}

/** The owner starts a reload attempt; it carries the current claim if that is safe. */
export function beginFencedReload(): ReloadFenceTicket {
  const guard = pendingClaimGuard?.phase === 'safe' ? pendingClaimGuard : null;
  if (guard) guard.phase = 'reloading';
  const reload: FencedReload = { guard, rollback: null, ended: false };
  fencedReload = reload;
  return {
    restoreClaim() {
      if (fencedReload !== reload || reload.ended || reload.rollback) return;
      if (guard && pendingClaimGuard === guard && guard.phase === 'reloading') {
        reload.rollback = guard.preparation();
      }
    },
    end: () => endFencedReload(reload),
  };
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
      reportFenceOpened();
    },
    release() {
      if (pendingClaimGuard !== guard || guard.phase === 'released') return;
      pendingClaimGuard = null;
      guard.phase = 'released';
      guard.mutationWaiters.forEach((resolve) => resolve());
      guard.mutationWaiters.clear();
      try {
        if (fencedReload?.guard === guard) rollbackFencedReload(fencedReload);
      } finally {
        reportFenceOpened();
      }
    },
  };
}

/** Register the sole document-scoped claim that may survive a safe reload. */
export function registerPendingClaimReloadPreparation(
  preparation: ClaimPreparation,
): PendingClaimReloadGuard {
  const predecessor = pendingClaimGuard;
  if (predecessor) {
    predecessor.phase = 'released';
    predecessor.mutationWaiters.forEach((resolve) => resolve());
    predecessor.mutationWaiters.clear();
    if (fencedReload?.guard === predecessor) rollbackFencedReload(fencedReload);
  }
  const guard: ClaimGuardState = {
    preparation,
    phase: 'safe',
    mutationWaiters: new Set(),
  };
  pendingClaimGuard = guard;

  return createGuardFacade(guard);
}

/** @internal Exact active claim guard, captured by the flow that consumed it. */
export function capturePendingClaimReloadGuard(): PendingClaimReloadGuard | null {
  // Registration returns methods with identity-sensitive closures, so expose a
  // fresh facade only by remembering it on the state without storing secrets.
  const guard = pendingClaimGuard;
  if (!guard) return null;
  return createGuardFacade(guard);
}

/**
 * @internal Test-only cleanup for module-scoped fence state. Tests reset the
 * whole navigation owner with core/session-reset.ts
 * __resetPageNavigationForTests, which calls this (C6-13).
 */
export function __resetReloadFenceForTests(): void {
  if (fencedReload) rollbackFencedReload(fencedReload);
  pendingClaimGuard?.mutationWaiters.forEach((resolve) => resolve());
  pendingClaimGuard = null;
  fencedReload = null;
}
