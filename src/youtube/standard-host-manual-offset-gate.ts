/**
 * Synchronous safety boundary for the lazily loaded Standard-host YouTube
 * manual-offset transaction. Every caller that can publish or replace media
 * reads this tiny eager facade; iframe commands and their verifier stay in the
 * deferred runtime.
 */

import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { MANUAL_SYNC_OFFSET_LIMIT_SEC } from '../core/constants.ts';
import { getState, setState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { IMMEDIATE_ACTION_COOLDOWN_MS } from './constants.ts';
import {
  clearProCoordinatorYouTubeNudgeAnchor,
  PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER,
} from './local-offset.ts';
import type { YouTubePlayerInstance } from './_state.ts';

export interface StandardHostManualOffsetRuntimeHooks {
  cancelForMediaTransition(): void;
  repairAfterTimerCleanup(): void;
  reset(): void;
}

export interface StandardHostManualOffsetLease {
  readonly generation: number;
  readonly player: YouTubePlayerInstance;
  readonly requestedOffsetSeconds: number;
  readonly priorRequestedOffset: number;
  readonly priorAppliedOffset: number;
  isCurrent(): boolean;
  bindRuntimeHooks(hooks: StandardHostManualOffsetRuntimeHooks): boolean;
  commit(action: () => void): boolean;
  restorePrevious(action: () => void): boolean;
}

interface ActiveReservation {
  generation: number;
  hooks: StandardHostManualOffsetRuntimeHooks | null;
  previous: ActiveReservation | null;
  baselineRequestedOffset: number;
  baselineAppliedOffset: number;
}

type RuntimeModule = typeof import('./standard-host-manual-offset-runtime.ts');

let generation = 0;
let activeReservation: ActiveReservation | null = null;
let loadedRuntime: RuntimeModule | null = null;
let runtimeLoad: Promise<RuntimeModule> | null = null;
let settlementListeners: Array<() => void> = [];

function releaseSettlementListeners(): void {
  const listeners = settlementListeners;
  settlementListeners = [];
  if (listeners.length === 0) return;
  queueMicrotask(() => {
    // A rapid follow-up edit extends the same media fence. Preserve every
    // deferred intent until the newest transaction owns a verified boundary.
    if (activeReservation) {
      settlementListeners.push(...listeners);
      return;
    }
    for (const listener of listeners) listener();
  });
}

function loadRuntime(): Promise<RuntimeModule> {
  runtimeLoad ??= import('./standard-host-manual-offset-runtime.ts')
    .then((runtime) => {
      loadedRuntime = runtime;
      return runtime;
    })
    .catch((error: unknown) => {
      // A chunk fetch can fail transiently during an atomic deployment. No
      // iframe command ran before evaluation, so release this flight and let a
      // later explicit input attempt the immutable URL again.
      loadedRuntime = null;
      runtimeLoad = null;
      throw error;
    });
  return runtimeLoad;
}

function clampOffset(offset: number): number {
  return Math.max(-MANUAL_SYNC_OFFSET_LIMIT_SEC, Math.min(MANUAL_SYNC_OFFSET_LIMIT_SEC, offset));
}

function makeLease(
  reservation: ActiveReservation,
  player: YouTubePlayerInstance,
  requestedOffsetSeconds: number,
  priorRequestedOffset: number,
  priorAppliedOffset: number,
): StandardHostManualOffsetLease {
  const isCurrent = (): boolean => activeReservation === reservation;
  return {
    generation: reservation.generation,
    player,
    requestedOffsetSeconds,
    priorRequestedOffset,
    priorAppliedOffset,
    isCurrent,
    bindRuntimeHooks(hooks) {
      if (!isCurrent()) return false;
      reservation.hooks = hooks;
      return true;
    },
    commit(action) {
      if (!isCurrent()) return false;
      action();
      if (isCurrent()) {
        activeReservation = null;
        releaseSettlementListeners();
      }
      return true;
    },
    restorePrevious(action) {
      if (!isCurrent()) return false;
      activeReservation = reservation.previous;
      action();
      return true;
    },
  };
}

function restoreFailedLoad(lease: StandardHostManualOffsetLease, error: unknown): void {
  lease.commit(() => {
    const reservation = activeReservation;
    setState(
      'sync.youtubeLocalOffset',
      reservation?.baselineRequestedOffset ?? lease.priorRequestedOffset,
    );
    setState(
      'sync.youtubeCoordinatorAppliedOffset',
      reservation?.baselineAppliedOffset ?? lease.priorAppliedOffset,
    );
    bus.emit('sync:display-update');
  });
  log.warn('[YouTube Sync] Standard-host manual-offset runtime failed to load:', error);
}

/** Reserve the gate synchronously, before the dynamic import can yield. */
export function requestStandardHostManualOffsetTransaction(
  player: YouTubePlayerInstance,
  requestedOffsetSeconds: number,
): void {
  const priorRequestedOffset = getState('sync.youtubeLocalOffset') || 0;
  const priorAppliedOffset = getState('sync.youtubeCoordinatorAppliedOffset') || 0;
  const reservation: ActiveReservation = {
    generation: ++generation,
    hooks: activeReservation?.hooks ?? null,
    previous: activeReservation,
    baselineRequestedOffset: activeReservation?.baselineRequestedOffset ?? priorRequestedOffset,
    baselineAppliedOffset: activeReservation?.baselineAppliedOffset ?? priorAppliedOffset,
  };
  activeReservation = reservation;
  const requestedOffset = clampOffset(requestedOffsetSeconds);
  const lease = makeLease(
    reservation,
    player,
    requestedOffset,
    priorRequestedOffset,
    priorAppliedOffset,
  );

  // Requested state is immediate so rapid +/- inputs accumulate. Applied state
  // remains the last physically verified boundary until the runtime commits.
  setState('sync.youtubeLocalOffset', requestedOffset);
  bus.emit('sync:display-update');

  if (loadedRuntime) {
    loadedRuntime.beginStandardHostManualOffsetTransaction(lease);
    return;
  }
  void loadRuntime().then(
    (runtime) => {
      if (lease.isCurrent()) runtime.beginStandardHostManualOffsetTransaction(lease);
    },
    (error: unknown) => restoreFailedLoad(lease, error),
  );
}

/** Preload hook used by focused tests and optional post-interaction warm-up. */
export function prepareStandardHostManualOffsetRuntimeForTests(): Promise<void> {
  return loadRuntime().then(() => undefined);
}

export function isStandardHostManualOffsetTransactionPending(): boolean {
  return activeReservation !== null;
}

/** Keep one-shot local actions behind the same verified iframe boundary. */
export function afterStandardHostManualOffsetTransaction(listener: () => void): boolean {
  if (!activeReservation) return false;
  settlementListeners.push(listener);
  return true;
}

/** Hard media transitions must synchronously invalidate a deferred command. */
export function cancelStandardHostManualOffsetTransaction(): boolean {
  const reservation = activeReservation;
  if (!reservation) return false;
  activeReservation = null;
  generation += 1;
  settlementListeners = [];
  reservation.hooks?.cancelForMediaTransition();
  setState('sync.youtubeLocalOffset', 0);
  setManagedTimer(
    PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER,
    clearProCoordinatorYouTubeNudgeAnchor,
    IMMEDIATE_ACTION_COOLDOWN_MS,
  );
  bus.emit('sync:display-update');
  return true;
}

/** Restore a verifier whose page-wide managed timer was cleared mid-flight. */
export function repairStandardHostManualOffsetTransaction(): void {
  activeReservation?.hooks?.repairAfterTimerCleanup();
}

/** Session/authority teardown clears both a pending import and active runtime. */
export function resetStandardHostManualOffsetTransaction(): void {
  const reservation = activeReservation;
  activeReservation = null;
  generation += 1;
  settlementListeners = [];
  reservation?.hooks?.reset();
  clearManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER);
  clearProCoordinatorYouTubeNudgeAnchor();
}
