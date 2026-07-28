import { getPrimedFilePlaybackProductAudio } from '../audio/file-playback-audio-readiness.ts';
import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState, setState } from '../core/state.ts';
import {
  resolveProRoomPlaylistRangeSource,
  restoreProRoomLegacyPlayback,
} from '../pro-room/legacy-media-hooks.ts';
import { ProRoomMediaRangeCompatibilityError } from '../pro-room/media-transfer.ts';
import { getProRoomServerNow } from '../pro-room/network-bridge.ts';
import {
  getProPlaybackAuthorityKey,
  isProPlaybackAuthorityToken,
  routeProPlaybackCommand,
  type ProPlaybackAuthorityToken,
  type ProPlaybackCommitRequest,
  type ProPlaybackPrepareRequest,
} from '../pro-room/playback-authority-hooks.ts';
import type { QueueItemId } from '../types/index.ts';
import { getFilePlaybackBuildProfile } from './file-playback-build-profile.ts';
import {
  FilePlaybackManager,
  type FilePlaybackCutoverCandidatePort,
} from './file-playback-manager.ts';
import { transition } from './lifecycle.ts';
import { isExternalOwner } from './ownership.ts';
import {
  createEncodedFilePlaybackSource,
  UnsupportedOrdinaryEncodedSourceError,
  type BlobFilePlaybackSourceResult,
  type CreateEncodedFilePlaybackSourceOptions,
} from './file-playback-source-factory.ts';
import {
  createFilePlaybackCutoverTarget,
  type FilePlaybackCutoverSource,
  type FilePlaybackPosition,
  type FilePlaybackSourceSnapshot,
} from './file-playback-source.ts';
import type { EncodedAudioSource } from './sources/encoded-audio-source.ts';

const DEFAULT_PREPARE_BUDGET_MS = 2_000;
const PREPARE_COMMIT_RESERVE_MS = 200;
// Participant-local catch-up has no server PREPARE deadline. Reserve a bounded
// future horizon before the one-shot exact prime so an ordinary mobile
// decoder/range stall can finish without turning the arm target into the past.
// This applies only to snapshot/manual-sync catch-up; server PREPARE keeps its
// exact deadline. Missing the 750ms horizon fails closed instead of drifting.
const LOCAL_CATCHUP_HORIZON_MS = 750;
const MIN_TRANSITION_LEAD_MS = 30;
const OBSERVER_INTERVAL_MS = 100;

type ProRoomBoundedPrepareOutcome =
  | Readonly<{
      status: 'ready';
      durationSeconds: number | null;
    }>
  | Readonly<{ status: 'fallback' }>
  | Readonly<{ status: 'superseded' }>;

type ProRoomBoundedCommitOutcome =
  | Readonly<{
      status: 'applied';
      phase: 'playing' | 'paused' | 'idle';
      durationSeconds: number | null;
      positionSeconds: number;
    }>
  | Readonly<{ status: 'failed' | 'superseded' }>
  | null;

interface ProRoomBoundedAudioRuntime {
  readonly audioContext: AudioContext;
  readonly destination: AudioNode;
}

interface PreparedCandidate {
  readonly authority: ProPlaybackAuthorityToken;
  readonly authorityKey: string;
  readonly queueItemId: QueueItemId;
  readonly basePositionSeconds: number;
  positionSeconds: number;
  readonly minimumStartLeadMs: number;
  readonly controller: AbortController;
  readonly loadingToken: string;
  readonly authorityFence: { live: boolean; committed: boolean };
  port: FilePlaybackCutoverCandidatePort | null;
  preparePromise: Promise<ProRoomBoundedPrepareOutcome> | null;
  primedPositionSeconds: number | null;
  durationSeconds: number | null;
  loadingSettled: boolean;
  audioContext: AudioContext | null;
}

interface CurrentRenderer {
  readonly port: FilePlaybackCutoverCandidatePort;
  readonly roomId: string;
  readonly roomEpoch: number;
  readonly queueItemId: QueueItemId;
  committedPlaybackRevision: number;
  readonly audioContext: AudioContext;
  canonicalPhase: 'playing' | 'paused';
  endedSubmitted: boolean;
  recovering: boolean;
}

interface ProRoomBoundedPlaybackDependencies {
  readonly resolveRangeSource: (
    queueItemId: QueueItemId,
    signal: AbortSignal,
  ) => Promise<EncodedAudioSource | null> | null;
  readonly createSource: (
    options: CreateEncodedFilePlaybackSourceOptions,
  ) => Promise<BlobFilePlaybackSourceResult>;
  readonly getAudioRuntime: () => Promise<ProRoomBoundedAudioRuntime | null>;
  readonly nowRoomTimeMs: () => number;
  readonly routeEnded: typeof routeProPlaybackCommand;
  readonly restoreLegacy: typeof restoreProRoomLegacyPlayback;
  readonly getBuildProfile: typeof getFilePlaybackBuildProfile;
}

function defaultDependencies(): ProRoomBoundedPlaybackDependencies {
  return {
    resolveRangeSource: resolveProRoomPlaylistRangeSource,
    createSource: createEncodedFilePlaybackSource,
    getAudioRuntime: async () => getPrimedFilePlaybackProductAudio().catch(() => null),
    nowRoomTimeMs: () => getProRoomServerNow(),
    routeEnded: routeProPlaybackCommand,
    restoreLegacy: restoreProRoomLegacyPlayback,
    getBuildProfile: getFilePlaybackBuildProfile,
  };
}

function isCompatibilityFailure(error: unknown): boolean {
  if (
    error instanceof UnsupportedOrdinaryEncodedSourceError ||
    error instanceof ProRoomMediaRangeCompatibilityError
  ) {
    return true;
  }
  const name =
    error && typeof error === 'object' && 'name' in error
      ? String((error as { name?: unknown }).name ?? '')
      : '';
  return name === 'NotSupportedError' || name.endsWith('UnavailableError');
}

function resolveRangeSourceWithAbort(
  promise: PromiseLike<EncodedAudioSource | null>,
  signal: AbortSignal,
): Promise<EncodedAudioSource | null> {
  const abortReason = () =>
    signal.reason ?? new DOMException('PRO bounded preparation aborted', 'AbortError');
  if (signal.aborted) {
    // The resolver can be backed by a shared heartbeat that intentionally
    // outlives this candidate. Retire a source that arrives after cancellation
    // instead of leaking its transport lifetime.
    void Promise.resolve(promise).then(
      (source) => source?.close().catch(() => undefined),
      () => undefined,
    );
    return Promise.reject(abortReason());
  }
  return new Promise<EncodedAudioSource | null>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(abortReason());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (source) => {
        if (settled) {
          void source?.close().catch(() => undefined);
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(source);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function settlePreparationWithAbort<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException('PRO bounded preparation aborted', 'AbortError'),
    );
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new DOMException('PRO bounded preparation aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function clampPosition(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function sameAuthority(left: ProPlaybackAuthorityToken, right: ProPlaybackAuthorityToken): boolean {
  return getProPlaybackAuthorityKey(left) === getProPlaybackAuthorityKey(right);
}

function boundedRunId(request: Readonly<ProPlaybackCommitRequest>): string {
  return `pro-${request.authority.roomEpoch}-${request.committedPlaybackRevision}`;
}

function boundedRendezvousId(request: Readonly<ProPlaybackCommitRequest>): string {
  const transition = request.authority.transitionId ?? 'snapshot';
  return `pro-${request.committedPlaybackRevision}-${transition}`.slice(0, 256);
}

/**
 * PRO owns a distinct manager instance. It reuses the renderer primitives but
 * cannot claim the standard-room product singleton or its controller state.
 */
class ProRoomBoundedPlaybackAdapter {
  readonly #manager = new FilePlaybackManager();
  readonly #dependencies: ProRoomBoundedPlaybackDependencies;
  #prepared: PreparedCandidate | null = null;
  #current: CurrentRenderer | null = null;
  #epoch = 0;
  #observer: ReturnType<typeof globalThis.setInterval> | null = null;

  constructor(dependencies: ProRoomBoundedPlaybackDependencies = defaultDependencies()) {
    this.#dependencies = dependencies;
  }

  hasCurrent(queueItemId?: QueueItemId): boolean {
    const current = this.#current;
    if (!current || this.#manager.currentCutoverPort() !== current.port) return false;
    const snapshot = this.#manager.currentCutoverSnapshot(current.port);
    return !!snapshot && (queueItemId === undefined || snapshot.queueItemId === queueItemId);
  }

  currentSnapshot(): FilePlaybackSourceSnapshot | null {
    const current = this.#current;
    return current ? this.#manager.currentCutoverSnapshot(current.port) : null;
  }

  currentPosition(): FilePlaybackPosition | null {
    const current = this.#current;
    return current ? this.#manager.currentCutoverPosition(current.port, performance.now()) : null;
  }

  #settleLoading(candidate: PreparedCandidate): void {
    if (candidate.loadingSettled) return;
    candidate.loadingSettled = true;
    bus.emit('player:v2-file-loading-settled', {
      owner: 'pro-prepare',
      token: candidate.loadingToken,
    });
  }

  async #retirePrepared(candidate: PreparedCandidate): Promise<void> {
    candidate.authorityFence.live = false;
    if (!candidate.controller.signal.aborted) {
      candidate.controller.abort(new DOMException('PRO bounded preparation retired', 'AbortError'));
    }
    this.#settleLoading(candidate);
    if (this.#prepared === candidate) this.#prepared = null;
    if (candidate.port) {
      await this.#manager.retireCutoverCandidate(candidate.port).catch(() => false);
    }
  }

  cancel(authority?: ProPlaybackAuthorityToken): void {
    const candidate = this.#prepared;
    if (!candidate || (authority && !sameAuthority(candidate.authority, authority))) return;
    void this.#retirePrepared(candidate);
  }

  async clear(): Promise<void> {
    this.#epoch += 1;
    const candidate = this.#prepared;
    this.#prepared = null;
    if (candidate) {
      candidate.authorityFence.live = false;
      if (!candidate.controller.signal.aborted) {
        candidate.controller.abort(new DOMException('PRO bounded playback cleared', 'AbortError'));
      }
      this.#settleLoading(candidate);
    }
    this.#stopObserver();
    this.#current = null;
    await this.#manager.clear();
  }

  /**
   * The server has committed a newer checkpoint, but this participant could
   * not prepare/apply its media. The outgoing renderer is now stale room truth
   * and must not remain audible indefinitely. Retire only that exact current
   * port; a newer candidate/current is never broadly cleared.
   */
  async invalidateCommitted(request: Readonly<ProPlaybackCommitRequest>): Promise<void> {
    const observedEpoch = this.#epoch;
    const current = this.#current;
    const snapshot = current ? this.#manager.currentCutoverSnapshot(current.port) : null;
    if (
      !current ||
      !snapshot?.run ||
      request.isCurrent?.() === false ||
      request.authority.roomId !== current.roomId ||
      request.authority.roomEpoch !== current.roomEpoch ||
      request.committedPlaybackRevision <= current.committedPlaybackRevision
    ) {
      return;
    }
    try {
      if (request.committedPlaybackRevision === current.committedPlaybackRevision + 1) {
        const delayMs = Number.isFinite(request.scheduleDelayMs)
          ? Math.max(0, Math.min(30_000, request.scheduleDelayMs))
          : 0;
        const atRoomTimeMs =
          this.#dependencies.nowRoomTimeMs() + Math.max(MIN_TRANSITION_LEAD_MS, delayMs);
        const contextTimeSeconds =
          current.audioContext.currentTime +
          (atRoomTimeMs - this.#dependencies.nowRoomTimeMs()) / 1_000;
        const stopped = await this.#manager.stopCurrentCutover(current.port, {
          kind: 'file-playback-stop-transition',
          from: snapshot.run,
          to: {
            queueItemId: snapshot.run.queueItemId,
            runId: snapshot.run.runId,
            revision: request.committedPlaybackRevision,
          },
          atRoomTimeMs,
          target: createFilePlaybackCutoverTarget(
            current.audioContext,
            contextTimeSeconds,
            Math.round(contextTimeSeconds * current.audioContext.sampleRate),
          ),
        });
        await stopped.applied;
      } else {
        // A resumed endpoint can observe a revision gap. No fabricated
        // transition identity is safe in that case; exact-port retirement is.
        await this.#manager.retireExactCutoverPort(current.port);
      }
    } catch (error) {
      log.warn('[PRO Playback] Failed to retire stale bounded renderer', error);
      // Some stop preflight failures (for example an already-pending current
      // transition) deliberately preserve the current renderer. Canonical
      // truth has nevertheless advanced, so fail silent by retiring only this
      // exact stale port. A successor candidate owns a different opaque port
      // and remains untouched.
      await this.#manager.retireExactCutoverPort(current.port).catch((retireError) => {
        log.warn('[PRO Playback] Failed to fail-silent stale bounded renderer', retireError);
      });
    }
    if (
      observedEpoch !== this.#epoch ||
      this.#current !== current ||
      this.#manager.currentCutoverPort() === current.port
    ) {
      return;
    }
    this.#current = null;
    this.#stopObserver();
    if (request.isCurrent?.() === false) return;
    transition({ type: 'PRODUCT_TIMELINE_RENDERED', phase: 'paused' });
    bus.emit('ui:update-play-state', false);
    bus.emit('visualizer:hold-frame');
  }

  async prepare(
    request: Readonly<ProPlaybackPrepareRequest>,
  ): Promise<ProRoomBoundedPrepareOutcome> {
    if (!isProPlaybackAuthorityToken(request.authority)) return { status: 'superseded' };
    const context = getState('room.context');
    if (
      context.kind !== 'pro' ||
      context.roomId !== request.authority.roomId ||
      context.epoch !== request.authority.roomEpoch ||
      request.isCurrent?.() === false
    ) {
      return { status: 'superseded' };
    }

    const buildProfile = this.#dependencies.getBuildProfile();
    if (buildProfile.engine !== 'v2') return { status: 'fallback' };

    if (this.#prepared && sameAuthority(this.#prepared.authority, request.authority)) {
      return this.#prepared.preparePromise ?? { status: 'superseded' };
    }
    if (this.#prepared) await this.#retirePrepared(this.#prepared);

    const current = this.currentSnapshot();
    if ((request.state ?? 'playing') === 'paused') {
      if (current?.queueItemId === request.queueItemId) {
        return { status: 'ready', durationSeconds: current.durationSeconds };
      }
      // A paused checkpoint needs no media bytes. Keep a metadata-only exact
      // authority slot so COMMIT can publish title/position (and retire an
      // outgoing renderer) without downloading the full R2 object. A later
      // PLAY performs ordinary bounded preparation from that exact position.
      const controller = new AbortController();
      const authorityKey = getProPlaybackAuthorityKey(request.authority);
      const candidate: PreparedCandidate = {
        authority: request.authority,
        authorityKey,
        queueItemId: request.queueItemId,
        basePositionSeconds: clampPosition(request.positionSeconds),
        positionSeconds: clampPosition(request.positionSeconds),
        minimumStartLeadMs: 0,
        controller,
        loadingToken: authorityKey,
        authorityFence: { live: true, committed: false },
        port: null,
        preparePromise: null,
        primedPositionSeconds: null,
        durationSeconds: null,
        loadingSettled: true,
        audioContext: null,
      };
      const outcome = Promise.resolve<ProRoomBoundedPrepareOutcome>({
        status: 'ready',
        durationSeconds: null,
      });
      candidate.preparePromise = outcome;
      this.#prepared = candidate;
      return outcome;
    }

    const requestedBudgetMs = Number.isFinite(request.prepareBudgetMs)
      ? Math.max(0, request.prepareBudgetMs!)
      : DEFAULT_PREPARE_BUDGET_MS;
    const admissionBudgetMs = Math.max(0, requestedBudgetMs - PREPARE_COMMIT_RESERVE_MS);
    if (admissionBudgetMs <= 0) {
      return Promise.reject(new DOMException('PRO bounded preparation deadline', 'TimeoutError'));
    }

    const controller = new AbortController();
    const authorityKey = getProPlaybackAuthorityKey(request.authority);
    const candidate: PreparedCandidate = {
      authority: request.authority,
      authorityKey,
      queueItemId: request.queueItemId,
      basePositionSeconds: clampPosition(request.positionSeconds),
      positionSeconds: clampPosition(request.positionSeconds),
      minimumStartLeadMs: request.prepareBudgetMs === undefined ? LOCAL_CATCHUP_HORIZON_MS : 0,
      controller,
      loadingToken: authorityKey,
      authorityFence: { live: true, committed: false },
      port: null,
      preparePromise: null,
      primedPositionSeconds: null,
      durationSeconds: null,
      loadingSettled: false,
      audioContext: null,
    };
    this.#prepared = candidate;
    bus.emit('player:v2-file-loading-pending', {
      owner: 'pro-prepare',
      token: candidate.loadingToken,
    });
    const operation = this.#runPreparation(
      candidate,
      request,
      this.#epoch,
      admissionBudgetMs,
      buildProfile,
    );
    candidate.preparePromise = operation;
    return operation;
  }

  async #runPreparation(
    candidate: PreparedCandidate,
    request: Readonly<ProPlaybackPrepareRequest>,
    observedEpoch: number,
    admissionBudgetMs: number,
    buildProfile: ReturnType<typeof getFilePlaybackBuildProfile>,
  ): Promise<ProRoomBoundedPrepareOutcome> {
    const controller = candidate.controller;
    let untransferredEncodedSource: EncodedAudioSource | null = null;
    let deadlineExpired = false;
    const deadlineTimer = globalThis.setTimeout(() => {
      deadlineExpired = true;
      controller.abort(new DOMException('PRO bounded preparation deadline', 'TimeoutError'));
    }, admissionBudgetMs);

    try {
      const encodedSource = await resolveRangeSourceWithAbort(
        Promise.resolve(
          this.#dependencies.resolveRangeSource(request.queueItemId, controller.signal),
        ),
        controller.signal,
      );
      if (!encodedSource) {
        await this.#retirePrepared(candidate);
        return request.isCurrent?.() === false ? { status: 'superseded' } : { status: 'fallback' };
      }
      untransferredEncodedSource = encodedSource;
      // Audio graph initialization can be shared/document-scoped and may not
      // itself observe this candidate signal. The participant admission
      // deadline must nevertheless settle promptly.
      const audio = await settlePreparationWithAbort(
        this.#dependencies.getAudioRuntime(),
        controller.signal,
      );
      if (!audio) {
        await this.#retirePrepared(candidate);
        return { status: 'fallback' };
      }
      const { audioContext, destination } = audio;
      candidate.audioContext = audioContext;
      // Resolver-issued PRO sources are canonical by construction. The source
      // factory owns that source from invocation onward; until this exact
      // transfer point the adapter must close it itself.
      untransferredEncodedSource = null;
      const sourceResult = await this.#dependencies.createSource({
        encodedSource,
        queueItemId: request.queueItemId,
        audioContext,
        nowRoomTimeMs: this.#dependencies.nowRoomTimeMs,
        roomTimeMsToContextTime: (roomTimeMs) => {
          const nowRoomTimeMs = this.#dependencies.nowRoomTimeMs();
          return audioContext.currentTime + (roomTimeMs - nowRoomTimeMs) / 1_000;
        },
        localPerformanceMsToContextTime: (localPerformanceTimeMs) =>
          audioContext.currentTime + (localPerformanceTimeMs - performance.now()) / 1_000,
        signal: controller.signal,
        ...(buildProfile.boundedRoutePolicy
          ? { boundedRoutePolicy: buildProfile.boundedRoutePolicy }
          : {}),
      });
      if (sourceResult.backend !== 'bounded-stream') {
        await sourceResult.source.destroy();
        await this.#retirePrepared(candidate);
        return { status: 'fallback' };
      }
      if (
        observedEpoch !== this.#epoch ||
        this.#prepared !== candidate ||
        request.isCurrent?.() === false ||
        controller.signal.aborted
      ) {
        await sourceResult.source.destroy();
        await this.#retirePrepared(candidate);
        return { status: 'superseded' };
      }
      const port = await this.#manager.stageCutoverCandidate({
        source: sourceResult.source as FilePlaybackCutoverSource,
        destination,
        authority: () =>
          candidate.authorityFence.live &&
          (candidate.authorityFence.committed || request.isCurrent?.() !== false),
      });
      candidate.port = port;
      // Snapshot/manual-sync preparation does not yet know the canonical
      // position at COMMIT receipt. Keep the already-decoded source staged and
      // bind its one-shot prime only after the fresh COMMIT position arrives.
      // A server PREPARE already carries the exact target and is primed here.
      const snapshot =
        candidate.minimumStartLeadMs > 0
          ? sourceResult.source.getSnapshot()
          : await this.#manager.primeCutoverCandidate(
              port,
              candidate.positionSeconds,
              controller.signal,
            );
      if (candidate.minimumStartLeadMs === 0) {
        candidate.primedPositionSeconds = candidate.positionSeconds;
      }
      if (
        observedEpoch !== this.#epoch ||
        this.#prepared !== candidate ||
        request.isCurrent?.() === false ||
        controller.signal.aborted
      ) {
        await this.#retirePrepared(candidate);
        return { status: 'superseded' };
      }
      candidate.durationSeconds = snapshot.durationSeconds;
      return { status: 'ready', durationSeconds: snapshot.durationSeconds };
    } catch (error) {
      const cancelledBeforeCatch = controller.signal.aborted && !deadlineExpired;
      await this.#retirePrepared(candidate);
      if (
        request.isCurrent?.() === false ||
        observedEpoch !== this.#epoch ||
        cancelledBeforeCatch
      ) {
        return { status: 'superseded' };
      }
      // A server PREPARE deadline means the participant no longer has enough
      // barrier time to start a whole-object download/decode. Fail promptly;
      // only an immediate, explicit capability incompatibility may enter V1.
      if (deadlineExpired) {
        throw error;
      }
      if (isCompatibilityFailure(error)) {
        return { status: 'fallback' };
      }
      throw error;
    } finally {
      globalThis.clearTimeout(deadlineTimer);
      if (untransferredEncodedSource) {
        const source = untransferredEncodedSource;
        try {
          // Cleanup starts exactly once, but it must not extend the strict
          // participant admission deadline if an external range transport
          // implements a slow or stalled close.
          void Promise.resolve(source.close()).catch((error) => {
            log.warn('[PRO Playback] Failed to close untransferred range source', error);
          });
        } catch (error) {
          log.warn('[PRO Playback] Failed to close untransferred range source', error);
        }
      }
    }
  }

  async commit(request: Readonly<ProPlaybackCommitRequest>): Promise<ProRoomBoundedCommitOutcome> {
    if (!isProPlaybackAuthorityToken(request.authority)) return null;
    if (request.state === 'idle') return this.#commitIdle(request);

    const current = this.currentSnapshot();
    if (request.state === 'paused' && current?.queueItemId === request.queueItemId) {
      return this.#commitPaused(request, current);
    }

    const candidate = this.#prepared;
    if (
      request.state === 'paused' &&
      candidate &&
      candidate.port === null &&
      candidate.queueItemId === request.queueItemId &&
      sameAuthority(candidate.authority, request.authority)
    ) {
      return this.#commitMetadataPaused(request, candidate);
    }
    if (
      request.state !== 'playing' ||
      !request.queueItemId ||
      !candidate ||
      !candidate.port ||
      candidate.queueItemId !== request.queueItemId ||
      !sameAuthority(candidate.authority, request.authority)
    ) {
      if (
        request.state === 'playing' &&
        current?.queueItemId === request.queueItemId &&
        current.revision === request.committedPlaybackRevision &&
        current.phase === 'playing'
      ) {
        const position = this.currentPosition();
        return {
          status: 'applied',
          phase: 'playing',
          durationSeconds: current.durationSeconds,
          positionSeconds: position?.positionSeconds ?? clampPosition(request.positionSeconds),
        };
      }
      return null;
    }
    if (request.isCurrent?.() === false) {
      await this.#retirePrepared(candidate);
      return { status: 'superseded' };
    }

    const commitReceivedAtRoomTimeMs = this.#dependencies.nowRoomTimeMs();
    const requestedDelayMs = Number.isFinite(request.scheduleDelayMs)
      ? Math.max(0, Math.min(30_000, request.scheduleDelayMs))
      : 0;
    const startLeadMs = Math.max(candidate.minimumStartLeadMs, requestedDelayMs);
    if (candidate.primedPositionSeconds === null) {
      // Catch-up/manual-sync COMMIT position is fresher than PREPARE. When the
      // caller supplied a shorter delay than the local admission lead, project
      // only the extra lead we add. A caller-supplied future position (for
      // example delay=300ms) is already expressed at that target and must not
      // be double-counted.
      const projectedPosition =
        clampPosition(request.positionSeconds) +
        Math.max(0, candidate.minimumStartLeadMs - requestedDelayMs) / 1_000;
      candidate.positionSeconds =
        candidate.durationSeconds && candidate.durationSeconds > 0
          ? Math.min(projectedPosition, Math.max(0, candidate.durationSeconds - 0.001))
          : projectedPosition;
      try {
        const primed = await this.#manager.primeCutoverCandidate(
          candidate.port,
          candidate.positionSeconds,
          candidate.controller.signal,
        );
        candidate.primedPositionSeconds = candidate.positionSeconds;
        candidate.durationSeconds = primed.durationSeconds;
      } catch (error) {
        await this.#retirePrepared(candidate);
        log.warn('[PRO Playback] Deferred bounded prime failed', error);
        return request.isCurrent?.() === false ? { status: 'superseded' } : { status: 'failed' };
      }
    }
    const startAtRoomTimeMs = commitReceivedAtRoomTimeMs + startLeadMs;
    // Deferred prime is intentionally bounded by the preselected canonical
    // horizon. If it misses that horizon, starting late at the already-primed
    // position would introduce deterministic drift. Retire and let the
    // canonical catch-up path retry/fallback instead.
    if (
      candidate.minimumStartLeadMs > 0 &&
      startAtRoomTimeMs - this.#dependencies.nowRoomTimeMs() < MIN_TRANSITION_LEAD_MS
    ) {
      await this.#retirePrepared(candidate);
      return { status: 'failed' };
    }
    if (
      candidate.minimumStartLeadMs === 0 &&
      (requestedDelayMs < MIN_TRANSITION_LEAD_MS ||
        Math.abs(clampPosition(request.positionSeconds) - candidate.basePositionSeconds) > 0.05)
    ) {
      await this.#retirePrepared(candidate);
      return { status: 'failed' };
    }
    const finalizeByRoomTimeMs = startAtRoomTimeMs - 50;
    const runId = boundedRunId(request);
    const rendezvousId = boundedRendezvousId(request);
    const arm = {
      protocolVersion: 2 as const,
      kind: 'rendezvous-arm' as const,
      queueItemId: request.queueItemId,
      runId,
      revision: request.committedPlaybackRevision,
      rendezvousId,
      recipientId: 'pro-local',
      positionSeconds: candidate.positionSeconds,
      playbackRate: 1,
      startAtRoomTimeMs,
      finalizeByRoomTimeMs,
    };
    try {
      const armed = await this.#manager.armCutoverCandidate(candidate.port, arm);
      if (armed.status !== 'armed' || request.isCurrent?.() === false) {
        await this.#retirePrepared(candidate);
        return { status: 'superseded' };
      }
      candidate.authorityFence.committed = true;
      const finalized = await this.#manager.finalizeCutoverCandidate(candidate.port, {
        protocolVersion: 2,
        kind: 'rendezvous-finalize',
        queueItemId: request.queueItemId,
        runId,
        revision: request.committedPlaybackRevision,
        rendezvousId,
        recipientId: 'pro-local',
        startAtRoomTimeMs,
        finalizedAtRoomTimeMs: this.#dependencies.nowRoomTimeMs(),
      });
      await finalized.started;
      if (request.isCurrent?.() === false) {
        await this.#manager.retireExactCutoverPort(candidate.port);
        return { status: 'superseded' };
      }
      this.#settleLoading(candidate);
      this.#prepared = null;
      this.#current = {
        port: candidate.port,
        roomId: request.authority.roomId,
        roomEpoch: request.authority.roomEpoch,
        queueItemId: request.queueItemId,
        committedPlaybackRevision: request.committedPlaybackRevision,
        audioContext: candidate.audioContext!,
        canonicalPhase: 'playing',
        endedSubmitted: false,
        recovering: false,
      };
      this.#startObserver();
      const snapshot = this.currentSnapshot();
      const position = this.currentPosition();
      return {
        status: 'applied',
        phase: 'playing',
        durationSeconds: snapshot?.durationSeconds ?? candidate.durationSeconds,
        positionSeconds: position?.positionSeconds ?? candidate.positionSeconds,
      };
    } catch (error) {
      await this.#retirePrepared(candidate);
      log.warn('[PRO Playback] Bounded cutover failed', error);
      return { status: 'failed' };
    }
  }

  async #commitMetadataPaused(
    request: Readonly<ProPlaybackCommitRequest>,
    candidate: PreparedCandidate,
  ): Promise<ProRoomBoundedCommitOutcome> {
    if (request.isCurrent?.() === false) {
      await this.#retirePrepared(candidate);
      return { status: 'superseded' };
    }
    const delayMs = Number.isFinite(request.scheduleDelayMs)
      ? Math.max(0, Math.min(30_000, request.scheduleDelayMs))
      : 0;
    const current = this.#current;
    const snapshot = this.currentSnapshot();
    try {
      if (current && snapshot?.run) {
        const atRoomTimeMs =
          this.#dependencies.nowRoomTimeMs() + Math.max(MIN_TRANSITION_LEAD_MS, delayMs);
        const contextTimeSeconds =
          current.audioContext.currentTime +
          (atRoomTimeMs - this.#dependencies.nowRoomTimeMs()) / 1_000;
        const stopped = await this.#manager.stopCurrentCutover(current.port, {
          kind: 'file-playback-stop-transition',
          from: snapshot.run,
          to: {
            queueItemId: snapshot.run.queueItemId,
            runId: snapshot.run.runId,
            revision: request.committedPlaybackRevision,
          },
          atRoomTimeMs,
          target: createFilePlaybackCutoverTarget(
            current.audioContext,
            contextTimeSeconds,
            Math.round(contextTimeSeconds * current.audioContext.sampleRate),
          ),
        });
        await stopped.applied;
        this.#stopObserver();
        this.#current = null;
      } else if (delayMs > 0) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
      }
      if (request.isCurrent?.() === false || this.#prepared !== candidate) {
        await this.#retirePrepared(candidate);
        return { status: 'superseded' };
      }
      candidate.authorityFence.committed = true;
      this.#settleLoading(candidate);
      this.#prepared = null;
      candidate.authorityFence.live = false;
      return {
        status: 'applied',
        phase: 'paused',
        durationSeconds: null,
        positionSeconds: clampPosition(request.positionSeconds),
      };
    } catch (error) {
      await this.#retirePrepared(candidate);
      log.warn('[PRO Playback] Metadata-only paused cutover failed', error);
      return { status: 'failed' };
    }
  }

  async #commitPaused(
    request: Readonly<ProPlaybackCommitRequest>,
    snapshot: FilePlaybackSourceSnapshot,
  ): Promise<ProRoomBoundedCommitOutcome> {
    const current = this.#current;
    const from = snapshot.run;
    if (!current || !from || request.isCurrent?.() === false) return { status: 'superseded' };
    const to = {
      queueItemId: from.queueItemId,
      runId: from.runId,
      revision: request.committedPlaybackRevision,
    };
    const delayMs = Math.max(
      MIN_TRANSITION_LEAD_MS,
      Math.min(30_000, clampPosition(request.scheduleDelayMs)),
    );
    const atRoomTimeMs = this.#dependencies.nowRoomTimeMs() + delayMs;
    try {
      if (snapshot.phase === 'playing') {
        const projected = this.#manager.currentCutoverPosition(
          current.port,
          performance.now() + delayMs,
        );
        if (
          clampPosition(request.positionSeconds) <= 0.001 ||
          !projected ||
          Math.abs(projected.positionSeconds - clampPosition(request.positionSeconds)) > 0.25
        ) {
          // A canonical paused-at-an-exact-position command (notably STOP at
          // 0:00) cannot be represented by the source's natural pause point.
          // Revoke the current renderer at the exact outer-gate boundary;
          // a later resume prepares a fresh bounded candidate from the
          // canonical paused position.
          const audioContext = current.audioContext;
          const contextTimeSeconds =
            audioContext.currentTime + (atRoomTimeMs - this.#dependencies.nowRoomTimeMs()) / 1_000;
          const stopped = await this.#manager.stopCurrentCutover(current.port, {
            kind: 'file-playback-stop-transition',
            from,
            to,
            atRoomTimeMs,
            target: createFilePlaybackCutoverTarget(
              audioContext,
              contextTimeSeconds,
              Math.round(contextTimeSeconds * audioContext.sampleRate),
            ),
          });
          await stopped.applied;
          this.#stopObserver();
          this.#current = null;
          return {
            status: 'applied',
            phase: 'paused',
            durationSeconds: snapshot.durationSeconds,
            positionSeconds: clampPosition(request.positionSeconds),
          };
        }
      }
      const scheduled =
        snapshot.phase === 'playing'
          ? await this.#manager.pauseCurrentCutover(current.port, {
              kind: 'file-playback-pause-transition',
              from,
              to,
              atRoomTimeMs,
            })
          : await this.#manager.seekCurrentCutover(current.port, {
              kind: 'file-playback-seek-transition',
              from,
              to,
              positionSeconds: clampPosition(request.positionSeconds),
              atRoomTimeMs,
            });
      if (scheduled.status !== 'scheduled' || !scheduled.applied) return { status: 'failed' };
      await scheduled.applied;
      current.canonicalPhase = 'paused';
      current.committedPlaybackRevision = request.committedPlaybackRevision;
      const next = this.currentSnapshot();
      const position = this.currentPosition();
      return {
        status: 'applied',
        phase: 'paused',
        durationSeconds: next?.durationSeconds ?? snapshot.durationSeconds,
        positionSeconds: position?.positionSeconds ?? clampPosition(request.positionSeconds),
      };
    } catch (error) {
      log.warn('[PRO Playback] Bounded pause/seek failed', error);
      return { status: 'failed' };
    }
  }

  async #commitIdle(
    request: Readonly<ProPlaybackCommitRequest>,
  ): Promise<ProRoomBoundedCommitOutcome> {
    const current = this.#current;
    const snapshot = this.currentSnapshot();
    const from = snapshot?.run;
    if (!current || !snapshot || !from) return null;
    const audioContext = current.audioContext;
    const delayMs = Number.isFinite(request.scheduleDelayMs)
      ? Math.max(0, Math.min(30_000, request.scheduleDelayMs))
      : 0;
    const atRoomTimeMs =
      this.#dependencies.nowRoomTimeMs() + Math.max(MIN_TRANSITION_LEAD_MS, delayMs);
    const contextTimeSeconds =
      audioContext.currentTime + (atRoomTimeMs - this.#dependencies.nowRoomTimeMs()) / 1_000;
    const to = {
      queueItemId: from.queueItemId,
      runId: from.runId,
      revision: request.committedPlaybackRevision,
    };
    try {
      const stopped = await this.#manager.stopCurrentCutover(current.port, {
        kind: 'file-playback-stop-transition',
        from,
        to,
        atRoomTimeMs,
        target: createFilePlaybackCutoverTarget(
          audioContext,
          contextTimeSeconds,
          Math.round(contextTimeSeconds * audioContext.sampleRate),
        ),
      });
      await stopped.applied;
      this.#stopObserver();
      this.#current = null;
      return {
        status: 'applied',
        phase: 'idle',
        durationSeconds: snapshot.durationSeconds,
        positionSeconds: 0,
      };
    } catch (error) {
      log.warn('[PRO Playback] Bounded stop failed', error);
      return { status: 'failed' };
    }
  }

  #startObserver(): void {
    this.#stopObserver();
    this.#observer = globalThis.setInterval(() => {
      void this.#observeCurrent();
    }, OBSERVER_INTERVAL_MS);
  }

  #stopObserver(): void {
    if (this.#observer === null) return;
    globalThis.clearInterval(this.#observer);
    this.#observer = null;
  }

  async #observeCurrent(): Promise<void> {
    const observedEpoch = this.#epoch;
    const current = this.#current;
    if (!current) return;
    const context = getState('room.context');
    if (
      context.kind !== 'pro' ||
      context.roomId !== current.roomId ||
      context.epoch !== current.roomEpoch
    ) {
      await this.clear();
      return;
    }
    const snapshot = this.#manager.currentCutoverSnapshot(current.port);
    if (!snapshot) return;
    const exactCurrent =
      this.#current === current &&
      this.#manager.currentCutoverPort() === current.port &&
      snapshot.queueItemId === current.queueItemId &&
      snapshot.run?.revision === current.committedPlaybackRevision;
    if (!exactCurrent) return;
    // A natural end/failure from the outgoing renderer is weaker than a newer
    // server-authoritative PREPARE. Let the staged transition settle instead
    // of turning the predecessor observation into a competing room command or
    // late local recovery.
    if (this.#prepared) return;
    if (snapshot.phase === 'ended' && !current.endedSubmitted) {
      const position = this.#manager.currentCutoverPosition(current.port, performance.now());
      const duration = snapshot.durationSeconds;
      if (duration && duration > 0) {
        current.endedSubmitted = true;
        this.#dependencies.routeEnded({
          kind: 'ended',
          queueItemId: snapshot.queueItemId,
          positionSeconds: position?.positionSeconds ?? duration,
          observedPositionSeconds: position?.positionSeconds ?? duration,
          durationSeconds: duration,
          mediaKind: 'file',
        });
      }
      return;
    }
    if (snapshot.phase !== 'failed' || current.recovering) return;
    current.recovering = true;
    const position =
      this.#manager.currentCutoverPosition(current.port, performance.now())?.positionSeconds ??
      snapshot.positionSeconds;
    this.#current = null;
    this.#stopObserver();
    await this.#manager.retireExactCutoverPort(current.port).catch(() => undefined);
    const room = getState('room.context');
    if (
      observedEpoch !== this.#epoch ||
      room.kind !== 'pro' ||
      room.roomId !== current.roomId ||
      room.epoch !== current.roomEpoch ||
      this.#current !== null ||
      this.#prepared !== null ||
      isExternalOwner()
    ) {
      return;
    }
    // A renderer that was already committed may fail because of malformed
    // bytes, a decoder bug, or a device-local runtime loss. Automatically
    // starting the whole-file engine here is unsafe: its asynchronous download
    // can outlive a newer canonical transition and overwrite it. Compatibility
    // fallback remains available during PREPARE; post-COMMIT failures instead
    // fail closed and wait for an explicit/canonical reconciliation.
    setState('player.pausedAt', clampPosition(position));
    transition({ type: 'PRODUCT_TIMELINE_RENDERED', phase: 'paused' });
    bus.emit('ui:update-play-state', false);
    bus.emit('visualizer:hold-frame');
    log.warn('[PRO Playback] Bounded renderer failed after commit; playback was silenced');
  }
}

const proRoomBoundedPlayback = new ProRoomBoundedPlaybackAdapter();

/** @internal Test-only constructor seam; production owns the singleton above. */
export function createProRoomBoundedPlaybackAdapterForTests(
  dependencies?: ProRoomBoundedPlaybackDependencies,
): ProRoomBoundedPlaybackAdapter {
  return new ProRoomBoundedPlaybackAdapter(dependencies);
}

export function prepareProRoomBoundedFilePlayback(
  request: Readonly<ProPlaybackPrepareRequest>,
): Promise<ProRoomBoundedPrepareOutcome> {
  return proRoomBoundedPlayback.prepare(request);
}

export function commitProRoomBoundedFilePlayback(
  request: Readonly<ProPlaybackCommitRequest>,
): Promise<ProRoomBoundedCommitOutcome> {
  return proRoomBoundedPlayback.commit(request);
}

export function cancelProRoomBoundedFilePlayback(authority?: ProPlaybackAuthorityToken): void {
  proRoomBoundedPlayback.cancel(authority);
}

export function clearProRoomBoundedFilePlayback(): Promise<void> {
  return proRoomBoundedPlayback.clear();
}

export function invalidateCommittedProRoomBoundedFilePlayback(
  request: Readonly<ProPlaybackCommitRequest>,
): Promise<void> {
  return proRoomBoundedPlayback.invalidateCommitted(request);
}

export function hasCurrentProRoomBoundedFilePlayback(queueItemId?: QueueItemId): boolean {
  return proRoomBoundedPlayback.hasCurrent(queueItemId);
}

export function getProRoomBoundedFilePlaybackPosition(): FilePlaybackPosition | null {
  return proRoomBoundedPlayback.currentPosition();
}
