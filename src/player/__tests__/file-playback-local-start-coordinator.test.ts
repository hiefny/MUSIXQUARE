import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  FilePlaybackAssetRegistry,
  type FilePlaybackAssetBinding,
  type FilePlaybackAssetLease,
} from '../file-playback-asset-registry.ts';
import { stageFilePlaybackAssetSource } from '../file-playback-asset-source-stager.ts';
import {
  completeLocalFilePlaybackParticipant,
  retireLocalFilePlaybackParticipant,
  stageLocalFilePlaybackParticipant,
  startLocalFilePlayback,
  type StageLocalFilePlaybackParticipantOptions,
  type StartLocalFilePlaybackOptions,
} from '../file-playback-local-start-coordinator.ts';
import {
  FilePlaybackManager,
  type FilePlaybackCutoverCandidatePort,
} from '../file-playback-manager.ts';
import {
  createAudioBufferPlaybackStartEvidence,
  createFilePlaybackCutoverTarget,
  createFilePlaybackRejectedTransitionResult,
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
import type { BlobFilePlaybackSourceResult } from '../file-playback-source-factory.ts';
import type {
  RendezvousArmIntent,
  RendezvousArmReceipt,
  RendezvousFinalizeIntent,
  RendezvousFinalizeReceipt,
} from '../rendezvous-contract.ts';
import {
  HostRendezvousCoordinator,
  type HostRendezvousParticipant,
} from '../rendezvous-coordinator.ts';

const TOKEN = Object.freeze({ room: 'local-start-coordinator' });
const Q1 = '92000000-0000-4000-8000-000000000001' as QueueItemId;
const Q2 = '92000000-0000-4000-8000-000000000002' as QueueItemId;
const PARTICIPANT_ID = 'local-room-participant';

function binding(queueItemId: QueueItemId, suffix: string): FilePlaybackAssetBinding {
  return Object.freeze({
    queueItemId,
    sourceIdentity: `distributed-source:${suffix}`,
    transferSessionId: `transfer-session:${suffix}`,
  });
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

async function drainMicrotasks(turns = 48): Promise<void> {
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
    observedAtRoomTimeMs: 1_000,
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
    observedAtRoomTimeMs: 1_000,
    reasonCode: null,
  });
}

function rejectedArmReceipt(intent: RendezvousArmIntent): RendezvousArmReceipt {
  return Object.freeze({
    protocolVersion: 2,
    kind: 'rendezvous-armed',
    queueItemId: intent.queueItemId,
    runId: intent.runId,
    revision: intent.revision,
    rendezvousId: intent.rendezvousId,
    participantId: intent.recipientId,
    status: 'rejected',
    observedAtRoomTimeMs: 1_000,
    bufferedAheadSeconds: 0,
    reasonCode: 'fixture-remote-rejected',
  });
}

interface FakeSourceOptions {
  readonly rejectArm?: boolean;
  readonly holdArm?: boolean;
  readonly holdDestroy?: boolean;
  readonly invalidEvidence?: boolean;
}

interface FakeSourceHarness {
  readonly source: FilePlaybackCutoverSource;
  readonly events: string[];
  readonly stats: {
    readonly arm: ReturnType<typeof vi.fn>;
    readonly finalize: ReturnType<typeof vi.fn>;
    readonly destroy: ReturnType<typeof vi.fn>;
  };
  readonly startAtContextTime: () => number | null;
  resolveStart(): void;
  releaseArm(): void;
  releaseDestroy(): void;
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
  let heldArmResult: FilePlaybackCutoverArmResult | null = null;
  const started = deferred<FilePlaybackStartEvidence>();
  const armGate = deferred<FilePlaybackCutoverArmResult>();
  const destroyGate = deferred<void>();
  const events: string[] = [];
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
      events.push('prepare');
      phase = 'preparing';
      phase = 'ready';
      return snapshot();
    },
    async connect() {
      events.push('connect');
      phase = 'connected';
      return snapshot();
    },
    async arm(intent) {
      return armedReceipt(intent);
    },
    async armForCutover(intent) {
      events.push('arm');
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
      const result = Object.freeze({
        status: 'armed' as const,
        receipt: armedReceipt(intent),
        target: createFilePlaybackCutoverTarget(
          context as unknown as AudioContext,
          targetTime,
          targetFrame,
        ),
        started: started.promise,
      });
      if (options.holdArm) {
        heldArmResult = result;
        return armGate.promise;
      }
      return result;
    },
    async finalize(intent) {
      events.push('finalize');
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
      events.push('destroy');
      destroy();
      phase = 'destroyed';
      if (options.holdDestroy) await destroyGate.promise;
    },
  };

  return {
    source,
    events,
    stats: { arm, finalize, destroy },
    startAtContextTime: () => targetTime,
    resolveStart() {
      if (targetFrame === null) throw new Error('No start target is armed');
      events.push('start');
      phase = 'playing';
      if (backend === 'audio-buffer') {
        started.resolve(
          createAudioBufferPlaybackStartEvidence(
            options.invalidEvidence ? targetFrame + 1 : targetFrame,
          ),
        );
      } else {
        const evidenceFrame = options.invalidEvidence ? targetFrame + 1 : targetFrame;
        started.resolve(createStreamingPlaybackStartEvidence(evidenceFrame, evidenceFrame));
      }
    },
    releaseArm() {
      if (!heldArmResult) throw new Error('No arm operation is held');
      armGate.resolve(heldArmResult);
      heldArmResult = null;
    },
    releaseDestroy() {
      destroyGate.resolve();
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
    backend: 'bounded-stream',
    source: harness.source as never,
    sourceIdentity,
    releaseConstructionLease: vi.fn(),
    flacMetadata: Object.freeze({ fixture: true }) as never,
  });
}

interface RoomHarness {
  readonly registry: FilePlaybackAssetRegistry;
  readonly manager: FilePlaybackManager;
  readonly context: FakeAudioContext;
  readonly destination: AudioNode;
  readonly coordinator: HostRendezvousCoordinator;
  readonly ids: string[];
  readonly current: { value: boolean };
  readonly nowRoomTimeMs: { value: number };
  admit(
    queueItemId: QueueItemId,
    suffix: string,
    backend: FilePlaybackBackend,
    sourceOptions?: FakeSourceOptions,
  ): {
    readonly binding: FilePlaybackAssetBinding;
    readonly lease: FilePlaybackAssetLease;
    readonly source: FakeSourceHarness;
    readonly options: StartLocalFilePlaybackOptions;
    readonly getPort: () => FilePlaybackCutoverCandidatePort | null;
  };
}

function roomHarness(ids = ['rv-local-1', 'rv-local-2', 'rv-local-3']): RoomHarness {
  const registry = new FilePlaybackAssetRegistry({
    liveRoomToken: TOKEN,
    onFatalRoom: vi.fn(),
  });
  const manager = new FilePlaybackManager();
  const context = new FakeAudioContext();
  const destination = destinationFor(context);
  const current = { value: true };
  const nowRoomTimeMs = { value: 1_000 };
  const availableIds = [...ids];
  const coordinator = new HostRendezvousCoordinator({
    nowRoomTimeMs: () => nowRoomTimeMs.value,
    createRendezvousId: () => availableIds.shift() ?? 'rv-local-fallback',
  });

  return {
    registry,
    manager,
    context,
    destination,
    coordinator,
    ids: availableIds,
    current,
    nowRoomTimeMs,
    admit(queueItemId, suffix, backend, sourceOptions = {}) {
      const expectedBinding = binding(queueItemId, suffix);
      const metadata = Object.freeze({
        name: backend === 'audio-buffer' ? `${suffix}.mp3` : `${suffix}.flac`,
        mime: backend === 'audio-buffer' ? 'audio/mpeg' : 'audio/flac',
      });
      const lease = registry.admitBlob(
        TOKEN,
        expectedBinding,
        new Blob([new Uint8Array([1, 2, 3, 4])], { type: metadata.mime }),
        metadata,
      );
      const source = makeSource(queueItemId, backend, context, sourceOptions);
      let port: FilePlaybackCutoverCandidatePort | null = null;
      const result = factoryResult(source, expectedBinding.sourceIdentity);
      const stageAssetSourceForTests = (
        options: Parameters<typeof stageFilePlaybackAssetSource>[0],
      ) =>
        stageFilePlaybackAssetSource({
          ...options,
          runtime: {
            createBlobSource: vi.fn(async () => result),
          },
        }).then((staged) => {
          port = staged.cutoverPort;
          return staged;
        });
      const options: StartLocalFilePlaybackOptions = {
        registry,
        roomToken: TOKEN,
        assetLease: lease,
        expectedBinding,
        manager,
        audioContext: context as unknown as AudioContext,
        destination,
        clockBindings: {
          nowRoomTimeMs: () => nowRoomTimeMs.value,
          roomTimeMsToContextTime: (roomTimeMs) => roomTimeMs / 1_000,
          localPerformanceMsToContextTime: (localTimeMs) => localTimeMs / 1_000,
        },
        signal: new AbortController().signal,
        isCurrent: () => current.value,
        decodeOrdinaryAudio: vi.fn(async () => ({
          audioBuffer: fakeAudioBuffer(),
          release: vi.fn(),
        })),
        playbackState: { queueItemId, runId: `run:${suffix}`, revision: 1 },
        positionSeconds: 0,
        playbackRate: 1,
        participantId: PARTICIPANT_ID,
        rttP95Ms: 25,
        armP95Ms: 75,
        rendezvousCoordinator: coordinator,
        runtimeForTests: { stageAssetSourceForTests },
      };
      return { binding: expectedBinding, lease, source, options, getPort: () => port };
    },
  };
}

function splitStageOptions(
  options: StartLocalFilePlaybackOptions,
): StageLocalFilePlaybackParticipantOptions {
  return {
    registry: options.registry,
    roomToken: options.roomToken,
    assetLease: options.assetLease,
    expectedBinding: options.expectedBinding,
    manager: options.manager,
    audioContext: options.audioContext,
    destination: options.destination,
    clockBindings: options.clockBindings,
    signal: options.signal,
    isCurrent: options.isCurrent,
    decodeOrdinaryAudio: options.decodeOrdinaryAudio,
    playbackState: options.playbackState,
    participantId: options.participantId,
    rttP95Ms: options.rttP95Ms,
    armP95Ms: options.armP95Ms,
    runtimeForTests: options.runtimeForTests,
  };
}

async function resolveStarted(
  pending: Promise<unknown>,
  room: RoomHarness,
  source: FakeSourceHarness,
): Promise<void> {
  await drainMicrotasks();
  expect(source.stats.arm).toHaveBeenCalledTimes(1);
  expect(source.stats.finalize).toHaveBeenCalledTimes(1);
  const targetTime = source.startAtContextTime();
  expect(targetTime).not.toBeNull();
  room.context.currentTime = targetTime!;
  source.resolveStart();
  void pending.catch(() => undefined);
}

describe('split local rendezvous participant lifecycle', () => {
  it('returns a frozen silent construction and retires it exactly once', async () => {
    const room = roomHarness();
    const fixture = room.admit(Q1, 'split-silent', 'audio-buffer');
    const staged = await stageLocalFilePlaybackParticipant(splitStageOptions(fixture.options));

    expect(Object.isFrozen(staged)).toBe(true);
    expect(Object.isFrozen(staged.source)).toBe(true);
    expect(Object.isFrozen(staged.playbackState)).toBe(true);
    expect(staged.port).toBe(fixture.getPort());
    expect(staged.participant.participantId).toBe(PARTICIPANT_ID);
    expect(fixture.source.events).toEqual(['prepare', 'connect']);
    expect(fixture.source.stats.arm).not.toHaveBeenCalled();
    expect(fixture.source.stats.finalize).not.toHaveBeenCalled();
    expect(room.manager.currentCutoverPort()).toBeNull();

    const firstRetirement = retireLocalFilePlaybackParticipant(staged, 'split-test-retired');
    const duplicateRetirement = retireLocalFilePlaybackParticipant(staged, 'split-test-retired');
    expect(duplicateRetirement).toBe(firstRetirement);
    await firstRetirement;
    expect(fixture.source.stats.destroy).toHaveBeenCalledTimes(1);
    expect(room.manager.currentCutoverPort()).toBeNull();
  });

  it('rejects a copied construction and an attempt that omits the exact local participant', async () => {
    const forgedRoom = roomHarness();
    const forgedFixture = forgedRoom.admit(Q1, 'split-forged', 'audio-buffer');
    const exact = await stageLocalFilePlaybackParticipant(splitStageOptions(forgedFixture.options));
    const forged = Object.freeze({ ...exact });
    const emptyAttempt = forgedRoom.coordinator.start({
      run: exact.playbackState,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [],
    });
    await expect(
      completeLocalFilePlaybackParticipant({ staged: forged, attempt: emptyAttempt }),
    ).rejects.toThrow(/construction is invalid/);
    expect(forgedFixture.source.stats.destroy).not.toHaveBeenCalled();
    await retireLocalFilePlaybackParticipant(exact, 'split-forged-cleanup');
    expect(forgedFixture.source.stats.destroy).toHaveBeenCalledTimes(1);

    const omittedRoom = roomHarness();
    const omittedFixture = omittedRoom.admit(Q1, 'split-omitted', 'bounded-stream');
    const omitted = await stageLocalFilePlaybackParticipant(
      splitStageOptions(omittedFixture.options),
    );
    const omittedAttempt = omittedRoom.coordinator.start({
      run: omitted.playbackState,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [],
    });
    await expect(
      completeLocalFilePlaybackParticipant({ staged: omitted, attempt: omittedAttempt }),
    ).rejects.toThrow(/does not belong/);
    await drainMicrotasks();
    expect(omittedRoom.manager.currentCutoverPort()).toBeNull();
    expect(omittedFixture.source.stats.destroy).toHaveBeenCalledTimes(1);
  });

  it('commits the local participant while an unrelated remote arm stays pending', async () => {
    const room = roomHarness();
    const fixture = room.admit(Q1, 'split-remote-pending', 'bounded-stream');
    const staged = await stageLocalFilePlaybackParticipant(splitStageOptions(fixture.options));
    const remoteCancel = vi.fn();
    const remote: HostRendezvousParticipant = {
      participantId: 'remote-pending',
      rttP95Ms: 50,
      armP95Ms: 100,
      arm: () => new Promise<RendezvousArmReceipt>(() => undefined),
      finalize: vi.fn(),
      cancel: remoteCancel,
    };
    const attempt = room.coordinator.start({
      run: staged.playbackState,
      positionSeconds: 3,
      playbackRate: 1,
      participants: [remote, staged.participant],
    });
    const pending = completeLocalFilePlaybackParticipant({ staged, attempt });

    await resolveStarted(pending, room, fixture.source);
    const result = await pending;
    expect(result.schedule.positionSeconds).toBe(3);
    expect(attempt.getSnapshot()).toMatchObject({
      status: 'open',
      participants: [
        { participantId: 'remote-pending', armStatus: 'pending' },
        {
          participantId: PARTICIPANT_ID,
          armStatus: 'armed',
          finalizeStatus: 'accepted',
        },
      ],
    });
    expect(remoteCancel).not.toHaveBeenCalled();
    expect(room.manager.currentCutoverPort()).toBe(result.port);

    room.coordinator.close();
    await room.manager.retireCurrentCutover(result.port);
  });

  it('commits the local participant when an unrelated remote is rejected', async () => {
    const room = roomHarness();
    const fixture = room.admit(Q1, 'split-remote-rejected', 'audio-buffer');
    const staged = await stageLocalFilePlaybackParticipant(splitStageOptions(fixture.options));
    const remoteFinalize = vi.fn();
    const remote: HostRendezvousParticipant = {
      participantId: 'remote-rejected',
      rttP95Ms: 0,
      armP95Ms: 0,
      arm: async (intent) => rejectedArmReceipt(intent),
      finalize: remoteFinalize,
    };
    const attempt = room.coordinator.start({
      run: staged.playbackState,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [staged.participant, remote],
    });
    const pending = completeLocalFilePlaybackParticipant({ staged, attempt });

    await resolveStarted(pending, room, fixture.source);
    const result = await pending;
    expect(attempt.getSnapshot()).toMatchObject({
      status: 'complete',
      participants: [
        { participantId: PARTICIPANT_ID, finalizeStatus: 'accepted' },
        {
          participantId: 'remote-rejected',
          armStatus: 'rejected',
          finalizeStatus: 'not-requested',
        },
      ],
    });
    expect(remoteFinalize).not.toHaveBeenCalled();
    await room.manager.retireCurrentCutover(result.port);
  });

  it('aborts and retires only local work while a finalized remote stays live', async () => {
    const room = roomHarness();
    const fixture = room.admit(Q1, 'split-local-abort', 'bounded-stream');
    const controller = new AbortController();
    const staged = await stageLocalFilePlaybackParticipant({
      ...splitStageOptions(fixture.options),
      signal: controller.signal,
    });
    const remoteCancel = vi.fn();
    const remote: HostRendezvousParticipant = {
      participantId: 'remote-finalized',
      rttP95Ms: 0,
      armP95Ms: 0,
      arm: async (intent) => armedReceipt(intent),
      finalize: async (intent) => acceptedReceipt(intent),
      cancel: remoteCancel,
    };
    const attempt = room.coordinator.start({
      run: staged.playbackState,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [staged.participant, remote],
    });
    const pending = completeLocalFilePlaybackParticipant({ staged, attempt });
    await drainMicrotasks();
    expect(fixture.source.stats.finalize).toHaveBeenCalledTimes(1);
    expect(attempt.getSnapshot()).toMatchObject({
      status: 'complete',
      participants: [
        { participantId: PARTICIPANT_ID, finalizeStatus: 'accepted' },
        { participantId: 'remote-finalized', finalizeStatus: 'accepted' },
      ],
    });

    controller.abort(new Error('split-local-aborted'));
    await expect(pending).rejects.toThrow('split-local-aborted');
    await drainMicrotasks();
    expect(attempt.getSnapshot().status).toBe('complete');
    expect(remoteCancel).not.toHaveBeenCalled();
    expect(room.manager.currentCutoverPort()).toBeNull();
    expect(fixture.source.stats.destroy).toHaveBeenCalledTimes(1);

    room.context.currentTime = fixture.source.startAtContextTime()!;
    fixture.source.resolveStart();
    await drainMicrotasks();
    expect(room.manager.currentCutoverPort()).toBeNull();
    expect(fixture.source.stats.destroy).toHaveBeenCalledTimes(1);
    room.coordinator.close();
  });

  it('coalesces exact completion and rejects an ABA attempt without disturbing it', async () => {
    const room = roomHarness(['rv-split-primary']);
    const fixture = room.admit(Q1, 'split-attempt-fence', 'audio-buffer');
    const staged = await stageLocalFilePlaybackParticipant(splitStageOptions(fixture.options));
    const attempt = room.coordinator.start({
      run: staged.playbackState,
      positionSeconds: 4,
      playbackRate: 1,
      participants: [staged.participant],
    });
    const otherCoordinator = new HostRendezvousCoordinator({
      nowRoomTimeMs: () => room.nowRoomTimeMs.value,
      createRendezvousId: () => 'rv-split-aba',
    });
    const otherAttempt = otherCoordinator.start({
      run: staged.playbackState,
      positionSeconds: 4,
      playbackRate: 1,
      participants: [],
    });

    const first = completeLocalFilePlaybackParticipant({ staged, attempt });
    const duplicate = completeLocalFilePlaybackParticipant({ staged, attempt });
    expect(duplicate).toBe(first);
    await expect(
      completeLocalFilePlaybackParticipant({ staged, attempt: otherAttempt }),
    ).rejects.toThrow(/another attempt/);

    await resolveStarted(first, room, fixture.source);
    const result = await first;
    expect(result.attempt.rendezvousId).toBe('rv-split-primary');
    expect(room.manager.currentCutoverPort()).toBe(result.port);
    otherCoordinator.close();
    await room.manager.retireCurrentCutover(result.port);
  });

  it('fails closed when retirement re-enters immediately before participant commit', async () => {
    const room = roomHarness();
    const fixture = room.admit(Q1, 'split-retire-reentry', 'bounded-stream');
    let staged: Awaited<ReturnType<typeof stageLocalFilePlaybackParticipant>> | null = null;
    let retirement: Promise<void> | null = null;
    staged = await stageLocalFilePlaybackParticipant({
      ...splitStageOptions(fixture.options),
      runtimeForTests: {
        ...fixture.options.runtimeForTests,
        beforeParticipantCommitForTests: () => {
          retirement = retireLocalFilePlaybackParticipant(staged!, 'split-reentrant-retire');
        },
      },
    });
    const attempt = room.coordinator.start({
      run: staged.playbackState,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [staged.participant],
    });
    const pending = completeLocalFilePlaybackParticipant({ staged, attempt });

    await resolveStarted(pending, room, fixture.source);
    await expect(pending).rejects.toThrow(/retired/);
    await retirement;
    expect(attempt.getSnapshot()).toMatchObject({
      status: 'complete',
      participants: [{ finalizeStatus: 'accepted' }],
    });
    expect(room.manager.currentCutoverPort()).toBeNull();
    expect(fixture.source.stats.destroy).toHaveBeenCalledTimes(1);
  });

  it('retires a stage result that arrives after the caller aborts', async () => {
    const room = roomHarness();
    const fixture = room.admit(Q1, 'split-late-stage', 'audio-buffer');
    const controller = new AbortController();
    type StagedSource = Awaited<ReturnType<typeof stageFilePlaybackAssetSource>>;
    const stageReady = deferred<StagedSource>();
    const stageGate = deferred<StagedSource>();
    const actualStage = fixture.options.runtimeForTests!.stageAssetSourceForTests!;
    const pending = stageLocalFilePlaybackParticipant({
      ...splitStageOptions(fixture.options),
      signal: controller.signal,
      runtimeForTests: {
        stageAssetSourceForTests: async (options) => {
          const value = await actualStage(options);
          stageReady.resolve(value);
          return stageGate.promise;
        },
      },
    });
    const late = await stageReady.promise;
    controller.abort(new Error('split-stage-aborted'));
    await expect(pending).rejects.toThrow('split-stage-aborted');
    expect(fixture.source.stats.destroy).not.toHaveBeenCalled();

    stageGate.resolve(late);
    await drainMicrotasks();
    expect(room.manager.currentCutoverPort()).toBeNull();
    expect(fixture.source.stats.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps the compatibility API result equal to explicit stage/start/complete composition', async () => {
    const splitRoom = roomHarness(['rv-parity']);
    const splitFixture = splitRoom.admit(Q1, 'split-parity', 'audio-buffer');
    const staged = await stageLocalFilePlaybackParticipant(splitStageOptions(splitFixture.options));
    const attempt = splitRoom.coordinator.start({
      run: staged.playbackState,
      positionSeconds: splitFixture.options.positionSeconds,
      playbackRate: splitFixture.options.playbackRate,
      participants: [staged.participant],
    });
    const splitPending = completeLocalFilePlaybackParticipant({ staged, attempt });
    await resolveStarted(splitPending, splitRoom, splitFixture.source);
    const splitResult = await splitPending;

    const compatibilityRoom = roomHarness(['rv-parity']);
    const compatibilityFixture = compatibilityRoom.admit(Q1, 'split-parity', 'audio-buffer');
    const compatibilityPending = startLocalFilePlayback(compatibilityFixture.options);
    await resolveStarted(compatibilityPending, compatibilityRoom, compatibilityFixture.source);
    const compatibilityResult = await compatibilityPending;

    expect({
      backend: splitResult.backend,
      source: splitResult.source,
      asset: splitResult.asset,
      attempt: splitResult.attempt,
      schedule: splitResult.schedule,
      startEvidence: splitResult.startEvidence,
    }).toEqual({
      backend: compatibilityResult.backend,
      source: compatibilityResult.source,
      asset: compatibilityResult.asset,
      attempt: compatibilityResult.attempt,
      schedule: compatibilityResult.schedule,
      startEvidence: compatibilityResult.startEvidence,
    });
    await splitRoom.manager.retireCurrentCutover(splitResult.port);
    await compatibilityRoom.manager.retireCurrentCutover(compatibilityResult.port);
  });
});

describe('startLocalFilePlayback', () => {
  it.each([
    ['ordinary AudioBuffer', 'audio-buffer'],
    ['bounded FLAC', 'bounded-stream'],
  ] as const)(
    'routes %s and commits exact ARM -> FINALIZE -> start evidence',
    async (_, backend) => {
      const room = roomHarness();
      const fixture = room.admit(Q1, backend, backend);
      const pending = startLocalFilePlayback(fixture.options);
      await resolveStarted(pending, room, fixture.source);
      const result = await pending;

      expect(fixture.source.events.slice(0, 5)).toEqual([
        'prepare',
        'connect',
        'arm',
        'finalize',
        'start',
      ]);
      expect(result.backend).toBe(backend);
      expect(result.port).toBe(fixture.getPort());
      expect(room.manager.currentCutoverPort()).toBe(result.port);
      expect(result.attempt).toEqual({
        queueItemId: Q1,
        runId: `run:${backend}`,
        revision: 1,
        rendezvousId: 'rv-local-1',
      });
      expect(result.schedule).toMatchObject({
        positionSeconds: 0,
        playbackRate: 1,
        leadTimeMs: 450,
        finalizeByRoomTimeMs: 1_350,
        startAtRoomTimeMs: 1_450,
      });
      expect(result.startEvidence.kind).toBe(
        backend === 'audio-buffer' ? 'webaudio-schedule-passed' : 'worklet-observed',
      );
    },
  );

  it('returns a deeply frozen body-free authority record', async () => {
    const room = roomHarness();
    const fixture = room.admit(Q1, 'body-free', 'audio-buffer');
    const pending = startLocalFilePlayback(fixture.options);
    await resolveStarted(pending, room, fixture.source);
    const result = await pending;

    expect(Object.keys(result)).toEqual([
      'port',
      'backend',
      'source',
      'asset',
      'attempt',
      'schedule',
      'startEvidence',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.source)).toBe(true);
    expect(Object.isFrozen(result.source.metadata)).toBe(true);
    expect(Object.isFrozen(result.asset)).toBe(true);
    expect(Object.isFrozen(result.attempt)).toBe(true);
    expect(Object.isFrozen(result.schedule)).toBe(true);
    expect(Object.isFrozen(result.startEvidence)).toBe(true);
    expect(result.source).toEqual({
      identity: fixture.binding.sourceIdentity,
      metadata: { name: 'body-free.mp3', mime: 'audio/mpeg' },
    });
    expect(JSON.stringify(result)).not.toContain('audioBuffer');
    expect(JSON.stringify(result)).not.toContain('data:');
    expect(Reflect.ownKeys(result.port)).toHaveLength(0);
  });

  it('rejects a queue identity mismatch before staging anything', async () => {
    const room = roomHarness();
    const fixture = room.admit(Q1, 'qid-mismatch', 'audio-buffer');
    const stageAssetSourceForTests = vi.fn(
      fixture.options.runtimeForTests!.stageAssetSourceForTests,
    );
    await expect(
      startLocalFilePlayback({
        ...fixture.options,
        playbackState: { queueItemId: Q2, runId: 'run:mismatch', revision: 1 },
        runtimeForTests: { stageAssetSourceForTests },
      }),
    ).rejects.toThrow(/queue identities differ/);
    expect(stageAssetSourceForTests).not.toHaveBeenCalled();
    expect(room.manager.currentCutoverPort()).toBeNull();
  });

  it('aborts before staging without claiming a renderer slot', async () => {
    const room = roomHarness();
    const fixture = room.admit(Q1, 'abort-before', 'audio-buffer');
    const controller = new AbortController();
    controller.abort(new Error('abort-before-stage'));
    const stageAssetSourceForTests = vi.fn(
      fixture.options.runtimeForTests!.stageAssetSourceForTests,
    );
    await expect(
      startLocalFilePlayback({
        ...fixture.options,
        signal: controller.signal,
        runtimeForTests: { stageAssetSourceForTests },
      }),
    ).rejects.toThrow('abort-before-stage');
    expect(stageAssetSourceForTests).not.toHaveBeenCalled();
    expect(room.manager.currentCutoverPort()).toBeNull();
  });

  it('aborts after staging promptly while exact destruction is still pending', async () => {
    const room = roomHarness();
    const fixture = room.admit(Q1, 'abort-after', 'bounded-stream', {
      holdArm: true,
      holdDestroy: true,
    });
    const controller = new AbortController();
    const pending = startLocalFilePlayback({ ...fixture.options, signal: controller.signal });
    await drainMicrotasks();
    expect(fixture.source.stats.arm).toHaveBeenCalledTimes(1);
    controller.abort(new Error('abort-after-stage'));

    await expect(pending).rejects.toThrow('abort-after-stage');
    await drainMicrotasks();
    expect(room.manager.currentCutoverPort()).toBeNull();
    expect(fixture.source.stats.destroy).toHaveBeenCalledTimes(1);
    fixture.source.releaseArm();
    fixture.source.releaseDestroy();
    await drainMicrotasks();
  });

  it('retires the exact candidate when authority turns stale at start evidence', async () => {
    const room = roomHarness();
    const fixture = room.admit(Q1, 'stale-evidence', 'audio-buffer');
    const pending = startLocalFilePlayback(fixture.options);
    await drainMicrotasks();
    room.current.value = false;
    room.context.currentTime = fixture.source.startAtContextTime()!;
    fixture.source.resolveStart();

    await expect(pending).rejects.toThrow();
    await drainMicrotasks();
    expect(room.manager.currentCutoverPort()).toBeNull();
    expect(fixture.source.stats.destroy).toHaveBeenCalledTimes(1);
  });

  it('fails a raced logical commit and retires only its exact promoted port', async () => {
    const room = roomHarness();
    const fixture = room.admit(Q1, 'commit-race', 'bounded-stream');
    let retirement: Promise<boolean> | null = null;
    const pending = startLocalFilePlayback({
      ...fixture.options,
      runtimeForTests: {
        ...fixture.options.runtimeForTests,
        beforeParticipantCommitForTests: () => {
          retirement = room.manager.retireCurrentCutover(fixture.getPort()!);
        },
      },
    });
    await resolveStarted(pending, room, fixture.source);

    await expect(pending).rejects.toThrow(/commit was rejected/);
    await retirement;
    expect(room.manager.currentCutoverPort()).toBeNull();
    expect(fixture.source.stats.destroy).toHaveBeenCalledTimes(1);
  });

  it('preserves the old current when a replacement candidate fails before promotion', async () => {
    const room = roomHarness();
    const first = room.admit(Q1, 'old-current', 'audio-buffer');
    const firstPending = startLocalFilePlayback(first.options);
    await resolveStarted(firstPending, room, first.source);
    const current = await firstPending;

    const replacement = room.admit(Q2, 'failed-replacement', 'bounded-stream', {
      rejectArm: true,
    });
    await expect(
      startLocalFilePlayback({
        ...replacement.options,
        playbackState: { ...replacement.options.playbackState, revision: 2 },
      }),
    ).rejects.toThrow();
    await drainMicrotasks();
    expect(room.manager.currentCutoverPort()).toBe(current.port);
    expect(first.source.stats.destroy).not.toHaveBeenCalled();
    expect(replacement.source.stats.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid native evidence and retires the exact candidate', async () => {
    const room = roomHarness();
    const fixture = room.admit(Q1, 'invalid-evidence', 'bounded-stream', {
      invalidEvidence: true,
    });
    const pending = startLocalFilePlayback(fixture.options);
    await resolveStarted(pending, room, fixture.source);

    await expect(pending).rejects.toThrow();
    await drainMicrotasks();
    expect(room.manager.currentCutoverPort()).toBeNull();
    expect(fixture.source.stats.destroy).toHaveBeenCalledTimes(1);
  });

  it('uses one room coordinator for a committed start and its revision-2 replacement', async () => {
    const room = roomHarness(['rv-shared-1', 'rv-shared-2']);
    const first = room.admit(Q1, 'shared-first', 'audio-buffer');
    const firstPending = startLocalFilePlayback(first.options);
    await resolveStarted(firstPending, room, first.source);
    const firstResult = await firstPending;
    room.nowRoomTimeMs.value = 2_000;

    const second = room.admit(Q2, 'shared-second', 'bounded-stream');
    const secondPending = startLocalFilePlayback({
      ...second.options,
      playbackState: { ...second.options.playbackState, revision: 2 },
    });
    await resolveStarted(secondPending, room, second.source);
    const result = await secondPending;

    expect(firstResult.attempt.rendezvousId).toBe('rv-shared-1');
    expect(result.attempt.rendezvousId).toBe('rv-shared-2');
    expect(room.manager.currentCutoverPort()).toBe(result.port);
    await drainMicrotasks();
    expect(first.source.stats.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects equal-revision candidates before staging and preserves the current renderer', async () => {
    const room = roomHarness(['rv-current', 'rv-unused']);
    const first = room.admit(Q1, 'same-state-first', 'audio-buffer');
    const firstPending = startLocalFilePlayback(first.options);
    await resolveStarted(firstPending, room, first.source);
    const current = await firstPending;

    const replacement = room.admit(Q2, 'equal-revision', 'bounded-stream');
    const replacementStage = vi.fn(replacement.options.runtimeForTests!.stageAssetSourceForTests);
    const sameStateOptions: StartLocalFilePlaybackOptions = {
      ...replacement.options,
      runtimeForTests: { stageAssetSourceForTests: replacementStage },
    };
    await expect(startLocalFilePlayback(sameStateOptions)).rejects.toThrow(/exact next.*revision/);
    expect(replacementStage).not.toHaveBeenCalled();
    expect(room.manager.currentCutoverPort()).toBe(current.port);
    expect(replacement.source.stats.destroy).not.toHaveBeenCalled();
  });

  it('rejects a revision gap before staging and preserves the current renderer', async () => {
    const room = roomHarness(['rv-current', 'rv-unused']);
    const first = room.admit(Q1, 'gap-current', 'audio-buffer');
    const firstPending = startLocalFilePlayback(first.options);
    await resolveStarted(firstPending, room, first.source);
    const current = await firstPending;

    const replacement = room.admit(Q2, 'gap-replacement', 'bounded-stream');
    const replacementStage = vi.fn(replacement.options.runtimeForTests!.stageAssetSourceForTests);
    await expect(
      startLocalFilePlayback({
        ...replacement.options,
        playbackState: { ...replacement.options.playbackState, revision: 3 },
        runtimeForTests: { stageAssetSourceForTests: replacementStage },
      }),
    ).rejects.toThrow(/exact next.*revision/);
    expect(replacementStage).not.toHaveBeenCalled();
    expect(room.manager.currentCutoverPort()).toBe(current.port);
    expect(replacement.source.stats.destroy).not.toHaveBeenCalled();
  });
});
