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
} from '../file-playback-host-first-file-engine.ts';
import { FilePlaybackManager } from '../file-playback-manager.ts';
import { FilePlaybackProductBaselineIdIssuer } from '../file-playback-product-baseline-session.ts';
import { FilePlaybackRoomClock } from '../file-playback-room-clock.ts';
import {
  createAudioBufferPlaybackStartEvidence,
  createFilePlaybackCutoverTarget,
  createFilePlaybackRejectedTransitionResult,
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
    positionSeconds: 0,
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
      return rejectedTransition(intent);
    },
    async seekRevisioned(intent) {
      return rejectedTransition(intent);
    },
    positionAt() {
      return {
        queueItemId,
        run,
        phase,
        positionSeconds: 0,
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
  const createRunId = vi.fn(() => RUN_1);
  const fatal = vi.fn(options.fatal ?? (() => undefined));
  const runtimeForTests: FilePlaybackHostFirstFileEngineRuntimeForTests = {
    createRunIdForTests: createRunId,
    createRendezvousIdForTests: () => `host-first-rendezvous-${++rendezvousSequence}`,
    createManagerForTests: () => options.managerFactory?.(manager) ?? manager,
    localStartRuntimeForTests: { stageAssetSourceForTests },
    ...(options.beforeControllerCommit
      ? { beforeControllerCommitForTests: options.beforeControllerCommit }
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

  it('rejects non-host and non-stopped controller authority', () => {
    expect(() => makeHarness([], { controllerRole: 'guest' })).toThrow(/stopped host/u);
    expect(() => makeHarness([], { controllerRole: null })).toThrow(/stopped host/u);
    expect(() => makeHarness([], { establishActiveGuest: true })).toThrow(/stopped host/u);
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
    expect(harness.controller.timelineSnapshot().revision).toBe(0);
    expect(harness.controller.timelineSnapshot().phase).toBe('stopped');

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

  it('aborts an in-flight renderer without advancing timeline truth', async () => {
    const harness = makeHarness([{ backend: 'streaming-flac' }]);
    const abort = new AbortController();
    const blob = new Blob([new Uint8Array([13, 14])], { type: 'audio/flac' });
    const pending = harness.start(blob, { name: 'abort.flac', signal: abort.signal });
    await drainMicrotasks();
    abort.abort(new Error('user cancelled'));

    await expect(pending).rejects.toThrow('user cancelled');
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
    await harness.engine.close();
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

  it('lets close win the same-microtask race with physical-start evidence', async () => {
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
    expect(harness.controller.timelineSnapshot().revision).toBe(0);
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
