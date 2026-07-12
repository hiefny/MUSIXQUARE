import { describe, expect, it, vi } from 'vitest';

import { FilePlaybackConnectionChannel } from '../../network/file-playback-connection-channel.ts';
import {
  FilePlaybackGuestSessionHandshake,
  FilePlaybackHandshakeIdIssuer,
  FilePlaybackHostSessionHandshake,
} from '../../network/file-playback-session-handshake.ts';
import type { DataConnection, QueueItemId } from '../../types/index.ts';
import { FilePlaybackApplicationController } from '../file-playback-application-controller.ts';
import { FilePlaybackClock } from '../file-playback-clock.ts';
import {
  FilePlaybackHostFirstFileEngine,
  type FilePlaybackHostFirstFileEngineRuntimeForTests,
  type StartHostFirstLocalFileOptions,
  type StartHostLocalTrackOptions,
} from '../file-playback-host-first-file-engine.ts';
import { FilePlaybackManager } from '../file-playback-manager.ts';
import { FilePlaybackProductBaselineIdIssuer } from '../file-playback-product-baseline-session.ts';
import { FilePlaybackRoomClock } from '../file-playback-room-clock.ts';
import {
  createAudioBufferPlaybackStartEvidence,
  createFilePlaybackCutoverTarget,
  createFilePlaybackRejectedTransitionResult,
  createFilePlaybackScheduledTransitionResult,
  createFilePlaybackTransitionEvidence,
  createStreamingFlacPlaybackStartEvidence,
  type FilePlaybackBackend,
  type FilePlaybackCutoverArmResult,
  type FilePlaybackCutoverSource,
  type FilePlaybackSourcePhase,
  type FilePlaybackSourceSnapshot,
  type FilePlaybackStartEvidence,
  type FilePlaybackTransitionIntent,
  type FilePlaybackTransitionResult,
} from '../file-playback-source.ts';
import { stageFilePlaybackAssetSource } from '../file-playback-asset-source-stager.ts';
import type { BlobFilePlaybackSourceResult } from '../file-playback-source-factory.ts';
import { createPlaybackRunIdentity } from '../playback-identity.ts';
import {
  createStoppedPlaybackTimeline,
  type PlaybackTimelineSnapshot,
} from '../playback-timeline.ts';
import type {
  RendezvousArmIntent,
  RendezvousArmReceipt,
  RendezvousFinalizeIntent,
  RendezvousFinalizeReceipt,
} from '../rendezvous-contract.ts';

const Q1 = '96000000-0000-4000-8000-000000000001' as QueueItemId;
const Q2 = '96000000-0000-4000-8000-000000000002' as QueueItemId;
const RUN_1 = '96000000-0000-4000-8000-000000000101';
const RUN_2 = '96000000-0000-4000-8000-000000000102';
const RUN_3 = '96000000-0000-4000-8000-000000000103';
const APPLICATION_SCOPE = '96000000-0000-4000-8000-000000000201';
const ROOM_TOKEN = Object.freeze({ room: 'host-first-file-engine' });
let connectionSequence = 0;

function establishHostChannel(): {
  readonly connection: DataConnection;
  readonly channel: FilePlaybackConnectionChannel;
} {
  const suffix = ++connectionSequence;
  const hostIds = new FilePlaybackHandshakeIdIssuer({
    createSessionId: () => `first-engine-session-${suffix}`,
    createConnectionId: () => `first-engine-connection-${suffix}`,
    createHelloId: () => `first-engine-host-hello-${suffix}`,
  });
  const guestIds = new FilePlaybackHandshakeIdIssuer({
    createSessionId: () => `first-engine-guest-session-${suffix}`,
    createConnectionId: () => `first-engine-guest-connection-${suffix}`,
    createHelloId: () => `first-engine-guest-hello-${suffix}`,
  });
  const hostHandshake = new FilePlaybackHostSessionHandshake({
    idIssuer: hostIds,
    sessionId: hostIds.issueSessionId(),
    connectionId: hostIds.issueConnectionId(),
    hostParticipantId: 'first-engine-host',
    guestParticipantId: `first-engine-guest-${suffix}`,
  });
  const guestHandshake = new FilePlaybackGuestSessionHandshake({
    idIssuer: guestIds,
    guestParticipantId: `first-engine-guest-${suffix}`,
  });
  const hello = guestHandshake.createHello();
  if (!hello.accepted) throw new Error(hello.reason);
  const welcome = hostHandshake.handleHello(hello.hello);
  if (!welcome.accepted) throw new Error(welcome.reason);
  const welcomed = guestHandshake.handleWelcome(welcome.welcome);
  if (!welcomed.accepted) throw new Error(welcomed.reason);
  const snapshot = hostHandshake.createSnapshot();
  if (!snapshot.accepted) throw new Error(snapshot.reason);
  const accepted = guestHandshake.acceptSnapshot(snapshot.snapshot);
  if (!accepted.accepted) throw new Error(accepted.reason);
  const applied = guestHandshake.createApplied();
  if (!applied.accepted) throw new Error(applied.reason);
  const hostApplied = hostHandshake.handleApplied(applied.applied);
  if (!hostApplied.accepted) throw new Error(hostApplied.reason);
  const connection = {
    peer: `first-engine-peer-${suffix}`,
    open: true,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as DataConnection;
  return {
    connection,
    channel: new FilePlaybackConnectionChannel(hostHandshake, connection, { now: () => 1_000 }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function drainMicrotasks(turns = 64): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

class FakeAudioParam {
  cancelScheduledValues(): AudioParam {
    return this as unknown as AudioParam;
  }

  setValueAtTime(): AudioParam {
    return this as unknown as AudioParam;
  }
}

class FakeGainNode {
  readonly gain = new FakeAudioParam();

  constructor(readonly context: FakeAudioContext) {}

  connect(): AudioNode {
    return this as unknown as AudioNode;
  }

  disconnect(): void {}
}

class FakeAudioContext {
  readonly sampleRate = 48_000;
  readonly state: AudioContextState = 'running';
  currentTime = 0;

  createGain(): GainNode {
    return new FakeGainNode(this) as unknown as GainNode;
  }
}

function destinationFor(context: FakeAudioContext): AudioNode {
  return { context } as unknown as AudioNode;
}

function armedReceipt(intent: RendezvousArmIntent): RendezvousArmReceipt {
  return Object.freeze({
    protocolVersion: 2,
    kind: 'rendezvous-armed',
    queueItemId: intent.queueItemId,
    runId: intent.runId,
    revision: intent.revision,
    rendezvousId: intent.rendezvousId,
    participantId: intent.recipientId,
    status: 'armed',
    observedAtRoomTimeMs: Math.max(0, intent.finalizeByRoomTimeMs - 1),
    bufferedAheadSeconds: 8,
    reasonCode: null,
  });
}

function acceptedReceipt(intent: RendezvousFinalizeIntent): RendezvousFinalizeReceipt {
  return Object.freeze({
    protocolVersion: 2,
    kind: 'rendezvous-finalized',
    queueItemId: intent.queueItemId,
    runId: intent.runId,
    revision: intent.revision,
    rendezvousId: intent.rendezvousId,
    participantId: intent.recipientId,
    status: 'accepted',
    observedAtRoomTimeMs: intent.finalizedAtRoomTimeMs,
    reasonCode: null,
  });
}

interface FakeSourceOptions {
  readonly rejectArm?: boolean;
}

interface FakeSourceHarness {
  readonly source: FilePlaybackCutoverSource;
  readonly arm: ReturnType<typeof vi.fn>;
  readonly finalize: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly startAtContextTime: () => number | null;
  resolveStart(): void;
  rejectStart(error?: Error): void;
  resolvePause(): void;
  resolveSeek(): void;
  hasPendingPause(): boolean;
  hasPendingSeek(): boolean;
  markEnded(): void;
}

function makeSource(
  queueItemId: QueueItemId,
  backend: FilePlaybackBackend,
  context: FakeAudioContext,
  options: FakeSourceOptions = {},
): FakeSourceHarness {
  let phase: FilePlaybackSourcePhase = 'new';
  let revision = 0;
  let run: FilePlaybackSourceSnapshot['run'] = null;
  let targetTime: number | null = null;
  let targetFrame: number | null = null;
  let positionSeconds = 0;
  let pendingPause: Readonly<{
    intent: Extract<
      FilePlaybackTransitionIntent,
      { readonly kind: 'file-playback-pause-transition' }
    >;
    targetFrame: number;
    applied: ReturnType<typeof deferred<ReturnType<typeof createFilePlaybackTransitionEvidence>>>;
  }> | null = null;
  let pendingSeek: Readonly<{
    intent: Extract<
      FilePlaybackTransitionIntent,
      { readonly kind: 'file-playback-seek-transition' }
    >;
    targetFrame: number;
    applied: ReturnType<typeof deferred<ReturnType<typeof createFilePlaybackTransitionEvidence>>>;
  }> | null = null;
  const started = deferred<FilePlaybackStartEvidence>();
  const arm = vi.fn();
  const finalize = vi.fn();
  const destroy = vi.fn();
  void started.promise.catch(() => undefined);

  const snapshot = (): FilePlaybackSourceSnapshot => ({
    schemaVersion: 1,
    queueItemId,
    backend,
    phase,
    revision,
    run,
    durationSeconds: 180,
    positionSeconds,
    bufferedAheadSeconds: phase === 'new' || phase === 'preparing' ? 0 : 8,
    outputSampleRateHz: context.sampleRate,
    channelCount: 2,
    underrunCount: 0,
    errorCode: null,
  });
  const rejectedTransition = (intent: FilePlaybackTransitionIntent): FilePlaybackTransitionResult =>
    createFilePlaybackRejectedTransitionResult(intent, 'wrong-phase', snapshot());

  const source: FilePlaybackCutoverSource = {
    queueItemId,
    backend,
    async prepare() {
      phase = 'preparing';
      phase = 'ready';
      return snapshot();
    },
    async connect() {
      phase = 'connected';
      return snapshot();
    },
    async arm(intent) {
      return armedReceipt(intent);
    },
    async armForCutover(intent) {
      arm();
      if (options.rejectArm) throw new Error('fixture arm rejection');
      phase = 'armed';
      revision = intent.revision;
      run = Object.freeze({
        queueItemId: intent.queueItemId,
        runId: intent.runId,
        revision: intent.revision,
      });
      targetTime = intent.startAtRoomTimeMs / 1_000;
      targetFrame = Math.round(targetTime * context.sampleRate);
      positionSeconds = intent.positionSeconds;
      return Object.freeze({
        status: 'armed' as const,
        receipt: armedReceipt(intent),
        target: createFilePlaybackCutoverTarget(
          context as unknown as AudioContext,
          targetTime,
          targetFrame,
        ),
        started: started.promise,
      });
    },
    async finalize(intent) {
      finalize();
      return acceptedReceipt(intent);
    },
    async cancel() {
      phase = 'cancelled';
      return snapshot();
    },
    async pause() {
      return snapshot();
    },
    async seek() {
      return snapshot();
    },
    async pauseRevisioned(intent) {
      if (phase !== 'playing') return rejectedTransition(intent);
      const pauseTargetTime = intent.atRoomTimeMs / 1_000;
      const pauseTargetFrame = Math.round(pauseTargetTime * context.sampleRate);
      const applied = deferred<ReturnType<typeof createFilePlaybackTransitionEvidence>>();
      pendingPause = Object.freeze({ intent, targetFrame: pauseTargetFrame, applied });
      return createFilePlaybackScheduledTransitionResult(
        intent,
        createFilePlaybackCutoverTarget(
          context as unknown as AudioContext,
          pauseTargetTime,
          pauseTargetFrame,
        ),
        snapshot(),
        applied.promise,
      );
    },
    async seekRevisioned(intent) {
      if (phase !== 'paused') return rejectedTransition(intent);
      const seekTargetTime = intent.atRoomTimeMs / 1_000;
      const seekTargetFrame = Math.round(seekTargetTime * context.sampleRate);
      const applied = deferred<ReturnType<typeof createFilePlaybackTransitionEvidence>>();
      pendingSeek = Object.freeze({ intent, targetFrame: seekTargetFrame, applied });
      return createFilePlaybackScheduledTransitionResult(
        intent,
        createFilePlaybackCutoverTarget(
          context as unknown as AudioContext,
          seekTargetTime,
          seekTargetFrame,
        ),
        snapshot(),
        applied.promise,
      );
    },
    positionAt() {
      return {
        queueItemId,
        run,
        phase,
        positionSeconds,
        bufferedAheadSeconds: 8,
        underrunCount: 0,
      };
    },
    getSnapshot: snapshot,
    async destroy() {
      destroy();
      phase = 'destroyed';
    },
  };

  return {
    source,
    arm,
    finalize,
    destroy,
    startAtContextTime: () => targetTime,
    resolveStart() {
      if (targetFrame === null) throw new Error('No start target is armed');
      phase = 'playing';
      if (backend === 'audio-buffer') {
        started.resolve(createAudioBufferPlaybackStartEvidence(targetFrame));
      } else {
        started.resolve(createStreamingFlacPlaybackStartEvidence(targetFrame, targetFrame));
      }
    },
    rejectStart(error = new Error('fixture local renderer start failed')) {
      started.reject(error);
    },
    resolvePause() {
      if (!pendingPause) throw new Error('No pause transition is scheduled');
      const currentPause = pendingPause;
      pendingPause = null;
      phase = 'paused';
      revision = currentPause.intent.to.revision;
      run = Object.freeze({ ...currentPause.intent.to });
      currentPause.applied.resolve(
        createFilePlaybackTransitionEvidence(
          currentPause.intent,
          backend === 'audio-buffer' ? 'webaudio-schedule-passed' : 'worklet-observed',
          currentPause.targetFrame,
          currentPause.targetFrame,
        ),
      );
    },
    resolveSeek() {
      if (!pendingSeek) throw new Error('No seek transition is scheduled');
      const currentSeek = pendingSeek;
      pendingSeek = null;
      phase = 'paused';
      revision = currentSeek.intent.to.revision;
      run = Object.freeze({ ...currentSeek.intent.to });
      positionSeconds = currentSeek.intent.positionSeconds;
      currentSeek.applied.resolve(
        createFilePlaybackTransitionEvidence(
          currentSeek.intent,
          backend === 'audio-buffer' ? 'webaudio-schedule-passed' : 'worklet-observed',
          currentSeek.targetFrame,
          currentSeek.targetFrame,
        ),
      );
    },
    hasPendingPause: () => pendingPause !== null,
    hasPendingSeek: () => pendingSeek !== null,
    markEnded() {
      if (phase !== 'playing') throw new Error('Only a playing fixture can end');
      phase = 'ended';
      positionSeconds = 180;
    },
  };
}

function fakeAudioBuffer(): AudioBuffer {
  return {
    duration: 180,
    sampleRate: 48_000,
    numberOfChannels: 2,
    length: 8_640_000,
  } as AudioBuffer;
}

function factoryResult(
  harness: FakeSourceHarness,
  sourceIdentity: string,
): BlobFilePlaybackSourceResult {
  if (harness.source.backend === 'audio-buffer') {
    return Object.freeze({
      backend: 'audio-buffer',
      source: harness.source as never,
      sourceIdentity,
      audioBuffer: fakeAudioBuffer(),
      releaseConstructionLease: vi.fn(),
      flacMetadata: null,
    });
  }
  return Object.freeze({
    backend: 'streaming-flac',
    source: harness.source as never,
    sourceIdentity,
    releaseConstructionLease: vi.fn(),
    flacMetadata: Object.freeze({ fixture: true }) as never,
  });
}

interface StagePlan {
  readonly backend: FilePlaybackBackend;
  readonly rejectArm?: boolean;
  readonly neverStage?: boolean;
  readonly holdAfterStage?: ReturnType<typeof deferred<void>>;
}

interface EngineHarness {
  readonly controller: FilePlaybackApplicationController;
  readonly manager: FilePlaybackManager;
  readonly context: FakeAudioContext;
  readonly destination: AudioNode;
  readonly roomClock: FilePlaybackRoomClock;
  readonly engine: FilePlaybackHostFirstFileEngine;
  readonly sources: FakeSourceHarness[];
  readonly createRunId: ReturnType<typeof vi.fn>;
  readonly sendRequired: ReturnType<typeof vi.fn>;
  readonly closeConnection: ReturnType<typeof vi.fn>;
  readonly fatal: ReturnType<typeof vi.fn>;
  setRoomTime(roomTimeMs: number): void;
  start(
    blob: Blob,
    overrides?: Partial<StartHostFirstLocalFileOptions>,
  ): Promise<
    ReturnType<FilePlaybackHostFirstFileEngine['startFirstLocalFile']> extends Promise<infer T>
      ? T
      : never
  >;
}

let baselineSequence = 0;

function makeHarness(
  plans: StagePlan[],
  options: {
    readonly beforeControllerCommit?: () => void;
    readonly beforeManagerTransition?: () => void;
    readonly beforeTransitionControllerCommit?: () => void;
    readonly fatal?: (error: Error) => void;
    readonly roomTimeMs?: number;
    readonly fatalAfterAdmission?: boolean;
    readonly onTerminalReferencesReleased?: (
      snapshot: Readonly<{
        readonly assetReferenceCount: 0;
        readonly audioContextRetained: false;
        readonly destinationRetained: false;
        readonly clockBindingsRetained: false;
      }>,
    ) => void;
    readonly managerFactory?: (defaultManager: FilePlaybackManager) => FilePlaybackManager;
    readonly controller?: FilePlaybackApplicationController;
    readonly roomClock?: FilePlaybackRoomClock;
    readonly context?: FakeAudioContext;
    readonly destination?: AudioNode;
    readonly activateRoomClock?: boolean;
    readonly controllerRole?: 'host' | 'guest' | null;
    readonly initialTimeline?: PlaybackTimelineSnapshot;
    readonly onCoordinatorClosed?: () => void;
    readonly establishActiveGuest?: boolean;
  } = {},
): EngineHarness {
  const sendRequired = vi.fn(() => true);
  const closeConnection = vi.fn();
  const controller =
    options.controller ??
    new FilePlaybackApplicationController({
      initialTimeline: options.initialTimeline ?? createStoppedPlaybackTimeline(1_000, 0),
      idIssuer: new FilePlaybackProductBaselineIdIssuer({
        createBaselineId: () => `host-first-file-baseline-${++baselineSequence}`,
      }),
      sendRequired,
      closeConnection,
    });
  if (controller.snapshot().roomRole === null && options.controllerRole !== null) {
    controller.claimRoomRole(options.controllerRole ?? 'host');
  }
  if (options.establishActiveGuest) {
    const active = establishHostChannel();
    controller.applicationSessionHooks().onLifecycleEvent(
      Object.freeze({
        kind: 'established',
        role: 'host',
        connection: active.connection,
        channel: active.channel,
      }),
    );
  }
  const manager = new FilePlaybackManager();
  const context = options.context ?? new FakeAudioContext();
  const destination = options.destination ?? destinationFor(context);
  const roomTime = { value: options.roomTimeMs ?? 1_000 };
  const roomClock =
    options.roomClock ??
    new FilePlaybackRoomClock({
      createHostClock: () => new FilePlaybackClock({ now: () => roomTime.value }),
    });
  if (!options.roomClock && options.activateRoomClock !== false) roomClock.beginHostSession();
  let rendezvousSequence = 0;
  const sources: FakeSourceHarness[] = [];
  const pendingPlans = [...plans];
  const stageAssetSourceForTests: NonNullable<
    FilePlaybackHostFirstFileEngineRuntimeForTests['localStartRuntimeForTests']
  >['stageAssetSourceForTests'] = async (stageOptions) => {
    const plan = pendingPlans.shift();
    if (!plan) throw new Error('No source stage plan remains');
    if (plan.neverStage) return new Promise(() => undefined);
    const source = makeSource(stageOptions.expectedBinding.queueItemId, plan.backend, context, {
      rejectArm: plan.rejectArm,
    });
    sources.push(source);
    const staged = await stageFilePlaybackAssetSource({
      ...stageOptions,
      runtime: {
        createBlobSource: vi.fn(async () =>
          factoryResult(source, stageOptions.expectedBinding.sourceIdentity),
        ),
      },
    });
    if (plan.holdAfterStage) await plan.holdAfterStage.promise;
    return staged;
  };
  const runIds = [RUN_1, RUN_2, RUN_3] as const;
  let runSequence = 0;
  const createRunId = vi.fn(() => runIds[Math.min(runSequence++, runIds.length - 1)]);
  const fatal = vi.fn(options.fatal ?? (() => undefined));
  const runtimeForTests: FilePlaybackHostFirstFileEngineRuntimeForTests = {
    createRunIdForTests: createRunId,
    createRendezvousIdForTests: () => `host-first-rendezvous-${++rendezvousSequence}`,
    createManagerForTests: () => options.managerFactory?.(manager) ?? manager,
    localStartRuntimeForTests: { stageAssetSourceForTests },
    ...(options.beforeControllerCommit
      ? { beforeControllerCommitForTests: options.beforeControllerCommit }
      : {}),
    ...(options.beforeManagerTransition
      ? { beforeManagerTransitionForTests: options.beforeManagerTransition }
      : {}),
    ...(options.beforeTransitionControllerCommit
      ? {
          beforeTransitionControllerCommitForTests: options.beforeTransitionControllerCommit,
        }
      : {}),
    ...(options.fatalAfterAdmission ? { fatalAfterAdmissionForTests: true } : {}),
    ...(options.onCoordinatorClosed
      ? { onCoordinatorClosedForTests: options.onCoordinatorClosed }
      : {}),
    ...(options.onTerminalReferencesReleased
      ? {
          onTerminalReferencesReleasedForTests: options.onTerminalReferencesReleased,
        }
      : {}),
  };
  const roomGeneration = controller.snapshot().roomGeneration;
  const engine = new FilePlaybackHostFirstFileEngine({
    controller,
    roomGeneration,
    applicationScopeId: APPLICATION_SCOPE,
    roomToken: ROOM_TOKEN,
    roomClock,
    hostParticipantId: 'host-first-participant',
    onFatalRoom: fatal,
    runtimeForTests,
  });
  return {
    controller,
    manager,
    context,
    destination,
    roomClock,
    engine,
    sources,
    createRunId,
    sendRequired,
    closeConnection,
    fatal,
    setRoomTime(roomTimeMs) {
      roomTime.value = roomTimeMs;
    },
    start(blob, overrides = {}) {
      return engine.startFirstLocalFile({
        queueItemId: Q1,
        blob,
        name: 'first.flac',
        mime: blob.type,
        audioContext: context as unknown as AudioContext,
        destination,
        decodeOrdinaryAudio: vi.fn(async () => ({
          audioBuffer: fakeAudioBuffer(),
          release: vi.fn(),
        })),
        signal: new AbortController().signal,
        ...overrides,
      });
    },
  };
}

async function resolveLatestStart<T>(harness: EngineHarness, pending: Promise<T>): Promise<T> {
  await drainMicrotasks();
  const source = harness.sources.at(-1);
  if (!source) throw new Error('No staged source exists');
  expect(source.arm).toHaveBeenCalledTimes(1);
  expect(source.finalize).toHaveBeenCalledTimes(1);
  const target = source.startAtContextTime();
  expect(target).not.toBeNull();
  harness.context.currentTime = target!;
  source.resolveStart();
  return pending;
}

function localTrackOptions(
  harness: EngineHarness,
  queueItemId: QueueItemId,
  blob: Blob,
  positionSeconds: number,
): StartHostLocalTrackOptions {
  return {
    queueItemId,
    blob,
    name: queueItemId === Q1 ? 'first.flac' : 'replacement.flac',
    mime: blob.type,
    audioContext: harness.context as unknown as AudioContext,
    destination: harness.destination,
    decodeOrdinaryAudio: vi.fn(async () => ({
      audioBuffer: fakeAudioBuffer(),
      release: vi.fn(),
    })),
    signal: new AbortController().signal,
    positionSeconds,
  };
}

async function pauseCurrent(harness: EngineHarness): Promise<PlaybackTimelineSnapshot> {
  const previous = harness.controller.timelineSnapshot();
  if (previous.phase !== 'playing' || !previous.run) {
    throw new Error('Fixture requires playing timeline truth');
  }
  const port = harness.manager.currentCutoverPort();
  const source = [...harness.sources]
    .reverse()
    .find((candidate) => candidate.source.getSnapshot().phase === 'playing');
  if (!port || !source) throw new Error('Fixture current renderer is unavailable');
  const atRoomTimeMs = Math.max(
    previous.anchorMonotonicMs + 500,
    (harness.context.currentTime + 0.5) * 1_000,
  );
  const intent = Object.freeze({
    kind: 'file-playback-pause-transition' as const,
    from: Object.freeze({
      queueItemId: previous.run.queueItemId,
      runId: previous.run.runId,
      revision: previous.revision,
    }),
    to: Object.freeze({
      queueItemId: previous.run.queueItemId,
      runId: previous.run.runId,
      revision: previous.revision + 1,
    }),
    atRoomTimeMs,
  });
  const scheduled = await harness.manager.pauseCurrentCutover(port, intent);
  if (scheduled.status !== 'scheduled') throw new Error('Fixture pause was rejected');
  harness.context.currentTime = scheduled.target.contextTimeSeconds;
  source.resolvePause();
  const evidence = await scheduled.applied;
  const committed = harness.controller.commitHostPlaybackTransition({
    kind: 'pause',
    roomGeneration: harness.controller.snapshot().roomGeneration,
    expectedPrevious: previous,
    intent,
    evidence,
  });
  return committed.timeline;
}

function expectBodyFree(value: unknown): void {
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    expect(candidate).not.toBeInstanceOf(Blob);
    if (candidate === null || typeof candidate !== 'object' || seen.has(candidate)) return;
    seen.add(candidate);
    for (const nested of Object.values(candidate)) visit(nested);
  };
  visit(value);
}

describe('FilePlaybackHostFirstFileEngine', () => {
  it('keeps production manager ownership private and rejects an inexact test factory', () => {
    class InexactManager extends FilePlaybackManager {}
    expect(() =>
      makeHarness([], {
        managerFactory: () => new InexactManager(),
      }),
    ).toThrow(/inexact manager/u);
  });

  it('rejects a subclassed room clock even when it has an active host session', () => {
    class InexactRoomClock extends FilePlaybackRoomClock {}
    const roomClock = new InexactRoomClock();
    roomClock.beginHostSession();
    expect(() => makeHarness([], { roomClock })).toThrow(/exact room clock/u);
  });

  it('rejects non-host and non-stopped controller authority', async () => {
    expect(() => makeHarness([], { controllerRole: 'guest' })).toThrow(/stopped host/u);
    expect(() => makeHarness([], { controllerRole: null })).toThrow(/stopped host/u);
    const connectedHost = makeHarness([{ backend: 'audio-buffer' }], {
      establishActiveGuest: true,
    });
    expect(connectedHost.controller.snapshot()).toMatchObject({
      roomRole: 'host',
      activeConnectionCount: 1,
    });
    const connectedCommit = await resolveLatestStart(
      connectedHost,
      connectedHost.start(new Blob([new Uint8Array([48])], { type: 'audio/mpeg' }), {
        name: 'connected-host.mp3',
      }),
    );
    expect(connectedCommit.timeline).toMatchObject({ revision: 1, phase: 'playing' });
    await connectedHost.engine.close();
    const playingTimeline: PlaybackTimelineSnapshot = Object.freeze({
      schemaVersion: 1,
      revision: 1,
      phase: 'playing',
      run: createPlaybackRunIdentity({ queueItemId: Q1, runId: RUN_1 }),
      positionSeconds: 0,
      anchorMonotonicMs: 1_000,
      rate: 1,
    });
    expect(() => makeHarness([], { initialTimeline: playingTimeline })).toThrow(/stopped host/u);
  });

  it.each([
    ['ordinary AudioBuffer', 'audio-buffer', 'audio/mpeg'],
    ['bounded FLAC', 'streaming-flac', 'audio/flac'],
  ] as const)('atomically composes the %s first-file path', async (_label, backend, mime) => {
    const harness = makeHarness([{ backend }]);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: mime });
    const pending = harness.start(blob, { name: backend === 'audio-buffer' ? 'a.mp3' : 'a.flac' });

    await drainMicrotasks();
    expect(harness.controller.timelineSnapshot()).toMatchObject({
      revision: 1,
      phase: 'playing',
      run: { queueItemId: Q1, runId: RUN_1 },
    });
    expect(harness.manager.currentCutoverPort()).toBeNull();

    const result = await resolveLatestStart(harness, pending);
    expect(result.backend).toBe(backend);
    expect(result.asset.kind).toBe('blob');
    expect(result.attempt).toMatchObject({ queueItemId: Q1, runId: RUN_1, revision: 1 });
    expect(result.timeline).toBe(harness.controller.timelineSnapshot());
    expect(result.timeline.revision).toBe(1);
    expect(result.timeline.phase).toBe('playing');
    expect(result.timeline.anchorMonotonicMs).toBe(result.schedule.startAtRoomTimeMs);
    expect(result.timeline.run).toEqual({ queueItemId: Q1, runId: RUN_1 });
    expect(Object.isFrozen(result)).toBe(true);
    expectBodyFree(result);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(harness.sendRequired).not.toHaveBeenCalled();
    expect(harness.closeConnection).not.toHaveBeenCalled();
    const renderer = harness.engine.currentRendererSnapshot();
    expect(renderer).toMatchObject({
      backend,
      phase: 'playing',
      durationSeconds: 180,
      positionSeconds: 0,
    });
    const position = harness.engine.positionAt(1_500);
    expect(position).toMatchObject({
      queueItemId: Q1,
      phase: 'playing',
      positionSeconds: 0,
    });
    expectBodyFree(renderer);
    expectBodyFree(position);
    expect(Object.isFrozen(renderer)).toBe(true);
    expect(Object.isFrozen(position)).toBe(true);
    expect(harness.engine.positionAt(Number.NaN)).toBeNull();
    expect(harness.engine.positionAt(-1)).toBeNull();
    await harness.engine.close();
    expect(harness.manager.currentCutoverPort()).toBeNull();
    expect(harness.sources[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(harness.engine.currentRendererSnapshot()).toBeNull();
    expect(harness.engine.positionAt(1_500)).toBeNull();
  });

  it('keeps canonical accepted timeline truth when only the local renderer later fails', async () => {
    const harness = makeHarness([{ backend: 'streaming-flac' }]);
    const pending = harness.start(new Blob([new Uint8Array([49])], { type: 'audio/flac' }), {
      name: 'local-renderer-failure.flac',
    });
    await drainMicrotasks();

    expect(harness.sources[0]?.finalize).toHaveBeenCalledTimes(1);
    const committedTimeline = harness.controller.timelineSnapshot();
    expect(committedTimeline).toMatchObject({
      revision: 1,
      phase: 'playing',
      run: { queueItemId: Q1, runId: RUN_1 },
    });
    harness.sources[0]?.rejectStart();

    await expect(pending).rejects.toThrow('fixture local renderer start failed');
    await drainMicrotasks();
    expect(harness.controller.timelineSnapshot()).toBe(committedTimeline);
    expect(harness.manager.currentCutoverPort()).toBeNull();
    expect(harness.engine.currentRendererSnapshot()).toBeNull();
    expect(harness.sources[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(harness.fatal).not.toHaveBeenCalled();
    await expect(
      harness.engine.pauseCurrent({ signal: new AbortController().signal }),
    ).rejects.toThrow(/renderer|current/u);
    await expect(
      harness.engine.seekPlaying({
        positionSeconds: 12,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/renderer|current/u);
    await expect(
      harness.engine.stopCurrent({ signal: new AbortController().signal }),
    ).rejects.toThrow(/renderer|current/u);
    expect(harness.controller.timelineSnapshot()).toBe(committedTimeline);
    await harness.engine.close();
    expect(harness.sources[0]?.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['AudioBuffer to FLAC', 'audio-buffer', 'streaming-flac'],
    ['FLAC to AudioBuffer', 'streaming-flac', 'audio-buffer'],
  ] as const)(
    'replaces %s on the same room manager with a new run and exact next revision',
    async (_label, firstBackend, replacementBackend) => {
      const harness = makeHarness([{ backend: firstBackend }, { backend: replacementBackend }]);
      const firstBlob = new Blob([new Uint8Array([51])], {
        type: firstBackend === 'audio-buffer' ? 'audio/mpeg' : 'audio/flac',
      });
      await resolveLatestStart(harness, harness.start(firstBlob, { name: 'first-track' }));
      const previousPort = harness.manager.currentCutoverPort();
      harness.setRoomTime(2_000);

      const replacementBlob = new Blob([new Uint8Array([52])], {
        type: replacementBackend === 'audio-buffer' ? 'audio/mpeg' : 'audio/flac',
      });
      const pending = harness.engine.startLocalTrack(
        localTrackOptions(harness, Q2, replacementBlob, 12),
      );
      await drainMicrotasks();
      expect(harness.controller.timelineSnapshot()).toMatchObject({
        revision: 2,
        phase: 'playing',
        run: { queueItemId: Q2, runId: RUN_2 },
        positionSeconds: 12,
      });
      expect(harness.manager.currentCutoverPort()).toBe(previousPort);
      expect(harness.sources[0]?.destroy).not.toHaveBeenCalled();

      const committed = await resolveLatestStart(harness, pending);
      expect(committed).toMatchObject({
        backend: replacementBackend,
        attempt: { queueItemId: Q2, runId: RUN_2, revision: 2 },
        schedule: { positionSeconds: 12, playbackRate: 1 },
        timeline: { phase: 'playing', revision: 2, positionSeconds: 12 },
      });
      expect(committed.timeline.run).toEqual({ queueItemId: Q2, runId: RUN_2 });
      expect(harness.manager.currentCutoverPort()).not.toBe(previousPort);
      expect(harness.sources[0]?.destroy).toHaveBeenCalledTimes(1);
      expect(harness.createRunId).toHaveBeenCalledTimes(2);
      expectBodyFree(committed);
      expect(harness.engine.currentRendererSnapshot()).toMatchObject({
        queueItemId: Q2,
        backend: replacementBackend,
        positionSeconds: 12,
      });
      await harness.engine.close();
    },
  );

  it.each(['audio-buffer', 'streaming-flac'] as const)(
    'preserves the audible %s current renderer when a replacement candidate fails',
    async (backend) => {
      const harness = makeHarness([{ backend }, { backend, rejectArm: true }]);
      const firstBlob = new Blob([new Uint8Array([53])], {
        type: backend === 'audio-buffer' ? 'audio/mpeg' : 'audio/flac',
      });
      await resolveLatestStart(harness, harness.start(firstBlob, { name: 'stable-current' }));
      const previousTimeline = harness.controller.timelineSnapshot();
      const previousPort = harness.manager.currentCutoverPort();
      harness.setRoomTime(2_000);

      const failedBlob = new Blob([new Uint8Array([54])], { type: firstBlob.type });
      await expect(
        harness.engine.startLocalTrack(localTrackOptions(harness, Q2, failedBlob, 0)),
      ).rejects.toThrow(/arm|retired/u);
      await drainMicrotasks();

      expect(harness.controller.timelineSnapshot()).toBe(previousTimeline);
      expect(harness.manager.currentCutoverPort()).toBe(previousPort);
      expect(harness.engine.currentRendererSnapshot()).toMatchObject({
        queueItemId: Q1,
        backend,
        phase: 'playing',
      });
      expect(harness.sources[0]?.destroy).not.toHaveBeenCalled();
      expect(harness.sources[1]?.destroy).toHaveBeenCalledTimes(1);
      await harness.engine.close();
      expect(harness.sources[0]?.destroy).toHaveBeenCalledTimes(1);
    },
  );

  it('does not reuse a failed replacement run after timeline truth advances', async () => {
    const harness = makeHarness([
      { backend: 'audio-buffer' },
      { backend: 'audio-buffer', rejectArm: true },
      { backend: 'audio-buffer' },
    ]);
    const firstBlob = new Blob([new Uint8Array([59])], { type: 'audio/mpeg' });
    const replacementBlob = new Blob([new Uint8Array([60])], { type: 'audio/mpeg' });
    await resolveLatestStart(harness, harness.start(firstBlob, { name: 'run-fence-current' }));
    harness.setRoomTime(2_000);
    await expect(
      harness.engine.startLocalTrack(localTrackOptions(harness, Q2, replacementBlob, 0)),
    ).rejects.toThrow(/arm|retired/u);
    expect(harness.createRunId).toHaveBeenCalledTimes(2);

    const paused = await pauseCurrent(harness);
    expect(paused).toMatchObject({ phase: 'paused', revision: 2 });

    harness.setRoomTime(3_500);
    const committed = await resolveLatestStart(
      harness,
      harness.engine.startLocalTrack(localTrackOptions(harness, Q2, replacementBlob, 0)),
    );
    expect(committed.attempt).toMatchObject({ runId: RUN_3, revision: 3 });
    expect(committed.attempt.runId).not.toBe(RUN_2);
    expect(harness.createRunId).toHaveBeenCalledTimes(3);
    await harness.engine.close();
  });

  it.each(['audio-buffer', 'streaming-flac'] as const)(
    'seeks a playing %s renderer through a same-run rendezvous candidate',
    async (backend) => {
      const harness = makeHarness([{ backend }, { backend }]);
      const blob = new Blob([new Uint8Array([55])], {
        type: backend === 'audio-buffer' ? 'audio/mpeg' : 'audio/flac',
      });
      const first = await resolveLatestStart(
        harness,
        harness.start(blob, { name: 'seek-current' }),
      );
      const previousPort = harness.manager.currentCutoverPort();
      harness.setRoomTime(2_000);

      const pending = harness.engine.seekPlaying({
        positionSeconds: 42,
        signal: new AbortController().signal,
      });
      const committed = await resolveLatestStart(harness, pending);

      expect(committed.attempt).toMatchObject({
        queueItemId: Q1,
        runId: first.attempt.runId,
        revision: 2,
      });
      expect(committed.schedule.positionSeconds).toBe(42);
      expect(committed.timeline).toMatchObject({
        phase: 'playing',
        revision: 2,
        positionSeconds: 42,
      });
      expect(committed.timeline.run).toEqual(first.timeline.run);
      expect(harness.createRunId).toHaveBeenCalledTimes(1);
      expect(harness.manager.currentCutoverPort()).not.toBe(previousPort);
      expect(harness.sources[0]?.destroy).toHaveBeenCalledTimes(1);
      expect(harness.engine.currentRendererSnapshot()?.positionSeconds).toBe(42);
      await harness.engine.close();
    },
  );

  it.each(['audio-buffer', 'streaming-flac'] as const)(
    'resumes a paused %s renderer with the same run at its canonical paused position',
    async (backend) => {
      const harness = makeHarness([{ backend }, { backend }]);
      const blob = new Blob([new Uint8Array([56])], {
        type: backend === 'audio-buffer' ? 'audio/mpeg' : 'audio/flac',
      });
      const first = await resolveLatestStart(
        harness,
        harness.start(blob, { name: 'resume-current' }),
      );
      const paused = await pauseCurrent(harness);
      expect(paused).toMatchObject({ phase: 'paused', revision: 2 });
      const pausedPort = harness.manager.currentCutoverPort();
      harness.setRoomTime(paused.anchorMonotonicMs + 500);

      const pending = harness.engine.resumeCurrent({ signal: new AbortController().signal });
      const committed = await resolveLatestStart(harness, pending);

      expect(committed.attempt).toMatchObject({
        queueItemId: Q1,
        runId: first.attempt.runId,
        revision: 3,
      });
      expect(committed.schedule.positionSeconds).toBe(paused.positionSeconds);
      expect(committed.timeline).toMatchObject({
        phase: 'playing',
        revision: 3,
        positionSeconds: paused.positionSeconds,
      });
      expect(committed.timeline.run).toEqual(first.timeline.run);
      expect(harness.createRunId).toHaveBeenCalledTimes(1);
      expect(harness.manager.currentCutoverPort()).not.toBe(pausedPort);
      expect(harness.sources[0]?.destroy).toHaveBeenCalledTimes(1);
      await harness.engine.close();
    },
  );

  it.each(['audio-buffer', 'streaming-flac'] as const)(
    'replays an ended %s renderer as a fresh run without rebuilding room authority',
    async (backend) => {
      const harness = makeHarness([{ backend }, { backend }]);
      const blob = new Blob([new Uint8Array([57])], {
        type: backend === 'audio-buffer' ? 'audio/mpeg' : 'audio/flac',
      });
      const first = await resolveLatestStart(
        harness,
        harness.start(blob, { name: 'replay-current' }),
      );
      harness.sources[0]?.markEnded();
      expect(harness.engine.currentRendererSnapshot()?.phase).toBe('ended');
      harness.setRoomTime(2_000);

      const committed = await resolveLatestStart(
        harness,
        harness.engine.replayCurrent({ signal: new AbortController().signal }),
      );

      expect(committed.attempt).toMatchObject({
        queueItemId: Q1,
        runId: RUN_2,
        revision: 2,
      });
      expect(committed.attempt.runId).not.toBe(first.attempt.runId);
      expect(committed.schedule.positionSeconds).toBe(0);
      expect(committed.timeline).toMatchObject({
        phase: 'playing',
        revision: 2,
        positionSeconds: 0,
      });
      expect(harness.createRunId).toHaveBeenCalledTimes(2);
      expect(harness.sources[0]?.destroy).toHaveBeenCalledTimes(1);
      await harness.engine.close();
    },
  );

  it('lets an accepted-rendezvous commit dominate a reentrant successor intent', async () => {
    let harness!: EngineHarness;
    let reentrant: ReturnType<FilePlaybackHostFirstFileEngine['replayCurrent']> | null = null;
    harness = makeHarness([{ backend: 'audio-buffer' }], {
      beforeControllerCommit: () => {
        reentrant = harness.engine.replayCurrent({ signal: new AbortController().signal });
      },
    });
    const committed = await resolveLatestStart(
      harness,
      harness.start(new Blob([new Uint8Array([58])], { type: 'audio/mpeg' }), {
        name: 'commit-dominant',
      }),
    );

    expect(committed.timeline).toMatchObject({ phase: 'playing', revision: 1 });
    await expect(reentrant).rejects.toThrow(/cannot supersede|physical commit/u);
    expect(harness.sources).toHaveLength(1);
    await harness.engine.close();
  });

  it.each(['audio-buffer', 'streaming-flac'] as const)(
    'pauses and resumes a %s renderer through exact manager evidence',
    async (backend) => {
      const harness = makeHarness([{ backend }, { backend }]);
      const blob = new Blob([new Uint8Array([61])], {
        type: backend === 'audio-buffer' ? 'audio/mpeg' : 'audio/flac',
      });
      const first = await resolveLatestStart(
        harness,
        harness.start(blob, { name: 'engine-pause-resume' }),
      );
      const currentPort = harness.manager.currentCutoverPort();
      const previous = harness.controller.timelineSnapshot();
      harness.setRoomTime(2_000);
      const signal = new AbortController().signal;
      const pending = harness.engine.pauseCurrent({ signal });
      const retry = harness.engine.pauseCurrent({ signal });
      expect(retry).toBe(pending);
      await expect(
        harness.engine.stopCurrent({ signal: new AbortController().signal }),
      ).rejects.toThrow(/conflicts/u);
      await expect(
        harness.engine.replayCurrent({ signal: new AbortController().signal }),
      ).rejects.toThrow(/conflicts/u);
      await drainMicrotasks();
      expect(harness.sources[0]?.hasPendingPause()).toBe(true);
      expect(harness.controller.timelineSnapshot()).toBe(previous);
      expect(harness.manager.currentCutoverPort()).toBe(currentPort);
      expect(harness.manager.currentCutoverSnapshot(currentPort!)).toMatchObject({
        phase: 'playing',
        revision: 1,
      });

      harness.sources[0]?.resolvePause();
      const paused = await pending;
      expect(paused).toMatchObject({
        kind: 'pause',
        evidence: { kind: 'pause-applied', to: { revision: 2 } },
        timeline: { phase: 'paused', revision: 2 },
      });
      expect(paused.timeline.run).toEqual(first.timeline.run);
      expect(harness.manager.currentCutoverPort()).toBe(currentPort);
      expect(harness.manager.currentCutoverSnapshot(currentPort!)).toMatchObject({
        phase: 'paused',
        revision: 2,
      });
      expectBodyFree(paused);

      harness.setRoomTime(3_000);
      const resumed = await resolveLatestStart(
        harness,
        harness.engine.resumeCurrent({ signal: new AbortController().signal }),
      );
      expect(resumed).toMatchObject({
        attempt: { runId: first.attempt.runId, revision: 3 },
        schedule: { positionSeconds: paused.timeline.positionSeconds },
        timeline: { phase: 'playing', revision: 3 },
      });
      expect(harness.createRunId).toHaveBeenCalledTimes(1);
      await harness.engine.close();
    },
  );

  it.each(['audio-buffer', 'streaming-flac'] as const)(
    'seeks a paused %s renderer only after native evidence',
    async (backend) => {
      const harness = makeHarness([{ backend }]);
      const blob = new Blob([new Uint8Array([62])], {
        type: backend === 'audio-buffer' ? 'audio/mpeg' : 'audio/flac',
      });
      await resolveLatestStart(harness, harness.start(blob, { name: 'engine-paused-seek' }));
      harness.setRoomTime(2_000);
      const pausing = harness.engine.pauseCurrent({ signal: new AbortController().signal });
      await drainMicrotasks();
      harness.sources[0]?.resolvePause();
      await pausing;

      harness.setRoomTime(3_000);
      const previous = harness.controller.timelineSnapshot();
      const port = harness.manager.currentCutoverPort();
      const pending = harness.engine.seekPaused({
        positionSeconds: 33,
        signal: new AbortController().signal,
      });
      await drainMicrotasks();
      expect(harness.sources[0]?.hasPendingSeek()).toBe(true);
      expect(harness.controller.timelineSnapshot()).toBe(previous);
      expect(harness.manager.currentCutoverSnapshot(port!)).toMatchObject({
        phase: 'paused',
        revision: 2,
      });

      harness.sources[0]?.resolveSeek();
      const committed = await pending;
      expect(committed).toMatchObject({
        kind: 'seek',
        evidence: { kind: 'seek-applied', positionSeconds: 33, to: { revision: 3 } },
        timeline: { phase: 'paused', revision: 3, positionSeconds: 33 },
      });
      expect(harness.manager.currentCutoverPort()).toBe(port);
      expect(harness.manager.currentCutoverSnapshot(port!)).toMatchObject({
        phase: 'paused',
        revision: 3,
        positionSeconds: 33,
      });
      expectBodyFree(committed);
      await harness.engine.close();
    },
  );

  it('honors abort before a manager transition is scheduled', async () => {
    const abort = new AbortController();
    const harness = makeHarness([{ backend: 'audio-buffer' }], {
      beforeManagerTransition: () => abort.abort(new Error('cancel before native schedule')),
    });
    await resolveLatestStart(
      harness,
      harness.start(new Blob([new Uint8Array([63])], { type: 'audio/mpeg' }), {
        name: 'abort-before-pause',
      }),
    );
    const previous = harness.controller.timelineSnapshot();

    await expect(harness.engine.pauseCurrent({ signal: abort.signal })).rejects.toThrow(
      'cancel before native schedule',
    );
    expect(harness.sources[0]?.hasPendingPause()).toBe(false);
    expect(harness.controller.timelineSnapshot()).toBe(previous);
    expect(harness.manager.currentCutoverPort()).not.toBeNull();
    await harness.engine.close();
  });

  it('lets scheduled evidence dominate a later abort and close', async () => {
    const harness = makeHarness([{ backend: 'streaming-flac' }]);
    await resolveLatestStart(
      harness,
      harness.start(new Blob([new Uint8Array([64])], { type: 'audio/flac' }), {
        name: 'dominant-pause.flac',
      }),
    );
    harness.setRoomTime(2_000);
    const abort = new AbortController();
    const pending = harness.engine.pauseCurrent({ signal: abort.signal });
    await drainMicrotasks();
    expect(harness.sources[0]?.hasPendingPause()).toBe(true);
    abort.abort(new Error('too late to cancel'));
    const close = harness.engine.close();
    harness.sources[0]?.resolvePause();

    await expect(pending).resolves.toMatchObject({
      kind: 'pause',
      timeline: { phase: 'paused', revision: 2 },
    });
    await close;
    expect(harness.controller.timelineSnapshot()).toMatchObject({ phase: 'paused', revision: 2 });
    expect(harness.manager.currentCutoverPort()).toBeNull();
    expect(harness.fatal).not.toHaveBeenCalled();
  });

  it.each(['audio-buffer', 'streaming-flac'] as const)(
    'stops a %s renderer at one mapped frame and can start the next track',
    async (backend) => {
      vi.useFakeTimers();
      try {
        const harness = makeHarness([{ backend }, { backend }]);
        const blob = new Blob([new Uint8Array([65])], {
          type: backend === 'audio-buffer' ? 'audio/mpeg' : 'audio/flac',
        });
        await resolveLatestStart(harness, harness.start(blob, { name: 'engine-stop' }));
        const previous = harness.controller.timelineSnapshot();
        harness.setRoomTime(2_000);
        const pending = harness.engine.stopCurrent({ signal: new AbortController().signal });
        await drainMicrotasks();
        expect(harness.controller.timelineSnapshot()).toBe(previous);
        expect(harness.manager.currentCutoverPort()).not.toBeNull();

        harness.context.currentTime = 10;
        await vi.advanceTimersByTimeAsync(1_000);
        const stopped = await pending;
        expect(stopped).toMatchObject({
          kind: 'stop',
          evidence: { kind: 'stop-applied', to: { revision: 2 } },
          timeline: { phase: 'stopped', revision: 2, run: null },
        });
        expect(harness.manager.currentCutoverPort()).toBeNull();
        expect(harness.engine.currentRendererSnapshot()).toBeNull();
        expectBodyFree(stopped);

        harness.setRoomTime(11_000);
        const nextBlob = new Blob([new Uint8Array([66])], { type: blob.type });
        const next = await resolveLatestStart(
          harness,
          harness.engine.startLocalTrack(localTrackOptions(harness, Q2, nextBlob, 0)),
        );
        expect(next).toMatchObject({
          attempt: { queueItemId: Q2, revision: 3 },
          timeline: { phase: 'playing', revision: 3 },
        });
        await harness.engine.close();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(['audio-buffer', 'streaming-flac'] as const)(
    'settles natural end for a %s renderer without synthesizing a scheduled stop',
    async (backend) => {
      const harness = makeHarness([{ backend }]);
      const blob = new Blob([new Uint8Array([67])], {
        type: backend === 'audio-buffer' ? 'audio/mpeg' : 'audio/flac',
      });
      await resolveLatestStart(harness, harness.start(blob, { name: 'engine-ended' }));
      harness.sources[0]?.markEnded();
      harness.setRoomTime(2_000);
      const previous = harness.controller.timelineSnapshot();
      const committed = await harness.engine.settleEndedCurrent({
        signal: new AbortController().signal,
      });

      expect(previous).toMatchObject({ phase: 'playing', revision: 1 });
      expect(committed).toMatchObject({
        kind: 'ended',
        evidence: { kind: 'ended-renderer-retired', to: { revision: 2 } },
        timeline: { phase: 'stopped', revision: 2, run: null },
      });
      expect(harness.manager.currentCutoverPort()).toBeNull();
      expect(harness.sources[0]?.destroy).toHaveBeenCalledTimes(1);
      expectBodyFree(committed);
      await harness.engine.close();
    },
  );

  it('rejects a transition after room-clock authority becomes stale', async () => {
    const harness = makeHarness([{ backend: 'audio-buffer' }]);
    await resolveLatestStart(
      harness,
      harness.start(new Blob([new Uint8Array([68])], { type: 'audio/mpeg' }), {
        name: 'stale-transition-clock',
      }),
    );
    const previous = harness.controller.timelineSnapshot();
    harness.roomClock.beginHostSession();

    await expect(
      harness.engine.pauseCurrent({ signal: new AbortController().signal }),
    ).rejects.toThrow(/ROOM_CLOCK_REVOKED|stale/u);
    expect(harness.controller.timelineSnapshot()).toBe(previous);
    expect(harness.sources[0]?.hasPendingPause()).toBe(false);
    await harness.engine.close();
  });

  it('quarantines the room when controller authority changes after transition evidence', async () => {
    let controller!: FilePlaybackApplicationController;
    const harness = makeHarness([{ backend: 'audio-buffer' }], {
      beforeTransitionControllerCommit: () => {
        controller.beginRoom(createStoppedPlaybackTimeline(5_000, 0));
        controller.claimRoomRole('host');
      },
    });
    controller = harness.controller;
    const blob = new Blob([new Uint8Array([69])], { type: 'audio/mpeg' });
    await resolveLatestStart(harness, harness.start(blob, { name: 'transition-aba' }));
    harness.setRoomTime(2_000);
    const pending = harness.engine.pauseCurrent({ signal: new AbortController().signal });
    await drainMicrotasks();
    harness.sources[0]?.resolvePause();

    await expect(pending).rejects.toThrow(/stale|superseded/u);
    await expect(
      harness.engine.pauseCurrent({ signal: new AbortController().signal }),
    ).rejects.toThrow(/closed|stale/u);
    await harness.engine.close();
    expect(harness.manager.currentCutoverPort()).toBeNull();
    expect(harness.fatal).toHaveBeenCalledTimes(1);
  });

  it('normalizes an empty browser MIME without changing the immutable file binding', async () => {
    const harness = makeHarness([{ backend: 'audio-buffer' }]);
    const blob = new Blob([new Uint8Array([5, 6, 7])]);
    const result = await resolveLatestStart(
      harness,
      harness.start(blob, { name: 'unknown.bin', mime: '' }),
    );

    expect(result.asset.mime).toBe('application/octet-stream');
    expect(result.asset.sourceIdentity).toBe(`mxq:q:${Q1}`);
    expect(result.asset.transferSessionId).toBe(`mxq:s:${APPLICATION_SCOPE}:q:${Q1}`);
    await harness.engine.close();
  });

  it('returns null projections after room-clock authority becomes stale', async () => {
    const harness = makeHarness([{ backend: 'audio-buffer' }]);
    const pending = harness.start(new Blob([new Uint8Array([6, 7, 8])], { type: 'audio/mpeg' }), {
      name: 'stale-projection.mp3',
    });
    await resolveLatestStart(harness, pending);
    expect(harness.engine.currentRendererSnapshot()).not.toBeNull();

    harness.roomClock.beginHostSession();
    expect(harness.engine.currentRendererSnapshot()).toBeNull();
    expect(harness.engine.positionAt(1_500)).toBeNull();
    await harness.engine.close();
  });

  it('retains the admitted lease and run across a failed retry while issuing a new rendezvous', async () => {
    const harness = makeHarness([
      { backend: 'audio-buffer', rejectArm: true },
      { backend: 'audio-buffer' },
    ]);
    const blob = new Blob([new Uint8Array([8, 9, 10])], { type: 'audio/mpeg' });

    await expect(harness.start(blob, { name: 'retry.mp3' })).rejects.toThrow(/retired|arm/u);
    await drainMicrotasks();
    expect(harness.controller.timelineSnapshot().revision).toBe(0);

    const result = await resolveLatestStart(harness, harness.start(blob, { name: 'retry.mp3' }));
    expect(result.attempt.runId).toBe(RUN_1);
    expect(result.attempt.rendezvousId).toBe('host-first-rendezvous-2');
    expect(harness.createRunId).toHaveBeenCalledTimes(1);
    await harness.engine.close();
  });

  it('rejects Q2 after a failed Q1 arm and accepts Q2 only through a fresh engine', async () => {
    const first = makeHarness([{ backend: 'audio-buffer', rejectArm: true }]);
    const q1Blob = new Blob([new Uint8Array([31])], { type: 'audio/mpeg' });
    await expect(first.start(q1Blob, { name: 'q1.mp3' })).rejects.toThrow(/retired|arm/u);
    await drainMicrotasks();

    const q2Blob = new Blob([new Uint8Array([32])], { type: 'audio/mpeg' });
    await expect(first.start(q2Blob, { queueItemId: Q2, name: 'q2.mp3' })).rejects.toThrow(
      /one logical queue asset/u,
    );
    expect(first.createRunId).toHaveBeenCalledTimes(1);
    await first.engine.close();

    const fresh = makeHarness([{ backend: 'audio-buffer' }], {
      controller: first.controller,
      roomClock: first.roomClock,
      context: first.context,
      destination: first.destination,
    });
    const committed = await resolveLatestStart(
      fresh,
      fresh.start(q2Blob, { queueItemId: Q2, name: 'q2.mp3' }),
    );
    expect(committed.attempt.queueItemId).toBe(Q2);
    expect(committed.timeline.run?.queueItemId).toBe(Q2);
    await fresh.engine.close();
  });

  it('requires an active exact host room clock and fences its replacement', async () => {
    expect(() =>
      makeHarness([], {
        activateRoomClock: false,
      }),
    ).toThrow(/ROOM_CLOCK_UNAVAILABLE|host room clock authority/u);

    const harness = makeHarness([{ backend: 'streaming-flac' }]);
    const pending = harness.start(new Blob([new Uint8Array([33])], { type: 'audio/flac' }), {
      name: 'clock.flac',
    });
    await drainMicrotasks();
    harness.roomClock.beginHostSession();
    harness.sources[0]?.resolveStart();
    await expect(pending).rejects.toThrow(/ROOM_CLOCK_REVOKED|superseded|stale/u);
    await drainMicrotasks();
    expect(harness.manager.currentCutoverPort()).toBeNull();
    await harness.engine.close();
  });

  it('lets the newest same-file intent abort an older silent admission', async () => {
    const harness = makeHarness([
      { backend: 'audio-buffer', neverStage: true },
      { backend: 'audio-buffer' },
    ]);
    const blob = new Blob([new Uint8Array([11, 12])], { type: 'audio/mpeg' });
    const first = harness.start(blob, { name: 'overlap.mp3' });
    const second = harness.start(blob, { name: 'overlap.mp3' });

    await expect(first).rejects.toThrow(/superseded/u);
    const committed = await resolveLatestStart(harness, second);
    expect(committed.attempt.runId).toBe(RUN_1);
    expect(harness.createRunId).toHaveBeenCalledTimes(1);
    expect(harness.sources).toHaveLength(1);
    await harness.engine.close();
  });

  it('aborts a staged renderer before rendezvous acceptance without advancing timeline truth', async () => {
    const hold = deferred<void>();
    const harness = makeHarness([{ backend: 'streaming-flac', holdAfterStage: hold }]);
    const abort = new AbortController();
    const blob = new Blob([new Uint8Array([13, 14])], { type: 'audio/flac' });
    const pending = harness.start(blob, { name: 'abort.flac', signal: abort.signal });
    await drainMicrotasks();
    abort.abort(new Error('user cancelled'));

    await expect(pending).rejects.toThrow('user cancelled');
    hold.resolve();
    await drainMicrotasks();
    expect(harness.manager.currentCutoverPort()).toBeNull();
    expect(harness.controller.timelineSnapshot().revision).toBe(0);
    expect(harness.sources[0]?.destroy).toHaveBeenCalledTimes(1);
    await harness.engine.close();
  });

  it('fences room ABA before controller commit and retires the exact promoted port', async () => {
    let controller!: FilePlaybackApplicationController;
    const harness = makeHarness([{ backend: 'audio-buffer' }], {
      beforeControllerCommit: () => {
        controller.beginRoom(createStoppedPlaybackTimeline(2_000, 0));
        controller.claimRoomRole('host');
      },
    });
    controller = harness.controller;
    const pending = harness.start(new Blob([new Uint8Array([15, 16])], { type: 'audio/mpeg' }), {
      name: 'aba.mp3',
    });

    await expect(resolveLatestStart(harness, pending)).rejects.toThrow(/stale/u);
    expect(harness.manager.currentCutoverPort()).toBeNull();
    expect(harness.sources[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(harness.controller.timelineSnapshot()).toMatchObject({
      revision: 0,
      phase: 'stopped',
      anchorMonotonicMs: 2_000,
    });
    await harness.engine.close();
  });

  it('keeps timeline truth unchanged when the controller rejects the physical schedule', async () => {
    const harness = makeHarness([{ backend: 'audio-buffer' }], { roomTimeMs: 0 });
    const pending = harness.start(new Blob([new Uint8Array([23, 24])], { type: 'audio/mpeg' }), {
      name: 'old-anchor.mp3',
    });

    await expect(resolveLatestStart(harness, pending)).rejects.toThrow(/precedes/u);
    expect(harness.controller.timelineSnapshot()).toMatchObject({
      revision: 0,
      phase: 'stopped',
      anchorMonotonicMs: 1_000,
    });
    expect(harness.manager.currentCutoverPort()).toBeNull();
    expect(harness.sources[0]?.destroy).toHaveBeenCalledTimes(1);
    await expect(
      harness.start(new Blob([new Uint8Array([25])], { type: 'audio/mpeg' }), {
        name: 'must-not-reuse.mp3',
      }),
    ).rejects.toThrow(/closed|precedes/u);
    await harness.engine.close();
    expect(harness.fatal).toHaveBeenCalledTimes(1);
  });

  it('fences a generation change across the physical-start await', async () => {
    const harness = makeHarness([{ backend: 'streaming-flac' }]);
    const pending = harness.start(new Blob([new Uint8Array([17, 18])], { type: 'audio/flac' }), {
      name: 'stale.flac',
    });
    await drainMicrotasks();
    harness.controller.beginRoom(createStoppedPlaybackTimeline(3_000, 0));
    harness.controller.claimRoomRole('host');
    harness.sources[0]?.resolveStart();

    await expect(pending).rejects.toThrow(/superseded|stale/u);
    await drainMicrotasks();
    expect(harness.manager.currentCutoverPort()).toBeNull();
    expect(harness.controller.timelineSnapshot().revision).toBe(0);
    await harness.engine.close();
  });

  it('close cancels a late stager, clears only its claimed manager, and is idempotent', async () => {
    const hold = deferred<void>();
    const terminalReferences = vi.fn();
    const cleanupOrder: string[] = [];
    const harness = makeHarness([{ backend: 'audio-buffer', holdAfterStage: hold }], {
      onCoordinatorClosed: () => cleanupOrder.push('coordinator'),
      onTerminalReferencesReleased: (snapshot) => {
        cleanupOrder.push('references');
        terminalReferences(snapshot);
      },
    });
    const pending = harness.start(new Blob([new Uint8Array([19, 20])], { type: 'audio/mpeg' }), {
      name: 'late.mp3',
    });
    await drainMicrotasks();
    expect(harness.sources).toHaveLength(1);

    const close1 = harness.engine.close();
    const close2 = harness.engine.close();
    expect(close2).toBe(close1);
    await expect(pending).rejects.toThrow(/closed/u);
    await close1;
    expect(harness.manager.currentCutoverPort()).toBeNull();
    expect(harness.sources[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(harness.controller.timelineSnapshot().revision).toBe(0);
    expect(terminalReferences).toHaveBeenCalledOnce();
    expect(terminalReferences).toHaveBeenCalledWith({
      assetReferenceCount: 0,
      audioContextRetained: false,
      destinationRetained: false,
      clockBindingsRetained: false,
    });
    expect(cleanupOrder).toEqual(['coordinator', 'references']);

    hold.resolve();
    await drainMicrotasks();
    expect(harness.manager.currentCutoverPort()).toBeNull();
    expect(harness.sources[0]?.destroy).toHaveBeenCalledTimes(1);
  });

  it('propagates coordinator-close cleanup failure while still completing native cleanup', async () => {
    const coordinatorFailure = new Error('fixture coordinator close failure');
    const coordinatorClosed = vi.fn(() => {
      throw coordinatorFailure;
    });
    const terminalReferences = vi.fn();
    const harness = makeHarness([{ backend: 'audio-buffer' }], {
      onCoordinatorClosed: coordinatorClosed,
      onTerminalReferencesReleased: terminalReferences,
    });
    const pending = harness.start(new Blob([new Uint8Array([41])], { type: 'audio/mpeg' }), {
      name: 'coordinator-race.mp3',
    });
    await drainMicrotasks();

    const close = harness.engine.close();
    await expect(pending).rejects.toThrow(/closed|retired/u);
    await expect(close).rejects.toBe(coordinatorFailure);
    await expect(harness.engine.close()).rejects.toBe(coordinatorFailure);
    expect(coordinatorClosed).toHaveBeenCalledTimes(1);
    expect(terminalReferences).toHaveBeenCalledTimes(1);
    expect(harness.manager.currentCutoverPort()).toBeNull();
    expect(harness.sources[0]?.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps accepted timeline truth when close wins the local-evidence race', async () => {
    const coordinatorClosed = vi.fn();
    const harness = makeHarness([{ backend: 'streaming-flac' }], {
      onCoordinatorClosed: coordinatorClosed,
    });
    const pending = harness.start(new Blob([new Uint8Array([42])], { type: 'audio/flac' }), {
      name: 'evidence-race.flac',
    });
    await drainMicrotasks();
    harness.sources[0]?.resolveStart();
    const close = harness.engine.close();

    await expect(pending).rejects.toThrow(/closed|retired|superseded/u);
    await close;
    expect(coordinatorClosed).toHaveBeenCalledTimes(1);
    expect(harness.controller.timelineSnapshot()).toMatchObject({
      revision: 1,
      phase: 'playing',
      run: { queueItemId: Q1, runId: RUN_1 },
    });
    expect(harness.manager.currentCutoverPort()).toBeNull();
    expect(harness.sources[0]?.destroy).toHaveBeenCalledTimes(1);
  });

  it('notifies fatal ownership only after manager and registry terminal cleanup', async () => {
    const fatalObserved = deferred<void>();
    let closeObservedAtFatal: Promise<void> | null = null;
    const terminalReferences = vi.fn();
    const terminalOrder: string[] = [];
    let harness!: EngineHarness;
    harness = makeHarness([], {
      fatalAfterAdmission: true,
      onCoordinatorClosed: () => terminalOrder.push('coordinator-closed'),
      onTerminalReferencesReleased: (snapshot) => {
        terminalOrder.push('references-released');
        terminalReferences(snapshot);
      },
      fatal: () => {
        terminalOrder.push('fatal-callback');
        expect(harness.manager.currentCutoverPort()).toBeNull();
        expect(terminalReferences).toHaveBeenCalledWith({
          assetReferenceCount: 0,
          audioContextRetained: false,
          destinationRetained: false,
          clockBindingsRetained: false,
        });
        closeObservedAtFatal = harness.engine.close();
        fatalObserved.resolve();
      },
    });
    const firstBlob = new Blob([new Uint8Array([21])], { type: 'audio/mpeg' });
    await expect(harness.start(firstBlob, { name: 'fatal.mp3' })).rejects.toThrow(/fixture/iu);
    await fatalObserved.promise;
    expect(closeObservedAtFatal).toBe(harness.engine.close());
    await expect(harness.engine.close()).resolves.toBeUndefined();
    expect(harness.fatal).toHaveBeenCalledTimes(1);
    expect(terminalReferences).toHaveBeenCalledTimes(1);
    expect(terminalOrder).toEqual(['coordinator-closed', 'references-released', 'fatal-callback']);
    await expect(harness.start(firstBlob, { name: 'fatal.mp3' })).rejects.toThrow(
      /closed|fixture/iu,
    );
  });
});
