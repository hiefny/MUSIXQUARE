import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import type { QueueItemId } from '../types/index.ts';
import {
  ProRoomApiError,
  type ProRoomApiClient,
  type ProRoomPlaybackCommand,
  type ProRoomPlaybackCommandResult,
  type ProRoomPlaybackCommitEvent,
  type ProRoomPlaybackPrepareEvent,
} from './api.ts';
import type { ProRoomPlaybackCheckpoint, ProRoomSnapshot } from './contracts.ts';
import { createProRoomIdempotencyKey } from './idempotency.ts';
import {
  getProRoomServerNow,
  isProRoomServerClockCalibrated,
  waitForFreshProRoomServerClockCalibration,
} from './network-bridge.ts';
import {
  cancelProPlaybackPreparation,
  commitProPlaybackAuthority,
  createProPlaybackAuthorityToken,
  invalidateCommittedProPlaybackMedia,
  prepareCurrentProPlaybackRendezvousAuthority,
  prepareProPlaybackAuthority,
  reconcileCurrentProPlaybackAuthority,
  rendezvousCurrentProPlaybackAuthority,
  refreshProPlaybackUiControlTimeout,
  registerProPlaybackCommandHandler,
  resetProPlaybackAuthorityHooks,
  settleProPlaybackUiControl,
  type ProPlaybackAuthorityToken,
  type ProPlaybackCommitResult,
  type ProPlaybackPrepareResult,
  type ProPlaybackTimingMode,
  type ProPlaybackUserIntent,
} from './playback-authority-hooks.ts';
import type { ProRoomFirstAppendSelectionRequest } from './playlist-state-manager.ts';

const PLAYBACK_COMMAND_REQUEST_TIMEOUT_MS = 6_000;
const PLAYLIST_HYDRATION_MAX_WAIT_MS = 1_500;
const PLAYLIST_HYDRATION_PREPARE_RESERVE_MS = 500;
const PLAYBACK_RECONCILIATION_CLOCK_WAIT_MS = 1_000;
const PLAYBACK_RECONCILIATION_RENDEZVOUS_LEAD_MS = 700;

export interface ProRoomPlaybackPlaylistLease {
  readonly generation: number;
  readonly roomCode: string;
}

export interface ProRoomPlaybackReconciliationLiveness {
  /** Reference-compared opaque owner. Only requests from this exact owner may share work. */
  readonly identity: object;
  /** Checked before and after every asynchronous reconciliation boundary. */
  readonly isCurrent: () => boolean;
}

interface ProRoomPlaybackControllerPorts {
  isActive(): boolean;
  getCanonicalSnapshot(): ProRoomSnapshot | null;
  getPlaylistSnapshot(): ProRoomSnapshot | null;
  capturePlaylistLease(): ProRoomPlaybackPlaylistLease | null;
  isPlaylistLeaseCurrent(lease: ProRoomPlaybackPlaylistLease): boolean;
  getRoomAbortSignal(): AbortSignal | undefined;
  subscribePlaylistProjection(listener: () => void): () => void;
  runHeartbeat(
    force?: boolean,
    includePersistedState?: boolean,
    playbackIsCurrent?: () => boolean,
  ): Promise<void>;
  reportPlaybackTransitionReady(
    input: Parameters<ProRoomApiClient['reportPlaybackTransitionReady']>[0],
  ): ReturnType<ProRoomApiClient['reportPlaybackTransitionReady']>;
  executePlaybackCommand(
    input: Parameters<ProRoomApiClient['executePlaybackCommand']>[0],
    signal?: AbortSignal,
  ): ReturnType<ProRoomApiClient['executePlaybackCommand']>;
  recoverTerminalSession(error: ProRoomApiError): Promise<void>;
}

interface ActiveServerPlaybackTransition {
  event: ProRoomPlaybackPrepareEvent;
  authority: ProPlaybackAuthorityToken;
  preparation: ReturnType<typeof prepareProPlaybackAuthority>;
  readyReportStarted: boolean;
  receivedAtMs: number;
  clockAbort: AbortController;
}

type PlaybackCommitOwner = () => boolean;

interface PlaybackCommitFlight {
  promise: Promise<void>;
  owner: PlaybackCommitOwner;
}

interface PlaybackCommitFollowUp {
  event: ProRoomPlaybackCommitEvent;
  owner: PlaybackCommitOwner;
}

interface PlaybackReconciliationOptions {
  showLoading: boolean;
  youtubeOnly: boolean;
  rendezvous: boolean;
  owner: ProRoomPlaybackReconciliationLiveness;
}

interface PlaybackReconciliationFlight {
  options: PlaybackReconciliationOptions;
  promise: Promise<boolean>;
  schedulerGeneration: number;
}

interface QueuedPlaybackReconciliation {
  options: PlaybackReconciliationOptions;
  promise: Promise<boolean>;
  resolve: (value: boolean) => void;
  reject: (reason: unknown) => void;
  schedulerGeneration: number;
}

interface PendingLocalPlaybackUiControl {
  token: number;
  roomCode: string;
  roomEpoch: number;
  expectedPlaybackRevision: number;
  admitted: boolean;
  transitionId: string | null | undefined;
}

interface ProRoomPlaybackControllerState {
  unregisterCommandHandler: (() => void) | null;
  commandTail: Promise<void>;
  commandRequestSequence: number;
  commandGeneration: number;
  highestKnownRevision: number;
  lastAppliedRevision: number;
  activeTransition: ActiveServerPlaybackTransition | null;
  transitionUiIds: Set<string>;
  commitInFlight: Map<number, PlaybackCommitFlight>;
  commitFollowUps: Map<number, PlaybackCommitFollowUp>;
  commitTail: Promise<void>;
  commitGeneration: number;
  reconciliationSequence: number;
  reconciliationInFlight: PlaybackReconciliationFlight | null;
  queuedReconciliations: QueuedPlaybackReconciliation[];
  reconciliationSchedulerGeneration: number;
  pendingLocalUiControls: Map<number, PendingLocalPlaybackUiControl>;
  cancelledTransitionIds: Set<string>;
  lastAppliedUiCheckpoint: {
    roomCode: string;
    roomEpoch: number;
    revision: number;
    positionSeconds: number;
  } | null;
}

function createInitialState(): ProRoomPlaybackControllerState {
  return {
    unregisterCommandHandler: null,
    commandTail: Promise.resolve(),
    commandRequestSequence: 0,
    commandGeneration: 0,
    highestKnownRevision: -1,
    lastAppliedRevision: -1,
    activeTransition: null,
    transitionUiIds: new Set(),
    commitInFlight: new Map(),
    commitFollowUps: new Map(),
    commitTail: Promise.resolve(),
    commitGeneration: 0,
    reconciliationSequence: 0,
    reconciliationInFlight: null,
    queuedReconciliations: [],
    reconciliationSchedulerGeneration: 0,
    pendingLocalUiControls: new Map(),
    cancelledTransitionIds: new Set(),
    lastAppliedUiCheckpoint: null,
  };
}

interface ProRoomPlaybackImplementation {
  acceptPrepare(event: ProRoomPlaybackPrepareEvent, receivedAtMs?: number): void;
  acceptCancel(transitionId: string): void;
  acceptCommit(event: ProRoomPlaybackCommitEvent, isRequestCurrent?: PlaybackCommitOwner): void;
  enqueueIntent(intent: Readonly<ProPlaybackUserIntent>): Promise<void>;
  requestFirstAppendSelection(
    request: Readonly<ProRoomFirstAppendSelectionRequest>,
    signal?: AbortSignal,
    lease?: ProRoomPlaybackPlaylistLease,
  ): Promise<void>;
  restorePersistedPlayback(
    snapshot: ProRoomSnapshot,
    isRequestCurrent?: PlaybackCommitOwner,
  ): Promise<void>;
  requestReconciliation(
    options?: Readonly<{
      showLoading?: boolean;
      liveness?: ProRoomPlaybackReconciliationLiveness;
    }>,
  ): Promise<boolean>;
  reconcile(
    options: Readonly<{
      showLoading: boolean;
      youtubeOnly: boolean;
      rendezvous: boolean;
      liveness?: ProRoomPlaybackReconciliationLiveness;
    }>,
  ): Promise<boolean>;
  startLifecycle(): void;
  stopLifecycle(): void;
  resetPlaylistRuntime(): void;
  beginControlChannelRecovery(): void;
}

function createImplementation(
  ports: ProRoomPlaybackControllerPorts,
  state: ProRoomPlaybackControllerState,
): ProRoomPlaybackImplementation {
  const MAX_CANCELLED_PLAYBACK_TRANSITION_IDS = 64;
  const canonicalPlaybackCommitOwner: PlaybackCommitOwner = () => true;
  const defaultPlaybackReconciliationIdentity = {};
  const defaultPlaybackReconciliationOwner: ProRoomPlaybackReconciliationLiveness = {
    identity: defaultPlaybackReconciliationIdentity,
    isCurrent: () => true,
  };

  function isTerminalSessionError(error: unknown): error is ProRoomApiError {
    return (
      error instanceof ProRoomApiError &&
      (error.code === 'SESSION_REQUIRED' ||
        error.code === 'PRESENCE_SUPERSEDED' ||
        error.status === 423 ||
        error.code === 'ROOM_SUSPENDED')
    );
  }

  function beginPlaybackTransitionUi(transitionId: string): void {
    const wasLoading = state.transitionUiIds.size > 0;
    state.transitionUiIds.add(transitionId);
    if (!wasLoading) bus.emit('pro-playback:transition-loading', true);
  }

  function replacePlaybackTransitionUi(previousTransitionId: string, transitionId: string): void {
    const wasLoading = state.transitionUiIds.size > 0;
    state.transitionUiIds.delete(previousTransitionId);
    state.transitionUiIds.add(transitionId);
    if (!wasLoading) bus.emit('pro-playback:transition-loading', true);
  }

  function settlePlaybackTransitionUi(transitionId: string): void {
    if (!state.transitionUiIds.delete(transitionId)) return;
    if (state.transitionUiIds.size === 0) bus.emit('pro-playback:transition-loading', false);
  }

  function resetPlaybackTransitionUi(): void {
    if (state.transitionUiIds.size === 0) return;
    state.transitionUiIds.clear();
    bus.emit('pro-playback:transition-loading', false);
  }

  function trackLocalPlaybackUiControl(
    intent: Readonly<ProPlaybackUserIntent>,
    expectedPlaybackRevision: number,
  ): PendingLocalPlaybackUiControl | null {
    const token = intent.clientUiControlToken;
    if (!Number.isSafeInteger(token) || !token || token < 0) return null;
    const pending = {
      token,
      roomCode: intent.roomId,
      roomEpoch: intent.roomEpoch,
      expectedPlaybackRevision,
      admitted: false,
      transitionId: undefined,
    };
    state.pendingLocalUiControls.set(token, pending);
    return pending;
  }

  function settleLocalPlaybackUiControl(
    pending: PendingLocalPlaybackUiControl | null,
    status: 'applied' | 'failed' | 'superseded',
    positionSeconds?: number,
  ): void {
    if (!pending) return;
    state.pendingLocalUiControls.delete(pending.token);
    settleProPlaybackUiControl(pending.token, status, positionSeconds);
  }

  function settleLocalPlaybackUiControlsThrough(
    roomCode: string,
    roomEpoch: number,
    playbackRevision: number,
    positionSeconds?: number,
  ): void {
    for (const pending of state.pendingLocalUiControls.values()) {
      if (pending.roomCode !== roomCode || pending.roomEpoch !== roomEpoch) continue;
      if (!pending.admitted) continue;
      if (pending.expectedPlaybackRevision > playbackRevision) continue;
      settleLocalPlaybackUiControl(
        pending,
        pending.expectedPlaybackRevision === playbackRevision ? 'applied' : 'superseded',
        positionSeconds,
      );
    }
  }

  function settleLocalPlaybackUiControlByTransition(
    transitionId: string,
    status: 'failed' | 'superseded',
  ): void {
    for (const pending of state.pendingLocalUiControls.values()) {
      if (pending.admitted && pending.transitionId === transitionId) {
        settleLocalPlaybackUiControl(pending, status);
      }
    }
  }

  function bindAdmittedLocalPlaybackUiControl(
    pending: PendingLocalPlaybackUiControl | null,
    expectedPlaybackRevision: number,
    transitionId: string | null,
  ): void {
    if (!pending) return;
    pending.expectedPlaybackRevision = expectedPlaybackRevision;
    pending.transitionId = transitionId;
    pending.admitted = true;
    refreshProPlaybackUiControlTimeout(pending.token);
    const checkpoint = state.lastAppliedUiCheckpoint;
    if (
      checkpoint &&
      checkpoint.roomCode === pending.roomCode &&
      checkpoint.roomEpoch === pending.roomEpoch &&
      checkpoint.revision >= pending.expectedPlaybackRevision
    ) {
      settleLocalPlaybackUiControl(
        pending,
        checkpoint.revision === pending.expectedPlaybackRevision ? 'applied' : 'superseded',
        checkpoint.positionSeconds,
      );
    }
  }

  function failLocalPlaybackUiControlsForRevision(
    roomCode: string,
    roomEpoch: number,
    playbackRevision: number,
  ): void {
    for (const pending of state.pendingLocalUiControls.values()) {
      if (
        pending.roomCode === roomCode &&
        pending.roomEpoch === roomEpoch &&
        pending.admitted &&
        pending.expectedPlaybackRevision === playbackRevision
      ) {
        settleLocalPlaybackUiControl(pending, 'failed');
      }
    }
  }

  function clearLocalPlaybackUiControls(): void {
    for (const pending of state.pendingLocalUiControls.values()) {
      settleLocalPlaybackUiControl(pending, 'failed');
    }
    state.pendingLocalUiControls.clear();
    state.cancelledTransitionIds.clear();
    state.lastAppliedUiCheckpoint = null;
  }

  function rememberCancelledPlaybackTransition(transitionId: string): void {
    state.cancelledTransitionIds.add(transitionId);
    while (state.cancelledTransitionIds.size > MAX_CANCELLED_PLAYBACK_TRANSITION_IDS) {
      const oldest = state.cancelledTransitionIds.values().next().value as string | undefined;
      if (!oldest) break;
      state.cancelledTransitionIds.delete(oldest);
    }
  }

  function createRoomLinkedAbortController(parent?: AbortSignal): {
    controller: AbortController;
    detach: () => void;
  } {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (parent?.aborted) controller.abort();
    else parent?.addEventListener('abort', abort, { once: true });
    return {
      controller,
      detach: () => parent?.removeEventListener('abort', abort),
    };
  }

  async function executePlaybackCommandWithRecovery(
    input: Parameters<ProRoomApiClient['executePlaybackCommand']>[0],
  ): Promise<ProRoomPlaybackCommandResult> {
    const roomSignal = ports.getRoomAbortSignal();
    let lastError: unknown = new ProRoomApiError('NETWORK_ERROR');

    // Playback commands already carry an idempotency key. One bounded replay
    // recovers the important "server committed, response was lost" case without
    // ever applying the command twice or leaving the serialized control queue
    // behind a fetch that can remain pending forever.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const linked = createRoomLinkedAbortController(roomSignal);
      const timeoutTimer = `pro-playback-command-request-timeout-${++state.commandRequestSequence}`;
      let timedOut = false;
      setManagedTimer(
        timeoutTimer,
        () => {
          timedOut = true;
          linked.controller.abort();
        },
        PLAYBACK_COMMAND_REQUEST_TIMEOUT_MS,
      );
      try {
        return await ports.executePlaybackCommand(input, linked.controller.signal);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof ProRoomApiError &&
          (error.code === 'NETWORK_ERROR' || (error.code === 'ABORTED' && timedOut));
        if (!retryable || attempt > 0 || roomSignal?.aborted) throw error;
      } finally {
        clearManagedTimer(timeoutTimer);
        linked.detach();
      }
    }

    throw lastError;
  }

  function serverNowForFrame(serverTimeMs: number, receivedAtMs: number): number {
    return isProRoomServerClockCalibrated()
      ? getProRoomServerNow()
      : serverTimeMs + Math.max(0, Date.now() - receivedAtMs);
  }

  function playbackAuthorityFor(
    roomCode: string,
    roomEpoch: number,
    playbackRevision: number,
    transitionId: string | null,
  ): ProPlaybackAuthorityToken {
    return createProPlaybackAuthorityToken({
      roomId: roomCode,
      roomEpoch,
      basePlaybackRevision: Math.max(0, playbackRevision - 1),
      transitionId,
    });
  }

  function playbackPrepareRequest(
    authority: ProPlaybackAuthorityToken,
    playback: ProRoomPlaybackCheckpoint,
  ) {
    if (!playback.queueItemId) return null;
    return {
      authority,
      queueItemId: playback.queueItemId,
      positionSeconds: playback.positionSeconds,
      state: playback.state === 'paused' ? ('paused' as const) : ('playing' as const),
      youtubeSubIndex: playback.youtubeSubIndex,
      youtubeVideoId: playback.youtubeVideoId,
    } as const;
  }

  function sameServerTransition(
    activeTransition: typeof state.activeTransition,
    event: ProRoomPlaybackPrepareEvent,
  ): boolean {
    return !!(
      activeTransition &&
      activeTransition.event.transitionId === event.transitionId &&
      activeTransition.event.basePlaybackRevision === event.basePlaybackRevision
    );
  }

  function reportPlaybackPreparation(transition: NonNullable<typeof state.activeTransition>): void {
    if (transition.readyReportStarted) return;
    transition.readyReportStarted = true;
    void transition.preparation
      .then(async (result) => {
        if (state.activeTransition !== transition) return;
        let status: 'ready' | 'failed' = 'failed';
        if (result.status === 'ready') {
          const elapsedSinceReceiptMs = Math.max(0, Date.now() - transition.receivedAtMs);
          const fallbackTimeoutMs = Math.max(
            0,
            transition.event.deadlineAtMs - transition.event.serverTimeMs - elapsedSinceReceiptMs,
          );
          const calibrated = await waitForFreshProRoomServerClockCalibration({
            serverDeadlineAtMs: transition.event.deadlineAtMs,
            fallbackTimeoutMs,
            signal: transition.clockAbort.signal,
          });
          if (state.activeTransition !== transition) return;
          if (calibrated) status = 'ready';
        }
        try {
          const outcome = await ports.reportPlaybackTransitionReady({
            code: transition.authority.roomId,
            transitionId: transition.event.transitionId,
            basePlaybackRevision: transition.event.basePlaybackRevision,
            status,
          });
          // A lost WebSocket COMMIT is recovered from the canonical snapshot.
          if (outcome === 'committed') void ports.runHeartbeat(true);
        } catch (error) {
          if (
            error instanceof ProRoomApiError &&
            (error.code === 'PLAYBACK_TRANSITION_NOT_FOUND' ||
              error.code === 'PLAYBACK_TRANSITION_STALE' ||
              error.code === 'PLAYBACK_TRANSITION_NOT_IN_COHORT')
          ) {
            return;
          }
          log.warn('[PRO Playback] Could not report participant readiness', error);
        }
      })
      .catch((error) => {
        log.warn('[PRO Playback] Participant preparation failed unexpectedly', error);
      });
  }

  function hasProjectedQueueItem(queueItemId: QueueItemId): boolean {
    return getState('playlist.items').some((item) => item.queueItemId === queueItemId);
  }

  function supersededPlaybackPreparation(
    request: NonNullable<ReturnType<typeof playbackPrepareRequest>>,
  ): ProPlaybackPrepareResult {
    return {
      status: 'superseded',
      authority: request.authority,
      queueItemId: request.queueItemId,
      reason: 'superseded',
    };
  }

  async function preparePlaybackAfterPlaylistHydration(
    request: NonNullable<ReturnType<typeof playbackPrepareRequest>>,
    event: ProRoomPlaybackPrepareEvent,
    receivedAtMs: number,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): Promise<ProPlaybackPrepareResult> {
    const prepareWithRemainingBudget = () =>
      prepareProPlaybackAuthority({
        ...request,
        prepareBudgetMs: Math.max(
          0,
          event.deadlineAtMs - serverNowForFrame(event.serverTimeMs, receivedAtMs),
        ),
      });
    if (hasProjectedQueueItem(request.queueItemId)) {
      return prepareWithRemainingBudget();
    }

    // BOT/developer add+play can legitimately deliver PREPARE before the
    // invalidation heartbeat has projected the newly-created queue row. Request
    // one authoritative follow-up and resume as soon as playlist projection is
    // complete; effects, queue-mode, and system-audio refreshes deliberately stay
    // outside this media-critical wait.
    const remainingWindowMs = Math.max(
      0,
      event.deadlineAtMs - serverNowForFrame(event.serverTimeMs, receivedAtMs),
    );
    const hydrationWaitMs = Math.max(
      0,
      Math.min(
        PLAYLIST_HYDRATION_MAX_WAIT_MS,
        remainingWindowMs - PLAYLIST_HYDRATION_PREPARE_RESERVE_MS,
      ),
    );

    if (hydrationWaitMs > 0 && !signal.aborted) {
      await new Promise<void>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let unsubscribeProjection: (() => void) | null = null;
        const settle = () => {
          if (settled) return;
          settled = true;
          unsubscribeProjection?.();
          signal.removeEventListener('abort', settle);
          if (timer !== null) clearTimeout(timer);
          resolve();
        };
        const onProjection = () => {
          if (hasProjectedQueueItem(request.queueItemId)) settle();
        };
        unsubscribeProjection = ports.subscribePlaylistProjection(onProjection);
        signal.addEventListener('abort', settle, { once: true });
        timer = globalThis.setTimeout(settle, hydrationWaitMs);

        // Close the registration race before starting/joining the heartbeat. A
        // forced follow-up guarantees that an older in-flight snapshot cannot be
        // the final reconciliation attempt.
        onProjection();
        if (!settled) {
          void ports.runHeartbeat(true, true).then(settle, (error) => {
            log.warn('[PRO Playback] Playlist hydration failed', error);
            settle();
          });
        }
      });
    }
    if (!isCurrent()) return supersededPlaybackPreparation(request);

    // If the canonical row is still absent, use the ordinary media endpoint so
    // it reports one bounded missing-track failure through the existing READY
    // protocol. Never spin or extend the server's three-second rendezvous gate.
    return prepareWithRemainingBudget();
  }

  function acceptPlaybackPrepare(
    event: ProRoomPlaybackPrepareEvent,
    receivedAtMs = Date.now(),
  ): void {
    if (state.cancelledTransitionIds.has(event.transitionId)) {
      settleLocalPlaybackUiControlByTransition(event.transitionId, 'superseded');
      return;
    }
    const context = getState('room.context');
    if (
      !ports.isActive() ||
      context.kind !== 'pro' ||
      !context.roomId ||
      event.target.coordinatorEpoch !== context.epoch ||
      event.target.revision !== event.basePlaybackRevision + 1 ||
      event.target.state === 'idle' ||
      !event.target.queueItemId ||
      event.basePlaybackRevision < state.highestKnownRevision
    ) {
      return;
    }
    if (sameServerTransition(state.activeTransition, event)) return;

    const replacedTransitionId = state.activeTransition?.event.transitionId ?? null;
    if (state.activeTransition) {
      settleLocalPlaybackUiControlByTransition(
        state.activeTransition.event.transitionId,
        'superseded',
      );
      state.activeTransition.clockAbort.abort();
      cancelProPlaybackPreparation(state.activeTransition.authority);
    }
    const authority = createProPlaybackAuthorityToken({
      roomId: context.roomId,
      roomEpoch: context.epoch,
      basePlaybackRevision: event.basePlaybackRevision,
      transitionId: event.transitionId,
    });
    const request = playbackPrepareRequest(authority, event.target);
    if (!request) return;
    const clockAbort = new AbortController();
    const preparation = preparePlaybackAfterPlaylistHydration(
      request,
      event,
      receivedAtMs,
      clockAbort.signal,
      () => state.activeTransition?.authority === authority && !clockAbort.signal.aborted,
    );
    const transition: ActiveServerPlaybackTransition = {
      event,
      authority,
      preparation,
      readyReportStarted: false,
      receivedAtMs,
      clockAbort,
    };
    state.activeTransition = transition;
    if (replacedTransitionId) {
      // PREPARE B atomically owns the visible rendezvous state as soon as it
      // supersedes PREPARE A. A lost CANCEL for A must not leave an unreachable
      // transition ID keeping the shared spinner alive forever.
      replacePlaybackTransitionUi(replacedTransitionId, event.transitionId);
    } else {
      beginPlaybackTransitionUi(event.transitionId);
    }
    reportPlaybackPreparation(transition);
  }

  function acceptPlaybackCancel(transitionId: string): void {
    rememberCancelledPlaybackTransition(transitionId);
    settlePlaybackTransitionUi(transitionId);
    settleLocalPlaybackUiControlByTransition(transitionId, 'superseded');
    const transition = state.activeTransition;
    if (!transition || transition.event.transitionId !== transitionId) return;
    transition.clockAbort.abort();
    cancelProPlaybackPreparation(transition.authority);
    state.activeTransition = null;
  }

  function playbackCommitStillCurrent(
    event: ProRoomPlaybackCommitEvent,
    generation: number,
    isRequestCurrent: () => boolean = canonicalPlaybackCommitOwner,
  ): boolean {
    const context = getState('room.context');
    return !!(
      isRequestCurrent() &&
      ports.isActive() &&
      generation === state.commitGeneration &&
      context.kind === 'pro' &&
      !!context.roomId &&
      context.epoch === event.playback.coordinatorEpoch &&
      event.playback.revision > state.lastAppliedRevision &&
      event.playback.revision >= state.highestKnownRevision
    );
  }

  const PRO_PLAYBACK_ZERO_START_WIRE_LEAD_MS = 699;

  function playbackCommitTiming(
    event: ProRoomPlaybackCommitEvent,
    receivedAtMs: number,
  ): {
    positionSeconds: number;
    scheduleDelayMs: number;
    timingMode: ProPlaybackTimingMode;
  } {
    const nowMs = serverNowForFrame(event.serverTimeMs, receivedAtMs);
    // Wire-compatible rollout marker: old clients treat 699ms as an ordinary
    // future COMMIT instant. Refreshed clients grant platform lead only to this
    // explicit marker; legacy, direct, and malformed timings fail safely as
    // running-timeline controls.
    const zeroStart =
      event.transitionId !== null &&
      event.executeAtMs - event.serverTimeMs === PRO_PLAYBACK_ZERO_START_WIRE_LEAD_MS;
    return {
      scheduleDelayMs: Math.max(0, event.executeAtMs - nowMs),
      timingMode: zeroStart ? 'zero-start' : 'scheduled-control',
      positionSeconds:
        event.playback.state === 'playing'
          ? event.playback.positionSeconds + Math.max(0, nowMs - event.executeAtMs) / 1_000
          : event.playback.positionSeconds,
    };
  }

  function recordAppliedPlaybackCheckpoint(playback: ProRoomPlaybackCheckpoint): void {
    bus.emit('sync:diagnostic-pro-checkpoint', {
      trackKey: playback.queueItemId,
      state: playback.state,
      positionSeconds: playback.positionSeconds,
      updatedAtMs: playback.updatedAtMs,
      revision: playback.revision,
    });
  }

  function clearServerPlaybackTransition(
    transition: NonNullable<typeof state.activeTransition>,
  ): void {
    transition.clockAbort.abort();
    cancelProPlaybackPreparation(transition.authority);
    if (state.activeTransition === transition) state.activeTransition = null;
  }

  async function catchUpExactPlaybackCheckpoint(
    event: ProRoomPlaybackCommitEvent,
    receivedAtMs: number,
    generation: number,
    roomCode: string,
    roomEpoch: number,
    isRequestCurrent: () => boolean,
  ) {
    const playback = event.playback;
    if (playback.state === 'idle' || !playback.queueItemId) return null;
    const authority = playbackAuthorityFor(
      roomCode,
      roomEpoch,
      playback.revision,
      `snapshot_${playback.revision}`,
    );
    const request = playbackPrepareRequest(authority, playback);
    if (!request) return null;
    let prepared: ProPlaybackPrepareResult;
    try {
      prepared = await prepareProPlaybackAuthority({
        ...request,
        isCurrent: () => playbackCommitStillCurrent(event, generation, isRequestCurrent),
      });
    } catch (error) {
      cancelProPlaybackPreparation(authority);
      throw error;
    }
    if (!playbackCommitStillCurrent(event, generation, isRequestCurrent)) {
      cancelProPlaybackPreparation(authority);
      return null;
    }
    if (prepared.status !== 'ready') {
      cancelProPlaybackPreparation(authority);
      return null;
    }
    const timing = playbackCommitTiming(event, receivedAtMs);
    try {
      const result = await commitProPlaybackAuthority({
        authority,
        committedPlaybackRevision: playback.revision,
        queueItemId: playback.queueItemId,
        state: playback.state,
        positionSeconds: timing.positionSeconds,
        scheduleDelayMs: timing.scheduleDelayMs,
        // Catch-up is already following a committed running checkpoint; applying
        // the one-time zero-start lead here would move a late endpoint ahead.
        timingMode: 'scheduled-control',
        youtubeSubIndex: playback.youtubeSubIndex,
        youtubeVideoId: playback.youtubeVideoId,
        isCurrent: () => playbackCommitStillCurrent(event, generation, isRequestCurrent),
      });
      if (
        result.status !== 'applied' ||
        !playbackCommitStillCurrent(event, generation, isRequestCurrent)
      ) {
        cancelProPlaybackPreparation(authority);
      }
      return result;
    } catch (error) {
      cancelProPlaybackPreparation(authority);
      throw error;
    }
  }

  async function silenceUnappliedCanonicalRenderer(
    event: ProRoomPlaybackCommitEvent,
    receivedAtMs: number,
    generation: number,
    authority: ProPlaybackAuthorityToken,
    isRequestCurrent: () => boolean,
  ): Promise<void> {
    const timing = playbackCommitTiming(event, receivedAtMs);
    await invalidateCommittedProPlaybackMedia({
      authority,
      committedPlaybackRevision: event.playback.revision,
      queueItemId: event.playback.queueItemId,
      state: event.playback.state,
      positionSeconds: timing.positionSeconds,
      scheduleDelayMs: timing.scheduleDelayMs,
      timingMode: timing.timingMode,
      youtubeSubIndex: event.playback.youtubeSubIndex,
      youtubeVideoId: event.playback.youtubeVideoId,
      isCurrent: () => playbackCommitStillCurrent(event, generation, isRequestCurrent),
    });
  }

  async function applyPlaybackCommit(
    event: ProRoomPlaybackCommitEvent,
    receivedAtMs: number,
    generation: number,
    isRequestCurrent: () => boolean,
  ): Promise<void> {
    const context = getState('room.context');
    const playback = event.playback;
    if (
      !ports.isActive() ||
      context.kind !== 'pro' ||
      !context.roomId ||
      playback.coordinatorEpoch !== context.epoch ||
      playback.revision <= state.lastAppliedRevision ||
      playback.revision < state.highestKnownRevision
    ) {
      return;
    }
    if (!playbackCommitStillCurrent(event, generation, isRequestCurrent)) return;

    state.highestKnownRevision = Math.max(state.highestKnownRevision, playback.revision);
    let authority: ProPlaybackAuthorityToken;
    let preparation: ReturnType<typeof prepareProPlaybackAuthority> | null = null;
    let preparedFromMatchingTransition = false;
    let activeTransition = state.activeTransition;
    const matchesActiveTransition = !!(
      event.transitionId !== null &&
      activeTransition?.event.transitionId === event.transitionId &&
      activeTransition.event.target.revision === playback.revision
    );
    // A canonical direct/snapshot COMMIT can overtake a still-hydrating PREPARE.
    // Once that checkpoint is at least as new, the old transition must not keep
    // reporting READY or occupy the active slot after its authority is obsolete.
    if (
      activeTransition &&
      !matchesActiveTransition &&
      activeTransition.event.target.revision <= playback.revision
    ) {
      clearServerPlaybackTransition(activeTransition);
      activeTransition = null;
    }
    if (matchesActiveTransition && activeTransition) {
      authority = activeTransition.authority;
      preparation = activeTransition.preparation;
      preparedFromMatchingTransition = true;
    } else if (event.transitionId !== null && playback.queueItemId) {
      if (activeTransition) cancelProPlaybackPreparation(activeTransition.authority);
      authority = playbackAuthorityFor(
        context.roomId,
        context.epoch,
        playback.revision,
        event.transitionId,
      );
      const request = playbackPrepareRequest(authority, playback);
      preparation = request
        ? prepareProPlaybackAuthority({
            ...request,
            isCurrent: () => playbackCommitStillCurrent(event, generation, isRequestCurrent),
          })
        : null;
    } else {
      authority = playbackAuthorityFor(context.roomId, context.epoch, playback.revision, null);
    }

    if (preparation) {
      let prepared: ProPlaybackPrepareResult;
      try {
        prepared = await preparation;
      } catch (error) {
        cancelProPlaybackPreparation(authority);
        throw error;
      }
      if (!playbackCommitStillCurrent(event, generation, isRequestCurrent)) {
        cancelProPlaybackPreparation(authority);
        return;
      }
      if (prepared.status !== 'ready') {
        if (activeTransition) clearServerPlaybackTransition(activeTransition);
        const catchup = await catchUpExactPlaybackCheckpoint(
          event,
          receivedAtMs,
          generation,
          context.roomId,
          context.epoch,
          isRequestCurrent,
        );
        if (!playbackCommitStillCurrent(event, generation, isRequestCurrent)) return;
        if (catchup?.status !== 'applied') {
          await silenceUnappliedCanonicalRenderer(
            event,
            receivedAtMs,
            generation,
            authority,
            isRequestCurrent,
          );
          if (!playbackCommitStillCurrent(event, generation, isRequestCurrent)) return;
          failLocalPlaybackUiControlsForRevision(context.roomId, context.epoch, playback.revision);
          return;
        }
        state.lastAppliedRevision = playback.revision;
        state.lastAppliedUiCheckpoint = {
          roomCode: context.roomId,
          roomEpoch: context.epoch,
          revision: playback.revision,
          positionSeconds: playback.positionSeconds,
        };
        recordAppliedPlaybackCheckpoint(playback);
        settleLocalPlaybackUiControlsThrough(
          context.roomId,
          context.epoch,
          playback.revision,
          playback.positionSeconds,
        );
        void ports.runHeartbeat(true);
        return;
      }
    }

    if (!playbackCommitStillCurrent(event, generation, isRequestCurrent)) return;
    const timing = playbackCommitTiming(event, receivedAtMs);
    let result: ProPlaybackCommitResult;
    try {
      result = await commitProPlaybackAuthority({
        authority,
        committedPlaybackRevision: playback.revision,
        queueItemId: playback.queueItemId,
        state: playback.state,
        positionSeconds: timing.positionSeconds,
        scheduleDelayMs: timing.scheduleDelayMs,
        timingMode: preparedFromMatchingTransition ? timing.timingMode : 'scheduled-control',
        youtubeSubIndex: playback.youtubeSubIndex,
        youtubeVideoId: playback.youtubeVideoId,
        isCurrent: () => playbackCommitStillCurrent(event, generation, isRequestCurrent),
      });
    } catch (error) {
      cancelProPlaybackPreparation(authority);
      throw error;
    }
    if (!playbackCommitStillCurrent(event, generation, isRequestCurrent)) {
      cancelProPlaybackPreparation(authority);
      return;
    }

    // A direct pause/seek or a canonical transition whose resident media was
    // superseded can reach a freshly resumed endpoint before hydration. Clear
    // the failed transition and catch up from the exact committed checkpoint
    // immediately rather than waiting for the next heartbeat.
    if (result.status !== 'applied' && playback.state !== 'idle' && playback.queueItemId) {
      if (activeTransition) clearServerPlaybackTransition(activeTransition);
      result =
        (await catchUpExactPlaybackCheckpoint(
          event,
          receivedAtMs,
          generation,
          context.roomId,
          context.epoch,
          isRequestCurrent,
        )) ?? result;
    }

    if (!playbackCommitStillCurrent(event, generation, isRequestCurrent)) return;
    if (result.status !== 'applied') {
      await silenceUnappliedCanonicalRenderer(
        event,
        receivedAtMs,
        generation,
        authority,
        isRequestCurrent,
      );
      if (!playbackCommitStillCurrent(event, generation, isRequestCurrent)) return;
      failLocalPlaybackUiControlsForRevision(context.roomId, context.epoch, playback.revision);
      return;
    }
    state.lastAppliedRevision = playback.revision;
    state.lastAppliedUiCheckpoint = {
      roomCode: context.roomId,
      roomEpoch: context.epoch,
      revision: playback.revision,
      positionSeconds: playback.positionSeconds,
    };
    recordAppliedPlaybackCheckpoint(playback);
    settleLocalPlaybackUiControlsThrough(
      context.roomId,
      context.epoch,
      playback.revision,
      playback.positionSeconds,
    );
    if (
      state.activeTransition?.event.transitionId === event.transitionId ||
      state.activeTransition?.authority === authority
    ) {
      state.activeTransition.clockAbort.abort();
      state.activeTransition = null;
    }
    void ports.runHeartbeat(true);
  }

  function acceptPlaybackCommit(
    event: ProRoomPlaybackCommitEvent,
    isRequestCurrent: PlaybackCommitOwner = canonicalPlaybackCommitOwner,
  ): void {
    if (!isRequestCurrent()) return;
    if (event.playback.revision <= state.lastAppliedRevision) return;
    // A lower revision can arrive after a newer WebSocket frame when a heartbeat
    // snapshot and the live channel cross. Reject it before advancing the local
    // generation; otherwise it would cancel the newer COMMIT and then reject
    // itself against state.highestKnownRevision.
    if (event.playback.revision < state.highestKnownRevision) return;
    const existing = state.commitInFlight.get(event.playback.revision);
    if (existing) {
      if (existing.owner === isRequestCurrent || existing.owner === canonicalPlaybackCommitOwner) {
        return;
      }
      const pending = state.commitFollowUps.get(event.playback.revision);
      if (
        !pending ||
        (isRequestCurrent === canonicalPlaybackCommitOwner &&
          pending.owner !== canonicalPlaybackCommitOwner)
      ) {
        state.commitFollowUps.set(event.playback.revision, {
          event,
          owner: isRequestCurrent,
        });
      }
      return;
    }
    const receivedAtMs = Date.now();
    const pendingUiTransitionId =
      state.activeTransition &&
      state.activeTransition.event.target.revision <= event.playback.revision
        ? state.activeTransition.event.transitionId
        : event.transitionId;
    state.highestKnownRevision = Math.max(state.highestKnownRevision, event.playback.revision);
    const generation = ++state.commitGeneration;
    const operation = state.commitTail
      .then(
        () => applyPlaybackCommit(event, receivedAtMs, generation, isRequestCurrent),
        () => applyPlaybackCommit(event, receivedAtMs, generation, isRequestCurrent),
      )
      .finally(() => {
        if (event.transitionId) settlePlaybackTransitionUi(event.transitionId);
        if (pendingUiTransitionId && pendingUiTransitionId !== event.transitionId) {
          settlePlaybackTransitionUi(pendingUiTransitionId);
        }
        if (state.commitInFlight.get(event.playback.revision)?.promise === operation) {
          state.commitInFlight.delete(event.playback.revision);
        }
        const followUp = state.commitFollowUps.get(event.playback.revision);
        if (followUp) state.commitFollowUps.delete(event.playback.revision);
        if (
          followUp &&
          followUp.owner() &&
          followUp.event.playback.revision > state.lastAppliedRevision
        ) {
          // Consume before starting the retry. A permanent endpoint failure gets
          // one exact follower, never a self-replenishing retry loop.
          acceptPlaybackCommit(followUp.event, followUp.owner);
        }
      });
    state.commitTail = operation.catch(() => undefined);
    state.commitInFlight.set(event.playback.revision, {
      promise: operation,
      owner: isRequestCurrent,
    });
    void operation.catch((error) => {
      log.warn('[PRO Playback] Canonical COMMIT could not be applied', error);
    });
  }

  function commandForPlaybackIntent(
    intent: Readonly<ProPlaybackUserIntent>,
    baseRevision: number,
  ): ProRoomPlaybackCommand {
    if (
      intent.kind === 'play' ||
      intent.kind === 'pause' ||
      intent.kind === 'stop' ||
      intent.kind === 'next' ||
      intent.kind === 'previous'
    ) {
      return { type: intent.kind, baseRevision };
    }
    if (intent.kind === 'advance-sub-video') {
      // The server already owns manifest traversal for `next`. The distinct
      // client intent exists only to preserve the exact observation revision;
      // it deliberately does not add another public Worker command shape.
      return { type: 'next', baseRevision };
    }
    if (intent.kind === 'seek') {
      return { type: 'seek', baseRevision, positionSeconds: intent.positionSeconds };
    }
    if (intent.kind === 'select') {
      const youtubeIdentity = {
        ...(intent.youtubeSubIndex === null ? {} : { youtubeSubIndex: intent.youtubeSubIndex }),
        ...(intent.youtubeVideoId ? { youtubeVideoId: intent.youtubeVideoId } : {}),
      };
      return {
        type: 'select',
        baseRevision,
        queueItemId: intent.queueItemId,
        state: 'playing',
        positionSeconds: intent.positionSeconds,
        ...youtubeIdentity,
      };
    }
    if (intent.kind === 'ended' || intent.kind === 'unavailable') {
      const youtubeIdentity = {
        ...(intent.youtubeSubIndex === null || intent.youtubeSubIndex === undefined
          ? {}
          : { youtubeSubIndex: intent.youtubeSubIndex }),
        ...(intent.youtubeVideoId ? { youtubeVideoId: intent.youtubeVideoId } : {}),
      };
      return {
        type: intent.kind,
        baseRevision,
        queueItemId: intent.queueItemId,
        mediaKind: intent.mediaKind,
        observedPositionSeconds: intent.observedPositionSeconds,
        durationSeconds: intent.durationSeconds,
        ...youtubeIdentity,
      };
    }
    throw new Error('PRO_PLAYBACK_INTENT_UNSUPPORTED');
  }

  async function submitPlaybackIntent(
    intent: Readonly<ProPlaybackUserIntent>,
    exactBasePlaybackRevision?: number,
  ): Promise<void> {
    const context = getState('room.context');
    const snapshot = ports.getCanonicalSnapshot();
    if (
      !ports.isActive() ||
      context.kind !== 'pro' ||
      !context.roomId ||
      context.roomId !== intent.roomId ||
      context.epoch !== intent.roomEpoch ||
      snapshot?.roomCode !== intent.roomId
    ) {
      if (intent.clientUiControlToken) {
        settleProPlaybackUiControl(intent.clientUiControlToken, 'failed');
      }
      return;
    }
    if (
      intent.clientUiControlToken &&
      !refreshProPlaybackUiControlTimeout(intent.clientUiControlToken)
    ) {
      return;
    }
    const exactRevisionIsCurrent =
      exactBasePlaybackRevision === undefined ||
      (state.highestKnownRevision <= exactBasePlaybackRevision &&
        (intent.kind === 'advance-sub-video'
          ? // COMMIT application precedes the heartbeat that refreshes the
            // playlist snapshot. The local media revision is therefore the
            // exact fence for iframe observations during that short window.
            state.lastAppliedRevision === exactBasePlaybackRevision
          : snapshot.playback.revision === exactBasePlaybackRevision));
    if (!exactRevisionIsCurrent) {
      // Revision-fenced automatic work is intentionally weaker than a human
      // command. Never rebase a delayed media observation over another
      // participant's selection/command.
      await ports.runHeartbeat(true);
      return;
    }
    const baseRevision =
      exactBasePlaybackRevision ?? Math.max(state.highestKnownRevision, snapshot.playback.revision);
    const localUiControl = trackLocalPlaybackUiControl(intent, baseRevision + 1);
    const commandGeneration = state.commandGeneration;
    const commandIsCurrent = (): boolean => {
      const currentContext = getState('room.context');
      const currentSnapshot = ports.getCanonicalSnapshot();
      return (
        commandGeneration === state.commandGeneration &&
        ports.isActive() &&
        currentContext.kind === 'pro' &&
        currentContext.roomId === intent.roomId &&
        currentContext.epoch === intent.roomEpoch &&
        currentSnapshot?.roomCode === intent.roomId &&
        currentSnapshot.presence.coordinatorEpoch === intent.roomEpoch
      );
    };
    try {
      const result = await executePlaybackCommandWithRecovery({
        code: intent.roomId,
        command: commandForPlaybackIntent(intent, baseRevision),
        idempotencyKey: createProRoomIdempotencyKey(),
      });
      if (!commandIsCurrent()) return;
      state.highestKnownRevision = Math.max(state.highestKnownRevision, result.playback.revision);
      if (result.status === 'preparing' && result.transition) {
        bindAdmittedLocalPlaybackUiControl(
          localUiControl,
          result.transition.target.revision,
          result.transition.transitionId,
        );
        acceptPlaybackPrepare(result.transition);
      } else if (result.status === 'committed') {
        bindAdmittedLocalPlaybackUiControl(localUiControl, result.playback.revision, null);
        acceptPlaybackCommit({
          type: 'pro-playback-commit',
          transitionId: null,
          serverTimeMs: result.serverTimeMs,
          executeAtMs: result.playback.updatedAtMs,
          playback: result.playback,
        });
      } else if (result.status === 'unchanged') {
        if (result.playback.revision > state.lastAppliedRevision) {
          void restorePlaybackCheckpoint(result.playback, intent.roomId, intent.roomEpoch);
          settleLocalPlaybackUiControl(localUiControl, 'applied', result.playback.positionSeconds);
        } else if (intent.kind === 'play' && result.playback.state === 'playing') {
          // The room can already be playing while a foregrounded WebKit iframe
          // is locally frozen. `unchanged` is correct server semantics, but the
          // initiating participant still needs the exact checkpoint re-applied.
          const reconciled = await reapplyCurrentPlaybackCheckpoint(
            result.playback,
            intent.roomId,
            intent.roomEpoch,
            result.serverTimeMs,
            false,
          );
          if (!commandIsCurrent()) return;
          settleLocalPlaybackUiControl(
            localUiControl,
            reconciled ? 'applied' : 'failed',
            result.playback.positionSeconds,
          );
        } else {
          settleLocalPlaybackUiControl(localUiControl, 'applied', result.playback.positionSeconds);
        }
      }
    } catch (error) {
      if (!commandIsCurrent()) return;
      if (
        error instanceof ProRoomApiError &&
        (error.code === 'PLAYBACK_REVISION_CONFLICT' ||
          error.code === 'PLAYBACK_OBSERVATION_STALE' ||
          error.code === 'PLAYBACK_TRANSITION_PENDING')
      ) {
        await ports.runHeartbeat(true);
        if (!commandIsCurrent()) return;
        settleLocalPlaybackUiControl(localUiControl, 'superseded');
        return;
      }
      if (isTerminalSessionError(error)) {
        settleLocalPlaybackUiControl(localUiControl, 'failed');
        await ports.recoverTerminalSession(error);
        return;
      }
      log.warn('[PRO Playback] Server command failed', error);
      // Both attempts used the same idempotency key, so a lost first response was
      // already recovered without executing twice. Reconcile any canonical room
      // movement before releasing the participant-local projection.
      await ports.runHeartbeat(true);
      if (!commandIsCurrent()) return;
      settleLocalPlaybackUiControl(localUiControl, 'failed');
    }
  }

  function enqueueFirstAppendSelection(
    request: Readonly<ProRoomFirstAppendSelectionRequest>,
    lease: ProRoomPlaybackPlaylistLease,
    signal?: AbortSignal,
  ): Promise<void> {
    const commandGeneration = state.commandGeneration;
    const submit = async () => {
      if (commandGeneration !== state.commandGeneration) return;
      const context = getState('room.context');
      const snapshot = ports.getPlaylistSnapshot();
      const item = snapshot?.playlist.find(
        (candidate) => candidate.queueItemId === request.queueItemId,
      );
      if (
        signal?.aborted ||
        !ports.isActive() ||
        !ports.isPlaylistLeaseCurrent(lease) ||
        context.kind !== 'pro' ||
        context.roomId !== request.roomCode ||
        context.epoch !== request.coordinatorEpoch ||
        snapshot?.roomCode !== request.roomCode ||
        snapshot.playlist[0]?.queueItemId !== request.queueItemId ||
        snapshot.currentQueueItemId !== null ||
        snapshot.playback.state !== 'idle' ||
        snapshot.playback.queueItemId !== null ||
        snapshot.playback.revision !== request.basePlaybackRevision ||
        !item ||
        (item.source.kind === 'youtube'
          ? item.source.videoId !== request.youtubeVideoId ||
            (item.source.videoIds?.indexOf(item.source.videoId) ?? 0) !== request.youtubeSubIndex
          : request.youtubeVideoId !== null || request.youtubeSubIndex !== null)
      ) {
        return;
      }
      await submitPlaybackIntent(
        {
          kind: 'select',
          roomId: request.roomCode,
          roomEpoch: request.coordinatorEpoch,
          queueItemId: request.queueItemId,
          positionSeconds: 0,
          youtubeVideoId: request.youtubeVideoId,
          youtubeSubIndex: request.youtubeSubIndex,
        },
        request.basePlaybackRevision,
      );
    };
    // A preceding user command failure must not starve a newly committed first
    // row; the exact playback revision fence still prevents selection theft.
    const operation = state.commandTail.then(submit, submit);
    state.commandTail = operation.catch(() => undefined);
    return operation;
  }

  /** @internal Exact first-append command seam for coordinator-free regressions. */
  function requestFirstAppendSelection(
    request: Readonly<ProRoomFirstAppendSelectionRequest>,
    signal?: AbortSignal,
    suppliedLease?: ProRoomPlaybackPlaylistLease,
  ): Promise<void> {
    const lease = suppliedLease ?? ports.capturePlaylistLease();
    return lease ? enqueueFirstAppendSelection(request, lease, signal) : Promise.resolve();
  }

  function enqueuePlaybackIntent(intent: Readonly<ProPlaybackUserIntent>): Promise<void> {
    const exactBaseRevision =
      intent.kind === 'ended' ||
      intent.kind === 'unavailable' ||
      intent.kind === 'advance-sub-video'
        ? intent.observedPlaybackRevision
        : undefined;
    const commandGeneration = state.commandGeneration;
    const submit = () => {
      if (commandGeneration !== state.commandGeneration) {
        if (intent.clientUiControlToken) {
          settleProPlaybackUiControl(intent.clientUiControlToken, 'failed');
        }
        return Promise.resolve();
      }
      return submitPlaybackIntent(intent, exactBaseRevision);
    };
    const operation = state.commandTail.then(submit, submit);
    state.commandTail = operation.catch(() => undefined);
    return operation;
  }

  async function restorePlaybackCheckpoint(
    playback: ProRoomPlaybackCheckpoint,
    roomCode: string,
    roomEpoch: number,
    isRequestCurrent: () => boolean = canonicalPlaybackCommitOwner,
  ): Promise<void> {
    const context = getState('room.context');
    if (
      !isRequestCurrent() ||
      context.kind !== 'pro' ||
      context.roomId !== roomCode ||
      context.epoch !== roomEpoch ||
      playback.coordinatorEpoch !== roomEpoch ||
      playback.revision <= state.lastAppliedRevision ||
      playback.revision < state.highestKnownRevision
    ) {
      return;
    }
    if (playback.revision === 0) {
      if (playback.state === 'idle') state.lastAppliedRevision = 0;
      return;
    }
    const transition = state.activeTransition;
    if (
      !isRequestCurrent() ||
      (transition && transition.event.target.revision > playback.revision)
    ) {
      return;
    }
    acceptPlaybackCommit(
      {
        type: 'pro-playback-commit',
        transitionId:
          transition?.event.target.revision === playback.revision
            ? transition.event.transitionId
            : `snapshot_${playback.revision}`,
        serverTimeMs: getProRoomServerNow(),
        executeAtMs: playback.updatedAtMs,
        playback,
      },
      isRequestCurrent,
    );
  }

  async function restorePersistedPlayback(
    snapshot: ProRoomSnapshot,
    isRequestCurrent: () => boolean = canonicalPlaybackCommitOwner,
  ): Promise<void> {
    const lease = ports.capturePlaylistLease();
    if (
      !isRequestCurrent() ||
      !lease ||
      lease.roomCode !== snapshot.roomCode ||
      !ports.isPlaylistLeaseCurrent(lease)
    ) {
      return;
    }
    state.highestKnownRevision = Math.max(state.highestKnownRevision, snapshot.playback.revision);
    await restorePlaybackCheckpoint(
      snapshot.playback,
      snapshot.roomCode,
      snapshot.presence.coordinatorEpoch,
      isRequestCurrent,
    );
  }

  function playbackReconciliationStillCurrent(
    playback: ProRoomPlaybackCheckpoint,
    roomCode: string,
    roomEpoch: number,
    generation: number,
  ): boolean {
    const context = getState('room.context');
    return !!(
      ports.isActive() &&
      generation === state.commitGeneration &&
      context.kind === 'pro' &&
      context.roomId === roomCode &&
      context.epoch === roomEpoch &&
      playback.coordinatorEpoch === roomEpoch &&
      playback.revision === state.lastAppliedRevision &&
      playback.revision === state.highestKnownRevision &&
      !state.activeTransition &&
      !state.commitInFlight.has(playback.revision)
    );
  }

  /** Re-apply one exact server revision without manufacturing a new room event. */
  async function reapplyCurrentPlaybackCheckpoint(
    playback: ProRoomPlaybackCheckpoint,
    roomCode: string,
    roomEpoch: number,
    observedServerTimeMs: number,
    rendezvous: boolean,
    isRequestCurrent: () => boolean = canonicalPlaybackCommitOwner,
  ): Promise<boolean> {
    if (
      !isRequestCurrent() ||
      playback.revision <= 0 ||
      playback.state === 'idle' ||
      !playback.queueItemId ||
      playback.revision !== state.lastAppliedRevision ||
      playback.revision !== state.highestKnownRevision ||
      state.activeTransition ||
      state.commitInFlight.has(playback.revision)
    ) {
      return false;
    }

    const generation = state.commitGeneration;
    const runningRendezvous = rendezvous && playback.state === 'playing';
    const authority = createProPlaybackAuthorityToken({
      roomId: roomCode,
      roomEpoch,
      basePlaybackRevision: playback.revision - 1,
      // A running manual sync uses a participant-local arm/release cycle. The
      // opaque ID never leaves this browser and cannot create a room revision.
      // Paused checkpoints remain exact direct re-applications.
      transitionId: runningRendezvous
        ? `local_sync_${playback.revision}_${++state.reconciliationSequence}`
        : null,
    });
    // `observedServerTimeMs` is either a timestamp carried by the command
    // response or a clock value read only after fresh calibration. Never mix an
    // uncalibrated local wall clock into this server-timeline calculation: a
    // manually skewed device clock could otherwise seek hours away.
    const serverNow = isProRoomServerClockCalibrated()
      ? getProRoomServerNow()
      : observedServerTimeMs;
    const canonicalPositionNow =
      playback.state === 'playing'
        ? playback.positionSeconds + Math.max(0, serverNow - playback.updatedAtMs) / 1_000
        : playback.positionSeconds;
    const isCurrent = () =>
      isRequestCurrent() &&
      playbackReconciliationStillCurrent(playback, roomCode, roomEpoch, generation);
    if (!isCurrent()) return false;

    if (runningRendezvous) {
      let prepared: ProPlaybackPrepareResult;
      try {
        prepared = await prepareCurrentProPlaybackRendezvousAuthority({
          authority,
          queueItemId: playback.queueItemId,
          positionSeconds: canonicalPositionNow,
          youtubeSubIndex: playback.youtubeSubIndex,
          youtubeVideoId: playback.youtubeVideoId,
          isCurrent,
        });
      } catch (error) {
        cancelProPlaybackPreparation(authority);
        throw error;
      }
      if (prepared.status !== 'ready' || !isCurrent()) {
        cancelProPlaybackPreparation(authority);
        return false;
      }

      // Preparation can take hundreds of milliseconds on an iframe. Rebase the
      // target after it is ready, then release at one future server instant so
      // this endpoint rejoins the running timeline rather than hard-seeking at
      // an arbitrary response-arrival time.
      const executeAtMs = getProRoomServerNow() + PLAYBACK_RECONCILIATION_RENDEZVOUS_LEAD_MS;
      const rendezvousPosition =
        playback.positionSeconds + Math.max(0, executeAtMs - playback.updatedAtMs) / 1_000;
      if (!isCurrent()) {
        cancelProPlaybackPreparation(authority);
        return false;
      }
      let result: ProPlaybackCommitResult;
      try {
        result = await rendezvousCurrentProPlaybackAuthority({
          authority,
          committedPlaybackRevision: playback.revision,
          queueItemId: playback.queueItemId,
          state: playback.state,
          positionSeconds: rendezvousPosition,
          scheduleDelayMs: PLAYBACK_RECONCILIATION_RENDEZVOUS_LEAD_MS,
          timingMode: 'scheduled-control',
          youtubeSubIndex: playback.youtubeSubIndex,
          youtubeVideoId: playback.youtubeVideoId,
          isCurrent,
        });
      } catch (error) {
        cancelProPlaybackPreparation(authority);
        throw error;
      }
      if (result.status !== 'applied') cancelProPlaybackPreparation(authority);
      return result.status === 'applied' && isCurrent();
    }

    if (!isCurrent()) return false;
    const result = await reconcileCurrentProPlaybackAuthority({
      authority,
      committedPlaybackRevision: playback.revision,
      queueItemId: playback.queueItemId,
      state: playback.state,
      positionSeconds: canonicalPositionNow,
      scheduleDelayMs: 0,
      timingMode: 'scheduled-control',
      youtubeSubIndex: playback.youtubeSubIndex,
      youtubeVideoId: playback.youtubeVideoId,
      isCurrent,
    });
    return result.status === 'applied' && isCurrent();
  }

  function reconciliationOptionsCover(
    running: Readonly<PlaybackReconciliationOptions>,
    requested: Readonly<PlaybackReconciliationOptions>,
  ): boolean {
    return (
      (!running.youtubeOnly || requested.youtubeOnly) &&
      (running.rendezvous || !requested.rendezvous)
    );
  }

  function sameReconciliationOwner(
    left: Readonly<ProRoomPlaybackReconciliationLiveness>,
    right: Readonly<ProRoomPlaybackReconciliationLiveness>,
  ): boolean {
    return left.identity === right.identity;
  }

  function mergeReconciliationOptions(
    left: Readonly<PlaybackReconciliationOptions>,
    right: Readonly<PlaybackReconciliationOptions>,
  ): PlaybackReconciliationOptions {
    return {
      showLoading: false,
      // false means all supported media and is therefore the stronger request.
      youtubeOnly: left.youtubeOnly && right.youtubeOnly,
      rendezvous: left.rendezvous || right.rendezvous,
      owner: left.owner,
    };
  }

  function withReconciliationLoading(
    promise: Promise<boolean>,
    showLoading: boolean,
  ): Promise<boolean> {
    if (!showLoading) return promise;
    const transitionUiId = `local_reconcile_${++state.reconciliationSequence}`;
    beginPlaybackTransitionUi(transitionUiId);
    return promise.finally(() => settlePlaybackTransitionUi(transitionUiId));
  }

  function enqueuePlaybackReconciliation(
    options: Readonly<PlaybackReconciliationOptions>,
  ): Promise<boolean> {
    const schedulerGeneration = state.reconciliationSchedulerGeneration;
    const existing = state.queuedReconciliations.find(
      (candidate) =>
        candidate.schedulerGeneration === schedulerGeneration &&
        sameReconciliationOwner(candidate.options.owner, options.owner) &&
        candidate.options.owner.isCurrent(),
    );
    if (existing) {
      existing.options = mergeReconciliationOptions(existing.options, options);
      return existing.promise;
    }

    let resolvePromise!: (value: boolean) => void;
    let rejectPromise!: (reason: unknown) => void;
    const promise = new Promise<boolean>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    state.queuedReconciliations.push({
      options: { ...options, showLoading: false },
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      schedulerGeneration,
    });
    return promise;
  }

  function drainQueuedPlaybackReconciliations(): void {
    if (state.reconciliationInFlight) return;
    while (state.queuedReconciliations.length > 0) {
      const queued = state.queuedReconciliations.shift()!;
      if (
        !ports.isActive() ||
        queued.schedulerGeneration !== state.reconciliationSchedulerGeneration ||
        !queued.options.owner.isCurrent()
      ) {
        queued.resolve(false);
        continue;
      }
      const operation = startPlaybackReconciliation(queued.options);
      void operation.then(queued.resolve, queued.reject);
      return;
    }
  }

  function startPlaybackReconciliation(
    options: Readonly<PlaybackReconciliationOptions>,
  ): Promise<boolean> {
    const schedulerGeneration = state.reconciliationSchedulerGeneration;
    const flight: PlaybackReconciliationFlight = {
      options: { ...options, showLoading: false },
      promise: Promise.resolve(false),
      schedulerGeneration,
    };
    state.reconciliationInFlight = flight;
    const requestStillCurrent = () =>
      ports.isActive() &&
      schedulerGeneration === state.reconciliationSchedulerGeneration &&
      options.owner.isCurrent();
    const operation = (async () => {
      if (!requestStillCurrent()) return false;
      await ports.runHeartbeat(true, true, requestStillCurrent);
      if (!requestStillCurrent()) return false;
      const snapshot = ports.getCanonicalSnapshot();
      const context = getState('room.context');
      if (
        !requestStillCurrent() ||
        !snapshot ||
        context.kind !== 'pro' ||
        context.roomId !== snapshot.roomCode ||
        context.epoch !== snapshot.presence.coordinatorEpoch
      ) {
        return false;
      }
      const playback = snapshot.playback;
      const item = playback.queueItemId
        ? snapshot.playlist.find((candidate) => candidate.queueItemId === playback.queueItemId)
        : null;
      if (options.youtubeOnly && item?.source.kind !== 'youtube') return false;

      if (playback.state === 'playing') {
        // Heartbeat snapshots intentionally omit a wall-clock field. Require a
        // fresh control-channel sample before extrapolating a running checkpoint;
        // paused/idle checkpoints carry an exact position and need no clock.
        // The timeout is duration-based and therefore independent of a skewed
        // client Date clock.
        if (!requestStillCurrent()) return false;
        const clockCalibrated = await waitForFreshProRoomServerClockCalibration({
          serverDeadlineAtMs: Number.MAX_SAFE_INTEGER,
          fallbackTimeoutMs: PLAYBACK_RECONCILIATION_CLOCK_WAIT_MS,
        });
        if (!requestStillCurrent() || !clockCalibrated) return false;
      }

      if (playback.revision > state.lastAppliedRevision) {
        if (!requestStillCurrent()) return false;
        await restorePlaybackCheckpoint(
          playback,
          snapshot.roomCode,
          snapshot.presence.coordinatorEpoch,
          requestStillCurrent,
        );
        if (!requestStillCurrent()) return false;
        const commit = state.commitInFlight.get(playback.revision);
        if (commit) await commit.promise;
        return requestStillCurrent() && playback.revision === state.lastAppliedRevision;
      }
      if (playback.revision < state.lastAppliedRevision) return false;
      if (!requestStillCurrent()) return false;
      return reapplyCurrentPlaybackCheckpoint(
        playback,
        snapshot.roomCode,
        snapshot.presence.coordinatorEpoch,
        getProRoomServerNow(),
        options.rendezvous,
        requestStillCurrent,
      );
    })().finally(() => {
      if (state.reconciliationInFlight !== flight) return;
      state.reconciliationInFlight = null;
      drainQueuedPlaybackReconciliations();
    });
    flight.promise = operation;
    return operation;
  }

  function reconcileActiveProRoomPlayback(
    options: Readonly<{
      showLoading: boolean;
      youtubeOnly: boolean;
      rendezvous: boolean;
      liveness?: ProRoomPlaybackReconciliationLiveness;
    }>,
  ): Promise<boolean> {
    const normalized: PlaybackReconciliationOptions = {
      showLoading: false,
      youtubeOnly: options.youtubeOnly,
      rendezvous: options.rendezvous,
      owner: options.liveness ?? defaultPlaybackReconciliationOwner,
    };
    if (!normalized.owner.isCurrent()) return Promise.resolve(false);

    const current = state.reconciliationInFlight;
    let operation: Promise<boolean>;
    if (!current) {
      operation = startPlaybackReconciliation(normalized);
    } else if (
      current.schedulerGeneration === state.reconciliationSchedulerGeneration &&
      sameReconciliationOwner(current.options.owner, normalized.owner) &&
      current.options.owner.isCurrent() &&
      reconciliationOptionsCover(current.options, normalized)
    ) {
      operation = current.promise;
    } else {
      operation = enqueuePlaybackReconciliation(normalized);
    }
    return withReconciliationLoading(operation, options.showLoading);
  }

  function requestReconciliation(
    options: Readonly<{
      showLoading?: boolean;
      liveness?: ProRoomPlaybackReconciliationLiveness;
    }> = {},
  ): Promise<boolean> {
    return reconcileActiveProRoomPlayback({
      showLoading: options.showLoading ?? true,
      youtubeOnly: false,
      rendezvous: true,
      liveness: options.liveness,
    });
  }

  function resetPlaylistRuntime(): void {
    state.commandGeneration += 1;
    const transition = state.activeTransition;
    if (transition) {
      transition.clockAbort.abort();
      cancelProPlaybackPreparation(transition.authority);
    }
    state.activeTransition = null;
    resetPlaybackTransitionUi();
    state.commitInFlight.clear();
    state.commitFollowUps.clear();
    state.commitGeneration += 1;
    state.commitTail = Promise.resolve();
    state.commandTail = Promise.resolve();
    state.highestKnownRevision = -1;
    state.lastAppliedRevision = -1;
    clearLocalPlaybackUiControls();
    resetProPlaybackAuthorityHooks();
  }

  function stopLifecycle(): void {
    state.commandGeneration += 1;
    state.reconciliationSchedulerGeneration += 1;
    state.reconciliationInFlight = null;
    for (const queued of state.queuedReconciliations) queued.resolve(false);
    state.queuedReconciliations = [];
    state.commitFollowUps.clear();
    state.unregisterCommandHandler?.();
    state.unregisterCommandHandler = null;
    const transition = state.activeTransition;
    if (transition) {
      transition.clockAbort.abort();
      cancelProPlaybackPreparation(transition.authority);
    }
    state.activeTransition = null;
    resetPlaybackTransitionUi();
    state.commitGeneration += 1;
    clearLocalPlaybackUiControls();
    resetProPlaybackAuthorityHooks();
  }

  function startLifecycle(): void {
    state.unregisterCommandHandler?.();
    state.unregisterCommandHandler = registerProPlaybackCommandHandler((intent) =>
      enqueuePlaybackIntent(intent),
    );
  }

  function beginControlChannelRecovery(): void {
    const transition = state.activeTransition;
    if (transition && !state.commitInFlight.has(transition.event.target.revision)) {
      transition.clockAbort.abort();
      cancelProPlaybackPreparation(transition.authority);
      if (state.activeTransition === transition) {
        state.activeTransition = null;
        settlePlaybackTransitionUi(transition.event.transitionId);
      }
    }
  }

  return {
    acceptPrepare: acceptPlaybackPrepare,
    acceptCancel: acceptPlaybackCancel,
    acceptCommit: acceptPlaybackCommit,
    enqueueIntent: enqueuePlaybackIntent,
    requestFirstAppendSelection,
    restorePersistedPlayback,
    requestReconciliation,
    reconcile: reconcileActiveProRoomPlayback,
    startLifecycle,
    stopLifecycle,
    resetPlaylistRuntime,
    beginControlChannelRecovery,
  };
}

/** Owns the PRO playback prepare/commit/intent/reconciliation state machine. */
export class ProRoomPlaybackController {
  private readonly state = createInitialState();
  private readonly implementation: ProRoomPlaybackImplementation;

  constructor(ports: ProRoomPlaybackControllerPorts) {
    this.implementation = createImplementation(ports, this.state);
  }

  acceptPrepare(event: ProRoomPlaybackPrepareEvent, receivedAtMs?: number): void {
    this.implementation.acceptPrepare(event, receivedAtMs);
  }

  acceptCancel(transitionId: string): void {
    this.implementation.acceptCancel(transitionId);
  }

  acceptCommit(event: ProRoomPlaybackCommitEvent, isRequestCurrent?: PlaybackCommitOwner): void {
    this.implementation.acceptCommit(event, isRequestCurrent);
  }

  enqueueIntent(intent: Readonly<ProPlaybackUserIntent>): Promise<void> {
    return this.implementation.enqueueIntent(intent);
  }

  requestFirstAppendSelection(
    request: Readonly<ProRoomFirstAppendSelectionRequest>,
    signal?: AbortSignal,
    lease?: ProRoomPlaybackPlaylistLease,
  ): Promise<void> {
    return this.implementation.requestFirstAppendSelection(request, signal, lease);
  }

  restorePersistedPlayback(
    snapshot: ProRoomSnapshot,
    isRequestCurrent?: PlaybackCommitOwner,
  ): Promise<void> {
    return this.implementation.restorePersistedPlayback(snapshot, isRequestCurrent);
  }

  requestReconciliation(
    options: Readonly<{
      showLoading?: boolean;
      liveness?: ProRoomPlaybackReconciliationLiveness;
    }> = {},
  ): Promise<boolean> {
    return this.implementation.requestReconciliation(options);
  }

  reconcile(
    options: Readonly<{
      showLoading: boolean;
      youtubeOnly: boolean;
      rendezvous: boolean;
      liveness?: ProRoomPlaybackReconciliationLiveness;
    }>,
  ): Promise<boolean> {
    return this.implementation.reconcile(options);
  }

  startLifecycle(): void {
    this.implementation.startLifecycle();
  }

  stopLifecycle(): void {
    this.implementation.stopLifecycle();
  }

  resetPlaylistRuntime(): void {
    this.implementation.resetPlaylistRuntime();
  }

  beginControlChannelRecovery(): void {
    this.implementation.beginControlChannelRecovery();
  }
}
