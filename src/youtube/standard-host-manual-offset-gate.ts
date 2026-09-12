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
import { getCurrentQueueItemId, getQueueItemById } from '../player/queue-model.ts';
import { getRoomContext } from '../rooms/authority.ts';
import { IMMEDIATE_ACTION_COOLDOWN_MS } from './constants.ts';
import {
  clearProCoordinatorYouTubeNudgeAnchor,
  isStandardHostYouTubeManualOffsetEndpoint,
  PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER,
} from './local-offset.ts';
import { getCurrentSessionId, getYouTubePlayer, type YouTubePlayerInstance } from './_state.ts';

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
  readonly scheduled: boolean;
  isCurrent(): boolean;
  publishRequestedOffset(value: number): void;
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
  projectedRequestedOffset: number;
}

type StandardHostManualOffsetInputMode = 'debounced' | 'committed';

interface UserInputIdentity {
  player: YouTubePlayerInstance;
  sessionId: number;
  endpoint: string;
  queueItemId: string;
  subIndex: number;
  videoId: string;
}

interface PendingUserInput {
  identity: UserInputIdentity;
  requestedOffset: number;
  dueAt: number;
  baselineRequestedOffset: number;
  baselineAppliedOffset: number;
}

const USER_INPUT_TIMER = 'yt-standard-host-offset-input';
const USER_INPUT_DEBOUNCE_MS = 1_000;

type RuntimeModule = typeof import('./standard-host-manual-offset-runtime.ts');

let generation = 0;
let activeReservation: ActiveReservation | null = null;
let loadedRuntime: RuntimeModule | null = null;
let runtimeLoad: Promise<RuntimeModule> | null = null;
let settlementListeners: Array<() => void> = [];
let settlementEpoch = 0;
let pendingUserInput: PendingUserInput | null = null;

function readUserInputIdentity(player: YouTubePlayerInstance): UserInputIdentity | null {
  if (
    getYouTubePlayer() !== player ||
    getState('playback.mode') !== 'youtube' ||
    !isStandardHostYouTubeManualOffsetEndpoint()
  )
    return null;
  const queueItemId = getCurrentQueueItemId();
  const item = queueItemId ? getQueueItemById(queueItemId) : null;
  if (!queueItemId || item?.type !== 'youtube') return null;
  const room = getRoomContext();
  const subIndex = getState('youtube.currentSubIndex') ?? -1;
  const videoId = item.playlistId
    ? getState('youtube.subItemsMap')[item.playlistId]?.ids?.[subIndex] || ''
    : item.videoId || '';
  if (!videoId) return null;
  return {
    player,
    sessionId: getCurrentSessionId(),
    endpoint: `${getState('network.sessionCode')}:${room.roomId ?? ''}:${room.epoch}`,
    queueItemId,
    subIndex,
    videoId,
  };
}

function matchesUserInputIdentity(identity: UserInputIdentity): boolean {
  const live = readUserInputIdentity(identity.player);
  return (
    !!live &&
    live.sessionId === identity.sessionId &&
    live.endpoint === identity.endpoint &&
    live.queueItemId === identity.queueItemId &&
    live.subIndex === identity.subIndex &&
    live.videoId === identity.videoId
  );
}

function currentPendingUserInput(): PendingUserInput | null {
  const pending = pendingUserInput;
  if (pending && !matchesUserInputIdentity(pending.identity)) {
    pendingUserInput = null;
    clearManagedTimer(USER_INPUT_TIMER);
    return null;
  }
  return pending;
}

function clearPendingUserInput(restoreRequested = false): boolean {
  const pending = pendingUserInput;
  pendingUserInput = null;
  clearManagedTimer(USER_INPUT_TIMER);
  if (restoreRequested && pending && matchesUserInputIdentity(pending.identity)) {
    setState(
      'sync.youtubeLocalOffset',
      activeReservation?.projectedRequestedOffset ?? pending.baselineRequestedOffset,
    );
    bus.emit('sync:display-update');
  }
  return pending !== null;
}

function schedulePendingUserInput(): void {
  const pending = currentPendingUserInput();
  if (!pending) return;
  const waitMs = Math.max(0, pending.dueAt - Date.now());
  clearManagedTimer(USER_INPUT_TIMER);
  if (waitMs > 0) {
    setManagedTimer(USER_INPUT_TIMER, flushPendingUserInput, waitMs);
  } else if (!activeReservation) {
    // Let the previous runtime finish unwinding before the next one begins.
    queueMicrotask(() => {
      if (pendingUserInput === pending) flushPendingUserInput();
    });
  }
}

function flushPendingUserInput(): void {
  const pending = currentPendingUserInput();
  if (!pending) return;
  if (Date.now() < pending.dueAt) {
    schedulePendingUserInput();
    return;
  }
  if (activeReservation) return;
  pendingUserInput = null;
  clearManagedTimer(USER_INPUT_TIMER);
  beginReservation(
    pending.identity.player,
    pending.requestedOffset,
    true,
    pending.baselineRequestedOffset,
    pending.baselineAppliedOffset,
    pending.identity,
  );
}

function releaseSettlementListeners(): void {
  const listeners = settlementListeners;
  settlementListeners = [];
  if (listeners.length === 0) return;
  const epoch = settlementEpoch;
  queueMicrotask(() => {
    if (epoch !== settlementEpoch) return;
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
  scheduled = false,
): StandardHostManualOffsetLease {
  const isCurrent = (): boolean => activeReservation === reservation;
  return {
    generation: reservation.generation,
    player,
    requestedOffsetSeconds,
    priorRequestedOffset,
    priorAppliedOffset,
    scheduled,
    isCurrent,
    publishRequestedOffset(value) {
      if (!isCurrent()) return;
      reservation.projectedRequestedOffset = value;
      setState('sync.youtubeLocalOffset', currentPendingUserInput()?.requestedOffset ?? value);
    },
    bindRuntimeHooks(hooks) {
      if (!isCurrent()) return false;
      reservation.hooks = hooks;
      return true;
    },
    commit(action) {
      if (!isCurrent()) return false;
      action();
      if (isCurrent()) {
        reservation.projectedRequestedOffset = getState('sync.youtubeLocalOffset');
        const pending = currentPendingUserInput();
        if (pending) {
          pending.baselineRequestedOffset = reservation.projectedRequestedOffset;
          pending.baselineAppliedOffset = getState('sync.youtubeCoordinatorAppliedOffset');
          setState('sync.youtubeLocalOffset', pending.requestedOffset);
          bus.emit('sync:display-update');
        }
        activeReservation = null;
        schedulePendingUserInput();
        releaseSettlementListeners();
      }
      return true;
    },
    restorePrevious(action) {
      if (!isCurrent()) return false;
      activeReservation = reservation.previous;
      action();
      const pending = currentPendingUserInput();
      if (pending) {
        setState('sync.youtubeLocalOffset', pending.requestedOffset);
        bus.emit('sync:display-update');
      }
      if (!activeReservation) {
        schedulePendingUserInput();
        releaseSettlementListeners();
      }
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
  clearPendingUserInput(true);
  const priorRequestedOffset = getState('sync.youtubeLocalOffset') || 0;
  const priorAppliedOffset = getState('sync.youtubeCoordinatorAppliedOffset') || 0;
  beginReservation(player, requestedOffsetSeconds, false, priorRequestedOffset, priorAppliedOffset);
}

/** Accumulate user edits without owning playback until an actual command starts. */
export function requestUserStandardHostManualOffsetTransaction(
  player: YouTubePlayerInstance,
  requestedOffsetSeconds: number,
  inputMode: StandardHostManualOffsetInputMode,
): void {
  if (!Number.isFinite(requestedOffsetSeconds)) return;
  const identity = readUserInputIdentity(player);
  if (!identity) return;
  const previous = currentPendingUserInput();
  pendingUserInput = {
    identity,
    requestedOffset: clampOffset(requestedOffsetSeconds),
    dueAt: Date.now() + (inputMode === 'debounced' ? USER_INPUT_DEBOUNCE_MS : 0),
    baselineRequestedOffset:
      previous?.baselineRequestedOffset ??
      activeReservation?.baselineRequestedOffset ??
      getState('sync.youtubeLocalOffset'),
    baselineAppliedOffset:
      previous?.baselineAppliedOffset ??
      activeReservation?.baselineAppliedOffset ??
      getState('sync.youtubeCoordinatorAppliedOffset'),
  };
  setState('sync.youtubeLocalOffset', pendingUserInput.requestedOffset);
  bus.emit('sync:display-update');
  clearManagedTimer(USER_INPUT_TIMER);
  if (inputMode === 'committed') flushPendingUserInput();
  else schedulePendingUserInput();
}

function beginReservation(
  player: YouTubePlayerInstance,
  requestedOffsetSeconds: number,
  scheduled: boolean,
  priorRequestedOffset: number,
  priorAppliedOffset: number,
  userIdentity?: UserInputIdentity,
): void {
  const reservation: ActiveReservation = {
    generation: ++generation,
    hooks: activeReservation?.hooks ?? null,
    previous: activeReservation,
    baselineRequestedOffset: activeReservation?.baselineRequestedOffset ?? priorRequestedOffset,
    baselineAppliedOffset: activeReservation?.baselineAppliedOffset ?? priorAppliedOffset,
    projectedRequestedOffset: clampOffset(requestedOffsetSeconds),
  };
  activeReservation = reservation;
  const requestedOffset = clampOffset(requestedOffsetSeconds);
  const lease = makeLease(
    reservation,
    player,
    requestedOffset,
    priorRequestedOffset,
    priorAppliedOffset,
    scheduled,
  );

  // Requested state is immediate so rapid +/- inputs accumulate. Applied state
  // remains the last physically verified boundary until the runtime commits.
  setState('sync.youtubeLocalOffset', requestedOffset);
  bus.emit('sync:display-update');

  const beginIfCurrent = (runtime: RuntimeModule): void => {
    if (!lease.isCurrent()) return;
    if (userIdentity && !matchesUserInputIdentity(userIdentity)) {
      resetStandardHostManualOffsetTransaction();
      return;
    }
    runtime.beginStandardHostManualOffsetTransaction(lease);
  };
  if (loadedRuntime) {
    beginIfCurrent(loadedRuntime);
    return;
  }
  void loadRuntime().then(beginIfCurrent, (error: unknown) => restoreFailedLoad(lease, error));
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
  const hadPending = clearPendingUserInput();
  if (!reservation && !hadPending) return false;
  activeReservation = null;
  generation += 1;
  settlementEpoch += 1;
  settlementListeners = [];
  reservation?.hooks?.cancelForMediaTransition();
  setState('sync.youtubeLocalOffset', 0);
  if (reservation)
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
  clearPendingUserInput();
  activeReservation = null;
  generation += 1;
  settlementEpoch += 1;
  settlementListeners = [];
  reservation?.hooks?.reset();
  clearManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER);
  clearProCoordinatorYouTubeNudgeAnchor();
}
