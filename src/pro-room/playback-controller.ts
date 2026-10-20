import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { recordProStartObservation } from '../diagnostics/pro-start-observations.ts';
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
  acquireProRoomServerClock,
  captureProRoomServerClockSnapshot,
  getProRoomServerNow,
  isProRoomClockSnapshotCurrent,
  isProRoomServerClockCalibrated,
  type ProRoomClockSnapshot,
} from './network-bridge.ts';
import {
  cancelProPlaybackPreparation,
  cancelSupersededProPlaybackPreparation,
  commitProPlaybackAuthority,
  createProPlaybackAuthorityToken,
  hasCancelledProPlaybackCheckpointRecovery,
  invalidateCommittedProPlaybackMedia,
  prepareCurrentProPlaybackRendezvousAuthority,
  prepareProPlaybackAuthority,
  reconcileCurrentProPlaybackAuthority,
  recoverCancelledProPlaybackCheckpoint,
  rendezvousCurrentProPlaybackAuthority,
  refreshProPlaybackUiControlTimeout,
  registerProPlaybackCommandHandler,
  resetProPlaybackAuthorityHooks,
  settleProPlaybackUiControl,
  type ProPlaybackAuthorityToken,
  type ProPlaybackCommitResult,
  type ProPlaybackPrepareResult,
  type ProPlaybackPrepareRequest,
  type ProPlaybackTimingMode,
  type ProPlaybackUserIntent,
} from './playback-authority-hooks.ts';
import { pendingProQueueRemoval } from './queue-removal-wait.ts';
import type { ProRoomFirstAppendSelectionRequest } from './playlist-state-manager.ts';
import { registerProRoomLocalPlaybackTimeline } from './local-playback-timeline.ts';
import { getProSystemAudioViewState } from './system-audio-bridge.ts';
import type { ProRoomSystemAudioViewState } from './system-audio-controller.ts';

const PLAYBACK_COMMAND_REQUEST_TIMEOUT_MS = 6_000;
const PLAYLIST_HYDRATION_MAX_WAIT_MS = 1_500;
const PLAYLIST_HYDRATION_PREPARE_RESERVE_MS = 500;
const PLAYBACK_RECONCILIATION_CLOCK_WAIT_MS = 1_000;
const PLAYBACK_COMMIT_CLOCK_WAIT_MS = 700;
const PLAYBACK_RECONCILIATION_RENDEZVOUS_LEAD_MS = 700;
// A YouTube iframe starts late by its seek latency whenever it seeks at the
// release instant. Participant-local rejoins therefore pick their release
// instant before preparing, like a server PREPARE/COMMIT, and settle there.
const LOCAL_YOUTUBE_REJOIN_DEFAULT_LEAD_MS = 2_000;
const LOCAL_YOUTUBE_REJOIN_MIN_LEAD_MS = 1_500;
const LOCAL_YOUTUBE_REJOIN_MAX_LEAD_MS = 4_000;
const LOCAL_YOUTUBE_REJOIN_LEAD_MARGIN_MS = 500;
const LOCAL_YOUTUBE_REJOIN_SAMPLE_LIMIT = 4;
// Below this remaining lead the arm can no longer release without a seek
// (the Android fixed output lead alone is 250ms).
const LOCAL_YOUTUBE_REJOIN_MIN_RELEASE_MS = 400;
// A restore or delayed COMMIT whose instant is this close (or already past)
// cannot prepare in time and joins at a later participant-local instant.
const LATE_YOUTUBE_COMMIT_THRESHOLD_MS = 1_500;
const LATE_YOUTUBE_COMMIT_LEAD_MS = 3_000;
// Mirrors the arm's catch-up tolerance: smaller lateness releases without a seek.
const LATE_YOUTUBE_RELEASE_TOLERANCE_MS = 40;
const MEDIA_DURATION_REPORT_TIMEOUT_MS = 6_000;
const MEDIA_DURATION_REPORT_RETRY_MS = 30_000;
const MEDIA_DURATION_REPORT_CACHE_SIZE = 128;
let clockRecoveryTimerSequence = 0;

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
  reportMediaDuration?(
    input: Parameters<ProRoomApiClient['reportMediaDuration']>[0],
    signal?: AbortSignal,
  ): ReturnType<ProRoomApiClient['reportMediaDuration']>;
  executePlaybackCommand(
    input: Parameters<ProRoomApiClient['executePlaybackCommand']>[0],
    signal?: AbortSignal,
  ): ReturnType<ProRoomApiClient['executePlaybackCommand']>;
  recoverTerminalSession(error: ProRoomApiError): Promise<void>;
}

interface ActiveServerPlaybackTransition {
  event: ProRoomPlaybackPrepareEvent;
  authority: ProPlaybackAuthorityToken;
  mediaPreparation: Promise<ProPlaybackPrepareResult>;
  preparation: Promise<PlaybackPreparation>;
  clockSnapshot: ProRoomClockSnapshot | null;
  commitReceived: boolean;
  readyReportStarted: boolean;
  receivedAtMs: number;
  clockAbort: AbortController;
}

interface PlaybackPreparation {
  media: ProPlaybackPrepareResult;
  clock: ProRoomClockSnapshot | null;
}

type PlaybackCommitOwner = () => boolean;

interface PlaybackCommitFlight {
  promise: Promise<void>;
  owner: PlaybackCommitOwner;
}

interface PlaybackCommitFollowUp {
  event: ProRoomPlaybackCommitEvent;
  owner: PlaybackCommitOwner;
  /** The requester's clock lease, so the follower can plan its release too. */
  clock: ProRoomClockSnapshot | null;
}

interface PlaybackReconciliationOptions {
  showLoading: boolean;
  youtubeOnly: boolean;
  rendezvous: boolean;
  preparePaused: boolean;
  owner: ProRoomPlaybackReconciliationLiveness;
}

interface PlaybackReconciliationFlight {
  options: PlaybackReconciliationOptions;
  promise: Promise<boolean>;
  schedulerGeneration: number;
}

interface CancelledCheckpointRecoveryFlight {
  playback: ProRoomPlaybackCheckpoint;
  roomCode: string;
  roomEpoch: number;
  generation: number;
  isCurrent: () => boolean;
  promise: Promise<ProPlaybackCommitResult | null>;
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
  cancelledCheckpointRecovery: CancelledCheckpointRecoveryFlight | null;
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
    cancelledCheckpointRecovery: null,
    queuedReconciliations: [],
    reconciliationSchedulerGeneration: 0,
    pendingLocalUiControls: new Map(),
    cancelledTransitionIds: new Set(),
    lastAppliedUiCheckpoint: null,
  };
}

interface ProRoomPlaybackImplementation {
  resolveProjectedQueueItemId(snapshot: ProRoomSnapshot): QueueItemId | null;
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
      preparePaused?: boolean;
      liveness?: ProRoomPlaybackReconciliationLiveness;
    }>,
  ): Promise<boolean>;
  startLifecycle(): void;
  stopLifecycle(): void;
  resetPlaylistRuntime(): void;
  beginControlChannelRecovery(): number;
  completeControlChannelRecovery(generation: number): void;
}

function createImplementation(
  ports: ProRoomPlaybackControllerPorts,
  state: ProRoomPlaybackControllerState,
): ProRoomPlaybackImplementation {
  const MAX_CANCELLED_PLAYBACK_TRANSITION_IDS = 64;
  let unregisterLocalTimeline: (() => void) | null = null;
  let unregisterCommandAuthority: (() => void) | null = null;
  let unregisterSystemAudioState: (() => void) | null = null;
  let snapshotPlaybackGeneration = 0;
  let snapshotPlaybackBlocked = false;
  let snapshotPlaybackOwner = createSnapshotPlaybackOwner();
  let commandAuthorityGeneration = 0;
  let commandMediaGeneration = 0;
  let controlChannelGeneration = 0;
  let controlChannelRecovering = false;
  let commandPlayback: { roomId: string; playback: ProRoomPlaybackCheckpoint } | null = null;
  let durationReportGeneration = 0;
  let durationEndpointUnavailable = false;
  let durationReportSequence = 0;
  const durationReports = new Map<
    string,
    { status: 'pending' | 'succeeded' | 'failed'; retryAtMs: number }
  >();
  const durationReportRequests = new Set<AbortController>();
  const clockRequests = new Map<AbortController, number>();
  let clockRecoveryTimer: string | null = null;
  let clockRecoveryRevision = -1;
  // Recent participant-local YouTube preparation durations. They only size the
  // planned rejoin lead; media timing itself is never learned from them.
  const localYouTubePreparationSamples: number[] = [];
  let localRejoinUiSequence = 0;

  function localYouTubeRejoinLeadMs(minimumMs = LOCAL_YOUTUBE_REJOIN_MIN_LEAD_MS): number {
    const observedMs =
      localYouTubePreparationSamples.length > 0
        ? Math.max(...localYouTubePreparationSamples) + LOCAL_YOUTUBE_REJOIN_LEAD_MARGIN_MS
        : LOCAL_YOUTUBE_REJOIN_DEFAULT_LEAD_MS;
    return Math.min(LOCAL_YOUTUBE_REJOIN_MAX_LEAD_MS, Math.max(minimumMs, observedMs));
  }

  function recordLocalYouTubePreparation(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    localYouTubePreparationSamples.push(durationMs);
    if (localYouTubePreparationSamples.length > LOCAL_YOUTUBE_REJOIN_SAMPLE_LIMIT) {
      localYouTubePreparationSamples.shift();
    }
  }

  function positionAtServerTime(playback: ProRoomPlaybackCheckpoint, serverTimeMs: number): number {
    return playback.state === 'playing'
      ? playback.positionSeconds + Math.max(0, serverTimeMs - playback.updatedAtMs) / 1_000
      : playback.positionSeconds;
  }

  /**
   * A running YouTube checkpoint whose instant is already (nearly) past would
   * otherwise prepare its stale anchor and seek far ahead while releasing at
   * once. Plan a participant-local instant instead and settle at its position.
   */
  function planLateYouTubeRelease(
    event: ProRoomPlaybackCommitEvent,
    clock: ProRoomClockSnapshot | null,
  ): { executeAtMs: number } | null {
    const playback = event.playback;
    if (
      playback.state !== 'playing' ||
      playback.youtubeVideoId === null ||
      !clock ||
      !isProRoomClockSnapshotCurrent(clock)
    ) {
      return null;
    }
    const nowMs = Date.now() + clock.offsetMs;
    if (event.executeAtMs - nowMs >= LATE_YOUTUBE_COMMIT_THRESHOLD_MS) return null;
    return { executeAtMs: nowMs + localYouTubeRejoinLeadMs(LATE_YOUTUBE_COMMIT_LEAD_MS) };
  }

  /** Commit timing for a planned late release, or null once the plan has overrun. */
  function plannedLateYouTubeTiming(
    playback: ProRoomPlaybackCheckpoint,
    plan: { executeAtMs: number },
    clock: ProRoomClockSnapshot,
  ): ReturnType<typeof playbackCommitTiming> | null {
    const remainingMs = plan.executeAtMs - (Date.now() + clock.offsetMs);
    if (remainingMs < LOCAL_YOUTUBE_REJOIN_MIN_RELEASE_MS) return null;
    return {
      positionSeconds: positionAtServerTime(playback, plan.executeAtMs),
      scheduleDelayMs: remainingMs,
      signedDelayMs: remainingMs,
      timingMode: 'scheduled-control',
    };
  }

  function cancelClockRequests(beforeRevision = Number.POSITIVE_INFINITY): void {
    for (const [controller, revision] of clockRequests) {
      if (revision < beforeRevision) controller.abort();
    }
    if (clockRecoveryTimer !== null) clearManagedTimer(clockRecoveryTimer);
    clockRecoveryTimer = null;
  }

  async function acquirePlaybackClock(input: {
    revision: number;
    purpose: 'prepare' | 'commit' | 'restore' | 'reconcile';
    isCurrent: () => boolean;
    timeoutMs: number;
    fresh?: boolean;
    serverDeadlineAtMs?: number;
    signal?: AbortSignal;
  }): Promise<ProRoomClockSnapshot | null> {
    if (!input.isCurrent()) return null;
    const linked = createRoomLinkedAbortController(ports.getRoomAbortSignal());
    const abort = () => linked.controller.abort();
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener('abort', abort, { once: true });
    clockRequests.set(linked.controller, input.revision);
    try {
      const clock = await acquireProRoomServerClock({
        timeoutMs: input.timeoutMs,
        signal: linked.controller.signal,
        fresh: input.fresh,
        serverDeadlineAtMs: input.serverDeadlineAtMs,
      });
      const valid =
        !linked.controller.signal.aborted &&
        input.isCurrent() &&
        clock !== null &&
        isProRoomClockSnapshotCurrent(clock);
      recordProStartObservation('playback-clock', {
        purpose: input.purpose,
        revision: input.revision,
        outcome: valid ? 'selected' : linked.controller.signal.aborted ? 'aborted' : 'timeout',
        sampleId: clock?.sampleId ?? null,
        generation: clock?.generation ?? null,
        offsetMs: clock?.offsetMs ?? null,
        rttMs: clock?.rttMs ?? null,
        sampledAtMs: clock?.sampledAtMs ?? null,
      });
      return valid ? clock : null;
    } finally {
      input.signal?.removeEventListener('abort', abort);
      linked.detach();
      clockRequests.delete(linked.controller);
    }
  }

  function retryClockRecovery(revision: number, isCurrent: () => boolean): void {
    if (clockRecoveryRevision === revision || !isCurrent()) return;
    clockRecoveryRevision = revision;
    clockRecoveryTimer = `pro-playback-clock-recovery-${++clockRecoveryTimerSequence}`;
    setManagedTimer(
      clockRecoveryTimer,
      () => {
        clockRecoveryTimer = null;
        if (!isCurrent()) return;
        recordProStartObservation('playback-clock-retry', { revision, outcome: 'retry' });
        // The regular heartbeat remains the bounded long-term recovery path.
        // One early retry must not turn an unavailable clock into an HTTP loop.
        void ports.runHeartbeat(true).catch((error) => {
          log.warn('[PRO Playback] Clock recovery heartbeat failed', error);
        });
      },
      250,
    );
  }

  function resetDurationReports(): void {
    durationReportGeneration += 1;
    durationEndpointUnavailable = false;
    durationReports.clear();
    for (const controller of durationReportRequests) controller.abort();
    durationReportRequests.clear();
  }

  /** Capture the immutable source before decoding, never infer it from the next song. */
  function captureFileDurationReporter(
    request: Pick<ProPlaybackPrepareRequest, 'authority' | 'queueItemId'>,
    isCurrent: () => boolean,
  ): (result: ProPlaybackPrepareResult) => void {
    if (!ports.reportMediaDuration) return () => undefined;
    const snapshot = ports.getPlaylistSnapshot() ?? ports.getCanonicalSnapshot();
    const item = snapshot?.playlist.find(
      (candidate) => candidate.queueItemId === request.queueItemId,
    );
    const lease = ports.capturePlaylistLease();
    const context = getState('room.context');
    const source = item?.source;
    if (
      !lease ||
      source?.kind !== 'pro-r2' ||
      context.kind !== 'pro' ||
      context.roomId !== request.authority.roomId ||
      context.epoch !== request.authority.roomEpoch ||
      !context.capabilities.includes('playback.control') ||
      snapshot?.roomCode !== context.roomId ||
      lease.roomCode !== context.roomId
    )
      return () => undefined;
    const captured = {
      code: context.roomId,
      assetId: source.assetId,
      assetVersion: source.version,
      byteLength: source.byteLength,
    };
    const epoch = context.epoch;
    const generation = durationReportGeneration;
    const roomSignal = ports.getRoomAbortSignal();
    const stillCurrent = () => {
      const currentContext = getState('room.context');
      const currentSnapshot = ports.getPlaylistSnapshot() ?? ports.getCanonicalSnapshot();
      const currentSource = currentSnapshot?.playlist.find(
        (candidate) => candidate.queueItemId === request.queueItemId,
      )?.source;
      return (
        isCurrent() &&
        ports.isActive() &&
        !roomSignal?.aborted &&
        generation === durationReportGeneration &&
        ports.isPlaylistLeaseCurrent(lease) &&
        currentContext.kind === 'pro' &&
        currentContext.roomId === captured.code &&
        currentContext.epoch === epoch &&
        currentContext.capabilities.includes('playback.control') &&
        currentSnapshot?.roomCode === captured.code &&
        currentSource?.kind === 'pro-r2' &&
        currentSource.assetId === captured.assetId &&
        currentSource.version === captured.assetVersion &&
        currentSource.byteLength === captured.byteLength
      );
    };
    return (result) => {
      if (
        result.status !== 'ready' ||
        result.mediaKind !== 'file' ||
        result.queueItemId !== request.queueItemId ||
        result.authority.roomId !== captured.code ||
        result.authority.roomEpoch !== epoch ||
        result.authority.basePlaybackRevision !== request.authority.basePlaybackRevision ||
        result.authority.transitionId !== request.authority.transitionId ||
        result.durationSeconds === null ||
        !Number.isFinite(result.durationSeconds) ||
        result.durationSeconds <= 0 ||
        result.durationSeconds > 7 * 24 * 60 * 60 ||
        !stillCurrent() ||
        durationEndpointUnavailable
      )
        return;
      const input = { ...captured, durationSeconds: result.durationSeconds };
      const key = JSON.stringify(input);
      const previous = durationReports.get(key);
      if (previous && (previous.status !== 'failed' || previous.retryAtMs > Date.now())) return;
      if (durationReportRequests.size >= MEDIA_DURATION_REPORT_CACHE_SIZE) return;
      const entry = { status: 'pending' as 'pending' | 'succeeded' | 'failed', retryAtMs: 0 };
      durationReports.delete(key);
      durationReports.set(key, entry);
      while (durationReports.size > MEDIA_DURATION_REPORT_CACHE_SIZE) {
        const oldest = durationReports.keys().next().value;
        if (oldest === undefined) break;
        durationReports.delete(oldest);
      }
      const linked = createRoomLinkedAbortController(roomSignal);
      durationReportRequests.add(linked.controller);
      const signal = linked.controller.signal;
      const timer = `pro-file-duration-report-${++durationReportSequence}`;
      let onAbort: () => void = () => undefined;
      const aborted = new Promise<false>((resolve) => {
        onAbort = () => resolve(false);
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      setManagedTimer(timer, () => linked.controller.abort(), MEDIA_DURATION_REPORT_TIMEOUT_MS);
      // Metadata must never delay a media commit or turn a working renderer
      // into a failed one. Retry only on a later preparation after backoff.
      void (async () => {
        let success = false;
        try {
          if (!signal.aborted && stillCurrent()) {
            success = await Promise.race([
              ports.reportMediaDuration!(input, signal).then(() => true),
              aborted,
            ]);
          }
        } catch (error) {
          // A refreshed App can run against an older Worker during rollback.
          if (
            generation === durationReportGeneration &&
            error instanceof ProRoomApiError &&
            error.status === 404 &&
            error.code === 'NOT_FOUND'
          ) {
            durationEndpointUnavailable = true;
          }
        } finally {
          clearManagedTimer(timer);
          signal.removeEventListener('abort', onAbort);
          linked.detach();
          durationReportRequests.delete(linked.controller);
          if (generation === durationReportGeneration && durationReports.get(key) === entry) {
            entry.status = success && !signal.aborted ? 'succeeded' : 'failed';
            entry.retryAtMs = Date.now() + MEDIA_DURATION_REPORT_RETRY_MS;
          }
        }
      })().catch(() => undefined);
    };
  }

  function prepareWithDurationReport(
    request: Readonly<ProPlaybackPrepareRequest>,
    isCurrent: () => boolean,
    prepare = prepareProPlaybackAuthority,
  ): Promise<ProPlaybackPrepareResult> {
    const report = captureFileDurationReporter(request, isCurrent);
    return prepare(request).then((result) => {
      // Optional metadata reporting cannot fail a successful preparation.
      try {
        report(result);
      } catch (error) {
        log.warn('[PRO Playback] Could not report decoded file duration', error);
      }
      return result;
    });
  }

  function createSnapshotPlaybackOwner(): PlaybackCommitOwner {
    const generation = snapshotPlaybackGeneration;
    return () => generation === snapshotPlaybackGeneration && !snapshotPlaybackBlocked;
  }

  function invalidateSnapshotPlaybackOwner(): void {
    snapshotPlaybackGeneration += 1;
    snapshotPlaybackOwner = createSnapshotPlaybackOwner();
  }

  function observeSystemAudioOwnership(
    view: Pick<ProRoomSystemAudioViewState, 'roomCode' | 'phase' | 'initialized'>,
  ): void {
    const context = getState('room.context');
    if (context.kind !== 'pro' || view.roomCode !== context.roomId) return;
    // The persisted checkpoint describes playback underneath a live share.
    // Retire already-waiting restores as well as new heartbeat restores. Keep
    // that fence through publisher recovery (live -> preparing -> live/idle).
    const blocked =
      view.phase === 'live'
        ? true
        : view.initialized && view.phase === 'idle'
          ? false
          : snapshotPlaybackBlocked;
    if (blocked === snapshotPlaybackBlocked) return;
    snapshotPlaybackBlocked = blocked;
    invalidateSnapshotPlaybackOwner();
  }

  function rememberCommandPlayback(roomId: string, playback: ProRoomPlaybackCheckpoint): void {
    const previous = commandPlayback;
    if (
      previous?.roomId === roomId &&
      previous.playback.coordinatorEpoch === playback.coordinatorEpoch &&
      previous.playback.revision >= playback.revision
    )
      return;
    if (
      previous?.roomId !== roomId ||
      previous.playback.coordinatorEpoch !== playback.coordinatorEpoch ||
      previous.playback.queueItemId !== playback.queueItemId ||
      previous.playback.youtubeSubIndex !== playback.youtubeSubIndex ||
      previous.playback.youtubeVideoId !== playback.youtubeVideoId
    )
      commandMediaGeneration += 1;
    commandPlayback = { roomId, playback };
  }

  function getCommandPlayback(): ProRoomPlaybackCheckpoint | null {
    const snapshot = ports.getCanonicalSnapshot();
    if (snapshot) rememberCommandPlayback(snapshot.roomCode, snapshot.playback);
    const context = getState('room.context');
    return commandPlayback?.roomId === context.roomId &&
      commandPlayback.playback.coordinatorEpoch === context.epoch
      ? commandPlayback.playback
      : null;
  }
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
    canRetry: () => boolean,
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
        if (!retryable || attempt > 0 || roomSignal?.aborted || !canRetry()) throw error;
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
    latePlan: { executeAtMs: number } | null = null,
  ) {
    if (!playback.queueItemId) return null;
    return {
      authority,
      queueItemId: playback.queueItemId,
      positionSeconds: latePlan
        ? positionAtServerTime(playback, latePlan.executeAtMs)
        : playback.positionSeconds,
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
      .then(async ({ media: result, clock }) => {
        if (state.activeTransition !== transition || transition.commitReceived) return;
        const status =
          result.status === 'ready' &&
          clock &&
          isProRoomClockSnapshotCurrent(clock) &&
          Date.now() + clock.offsetMs <= transition.event.deadlineAtMs
            ? 'ready'
            : 'failed';
        try {
          const outcome = await ports.reportPlaybackTransitionReady({
            code: transition.authority.roomId,
            transitionId: transition.event.transitionId,
            basePlaybackRevision: transition.event.basePlaybackRevision,
            status,
            ...(status === 'ready' &&
            result.status === 'ready' &&
            result.mediaKind === 'file' &&
            getState('room.context').capabilities.includes('playback.control') &&
            result.durationSeconds !== null &&
            Number.isFinite(result.durationSeconds) &&
            result.durationSeconds > 0
              ? { durationSeconds: result.durationSeconds }
              : {}),
          });
          // A lost WebSocket COMMIT is recovered from the canonical snapshot.
          if (outcome === 'committed') {
            ports.runHeartbeat(true).catch((error) => {
              log.warn('[PRO Playback] Post-COMMIT heartbeat failed', error);
            });
          }
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
      prepareWithDurationReport(
        {
          ...request,
          prepareBudgetMs: Math.max(
            0,
            event.deadlineAtMs - serverNowForFrame(event.serverTimeMs, receivedAtMs),
          ),
        },
        isCurrent,
      );
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
    cancelClockRequests(event.target.revision);
    state.cancelledCheckpointRecovery = null;

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
    const mediaPreparation = preparePlaybackAfterPlaylistHydration(
      request,
      event,
      receivedAtMs,
      clockAbort.signal,
      () => state.activeTransition?.authority === authority && !clockAbort.signal.aborted,
    );
    const preparation = mediaPreparation.then(async (media): Promise<PlaybackPreparation> => {
      if (media.status !== 'ready') return { media, clock: null };
      const clock = await acquirePlaybackClock({
        revision: event.target.revision,
        purpose: 'prepare',
        isCurrent: () =>
          state.activeTransition?.authority === authority && !clockAbort.signal.aborted,
        timeoutMs: Math.max(
          0,
          event.deadlineAtMs - event.serverTimeMs - Math.max(0, Date.now() - receivedAtMs),
        ),
        fresh: true,
        serverDeadlineAtMs: event.deadlineAtMs,
        signal: clockAbort.signal,
      });
      if (state.activeTransition?.authority === authority) {
        state.activeTransition.clockSnapshot = clock;
      }
      return { media, clock };
    });
    const transition: ActiveServerPlaybackTransition = {
      event,
      authority,
      mediaPreparation,
      preparation,
      clockSnapshot: null,
      commitReceived: false,
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

  function hasNewerServerPlaybackTransition(playbackRevision: number): boolean {
    const transition = state.activeTransition;
    return !!transition && transition.event.target.revision > playbackRevision;
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
      !hasNewerServerPlaybackTransition(event.playback.revision) &&
      event.playback.revision > state.lastAppliedRevision &&
      event.playback.revision >= state.highestKnownRevision
    );
  }

  const PRO_PLAYBACK_ZERO_START_WIRE_LEAD_MS = 699;

  function playbackCommitTiming(
    event: ProRoomPlaybackCommitEvent,
    receivedAtMs: number,
    clock: ProRoomClockSnapshot | null,
  ): {
    positionSeconds: number;
    scheduleDelayMs: number;
    signedDelayMs: number;
    timingMode: ProPlaybackTimingMode;
  } {
    if (event.playback.state === 'playing' && !clock) {
      throw new Error('PRO_PLAYBACK_CLOCK_UNAVAILABLE');
    }
    const nowMs = clock
      ? Date.now() + clock.offsetMs
      : serverNowForFrame(event.serverTimeMs, receivedAtMs);
    const signedDelayMs = event.executeAtMs - nowMs;
    // Wire-compatible rollout marker: old clients treat 699ms as an ordinary
    // future COMMIT instant. Refreshed clients grant learned startup lead only
    // to this explicit marker; all playing paths retain fixed output delay.
    // Legacy, direct, and malformed timings remain running-timeline controls.
    const zeroStart =
      event.transitionId !== null &&
      event.executeAtMs - event.serverTimeMs === PRO_PLAYBACK_ZERO_START_WIRE_LEAD_MS;
    return {
      scheduleDelayMs: Math.max(0, signedDelayMs),
      signedDelayMs,
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

  function canonicalCheckpointMatches(
    playback: ProRoomPlaybackCheckpoint,
    roomCode: string,
    roomEpoch: number,
  ): boolean {
    const snapshot = ports.getCanonicalSnapshot();
    const canonical = snapshot?.playback;
    return (
      snapshot?.roomCode === roomCode &&
      canonical?.coordinatorEpoch === roomEpoch &&
      canonical.revision === playback.revision &&
      canonical.queueItemId === playback.queueItemId &&
      canonical.state === playback.state &&
      canonical.positionSeconds === playback.positionSeconds &&
      canonical.updatedAtMs === playback.updatedAtMs &&
      canonical.youtubeSubIndex === playback.youtubeSubIndex &&
      canonical.youtubeVideoId === playback.youtubeVideoId
    );
  }

  async function catchUpExactPlaybackCheckpoint(
    event: ProRoomPlaybackCommitEvent,
    receivedAtMs: number,
    generation: number,
    roomCode: string,
    roomEpoch: number,
    isRequestCurrent: () => boolean,
    clock: ProRoomClockSnapshot | null,
  ) {
    const playback = event.playback;
    if (playback.state === 'idle' || !playback.queueItemId) return null;
    const authority = playbackAuthorityFor(
      roomCode,
      roomEpoch,
      playback.revision,
      `snapshot_${playback.revision}`,
    );
    const latePlan = planLateYouTubeRelease(event, clock);
    const request = playbackPrepareRequest(authority, playback, latePlan);
    if (!request) return null;
    const current = () =>
      playbackCommitStillCurrent(event, generation, isRequestCurrent) &&
      (playback.state !== 'playing' || (clock !== null && isProRoomClockSnapshotCurrent(clock)));
    if (!current()) return null;
    const reportRecoveredDuration = captureFileDurationReporter(request, current);
    let prepared: ProPlaybackPrepareResult;
    try {
      prepared = await prepareWithDurationReport(
        {
          ...request,
          isCurrent: current,
        },
        current,
      );
    } catch (error) {
      cancelProPlaybackPreparation(authority);
      throw error;
    }
    if (!current()) {
      cancelProPlaybackPreparation(authority);
      return null;
    }
    if (prepared.status !== 'ready') {
      cancelProPlaybackPreparation(authority);
      if (prepared.reason === 'stale-authority') {
        const exactCheckpointIsCurrent = () => {
          return current() && canonicalCheckpointMatches(playback, roomCode, roomEpoch);
        };
        const timing = playbackCommitTiming(event, receivedAtMs, clock);
        return recoverCancelledProPlaybackCheckpoint(
          {
            authority,
            committedPlaybackRevision: playback.revision,
            queueItemId: playback.queueItemId,
            state: playback.state,
            positionSeconds: timing.positionSeconds,
            scheduleDelayMs: timing.scheduleDelayMs,
            timingMode: 'scheduled-control',
            youtubeSubIndex: playback.youtubeSubIndex,
            youtubeVideoId: playback.youtubeVideoId,
            isCurrent: exactCheckpointIsCurrent,
          },
          () => playbackCommitTiming(event, receivedAtMs, clock),
          reportRecoveredDuration,
        );
      }
      return null;
    }
    // This is the final attempt: if preparation overran its planned instant,
    // keep the established immediate catch-up rather than waiting again.
    const timing =
      (latePlan && clock ? plannedLateYouTubeTiming(playback, latePlan, clock) : null) ??
      playbackCommitTiming(event, receivedAtMs, clock);
    try {
      const result = await commitProPlaybackAuthority({
        authority,
        committedPlaybackRevision: playback.revision,
        queueItemId: playback.queueItemId,
        state: playback.state,
        positionSeconds: timing.positionSeconds,
        scheduleDelayMs: timing.scheduleDelayMs,
        // Catch-up follows a committed running checkpoint. Keep fixed audio
        // output compensation, but never inherit learned startup-only lead.
        timingMode: 'scheduled-control',
        youtubeSubIndex: playback.youtubeSubIndex,
        youtubeVideoId: playback.youtubeVideoId,
        isCurrent: current,
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
    clock: ProRoomClockSnapshot | null,
  ): Promise<void> {
    const timing =
      clock || event.playback.state !== 'playing'
        ? playbackCommitTiming(event, receivedAtMs, clock)
        : {
            positionSeconds: event.playback.positionSeconds,
            scheduleDelayMs: 0,
            timingMode: 'scheduled-control' as const,
          };
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
    initialClock: ProRoomClockSnapshot | null = null,
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
    let preparation: Promise<PlaybackPreparation> | null = null;
    let clock: ProRoomClockSnapshot | null = initialClock;
    let preparedFromMatchingTransition = false;
    let latePlan: { executeAtMs: number } | null = null;
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
      const transition = activeTransition;
      // READY and COMMIT share media and the chosen estimate, but not their
      // remaining wait budgets. An early COMMIT must not wait the entire
      // PREPARE deadline before beginning its own bounded clock acquisition.
      preparation = transition.mediaPreparation.then((media) => ({
        media,
        clock: transition.clockSnapshot,
      }));
      preparedFromMatchingTransition = true;
    } else if (event.transitionId !== null && playback.queueItemId) {
      if (activeTransition) cancelProPlaybackPreparation(activeTransition.authority);
      authority = playbackAuthorityFor(
        context.roomId,
        context.epoch,
        playback.revision,
        event.transitionId,
      );
      latePlan = planLateYouTubeRelease(event, clock);
      const request = playbackPrepareRequest(authority, playback, latePlan);
      preparation = request
        ? prepareWithDurationReport(
            {
              ...request,
              isCurrent: () => playbackCommitStillCurrent(event, generation, isRequestCurrent),
            },
            () => playbackCommitStillCurrent(event, generation, isRequestCurrent),
          ).then((media) => ({ media, clock: null }))
        : null;
    } else {
      authority = playbackAuthorityFor(context.roomId, context.epoch, playback.revision, null);
    }

    const current = () => playbackCommitStillCurrent(event, generation, isRequestCurrent);
    const currentWithClock = () =>
      current() &&
      (playback.state !== 'playing' || (clock !== null && isProRoomClockSnapshotCurrent(clock)));
    const ensureClock = async (): Promise<boolean> => {
      if (playback.state !== 'playing') return current();
      if (clock && isProRoomClockSnapshotCurrent(clock)) return current();
      clock = await acquirePlaybackClock({
        revision: playback.revision,
        purpose: 'commit',
        isCurrent: current,
        timeoutMs: PLAYBACK_COMMIT_CLOCK_WAIT_MS,
      });
      if (clock) return current();
      if (!current()) return false;
      if (activeTransition) clearServerPlaybackTransition(activeTransition);
      cancelProPlaybackPreparation(authority);
      await silenceUnappliedCanonicalRenderer(
        event,
        receivedAtMs,
        generation,
        authority,
        isRequestCurrent,
        null,
      );
      if (!current()) return false;
      failLocalPlaybackUiControlsForRevision(
        authority.roomId,
        authority.roomEpoch,
        playback.revision,
      );
      retryClockRecovery(playback.revision, current);
      return false;
    };

    if (preparation) {
      let prepared: ProPlaybackPrepareResult;
      try {
        const result = await preparation;
        prepared = result.media;
        clock = result.clock ?? clock;
      } catch (error) {
        cancelProPlaybackPreparation(authority);
        throw error;
      }
      if (!playbackCommitStillCurrent(event, generation, isRequestCurrent)) {
        cancelProPlaybackPreparation(authority);
        return;
      }
      if (!(await ensureClock())) return;
      if (prepared.status !== 'ready') {
        if (activeTransition) clearServerPlaybackTransition(activeTransition);
        // A YouTube restore and its catch-up share the snapshot authority.
        // Release the settled failure first, or the catch-up merely observes it
        // again and the participant stays silent until the next heartbeat. File
        // failures keep their single download/decode attempt per request.
        if (playback.youtubeVideoId !== null) cancelProPlaybackPreparation(authority);
        const catchup =
          prepared.reason === 'device-unavailable'
            ? null
            : await catchUpExactPlaybackCheckpoint(
                event,
                receivedAtMs,
                generation,
                context.roomId,
                context.epoch,
                isRequestCurrent,
                clock,
              );
        if (!playbackCommitStillCurrent(event, generation, isRequestCurrent)) return;
        if (catchup?.status !== 'applied') {
          await silenceUnappliedCanonicalRenderer(
            event,
            receivedAtMs,
            generation,
            authority,
            isRequestCurrent,
            clock,
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
        ports.runHeartbeat(true).catch((error) => {
          log.warn('[PRO Playback] Post-checkpoint heartbeat failed', error);
        });
        return;
      }
    }

    if (!(await ensureClock()) || !currentWithClock()) return;
    const plannedTiming =
      latePlan && clock ? plannedLateYouTubeTiming(playback, latePlan, clock) : null;
    const timing = plannedTiming ?? playbackCommitTiming(event, receivedAtMs, clock);
    // A prepared YouTube iframe released after its instant would seek during
    // release and start late by its seek latency. Re-arm through the catch-up
    // path at a fresh participant-local instant instead. Lateness within the
    // arm's no-seek tolerance still releases normally.
    const youtubeReleaseOverran =
      preparation !== null &&
      playback.state === 'playing' &&
      playback.youtubeVideoId !== null &&
      plannedTiming === null &&
      (latePlan !== null || timing.signedDelayMs < -LATE_YOUTUBE_RELEASE_TOLERANCE_MS);
    recordProStartObservation('playback-clock', {
      purpose: 'commit',
      revision: playback.revision,
      outcome: 'selected',
      sampleId: clock?.sampleId ?? null,
      generation: clock?.generation ?? null,
      offsetMs: clock?.offsetMs ?? null,
      rttMs: clock?.rttMs ?? null,
      signedDelayMs: timing.signedDelayMs,
      scheduleDelayMs: timing.scheduleDelayMs,
      state: playback.state,
    });
    let result: ProPlaybackCommitResult;
    if (youtubeReleaseOverran) {
      cancelProPlaybackPreparation(authority);
      result = { status: 'failed', authority, reason: 'timeout' };
    } else {
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
          isCurrent: currentWithClock,
        });
      } catch (error) {
        cancelProPlaybackPreparation(authority);
        throw error;
      }
      if (!playbackCommitStillCurrent(event, generation, isRequestCurrent)) {
        cancelProPlaybackPreparation(authority);
        return;
      }
    }

    // A direct pause/seek or a canonical transition whose resident media was
    // superseded can reach a freshly resumed endpoint before hydration. Clear
    // the failed transition and catch up from the exact committed checkpoint
    // immediately rather than waiting for the next heartbeat.
    if (
      result.status !== 'applied' &&
      result.reason !== 'device-unavailable' &&
      playback.state !== 'idle' &&
      playback.queueItemId
    ) {
      if (activeTransition) clearServerPlaybackTransition(activeTransition);
      result =
        (await catchUpExactPlaybackCheckpoint(
          event,
          receivedAtMs,
          generation,
          context.roomId,
          context.epoch,
          isRequestCurrent,
          clock,
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
        clock,
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
    ports.runHeartbeat(true).catch((error) => {
      log.warn('[PRO Playback] Post-COMMIT heartbeat failed', error);
    });
  }

  function acceptPlaybackCommit(
    event: ProRoomPlaybackCommitEvent,
    isRequestCurrent: PlaybackCommitOwner = canonicalPlaybackCommitOwner,
    clock: ProRoomClockSnapshot | null = null,
  ): void {
    const context = getState('room.context');
    if (
      !isRequestCurrent() ||
      !ports.isActive() ||
      context.kind !== 'pro' ||
      !context.roomId ||
      context.epoch !== event.playback.coordinatorEpoch
    ) {
      return;
    }
    // A newer PREPARE can arrive in an HTTP command response before an older
    // WebSocket COMMIT. Keep its media owner and commit generation intact.
    if (hasNewerServerPlaybackTransition(event.playback.revision)) return;
    if (event.playback.revision <= state.lastAppliedRevision) return;
    // A lower revision can arrive after a newer WebSocket frame when a heartbeat
    // snapshot and the live channel cross. Reject it before advancing the local
    // generation; otherwise it would cancel the newer COMMIT and then reject
    // itself against state.highestKnownRevision.
    if (event.playback.revision < state.highestKnownRevision) return;
    // Live COMMIT is authoritative before its follow-up heartbeat hydrates the
    // snapshot. Command identity must move with this checkpoint, not that GET.
    rememberCommandPlayback(context.roomId, event.playback);
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
          clock,
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
    // A running YouTube checkpoint this endpoint never saw PREPARE for (a late
    // join, a missed COMMIT, a retry) keeps the iframe silent while it prepares.
    // Show the shared transition loading state meanwhile, so the transport is a
    // spinner rather than a button that would act on the room.
    if (
      event.transitionId &&
      event.playback.state === 'playing' &&
      event.playback.youtubeVideoId !== null &&
      !(pendingUiTransitionId && state.transitionUiIds.has(pendingUiTransitionId))
    ) {
      beginPlaybackTransitionUi(event.transitionId);
    }
    state.highestKnownRevision = Math.max(state.highestKnownRevision, event.playback.revision);
    state.cancelledCheckpointRecovery = null;
    const generation = ++state.commitGeneration;
    cancelClockRequests(event.playback.revision);
    const transition = state.activeTransition;
    if (
      transition?.event.transitionId === event.transitionId &&
      transition.event.target.revision === event.playback.revision
    ) {
      transition.commitReceived = true;
    }
    if (
      transition &&
      transition.event.target.revision <= event.playback.revision &&
      (transition.event.transitionId !== event.transitionId ||
        transition.event.target.revision !== event.playback.revision)
    ) {
      clearServerPlaybackTransition(transition);
    }
    // A committed transition no longer has a server PREPARE to CANCEL. A later
    // pause/stop/snapshot must release its obsolete native preparation wait
    // before queuing, while actual endpoint COMMITs remain serialized below.
    cancelSupersededProPlaybackPreparation(
      playbackAuthorityFor(
        context.roomId,
        context.epoch,
        event.playback.revision,
        event.transitionId,
      ),
    );
    const operation = state.commitTail
      .then(
        () => applyPlaybackCommit(event, receivedAtMs, generation, isRequestCurrent, clock),
        () => applyPlaybackCommit(event, receivedAtMs, generation, isRequestCurrent, clock),
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
          acceptPlaybackCommit(followUp.event, followUp.owner, followUp.clock);
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
    canSubmit: () => boolean = () => true,
  ): Promise<void> {
    const context = getState('room.context');
    const snapshot = ports.getCanonicalSnapshot();
    if (
      !ports.isActive() ||
      !canSubmit() ||
      context.kind !== 'pro' ||
      !context.capabilities.includes('playback.control') ||
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
        (intent.kind === 'advance-sub-video' ||
        intent.kind === 'ended' ||
        intent.kind === 'unavailable'
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
    const preparationResponseGeneration = controlChannelGeneration;
    const preparationResponseStartedConnected = !controlChannelRecovering;
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
      const result = await executePlaybackCommandWithRecovery(
        {
          code: intent.roomId,
          command: commandForPlaybackIntent(intent, baseRevision),
          idempotencyKey: createProRoomIdempotencyKey(),
        },
        canSubmit,
      );
      if (!commandIsCurrent()) return;
      if (
        result.status === 'preparing' &&
        result.transition &&
        (preparationResponseGeneration !== controlChannelGeneration ||
          !preparationResponseStartedConnected) &&
        !sameServerTransition(state.activeTransition, result.transition)
      ) {
        // An HTTP PREPARE describes what was pending when that request was
        // accepted. Its CANCEL may have been missed while the socket was
        // offline. Only the recovered channel's exact pending transition can
        // retain this response; committed results still use the revision fence.
        settleLocalPlaybackUiControl(localUiControl, 'superseded');
        return;
      }
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
          restorePlaybackCheckpoint(
            result.playback,
            intent.roomId,
            intent.roomEpoch,
            canonicalPlaybackCommitOwner,
            result.serverTimeMs,
          );
          settleLocalPlaybackUiControl(localUiControl, 'applied', result.playback.positionSeconds);
        } else if (intent.kind === 'play' && result.playback.state === 'playing') {
          // The room can already be playing while a foregrounded WebKit iframe
          // is locally frozen. `unchanged` is correct server semantics, but the
          // initiating participant still needs the exact checkpoint re-applied.
          // YouTube rejoins through the planned local rendezvous; a direct
          // seek-and-play would start late by the iframe's seek latency.
          const reconciled = await reapplyCurrentPlaybackCheckpoint(
            result.playback,
            intent.roomId,
            intent.roomEpoch,
            result.serverTimeMs,
            result.playback.youtubeVideoId !== null,
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
    const authorityGeneration = commandAuthorityGeneration;
    const canSubmit = () =>
      authorityGeneration === commandAuthorityGeneration &&
      getState('room.context').capabilities.includes('playback.control');
    const submit = async () => {
      if (commandGeneration !== state.commandGeneration || !canSubmit()) return;
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
        canSubmit,
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
    const authorityGeneration = commandAuthorityGeneration;
    const seekSource = intent.kind === 'seek' ? getCommandPlayback() : null;
    const seekMediaGeneration = commandMediaGeneration;
    const canSubmit = (): boolean => {
      if (
        authorityGeneration !== commandAuthorityGeneration ||
        !getState('room.context').capabilities.includes('playback.control')
      )
        return false;
      if (intent.kind !== 'seek') return true;
      const playback = getCommandPlayback();
      // Seek is a position in the media the gesture targeted, not a position
      // in whichever row/sub-video happens to own the queue after an HTTP wait.
      return Boolean(
        seekSource &&
        playback &&
        seekMediaGeneration === commandMediaGeneration &&
        seekSource.queueItemId === intent.queueItemId &&
        playback.queueItemId === intent.queueItemId &&
        playback.youtubeSubIndex === seekSource.youtubeSubIndex &&
        playback.youtubeVideoId === seekSource.youtubeVideoId,
      );
    };
    const submit = () => {
      if (commandGeneration !== state.commandGeneration || !canSubmit()) {
        if (intent.clientUiControlToken) {
          settleProPlaybackUiControl(intent.clientUiControlToken, 'failed');
        }
        return Promise.resolve();
      }
      return submitPlaybackIntent(intent, exactBaseRevision, canSubmit);
    };
    // A playlist removal sent just before this navigation must reach the
    // Worker first; it never rejects and gives up after a bounded wait.
    const navigates =
      intent.kind !== 'play' &&
      intent.kind !== 'pause' &&
      intent.kind !== 'seek' &&
      intent.kind !== 'stop';
    const removal = navigates ? pendingProQueueRemoval() : null;
    const tail = removal ? state.commandTail.then(() => removal) : state.commandTail;
    const operation = tail.then(submit, submit);
    state.commandTail = operation.catch(() => undefined);
    return operation;
  }

  function restorePlaybackCheckpoint(
    playback: ProRoomPlaybackCheckpoint,
    roomCode: string,
    roomEpoch: number,
    isRequestCurrent: () => boolean = canonicalPlaybackCommitOwner,
    observedServerTimeMs = getProRoomServerNow(),
    clock: ProRoomClockSnapshot | null = null,
  ): void {
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
    if (!isRequestCurrent() || hasNewerServerPlaybackTransition(playback.revision)) {
      return;
    }
    const target = transition?.event.target;
    // A direct commit can replace PREPARE at its reserved next revision. Reuse
    // preparation only for the same checkpoint; commit time itself may change.
    const preparedTransition =
      target?.coordinatorEpoch === playback.coordinatorEpoch &&
      target.revision === playback.revision &&
      target.queueItemId === playback.queueItemId &&
      target.state === playback.state &&
      target.positionSeconds === playback.positionSeconds &&
      target.youtubeVideoId === playback.youtubeVideoId &&
      target.youtubeSubIndex === playback.youtubeSubIndex
        ? transition
        : null;
    acceptPlaybackCommit(
      {
        type: 'pro-playback-commit',
        transitionId: preparedTransition?.event.transitionId ?? `snapshot_${playback.revision}`,
        serverTimeMs: playback.state === 'playing' ? observedServerTimeMs : 0,
        // Paused/idle snapshots restore immediately, including when the clock
        // becomes calibrated while local media preparation is still pending.
        executeAtMs: playback.state === 'playing' ? playback.updatedAtMs : 0,
        playback,
      },
      isRequestCurrent,
      clock,
    );
  }

  async function restorePersistedPlayback(
    snapshot: ProRoomSnapshot,
    isRequestCurrent: () => boolean = canonicalPlaybackCommitOwner,
  ): Promise<void> {
    const snapshotOwner = snapshotPlaybackOwner;
    // Reuse the default owner identity so repeated heartbeat snapshots still
    // coalesce. A caller's narrower reconciliation lifetime remains in force.
    const restoreIsCurrent =
      isRequestCurrent === canonicalPlaybackCommitOwner
        ? snapshotOwner
        : () => snapshotOwner() && isRequestCurrent();
    const lease = ports.capturePlaylistLease();
    if (
      !restoreIsCurrent() ||
      !lease ||
      lease.roomCode !== snapshot.roomCode ||
      !ports.isPlaylistLeaseCurrent(lease)
    ) {
      return;
    }
    state.highestKnownRevision = Math.max(state.highestKnownRevision, snapshot.playback.revision);
    const clock =
      snapshot.playback.state === 'playing'
        ? await acquirePlaybackClock({
            revision: snapshot.playback.revision,
            purpose: 'restore',
            isCurrent: () => restoreIsCurrent() && ports.isPlaylistLeaseCurrent(lease),
            timeoutMs: PLAYBACK_RECONCILIATION_CLOCK_WAIT_MS,
          })
        : null;
    if (snapshot.playback.state === 'playing' && !clock) return;
    if (!restoreIsCurrent() || !ports.isPlaylistLeaseCurrent(lease)) return;
    if (snapshot.playback.revision === state.lastAppliedRevision) {
      await recoverCancelledAppliedPlaybackCheckpoint(
        snapshot.playback,
        snapshot.roomCode,
        snapshot.presence.coordinatorEpoch,
        restoreIsCurrent,
        true,
        clock,
      );
      return;
    }
    await restorePlaybackCheckpoint(
      snapshot.playback,
      snapshot.roomCode,
      snapshot.presence.coordinatorEpoch,
      restoreIsCurrent,
      clock ? Date.now() + clock.offsetMs : 0,
      clock,
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

  function recoverCancelledAppliedPlaybackCheckpoint(
    playback: ProRoomPlaybackCheckpoint,
    roomCode: string,
    roomEpoch: number,
    isRequestCurrent: PlaybackCommitOwner,
    allowFollowUp = true,
    clock: ProRoomClockSnapshot | null = captureProRoomServerClockSnapshot(),
  ): Promise<ProPlaybackCommitResult | null> {
    const generation = state.commitGeneration;
    let flight: CancelledCheckpointRecoveryFlight | null = null;
    const isCurrent = () =>
      (flight === null || state.cancelledCheckpointRecovery === flight) &&
      isRequestCurrent() &&
      (playback.state !== 'playing' || (clock !== null && isProRoomClockSnapshotCurrent(clock))) &&
      playbackReconciliationStillCurrent(playback, roomCode, roomEpoch, generation) &&
      canonicalCheckpointMatches(playback, roomCode, roomEpoch);
    if (!isCurrent() || playback.state === 'idle' || !playback.queueItemId) {
      return Promise.resolve(null);
    }
    const existing = state.cancelledCheckpointRecovery;
    if (
      existing &&
      existing.roomCode === roomCode &&
      existing.roomEpoch === roomEpoch &&
      existing.generation === generation &&
      canonicalCheckpointMatches(existing.playback, roomCode, roomEpoch)
    ) {
      // Independent heartbeat/rejoin owners may wait on the same renderer, but
      // a follower must never replace or extend the original owner's liveness.
      const afterRecovery = (result: ProPlaybackCommitResult | null) => {
        if (!isCurrent()) return null;
        if (
          result?.status === 'applied' ||
          !allowFollowUp ||
          !hasCancelledProPlaybackCheckpointRecovery(roomCode, roomEpoch, playback.revision)
        )
          return result;
        return recoverCancelledAppliedPlaybackCheckpoint(
          playback,
          roomCode,
          roomEpoch,
          isRequestCurrent,
          false,
          clock,
        );
      };
      return existing.promise.then(afterRecovery, () => afterRecovery(null));
    }
    if (!hasCancelledProPlaybackCheckpointRecovery(roomCode, roomEpoch, playback.revision)) {
      return Promise.resolve(null);
    }
    const authority = playbackAuthorityFor(
      roomCode,
      roomEpoch,
      playback.revision,
      `snapshot_${playback.revision}`,
    );
    const timing = () => ({
      positionSeconds:
        playback.state === 'playing'
          ? playback.positionSeconds +
            Math.max(0, Date.now() + clock!.offsetMs - playback.updatedAtMs) / 1_000
          : playback.positionSeconds,
      scheduleDelayMs: 0,
    });
    flight = {
      playback,
      roomCode,
      roomEpoch,
      generation,
      isCurrent,
      promise: Promise.resolve(null),
    };
    state.cancelledCheckpointRecovery = flight;
    const request = {
      authority,
      committedPlaybackRevision: playback.revision,
      queueItemId: playback.queueItemId,
      state: playback.state,
      ...timing(),
      timingMode: 'scheduled-control' as const,
      youtubeSubIndex: playback.youtubeSubIndex,
      youtubeVideoId: playback.youtubeVideoId,
      isCurrent,
    };
    const reportRecoveredDuration = captureFileDurationReporter(request, isCurrent);
    const operation = recoverCancelledProPlaybackCheckpoint(
      request,
      timing,
      reportRecoveredDuration,
    )
      .then(async (result) => {
        if (result.reason === 'device-unavailable' && isCurrent()) {
          await invalidateCommittedProPlaybackMedia({ ...request, ...timing() });
        }
        return result;
      })
      .finally(() => {
        if (state.cancelledCheckpointRecovery === flight) state.cancelledCheckpointRecovery = null;
      });
    flight.promise = operation;
    return operation;
  }

  /** Re-apply one exact server revision without manufacturing a new room event. */
  async function reapplyCurrentPlaybackCheckpoint(
    playback: ProRoomPlaybackCheckpoint,
    roomCode: string,
    roomEpoch: number,
    observedServerTimeMs: number,
    rendezvous: boolean,
    isRequestCurrent: () => boolean = canonicalPlaybackCommitOwner,
    preparePaused = false,
    clock: ProRoomClockSnapshot | null = captureProRoomServerClockSnapshot(),
  ): Promise<boolean> {
    if (
      !isRequestCurrent() ||
      (playback.state === 'playing' && (!clock || !isProRoomClockSnapshotCurrent(clock))) ||
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

    const cancelledRecovery = await recoverCancelledAppliedPlaybackCheckpoint(
      playback,
      roomCode,
      roomEpoch,
      isRequestCurrent,
      true,
      clock,
    );
    if (cancelledRecovery && cancelledRecovery.status !== 'applied') return false;
    // The heartbeat can have started recovery under this request's owner. Wait
    // for it, then retain explicit sync's own offset/rendezvous application.

    const generation = state.commitGeneration;
    const runningRendezvous = rendezvous && playback.state === 'playing';
    const prepareRenderer = runningRendezvous || (preparePaused && playback.state === 'paused');
    const createAuthority = () =>
      createProPlaybackAuthorityToken({
        roomId: roomCode,
        roomEpoch,
        basePlaybackRevision: playback.revision - 1,
        // A running manual sync uses a participant-local arm/release cycle. The
        // opaque ID never leaves this browser and cannot create a room revision.
        // A paused renderer destroyed by system audio also needs preparation;
        // its exact checkpoint is committed without a running timeline/lead.
        transitionId: prepareRenderer
          ? `local_sync_${playback.revision}_${++state.reconciliationSequence}`
          : null,
      });
    const authority = createAuthority();
    // `observedServerTimeMs` is either a timestamp carried by the command
    // response or a clock value read only after fresh calibration. Never mix an
    // uncalibrated local wall clock into this server-timeline calculation: a
    // manually skewed device clock could otherwise seek hours away.
    const serverNow = clock ? Date.now() + clock.offsetMs : observedServerTimeMs;
    const canonicalPositionNow =
      playback.state === 'playing'
        ? playback.positionSeconds + Math.max(0, serverNow - playback.updatedAtMs) / 1_000
        : playback.positionSeconds;
    const isCurrent = () =>
      isRequestCurrent() &&
      (playback.state !== 'playing' || (clock !== null && isProRoomClockSnapshotCurrent(clock))) &&
      playbackReconciliationStillCurrent(playback, roomCode, roomEpoch, generation);
    if (!isCurrent()) return false;

    if (prepareRenderer) {
      // A YouTube iframe that seeks at the release instant starts late by its
      // seek latency. Like a server PREPARE/COMMIT, choose the release instant
      // first and settle at that exact position so release only plays. Files
      // keep the post-preparation projection; their scheduled start never seeks.
      const planYouTubeRelease =
        runningRendezvous && clock !== null && playback.youtubeVideoId !== null;
      // The arm pauses this iframe while it prepares. Show the shared loading
      // state meanwhile, so the transport is a spinner rather than a Play button
      // over a silent endpoint (foreground recovery, Sync, a rejoining Play).
      const rejoinUiId = planYouTubeRelease ? `local_rejoin_${++localRejoinUiSequence}` : null;
      if (rejoinUiId) beginPlaybackTransitionUi(rejoinUiId);
      try {
        let attemptAuthority = authority;
        for (let attempt = 1; ; attempt += 1) {
          const plannedExecuteAtMs =
            planYouTubeRelease && clock
              ? Date.now() + clock.offsetMs + localYouTubeRejoinLeadMs()
              : null;
          const preparationStartedAtMs = performance.now();
          let prepared: ProPlaybackPrepareResult;
          try {
            prepared = await prepareWithDurationReport(
              {
                authority: attemptAuthority,
                queueItemId: playback.queueItemId,
                positionSeconds:
                  plannedExecuteAtMs === null
                    ? canonicalPositionNow
                    : positionAtServerTime(playback, plannedExecuteAtMs),
                youtubeSubIndex: playback.youtubeSubIndex,
                youtubeVideoId: playback.youtubeVideoId,
                isCurrent,
              },
              isCurrent,
              prepareCurrentProPlaybackRendezvousAuthority,
            );
          } catch (error) {
            cancelProPlaybackPreparation(attemptAuthority);
            throw error;
          }
          if (prepared.status !== 'ready' || !isCurrent()) {
            cancelProPlaybackPreparation(attemptAuthority);
            // The arm paused this endpoint while preparing. A YouTube rejoin that
            // only timed out on a present player must not leave a running room
            // silent here until the next server transition; rejoin directly
            // (late, but audible) instead. A missing or locked player cannot.
            if (
              planYouTubeRelease &&
              prepared.status === 'failed' &&
              prepared.reason === 'timeout' &&
              clock &&
              isCurrent()
            ) {
              return await reconcileDirectly(
                createProPlaybackAuthorityToken({
                  roomId: roomCode,
                  roomEpoch,
                  basePlaybackRevision: playback.revision - 1,
                  transitionId: null,
                }),
                positionAtServerTime(playback, Date.now() + clock.offsetMs),
              );
            }
            return false;
          }
          if (plannedExecuteAtMs !== null) {
            recordLocalYouTubePreparation(performance.now() - preparationStartedAtMs);
          }

          const releaseNowMs = clock ? Date.now() + clock.offsetMs : observedServerTimeMs;
          let executeAtMs: number;
          if (
            plannedExecuteAtMs !== null &&
            plannedExecuteAtMs - releaseNowMs >= LOCAL_YOUTUBE_REJOIN_MIN_RELEASE_MS
          ) {
            executeAtMs = plannedExecuteAtMs;
          } else if (plannedExecuteAtMs !== null && attempt === 1) {
            // Preparation overran its planned instant. The iframe is warm now, so
            // re-arm once at a fresh (re-measured) instant instead of seeking
            // during release.
            cancelProPlaybackPreparation(attemptAuthority);
            if (!isCurrent()) return false;
            attemptAuthority = createAuthority();
            continue;
          } else {
            // Files, paused renderers, and a second YouTube overrun: rebase the
            // target after preparation, then release at one future server instant
            // so this endpoint rejoins the running timeline rather than
            // hard-seeking at an arbitrary response-arrival time.
            executeAtMs =
              releaseNowMs + (runningRendezvous ? PLAYBACK_RECONCILIATION_RENDEZVOUS_LEAD_MS : 0);
          }
          const rendezvousPosition = positionAtServerTime(playback, executeAtMs);
          if (!isCurrent()) {
            cancelProPlaybackPreparation(attemptAuthority);
            return false;
          }
          let result: ProPlaybackCommitResult;
          try {
            result = await rendezvousCurrentProPlaybackAuthority({
              authority: attemptAuthority,
              committedPlaybackRevision: playback.revision,
              queueItemId: playback.queueItemId,
              state: playback.state,
              positionSeconds: rendezvousPosition,
              scheduleDelayMs: Math.max(0, executeAtMs - releaseNowMs),
              timingMode: 'scheduled-control',
              youtubeSubIndex: playback.youtubeSubIndex,
              youtubeVideoId: playback.youtubeVideoId,
              isCurrent,
            });
          } catch (error) {
            cancelProPlaybackPreparation(attemptAuthority);
            throw error;
          }
          if (result.status !== 'applied') cancelProPlaybackPreparation(attemptAuthority);
          return result.status === 'applied' && isCurrent();
        }
      } finally {
        if (rejoinUiId) settlePlaybackTransitionUi(rejoinUiId);
      }
    }

    return reconcileDirectly(authority, canonicalPositionNow);

    async function reconcileDirectly(
      directAuthority: ProPlaybackAuthorityToken,
      positionSeconds: number,
    ): Promise<boolean> {
      if (!isCurrent()) return false;
      const result = await reconcileCurrentProPlaybackAuthority({
        authority: directAuthority,
        committedPlaybackRevision: playback.revision,
        queueItemId: playback.queueItemId,
        state: playback.state,
        positionSeconds,
        scheduleDelayMs: 0,
        timingMode: 'scheduled-control',
        youtubeSubIndex: playback.youtubeSubIndex,
        youtubeVideoId: playback.youtubeVideoId,
        isCurrent,
      });
      return result.status === 'applied' && isCurrent();
    }
  }

  function reconciliationOptionsCover(
    running: Readonly<PlaybackReconciliationOptions>,
    requested: Readonly<PlaybackReconciliationOptions>,
  ): boolean {
    return (
      (!running.youtubeOnly || requested.youtubeOnly) &&
      (running.rendezvous || !requested.rendezvous) &&
      (running.preparePaused || !requested.preparePaused)
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
      preparePaused: left.preparePaused || right.preparePaused,
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

      let clock: ProRoomClockSnapshot | null = null;
      if (playback.state === 'playing') {
        // Heartbeat snapshots intentionally omit a wall-clock field. Require a
        // fresh control-channel sample before extrapolating a running checkpoint;
        // paused/idle checkpoints carry an exact position and need no clock.
        // The timeout is duration-based and therefore independent of a skewed
        // client Date clock.
        if (!requestStillCurrent()) return false;
        clock = await acquirePlaybackClock({
          revision: playback.revision,
          purpose: 'reconcile',
          isCurrent: requestStillCurrent,
          timeoutMs: PLAYBACK_RECONCILIATION_CLOCK_WAIT_MS,
          fresh: true,
          serverDeadlineAtMs: Number.MAX_SAFE_INTEGER,
        });
        if (!requestStillCurrent() || !clock) return false;
      }

      if (playback.revision > state.lastAppliedRevision) {
        if (!requestStillCurrent()) return false;
        await restorePlaybackCheckpoint(
          playback,
          snapshot.roomCode,
          snapshot.presence.coordinatorEpoch,
          requestStillCurrent,
          clock ? Date.now() + clock.offsetMs : 0,
          clock,
        );
        if (!requestStillCurrent()) return false;
        const commit = state.commitInFlight.get(playback.revision);
        if (commit) await commit.promise;
        return requestStillCurrent() && playback.revision === state.lastAppliedRevision;
      }
      if (playback.revision < state.lastAppliedRevision) return false;
      if (!requestStillCurrent()) return false;
      // A same-revision restore can have applied while its release and
      // bookkeeping are still settling. Let it finish rather than report this
      // explicit request as not ready, then re-arm from the settled state.
      const settling = state.commitInFlight.get(playback.revision);
      if (settling) {
        await settling.promise.catch(() => undefined);
        if (!requestStillCurrent()) return false;
      }
      return reapplyCurrentPlaybackCheckpoint(
        playback,
        snapshot.roomCode,
        snapshot.presence.coordinatorEpoch,
        clock ? Date.now() + clock.offsetMs : 0,
        options.rendezvous,
        requestStillCurrent,
        options.preparePaused,
        clock,
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
      preparePaused?: boolean;
      liveness?: ProRoomPlaybackReconciliationLiveness;
    }>,
  ): Promise<boolean> {
    const normalized: PlaybackReconciliationOptions = {
      showLoading: false,
      youtubeOnly: options.youtubeOnly,
      rendezvous: options.rendezvous,
      preparePaused: options.preparePaused ?? false,
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
    cancelClockRequests();
    clockRecoveryRevision = -1;
    localYouTubePreparationSamples.length = 0;
    resetDurationReports();
    controlChannelGeneration += 1;
    controlChannelRecovering = false;
    invalidateSnapshotPlaybackOwner();
    commandPlayback = null;
    commandMediaGeneration += 1;
    state.cancelledCheckpointRecovery = null;
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
    cancelClockRequests();
    clockRecoveryRevision = -1;
    resetDurationReports();
    controlChannelGeneration += 1;
    controlChannelRecovering = false;
    unregisterSystemAudioState?.();
    unregisterSystemAudioState = null;
    snapshotPlaybackBlocked = false;
    invalidateSnapshotPlaybackOwner();
    commandPlayback = null;
    commandMediaGeneration += 1;
    state.cancelledCheckpointRecovery = null;
    unregisterLocalTimeline?.();
    unregisterLocalTimeline = null;
    unregisterCommandAuthority?.();
    unregisterCommandAuthority = null;
    commandAuthorityGeneration += 1;
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
    unregisterSystemAudioState?.();
    invalidateSnapshotPlaybackOwner();
    unregisterSystemAudioState = bus.on(
      'pro-system-audio:state-changed',
      observeSystemAudioOwnership,
    );
    observeSystemAudioOwnership(getProSystemAudioViewState());
    unregisterCommandAuthority?.();
    unregisterCommandAuthority = bus.on('state:room.context', () => {
      const context = getState('room.context');
      // A revoke/regrant cycle must not revive queued gestures. Canonical
      // PREPARE/COMMIT handling remains independent of this local authority.
      if (context.kind !== 'pro' || !context.capabilities.includes('playback.control')) {
        commandAuthorityGeneration += 1;
      }
    });
    unregisterLocalTimeline?.();
    unregisterLocalTimeline = registerProRoomLocalPlaybackTimeline({
      getSnapshot: ports.getCanonicalSnapshot,
      getServerNow: getProRoomServerNow,
      isClockCalibrated: isProRoomServerClockCalibrated,
      captureLiveness(revision) {
        const lease = ports.capturePlaylistLease();
        const generation = state.commitGeneration;
        const roomSignal = ports.getRoomAbortSignal();
        if (!lease) return null;
        return () =>
          ports.isActive() &&
          !roomSignal?.aborted &&
          ports.isPlaylistLeaseCurrent(lease) &&
          generation === state.commitGeneration &&
          revision === state.lastAppliedRevision &&
          revision === state.highestKnownRevision &&
          !state.activeTransition &&
          state.commitInFlight.size === 0 &&
          !state.cancelledCheckpointRecovery &&
          !state.reconciliationInFlight;
      },
    });
    state.unregisterCommandHandler?.();
    state.unregisterCommandHandler = registerProPlaybackCommandHandler((intent) =>
      enqueuePlaybackIntent(intent),
    );
  }

  function beginControlChannelRecovery(): number {
    cancelClockRequests();
    controlChannelGeneration += 1;
    controlChannelRecovering = true;
    const transition = state.activeTransition;
    if (transition && !state.commitInFlight.has(transition.event.target.revision)) {
      transition.clockAbort.abort();
      cancelProPlaybackPreparation(transition.authority);
      if (state.activeTransition === transition) {
        state.activeTransition = null;
        settlePlaybackTransitionUi(transition.event.transitionId);
      }
    }
    return controlChannelGeneration;
  }

  function completeControlChannelRecovery(generation: number): void {
    if (generation === controlChannelGeneration) controlChannelRecovering = false;
  }

  function resolveProjectedQueueItemId(snapshot: ProRoomSnapshot): QueueItemId | null {
    const transition = state.activeTransition;
    const context = getState('room.context');
    const target = transition?.event.target.queueItemId;
    if (
      !transition ||
      !target ||
      !ports.isActive() ||
      transition.clockAbort.signal.aborted ||
      context.kind !== 'pro' ||
      context.roomId !== snapshot.roomCode ||
      transition.authority.roomId !== snapshot.roomCode ||
      transition.authority.roomEpoch !== context.epoch ||
      snapshot.playback.coordinatorEpoch !== context.epoch ||
      snapshot.playback.revision !== transition.event.basePlaybackRevision ||
      getState('playlist.currentQueueItemId') !== target
    ) {
      return snapshot.currentQueueItemId;
    }

    // A queue-only mutation still describes the committed selection, while
    // the local endpoint may already be preparing the server's next target.
    // Retain only that exact live target with an unchanged canonical source;
    // deletion, source replacement, and newer playback remain authoritative.
    const previous = ports
      .getPlaylistSnapshot()
      ?.playlist.find((item) => item.queueItemId === target);
    const incoming = snapshot.playlist.find((item) => item.queueItemId === target);
    return previous &&
      incoming &&
      JSON.stringify(previous.source) === JSON.stringify(incoming.source)
      ? target
      : snapshot.currentQueueItemId;
  }

  return {
    resolveProjectedQueueItemId,
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
    completeControlChannelRecovery,
  };
}

/** Owns the PRO playback prepare/commit/intent/reconciliation state machine. */
export class ProRoomPlaybackController {
  private readonly state = createInitialState();
  private readonly implementation: ProRoomPlaybackImplementation;

  constructor(ports: ProRoomPlaybackControllerPorts) {
    this.implementation = createImplementation(ports, this.state);
  }

  resolveProjectedQueueItemId(snapshot: ProRoomSnapshot): QueueItemId | null {
    return this.implementation.resolveProjectedQueueItemId(snapshot);
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
      preparePaused?: boolean;
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

  beginControlChannelRecovery(): number {
    return this.implementation.beginControlChannelRecovery();
  }

  completeControlChannelRecovery(generation: number): void {
    this.implementation.completeControlChannelRecovery(generation);
  }
}
