import { describe, expect, it, vi } from 'vitest';

import { FilePlaybackConnectionChannel } from '../../network/file-playback-connection-channel.ts';
import {
  FilePlaybackGuestSessionHandshake,
  FilePlaybackHandshakeIdIssuer,
  FilePlaybackHostSessionHandshake,
} from '../../network/file-playback-session-handshake.ts';
import type { DataConnection, QueueItemId } from '../../types/index.ts';
import { FilePlaybackApplicationController } from '../file-playback-application-controller.ts';
import {
  FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
  type FilePlaybackBoundedRoutePolicy,
} from '../file-playback-bounded-route-policy.ts';
import { FilePlaybackClock } from '../file-playback-clock.ts';
import type {
  ClearHostLocalTrackWarmOptions,
  FilePlaybackHostFirstFileEngineOptions,
  HostCurrentPlaybackOperationOptions,
  HostCurrentPlaybackTransitionCommit,
  HostFirstLocalFilePlaybackCommit,
  HostLocalTrackSourceLease,
  HostLocalTrackWarmResult,
  HostCurrentPlaybackTimelineCommittedEvent,
  HostCurrentPlaybackTransitionScheduledEvent,
  HostRemoteEndRequiredEvent,
  HostPeerPlaybackPublication,
  HostPeerRangeManifestPublication,
  HostPeerRangeSource,
  HostPreparedLocalTrack,
  HostPreparedRemoteParticipant,
  HostRemoteRecoveryCommit,
  RecoverHostRemoteParticipantOptions,
  ResolvePreparedHostPeerRangeSourceOptions,
  ResolveHostPeerRangeSourceOptions,
  ResolveWarmHostPeerRangeSourceOptions,
  SeekHostPausedOptions,
  SeekHostPlayingOptions,
  StartPreparedHostLocalTrackOptions,
  StartHostFirstLocalFileOptions,
  StartHostLocalTrackOptions,
  WarmHostLocalTrackOptions,
} from '../file-playback-host-first-file-engine.ts';
import { FilePlaybackProductBaselineIdIssuer } from '../file-playback-product-baseline-session.ts';
import {
  FilePlaybackProductHostRoom,
  type FilePlaybackProductHostPreparedCohortContext,
  type FilePlaybackProductHostFirstEnginePort,
} from '../file-playback-product-host-room.ts';
import { FilePlaybackRoomClock } from '../file-playback-room-clock.ts';
import { RemoteRendezvousParticipant } from '../remote-rendezvous-participant.ts';
import type {
  FilePlaybackBackend,
  FilePlaybackPosition,
  FilePlaybackSourcePhase,
  FilePlaybackSourceSnapshot,
} from '../file-playback-source.ts';
import type { OrdinaryAudioDecoder } from '../file-playback-source-factory.ts';
import type { PlaybackAttemptIdentity } from '../playback-identity.ts';
import { createStoppedPlaybackTimeline } from '../playback-timeline.ts';

const Q1 = '97000000-0000-4000-8000-000000000001' as QueueItemId;
const Q2 = '97000000-0000-4000-8000-000000000002' as QueueItemId;
const Q3 = '97000000-0000-4000-8000-000000000003' as QueueItemId;
let connectionSequence = 0;

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function manifestPublication(): Readonly<HostPeerRangeManifestPublication> {
  return freezeCanonical({
    codec: 'adts-aac-lc' as const,
    manifestByteLength: 64,
    manifestSha256B64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  });
}

function establishedHostChannel(): {
  readonly connection: DataConnection;
  readonly channel: FilePlaybackConnectionChannel;
} {
  const suffix = ++connectionSequence;
  const hostIds = new FilePlaybackHandshakeIdIssuer({
    createSessionId: () => `product-host-active-session-${suffix}`,
    createConnectionId: () => `product-host-active-connection-${suffix}`,
    createHelloId: () => `product-host-active-hello-${suffix}`,
  });
  const guestIds = new FilePlaybackHandshakeIdIssuer({
    createSessionId: () => `product-guest-active-session-${suffix}`,
    createConnectionId: () => `product-guest-active-connection-${suffix}`,
    createHelloId: () => `product-guest-active-hello-${suffix}`,
  });
  const host = new FilePlaybackHostSessionHandshake({
    idIssuer: hostIds,
    sessionId: hostIds.issueSessionId(),
    connectionId: hostIds.issueConnectionId(),
    hostParticipantId: `product-host-${suffix}`,
    guestParticipantId: `product-guest-${suffix}`,
  });
  const guest = new FilePlaybackGuestSessionHandshake({
    idIssuer: guestIds,
    guestParticipantId: `product-guest-${suffix}`,
  });
  const hello = guest.createHello();
  if (!hello.accepted) throw new Error(hello.reason);
  const welcome = host.handleHello(hello.hello);
  if (!welcome.accepted) throw new Error(welcome.reason);
  const welcomed = guest.handleWelcome(welcome.welcome);
  if (!welcomed.accepted) throw new Error(welcomed.reason);
  const snapshot = host.createSnapshot();
  if (!snapshot.accepted) throw new Error(snapshot.reason);
  const accepted = guest.acceptSnapshot(snapshot.snapshot);
  if (!accepted.accepted) throw new Error(accepted.reason);
  const applied = guest.createApplied();
  if (!applied.accepted) throw new Error(applied.reason);
  const hostApplied = host.handleApplied(applied.applied);
  if (!hostApplied.accepted) throw new Error(hostApplied.reason);
  const connection = {
    peer: `product-active-peer-${suffix}`,
    open: true,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as DataConnection;
  return {
    connection,
    channel: new FilePlaybackConnectionChannel(host, connection, { now: () => 1_000 }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function drainMicrotasks(turns = 32): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

class FakeAudioContext {
  readonly state: AudioContextState = 'running';
  readonly sampleRate = 48_000;
}

function destinationFor(context: FakeAudioContext): AudioNode {
  return {
    context,
    connect: vi.fn(),
  } as unknown as AudioNode;
}

interface OperationPlan {
  readonly beforePhysical?: ReturnType<typeof deferred<void>>;
  readonly afterCommit?: ReturnType<typeof deferred<void>>;
  readonly ignoreAbortBeforePhysical?: boolean;
  readonly failure?: Error;
  readonly bodyLeak?: boolean;
  readonly onAbort?: () => void;
}

interface EnginePlan {
  readonly candidates?: OperationPlan[];
  readonly transitions?: OperationPlan[];
  readonly warmBackend?: FilePlaybackBackend;
  readonly warmPeerRangeManifest?: Readonly<HostPeerRangeManifestPublication>;
  readonly preparedPeerRangeManifest?: Readonly<HostPeerRangeManifestPublication>;
  readonly warmResultTransform?: (
    result: Readonly<HostLocalTrackWarmResult>,
  ) => Readonly<HostLocalTrackWarmResult>;
  readonly closeGate?: ReturnType<typeof deferred<void>>;
  readonly closeFailure?: Error;
  readonly onClose?: () => void;
}

async function waitForPlanGate(
  gate: ReturnType<typeof deferred<void>> | undefined,
  signal: AbortSignal,
  ignoreAbort: boolean,
  onAbort?: () => void,
): Promise<void> {
  if (!gate) return;
  if (ignoreAbort) {
    await gate.promise;
    return;
  }
  await Promise.race([
    gate.promise,
    new Promise<never>((_resolve, reject) => {
      const abort = () => {
        onAbort?.();
        reject(signal.reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }),
  ]);
}

type FixtureAsset = HostFirstLocalFilePlaybackCommit['asset'];

class FixtureEngine implements FilePlaybackProductHostFirstEnginePort {
  readonly warmLocalTrack = vi.fn(
    async (input: WarmHostLocalTrackOptions): Promise<Readonly<HostLocalTrackWarmResult>> => {
      input.signal.throwIfAborted();
      const backend = this.plan.warmBackend ?? 'audio-buffer';
      const sourceSequence = ++this.sequence;
      const mime = input.mime.trim().length === 0 ? 'application/octet-stream' : input.mime;
      this.warmQueueItemId = backend === 'bounded-stream' ? input.queueItemId : null;
      this.warmSourceLease =
        backend === 'bounded-stream'
          ? (freezeCanonical({}) as unknown as HostLocalTrackSourceLease)
          : null;
      this.warmBlob = backend === 'bounded-stream' ? input.blob : null;
      this.warmSourceIdentity =
        backend === 'bounded-stream' ? `fixture-warm-source-${sourceSequence}` : null;
      const result = freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: this.options.roomGeneration,
        status:
          backend === 'bounded-stream' ? ('warmed' as const) : ('skipped-non-bounded' as const),
        backend,
        asset: freezeCanonical({
          kind: 'blob' as const,
          binding: freezeCanonical({
            queueItemId: input.queueItemId,
            sourceIdentity: `fixture-warm-source-${sourceSequence}`,
            transferSessionId: `fixture-warm-transfer-${sourceSequence}`,
          }),
          metadata: freezeCanonical({ name: input.name, mime }),
          encodedSize: input.blob.size,
          peerRangeManifest: this.plan.warmPeerRangeManifest ?? null,
        }),
        readiness: freezeCanonical({
          durationSeconds: 180,
          bufferedAheadSeconds: 8,
          outputSampleRateHz: 48_000,
          channelCount: 2,
        }),
        sourceLease: this.warmSourceLease,
      });
      return this.plan.warmResultTransform?.(result) ?? result;
    },
  );
  readonly clearWarmLocalTrack = vi.fn(
    async (input: ClearHostLocalTrackWarmOptions): Promise<boolean> => {
      const matches =
        'sourceLease' in input
          ? this.warmSourceLease !== null && input.sourceLease === this.warmSourceLease
          : this.warmQueueItemId === input.queueItemId;
      if (!matches) return false;
      this.warmQueueItemId = null;
      this.warmSourceLease = null;
      this.warmBlob = null;
      this.warmSourceIdentity = null;
      return true;
    },
  );
  readonly resolveWarmPeerRangeSource = vi.fn(
    async (input: ResolveWarmHostPeerRangeSourceOptions): Promise<HostPeerRangeSource> => {
      input.signal.throwIfAborted();
      const lease = this.warmSourceLease;
      const blob = this.warmBlob;
      const sourceIdentity = this.warmSourceIdentity;
      if (
        !lease ||
        !blob ||
        input.sourceLease !== lease ||
        input.sourceIdentity !== sourceIdentity
      ) {
        throw new Error('Fixture warm source lease is stale');
      }
      await Promise.resolve();
      input.signal.throwIfAborted();
      if (
        this.warmSourceLease !== lease ||
        this.warmBlob !== blob ||
        this.warmSourceIdentity !== sourceIdentity
      ) {
        throw new Error('Fixture warm source lease changed');
      }
      return blob;
    },
  );
  readonly startFirstLocalFile = vi.fn(
    (input: StartHostFirstLocalFileOptions): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> =>
      this.#commitFileCandidate(input, 0),
  );
  readonly startLocalTrack = vi.fn(
    (input: StartHostLocalTrackOptions): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> =>
      this.#commitFileCandidate(input, input.positionSeconds),
  );
  readonly prepareLocalTrack = vi.fn(
    async (input: StartHostLocalTrackOptions): Promise<Readonly<HostPreparedLocalTrack>> => {
      input.signal.throwIfAborted();
      const backend: FilePlaybackBackend =
        input.mime === 'audio/flac' || input.name.toLowerCase().endsWith('.flac')
          ? 'bounded-stream'
          : 'audio-buffer';
      const sourceSequence = ++this.sequence;
      const previous = this.options.controller.timelineSnapshot();
      const prepared = freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: this.options.roomGeneration,
        backend,
        state: freezeCanonical({
          queueItemId: input.queueItemId,
          runId: `fixture-prepared-run-${sourceSequence}`,
          revision: previous.revision + 1,
        }),
        positionSeconds: input.positionSeconds,
        playbackRate: 1,
        asset: freezeCanonical({
          kind: 'blob' as const,
          binding: freezeCanonical({
            queueItemId: input.queueItemId,
            sourceIdentity: `fixture-prepared-source-${sourceSequence}`,
            transferSessionId: `fixture-prepared-transfer-${sourceSequence}`,
          }),
          metadata: freezeCanonical({
            name: input.name,
            mime: input.mime || 'application/octet-stream',
          }),
          encodedSize: input.blob.size,
          peerRangeManifest: this.plan.preparedPeerRangeManifest ?? null,
        }),
        sourceLease: null,
      });
      this.preparedInputs.set(prepared, input);
      return prepared;
    },
  );
  readonly preparePlayingSeek = vi.fn(
    async (input: SeekHostPlayingOptions): Promise<Readonly<HostPreparedLocalTrack>> => {
      input.signal.throwIfAborted();
      const previous = this.options.controller.timelineSnapshot();
      if (
        previous.phase !== 'playing' ||
        !previous.run ||
        !this.queueItemId ||
        !this.runId ||
        !this.backend ||
        !this.asset ||
        previous.run.queueItemId !== this.queueItemId ||
        previous.run.runId !== this.runId
      ) {
        throw new Error('Fixture playing seek has no exact current run');
      }
      const prepared = freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: this.options.roomGeneration,
        backend: this.backend,
        state: freezeCanonical({
          queueItemId: this.queueItemId,
          runId: this.runId,
          revision: previous.revision + 1,
        }),
        positionSeconds: input.positionSeconds,
        playbackRate: 1,
        asset: freezeCanonical({
          kind: this.asset.kind,
          binding: freezeCanonical({
            queueItemId: this.asset.queueItemId,
            sourceIdentity: this.asset.sourceIdentity,
            transferSessionId: this.asset.transferSessionId,
          }),
          metadata: freezeCanonical({
            name: this.asset.name,
            mime: this.asset.mime,
          }),
          encodedSize: this.asset.size,
          peerRangeManifest: null,
        }),
        sourceLease: null,
      });
      this.preparedSeekInputs.set(prepared, input);
      return prepared;
    },
  );
  readonly prepareReplayCurrent = vi.fn(
    async (
      input: HostCurrentPlaybackOperationOptions,
    ): Promise<Readonly<HostPreparedLocalTrack>> => {
      input.signal.throwIfAborted();
      const previous = this.options.controller.timelineSnapshot();
      if (
        (previous.phase !== 'playing' && previous.phase !== 'paused') ||
        !previous.run ||
        !this.queueItemId ||
        !this.runId ||
        !this.backend ||
        !this.asset ||
        previous.run.queueItemId !== this.queueItemId ||
        previous.run.runId !== this.runId
      ) {
        throw new Error('Fixture replay has no exact current run');
      }
      const prepared = freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: this.options.roomGeneration,
        backend: this.backend,
        state: freezeCanonical({
          queueItemId: this.queueItemId,
          runId: `fixture-prepared-replay-run-${++this.sequence}`,
          revision: previous.revision + 1,
        }),
        positionSeconds: 0,
        playbackRate: 1,
        asset: freezeCanonical({
          kind: this.asset.kind,
          binding: freezeCanonical({
            queueItemId: this.asset.queueItemId,
            sourceIdentity: this.asset.sourceIdentity,
            transferSessionId: this.asset.transferSessionId,
          }),
          metadata: freezeCanonical({
            name: this.asset.name,
            mime: this.asset.mime,
          }),
          encodedSize: this.asset.size,
          peerRangeManifest: null,
        }),
        sourceLease: null,
      });
      this.preparedReplayInputs.set(prepared, input);
      return prepared;
    },
  );
  readonly startPreparedLocalTrack = vi.fn(
    (
      input: StartPreparedHostLocalTrackOptions,
    ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> => {
      const preparedInput = this.preparedInputs.get(input.prepared);
      if (preparedInput) {
        return this.#commitFileCandidate(preparedInput, preparedInput.positionSeconds);
      }
      const seekInput = this.preparedSeekInputs.get(input.prepared);
      if (seekInput) {
        return this.#commitCurrentCandidate(
          'playing-seek',
          input.prepared.positionSeconds,
          seekInput.signal,
        );
      }
      const replayInput = this.preparedReplayInputs.get(input.prepared);
      if (replayInput) {
        return this.#commitCurrentCandidate(
          'replay',
          0,
          replayInput.signal,
          input.prepared.state.runId,
        );
      }
      return Promise.reject(new Error('Fixture prepared track is stale'));
    },
  );
  readonly resolvePreparedPeerRangeSource = vi.fn(
    async (input: ResolvePreparedHostPeerRangeSourceOptions): Promise<HostPeerRangeSource> => {
      input.signal.throwIfAborted();
      const local = this.preparedInputs.get(input.prepared)?.blob;
      const replay = this.preparedReplayInputs.has(input.prepared) ? this.currentBlob : null;
      const source = local ?? replay;
      if (!source || input.sourceIdentity !== input.prepared.asset.binding.sourceIdentity) {
        throw new Error('Fixture prepared peer source is unavailable');
      }
      return source;
    },
  );
  readonly pauseCurrent = vi.fn((input: HostCurrentPlaybackOperationOptions) =>
    this.#commitTransition('pause', input.signal),
  );
  readonly seekPlaying = vi.fn((input: SeekHostPlayingOptions) =>
    this.#commitCurrentCandidate('playing-seek', input.positionSeconds, input.signal),
  );
  readonly seekPaused = vi.fn((input: SeekHostPausedOptions) =>
    this.#commitTransition('seek', input.signal, input.positionSeconds),
  );
  readonly resumeCurrent = vi.fn((input: HostCurrentPlaybackOperationOptions) =>
    this.#commitCurrentCandidate('resume', this.positionSeconds, input.signal),
  );
  readonly replayCurrent = vi.fn((input: HostCurrentPlaybackOperationOptions) =>
    this.#commitCurrentCandidate('replay', 0, input.signal),
  );
  readonly stopCurrent = vi.fn((input: HostCurrentPlaybackOperationOptions) =>
    this.#commitTransition('stop', input.signal),
  );
  readonly settleEndedCurrent = vi.fn((input: HostCurrentPlaybackOperationOptions) =>
    this.#commitTransition('ended', input.signal),
  );
  readonly currentPeerPublication = vi.fn((): Readonly<HostPeerPlaybackPublication> | null => null);
  readonly resolveCurrentPeerRangeSource = vi.fn(
    (_input: ResolveHostPeerRangeSourceOptions): Promise<HostPeerRangeSource> =>
      Promise.reject(new Error('Fixture peer source is unavailable')),
  );
  readonly recoverRemoteParticipant = vi.fn(
    (_input: RecoverHostRemoteParticipantOptions): Promise<Readonly<HostRemoteRecoveryCommit>> =>
      Promise.reject(new Error('Fixture remote recovery is unavailable')),
  );
  readonly close = vi.fn((): Promise<void> => {
    if (!this.closePromise) {
      this.events.push('engine:close-called');
      this.closePromise = (async () => {
        this.plan.onClose?.();
        if (this.plan.closeGate) await this.plan.closeGate.promise;
        if (this.plan.closeFailure) throw this.plan.closeFailure;
        this.events.push('engine:close-settled');
      })();
    }
    return this.closePromise;
  });
  readonly currentRendererSnapshot = vi.fn((): FilePlaybackSourceSnapshot | null => {
    if (!this.queueItemId || !this.backend || !this.runId || this.phase === 'stopped') return null;
    return freezeCanonical({
      schemaVersion: 1 as const,
      queueItemId: this.queueItemId,
      backend: this.backend,
      phase: this.phase,
      revision: this.revision,
      run: freezeCanonical({
        queueItemId: this.queueItemId,
        runId: this.runId,
        revision: this.revision,
      }),
      durationSeconds: 180,
      positionSeconds: this.positionSeconds,
      bufferedAheadSeconds: 8,
      outputSampleRateHz: 48_000,
      channelCount: 2,
      underrunCount: 0,
      errorCode: null,
    });
  });
  readonly positionAt = vi.fn((_time: number): FilePlaybackPosition | null => {
    const snapshot = this.currentRendererSnapshot();
    if (!snapshot) return null;
    return freezeCanonical({
      queueItemId: snapshot.queueItemId,
      run: snapshot.run,
      phase: snapshot.phase,
      positionSeconds: snapshot.positionSeconds,
      bufferedAheadSeconds: snapshot.bufferedAheadSeconds,
      underrunCount: snapshot.underrunCount,
    });
  });

  private readonly candidates: OperationPlan[];
  private readonly transitions: OperationPlan[];
  private closePromise: Promise<void> | null = null;
  private backend: FilePlaybackBackend | null = null;
  private queueItemId: QueueItemId | null = null;
  private runId: string | null = null;
  private revision = 0;
  private positionSeconds = 0;
  private phase: FilePlaybackSourcePhase | 'stopped' = 'stopped';
  private asset: FixtureAsset | null = null;
  private audioContext: AudioContext | null = null;
  private sequence = 0;
  private readonly preparedInputs = new WeakMap<object, StartHostLocalTrackOptions>();
  private readonly preparedSeekInputs = new WeakMap<object, SeekHostPlayingOptions>();
  private readonly preparedReplayInputs = new WeakMap<
    object,
    HostCurrentPlaybackOperationOptions
  >();
  private currentBlob: Blob | null = null;
  private warmQueueItemId: QueueItemId | null = null;
  private warmSourceLease: HostLocalTrackSourceLease | null = null;
  private warmBlob: Blob | null = null;
  private warmSourceIdentity: string | null = null;

  constructor(
    readonly options: Readonly<FilePlaybackHostFirstFileEngineOptions>,
    readonly plan: EnginePlan,
    readonly events: string[],
  ) {
    this.candidates = [...(plan.candidates ?? [])];
    this.transitions = [...(plan.transitions ?? [])];
  }

  fatal(error: Error): void {
    this.options.onFatalRoom(error);
  }

  observeNaturalEndForTests(): void {
    if (this.phase !== 'playing') throw new Error('Fixture renderer is not playing');
    this.phase = 'ended';
  }

  replaceRendererIdentityForTests(
    input: Readonly<{
      queueItemId?: QueueItemId;
      runId?: string;
      revision?: number;
    }>,
  ): void {
    if (input.queueItemId !== undefined) this.queueItemId = input.queueItemId;
    if (input.runId !== undefined) this.runId = input.runId;
    if (input.revision !== undefined) this.revision = input.revision;
  }

  async #commitFileCandidate(
    input: StartHostFirstLocalFileOptions,
    positionSeconds: number,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
    const backend: FilePlaybackBackend =
      input.mime === 'audio/flac' || input.name.toLowerCase().endsWith('.flac')
        ? 'bounded-stream'
        : 'audio-buffer';
    const asset = freezeCanonical({
      queueItemId: input.queueItemId,
      sourceIdentity: `fixture-source-${++this.sequence}`,
      transferSessionId: `fixture-transfer-${this.sequence}`,
      kind: 'blob' as const,
      size: input.blob.size,
      name: input.name,
      mime: input.mime || 'application/octet-stream',
    });
    this.audioContext = input.audioContext;
    const committed = await this.#commitCandidate(
      input.queueItemId,
      backend,
      asset,
      positionSeconds,
      true,
      input.signal,
    );
    this.currentBlob = input.blob;
    return committed;
  }

  async #commitCurrentCandidate(
    action: 'playing-seek' | 'replay' | 'resume',
    positionSeconds: number,
    signal: AbortSignal,
    preparedRunId?: string,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
    if (!this.queueItemId || !this.backend || !this.asset || !this.runId) {
      throw new Error('Fixture current renderer is unavailable');
    }
    return this.#commitCandidate(
      this.queueItemId,
      this.backend,
      this.asset,
      positionSeconds,
      action === 'replay',
      signal,
      preparedRunId,
    );
  }

  async #commitCandidate(
    queueItemId: QueueItemId,
    backend: FilePlaybackBackend,
    asset: FixtureAsset,
    positionSeconds: number,
    newRun: boolean,
    signal: AbortSignal,
    preparedRunId?: string,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
    const plan = this.candidates.shift() ?? {};
    await waitForPlanGate(
      plan.beforePhysical,
      signal,
      plan.ignoreAbortBeforePhysical === true,
      plan.onAbort,
    );
    signal.throwIfAborted();
    if (plan.failure) throw plan.failure;

    const previous = this.options.controller.timelineSnapshot();
    const runId =
      preparedRunId ?? (newRun || !this.runId ? `fixture-run-${++this.sequence}` : this.runId);
    const attempt: Readonly<PlaybackAttemptIdentity> = freezeCanonical({
      queueItemId,
      runId,
      revision: previous.revision + 1,
      rendezvousId: `fixture-rendezvous-${this.sequence}-${previous.revision + 1}`,
    });
    const schedule = freezeCanonical({
      createdAtRoomTimeMs: Math.max(1_000, previous.anchorMonotonicMs),
      finalizeByRoomTimeMs: Math.max(1_300, previous.anchorMonotonicMs),
      leadTimeMs: 500,
      playbackRate: 1,
      positionSeconds,
      startAtRoomTimeMs: Math.max(1_500, previous.anchorMonotonicMs),
    });
    const startEvidence =
      backend === 'audio-buffer'
        ? freezeCanonical({ kind: 'webaudio-schedule-passed' as const, targetFrame: 72_000 })
        : freezeCanonical({
            kind: 'worklet-observed' as const,
            targetFrame: 72_000,
            actualStartFrame: 72_000,
          });
    const committed = this.options.controller.commitHostStartedPlayback({
      roomGeneration: this.options.roomGeneration,
      expectedPreviousRevision: previous.revision,
      attempt,
      schedule,
      startEvidence,
    });
    this.backend = backend;
    this.queueItemId = queueItemId;
    this.runId = runId;
    this.revision = attempt.revision;
    this.positionSeconds = positionSeconds;
    this.phase = 'playing';
    this.asset = asset;
    await waitForPlanGate(plan.afterCommit, signal, true);

    return freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: this.options.roomGeneration,
      backend,
      asset: plan.bodyLeak
        ? (freezeCanonical({ queueItemId, blob: new Blob(['leak']) }) as never)
        : asset,
      attempt,
      schedule,
      startEvidence,
      timeline: committed.timeline,
    });
  }

  async #commitTransition(
    kind: HostCurrentPlaybackTransitionCommit['kind'],
    signal: AbortSignal,
    seekPositionSeconds?: number,
  ): Promise<Readonly<HostCurrentPlaybackTransitionCommit>> {
    const plan = this.transitions.shift() ?? {};
    await waitForPlanGate(
      plan.beforePhysical,
      signal,
      plan.ignoreAbortBeforePhysical === true,
      plan.onAbort,
    );
    signal.throwIfAborted();
    if (plan.failure) throw plan.failure;
    const previous = this.options.controller.timelineSnapshot();
    if (!previous.run || !this.queueItemId || !this.runId) {
      throw new Error('Fixture transition has no current run');
    }
    const from = freezeCanonical({
      queueItemId: previous.run.queueItemId,
      runId: previous.run.runId,
      revision: previous.revision,
    });
    const to = freezeCanonical({ ...from, revision: from.revision + 1 });
    const atRoomTimeMs = Math.max(2_000, previous.anchorMonotonicMs);
    let timeline;
    let evidence: HostCurrentPlaybackTransitionCommit['evidence'];
    if (kind === 'ended') {
      const intent = freezeCanonical({
        kind: 'file-playback-ended-transition' as const,
        from,
        to,
        observedAtRoomTimeMs: atRoomTimeMs,
      });
      evidence = freezeCanonical({
        kind: 'ended-renderer-retired' as const,
        from,
        to,
        observedAtRoomTimeMs: atRoomTimeMs,
      });
      timeline = this.options.controller.commitHostEndedPlayback({
        roomGeneration: this.options.roomGeneration,
        expectedPrevious: previous,
        intent,
        evidence,
      }).timeline;
    } else if (kind === 'pause') {
      const intent = freezeCanonical({
        kind: 'file-playback-pause-transition' as const,
        from,
        to,
        atRoomTimeMs,
      });
      evidence = freezeCanonical({
        kind: 'pause-applied' as const,
        observation: 'webaudio-schedule-passed' as const,
        from,
        to,
        targetFrame: 96_000,
        appliedFrame: 96_000,
      });
      timeline = this.options.controller.commitHostPlaybackTransition({
        kind,
        roomGeneration: this.options.roomGeneration,
        expectedPrevious: previous,
        intent,
        evidence,
      }).timeline;
    } else if (kind === 'seek') {
      const intent = freezeCanonical({
        kind: 'file-playback-seek-transition' as const,
        from,
        to,
        positionSeconds: seekPositionSeconds ?? this.positionSeconds,
        atRoomTimeMs,
      });
      evidence = freezeCanonical({
        kind: 'seek-applied' as const,
        observation: 'webaudio-schedule-passed' as const,
        from,
        to,
        positionSeconds: intent.positionSeconds,
        targetFrame: 96_000,
        appliedFrame: 96_000,
      });
      timeline = this.options.controller.commitHostPlaybackTransition({
        kind,
        roomGeneration: this.options.roomGeneration,
        expectedPrevious: previous,
        intent,
        evidence,
      }).timeline;
      this.positionSeconds = intent.positionSeconds;
    } else {
      if (!this.audioContext) throw new Error('Fixture stop has no AudioContext');
      const target = freezeCanonical({
        audioContext: this.audioContext,
        contextTimeSeconds: 2,
        targetFrame: 96_000,
      });
      const intent = freezeCanonical({
        kind: 'file-playback-stop-transition' as const,
        from,
        to,
        atRoomTimeMs,
        target,
      });
      evidence = freezeCanonical({
        kind: 'stop-applied' as const,
        observation: 'webaudio-schedule-passed' as const,
        from,
        to,
        targetFrame: target.targetFrame,
        appliedFrame: target.targetFrame,
      });
      timeline = this.options.controller.commitHostPlaybackTransition({
        kind,
        roomGeneration: this.options.roomGeneration,
        expectedPrevious: previous,
        intent,
        evidence,
      }).timeline;
    }
    this.revision = to.revision;
    this.phase = kind === 'pause' || kind === 'seek' ? 'paused' : 'stopped';
    await waitForPlanGate(plan.afterCommit, signal, true);
    return freezeCanonical({
      schemaVersion: 1 as const,
      kind,
      roomGeneration: this.options.roomGeneration,
      evidence,
      timeline,
    });
  }
}

interface HarnessOptions {
  readonly enginePlan?: EnginePlan;
  readonly boundedRoutePolicy?: Readonly<FilePlaybackBoundedRoutePolicy>;
  readonly initGate?: ReturnType<typeof deferred<void>>;
  readonly ensureGate?: ReturnType<typeof deferred<void>>;
  readonly destination?: AudioNode | null;
  readonly onCreateEngine?: (engine: FixtureEngine) => void;
  readonly onGetAudioContext?: () => void;
  readonly onGetDestination?: () => void;
  readonly onReferencesReleased?: (snapshot: Readonly<Record<string, false>>) => void;
  readonly onTransitionScheduled?: (
    event: Readonly<HostCurrentPlaybackTransitionScheduledEvent>,
  ) => void;
  readonly onRemoteEndRequired?: (event: Readonly<HostRemoteEndRequiredEvent>) => void;
  readonly onTimelineCommitted?: (
    event: Readonly<HostCurrentPlaybackTimelineCommittedEvent>,
  ) => void;
}

interface Harness {
  readonly room: FilePlaybackProductHostRoom;
  readonly controller: FilePlaybackApplicationController;
  readonly roomClock: FilePlaybackRoomClock;
  readonly clockLease: ReturnType<FilePlaybackRoomClock['beginHostSession']>;
  readonly context: FakeAudioContext;
  readonly engines: FixtureEngine[];
  readonly fatal: ReturnType<typeof vi.fn>;
  readonly initAudio: ReturnType<typeof vi.fn>;
  readonly ensureRunning: ReturnType<typeof vi.fn>;
  readonly getAudioContext: ReturnType<typeof vi.fn>;
  readonly getDestination: ReturnType<typeof vi.fn>;
  readonly decoder: OrdinaryAudioDecoder;
  readonly events: string[];
  readonly released: Array<Readonly<Record<string, false>>>;
}

let harnessSequence = 0;

function makeHarness(options: HarnessOptions = {}): Harness {
  harnessSequence += 1;
  const events: string[] = [];
  const controller = new FilePlaybackApplicationController({
    initialTimeline: createStoppedPlaybackTimeline(0, 0),
    idIssuer: new FilePlaybackProductBaselineIdIssuer({
      createBaselineId: () => `product-host-room-baseline-${harnessSequence}`,
    }),
    sendRequired: vi.fn(() => true),
    closeConnection: vi.fn(),
  });
  controller.beginRoom(createStoppedPlaybackTimeline(1_000, 0));
  controller.claimRoomRole('host');
  const roomClock = new FilePlaybackRoomClock({
    createHostClock: () => new FilePlaybackClock({ now: () => 1_000 }),
  });
  const clockLease = roomClock.beginHostSession();
  const context = new FakeAudioContext();
  const destination =
    options.destination === undefined ? destinationFor(context) : options.destination;
  const engines: FixtureEngine[] = [];
  const fatal = vi.fn();
  const initAudio = vi.fn(async () => {
    events.push('graph:init');
    if (options.initGate) await options.initGate.promise;
  });
  const ensureRunning = vi.fn(async () => {
    events.push('graph:running');
    if (options.ensureGate) await options.ensureGate.promise;
  });
  const getAudioContext = vi.fn(() => {
    options.onGetAudioContext?.();
    return context as unknown as AudioContext;
  });
  const getDestination = vi.fn(() => {
    options.onGetDestination?.();
    return destination;
  });
  const decoder: OrdinaryAudioDecoder = vi.fn(async () => ({
    audioBuffer: {} as AudioBuffer,
    release: vi.fn(),
  }));
  const createEngine = vi.fn((engineOptions: Readonly<FilePlaybackHostFirstFileEngineOptions>) => {
    const engine = new FixtureEngine(engineOptions, options.enginePlan ?? {}, events);
    engines.push(engine);
    options.onCreateEngine?.(engine);
    return engine;
  });
  const released: Array<Readonly<Record<string, false>>> = [];
  const room = new FilePlaybackProductHostRoom({
    controller,
    hostRoomSnapshot: freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: controller.snapshot().roomGeneration,
      applicationSessionId: `product-host-room-session-${harnessSequence}`,
      hostParticipantId: `product-host-room-host-${harnessSequence}`,
    }),
    roomClock,
    ...(options.boundedRoutePolicy ? { boundedRoutePolicy: options.boundedRoutePolicy } : {}),
    onFatalRoom: fatal,
    ...(options.onTransitionScheduled
      ? { onTransitionScheduled: options.onTransitionScheduled }
      : {}),
    ...(options.onRemoteEndRequired ? { onRemoteEndRequired: options.onRemoteEndRequired } : {}),
    ...(options.onTimelineCommitted ? { onTimelineCommitted: options.onTimelineCommitted } : {}),
    runtimeForTests: {
      initAudioForTests: initAudio,
      ensureRunningForTests: ensureRunning,
      getAudioContextForTests: getAudioContext,
      getFilePlaybackDestinationForTests: getDestination,
      decodeOrdinaryAudioForTests: decoder,
      createRoomTokenForTests: () => freezeCanonical({ harness: harnessSequence }),
      createEngineForTests: createEngine,
      onTerminalReferencesReleasedForTests: (snapshot) => {
        events.push('references:released');
        released.push(snapshot);
        options.onReferencesReleased?.(snapshot);
      },
    },
  });
  return {
    room,
    controller,
    roomClock,
    clockLease,
    context,
    engines,
    fatal,
    initAudio,
    ensureRunning,
    getAudioContext,
    getDestination,
    decoder,
    events,
    released,
  };
}

function file(name: string, type = 'audio/mpeg'): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type, lastModified: 7 });
}

function first(
  room: FilePlaybackProductHostRoom,
  queueItemId: QueueItemId,
  value: File,
  signal = new AbortController().signal,
) {
  return room.startFirstLocalFile({ queueItemId, file: value, signal });
}

function warm(
  room: FilePlaybackProductHostRoom,
  queueItemId: QueueItemId,
  value: File,
  signal = new AbortController().signal,
) {
  return room.warmLocalTrack({ queueItemId, file: value, signal });
}

function clearWarm(
  room: FilePlaybackProductHostRoom,
  queueItemId: QueueItemId,
  signal = new AbortController().signal,
) {
  return room.clearWarmLocalTrack({ queueItemId, signal });
}

function track(
  room: FilePlaybackProductHostRoom,
  queueItemId: QueueItemId,
  value: File,
  positionSeconds = 0,
  signal = new AbortController().signal,
) {
  return room.startLocalTrack({ queueItemId, file: value, positionSeconds, signal });
}

function trackWithCohort(
  room: FilePlaybackProductHostRoom,
  queueItemId: QueueItemId,
  value: File,
  prepareRemoteParticipants: (
    context: Readonly<FilePlaybackProductHostPreparedCohortContext>,
  ) => Promise<readonly Readonly<HostPreparedRemoteParticipant>[]>,
  positionSeconds = 0,
  signal = new AbortController().signal,
) {
  return room.startLocalTrackWithCohort({
    queueItemId,
    file: value,
    positionSeconds,
    signal,
    prepareRemoteParticipants,
  });
}

function signalOptions() {
  return { signal: new AbortController().signal };
}

function containsBody(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return true;
  }
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(Object.getOwnPropertyDescriptors(value)).some(
    (descriptor) => Object.hasOwn(descriptor, 'value') && containsBody(descriptor.value, seen),
  );
}

describe('FilePlaybackProductHostRoom stable facade', () => {
  it('warms and clears one exact bounded source without allocating timeline authority', async () => {
    const setup = makeHarness({ enginePlan: { warmBackend: 'bounded-stream' } });
    const media = file('warm.bin', 'application/octet-stream');
    const external = new AbortController();
    const before = setup.controller.timelineSnapshot();

    const result = await warm(setup.room, Q1, media, external.signal);
    const engine = setup.engines[0]!;
    const warmInput = engine.warmLocalTrack.mock.calls[0]?.[0];
    const engineResult = await engine.warmLocalTrack.mock.results[0]!.value;

    expect(result).toMatchObject({
      schemaVersion: 1,
      roomGeneration: setup.controller.snapshot().roomGeneration,
      applicationSessionId: expect.any(String),
      hostParticipantId: expect.any(String),
      status: 'warmed',
      backend: 'bounded-stream',
      asset: {
        binding: { queueItemId: Q1 },
        metadata: { name: media.name, mime: media.type },
        encodedSize: media.size,
      },
      readiness: {
        durationSeconds: 180,
        bufferedAheadSeconds: 8,
        outputSampleRateHz: 48_000,
        channelCount: 2,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.sourceLease).not.toBeNull();
    expect(result.sourceLease).toBe(engineResult.sourceLease);
    expect(containsBody(result)).toBe(false);
    expect(setup.controller.timelineSnapshot()).toBe(before);
    expect(warmInput).toEqual({
      queueItemId: Q1,
      blob: media,
      name: media.name,
      mime: media.type,
      audioContext: setup.context,
      decodeOrdinaryAudio: setup.decoder,
      signal: expect.any(AbortSignal),
    });
    expect(warmInput?.signal).not.toBe(external.signal);
    expect(engine.prepareLocalTrack).not.toHaveBeenCalled();
    expect(engine.startPreparedLocalTrack).not.toHaveBeenCalled();

    await expect(clearWarm(setup.room, Q2)).resolves.toBe(false);
    await expect(clearWarm(setup.room, Q1)).resolves.toBe(true);
    expect(engine.clearWarmLocalTrack).toHaveBeenLastCalledWith({ queueItemId: Q1 });
    expect(setup.controller.timelineSnapshot()).toBe(before);
    await setup.room.close();
  });

  it.each([
    ['WAV', 'long-session.wav', 'audio/wav'],
    ['AIFF', 'long-session.aiff', 'audio/aiff'],
    ['CAF', 'long-session.caf', 'audio/x-caf'],
    ['FLAC', 'long-session.flac', 'audio/flac'],
    ['MP3', 'long-session.mp3', 'audio/mpeg'],
    ['AAC', 'long-session.aac', 'audio/aac'],
    ['M4A', 'long-session.m4a', 'audio/mp4'],
  ] as const)(
    'forwards %s through the same format-neutral bounded warm capability',
    async (_label, name, mime) => {
      const setup = makeHarness({ enginePlan: { warmBackend: 'bounded-stream' } });
      const media = file(name, mime);

      const result = await warm(setup.room, Q1, media);
      const engine = setup.engines[0]!;

      expect(result).toMatchObject({
        status: 'warmed',
        backend: 'bounded-stream',
        asset: {
          binding: { queueItemId: Q1 },
          metadata: { name, mime },
          encodedSize: media.size,
        },
      });
      expect(containsBody(result)).toBe(false);
      expect(result.sourceLease).not.toBeNull();
      expect(engine.warmLocalTrack).toHaveBeenCalledOnce();
      expect(engine.warmLocalTrack).toHaveBeenCalledWith(
        expect.objectContaining({ queueItemId: Q1, blob: media, name, mime }),
      );

      await setup.room.close();
    },
  );

  it('projects skipped non-bounded warm truth with an explicit null lease', async () => {
    const setup = makeHarness({ enginePlan: { warmBackend: 'audio-buffer' } });
    const result = await warm(setup.room, Q1, file('ordinary.wav', 'audio/wav'));
    const engineResult = await setup.engines[0]!.warmLocalTrack.mock.results[0]!.value;

    expect(result).toMatchObject({
      status: 'skipped-non-bounded',
      backend: 'audio-buffer',
      sourceLease: null,
    });
    expect(Object.hasOwn(result, 'sourceLease')).toBe(true);
    expect(result.sourceLease).toBe(engineResult.sourceLease);
  });

  it('resolves and clears only the exact issued warm lease without weakening engine races', async () => {
    const setup = makeHarness({ enginePlan: { warmBackend: 'bounded-stream' } });
    const media = file('exact-warm.flac', 'audio/flac');
    const result = await warm(setup.room, Q1, media);
    const sourceLease = result.sourceLease;
    if (!sourceLease) throw new Error('Fixture exact warm lease is unavailable');
    const sourceIdentity = result.asset.binding.sourceIdentity;
    const peerAuthority = new AbortController();

    await expect(
      setup.room.resolveWarmPeerRangeSource({
        sourceLease,
        sourceIdentity,
        peerRangeManifest: null,
        signal: peerAuthority.signal,
      }),
    ).resolves.toBe(media);
    expect(setup.engines[0]?.resolveWarmPeerRangeSource).toHaveBeenCalledWith({
      sourceLease,
      sourceIdentity,
      peerRangeManifest: null,
      signal: peerAuthority.signal,
    });

    setup.engines[0]?.clearWarmLocalTrack.mockResolvedValueOnce(false);
    await expect(
      setup.room.clearWarmLocalTrackByLease({
        sourceLease,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(false);
    await expect(
      setup.room.clearWarmLocalTrackByLease({
        sourceLease,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(true);
    await expect(
      setup.room.clearWarmLocalTrackByLease({
        sourceLease,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(false);
    await expect(
      setup.room.resolveWarmPeerRangeSource({
        sourceLease,
        sourceIdentity,
        peerRangeManifest: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/stale/u);
  });

  it('preserves the exact warm manifest selector identity through the room facade', async () => {
    const peerRangeManifest = manifestPublication();
    const setup = makeHarness({
      enginePlan: { warmBackend: 'bounded-stream', warmPeerRangeManifest: peerRangeManifest },
    });
    const media = file('manifest-warm.aac', 'audio/aac');
    const result = await warm(setup.room, Q1, media);
    if (!result.sourceLease) throw new Error('Fixture manifest warm lease is unavailable');

    expect(result.asset.peerRangeManifest).toBe(peerRangeManifest);
    await expect(
      setup.room.resolveWarmPeerRangeSource({
        sourceLease: result.sourceLease,
        sourceIdentity: result.asset.binding.sourceIdentity,
        peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(media);

    const forwarded = setup.engines[0]?.resolveWarmPeerRangeSource.mock.calls[0]?.[0];
    expect(forwarded?.peerRangeManifest).toBe(peerRangeManifest);
  });

  it('rejects copied and cross-room warm lease identities before engine authority', async () => {
    const firstRoom = makeHarness({ enginePlan: { warmBackend: 'bounded-stream' } });
    const secondRoom = makeHarness({ enginePlan: { warmBackend: 'bounded-stream' } });
    const result = await warm(firstRoom.room, Q1, file('lease-owner.flac', 'audio/flac'));
    const sourceLease = result.sourceLease;
    if (!sourceLease) throw new Error('Fixture exact warm lease is unavailable');
    const copiedLease = freezeCanonical({
      ...(sourceLease as unknown as Record<string, never>),
    }) as unknown as HostLocalTrackSourceLease;
    const options = (lease: HostLocalTrackSourceLease) => ({
      sourceLease: lease,
      sourceIdentity: result.asset.binding.sourceIdentity,
      peerRangeManifest: null,
      signal: new AbortController().signal,
    });

    await expect(firstRoom.room.resolveWarmPeerRangeSource(options(copiedLease))).rejects.toThrow(
      /not issued/u,
    );
    await expect(
      firstRoom.room.clearWarmLocalTrackByLease({
        sourceLease: copiedLease,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/not issued/u);
    await expect(secondRoom.room.resolveWarmPeerRangeSource(options(sourceLease))).rejects.toThrow(
      /not issued/u,
    );
    await expect(
      secondRoom.room.clearWarmLocalTrackByLease({
        sourceLease,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/not issued/u);
    expect(firstRoom.engines[0]?.resolveWarmPeerRangeSource).not.toHaveBeenCalled();
    expect(firstRoom.engines[0]?.clearWarmLocalTrack).not.toHaveBeenCalled();
    expect(secondRoom.engines).toHaveLength(0);
  });

  it('closes a late encoded warm source after its peer authority aborts', async () => {
    const setup = makeHarness({ enginePlan: { warmBackend: 'bounded-stream' } });
    const result = await warm(setup.room, Q1, file('late-warm.flac', 'audio/flac'));
    const sourceLease = result.sourceLease;
    if (!sourceLease) throw new Error('Fixture exact warm lease is unavailable');
    const sourceGate = deferred<HostPeerRangeSource>();
    const closeSource = vi.fn(async () => undefined);
    setup.engines[0]?.resolveWarmPeerRangeSource.mockImplementationOnce(
      async () => sourceGate.promise,
    );
    const peerAuthority = new AbortController();
    const pending = setup.room.resolveWarmPeerRangeSource({
      sourceLease,
      sourceIdentity: result.asset.binding.sourceIdentity,
      peerRangeManifest: null,
      signal: peerAuthority.signal,
    });
    await drainMicrotasks();

    peerAuthority.abort(new Error('warm peer retired'));
    sourceGate.resolve({ close: closeSource } as unknown as HostPeerRangeSource);

    await expect(pending).rejects.toThrow('warm peer retired');
    expect(closeSource).toHaveBeenCalledOnce();
  });

  it('rejects missing or contradictory warm lease projections', async () => {
    const withoutLease = makeHarness({
      enginePlan: {
        warmBackend: 'bounded-stream',
        warmResultTransform: (result) => {
          const copy = Object.assign(Object.create(null), result) as Record<string, unknown>;
          Reflect.deleteProperty(copy, 'sourceLease');
          return Object.freeze(copy) as unknown as Readonly<HostLocalTrackWarmResult>;
        },
      },
    });
    await expect(warm(withoutLease.room, Q1, file('missing.flac', 'audio/flac'))).rejects.toThrow(
      /warm result/u,
    );

    const warmedWithoutAuthority = makeHarness({
      enginePlan: {
        warmBackend: 'bounded-stream',
        warmResultTransform: (result) => freezeCanonical({ ...result, sourceLease: null }),
      },
    });
    await expect(
      warm(warmedWithoutAuthority.room, Q1, file('null.flac', 'audio/flac')),
    ).rejects.toThrow(/warm result/u);

    const skippedWithAuthority = makeHarness({
      enginePlan: {
        warmBackend: 'audio-buffer',
        warmResultTransform: (result) =>
          freezeCanonical({
            ...result,
            sourceLease: freezeCanonical({}) as unknown as HostLocalTrackSourceLease,
          }),
      },
    });
    await expect(
      warm(skippedWithAuthority.room, Q1, file('contradiction.wav', 'audio/wav')),
    ).rejects.toThrow(/warm result/u);
  });

  it('clears an absent warm slot without initializing the graph or engine', async () => {
    const setup = makeHarness();

    await expect(clearWarm(setup.room, Q1)).resolves.toBe(false);

    expect(setup.initAudio).not.toHaveBeenCalled();
    expect(setup.ensureRunning).not.toHaveBeenCalled();
    expect(setup.getAudioContext).not.toHaveBeenCalled();
    expect(setup.getDestination).not.toHaveBeenCalled();
    expect(setup.engines).toHaveLength(0);
  });

  it('rejects non-exact warm options before touching the audio graph', async () => {
    const setup = makeHarness();

    await expect(
      setup.room.warmLocalTrack({
        queueItemId: Q1,
        file: file('invalid.flac', 'audio/flac'),
        signal: new AbortController().signal,
        extra: true,
      } as never),
    ).rejects.toThrow(/options are invalid/u);
    await expect(
      setup.room.clearWarmLocalTrack({
        queueItemId: Q1,
        signal: new AbortController().signal,
        extra: true,
      } as never),
    ).rejects.toThrow(/options are invalid/u);

    expect(setup.initAudio).not.toHaveBeenCalled();
    expect(setup.engines).toHaveLength(0);
  });

  it('preserves policy omission and forwards one canonical universal-v1 policy to its engine', async () => {
    const omitted = makeHarness();
    await track(omitted.room, Q1, file('policy-omitted.mp3'));
    expect(omitted.engines[0]?.options).not.toHaveProperty('boundedRoutePolicy');

    const requested = Object.freeze({
      mode: 'universal-v1' as const,
      aacBackendId: 'webcodecs' as const,
      m4aBackendId: 'webcodecs' as const,
    });
    const optedIn = makeHarness({ boundedRoutePolicy: requested });
    await track(optedIn.room, Q1, file('policy-opted-in.m4a', 'audio/mp4'));

    expect(optedIn.engines[0]?.options.boundedRoutePolicy).toBe(
      FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
    );
    expect(optedIn.engines[0]?.options.boundedRoutePolicy).not.toBe(requested);
  });

  it('rejects an invalid route policy before creating an engine or touching the audio graph', () => {
    const onCreateEngine = vi.fn();
    const onGetAudioContext = vi.fn();
    expect(() =>
      makeHarness({
        boundedRoutePolicy: Object.freeze({
          mode: 'universal-v1',
          aacBackendId: 'webcodecs',
          m4aBackendId: 'automatic',
        }) as unknown as Readonly<FilePlaybackBoundedRoutePolicy>,
        onCreateEngine,
        onGetAudioContext,
      }),
    ).toThrow(/M4A backend must be exactly webcodecs/u);
    expect(onCreateEngine).not.toHaveBeenCalled();
    expect(onGetAudioContext).not.toHaveBeenCalled();
  });

  it('forwards exact transition observers to its single engine lifetime', async () => {
    const onTransitionScheduled = vi.fn();
    const onRemoteEndRequired = vi.fn();
    const onTimelineCommitted = vi.fn();
    const setup = makeHarness({
      onTransitionScheduled,
      onRemoteEndRequired,
      onTimelineCommitted,
    });

    await track(setup.room, Q1, file('observer.mp3'));

    expect(setup.engines).toHaveLength(1);
    expect(setup.engines[0]?.options.onTransitionScheduled).toBe(onTransitionScheduled);
    expect(setup.engines[0]?.options.onRemoteEndRequired).toBe(onRemoteEndRequired);
    expect(setup.engines[0]?.options.onTimelineCommitted).toBe(onTimelineCommitted);
  });

  it('forwards peer publication, range source, and recovery without reinitializing audio', async () => {
    const setup = makeHarness();
    const media = file('peer-forward.mp3');
    const started = await first(setup.room, Q1, media);
    const engine = setup.engines[0]!;
    const publication = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: started.roomGeneration,
      backend: started.backend,
      state: freezeCanonical({
        queueItemId: started.attempt.queueItemId,
        runId: started.attempt.runId,
        revision: started.attempt.revision,
      }),
      timeline: started.timeline,
      asset: freezeCanonical({
        kind: started.asset.kind,
        binding: freezeCanonical({
          queueItemId: started.asset.queueItemId,
          sourceIdentity: started.asset.sourceIdentity,
          transferSessionId: started.asset.transferSessionId,
        }),
        metadata: freezeCanonical({ name: started.asset.name, mime: started.asset.mime }),
        encodedSize: started.asset.size,
        peerRangeManifest: null,
      }),
    });
    engine.currentPeerPublication.mockReturnValue(publication);
    engine.resolveCurrentPeerRangeSource.mockResolvedValue(media);
    const participant = new RemoteRendezvousParticipant({
      participantId: 'product-recovery-peer',
      rendererEvidenceScope: Object.freeze({
        sessionId: 'product-recovery-session',
        connectionId: 'product-recovery-connection',
        recipientParticipantId: 'product-recovery-host',
        sourceIdentity: publication.asset.binding.sourceIdentity,
        transferSessionId: publication.asset.binding.transferSessionId,
      }),
      rttP95Ms: 10,
      armP95Ms: 10,
      nowRoomTimeMs: () => 1_000,
      dispatchArm: vi.fn(),
      dispatchFinalize: vi.fn(),
      dispatchCancel: vi.fn(),
    });
    const recoveryCommit = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: started.roomGeneration,
      participantId: participant.participantId,
      publication,
      attempt: started.attempt,
      schedule: started.schedule,
      timeline: started.timeline,
    });
    engine.recoverRemoteParticipant.mockResolvedValue(recoveryCommit);
    const graphCalls = {
      init: setup.initAudio.mock.calls.length,
      running: setup.ensureRunning.mock.calls.length,
      context: setup.getAudioContext.mock.calls.length,
      destination: setup.getDestination.mock.calls.length,
    };

    expect(setup.room.currentPeerPublication()).toBe(publication);
    const sourceSignal = new AbortController().signal;
    await expect(
      setup.room.resolveCurrentPeerRangeSource({
        publication,
        sourceIdentity: publication.asset.binding.sourceIdentity,
        peerRangeManifest: null,
        signal: sourceSignal,
      }),
    ).resolves.toBe(media);
    const bindAttempt = vi.fn(async () => undefined);
    await expect(
      setup.room.recoverRemoteParticipant({
        publication,
        participant,
        signal: new AbortController().signal,
        bindAttempt,
      }),
    ).resolves.toBe(recoveryCommit);
    expect(engine.resolveCurrentPeerRangeSource).toHaveBeenCalledWith({
      publication,
      sourceIdentity: publication.asset.binding.sourceIdentity,
      peerRangeManifest: null,
      signal: expect.any(AbortSignal),
    });
    expect(engine.recoverRemoteParticipant).toHaveBeenCalledWith({
      publication,
      participant,
      signal: expect.any(AbortSignal),
      bindAttempt,
    });
    expect(setup.initAudio).toHaveBeenCalledTimes(graphCalls.init);
    expect(setup.ensureRunning).toHaveBeenCalledTimes(graphCalls.running);
    expect(setup.getAudioContext).toHaveBeenCalledTimes(graphCalls.context);
    expect(setup.getDestination).toHaveBeenCalledTimes(graphCalls.destination);
    await setup.room.close();
  });

  it('preserves exact and copied current manifest selectors for engine authentication', async () => {
    const setup = makeHarness();
    const started = await first(setup.room, Q1, file('current-selector.aac', 'audio/aac'));
    const issuedManifest = manifestPublication();
    const copiedManifest = freezeCanonical({ ...issuedManifest });
    const publication = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: started.roomGeneration,
      backend: started.backend,
      state: freezeCanonical({
        queueItemId: started.attempt.queueItemId,
        runId: started.attempt.runId,
        revision: started.attempt.revision,
      }),
      timeline: started.timeline,
      asset: freezeCanonical({
        kind: started.asset.kind,
        binding: freezeCanonical({
          queueItemId: started.asset.queueItemId,
          sourceIdentity: started.asset.sourceIdentity,
          transferSessionId: started.asset.transferSessionId,
        }),
        metadata: freezeCanonical({ name: started.asset.name, mime: started.asset.mime }),
        encodedSize: started.asset.size,
        peerRangeManifest: issuedManifest,
      }),
    });
    const engine = setup.engines[0]!;
    engine.currentPeerPublication.mockReturnValue(publication);
    engine.resolveCurrentPeerRangeSource
      .mockResolvedValueOnce(file('resolved-selector.aac', 'audio/aac'))
      .mockRejectedValueOnce(new Error('Fixture engine rejected copied manifest selector'));

    await expect(
      setup.room.resolveCurrentPeerRangeSource({
        publication,
        sourceIdentity: publication.asset.binding.sourceIdentity,
        peerRangeManifest: issuedManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeInstanceOf(Blob);
    expect(engine.resolveCurrentPeerRangeSource.mock.calls[0]?.[0].peerRangeManifest).toBe(
      issuedManifest,
    );

    await expect(
      setup.room.resolveCurrentPeerRangeSource({
        publication,
        sourceIdentity: publication.asset.binding.sourceIdentity,
        peerRangeManifest: copiedManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/copied manifest selector/u);

    const forwarded = engine.resolveCurrentPeerRangeSource.mock.calls[1]?.[0];
    expect(forwarded?.peerRangeManifest).toBe(copiedManifest);
    expect(forwarded?.peerRangeManifest).not.toBe(issuedManifest);
  });

  it.each([
    ['ordinary to FLAC', file('one.mp3'), file('two.flac', 'audio/flac'), 'bounded-stream'],
    [
      'FLAC to ordinary',
      file('one.flac', 'audio/flac'),
      file('two.m4a', 'audio/mp4'),
      'audio-buffer',
    ],
  ] as const)(
    'replaces cross-Q %s on one stable private engine',
    async (_label, q1, q2, backend) => {
      const setup = makeHarness();

      await first(setup.room, Q1, q1);
      const result = await track(setup.room, Q2, q2, 3.5);

      expect(result).toMatchObject({
        status: 'committed',
        backend,
        attempt: { queueItemId: Q2 },
        schedule: { positionSeconds: 3.5 },
      });
      expect(setup.engines).toHaveLength(1);
      expect(setup.engines[0]?.prepareLocalTrack).toHaveBeenCalledTimes(2);
      expect(setup.engines[0]?.startPreparedLocalTrack).toHaveBeenCalledTimes(2);
      expect(setup.engines[0]?.startLocalTrack).not.toHaveBeenCalled();
      for (const [start] of setup.engines[0]?.startPreparedLocalTrack.mock.calls ?? []) {
        expect(start.remoteParticipants).toEqual([]);
      }
      expect(setup.engines[0]?.close).not.toHaveBeenCalled();
      expect(setup.room.currentRendererSnapshot()).toMatchObject({ queueItemId: Q2, backend });
      expect(setup.room.positionAt(2_000)?.queueItemId).toBe(Q2);
      expect(containsBody(result)).toBe(false);
    },
  );

  it('prepares one exact body-free remote cohort and starts it inside the candidate fence', async () => {
    const setup = makeHarness();
    const media = file('cohort.flac', 'audio/flac');
    const engine = setup.engines[0];
    const peerSource = new AbortController();
    const prepareRemoteParticipants = vi.fn(
      async (context: Readonly<FilePlaybackProductHostPreparedCohortContext>) => {
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.prepared)).toBe(true);
        expect(containsBody(context.prepared)).toBe(false);
        expect(context.prepared).toMatchObject({
          backend: 'bounded-stream',
          state: { queueItemId: Q1 },
          positionSeconds: 7.25,
          asset: { encodedSize: media.size },
        });
        const createdEngine = setup.engines[0]!;
        createdEngine.resolvePreparedPeerRangeSource.mockResolvedValueOnce(media);
        await expect(
          context.resolveSource(
            context.prepared.asset.binding.sourceIdentity,
            null,
            peerSource.signal,
          ),
        ).resolves.toBe(media);
        const participant = new RemoteRendezvousParticipant({
          participantId: 'product-cohort-peer',
          rendererEvidenceScope: Object.freeze({
            sessionId: 'product-cohort-session',
            connectionId: 'product-cohort-connection',
            recipientParticipantId: 'product-cohort-host',
            sourceIdentity: context.prepared.asset.binding.sourceIdentity,
            transferSessionId: context.prepared.asset.binding.transferSessionId,
          }),
          rttP95Ms: 10,
          armP95Ms: 10,
          nowRoomTimeMs: () => 1_000,
          dispatchArm: vi.fn(),
          dispatchFinalize: vi.fn(),
          dispatchCancel: vi.fn(),
        });
        return [freezeCanonical({ participant, bindAttempt: vi.fn(async () => undefined) })];
      },
    );

    const result = await trackWithCohort(setup.room, Q1, media, prepareRemoteParticipants, 7.25);
    const createdEngine = setup.engines[0]!;
    const prepared = createdEngine.prepareLocalTrack.mock.results[0]?.value;
    const context = prepareRemoteParticipants.mock.calls[0]?.[0];

    expect(engine).toBeUndefined();
    expect(prepareRemoteParticipants).toHaveBeenCalledOnce();
    expect(context?.signal).toBe(createdEngine.prepareLocalTrack.mock.calls[0]?.[0].signal);
    expect(createdEngine.resolvePreparedPeerRangeSource).toHaveBeenCalledWith({
      prepared: await prepared,
      sourceIdentity: context?.prepared.asset.binding.sourceIdentity,
      peerRangeManifest: null,
      signal: peerSource.signal,
    });
    expect(createdEngine.startPreparedLocalTrack).toHaveBeenCalledOnce();
    expect(createdEngine.startPreparedLocalTrack.mock.calls[0]?.[0].prepared).toBe(
      context?.prepared,
    );
    expect(createdEngine.startPreparedLocalTrack.mock.calls[0]?.[0].remoteParticipants).toBe(
      await prepareRemoteParticipants.mock.results[0]?.value,
    );
    expect(result).toMatchObject({
      status: 'committed',
      backend: 'bounded-stream',
      attempt: { queueItemId: Q1 },
      schedule: { positionSeconds: 7.25 },
    });
    expect(containsBody(result)).toBe(false);
  });

  it('preserves the exact prepared manifest selector identity through the cohort bridge', async () => {
    const peerRangeManifest = manifestPublication();
    const setup = makeHarness({ enginePlan: { preparedPeerRangeManifest: peerRangeManifest } });
    const media = file('prepared-selector.aac', 'audio/aac');

    await trackWithCohort(setup.room, Q1, media, async (context) => {
      expect(context.prepared.asset.peerRangeManifest).toBe(peerRangeManifest);
      setup.engines[0]?.resolvePreparedPeerRangeSource.mockResolvedValueOnce(media);
      await expect(
        context.resolveSource(
          context.prepared.asset.binding.sourceIdentity,
          peerRangeManifest,
          new AbortController().signal,
        ),
      ).resolves.toBe(media);
      return [];
    });

    const forwarded = setup.engines[0]?.resolvePreparedPeerRangeSource.mock.calls[0]?.[0];
    expect(forwarded?.peerRangeManifest).toBe(peerRangeManifest);
  });

  it('lets an exact peer source begun before commit finish after the room operation settles', async () => {
    const setup = makeHarness();
    const media = file('late-cohort-source.flac', 'audio/flac');
    const startAuthority = new AbortController();
    const peerAuthority = new AbortController();
    const sourceGate = deferred<HostPeerRangeSource>();
    let sourceResolution: Promise<HostPeerRangeSource> | null = null;

    const committed = await trackWithCohort(
      setup.room,
      Q1,
      media,
      async (context) => {
        setup.engines[0]?.resolvePreparedPeerRangeSource.mockImplementationOnce(
          async () => sourceGate.promise,
        );
        sourceResolution = context.resolveSource(
          context.prepared.asset.binding.sourceIdentity,
          null,
          peerAuthority.signal,
        );
        void sourceResolution.catch(() => undefined);
        return [];
      },
      0,
      startAuthority.signal,
    );

    expect(committed).toMatchObject({ status: 'committed', attempt: { queueItemId: Q1 } });
    expect(sourceResolution).not.toBeNull();
    startAuthority.abort(new Error('completed start caller released'));
    sourceGate.resolve(media);

    await expect(sourceResolution).resolves.toBe(media);
    expect(setup.engines[0]?.resolvePreparedPeerRangeSource).toHaveBeenCalledWith({
      prepared: setup.engines[0]?.startPreparedLocalTrack.mock.calls[0]?.[0].prepared,
      sourceIdentity: expect.any(String),
      peerRangeManifest: null,
      signal: peerAuthority.signal,
    });
  });

  it('aborts a slow remote cohort callback without starting a dangling candidate', async () => {
    const setup = makeHarness();
    const external = new AbortController();
    const callbackGate = deferred<readonly Readonly<HostPreparedRemoteParticipant>[]>();
    const observed = { callbackSignal: null as AbortSignal | null };
    const pending = trackWithCohort(
      setup.room,
      Q1,
      file('slow-cohort.mp3'),
      async (context) => {
        observed.callbackSignal = context.signal;
        return callbackGate.promise;
      },
      0,
      external.signal,
    );
    await drainMicrotasks();

    external.abort(new Error('cohort cancelled'));

    await expect(pending).rejects.toThrow('cohort cancelled');
    expect(observed.callbackSignal?.aborted).toBe(true);
    expect(setup.engines[0]?.startPreparedLocalTrack).not.toHaveBeenCalled();
    callbackGate.resolve([]);
    await drainMicrotasks();
    expect(setup.engines[0]?.startPreparedLocalTrack).not.toHaveBeenCalled();
  });

  it('closes a prepared source which resolves after its cohort operation became stale', async () => {
    const setup = makeHarness();
    const external = new AbortController();
    const peerSource = new AbortController();
    const sourceGate = deferred<HostPeerRangeSource>();
    const closeSource = vi.fn(async () => undefined);
    const pending = trackWithCohort(
      setup.room,
      Q1,
      file('late-source.flac', 'audio/flac'),
      async (context) => {
        setup.engines[0]?.resolvePreparedPeerRangeSource.mockImplementationOnce(
          async () => sourceGate.promise,
        );
        await context.resolveSource(
          context.prepared.asset.binding.sourceIdentity,
          null,
          peerSource.signal,
        );
        return [];
      },
      0,
      external.signal,
    );
    await drainMicrotasks();
    external.abort(new Error('source operation superseded'));
    peerSource.abort(new Error('peer source owner retired'));

    await expect(pending).rejects.toThrow('source operation superseded');
    sourceGate.resolve({ close: closeSource } as unknown as HostPeerRangeSource);
    await drainMicrotasks();

    expect(closeSource).toHaveBeenCalledOnce();
    expect(setup.engines[0]?.startPreparedLocalTrack).not.toHaveBeenCalled();
  });

  it('fences synchronous cohort callback reentry and lets only the successor start', async () => {
    const setup = makeHarness();
    let successor: Promise<Readonly<HostFirstLocalFilePlaybackCommit>> | null = null;
    const observed = { staleSignal: null as AbortSignal | null };
    const stale = trackWithCohort(setup.room, Q1, file('stale-reentry.mp3'), async (context) => {
      observed.staleSignal = context.signal;
      successor = track(setup.room, Q2, file('successor.mp3'));
      return [];
    });

    await expect(stale).rejects.toBeTruthy();
    expect(observed.staleSignal?.aborted).toBe(true);
    await expect(successor).resolves.toMatchObject({ attempt: { queueItemId: Q2 } });
    expect(setup.engines[0]?.startPreparedLocalTrack).toHaveBeenCalledOnce();
    expect(setup.controller.timelineSnapshot().run?.queueItemId).toBe(Q2);
  });

  it('fences close reentry from remote cohort preparation without starting the candidate', async () => {
    const setup = makeHarness();
    let terminal: Promise<void> | null = null;
    const pending = trackWithCohort(setup.room, Q1, file('close-reentry.mp3'), async (context) => {
      terminal = setup.room.close();
      expect(context.signal.aborted).toBe(true);
      return [];
    });

    await expect(pending).rejects.toBeTruthy();
    await expect(terminal).resolves.toBeUndefined();
    expect(setup.engines[0]?.startPreparedLocalTrack).not.toHaveBeenCalled();
    expect(setup.engines[0]?.close).toHaveBeenCalledOnce();
  });

  it('rejects stale room authority before a prepared cohort can start', async () => {
    const setup = makeHarness();
    const callbackGate = deferred<readonly Readonly<HostPreparedRemoteParticipant>[]>();
    const pending = trackWithCohort(
      setup.room,
      Q1,
      file('stale-room.mp3'),
      async () => callbackGate.promise,
    );
    await drainMicrotasks();
    setup.controller.beginRoom(createStoppedPlaybackTimeline(2_000, 0));
    setup.controller.claimRoomRole('host');
    callbackGate.resolve([]);

    await expect(pending).rejects.toThrow(/authority|stale/u);
    expect(setup.engines[0]?.startPreparedLocalTrack).not.toHaveBeenCalled();
    expect(setup.engines[0]?.prepareLocalTrack.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it('rejects a non-native remote cohort task before engine start', async () => {
    const setup = makeHarness();

    await expect(
      setup.room.startLocalTrackWithCohort({
        queueItemId: Q1,
        file: file('thenable.mp3'),
        positionSeconds: 0,
        signal: new AbortController().signal,
        prepareRemoteParticipants: (() => ({ then: vi.fn() })) as never,
      }),
    ).rejects.toThrow(/native Promise/u);
    expect(setup.engines[0]?.startPreparedLocalTrack).not.toHaveBeenCalled();
    expect(setup.engines[0]?.prepareLocalTrack.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it('aborts a prephysical candidate and lets its same-engine successor commit', async () => {
    const beforePhysical = deferred<void>();
    const setup = makeHarness({
      enginePlan: { candidates: [{ beforePhysical }, {}] },
    });
    const q1 = first(setup.room, Q1, file('one.mp3'));
    await drainMicrotasks();
    const q2 = track(setup.room, Q2, file('two.flac', 'audio/flac'));

    await expect(q1).rejects.toBeTruthy();
    await expect(q2).resolves.toMatchObject({
      status: 'committed',
      backend: 'bounded-stream',
      attempt: { queueItemId: Q2 },
    });
    expect(setup.engines).toHaveLength(1);
    expect(setup.controller.timelineSnapshot().run?.queueItemId).toBe(Q2);
  });

  it('publishes a postphysical predecessor commit before its queued successor', async () => {
    const afterCommit = deferred<void>();
    const setup = makeHarness({
      enginePlan: { candidates: [{ afterCommit }, {}] },
    });
    const q1 = first(setup.room, Q1, file('one.mp3'));
    await drainMicrotasks();
    expect(setup.controller.timelineSnapshot().run?.queueItemId).toBe(Q1);
    const q2 = track(setup.room, Q2, file('two.mp3'));
    afterCommit.resolve();

    await expect(q1).resolves.toMatchObject({ status: 'committed', attempt: { queueItemId: Q1 } });
    await expect(q2).resolves.toMatchObject({ status: 'committed', attempt: { queueItemId: Q2 } });
    expect(setup.engines).toHaveLength(1);
    expect(setup.controller.timelineSnapshot().run?.queueItemId).toBe(Q2);
  });

  it('commits pause, paused seek, and resume on one run and engine', async () => {
    const setup = makeHarness();
    const started = await first(setup.room, Q1, file('one.mp3'));
    const runId = started.attempt.runId;

    const paused = await setup.room.pauseCurrent(signalOptions());
    const sought = await setup.room.seekPaused({ ...signalOptions(), positionSeconds: 42 });
    const resumed = await setup.room.resumeCurrent(signalOptions());

    expect(paused).toMatchObject({
      status: 'committed',
      kind: 'pause',
      timeline: { phase: 'paused' },
    });
    expect(sought).toMatchObject({
      status: 'committed',
      kind: 'seek',
      timeline: { phase: 'paused' },
    });
    expect(resumed).toMatchObject({
      status: 'committed',
      attempt: { queueItemId: Q1, runId },
      schedule: { positionSeconds: 42 },
      timeline: { phase: 'playing' },
    });
    expect(setup.engines).toHaveLength(1);
    expect(setup.room.currentRendererSnapshot()).toMatchObject({
      queueItemId: Q1,
      phase: 'playing',
      positionSeconds: 42,
    });
  });

  it('commits a playing seek without changing the logical run', async () => {
    const setup = makeHarness();
    const started = await first(setup.room, Q1, file('one.flac', 'audio/flac'));

    const sought = await setup.room.seekPlaying({ ...signalOptions(), positionSeconds: 77 });

    expect(sought).toMatchObject({
      status: 'committed',
      attempt: { queueItemId: Q1, runId: started.attempt.runId },
      schedule: { positionSeconds: 77 },
    });
    expect(sought.attempt.revision).toBe(started.attempt.revision + 1);
    expect(setup.room.positionAt(2_000)?.positionSeconds).toBe(77);
  });

  it('starts an exact-next same-run playing seek with the prepared remote cohort and no new source resolution', async () => {
    const setup = makeHarness();
    const started = await first(setup.room, Q1, file('cohort-seek.flac', 'audio/flac'));
    const prepareRemoteParticipants = vi.fn(
      async (context: Readonly<FilePlaybackProductHostPreparedCohortContext>) => {
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.prepared)).toBe(true);
        expect(context.prepared).toMatchObject({
          backend: 'bounded-stream',
          state: {
            queueItemId: Q1,
            runId: started.attempt.runId,
            revision: started.attempt.revision + 1,
          },
          positionSeconds: 77,
          playbackRate: 1,
          sourceLease: null,
          asset: {
            binding: {
              queueItemId: Q1,
              sourceIdentity: started.asset.sourceIdentity,
              transferSessionId: started.asset.transferSessionId,
            },
          },
        });
        expect(containsBody(context.prepared)).toBe(false);
        const participant = new RemoteRendezvousParticipant({
          participantId: 'product-seek-cohort-peer',
          rendererEvidenceScope: Object.freeze({
            sessionId: 'product-seek-cohort-session',
            connectionId: 'product-seek-cohort-connection',
            recipientParticipantId: 'product-seek-cohort-host',
            sourceIdentity: context.prepared.asset.binding.sourceIdentity,
            transferSessionId: context.prepared.asset.binding.transferSessionId,
          }),
          rttP95Ms: 10,
          armP95Ms: 10,
          nowRoomTimeMs: () => 1_000,
          dispatchArm: vi.fn(),
          dispatchFinalize: vi.fn(),
          dispatchCancel: vi.fn(),
        });
        return [freezeCanonical({ participant, bindAttempt: vi.fn(async () => undefined) })];
      },
    );

    const sought = await setup.room.seekPlayingWithCohort({
      ...signalOptions(),
      positionSeconds: 77,
      prepareRemoteParticipants,
    });
    const engine = setup.engines[0]!;
    const context = prepareRemoteParticipants.mock.calls[0]?.[0];
    const preparedStart = engine.startPreparedLocalTrack.mock.calls.at(-1)?.[0];

    expect(engine.preparePlayingSeek).toHaveBeenCalledOnce();
    expect(engine.preparePlayingSeek).toHaveBeenCalledWith({
      positionSeconds: 77,
      signal: context?.signal,
    });
    expect(engine.seekPlaying).not.toHaveBeenCalled();
    expect(prepareRemoteParticipants).toHaveBeenCalledOnce();
    expect(preparedStart?.prepared).toBe(context?.prepared);
    expect(preparedStart?.remoteParticipants).toBe(
      await prepareRemoteParticipants.mock.results[0]?.value,
    );
    expect(engine.resolvePreparedPeerRangeSource).not.toHaveBeenCalled();
    expect(sought).toMatchObject({
      status: 'committed',
      backend: 'bounded-stream',
      attempt: {
        queueItemId: Q1,
        runId: started.attempt.runId,
        revision: started.attempt.revision + 1,
      },
      schedule: { positionSeconds: 77 },
    });
    expect(containsBody(sought)).toBe(false);
  });

  it('prepares and publishes a fresh replay cohort before starting the zero-position run', async () => {
    const setup = makeHarness();
    const media = file('cohort-replay.flac', 'audio/flac');
    const started = await first(setup.room, Q1, media);
    const prepareRemoteParticipants = vi.fn(
      async (context: Readonly<FilePlaybackProductHostPreparedCohortContext>) => {
        expect(context.prepared).toMatchObject({
          backend: 'bounded-stream',
          state: {
            queueItemId: Q1,
            revision: started.attempt.revision + 1,
          },
          positionSeconds: 0,
          playbackRate: 1,
          asset: {
            binding: {
              queueItemId: Q1,
              sourceIdentity: started.asset.sourceIdentity,
              transferSessionId: started.asset.transferSessionId,
            },
          },
        });
        expect(context.prepared.state.runId).not.toBe(started.attempt.runId);
        await expect(
          context.resolveSource(
            context.prepared.asset.binding.sourceIdentity,
            context.prepared.asset.peerRangeManifest,
            context.signal,
          ),
        ).resolves.toBe(media);
        return [];
      },
    );

    const replayed = await setup.room.replayCurrentWithCohort({
      ...signalOptions(),
      prepareRemoteParticipants,
    });
    const engine = setup.engines[0]!;
    const context = prepareRemoteParticipants.mock.calls[0]?.[0];
    const preparedStart = engine.startPreparedLocalTrack.mock.calls.at(-1)?.[0];

    expect(engine.prepareReplayCurrent).toHaveBeenCalledWith({ signal: context?.signal });
    expect(engine.replayCurrent).not.toHaveBeenCalled();
    expect(preparedStart?.prepared).toBe(context?.prepared);
    expect(preparedStart?.remoteParticipants).toEqual([]);
    expect(prepareRemoteParticipants.mock.invocationCallOrder[0]).toBeLessThan(
      engine.startPreparedLocalTrack.mock.invocationCallOrder.at(-1)!,
    );
    expect(replayed).toMatchObject({
      status: 'committed',
      backend: 'bounded-stream',
      attempt: {
        queueItemId: Q1,
        runId: context?.prepared.state.runId,
        revision: started.attempt.revision + 1,
      },
      schedule: { positionSeconds: 0 },
    });
  });

  it.each([
    ['ordinary', file('terminal.mp3'), 'audio-buffer'],
    ['streaming FLAC', file('terminal.flac', 'audio/flac'), 'bounded-stream'],
  ] as const)(
    'exposes an exact %s natural end only through the terminal observation boundary',
    async (_label, media, backend) => {
      const setup = makeHarness();
      const started = await first(setup.room, Q1, media);

      expect(setup.room.currentTerminalRendererObservation()).toBeNull();
      setup.engines[0]?.observeNaturalEndForTests();

      expect(setup.room.currentRendererSnapshot()).toBeNull();
      const observation = setup.room.currentTerminalRendererObservation();
      expect(observation).toMatchObject({
        queueItemId: Q1,
        backend,
        phase: 'ended',
        revision: started.attempt.revision,
        run: {
          queueItemId: Q1,
          runId: started.attempt.runId,
          revision: started.attempt.revision,
        },
      });
      expect(Object.isFrozen(observation)).toBe(true);
      expect(Object.isFrozen(observation?.run)).toBe(true);
    },
  );

  it.each(['queueItemId', 'runId', 'revision'] as const)(
    'rejects an ended renderer with a mismatched %s identity',
    async (kind) => {
      const setup = makeHarness();
      const started = await first(setup.room, Q1, file('identity.mp3'));
      setup.engines[0]?.observeNaturalEndForTests();
      if (kind === 'queueItemId') {
        setup.engines[0]?.replaceRendererIdentityForTests({ queueItemId: Q2 });
      } else if (kind === 'runId') {
        setup.engines[0]?.replaceRendererIdentityForTests({
          runId: `${started.attempt.runId}-stale-aba`,
        });
      } else {
        setup.engines[0]?.replaceRendererIdentityForTests({
          revision: started.attempt.revision + 1,
        });
      }

      expect(setup.room.currentTerminalRendererObservation()).toBeNull();
    },
  );

  it.each(['stale-generation', 'guest-role'] as const)(
    'fail-closes terminal observation under %s authority',
    async (authority) => {
      const setup = makeHarness();
      await first(setup.room, Q1, file('stale-authority.mp3'));
      setup.engines[0]?.observeNaturalEndForTests();
      expect(setup.room.currentTerminalRendererObservation()).not.toBeNull();

      setup.controller.beginRoom(createStoppedPlaybackTimeline(2_000, 0));
      setup.controller.claimRoomRole(authority === 'guest-role' ? 'guest' : 'host');

      expect(setup.room.currentTerminalRendererObservation()).toBeNull();
    },
  );

  it('fail-closes terminal observation after close or fatal quarantine', async () => {
    const closed = makeHarness();
    await first(closed.room, Q1, file('closed.mp3'));
    closed.engines[0]?.observeNaturalEndForTests();
    expect(closed.room.currentTerminalRendererObservation()).not.toBeNull();
    await closed.room.close();
    expect(closed.room.currentTerminalRendererObservation()).toBeNull();

    const fatal = makeHarness();
    await first(fatal.room, Q1, file('fatal-terminal.flac', 'audio/flac'));
    fatal.engines[0]?.observeNaturalEndForTests();
    expect(fatal.room.currentTerminalRendererObservation()).not.toBeNull();
    fatal.engines[0]?.fatal(new Error('terminal renderer fatal'));
    expect(fatal.room.currentTerminalRendererObservation()).toBeNull();
    await drainMicrotasks();
  });

  it('replays at zero with a new run on the stable engine', async () => {
    const setup = makeHarness();
    const started = await first(setup.room, Q1, file('one.mp3'));

    const replayed = await setup.room.replayCurrent(signalOptions());

    expect(replayed).toMatchObject({
      status: 'committed',
      attempt: { queueItemId: Q1 },
      schedule: { positionSeconds: 0 },
    });
    expect(replayed.attempt.runId).not.toBe(started.attempt.runId);
    expect(setup.engines).toHaveLength(1);
  });

  it('stops and starts a new track without replacing the room engine', async () => {
    const setup = makeHarness();
    await first(setup.room, Q1, file('one.mp3'));

    const stopped = await setup.room.stopCurrent(signalOptions());
    expect(stopped).toMatchObject({
      status: 'committed',
      kind: 'stop',
      timeline: { phase: 'stopped' },
    });
    expect(setup.room.currentRendererSnapshot()).toBeNull();

    const next = await track(setup.room, Q2, file('two.flac', 'audio/flac'));
    expect(next).toMatchObject({
      status: 'committed',
      backend: 'bounded-stream',
      attempt: { queueItemId: Q2 },
    });
    expect(setup.engines).toHaveLength(1);
  });

  it('settles natural end and leaves stopped room truth', async () => {
    const setup = makeHarness();
    await first(setup.room, Q1, file('one.mp3'));
    setup.engines[0]?.observeNaturalEndForTests();
    expect(setup.room.currentTerminalRendererObservation()).not.toBeNull();

    const ended = await setup.room.settleEndedCurrent(signalOptions());

    expect(ended).toMatchObject({
      status: 'committed',
      kind: 'ended',
      evidence: { kind: 'ended-renderer-retired' },
      timeline: { phase: 'stopped', run: null },
    });
    expect(setup.room.currentRendererSnapshot()).toBeNull();
    expect(setup.room.currentTerminalRendererObservation()).toBeNull();
  });

  it('rejects candidates and other transitions while a physical transition is pending', async () => {
    const beforePhysical = deferred<void>();
    const setup = makeHarness({ enginePlan: { transitions: [{ beforePhysical }] } });
    await first(setup.room, Q1, file('one.mp3'));
    const pause = setup.room.pauseCurrent(signalOptions());
    await drainMicrotasks();

    await expect(track(setup.room, Q2, file('two.mp3'))).rejects.toThrow(/transition/u);
    await expect(setup.room.stopCurrent(signalOptions())).rejects.toThrow(/busy/u);
    beforePhysical.resolve();
    await expect(pause).resolves.toMatchObject({ kind: 'pause' });
  });

  it.each(['init', 'ensure'] as const)(
    'keeps a stale %s graph completion from creating an engine',
    async (phase) => {
      const gate = deferred<void>();
      const setup = makeHarness(phase === 'init' ? { initGate: gate } : { ensureGate: gate });
      const pending = first(setup.room, Q1, file('stale.mp3'));
      await drainMicrotasks();
      setup.controller.beginRoom(createStoppedPlaybackTimeline(2_000, 0));
      setup.controller.claimRoomRole('host');
      gate.resolve();

      await expect(pending).rejects.toBeTruthy();
      expect(setup.engines).toHaveLength(0);
      if (phase === 'init') expect(setup.ensureRunning).not.toHaveBeenCalled();
      else expect(setup.getAudioContext).not.toHaveBeenCalled();
    },
  );

  it('allows exact host playback while guest connections are active', async () => {
    const setup = makeHarness();
    const active = establishedHostChannel();
    setup.controller.applicationSessionHooks().onLifecycleEvent(
      freezeCanonical({
        kind: 'established' as const,
        role: 'host' as const,
        connection: active.connection,
        channel: active.channel,
      }),
    );
    expect(setup.controller.snapshot().activeConnectionCount).toBe(1);

    await expect(first(setup.room, Q1, file('connected.mp3'))).resolves.toMatchObject({
      status: 'committed',
    });
    expect(setup.room.currentRendererSnapshot()?.queueItemId).toBe(Q1);
  });

  it('fences factory close reentry and closes the unpublished candidate once', async () => {
    let room: FilePlaybackProductHostRoom | null = null;
    let terminal: Promise<void> | null = null;
    const setup = makeHarness({
      onCreateEngine: () => {
        terminal = room?.close() ?? null;
      },
    });
    room = setup.room;

    await expect(first(setup.room, Q1, file('reentry.mp3'))).rejects.toBeTruthy();
    await expect(terminal).resolves.toBeUndefined();
    expect(setup.engines[0]?.close).toHaveBeenCalledOnce();
    expect(setup.engines[0]?.startLocalTrack).not.toHaveBeenCalled();
  });

  it('propagates unpublished-engine cleanup failure through a reentrant close', async () => {
    const cleanupFailure = new Error('unpublished engine close failed');
    let room: FilePlaybackProductHostRoom | null = null;
    let terminal: Promise<void> | null = null;
    const setup = makeHarness({
      enginePlan: { closeFailure: cleanupFailure },
      onCreateEngine: () => {
        terminal = room?.close() ?? null;
      },
    });
    room = setup.room;

    await expect(first(setup.room, Q1, file('cleanup-failure.mp3'))).rejects.toMatchObject({
      name: 'ProductHostRoomCleanupError',
    });
    await expect(terminal).rejects.toMatchObject({ name: 'ProductHostRoomCleanupError' });
    expect(setup.engines[0]?.close).toHaveBeenCalledOnce();
    expect(setup.events.filter((event) => event === 'references:released')).toHaveLength(1);
  });

  it('makes close idempotent through synchronous engine-close reentry', async () => {
    let room: FilePlaybackProductHostRoom | null = null;
    let reentered: Promise<void> | null = null;
    const setup = makeHarness({
      enginePlan: { onClose: () => (reentered = room?.close() ?? null) },
    });
    room = setup.room;
    await first(setup.room, Q1, file('one.mp3'));

    const closed = setup.room.close();

    expect(reentered).toBe(closed);
    await expect(closed).resolves.toBeUndefined();
    expect(setup.engines[0]?.close).toHaveBeenCalledOnce();
    expect(setup.events.filter((event) => event === 'references:released')).toHaveLength(1);
  });

  it('survives abort-listener close reentry without double-closing or retaining work', async () => {
    const beforePhysical = deferred<void>();
    let room: FilePlaybackProductHostRoom | null = null;
    let reentered: Promise<void> | null = null;
    const external = new AbortController();
    const setup = makeHarness({
      enginePlan: {
        candidates: [
          {
            beforePhysical,
            onAbort: () => (reentered = room?.close() ?? null),
          },
        ],
      },
    });
    room = setup.room;
    const active = first(setup.room, Q1, file('pending.mp3'), external.signal);
    await drainMicrotasks();

    external.abort(new Error('test abort'));

    await expect(active).rejects.toBeTruthy();
    await expect(reentered).resolves.toBeUndefined();
    expect(setup.engines[0]?.close).toHaveBeenCalledOnce();
    expect(setup.events.filter((event) => event === 'references:released')).toHaveLength(1);
  });

  it('reports synchronous engine fatal exact-once after reentrant terminal cleanup', async () => {
    const createdEngine = { current: null as FixtureEngine | null };
    const setup = makeHarness({
      enginePlan: {
        onClose: () => createdEngine.current?.fatal(new Error('duplicate-during-close')),
      },
      onCreateEngine: (created) => {
        createdEngine.current = created;
      },
    });
    await first(setup.room, Q1, file('fatal.mp3'));
    const fatal = new Error('fixture fatal');

    createdEngine.current?.fatal(fatal);
    await setup.room.close().catch(() => undefined);
    await drainMicrotasks();

    expect(setup.engines[0]?.close).toHaveBeenCalledOnce();
    expect(setup.fatal).toHaveBeenCalledOnce();
    expect(setup.fatal).toHaveBeenCalledWith(fatal);
  });

  it('returns a physically committed result even when close races its publication', async () => {
    const afterCommit = deferred<void>();
    const setup = makeHarness({ enginePlan: { candidates: [{ afterCommit }] } });
    const active = first(setup.room, Q1, file('dominant.mp3'));
    await drainMicrotasks();
    expect(setup.controller.timelineSnapshot().run?.queueItemId).toBe(Q1);

    const closed = setup.room.close();
    afterCommit.resolve();

    await expect(active).resolves.toMatchObject({
      status: 'committed',
      attempt: { queueItemId: Q1 },
    });
    await expect(closed).resolves.toBeUndefined();
    expect(setup.room.currentRendererSnapshot()).toBeNull();
  });

  it('quarantines a body leak and releases body/File references only after cleanup', async () => {
    const closeGate = deferred<void>();
    const media = file('leak.mp3');
    const setup = makeHarness({
      enginePlan: { candidates: [{ bodyLeak: true }], closeGate },
    });

    await expect(first(setup.room, Q1, media)).rejects.toThrow(/body/u);
    expect(setup.released).toHaveLength(0);
    closeGate.resolve();
    await setup.room.close().catch(() => undefined);
    await drainMicrotasks();

    expect(setup.fatal).toHaveBeenCalledOnce();
    expect(setup.released).toEqual([
      expect.objectContaining({
        activeTaskRetained: false,
        engineRetained: false,
        fileRetained: false,
      }),
    ]);
    expect(containsBody(setup.released[0])).toBe(false);
  });

  it('rejects a destination from another AudioContext before creating the stable engine', async () => {
    const wrongContext = new FakeAudioContext();
    const setup = makeHarness({ destination: destinationFor(wrongContext) });

    await expect(first(setup.room, Q1, file('wrong-context.mp3'))).rejects.toThrow(/destination/u);
    expect(setup.engines).toHaveLength(0);
  });

  it.each(['generation', 'role', 'clock'] as const)(
    'rejects stale %s authority without creating an engine',
    async (kind) => {
      const setup = makeHarness();
      if (kind === 'generation') {
        setup.controller.beginRoom(createStoppedPlaybackTimeline(2_000, 0));
        setup.controller.claimRoomRole('host');
      } else if (kind === 'role') {
        setup.controller.beginRoom(createStoppedPlaybackTimeline(2_000, 0));
        setup.controller.claimRoomRole('guest');
      } else {
        setup.roomClock.clear(setup.clockLease);
      }

      await expect(first(setup.room, Q3, file('stale.mp3'))).rejects.toBeTruthy();
      expect(setup.engines).toHaveLength(0);
    },
  );
});
