import { afterEach, describe, expect, it, vi } from 'vitest';

import { FilePlaybackConnectionChannel } from '../../network/file-playback-connection-channel.ts';
import {
  FilePlaybackGuestSessionHandshake,
  FilePlaybackHandshakeIdIssuer,
  FilePlaybackHostSessionHandshake,
} from '../../network/file-playback-session-handshake.ts';
import type { DataConnection, QueueItemId } from '../../types/index.ts';
import { FilePlaybackApplicationController } from '../file-playback-application-controller.ts';
import {
  FilePlaybackAssetRegistry,
  type FilePlaybackAssetLease,
} from '../file-playback-asset-registry.ts';
import {
  FILE_PLAYBACK_CURRENT_BOUNDED_ROUTE_POLICY,
  FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
  type FilePlaybackBoundedRoutePolicy,
} from '../file-playback-bounded-route-policy.ts';
import { FilePlaybackClock } from '../file-playback-clock.ts';
import {
  FilePlaybackHostFirstFileEngine,
  type FilePlaybackHostFirstFileEngineRuntimeForTests,
  type HostCurrentPlaybackTimelineCommittedEvent,
  type HostCurrentPlaybackTransitionScheduledEvent,
  type HostPeerPlaybackPublication,
  type HostPreparedLocalTrack,
  type StartHostFirstLocalFileOptions,
  type StartHostLocalTrackOptions,
  type WarmHostLocalTrackOptions,
} from '../file-playback-host-first-file-engine.ts';
import { FilePlaybackManager } from '../file-playback-manager.ts';
import { FilePlaybackProductBaselineIdIssuer } from '../file-playback-product-baseline-session.ts';
import {
  RemoteRendezvousParticipant,
  type RemoteRendererEvidenceScope,
} from '../remote-rendezvous-participant.ts';
import { FilePlaybackRoomClock } from '../file-playback-room-clock.ts';
import {
  createAudioBufferPlaybackStartEvidence,
  createFilePlaybackCutoverTarget,
  createFilePlaybackRejectedTransitionResult,
  createFilePlaybackScheduledTransitionResult,
  createFilePlaybackTransitionEvidence,
  createStreamingPlaybackStartEvidence,
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
import type { HostRendezvousAttempt } from '../rendezvous-coordinator.ts';
import type { EncodedAudioAsset } from '../sources/encoded-audio-asset.ts';
import {
  throwIfAborted,
  validateExactRead,
  type EncodedAudioSource,
  type EncodedAudioSourceMetadata,
} from '../sources/encoded-audio-source.ts';
import type { RendererHealthWireMessage } from '../file-playback-wire.ts';
import { scanAdtsFrames } from '../aac/frame-scanner.ts';
import { createCodecTimelineHostArtifact } from '../manifests/codec-timeline-host-artifact.ts';
import * as codecTimelineHostArtifactLeaseStore from '../manifests/codec-timeline-host-artifact-lease-store.ts';

const Q1 = '96000000-0000-4000-8000-000000000001' as QueueItemId;
const Q2 = '96000000-0000-4000-8000-000000000002' as QueueItemId;
const RUN_1 = '96000000-0000-4000-8000-000000000101';
const RUN_2 = '96000000-0000-4000-8000-000000000102';
const RUN_3 = '96000000-0000-4000-8000-000000000103';
const APPLICATION_SCOPE = '96000000-0000-4000-8000-000000000201';
const ROOM_TOKEN = Object.freeze({ room: 'host-first-file-engine' });
let connectionSequence = 0;

afterEach(() => vi.restoreAllMocks());

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

class HostArtifactMemorySource implements EncodedAudioSource {
  readonly kind = 'blob' as const;

  constructor(
    readonly bytes: Uint8Array,
    readonly identity: string,
    readonly metadata: EncodedAudioSourceMetadata,
  ) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    return this.bytes.slice(offset, end);
  }

  async close(): Promise<void> {}
}

function adtsFixtureFrame(frameLengthBytes: number, fill: number): Uint8Array {
  const bytes = new Uint8Array(frameLengthBytes).fill(fill);
  const sampleRateIndex = 4;
  const channelConfiguration = 2;
  bytes[0] = 0xff;
  bytes[1] = 0xf1;
  bytes[2] = (1 << 6) | (sampleRateIndex << 2) | ((channelConfiguration >>> 2) & 1);
  bytes[3] = ((channelConfiguration & 0b11) << 6) | ((frameLengthBytes >>> 11) & 0b11);
  bytes[4] = (frameLengthBytes >>> 3) & 0xff;
  bytes[5] = ((frameLengthBytes & 0b111) << 5) | 0b1_1111;
  bytes[6] = 0b1111_1100;
  return bytes;
}

async function issueFixtureHostArtifact(
  bytes: Uint8Array,
  binding: Readonly<{
    queueItemId: QueueItemId;
    sourceIdentity: string;
    transferSessionId: string;
    name: string;
    mime: string;
  }>,
) {
  const source = new HostArtifactMemorySource(
    bytes,
    binding.sourceIdentity,
    Object.freeze({ name: binding.name, mime: binding.mime }),
  );
  const timeline = await scanAdtsFrames(source, new AbortController().signal);
  return createCodecTimelineHostArtifact({
    binding: { ...binding, encodedSize: bytes.byteLength },
    source,
    timeline,
    signal: new AbortController().signal,
  });
}

async function installFixtureHostArtifact(
  registry: FilePlaybackAssetRegistry,
  lease: FilePlaybackAssetLease,
  bytes: Uint8Array,
) {
  const snapshot = registry.snapshotForLease(ROOM_TOKEN, lease);
  if (!snapshot) throw new Error('Fixture asset lease is unavailable');
  if (snapshot.size !== bytes.byteLength) throw new Error('Fixture artifact size changed');
  const artifact = await issueFixtureHostArtifact(bytes, {
    queueItemId: snapshot.queueItemId,
    sourceIdentity: snapshot.sourceIdentity,
    transferSessionId: snapshot.transferSessionId,
    name: snapshot.name,
    mime: snapshot.mime,
  });
  const access = { registry, roomToken: ROOM_TOKEN, lease };
  codecTimelineHostArtifactLeaseStore.installCodecTimelineHostArtifactForLease({
    ...access,
    artifact,
  });
  expect(
    codecTimelineHostArtifactLeaseStore.describeCodecTimelineHostArtifactForLease(access),
  ).not.toBeNull();
  return access;
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
  readonly finalizeGate?: ReturnType<typeof deferred<void>>;
  readonly prepareGate?: ReturnType<typeof deferred<void>>;
  readonly destroyGate?: ReturnType<typeof deferred<void>>;
  readonly destroyError?: Error;
}

interface FakeSourceHarness {
  readonly source: FilePlaybackCutoverSource;
  readonly prepare: ReturnType<typeof vi.fn>;
  readonly arm: ReturnType<typeof vi.fn>;
  readonly finalize: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly releaseConstructionLease: ReturnType<typeof vi.fn>;
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
  const prepare = vi.fn();
  const arm = vi.fn();
  const finalize = vi.fn();
  const destroy = vi.fn();
  const releaseConstructionLease = vi.fn();
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
      prepare();
      phase = 'preparing';
      if (options.prepareGate) await options.prepareGate.promise;
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
      if (options.finalizeGate) await options.finalizeGate.promise;
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
      if (options.destroyGate) await options.destroyGate.promise;
      if (options.destroyError) throw options.destroyError;
      phase = 'destroyed';
    },
  };

  return {
    source,
    prepare,
    arm,
    finalize,
    destroy,
    releaseConstructionLease,
    startAtContextTime: () => targetTime,
    resolveStart() {
      if (targetFrame === null) throw new Error('No start target is armed');
      phase = 'playing';
      if (backend === 'audio-buffer') {
        started.resolve(createAudioBufferPlaybackStartEvidence(targetFrame));
      } else {
        started.resolve(createStreamingPlaybackStartEvidence(targetFrame, targetFrame));
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
      releaseConstructionLease: harness.releaseConstructionLease,
    });
  }
  return Object.freeze({
    backend: 'bounded-stream',
    source: harness.source as never,
    sourceIdentity,
    releaseConstructionLease: harness.releaseConstructionLease,
  });
}

interface StagePlan {
  readonly backend: FilePlaybackBackend;
  readonly rejectArm?: boolean;
  readonly finalizeGate?: ReturnType<typeof deferred<void>>;
  readonly neverStage?: boolean;
  readonly holdAfterStage?: ReturnType<typeof deferred<void>>;
  readonly prepareGate?: ReturnType<typeof deferred<void>>;
  readonly destroyGate?: ReturnType<typeof deferred<void>>;
  readonly destroyError?: Error;
}

interface EngineHarness {
  readonly controller: FilePlaybackApplicationController;
  readonly manager: FilePlaybackManager;
  readonly context: FakeAudioContext;
  readonly destination: AudioNode;
  readonly roomClock: FilePlaybackRoomClock;
  readonly engine: FilePlaybackHostFirstFileEngine;
  readonly sources: FakeSourceHarness[];
  readonly stageRequests: Array<Parameters<typeof stageFilePlaybackAssetSource>[0]>;
  readonly factoryRequests: unknown[];
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
    readonly onTransitionScheduled?: (
      event: Readonly<HostCurrentPlaybackTransitionScheduledEvent>,
    ) => void;
    readonly onTimelineCommitted?: (
      event: Readonly<HostCurrentPlaybackTimelineCommittedEvent>,
    ) => void;
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
    readonly boundedRoutePolicy?: Readonly<FilePlaybackBoundedRoutePolicy>;
    readonly admitAsset?: NonNullable<
      FilePlaybackHostFirstFileEngineRuntimeForTests['admitAssetForTests']
    >;
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
  const stageRequests: Array<Parameters<typeof stageFilePlaybackAssetSource>[0]> = [];
  const factoryRequests: unknown[] = [];
  const pendingPlans = [...plans];
  const warmStageGates = new Map<QueueItemId, ReturnType<typeof deferred<void>>>();
  const stageAssetSourceForTests: NonNullable<
    FilePlaybackHostFirstFileEngineRuntimeForTests['localStartRuntimeForTests']
  >['stageAssetSourceForTests'] = async (stageOptions) => {
    stageRequests.push(stageOptions);
    const plan = pendingPlans.shift();
    if (!plan) throw new Error('No source stage plan remains');
    if (plan.neverStage) return new Promise(() => undefined);
    const source = makeSource(stageOptions.expectedBinding.queueItemId, plan.backend, context, {
      rejectArm: plan.rejectArm,
      finalizeGate: plan.finalizeGate,
      prepareGate: plan.prepareGate,
      destroyGate: plan.destroyGate,
      destroyError: plan.destroyError,
    });
    sources.push(source);
    const staged = await stageFilePlaybackAssetSource({
      ...stageOptions,
      runtime: {
        createBlobSource: vi.fn(async (sourceOptions) => {
          factoryRequests.push(sourceOptions);
          return factoryResult(source, stageOptions.expectedBinding.sourceIdentity);
        }),
        createEncodedSource: vi.fn(async (sourceOptions) => {
          factoryRequests.push(sourceOptions);
          return factoryResult(source, stageOptions.expectedBinding.sourceIdentity);
        }),
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
    warmSourceRuntimeForTests: {
      createBlobSource: async (sourceOptions) => {
        factoryRequests.push(sourceOptions);
        const plan = pendingPlans.shift();
        if (!plan) throw new Error('No warm source plan remains');
        if (plan.neverStage) return new Promise(() => undefined);
        const source = makeSource(sourceOptions.queueItemId, plan.backend, context, {
          rejectArm: plan.rejectArm,
          finalizeGate: plan.finalizeGate,
          prepareGate: plan.prepareGate,
          destroyGate: plan.destroyGate,
          destroyError: plan.destroyError,
        });
        sources.push(source);
        if (plan.holdAfterStage) {
          warmStageGates.set(sourceOptions.queueItemId, plan.holdAfterStage);
        }
        return factoryResult(source, sourceOptions.sourceIdentity);
      },
      createEncodedSource: async (sourceOptions) => {
        factoryRequests.push(sourceOptions);
        const plan = pendingPlans.shift();
        if (!plan) throw new Error('No warm source plan remains');
        if (plan.neverStage) return new Promise(() => undefined);
        const source = makeSource(sourceOptions.queueItemId, plan.backend, context, {
          rejectArm: plan.rejectArm,
          finalizeGate: plan.finalizeGate,
          prepareGate: plan.prepareGate,
          destroyGate: plan.destroyGate,
          destroyError: plan.destroyError,
        });
        sources.push(source);
        if (plan.holdAfterStage) {
          warmStageGates.set(sourceOptions.queueItemId, plan.holdAfterStage);
        }
        return factoryResult(source, sourceOptions.encodedSource.identity);
      },
      stageCandidate: async (manager, candidateOptions) => {
        const port = await manager.stageCutoverCandidate(candidateOptions);
        const queueItemId = candidateOptions.source.queueItemId;
        const gate = warmStageGates.get(queueItemId);
        if (gate) {
          warmStageGates.delete(queueItemId);
          await gate.promise;
        }
        return port;
      },
    },
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
    ...(options.admitAsset ? { admitAssetForTests: options.admitAsset } : {}),
  };
  const roomGeneration = controller.snapshot().roomGeneration;
  const engine = new FilePlaybackHostFirstFileEngine({
    controller,
    roomGeneration,
    applicationScopeId: APPLICATION_SCOPE,
    roomToken: ROOM_TOKEN,
    roomClock,
    hostParticipantId: 'host-first-participant',
    ...(options.boundedRoutePolicy ? { boundedRoutePolicy: options.boundedRoutePolicy } : {}),
    onFatalRoom: fatal,
    ...(options.onTransitionScheduled
      ? { onTransitionScheduled: options.onTransitionScheduled }
      : {}),
    ...(options.onTimelineCommitted ? { onTimelineCommitted: options.onTimelineCommitted } : {}),
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
    stageRequests,
    factoryRequests,
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

function warmTrackOptions(
  harness: EngineHarness,
  queueItemId: QueueItemId,
  blob: Blob,
  signal = new AbortController().signal,
): WarmHostLocalTrackOptions {
  return {
    queueItemId,
    blob,
    name: queueItemId === Q1 ? 'first.flac' : 'replacement.flac',
    mime: blob.type,
    audioContext: harness.context as unknown as AudioContext,
    decodeOrdinaryAudio: vi.fn(async () => ({
      audioBuffer: fakeAudioBuffer(),
      release: vi.fn(),
    })),
    signal,
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
    expect(candidate).not.toBeInstanceOf(ArrayBuffer);
    expect(ArrayBuffer.isView(candidate)).toBe(false);
    if (candidate === null || typeof candidate !== 'object' || seen.has(candidate)) return;
    seen.add(candidate);
    for (const nested of Object.values(candidate)) visit(nested);
  };
  visit(value);
}

async function expectBlobManifestBundle(
  source: Blob | EncodedAudioSource,
  manifest: Uint8Array,
  media: Uint8Array,
  sourceIdentity: string,
): Promise<void> {
  expect(source).not.toBeInstanceOf(Blob);
  if (source instanceof Blob) throw new Error('Expected a manifest-prefixed source');
  expect(source).toMatchObject({
    kind: 'blob',
    identity: sourceIdentity,
    size: manifest.byteLength + media.byteLength,
  });
  expect(await source.readAt(0, manifest.byteLength, new AbortController().signal)).toEqual(
    manifest,
  );
  const boundaryOffset = manifest.byteLength - 2;
  const expectedBoundary = new Uint8Array(4);
  expectedBoundary.set(manifest.subarray(boundaryOffset), 0);
  expectedBoundary.set(media.subarray(0, 2), 2);
  expect(await source.readAt(boundaryOffset, 4, new AbortController().signal)).toEqual(
    expectedBoundary,
  );
  expect(
    await source.readAt(manifest.byteLength, media.byteLength, new AbortController().signal),
  ).toEqual(media);
  await source.close();
}

function errorTreeContains(value: unknown, target: unknown): boolean {
  if (value === target) return true;
  if (
    value instanceof AggregateError &&
    value.errors.some((entry) => errorTreeContains(entry, target))
  ) {
    return true;
  }
  return value instanceof Error && errorTreeContains(value.cause, target);
}

function transferredAsset(
  blob: Blob,
  identity: string,
  metadata: Readonly<{ name: string; mime: string }>,
  sourceClosed: ReturnType<typeof vi.fn>,
  onAcquire?: () => void,
): EncodedAudioAsset {
  let activeLeaseCount = 0;
  return {
    kind: 'peer-range',
    size: blob.size,
    identity,
    metadata,
    get activeLeaseCount() {
      return activeLeaseCount;
    },
    acquire(): EncodedAudioSource {
      onAcquire?.();
      activeLeaseCount += 1;
      let closed = false;
      return {
        kind: 'peer-range',
        size: blob.size,
        identity,
        metadata,
        async readAt(_offset, length, signal) {
          signal.throwIfAborted();
          return new Uint8Array(length);
        },
        async close() {
          if (closed) return;
          closed = true;
          activeLeaseCount -= 1;
          sourceClosed();
        },
      };
    },
    async close() {},
  };
}

interface RemoteRecoveryHarness {
  readonly participant: RemoteRendezvousParticipant;
  readonly arms: RendezvousArmIntent[];
  readonly finalizes: RendezvousFinalizeIntent[];
  readonly cancels: unknown[];
  accept(attempt: HostRendezvousAttempt): Promise<void>;
}

function remoteRecoveryHarness(
  participantId: string,
  publication: Readonly<
    Pick<HostPeerPlaybackPublication, 'asset' | 'state'> | HostPreparedLocalTrack
  >,
): RemoteRecoveryHarness {
  const arms: RendezvousArmIntent[] = [];
  const finalizes: RendezvousFinalizeIntent[] = [];
  const cancels: unknown[] = [];
  let nowRoomTimeMs = 0;
  const scope: RemoteRendererEvidenceScope = Object.freeze({
    sessionId: `recovery-session-${participantId}`,
    connectionId: `recovery-connection-${participantId}`,
    recipientParticipantId: 'host-first-participant',
    sourceIdentity: publication.asset.binding.sourceIdentity,
    transferSessionId: publication.asset.binding.transferSessionId,
  });
  const participant = new RemoteRendezvousParticipant({
    participantId,
    rendererEvidenceScope: scope,
    rttP95Ms: 40,
    armP95Ms: 80,
    nowRoomTimeMs: () => nowRoomTimeMs,
    dispatchArm: (intent) => arms.push(intent),
    dispatchFinalize: (intent) => finalizes.push(intent),
    dispatchCancel: (intent) => cancels.push(intent),
  });
  return {
    participant,
    arms,
    finalizes,
    cancels,
    async accept(attempt) {
      const arm = arms.at(-1);
      if (!arm) throw new Error('Remote recovery ARM was not dispatched');
      nowRoomTimeMs = Math.max(nowRoomTimeMs, arm.finalizeByRoomTimeMs - 1);
      expect(participant.acceptArmReceipt(armedReceipt(arm))).toBe(true);
      await drainMicrotasks();
      const finalize = finalizes.at(-1);
      if (!finalize) throw new Error('Remote recovery FINALIZE was not dispatched');
      nowRoomTimeMs = Math.max(nowRoomTimeMs, finalize.finalizedAtRoomTimeMs);
      expect(participant.acceptFinalizeReceipt(acceptedReceipt(finalize))).toBe(true);
      await drainMicrotasks();
      nowRoomTimeMs = Math.max(nowRoomTimeMs, attempt.startAtRoomTimeMs);
      const evidence: RendererHealthWireMessage = {
        protocolVersion: 2,
        kind: 'renderer-health',
        sessionId: scope.sessionId,
        connectionId: scope.connectionId,
        senderParticipantId: participantId,
        recipientParticipantId: scope.recipientParticipantId,
        controlSequence: 1,
        queueItemId: publication.state.queueItemId,
        runId: publication.state.runId,
        revision: publication.state.revision,
        sourceIdentity: scope.sourceIdentity,
        transferSessionId: scope.transferSessionId,
        rendezvousId: attempt.rendezvousId,
        value: 'healthy',
        observedAtRoomTimeMs: attempt.startAtRoomTimeMs,
        leaseUntilRoomTimeMs: attempt.startAtRoomTimeMs + 5_000,
        renderedFrame: Math.round(attempt.startAtRoomTimeMs * 48),
        underrunCount: 0,
        reasonCode: null,
      };
      expect(participant.acceptRendererStartEvidence(evidence)).toBe(true);
    },
  };
}

const MANIFEST_POLICY_CASES: readonly Readonly<{
  label: string;
  policy: Readonly<FilePlaybackBoundedRoutePolicy> | undefined;
  installs: boolean;
}>[] = Object.freeze([
  Object.freeze({ label: 'omitted', policy: undefined, installs: false }),
  Object.freeze({
    label: 'explicit current',
    policy: FILE_PLAYBACK_CURRENT_BOUNDED_ROUTE_POLICY,
    installs: false,
  }),
  Object.freeze({
    label: 'M4A-only',
    policy: Object.freeze({
      mode: 'format-gated-v1' as const,
      mp3: 'current' as const,
      m4aAacLc: 'webcodecs' as const,
      rawAdtsAac: 'current' as const,
    }),
    installs: false,
  }),
  Object.freeze({
    label: 'ADTS manifest',
    policy: Object.freeze({
      mode: 'format-gated-v1' as const,
      mp3: 'current' as const,
      m4aAacLc: 'current' as const,
      rawAdtsAac: 'webcodecs' as const,
    }),
    installs: true,
  }),
  Object.freeze({
    label: 'MP3 manifest',
    policy: Object.freeze({
      mode: 'format-gated-v1' as const,
      mp3: 'bounded-stream' as const,
      m4aAacLc: 'current' as const,
      rawAdtsAac: 'current' as const,
    }),
    installs: true,
  }),
  Object.freeze({
    label: 'universal',
    policy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
    installs: true,
  }),
]);

describe('FilePlaybackHostFirstFileEngine', () => {
  it('preserves policy omission and forwards its canonical fixed policy to local staging', async () => {
    const omitted = makeHarness([{ backend: 'audio-buffer' }]);
    await resolveLatestStart(
      omitted,
      omitted.start(new Blob([new Uint8Array([1, 2])], { type: 'audio/mpeg' })),
    );
    expect(omitted.stageRequests[0]).not.toHaveProperty('boundedRoutePolicy');
    await omitted.engine.close();

    const requested = Object.freeze({
      mode: 'universal-v1' as const,
      aacBackendId: 'webcodecs' as const,
      m4aBackendId: 'webcodecs' as const,
    });
    const optedIn = makeHarness([{ backend: 'bounded-stream' }], {
      boundedRoutePolicy: requested,
    });
    await resolveLatestStart(
      optedIn,
      optedIn.start(new Blob([new Uint8Array([3, 4])], { type: 'audio/mp4' })),
    );
    expect(optedIn.stageRequests[0]?.boundedRoutePolicy).toBe(
      FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
    );
    expect(optedIn.stageRequests[0]?.boundedRoutePolicy).not.toBe(requested);
    await optedIn.engine.close();
  });

  it.each(MANIFEST_POLICY_CASES)(
    'propagates the host artifact opt-in only for $label cold staging',
    async ({ policy, installs }) => {
      const harness = makeHarness([{ backend: 'bounded-stream' }], {
        ...(policy ? { boundedRoutePolicy: policy } : {}),
      });
      await resolveLatestStart(
        harness,
        harness.start(new Blob([new Uint8Array([9, 8, 7])], { type: 'audio/mpeg' }), {
          name: 'policy.mp3',
        }),
      );

      if (installs) {
        expect(harness.stageRequests[0]).toHaveProperty('installCodecTimelineHostArtifact', true);
        expect(harness.factoryRequests[0]).toHaveProperty('codecTimelineHostArtifactBinding');
      } else {
        expect(harness.stageRequests[0]).not.toHaveProperty('installCodecTimelineHostArtifact');
        expect(harness.factoryRequests[0]).not.toHaveProperty('codecTimelineHostArtifactBinding');
      }
      await harness.engine.close();
    },
  );

  it.each(MANIFEST_POLICY_CASES)(
    'propagates the host artifact opt-in only for $label warm preparation',
    async ({ policy, installs }) => {
      const harness = makeHarness([{ backend: 'bounded-stream' }], {
        ...(policy ? { boundedRoutePolicy: policy } : {}),
      });
      const blob = new Blob([new Uint8Array([6, 5, 4])], { type: 'audio/mpeg' });
      await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));

      if (installs) {
        expect(harness.factoryRequests[0]).toHaveProperty('codecTimelineHostArtifactBinding');
      } else {
        expect(harness.factoryRequests[0]).not.toHaveProperty('codecTimelineHostArtifactBinding');
      }
      await harness.engine.close();
    },
  );

  it('rejects an invalid fixed route policy before constructing engine-owned collaborators', () => {
    const managerFactory = vi.fn((manager: FilePlaybackManager) => manager);
    expect(() =>
      makeHarness([], {
        boundedRoutePolicy: Object.freeze({
          mode: 'universal-v1',
          aacBackendId: 'webcodecs',
          m4aBackendId: 'automatic',
        }) as unknown as Readonly<FilePlaybackBoundedRoutePolicy>,
        managerFactory,
      }),
    ).toThrow(/M4A backend must be exactly webcodecs/u);
    expect(managerFactory).not.toHaveBeenCalled();
  });

  it('warms one bounded source without allocating a run or manager slot, then binds revision at handoff', async () => {
    const harness = makeHarness([{ backend: 'bounded-stream' }], {
      initialTimeline: createStoppedPlaybackTimeline(1_000, 6),
    });
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/flac' });
    const before = harness.controller.timelineSnapshot();

    const warm = await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));

    expect(warm).toMatchObject({
      schemaVersion: 1,
      roomGeneration: 1,
      status: 'warmed',
      backend: 'bounded-stream',
      asset: { binding: { queueItemId: Q1 }, encodedSize: 3 },
      readiness: { durationSeconds: 180, outputSampleRateHz: 48_000, channelCount: 2 },
    });
    expectBodyFree(warm);
    expect(harness.controller.timelineSnapshot()).toBe(before);
    expect(harness.createRunId).not.toHaveBeenCalled();
    expect(harness.manager.currentCutoverPort()).toBeNull();
    expect(harness.manager.snapshot()).toEqual({ active: null, standby: null });
    expect(harness.sources).toHaveLength(1);
    expect(harness.sources[0]?.prepare).toHaveBeenCalledOnce();
    expect(harness.sources[0]?.source.getSnapshot().phase).toBe('ready');
    expect(harness.sources[0]?.releaseConstructionLease).not.toHaveBeenCalled();
    expect(warm.sourceLease).toBeTruthy();
    expect(Object.isFrozen(warm.sourceLease)).toBe(true);

    const prepared = await harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q1, blob, 4),
    );
    expect(prepared).toMatchObject({
      backend: 'bounded-stream',
      state: { queueItemId: Q1, runId: RUN_1, revision: 7 },
      positionSeconds: 4,
    });
    expect(prepared.sourceLease).toBe(warm.sourceLease);
    expect(harness.createRunId).toHaveBeenCalledOnce();
    expect(harness.sources).toHaveLength(1);
    expect(harness.sources[0]?.prepare).toHaveBeenCalledOnce();
    expect(harness.sources[0]?.releaseConstructionLease).toHaveBeenCalledOnce();
    expect(harness.stageRequests).toHaveLength(0);

    const pending = harness.engine.startPreparedLocalTrack({
      prepared,
      remoteParticipants: [],
    });
    await resolveLatestStart(harness, pending);
    await harness.engine.close();
  });

  it('admits a new warm Blob provisionally and promotes its exact registry lease only at commit', async () => {
    const provisionalAdmission = vi.spyOn(
      FilePlaybackAssetRegistry.prototype,
      'admitProvisionalBlobAsset',
    );
    const liveAdmission = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'admitBlob');
    const promotion = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'promoteProvisionalAsset');
    const discard = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'discardProvisionalAsset');
    const harness = makeHarness([{ backend: 'bounded-stream' }]);
    const blob = new Blob([new Uint8Array([51, 52, 53])], { type: 'audio/flac' });

    const warm = await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));
    const provisionalLease = provisionalAdmission.mock.results[0]?.value;
    expect(provisionalLease).toBeTruthy();
    expect(provisionalAdmission).toHaveBeenCalledOnce();
    expect(liveAdmission).not.toHaveBeenCalled();
    expect(promotion).not.toHaveBeenCalled();

    const source = await harness.engine.resolveWarmPeerRangeSource({
      sourceLease: warm.sourceLease!,
      sourceIdentity: warm.asset.binding.sourceIdentity,
      peerRangeManifest: warm.asset.peerRangeManifest,
      signal: new AbortController().signal,
    });
    expect(source).toBe(blob);

    const prepared = await harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q1, blob, 0),
    );
    expect(promotion).not.toHaveBeenCalled();
    const pending = harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] });
    await resolveLatestStart(harness, pending);

    expect(promotion).toHaveBeenCalledOnce();
    expect(promotion).toHaveBeenCalledWith(ROOM_TOKEN, provisionalLease);
    expect(discard).not.toHaveBeenCalled();
    await harness.engine.close();
    expect(discard).not.toHaveBeenCalled();
  });

  it('retains an installed artifact across provisional promotion until room close', async () => {
    const provisionalAdmission = vi.spyOn(
      FilePlaybackAssetRegistry.prototype,
      'admitProvisionalBlobAsset',
    );
    const promotion = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'promoteProvisionalAsset');
    const holdBeforeWarmResult = deferred<void>();
    const harness = makeHarness(
      [{ backend: 'bounded-stream', prepareGate: holdBeforeWarmResult }],
      {
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
      },
    );
    const bytes = adtsFixtureFrame(37, 0x51);
    const blob = new Blob([bytes], { type: 'audio/aac' });

    const pendingWarm = harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));
    await drainMicrotasks();
    const lease = provisionalAdmission.mock.results[0]?.value;
    const registry = provisionalAdmission.mock.contexts[0] as FilePlaybackAssetRegistry;
    const access = await installFixtureHostArtifact(registry, lease!, bytes);
    holdBeforeWarmResult.resolve();
    const warm = await pendingWarm;
    const warmManifest = warm.asset.peerRangeManifest;
    if (!warm.sourceLease || !warmManifest) {
      throw new Error('Fixture expected a manifest-bearing warm source');
    }
    const manifestBytes =
      codecTimelineHostArtifactLeaseStore.copyCodecTimelineHostArtifactManifestForLease(access);
    if (!manifestBytes) throw new Error('Fixture manifest copy is unavailable');
    expect(warm.asset.encodedSize).toBe(bytes.byteLength);
    expect(warmManifest).toMatchObject({
      codec: 'adts-aac-lc',
      manifestByteLength: manifestBytes.byteLength,
    });
    expectBodyFree(warm);
    await expect(
      harness.engine.resolveWarmPeerRangeSource({
        sourceLease: warm.sourceLease,
        sourceIdentity: warm.asset.binding.sourceIdentity,
        peerRangeManifest: null,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(blob);
    const copiedWarmManifest = Object.freeze({ ...warmManifest });
    await expect(
      harness.engine.resolveWarmPeerRangeSource({
        sourceLease: warm.sourceLease,
        sourceIdentity: warm.asset.binding.sourceIdentity,
        peerRangeManifest: copiedWarmManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/exact issued authority/u);
    await expectBlobManifestBundle(
      await harness.engine.resolveWarmPeerRangeSource({
        sourceLease: warm.sourceLease,
        sourceIdentity: warm.asset.binding.sourceIdentity,
        peerRangeManifest: warmManifest,
        signal: new AbortController().signal,
      }),
      manifestBytes,
      bytes,
      warm.asset.binding.sourceIdentity,
    );

    const prepared = await harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q1, blob, 0),
    );
    const preparedManifest = prepared.asset.peerRangeManifest;
    if (!preparedManifest) throw new Error('Fixture expected a prepared manifest selector');
    expect(preparedManifest).toEqual(warmManifest);
    expect(preparedManifest).not.toBe(warmManifest);
    await expect(
      harness.engine.resolveWarmPeerRangeSource({
        sourceLease: warm.sourceLease,
        sourceIdentity: warm.asset.binding.sourceIdentity,
        peerRangeManifest: preparedManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/exact issued authority/u);
    await expect(
      harness.engine.resolvePreparedPeerRangeSource({
        prepared,
        sourceIdentity: prepared.asset.binding.sourceIdentity,
        peerRangeManifest: warmManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/exact issued authority/u);
    await expectBlobManifestBundle(
      await harness.engine.resolvePreparedPeerRangeSource({
        prepared,
        sourceIdentity: prepared.asset.binding.sourceIdentity,
        peerRangeManifest: preparedManifest,
        signal: new AbortController().signal,
      }),
      manifestBytes,
      bytes,
      prepared.asset.binding.sourceIdentity,
    );
    await resolveLatestStart(
      harness,
      harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] }),
    );

    expect(promotion).toHaveBeenCalledWith(ROOM_TOKEN, lease);
    expect(
      codecTimelineHostArtifactLeaseStore.describeCodecTimelineHostArtifactForLease(access),
    ).not.toBeNull();
    const publication = harness.engine.currentPeerPublication();
    const currentManifest = publication?.asset.peerRangeManifest;
    if (!publication || !currentManifest) {
      throw new Error('Fixture expected a current manifest publication');
    }
    expect(publication.asset.encodedSize).toBe(bytes.byteLength);
    expect(currentManifest).toEqual(preparedManifest);
    expect(currentManifest).not.toBe(preparedManifest);
    expectBodyFree(publication);
    await expect(
      harness.engine.resolveCurrentPeerRangeSource({
        publication,
        sourceIdentity: publication.asset.binding.sourceIdentity,
        peerRangeManifest: preparedManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/exact issued authority/u);
    await expectBlobManifestBundle(
      await harness.engine.resolveCurrentPeerRangeSource({
        publication,
        sourceIdentity: publication.asset.binding.sourceIdentity,
        peerRangeManifest: currentManifest,
        signal: new AbortController().signal,
      }),
      manifestBytes,
      bytes,
      publication.asset.binding.sourceIdentity,
    );
    await expect(
      harness.engine.resolveCurrentPeerRangeSource({
        publication,
        sourceIdentity: publication.asset.binding.sourceIdentity,
        peerRangeManifest: null,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(blob);
    manifestBytes.fill(0);
    await harness.engine.close();
    expect(
      codecTimelineHostArtifactLeaseStore.describeCodecTimelineHostArtifactForLease(access),
    ).toBeNull();
  });

  it('keeps a direct non-warm start on live admission without provisional promotion', async () => {
    const provisionalAdmission = vi.spyOn(
      FilePlaybackAssetRegistry.prototype,
      'admitProvisionalBlobAsset',
    );
    const liveAdmission = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'admitBlob');
    const promotion = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'promoteProvisionalAsset');
    const harness = makeHarness([{ backend: 'bounded-stream' }]);
    const blob = new Blob([new Uint8Array([54])], { type: 'audio/flac' });

    const pending = harness.start(blob);
    await resolveLatestStart(harness, pending);

    expect(liveAdmission).toHaveBeenCalledOnce();
    expect(provisionalAdmission).not.toHaveBeenCalled();
    expect(promotion).not.toHaveBeenCalled();
    await harness.engine.close();
  });

  it('reuses an exact live asset through repeat warm handoff without a second admission', async () => {
    const provisionalAdmission = vi.spyOn(
      FilePlaybackAssetRegistry.prototype,
      'admitProvisionalBlobAsset',
    );
    const liveAdmission = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'admitBlob');
    const promotion = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'promoteProvisionalAsset');
    const discard = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'discardProvisionalAsset');
    const harness = makeHarness([{ backend: 'bounded-stream' }, { backend: 'bounded-stream' }]);
    const blob = new Blob([new Uint8Array([55, 56])], { type: 'audio/flac' });

    await resolveLatestStart(harness, harness.start(blob));
    harness.setRoomTime(2_000);
    const warm = await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));
    const prepared = await harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q1, blob, 0),
    );
    expect(prepared.sourceLease).toBe(warm.sourceLease);
    await resolveLatestStart(
      harness,
      harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] }),
    );

    expect(liveAdmission).toHaveBeenCalledOnce();
    expect(provisionalAdmission).not.toHaveBeenCalled();
    expect(promotion).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    await harness.engine.close();
  });

  it('clears a live-backed warm renderer without retiring its registry asset', async () => {
    const provisionalAdmission = vi.spyOn(
      FilePlaybackAssetRegistry.prototype,
      'admitProvisionalBlobAsset',
    );
    const liveAdmission = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'admitBlob');
    const discard = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'discardProvisionalAsset');
    const harness = makeHarness([
      { backend: 'bounded-stream' },
      { backend: 'bounded-stream' },
      { backend: 'bounded-stream' },
    ]);
    const blob = new Blob([new Uint8Array([57, 58])], { type: 'audio/flac' });

    await resolveLatestStart(harness, harness.start(blob));
    harness.setRoomTime(2_000);
    await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));
    await expect(harness.engine.clearWarmLocalTrack({ queueItemId: Q1 })).resolves.toBe(true);
    expect(discard).not.toHaveBeenCalled();

    const prepared = await harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q1, blob, 0),
    );
    await resolveLatestStart(
      harness,
      harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] }),
    );
    expect(liveAdmission).toHaveBeenCalledOnce();
    expect(provisionalAdmission).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    await harness.engine.close();
  });

  it('discards skipped provisional ordinary warm assets before resolving', async () => {
    const provisionalAdmission = vi.spyOn(
      FilePlaybackAssetRegistry.prototype,
      'admitProvisionalBlobAsset',
    );
    const discard = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'discardProvisionalAsset');
    const harness = makeHarness([{ backend: 'audio-buffer' }]);
    const blob = new Blob([new Uint8Array([59])], { type: 'audio/mpeg' });

    await expect(
      harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob)),
    ).resolves.toMatchObject({ status: 'skipped-non-bounded' });
    expect(provisionalAdmission).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
    expect(discard.mock.calls[0]?.[1]).toBe(provisionalAdmission.mock.results[0]?.value);
    await harness.engine.close();
    expect(discard).toHaveBeenCalledOnce();
  });

  it('supports more than 128 identical provisional warm-clear cycles without tombstone exhaustion', async () => {
    const provisionalAdmission = vi.spyOn(
      FilePlaybackAssetRegistry.prototype,
      'admitProvisionalBlobAsset',
    );
    const discard = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'discardProvisionalAsset');
    const cycleCount = 130;
    const harness = makeHarness(
      Array.from({ length: cycleCount }, () => ({ backend: 'bounded-stream' as const })),
    );
    const blob = new Blob([new Uint8Array([60])], { type: 'audio/flac' });

    for (let index = 0; index < cycleCount; index += 1) {
      await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));
      await expect(harness.engine.clearWarmLocalTrack({ queueItemId: Q1 })).resolves.toBe(true);
    }

    expect(provisionalAdmission).toHaveBeenCalledTimes(cycleCount);
    expect(discard).toHaveBeenCalledTimes(cycleCount);
    expect(harness.fatal).not.toHaveBeenCalled();
    await harness.engine.close();
  });

  it('discards the exact provisional lease before admitting a replacement warm asset', async () => {
    const provisionalAdmission = vi.spyOn(
      FilePlaybackAssetRegistry.prototype,
      'admitProvisionalBlobAsset',
    );
    const discard = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'discardProvisionalAsset');
    const harness = makeHarness([{ backend: 'bounded-stream' }, { backend: 'bounded-stream' }]);
    const firstBlob = new Blob([new Uint8Array([62])], { type: 'audio/flac' });
    const replacementBlob = new Blob([new Uint8Array([63])], { type: 'audio/flac' });

    await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, firstBlob));
    await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q2, replacementBlob));

    expect(provisionalAdmission).toHaveBeenCalledTimes(2);
    expect(discard).toHaveBeenCalledOnce();
    expect(discard.mock.calls[0]?.[1]).toBe(provisionalAdmission.mock.results[0]?.value);
    await harness.engine.close();
    expect(discard).toHaveBeenCalledTimes(2);
    expect(discard.mock.calls[1]?.[1]).toBe(provisionalAdmission.mock.results[1]?.value);
  });

  it('discards a ready provisional warm asset exactly once when its caller aborts', async () => {
    const provisionalAdmission = vi.spyOn(
      FilePlaybackAssetRegistry.prototype,
      'admitProvisionalBlobAsset',
    );
    const discard = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'discardProvisionalAsset');
    const controller = new AbortController();
    const harness = makeHarness([{ backend: 'bounded-stream' }]);
    const blob = new Blob([new Uint8Array([64])], { type: 'audio/flac' });

    await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob, controller.signal));
    controller.abort(new Error('fixture ready warm abort'));
    await drainMicrotasks(128);

    expect(discard).toHaveBeenCalledOnce();
    expect(discard.mock.calls[0]?.[1]).toBe(provisionalAdmission.mock.results[0]?.value);
    await harness.engine.close();
    expect(discard).toHaveBeenCalledOnce();
  });

  it('revokes an installed artifact before clearing its provisional warm lease', async () => {
    const provisionalAdmission = vi.spyOn(
      FilePlaybackAssetRegistry.prototype,
      'admitProvisionalBlobAsset',
    );
    const discard = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'discardProvisionalAsset');
    const harness = makeHarness([{ backend: 'bounded-stream' }], {
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
    });
    const bytes = adtsFixtureFrame(38, 0x65);
    const blob = new Blob([bytes], { type: 'audio/aac' });

    await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));
    const lease = provisionalAdmission.mock.results[0]?.value;
    const registry = provisionalAdmission.mock.contexts[0] as FilePlaybackAssetRegistry;
    const access = await installFixtureHostArtifact(registry, lease!, bytes);

    await expect(harness.engine.clearWarmLocalTrack({ queueItemId: Q1 })).resolves.toBe(true);
    expect(discard).toHaveBeenCalledWith(ROOM_TOKEN, lease);
    expect(
      codecTimelineHostArtifactLeaseStore.describeCodecTimelineHostArtifactForLease(access),
    ).toBeNull();
    await harness.engine.close();
  });

  it('merges artifact revoke and provisional discard failures after attempting both', async () => {
    const harness = makeHarness([{ backend: 'bounded-stream' }], {
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
    });
    const blob = new Blob([adtsFixtureFrame(38, 0x75)], { type: 'audio/aac' });
    await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));
    const revokeFailure = new Error('fixture artifact revoke failed');
    const discardFailure = new Error('fixture provisional discard failed');
    const revoke = vi
      .spyOn(codecTimelineHostArtifactLeaseStore, 'revokeCodecTimelineHostArtifactForLease')
      .mockImplementation(() => {
        throw revokeFailure;
      });
    const discard = vi
      .spyOn(FilePlaybackAssetRegistry.prototype, 'discardProvisionalAsset')
      .mockRejectedValue(discardFailure);

    const cleanupError = await harness.engine.clearWarmLocalTrack({ queueItemId: Q1 }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(cleanupError).not.toBeNull();
    expect(errorTreeContains(cleanupError, revokeFailure)).toBe(true);
    expect(errorTreeContains(cleanupError, discardFailure)).toBe(true);
    expect(revoke).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();

    revoke.mockRestore();
    discard.mockRestore();
    await expect(harness.engine.close()).rejects.toThrow(/warm cleanup/u);
  });

  it('revokes an installed provisional artifact when source preparation fails', async () => {
    const prepareGate = deferred<void>();
    const provisionalAdmission = vi.spyOn(
      FilePlaybackAssetRegistry.prototype,
      'admitProvisionalBlobAsset',
    );
    const discard = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'discardProvisionalAsset');
    const harness = makeHarness([{ backend: 'bounded-stream', prepareGate }], {
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
    });
    const bytes = adtsFixtureFrame(39, 0x66);
    const blob = new Blob([bytes], { type: 'audio/aac' });
    const warming = harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));
    await drainMicrotasks();
    const lease = provisionalAdmission.mock.results[0]?.value;
    const registry = provisionalAdmission.mock.contexts[0] as FilePlaybackAssetRegistry;
    const access = await installFixtureHostArtifact(registry, lease!, bytes);

    prepareGate.reject(new Error('fixture warm preparation failed'));
    await expect(warming).rejects.toThrow('fixture warm preparation failed');
    expect(discard).toHaveBeenCalledWith(ROOM_TOKEN, lease);
    expect(
      codecTimelineHostArtifactLeaseStore.describeCodecTimelineHostArtifactForLease(access),
    ).toBeNull();
    await harness.engine.close();
  });

  it('revokes the superseded provisional artifact before admitting its replacement', async () => {
    const provisionalAdmission = vi.spyOn(
      FilePlaybackAssetRegistry.prototype,
      'admitProvisionalBlobAsset',
    );
    const harness = makeHarness([{ backend: 'bounded-stream' }, { backend: 'bounded-stream' }], {
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
    });
    const firstBytes = adtsFixtureFrame(40, 0x67);
    const firstBlob = new Blob([firstBytes], { type: 'audio/aac' });
    const secondBlob = new Blob([adtsFixtureFrame(41, 0x68)], { type: 'audio/aac' });

    await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, firstBlob));
    const firstLease = provisionalAdmission.mock.results[0]?.value;
    const registry = provisionalAdmission.mock.contexts[0] as FilePlaybackAssetRegistry;
    const access = await installFixtureHostArtifact(registry, firstLease!, firstBytes);
    await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q2, secondBlob));

    expect(provisionalAdmission).toHaveBeenCalledTimes(2);
    expect(
      codecTimelineHostArtifactLeaseStore.describeCodecTimelineHostArtifactForLease(access),
    ).toBeNull();
    await harness.engine.close();
  });

  it('coalesces failed candidate, abort, and close disposal of one claimed provisional lease', async () => {
    const provisionalAdmission = vi.spyOn(
      FilePlaybackAssetRegistry.prototype,
      'admitProvisionalBlobAsset',
    );
    const promotion = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'promoteProvisionalAsset');
    const discard = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'discardProvisionalAsset');
    const candidateAbort = new AbortController();
    const harness = makeHarness([{ backend: 'bounded-stream', rejectArm: true }]);
    const blob = new Blob([new Uint8Array([61])], { type: 'audio/flac' });

    await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));
    const prepared = await harness.engine.prepareLocalTrack({
      ...localTrackOptions(harness, Q1, blob, 0),
      signal: candidateAbort.signal,
    });
    const failed = harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] });
    candidateAbort.abort(new Error('fixture candidate abort raced failure'));
    const closing = harness.engine.close();

    await expect(failed).rejects.toThrow();
    await closing;
    expect(provisionalAdmission).toHaveBeenCalledOnce();
    expect(promotion).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledOnce();
    expect(discard.mock.calls[0]?.[1]).toBe(provisionalAdmission.mock.results[0]?.value);
    expect(harness.fatal).not.toHaveBeenCalled();
  });

  it('does not retain an AudioBuffer warm result and falls back to the ordinary cold path', async () => {
    const harness = makeHarness([{ backend: 'audio-buffer' }, { backend: 'audio-buffer' }]);
    const blob = new Blob([new Uint8Array([4, 5, 6])], { type: 'audio/mpeg' });

    const warm = await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));
    expect(warm).toMatchObject({ status: 'skipped-non-bounded', backend: 'audio-buffer' });
    expect(warm.sourceLease).toBeNull();
    expect(harness.sources[0]?.destroy).toHaveBeenCalledOnce();
    expect(harness.sources[0]?.releaseConstructionLease).toHaveBeenCalledOnce();
    expect(harness.manager.currentCutoverPort()).toBeNull();
    expect(harness.createRunId).not.toHaveBeenCalled();

    const prepared = await harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q1, blob, 0),
    );
    expect(prepared.backend).toBe('audio-buffer');
    expect(prepared.sourceLease).toBeNull();
    expect(harness.sources).toHaveLength(2);
    expect(harness.stageRequests).toHaveLength(1);
    const pending = harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] });
    await resolveLatestStart(harness, pending);
    await harness.engine.close();
  });

  it('clears only the matching provisional warm renderer and permits a fresh cold admission', async () => {
    const harness = makeHarness([{ backend: 'bounded-stream' }, { backend: 'bounded-stream' }]);
    const blob = new Blob([new Uint8Array([6, 7])], { type: 'audio/flac' });
    await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));

    await expect(harness.engine.clearWarmLocalTrack({ queueItemId: Q2 })).resolves.toBe(false);
    expect(harness.sources[0]?.destroy).not.toHaveBeenCalled();
    await expect(harness.engine.clearWarmLocalTrack({ queueItemId: Q1 })).resolves.toBe(true);
    expect(harness.sources[0]?.destroy).toHaveBeenCalledOnce();
    expect(harness.sources[0]?.releaseConstructionLease).toHaveBeenCalledOnce();
    await expect(harness.engine.clearWarmLocalTrack({ queueItemId: Q1 })).resolves.toBe(false);

    const prepared = await harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q1, blob, 0),
    );
    expect(prepared.backend).toBe('bounded-stream');
    expect(harness.sources).toHaveLength(2);
    const pending = harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] });
    await resolveLatestStart(harness, pending);
    await harness.engine.close();
  });

  it('resolves only the exact live warm lease and preserves it across prepared handoff', async () => {
    const harness = makeHarness([{ backend: 'bounded-stream' }]);
    const blob = new Blob([new Uint8Array([31, 32, 33])], { type: 'audio/flac' });
    const warm = await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));
    const sourceLease = warm.sourceLease;
    if (!sourceLease) throw new Error('Fixture expected a bounded warm source lease');

    const aborted = new AbortController();
    const abortedResolution = harness.engine.resolveWarmPeerRangeSource({
      sourceLease,
      sourceIdentity: warm.asset.binding.sourceIdentity,
      peerRangeManifest: warm.asset.peerRangeManifest,
      signal: aborted.signal,
    });
    aborted.abort(new Error('fixture warm resolution abort'));
    await expect(abortedResolution).rejects.toThrow(/fixture warm resolution abort/u);
    await expect(
      harness.engine.resolveWarmPeerRangeSource({
        sourceLease,
        sourceIdentity: `${warm.asset.binding.sourceIdentity}:wrong`,
        peerRangeManifest: warm.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/not the exact lease/u);
    await expect(
      harness.engine.resolveWarmPeerRangeSource({
        sourceLease,
        sourceIdentity: warm.asset.binding.sourceIdentity,
        peerRangeManifest: warm.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(blob);

    const prepared = await harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q1, blob, 0),
    );
    expect(prepared.sourceLease).toBe(sourceLease);
    await expect(
      harness.engine.resolveWarmPeerRangeSource({
        sourceLease,
        sourceIdentity: warm.asset.binding.sourceIdentity,
        peerRangeManifest: warm.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(blob);

    const pending = harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] });
    await drainMicrotasks();
    expect(harness.controller.timelineSnapshot()).toMatchObject({
      phase: 'playing',
      run: { queueItemId: Q1 },
    });
    await expect(
      harness.engine.resolveWarmPeerRangeSource({
        sourceLease,
        sourceIdentity: warm.asset.binding.sourceIdentity,
        peerRangeManifest: warm.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(blob);
    await expect(
      harness.engine.resolvePreparedPeerRangeSource({
        prepared,
        sourceIdentity: prepared.asset.binding.sourceIdentity,
        peerRangeManifest: prepared.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(blob);
    await resolveLatestStart(harness, pending);
    await expect(
      harness.engine.resolveWarmPeerRangeSource({
        sourceLease,
        sourceIdentity: warm.asset.binding.sourceIdentity,
        peerRangeManifest: warm.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(blob);
    await expect(
      harness.engine.resolvePreparedPeerRangeSource({
        prepared,
        sourceIdentity: prepared.asset.binding.sourceIdentity,
        peerRangeManifest: prepared.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(blob);
    await harness.engine.close();
    await expect(
      harness.engine.resolveWarmPeerRangeSource({
        sourceLease,
        sourceIdentity: warm.asset.binding.sourceIdentity,
        peerRangeManifest: warm.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/authority|retired|stale/u);
    await expect(
      harness.engine.resolvePreparedPeerRangeSource({
        prepared,
        sourceIdentity: prepared.asset.binding.sourceIdentity,
        peerRangeManifest: prepared.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/authority|retired|stale/u);
  });

  it('retires both source resolvers when a prepared candidate aborts before start', async () => {
    const harness = makeHarness([{ backend: 'bounded-stream' }]);
    const blob = new Blob([new Uint8Array([37, 38])], { type: 'audio/flac' });
    const warm = await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));
    const sourceLease = warm.sourceLease;
    if (!sourceLease) throw new Error('Fixture expected a bounded warm source lease');
    const candidateAbort = new AbortController();
    const prepared = await harness.engine.prepareLocalTrack({
      ...localTrackOptions(harness, Q1, blob, 0),
      signal: candidateAbort.signal,
    });

    candidateAbort.abort(new Error('fixture prepared candidate aborted'));
    await expect(
      harness.engine.resolveWarmPeerRangeSource({
        sourceLease,
        sourceIdentity: warm.asset.binding.sourceIdentity,
        peerRangeManifest: warm.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/authority|retired|stale/u);
    await expect(
      harness.engine.resolvePreparedPeerRangeSource({
        prepared,
        sourceIdentity: prepared.asset.binding.sourceIdentity,
        peerRangeManifest: prepared.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/authority|retired|stale/u);
    await harness.engine.close();
  });

  it('retires a failed candidate pair while preserving both exact current resolvers', async () => {
    const harness = makeHarness([
      { backend: 'bounded-stream' },
      { backend: 'bounded-stream', rejectArm: true },
    ]);
    const currentBlob = new Blob([new Uint8Array([39, 40])], { type: 'audio/flac' });
    const currentWarm = await harness.engine.warmLocalTrack(
      warmTrackOptions(harness, Q1, currentBlob),
    );
    const currentLease = currentWarm.sourceLease;
    if (!currentLease) throw new Error('Fixture expected a bounded current source lease');
    const currentPrepared = await harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q1, currentBlob, 0),
    );
    await resolveLatestStart(
      harness,
      harness.engine.startPreparedLocalTrack({
        prepared: currentPrepared,
        remoteParticipants: [],
      }),
    );

    const failedBlob = new Blob([new Uint8Array([47, 48])], { type: 'audio/flac' });
    const failedWarm = await harness.engine.warmLocalTrack(
      warmTrackOptions(harness, Q2, failedBlob),
    );
    const failedLease = failedWarm.sourceLease;
    if (!failedLease) throw new Error('Fixture expected a bounded failed source lease');
    const failedPrepared = await harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q2, failedBlob, 0),
    );
    const pending = harness.engine.startPreparedLocalTrack({
      prepared: failedPrepared,
      remoteParticipants: [],
    });

    await expect(pending).rejects.toThrow(/cutover-manager-arm-failed|fixture arm rejection/u);
    await expect(
      harness.engine.resolveWarmPeerRangeSource({
        sourceLease: failedLease,
        sourceIdentity: failedWarm.asset.binding.sourceIdentity,
        peerRangeManifest: failedWarm.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/authority|retired|stale/u);
    await expect(
      harness.engine.resolvePreparedPeerRangeSource({
        prepared: failedPrepared,
        sourceIdentity: failedPrepared.asset.binding.sourceIdentity,
        peerRangeManifest: failedPrepared.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/authority|retired|stale/u);
    await expect(
      harness.engine.resolveWarmPeerRangeSource({
        sourceLease: currentLease,
        sourceIdentity: currentWarm.asset.binding.sourceIdentity,
        peerRangeManifest: currentWarm.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(currentBlob);
    await expect(
      harness.engine.resolvePreparedPeerRangeSource({
        prepared: currentPrepared,
        sourceIdentity: currentPrepared.asset.binding.sourceIdentity,
        peerRangeManifest: currentPrepared.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(currentBlob);
    await harness.engine.close();
  });

  it('keeps both current resolvers through next-track preparation and retires them at commit', async () => {
    const harness = makeHarness([{ backend: 'bounded-stream' }, { backend: 'bounded-stream' }]);
    const blob = new Blob([new Uint8Array([41, 42])], { type: 'audio/flac' });
    const warm = await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));
    const sourceLease = warm.sourceLease;
    if (!sourceLease) throw new Error('Fixture expected a bounded warm source lease');
    const prepared = await harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q1, blob, 0),
    );
    await resolveLatestStart(
      harness,
      harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] }),
    );
    harness.setRoomTime(2_000);

    const nextBlob = new Blob([new Uint8Array([43, 44])], { type: 'audio/flac' });
    const nextPreparation = harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q2, nextBlob, 0),
    );
    await expect(
      harness.engine.resolveWarmPeerRangeSource({
        sourceLease,
        sourceIdentity: warm.asset.binding.sourceIdentity,
        peerRangeManifest: warm.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(blob);
    const nextPrepared = await nextPreparation;
    await expect(
      harness.engine.resolvePreparedPeerRangeSource({
        prepared,
        sourceIdentity: prepared.asset.binding.sourceIdentity,
        peerRangeManifest: prepared.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(blob);
    await expect(
      harness.engine.resolvePreparedPeerRangeSource({
        prepared: nextPrepared,
        sourceIdentity: nextPrepared.asset.binding.sourceIdentity,
        peerRangeManifest: nextPrepared.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(nextBlob);

    const nextStart = harness.engine.startPreparedLocalTrack({
      prepared: nextPrepared,
      remoteParticipants: [],
    });
    await drainMicrotasks();
    expect(harness.controller.timelineSnapshot()).toMatchObject({
      phase: 'playing',
      run: { queueItemId: Q2 },
    });
    await expect(
      harness.engine.resolveWarmPeerRangeSource({
        sourceLease,
        sourceIdentity: warm.asset.binding.sourceIdentity,
        peerRangeManifest: warm.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/authority|retired|stale/u);
    await expect(
      harness.engine.resolvePreparedPeerRangeSource({
        prepared,
        sourceIdentity: prepared.asset.binding.sourceIdentity,
        peerRangeManifest: prepared.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/authority|retired|stale/u);
    await expect(
      harness.engine.resolvePreparedPeerRangeSource({
        prepared: nextPrepared,
        sourceIdentity: nextPrepared.asset.binding.sourceIdentity,
        peerRangeManifest: nextPrepared.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(nextBlob);
    await resolveLatestStart(harness, nextStart);
    await expect(
      harness.engine.resolvePreparedPeerRangeSource({
        prepared: nextPrepared,
        sourceIdentity: nextPrepared.asset.binding.sourceIdentity,
        peerRangeManifest: nextPrepared.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(nextBlob);
    await harness.engine.close();
  });

  it('keeps both current resolvers through a future stop and retires them after commit', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness([{ backend: 'bounded-stream' }]);
      const blob = new Blob([new Uint8Array([45, 46])], { type: 'audio/flac' });
      const warm = await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));
      const sourceLease = warm.sourceLease;
      if (!sourceLease) throw new Error('Fixture expected a bounded warm source lease');
      const prepared = await harness.engine.prepareLocalTrack(
        localTrackOptions(harness, Q1, blob, 0),
      );
      await resolveLatestStart(
        harness,
        harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] }),
      );
      harness.setRoomTime(2_000);

      const stopping = harness.engine.stopCurrent({ signal: new AbortController().signal });
      await drainMicrotasks();
      await expect(
        harness.engine.resolveWarmPeerRangeSource({
          sourceLease,
          sourceIdentity: warm.asset.binding.sourceIdentity,
          peerRangeManifest: warm.asset.peerRangeManifest,
          signal: new AbortController().signal,
        }),
      ).resolves.toBe(blob);
      await expect(
        harness.engine.resolvePreparedPeerRangeSource({
          prepared,
          sourceIdentity: prepared.asset.binding.sourceIdentity,
          peerRangeManifest: prepared.asset.peerRangeManifest,
          signal: new AbortController().signal,
        }),
      ).resolves.toBe(blob);

      harness.context.currentTime = 10;
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(stopping).resolves.toMatchObject({
        kind: 'stop',
        timeline: { phase: 'stopped', run: null },
      });
      await expect(
        harness.engine.resolveWarmPeerRangeSource({
          sourceLease,
          sourceIdentity: warm.asset.binding.sourceIdentity,
          peerRangeManifest: warm.asset.peerRangeManifest,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/authority|retired|stale/u);
      await expect(
        harness.engine.resolvePreparedPeerRangeSource({
          prepared,
          sourceIdentity: prepared.asset.binding.sourceIdentity,
          peerRangeManifest: prepared.asset.peerRangeManifest,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/authority|retired|stale/u);
      await harness.engine.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['stop', 'ended'] as const)(
    'preserves both current resolvers when %s fails before its manager commit',
    async (action) => {
      const harness = makeHarness([{ backend: 'bounded-stream' }], {
        beforeManagerTransition: () => {
          throw new Error('fixture transition failed before manager commit');
        },
      });
      const blob = new Blob([new Uint8Array([49, 50])], { type: 'audio/flac' });
      const warm = await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));
      const sourceLease = warm.sourceLease;
      if (!sourceLease) throw new Error('Fixture expected a bounded warm source lease');
      const prepared = await harness.engine.prepareLocalTrack(
        localTrackOptions(harness, Q1, blob, 0),
      );
      await resolveLatestStart(
        harness,
        harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] }),
      );
      if (action === 'ended') harness.sources[0]?.markEnded();
      harness.setRoomTime(2_000);

      const transition =
        action === 'stop'
          ? harness.engine.stopCurrent({ signal: new AbortController().signal })
          : harness.engine.settleEndedCurrent({ signal: new AbortController().signal });
      await expect(transition).rejects.toThrow(/fixture transition failed before manager commit/u);
      await expect(
        harness.engine.resolveWarmPeerRangeSource({
          sourceLease,
          sourceIdentity: warm.asset.binding.sourceIdentity,
          peerRangeManifest: warm.asset.peerRangeManifest,
          signal: new AbortController().signal,
        }),
      ).resolves.toBe(blob);
      await expect(
        harness.engine.resolvePreparedPeerRangeSource({
          prepared,
          sourceIdentity: prepared.asset.binding.sourceIdentity,
          peerRangeManifest: prepared.asset.peerRangeManifest,
          signal: new AbortController().signal,
        }),
      ).resolves.toBe(blob);
      await harness.engine.close();
    },
  );

  it('retires both current resolvers after a successful ended commit', async () => {
    const harness = makeHarness([{ backend: 'bounded-stream' }]);
    const blob = new Blob([new Uint8Array([51, 52])], { type: 'audio/flac' });
    const warm = await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));
    const sourceLease = warm.sourceLease;
    if (!sourceLease) throw new Error('Fixture expected a bounded warm source lease');
    const prepared = await harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q1, blob, 0),
    );
    await resolveLatestStart(
      harness,
      harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] }),
    );
    harness.sources[0]?.markEnded();
    harness.setRoomTime(2_000);

    await expect(
      harness.engine.settleEndedCurrent({ signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      kind: 'ended',
      timeline: { phase: 'stopped', run: null },
    });
    await expect(
      harness.engine.resolveWarmPeerRangeSource({
        sourceLease,
        sourceIdentity: warm.asset.binding.sourceIdentity,
        peerRangeManifest: warm.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/authority|retired|stale/u);
    await expect(
      harness.engine.resolvePreparedPeerRangeSource({
        prepared,
        sourceIdentity: prepared.asset.binding.sourceIdentity,
        peerRangeManifest: prepared.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/authority|retired|stale/u);
    await harness.engine.close();
  });

  it('rejects copied, cross-engine, and stale warm leases without queue-ID ABA', async () => {
    const firstHarness = makeHarness([
      { backend: 'bounded-stream' },
      { backend: 'bounded-stream' },
    ]);
    const secondHarness = makeHarness([{ backend: 'bounded-stream' }]);
    const firstBlob = new Blob([new Uint8Array([34])], { type: 'audio/flac' });
    const otherBlob = new Blob([new Uint8Array([36])], { type: 'audio/flac' });
    const first = await firstHarness.engine.warmLocalTrack(
      warmTrackOptions(firstHarness, Q1, firstBlob),
    );
    const other = await secondHarness.engine.warmLocalTrack(
      warmTrackOptions(secondHarness, Q1, otherBlob),
    );
    const firstLease = first.sourceLease;
    const otherLease = other.sourceLease;
    if (!firstLease || !otherLease) throw new Error('Fixture expected bounded warm leases');
    const copiedLease = Object.freeze({ ...firstLease }) as unknown as typeof firstLease;

    await expect(
      firstHarness.engine.resolveWarmPeerRangeSource({
        sourceLease: copiedLease,
        sourceIdentity: first.asset.binding.sourceIdentity,
        peerRangeManifest: first.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/exact issued authority/u);
    await expect(
      secondHarness.engine.resolveWarmPeerRangeSource({
        sourceLease: firstLease,
        sourceIdentity: first.asset.binding.sourceIdentity,
        peerRangeManifest: first.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/exact issued authority/u);

    const replacement = await firstHarness.engine.warmLocalTrack(
      warmTrackOptions(firstHarness, Q1, firstBlob),
    );
    const replacementLease = replacement.sourceLease;
    if (!replacementLease) throw new Error('Fixture expected a replacement warm lease');
    await expect(
      firstHarness.engine.clearWarmLocalTrack({ sourceLease: firstLease }),
    ).resolves.toBe(false);
    await expect(
      firstHarness.engine.resolveWarmPeerRangeSource({
        sourceLease: firstLease,
        sourceIdentity: first.asset.binding.sourceIdentity,
        peerRangeManifest: first.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/superseded|authority|cleared/u);
    await expect(
      firstHarness.engine.resolveWarmPeerRangeSource({
        sourceLease: replacementLease,
        sourceIdentity: replacement.asset.binding.sourceIdentity,
        peerRangeManifest: replacement.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(firstBlob);
    await expect(
      firstHarness.engine.clearWarmLocalTrack({
        sourceLease: Object.freeze({ ...replacementLease }) as unknown as typeof replacementLease,
      }),
    ).resolves.toBe(false);
    await expect(
      firstHarness.engine.clearWarmLocalTrack({ sourceLease: replacementLease }),
    ).resolves.toBe(true);
    await expect(
      firstHarness.engine.resolveWarmPeerRangeSource({
        sourceLease: replacementLease,
        sourceIdentity: replacement.asset.binding.sourceIdentity,
        peerRangeManifest: replacement.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/superseded|authority|cleared/u);

    await firstHarness.engine.close();
    await secondHarness.engine.close();
  });

  it('keeps the caller AbortSignal authoritative until a ready warm source is consumed', async () => {
    const harness = makeHarness([{ backend: 'bounded-stream' }, { backend: 'bounded-stream' }]);
    const controller = new AbortController();
    const blob = new Blob([new Uint8Array([16, 17])], { type: 'audio/flac' });
    await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob, controller.signal));

    controller.abort(new Error('fixture ready warm cancelled'));
    await drainMicrotasks(128);
    expect(harness.sources[0]?.destroy).toHaveBeenCalledOnce();
    expect(harness.sources[0]?.releaseConstructionLease).toHaveBeenCalledOnce();
    await expect(harness.engine.clearWarmLocalTrack({ queueItemId: Q1 })).resolves.toBe(false);

    const prepared = await harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q1, blob, 0),
    );
    expect(prepared.backend).toBe('bounded-stream');
    expect(harness.sources).toHaveLength(2);
    expect(harness.stageRequests).toHaveLength(1);
    const pending = harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] });
    await resolveLatestStart(harness, pending);
    await harness.engine.close();
  });

  it('quarantines the room when detached ready-abort cleanup cannot prove destruction', async () => {
    const cleanupError = new Error('fixture detached warm destroy failed');
    const harness = makeHarness([{ backend: 'bounded-stream', destroyError: cleanupError }]);
    const controller = new AbortController();
    const blob = new Blob([new Uint8Array([25])], { type: 'audio/flac' });
    await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob, controller.signal));

    controller.abort(new Error('fixture detached cancellation'));
    await drainMicrotasks(256);

    expect(harness.sources[0]?.destroy).toHaveBeenCalledOnce();
    expect(harness.sources[0]?.releaseConstructionLease).toHaveBeenCalledOnce();
    await expect(harness.engine.close()).rejects.toThrow(/warm|cleanup/u);
    await drainMicrotasks();
    expect(harness.fatal).toHaveBeenCalledOnce();
  });

  it('lets an exact clear win before claim and cold-falls back instead of using stale warm authority', async () => {
    const harness = makeHarness([{ backend: 'bounded-stream' }, { backend: 'bounded-stream' }]);
    const blob = new Blob([new Uint8Array([18])], { type: 'audio/flac' });
    await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));

    const preparing = harness.engine.prepareLocalTrack(localTrackOptions(harness, Q1, blob, 0));
    const clearing = harness.engine.clearWarmLocalTrack({ queueItemId: Q1 });
    await expect(clearing).resolves.toBe(true);
    const prepared = await preparing;

    expect(harness.sources[0]?.destroy).toHaveBeenCalledOnce();
    expect(harness.sources).toHaveLength(2);
    expect(harness.stageRequests).toHaveLength(1);
    const pending = harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] });
    await resolveLatestStart(harness, pending);
    await harness.engine.close();
  });

  it('serializes a new warm source behind an exact claimed-source manager handoff', async () => {
    const handoffGate = deferred<void>();
    const harness = makeHarness([
      { backend: 'bounded-stream', holdAfterStage: handoffGate },
      { backend: 'bounded-stream' },
    ]);
    const firstBlob = new Blob([new Uint8Array([19])], { type: 'audio/flac' });
    const secondBlob = new Blob([new Uint8Array([20])], { type: 'audio/flac' });
    await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, firstBlob));

    const preparing = harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q1, firstBlob, 0),
    );
    await drainMicrotasks(128);
    expect(harness.sources[0]?.source.getSnapshot().phase).toBe('connected');

    const nextWarm = harness.engine.warmLocalTrack(warmTrackOptions(harness, Q2, secondBlob));
    await drainMicrotasks(128);
    expect(harness.sources).toHaveLength(1);

    handoffGate.resolve();
    await expect(preparing).resolves.toMatchObject({ backend: 'bounded-stream' });
    await expect(nextWarm).resolves.toMatchObject({
      status: 'warmed',
      asset: { binding: { queueItemId: Q2 } },
    });
    expect(harness.sources).toHaveLength(2);
    await harness.engine.close();
    expect(harness.sources[0]?.destroy).toHaveBeenCalledOnce();
    expect(harness.sources[1]?.destroy).toHaveBeenCalledOnce();
  });

  it('shares one exact warm cleanup failure between concurrent clear and close', async () => {
    const destroyGate = deferred<void>();
    const cleanupError = new Error('fixture warm destroy failed');
    const harness = makeHarness([
      { backend: 'bounded-stream', destroyGate, destroyError: cleanupError },
    ]);
    const blob = new Blob([new Uint8Array([21])], { type: 'audio/flac' });
    await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));

    const clearing = harness.engine.clearWarmLocalTrack({ queueItemId: Q1 });
    await drainMicrotasks();
    expect(harness.sources[0]?.destroy).toHaveBeenCalledOnce();
    const closing = harness.engine.close();
    destroyGate.resolve();

    await expect(clearing).rejects.toThrow(/warm retirement failed/u);
    await expect(closing).rejects.toThrow(/warm cleanup did not complete safely/u);
    expect(harness.sources[0]?.destroy).toHaveBeenCalledOnce();
    expect(harness.sources[0]?.releaseConstructionLease).toHaveBeenCalledOnce();
  });

  it('hard-blocks future renderer admission and later close after an observed clear failure', async () => {
    const cleanupError = new Error('fixture observed clear destroy failed');
    const harness = makeHarness([{ backend: 'bounded-stream', destroyError: cleanupError }]);
    const blob = new Blob([new Uint8Array([26])], { type: 'audio/flac' });
    await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));

    await expect(harness.engine.clearWarmLocalTrack({ queueItemId: Q1 })).rejects.toThrow(
      /warm retirement failed/u,
    );
    await expect(
      harness.engine.prepareLocalTrack(localTrackOptions(harness, Q1, blob, 0)),
    ).rejects.toThrow(/warm retirement failed/u);
    expect(harness.sources).toHaveLength(1);
    expect(harness.stageRequests).toHaveLength(0);
    await expect(harness.engine.close()).rejects.toThrow(/warm cleanup did not complete safely/u);
  });

  it('classifies non-bounded destroy failure as mandatory cleanup for a racing close', async () => {
    const destroyGate = deferred<void>();
    const cleanupError = new Error('fixture non-bounded destroy failed');
    const harness = makeHarness([
      { backend: 'audio-buffer', destroyGate, destroyError: cleanupError },
    ]);
    const blob = new Blob([new Uint8Array([22])], { type: 'audio/mpeg' });

    const warming = harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));
    await drainMicrotasks(128);
    expect(harness.sources[0]?.destroy).toHaveBeenCalledOnce();
    const closing = harness.engine.close();
    destroyGate.resolve();

    await expect(warming).rejects.toThrow(/non-bounded warm source cleanup failed/u);
    await expect(closing).rejects.toThrow(/warm cleanup did not complete safely/u);
    expect(harness.sources[0]?.destroy).toHaveBeenCalledOnce();
    expect(harness.sources[0]?.releaseConstructionLease).toHaveBeenCalledOnce();
  });

  it('retains a settled non-bounded cleanup failure for later admission and close', async () => {
    const cleanupError = new Error('fixture settled non-bounded destroy failed');
    const harness = makeHarness([{ backend: 'audio-buffer', destroyError: cleanupError }]);
    const blob = new Blob([new Uint8Array([27])], { type: 'audio/mpeg' });

    await expect(
      harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob)),
    ).rejects.toThrow(/non-bounded warm source cleanup failed/u);
    await expect(
      harness.engine.prepareLocalTrack(localTrackOptions(harness, Q1, blob, 0)),
    ).rejects.toThrow(/non-bounded warm source cleanup failed/u);
    expect(harness.sources).toHaveLength(1);
    expect(harness.stageRequests).toHaveLength(0);
    await expect(harness.engine.close()).rejects.toThrow(/warm cleanup did not complete safely/u);
  });

  it('waits for an abort-resistant mismatched warm cleanup before cold construction', async () => {
    const prepareGate = deferred<void>();
    const harness = makeHarness([
      { backend: 'bounded-stream', prepareGate },
      { backend: 'audio-buffer' },
    ]);
    const warmBlob = new Blob([new Uint8Array([23])], { type: 'audio/flac' });
    const requestedBlob = new Blob([new Uint8Array([24])], { type: 'audio/mpeg' });
    const warming = harness.engine.warmLocalTrack(warmTrackOptions(harness, Q2, warmBlob));
    await drainMicrotasks();

    const preparing = harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q1, requestedBlob, 0),
    );
    await drainMicrotasks(128);
    expect(harness.sources).toHaveLength(1);
    expect(harness.stageRequests).toHaveLength(0);

    prepareGate.resolve();
    await expect(warming).rejects.toThrow(/replaced|superseded/u);
    const prepared = await preparing;
    expect(prepared.backend).toBe('audio-buffer');
    expect(harness.sources).toHaveLength(2);
    expect(harness.stageRequests).toHaveLength(1);
    const pending = harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] });
    await resolveLatestStart(harness, pending);
    await harness.engine.close();
  });

  it('fully retires a late superseded warm source before constructing its replacement', async () => {
    const firstPrepare = deferred<void>();
    const harness = makeHarness([
      { backend: 'bounded-stream', prepareGate: firstPrepare },
      { backend: 'bounded-stream' },
    ]);
    const firstBlob = new Blob([new Uint8Array([7])], { type: 'audio/flac' });
    const secondBlob = new Blob([new Uint8Array([8])], { type: 'audio/flac' });

    const first = harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, firstBlob));
    await drainMicrotasks();
    expect(harness.sources).toHaveLength(1);
    expect(harness.sources[0]?.source.getSnapshot().phase).toBe('preparing');

    const second = harness.engine.warmLocalTrack(warmTrackOptions(harness, Q2, secondBlob));
    await drainMicrotasks();
    expect(harness.sources).toHaveLength(1);

    firstPrepare.resolve();
    await expect(first).rejects.toThrow(/superseded/u);
    await expect(second).resolves.toMatchObject({
      status: 'warmed',
      asset: { binding: { queueItemId: Q2 } },
    });
    expect(harness.sources).toHaveLength(2);
    expect(harness.sources[0]?.destroy).toHaveBeenCalledOnce();
    expect(harness.sources[0]?.releaseConstructionLease).toHaveBeenCalledOnce();
    expect(harness.sources[1]?.source.getSnapshot().phase).toBe('ready');
    await harness.engine.close();
    expect(harness.sources[1]?.destroy).toHaveBeenCalledOnce();
    expect(harness.sources[1]?.releaseConstructionLease).toHaveBeenCalledOnce();
  });

  it('keeps a next-track warm source across current pause and binds the latest exact revision', async () => {
    const harness = makeHarness([{ backend: 'audio-buffer' }, { backend: 'bounded-stream' }]);
    const currentBlob = new Blob([new Uint8Array([9])], { type: 'audio/mpeg' });
    const nextBlob = new Blob([new Uint8Array([10])], { type: 'audio/flac' });
    await resolveLatestStart(harness, harness.start(currentBlob, { name: 'current.mp3' }));

    await expect(
      harness.engine.warmLocalTrack(warmTrackOptions(harness, Q2, nextBlob)),
    ).resolves.toMatchObject({ status: 'warmed' });
    const paused = await pauseCurrent(harness);
    expect(paused).toMatchObject({ phase: 'paused', revision: 2 });
    harness.setRoomTime(paused.anchorMonotonicMs);
    expect(harness.sources[1]?.source.getSnapshot().phase).toBe('ready');

    const prepared = await harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q2, nextBlob, 0),
    );
    expect(prepared).toMatchObject({
      backend: 'bounded-stream',
      state: { queueItemId: Q2, runId: RUN_2, revision: 3 },
    });
    expect(harness.sources).toHaveLength(2);
    expect(harness.sources[1]?.prepare).toHaveBeenCalledOnce();
    const pending = harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] });
    await resolveLatestStart(harness, pending);
    await harness.engine.close();
  });

  it('does not consume or retire a next-track warm source while resuming the current run', async () => {
    const harness = makeHarness([
      { backend: 'audio-buffer' },
      { backend: 'bounded-stream' },
      { backend: 'audio-buffer' },
    ]);
    const currentBlob = new Blob([new Uint8Array([14])], { type: 'audio/mpeg' });
    const nextBlob = new Blob([new Uint8Array([15])], { type: 'audio/flac' });
    await resolveLatestStart(harness, harness.start(currentBlob, { name: 'current.mp3' }));
    await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q2, nextBlob));
    const warmSource = harness.sources[1]!;

    harness.setRoomTime(2_000);
    const pausing = harness.engine.pauseCurrent({ signal: new AbortController().signal });
    await drainMicrotasks();
    harness.sources[0]?.resolvePause();
    const paused = await pausing;
    harness.setRoomTime(paused.timeline.anchorMonotonicMs);

    const resumed = await resolveLatestStart(
      harness,
      harness.engine.resumeCurrent({ signal: new AbortController().signal }),
    );
    expect(resumed.timeline).toMatchObject({ phase: 'playing', revision: 3 });
    expect(warmSource.destroy).not.toHaveBeenCalled();
    expect(warmSource.source.getSnapshot().phase).toBe('ready');
    harness.setRoomTime(resumed.timeline.anchorMonotonicMs);

    const prepared = await harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q2, nextBlob, 0),
    );
    expect(prepared).toMatchObject({
      state: { queueItemId: Q2, runId: RUN_2, revision: 4 },
      backend: 'bounded-stream',
    });
    expect(harness.sources).toHaveLength(3);
    expect(warmSource.prepare).toHaveBeenCalledOnce();
    const pending = harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] });
    await drainMicrotasks();
    expect(warmSource.arm).toHaveBeenCalledOnce();
    expect(warmSource.finalize).toHaveBeenCalledOnce();
    harness.context.currentTime = warmSource.startAtContextTime()!;
    warmSource.resolveStart();
    await expect(pending).resolves.toMatchObject({ timeline: { revision: 4 } });
    await harness.engine.close();
  });

  it('retires a different ready warm source before cold-staging the requested track', async () => {
    const harness = makeHarness([{ backend: 'bounded-stream' }, { backend: 'audio-buffer' }]);
    const warmBlob = new Blob([new Uint8Array([11])], { type: 'audio/flac' });
    const requestedBlob = new Blob([new Uint8Array([12])], { type: 'audio/mpeg' });
    await harness.engine.warmLocalTrack(warmTrackOptions(harness, Q2, warmBlob));

    const prepared = await harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q1, requestedBlob, 0),
    );
    expect(harness.sources[0]?.destroy).toHaveBeenCalledOnce();
    expect(harness.sources[0]?.releaseConstructionLease).toHaveBeenCalledOnce();
    expect(prepared.backend).toBe('audio-buffer');
    expect(harness.sources).toHaveLength(2);
    expect(harness.stageRequests).toHaveLength(1);
    const pending = harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] });
    await resolveLatestStart(harness, pending);
    await harness.engine.close();
  });

  it.each(['preparing', 'ready'] as const)(
    'joins and retires a %s warm source before terminal registry cleanup',
    async (phase) => {
      const prepareGate = phase === 'preparing' ? deferred<void>() : undefined;
      const harness = makeHarness([
        { backend: 'bounded-stream', ...(prepareGate ? { prepareGate } : {}) },
      ]);
      const blob = new Blob([new Uint8Array([13])], { type: 'audio/flac' });
      const warm = harness.engine.warmLocalTrack(warmTrackOptions(harness, Q1, blob));
      if (phase === 'ready') {
        await warm;
      } else {
        await drainMicrotasks();
        expect(harness.sources[0]?.source.getSnapshot().phase).toBe('preparing');
      }

      const firstClose = harness.engine.close();
      expect(harness.engine.close()).toBe(firstClose);
      prepareGate?.resolve();
      if (phase === 'preparing') await expect(warm).rejects.toThrow(/closed|superseded/u);
      await expect(firstClose).resolves.toBeUndefined();
      expect(harness.sources[0]?.destroy).toHaveBeenCalledOnce();
      expect(harness.sources[0]?.releaseConstructionLease).toHaveBeenCalledOnce();
      expect(harness.manager.currentCutoverPort()).toBeNull();
    },
  );

  it('publishes transition schedule before evidence and canonical truth after commit', async () => {
    const order: string[] = [];
    const scheduledEvents: Readonly<HostCurrentPlaybackTransitionScheduledEvent>[] = [];
    const committedEvents: Readonly<HostCurrentPlaybackTimelineCommittedEvent>[] = [];
    const harness = makeHarness([{ backend: 'audio-buffer' }], {
      onTransitionScheduled: (event) => {
        scheduledEvents.push(event);
        order.push('scheduled');
        throw new Error('one connection fanout failed');
      },
      onTimelineCommitted: (event) => {
        committedEvents.push(event);
        order.push('committed');
        throw new Error('one timeline observer failed');
      },
    });
    await resolveLatestStart(
      harness,
      harness.start(new Blob([new Uint8Array([1, 2])], { type: 'audio/mpeg' })),
    );
    const previous = harness.controller.timelineSnapshot();
    harness.setRoomTime(2_000);

    const pending = harness.engine.pauseCurrent({ signal: new AbortController().signal });
    await drainMicrotasks();

    expect(order).toEqual(['scheduled']);
    expect(harness.controller.timelineSnapshot()).toBe(previous);
    expect(scheduledEvents[0]).toMatchObject({
      schemaVersion: 1,
      roomGeneration: 1,
      kind: 'pause',
      from: { revision: previous.revision },
      to: { revision: previous.revision + 1 },
      positionSeconds: null,
    });
    expect(Object.isFrozen(scheduledEvents[0])).toBe(true);

    harness.sources[0]?.resolvePause();
    const commit = await pending;
    expect(order).toEqual(['scheduled', 'committed']);
    expect(commit.timeline).toBe(harness.controller.timelineSnapshot());
    expect(committedEvents[0]).toMatchObject({
      schemaVersion: 1,
      roomGeneration: 1,
      kind: 'pause',
      previous,
      timeline: { phase: 'paused', revision: previous.revision + 1 },
    });
    expect(Object.isFrozen(committedEvents[0])).toBe(true);
    expect(harness.fatal).not.toHaveBeenCalled();
    await harness.engine.close();
  });

  it('prepares an exact body-free silent candidate and resolves only its private source lease', async () => {
    const harness = makeHarness([{ backend: 'audio-buffer' }]);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });
    const prepared = await harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q1, blob, 7),
    );

    expect(prepared).toMatchObject({
      schemaVersion: 1,
      roomGeneration: 1,
      backend: 'audio-buffer',
      state: { queueItemId: Q1, runId: RUN_1, revision: 1 },
      positionSeconds: 7,
      playbackRate: 1,
      asset: {
        metadata: { name: 'first.flac', mime: 'audio/mpeg' },
        encodedSize: 3,
      },
    });
    expectBodyFree(prepared);
    expect(prepared.sourceLease).toBeNull();
    expect(harness.controller.timelineSnapshot()).toMatchObject({ phase: 'stopped', revision: 0 });
    expect(harness.sources[0]?.arm).not.toHaveBeenCalled();
    expect(harness.sources[0]?.finalize).not.toHaveBeenCalled();

    const aborted = new AbortController();
    const abortedResolution = harness.engine.resolvePreparedPeerRangeSource({
      prepared,
      sourceIdentity: prepared.asset.binding.sourceIdentity,
      peerRangeManifest: prepared.asset.peerRangeManifest,
      signal: aborted.signal,
    });
    aborted.abort(new Error('fixture prepared resolution abort'));
    await expect(abortedResolution).rejects.toThrow(/fixture prepared resolution abort/u);
    await expect(
      harness.engine.resolvePreparedPeerRangeSource({
        prepared,
        sourceIdentity: prepared.asset.binding.sourceIdentity,
        peerRangeManifest: prepared.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(blob);

    const copied = Object.freeze({ ...prepared });
    await expect(
      harness.engine.startPreparedLocalTrack({ prepared: copied, remoteParticipants: [] }),
    ).rejects.toThrow(/exact current candidate/u);

    const pending = harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] });
    await expect(
      harness.engine.resolvePreparedPeerRangeSource({
        prepared,
        sourceIdentity: prepared.asset.binding.sourceIdentity,
        peerRangeManifest: prepared.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(blob);
    const committed = await resolveLatestStart(harness, pending);
    expect(committed.timeline).toMatchObject({
      phase: 'playing',
      revision: 1,
      run: { queueItemId: Q1, runId: RUN_1 },
    });
    await expect(
      harness.engine.resolvePreparedPeerRangeSource({
        prepared,
        sourceIdentity: prepared.asset.binding.sourceIdentity,
        peerRangeManifest: prepared.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(blob);
    await harness.engine.close();
  });

  it('starts one local-plus-remote cohort but commits only named local FINALIZE acceptance', async () => {
    const localFinalize = deferred<void>();
    const harness = makeHarness([{ backend: 'audio-buffer', finalizeGate: localFinalize }]);
    const blob = new Blob([new Uint8Array([4, 5, 6])], { type: 'audio/mpeg' });
    const prepared = await harness.engine.prepareLocalTrack(
      localTrackOptions(harness, Q1, blob, 0),
    );
    const remote = remoteRecoveryHarness('initial-cohort-peer', prepared);
    const evidence = deferred<void>();
    let attempt: HostRendezvousAttempt | null = null;
    const bindAttempt = vi.fn((candidate: HostRendezvousAttempt) => {
      expect(remote.arms).toHaveLength(0);
      attempt = candidate;
      return evidence.promise;
    });

    const pending = harness.engine.startPreparedLocalTrack({
      prepared,
      remoteParticipants: [{ participant: remote.participant, bindAttempt }],
    });
    await drainMicrotasks(128);
    expect(bindAttempt).toHaveBeenCalledOnce();
    expect(remote.arms).toHaveLength(1);
    expect(harness.sources[0]?.finalize).toHaveBeenCalledOnce();

    await remote.accept(attempt!);
    evidence.resolve();
    await drainMicrotasks(128);
    expect(attempt?.getSnapshot().participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: 'initial-cohort-peer',
          finalizeStatus: 'accepted',
        }),
      ]),
    );
    expect(harness.controller.timelineSnapshot()).toMatchObject({ phase: 'stopped', revision: 0 });

    localFinalize.resolve();
    await drainMicrotasks(128);
    expect(harness.controller.timelineSnapshot()).toMatchObject({
      phase: 'playing',
      revision: 1,
      run: { queueItemId: Q1, runId: RUN_1 },
    });
    const source = harness.sources[0]!;
    harness.context.currentTime = source.startAtContextTime()!;
    source.resolveStart();
    await expect(pending).resolves.toMatchObject({
      attempt: { queueItemId: Q1, runId: RUN_1, revision: 1 },
    });
    await harness.engine.close();
  });

  it('publishes body-free exact current metadata and resolves the original Blob by reference', async () => {
    const harness = makeHarness([{ backend: 'audio-buffer' }]);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mpeg' });
    await resolveLatestStart(harness, harness.start(blob, { name: 'peer.mp3' }));

    const publication = harness.engine.currentPeerPublication();
    expect(publication).not.toBeNull();
    expect(harness.engine.currentPeerPublication()).toBe(publication);
    expect(publication).toMatchObject({
      schemaVersion: 1,
      roomGeneration: harness.controller.snapshot().roomGeneration,
      state: { queueItemId: Q1, runId: RUN_1, revision: 1 },
      asset: {
        kind: 'blob',
        metadata: { name: 'peer.mp3', mime: 'audio/mpeg' },
        encodedSize: blob.size,
      },
    });
    expectBodyFree(publication);

    const resolved = await harness.engine.resolveCurrentPeerRangeSource({
      publication: publication!,
      sourceIdentity: publication!.asset.binding.sourceIdentity,
      peerRangeManifest: publication!.asset.peerRangeManifest,
      signal: new AbortController().signal,
    });
    expect(resolved).toBe(blob);

    await pauseCurrent(harness);
    await expect(
      harness.engine.resolveCurrentPeerRangeSource({
        publication: publication!,
        sourceIdentity: publication!.asset.binding.sourceIdentity,
        peerRangeManifest: publication!.asset.peerRangeManifest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/publication|authority|current/iu);
    await harness.engine.close();
  });

  it('returns a caller-owned encoded source lease and closes a stale acquired lease', async () => {
    const sourceClosed = vi.fn();
    const staleResolution = new AbortController();
    let acquireCount = 0;
    const harness = makeHarness([{ backend: 'bounded-stream' }], {
      admitAsset: (registry, roomToken, binding, blob, metadata) =>
        registry.admitEncodedAsset(
          roomToken,
          binding,
          transferredAsset(blob, binding.sourceIdentity, metadata, sourceClosed, () => {
            acquireCount += 1;
            if (acquireCount === 3) staleResolution.abort(new Error('fixture source became stale'));
          }),
        ),
    });
    const blob = new Blob([new Uint8Array([5, 6, 7, 8])], { type: 'audio/flac' });
    await resolveLatestStart(harness, harness.start(blob, { name: 'range.flac' }));
    const publication = harness.engine.currentPeerPublication();
    expect(publication?.asset.kind).toBe('peer-range');

    const source = await harness.engine.resolveCurrentPeerRangeSource({
      publication: publication!,
      sourceIdentity: publication!.asset.binding.sourceIdentity,
      peerRangeManifest: publication!.asset.peerRangeManifest,
      signal: new AbortController().signal,
    });
    expect(source).not.toBeInstanceOf(Blob);
    if (source instanceof Blob) throw new Error('Expected an encoded source lease');
    expect(source.identity).toBe(publication!.asset.binding.sourceIdentity);
    expect(await source.readAt(1, 2, new AbortController().signal)).toEqual(new Uint8Array([0, 0]));
    await source.close();
    expect(sourceClosed).toHaveBeenCalledOnce();
    await expect(
      harness.engine.resolveCurrentPeerRangeSource({
        publication: publication!,
        sourceIdentity: publication!.asset.binding.sourceIdentity,
        peerRangeManifest: publication!.asset.peerRangeManifest,
        signal: staleResolution.signal,
      }),
    ).rejects.toThrow(/fixture source became stale/u);
    expect(sourceClosed).toHaveBeenCalledTimes(2);
    await harness.engine.close();
  });

  it('scrubs a copied manifest and closes its owned encoded source after post-construction abort', async () => {
    const encodedAdmission = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'admitEncodedAsset');
    const sourceClosed = vi.fn();
    let abortOnAcquire: AbortController | null = null;
    let admittedAsset: EncodedAudioAsset | null = null;
    const harness = makeHarness([{ backend: 'bounded-stream' }], {
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
      admitAsset: (registry, roomToken, binding, blob, metadata) => {
        const asset = transferredAsset(blob, binding.sourceIdentity, metadata, sourceClosed, () => {
          abortOnAcquire?.abort(new Error('fixture manifest resolution aborted after acquire'));
        });
        admittedAsset = asset;
        return registry.admitEncodedAsset(roomToken, binding, asset);
      },
    });
    const bytes = adtsFixtureFrame(41, 0x63);
    const blob = new Blob([bytes], { type: 'audio/aac' });
    await resolveLatestStart(harness, harness.start(blob, { name: 'abort.aac' }));

    const lease = encodedAdmission.mock.results[0]?.value;
    const registry = encodedAdmission.mock.contexts[0] as FilePlaybackAssetRegistry;
    const access = await installFixtureHostArtifact(registry, lease!, bytes);
    const publication = harness.engine.currentPeerPublication();
    const selector = publication?.asset.peerRangeManifest;
    if (!publication || !selector || !admittedAsset) {
      throw new Error('Fixture expected a manifest-bearing encoded publication');
    }

    const originalCopy =
      codecTimelineHostArtifactLeaseStore.copyCodecTimelineHostArtifactManifestForLease;
    let temporaryCopy: Uint8Array | null = null;
    const copySpy = vi
      .spyOn(codecTimelineHostArtifactLeaseStore, 'copyCodecTimelineHostArtifactManifestForLease')
      .mockImplementation((options) => {
        const copied = originalCopy(options);
        if (copied) temporaryCopy = copied;
        return copied;
      });
    const abort = new AbortController();
    abortOnAcquire = abort;
    await expect(
      harness.engine.resolveCurrentPeerRangeSource({
        publication,
        sourceIdentity: publication.asset.binding.sourceIdentity,
        peerRangeManifest: selector,
        signal: abort.signal,
      }),
    ).rejects.toThrow(/manifest resolution aborted after acquire/u);
    expect(temporaryCopy).not.toBeNull();
    expect(temporaryCopy && Array.from(temporaryCopy)).toEqual(
      Array.from({ length: selector.manifestByteLength }, () => 0),
    );
    expect(sourceClosed).toHaveBeenCalledOnce();
    expect(admittedAsset.activeLeaseCount).toBe(1);

    abortOnAcquire = null;
    copySpy.mockRestore();
    const healthy = await harness.engine.resolveCurrentPeerRangeSource({
      publication,
      sourceIdentity: publication.asset.binding.sourceIdentity,
      peerRangeManifest: selector,
      signal: new AbortController().signal,
    });
    expect(healthy).not.toBeInstanceOf(Blob);
    if (healthy instanceof Blob) throw new Error('Expected an encoded manifest bundle');
    expect(healthy).toMatchObject({
      kind: 'peer-range',
      identity: publication.asset.binding.sourceIdentity,
      size: selector.manifestByteLength + bytes.byteLength,
    });
    await healthy.close();
    expect(sourceClosed).toHaveBeenCalledTimes(2);
    expect(admittedAsset.activeLeaseCount).toBe(1);
    expect(
      codecTimelineHostArtifactLeaseStore.revokeCodecTimelineHostArtifactForLease(access),
    ).toBe(true);
    await expect(
      harness.engine.resolveCurrentPeerRangeSource({
        publication,
        sourceIdentity: publication.asset.binding.sourceIdentity,
        peerRangeManifest: selector,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/lease diagnostics changed/u);
    const raw = await harness.engine.resolveCurrentPeerRangeSource({
      publication,
      sourceIdentity: publication.asset.binding.sourceIdentity,
      peerRangeManifest: null,
      signal: new AbortController().signal,
    });
    expect(raw).not.toBeInstanceOf(Blob);
    if (raw instanceof Blob) throw new Error('Expected a raw encoded source lease');
    await raw.close();
    expect(sourceClosed).toHaveBeenCalledTimes(3);
    expect(admittedAsset.activeLeaseCount).toBe(1);
    await harness.engine.close();
  });

  it('recovers delayed peers independently and commits exact renderer evidence', async () => {
    const harness = makeHarness([{ backend: 'audio-buffer' }]);
    await resolveLatestStart(
      harness,
      harness.start(new Blob([new Uint8Array([9])], { type: 'audio/mpeg' })),
    );
    const publication = harness.engine.currentPeerPublication()!;
    const failed = remoteRecoveryHarness('recovery-failed-peer', publication);
    const healthy = remoteRecoveryHarness('recovery-healthy-peer', publication);
    const failedEvidence = deferred<void>();
    const healthyEvidence = deferred<void>();
    let healthyAttempt: HostRendezvousAttempt | null = null;

    const failedTask = harness.engine.recoverRemoteParticipant({
      publication,
      participant: failed.participant,
      signal: new AbortController().signal,
      bindAttempt: () => failedEvidence.promise,
    });
    const healthyTask = harness.engine.recoverRemoteParticipant({
      publication,
      participant: healthy.participant,
      signal: new AbortController().signal,
      bindAttempt: (attempt) => {
        healthyAttempt = attempt;
        return healthyEvidence.promise;
      },
    });
    await drainMicrotasks(128);
    expect(failed.arms).toHaveLength(1);
    expect(healthy.arms).toHaveLength(1);

    failedEvidence.reject(new Error('fixture remote renderer failed'));
    await expect(failedTask).rejects.toThrow(/renderer failed/u);
    expect(harness.engine.currentPeerPublication()).toBe(publication);
    expect(harness.fatal).not.toHaveBeenCalled();

    await healthy.accept(healthyAttempt!);
    healthyEvidence.resolve();
    const commit = await healthyTask;
    expect(commit).toMatchObject({
      participantId: 'recovery-healthy-peer',
      publication,
      timeline: publication.timeline,
      attempt: publication.state,
    });
    expect(commit.publication).toBe(publication);
    expect(commit.timeline).toBe(publication.timeline);
    expectBodyFree(commit);
    expect(harness.engine.currentRendererSnapshot()?.phase).toBe('playing');
    await harness.engine.close();
  });

  it('fences same-participant ABA and cancels only stale recovery on revision or close', async () => {
    const harness = makeHarness([{ backend: 'bounded-stream' }]);
    await resolveLatestStart(
      harness,
      harness.start(new Blob([new Uint8Array([10])], { type: 'audio/flac' })),
    );
    const publication = harness.engine.currentPeerPublication()!;
    const first = remoteRecoveryHarness('recovery-aba-peer', publication);
    const replacement = remoteRecoveryHarness('recovery-aba-peer', publication);
    const firstEvidence = deferred<void>();
    const replacementEvidence = deferred<void>();
    let replacementAttempt: HostRendezvousAttempt | null = null;
    const firstTask = harness.engine.recoverRemoteParticipant({
      publication,
      participant: first.participant,
      signal: new AbortController().signal,
      bindAttempt: () => firstEvidence.promise,
    });
    const replacementTask = harness.engine.recoverRemoteParticipant({
      publication,
      participant: replacement.participant,
      signal: new AbortController().signal,
      bindAttempt: (attempt) => {
        replacementAttempt = attempt;
        return replacementEvidence.promise;
      },
    });
    await expect(firstTask).rejects.toThrow(/replaced|superseded/u);
    await drainMicrotasks();
    await replacement.accept(replacementAttempt!);
    replacementEvidence.resolve();
    await expect(replacementTask).resolves.toMatchObject({
      participantId: 'recovery-aba-peer',
    });

    const revision = remoteRecoveryHarness('recovery-revision-peer', publication);
    const revisionTask = harness.engine.recoverRemoteParticipant({
      publication,
      participant: revision.participant,
      signal: new AbortController().signal,
      bindAttempt: () => new Promise<void>(() => undefined),
    });
    const pause = harness.engine.pauseCurrent({ signal: new AbortController().signal });
    await expect(revisionTask).rejects.toThrow(/transition|superseded|recovery/iu);
    await drainMicrotasks();
    expect(harness.sources[0]?.hasPendingPause()).toBe(true);
    harness.sources[0]?.resolvePause();
    await expect(pause).resolves.toMatchObject({ kind: 'pause' });
    expect(harness.fatal).not.toHaveBeenCalled();
    await harness.engine.close();

    const closeHarness = makeHarness([{ backend: 'audio-buffer' }]);
    await resolveLatestStart(
      closeHarness,
      closeHarness.start(new Blob([new Uint8Array([11])], { type: 'audio/mpeg' })),
    );
    const closePublication = closeHarness.engine.currentPeerPublication()!;
    const closing = remoteRecoveryHarness('recovery-close-peer', closePublication);
    const closingTask = closeHarness.engine.recoverRemoteParticipant({
      publication: closePublication,
      participant: closing.participant,
      signal: new AbortController().signal,
      bindAttempt: () => new Promise<void>(() => undefined),
    });
    const close = closeHarness.engine.close();
    await expect(closingTask).rejects.toThrow(/closed|recovery|stale/iu);
    await close;
    expect(closeHarness.fatal).not.toHaveBeenCalled();
  });

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
    ['bounded FLAC', 'bounded-stream', 'audio/flac'],
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

  it('waits for arbitrarily delayed FINALIZE acceptance without a polling deadline', async () => {
    const finalizeGate = deferred<void>();
    const harness = makeHarness([{ backend: 'audio-buffer', finalizeGate }]);
    const pending = harness.start(new Blob([new Uint8Array([50])], { type: 'audio/mpeg' }), {
      name: 'delayed-finalize.mp3',
    });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await drainMicrotasks(256);
    expect(harness.sources[0]?.arm).toHaveBeenCalledOnce();
    expect(harness.sources[0]?.finalize).toHaveBeenCalledOnce();
    expect(harness.controller.timelineSnapshot()).toMatchObject({
      revision: 0,
      phase: 'stopped',
      run: null,
    });
    expect(harness.manager.currentCutoverPort()).toBeNull();
    expect(settled).toBe(false);

    finalizeGate.resolve();
    await drainMicrotasks();
    expect(harness.controller.timelineSnapshot()).toMatchObject({
      revision: 1,
      phase: 'playing',
      run: { queueItemId: Q1, runId: RUN_1 },
    });
    expect(settled).toBe(false);

    const source = harness.sources[0];
    const target = source?.startAtContextTime();
    expect(target).not.toBeNull();
    harness.context.currentTime = target!;
    source?.resolveStart();
    await expect(pending).resolves.toMatchObject({
      attempt: { queueItemId: Q1, runId: RUN_1, revision: 1 },
      timeline: { revision: 1, phase: 'playing' },
    });
    await harness.engine.close();
  });

  it('keeps canonical accepted timeline truth when only the local renderer later fails', async () => {
    const harness = makeHarness([{ backend: 'bounded-stream' }]);
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
    ['AudioBuffer to FLAC', 'audio-buffer', 'bounded-stream'],
    ['FLAC to AudioBuffer', 'bounded-stream', 'audio-buffer'],
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

  it.each(['audio-buffer', 'bounded-stream'] as const)(
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

  it.each(['audio-buffer', 'bounded-stream'] as const)(
    'prepares a body-free playing %s seek before starting its shared rendezvous',
    async (backend) => {
      const harness = makeHarness([{ backend }, { backend }]);
      const blob = new Blob([new Uint8Array([54])], {
        type: backend === 'audio-buffer' ? 'audio/mpeg' : 'audio/flac',
      });
      const first = await resolveLatestStart(
        harness,
        harness.start(blob, { name: 'prepared-seek-current' }),
      );
      const previousTimeline = harness.controller.timelineSnapshot();
      const previousPort = harness.manager.currentCutoverPort();
      const previousPublication = harness.engine.currentPeerPublication();
      if (!previousPublication) throw new Error('Fixture expected a current peer publication');
      harness.setRoomTime(2_000);

      const prepared = await harness.engine.preparePlayingSeek({
        positionSeconds: 42,
        signal: new AbortController().signal,
      });

      expect(prepared).toMatchObject({
        backend,
        state: {
          queueItemId: Q1,
          runId: first.attempt.runId,
          revision: 2,
        },
        positionSeconds: 42,
        playbackRate: 1,
      });
      expectBodyFree(prepared);
      expect(harness.controller.timelineSnapshot()).toBe(previousTimeline);
      expect(harness.manager.currentCutoverPort()).toBe(previousPort);
      expect(harness.sources[0]?.destroy).not.toHaveBeenCalled();
      expect(harness.engine.currentPeerPublication()).toBe(previousPublication);
      await expect(
        harness.engine.resolveCurrentPeerRangeSource({
          publication: previousPublication,
          sourceIdentity: previousPublication.asset.binding.sourceIdentity,
          peerRangeManifest: previousPublication.asset.peerRangeManifest,
          signal: new AbortController().signal,
        }),
      ).resolves.toBe(blob);
      const recovery = remoteRecoveryHarness('prepared-seek-recovery-peer', previousPublication);
      await expect(
        harness.engine.recoverRemoteParticipant({
          publication: previousPublication,
          participant: recovery.participant,
          signal: new AbortController().signal,
          bindAttempt: () => Promise.resolve(),
        }),
      ).rejects.toThrow(/idle|candidate|recovery|authority/iu);
      expect(recovery.arms).toHaveLength(0);

      const committed = await resolveLatestStart(
        harness,
        harness.engine.startPreparedLocalTrack({ prepared, remoteParticipants: [] }),
      );
      expect(committed.attempt).toMatchObject(prepared.state);
      expect(committed.timeline).toMatchObject({
        phase: 'playing',
        revision: 2,
        positionSeconds: 42,
      });
      expect(harness.createRunId).toHaveBeenCalledOnce();
      expect(harness.manager.currentCutoverPort()).not.toBe(previousPort);
      expect(harness.sources[0]?.destroy).toHaveBeenCalledOnce();
      await expect(
        harness.engine.resolveCurrentPeerRangeSource({
          publication: previousPublication,
          sourceIdentity: previousPublication.asset.binding.sourceIdentity,
          peerRangeManifest: previousPublication.asset.peerRangeManifest,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/publication|authority|current/iu);
      await harness.engine.close();
    },
  );

  it.each(['audio-buffer', 'bounded-stream'] as const)(
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

  it.each(['audio-buffer', 'bounded-stream'] as const)(
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

  it.each(['audio-buffer', 'bounded-stream'] as const)(
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

  it.each(['audio-buffer', 'bounded-stream'] as const)(
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

  it.each(['audio-buffer', 'bounded-stream'] as const)(
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
    const harness = makeHarness([{ backend: 'bounded-stream' }]);
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

  it.each(['audio-buffer', 'bounded-stream'] as const)(
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

  it.each(['audio-buffer', 'bounded-stream'] as const)(
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

  it('retains an installed live artifact across renderer failure and retry', async () => {
    const holdAfterStage = deferred<void>();
    const liveAdmission = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'admitBlob');
    const harness = makeHarness(
      [
        { backend: 'bounded-stream', rejectArm: true, holdAfterStage },
        { backend: 'bounded-stream' },
      ],
      { boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY },
    );
    const bytes = adtsFixtureFrame(42, 0x71);
    const blob = new Blob([bytes], { type: 'audio/aac' });
    const failed = harness.start(blob, { name: 'retry.aac' });
    await drainMicrotasks();
    const lease = liveAdmission.mock.results[0]?.value;
    const registry = liveAdmission.mock.contexts[0] as FilePlaybackAssetRegistry;
    const access = await installFixtureHostArtifact(registry, lease!, bytes);
    holdAfterStage.resolve();

    await expect(failed).rejects.toThrow(/retired|arm/u);
    expect(
      codecTimelineHostArtifactLeaseStore.describeCodecTimelineHostArtifactForLease(access),
    ).not.toBeNull();
    await resolveLatestStart(harness, harness.start(blob, { name: 'retry.aac' }));
    expect(
      codecTimelineHostArtifactLeaseStore.describeCodecTimelineHostArtifactForLease(access),
    ).not.toBeNull();
    await harness.engine.close();
    expect(
      codecTimelineHostArtifactLeaseStore.describeCodecTimelineHostArtifactForLease(access),
    ).toBeNull();
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

    const harness = makeHarness([{ backend: 'bounded-stream' }]);
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
    const harness = makeHarness([{ backend: 'bounded-stream', holdAfterStage: hold }]);
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
    const harness = makeHarness([{ backend: 'bounded-stream' }]);
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

  it('treats an absent host artifact association as harmless room cleanup', async () => {
    const revoke = vi.spyOn(
      codecTimelineHostArtifactLeaseStore,
      'revokeCodecTimelineHostArtifactForLease',
    );
    const harness = makeHarness([{ backend: 'audio-buffer' }]);
    await resolveLatestStart(
      harness,
      harness.start(new Blob([new Uint8Array([0x31])], { type: 'audio/mpeg' })),
    );

    await expect(harness.engine.close()).resolves.toBeUndefined();
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke.mock.results[0]?.value).toBe(false);
  });

  it('propagates artifact revoke failure only after registry close and reference release', async () => {
    const terminalReferences = vi.fn();
    const liveAdmission = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'admitBlob');
    const registryClose = vi.spyOn(FilePlaybackAssetRegistry.prototype, 'close');
    const harness = makeHarness([{ backend: 'bounded-stream' }], {
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
      onTerminalReferencesReleased: terminalReferences,
    });
    const bytes = adtsFixtureFrame(44, 0x76);
    const blob = new Blob([bytes], { type: 'audio/aac' });
    await resolveLatestStart(harness, harness.start(blob, { name: 'close.aac' }));
    const lease = liveAdmission.mock.results[0]?.value;
    const registry = liveAdmission.mock.contexts[0] as FilePlaybackAssetRegistry;
    const access = await installFixtureHostArtifact(registry, lease!, bytes);
    const revokeFailure = new Error('fixture close artifact revoke failed');
    const revoke = vi
      .spyOn(codecTimelineHostArtifactLeaseStore, 'revokeCodecTimelineHostArtifactForLease')
      .mockImplementation(() => {
        throw revokeFailure;
      });

    await expect(harness.engine.close()).rejects.toBe(revokeFailure);
    expect(revoke).toHaveBeenCalledOnce();
    expect(registryClose).toHaveBeenCalledWith(ROOM_TOKEN);
    expect(registry.snapshotForLease(ROOM_TOKEN, lease!)).toBeNull();
    expect(terminalReferences).toHaveBeenCalledOnce();
    expect(
      codecTimelineHostArtifactLeaseStore.describeCodecTimelineHostArtifactForLease(access),
    ).toBeNull();
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
    const harness = makeHarness([{ backend: 'bounded-stream' }], {
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

  it('revokes an installed artifact during fatal room close', async () => {
    const bytes = adtsFixtureFrame(43, 0x72);
    const artifact = await issueFixtureHostArtifact(bytes, {
      queueItemId: Q1,
      sourceIdentity: `mxq:q:${Q1}`,
      transferSessionId: `mxq:s:${APPLICATION_SCOPE}:q:${Q1}`,
      name: 'fatal.aac',
      mime: 'audio/aac',
    });
    let artifactAccess:
      | Readonly<{
          registry: FilePlaybackAssetRegistry;
          roomToken: object;
          lease: FilePlaybackAssetLease;
        }>
      | undefined;
    const harness = makeHarness([], {
      fatalAfterAdmission: true,
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
      admitAsset: (registry, roomToken, binding, blob, metadata) => {
        const lease = registry.admitBlob(roomToken, binding, blob, metadata);
        artifactAccess = Object.freeze({ registry, roomToken, lease });
        codecTimelineHostArtifactLeaseStore.installCodecTimelineHostArtifactForLease({
          ...artifactAccess,
          artifact,
        });
        return lease;
      },
    });
    const blob = new Blob([bytes], { type: 'audio/aac' });

    await expect(harness.start(blob, { name: 'fatal.aac' })).rejects.toThrow(/fixture/iu);
    await expect(harness.engine.close()).resolves.toBeUndefined();
    expect(harness.fatal).toHaveBeenCalledOnce();
    expect(artifactAccess).toBeDefined();
    expect(
      codecTimelineHostArtifactLeaseStore.describeCodecTimelineHostArtifactForLease(
        artifactAccess!,
      ),
    ).toBeNull();
  });
});
