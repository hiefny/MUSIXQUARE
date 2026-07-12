import { describe, expect, it } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  createFilePlaybackCutoverTarget,
  createFilePlaybackRejectedTransitionResult,
  createStreamingFlacPlaybackStartEvidence,
  type FilePlaybackCancelIntent,
  type FilePlaybackCutoverArmResult,
  type FilePlaybackCutoverSource,
  type FilePlaybackSourcePhase,
  type FilePlaybackSourceSnapshot,
  type FilePlaybackStartEvidence,
  type FilePlaybackTransitionIntent,
  type FilePlaybackTransitionResult,
} from '../file-playback-source.ts';
import {
  FilePlaybackManager,
  type FilePlaybackCutoverCandidatePort,
} from '../file-playback-manager.ts';
import { ManagerCutoverRendezvousParticipant } from '../manager-cutover-rendezvous-participant.ts';
import type { PlaybackAttemptIdentity } from '../playback-identity.ts';
import type {
  RendezvousArmIntent,
  RendezvousArmReceipt,
  RendezvousFinalizeIntent,
  RendezvousFinalizeReceipt,
} from '../rendezvous-contract.ts';
import { HostRendezvousCoordinator } from '../rendezvous-coordinator.ts';

const Q1 = '00000000-0000-4000-8000-000000000901' as QueueItemId;
const Q2 = '00000000-0000-4000-8000-000000000902' as QueueItemId;
const PARTICIPANT_ID = 'local-cutover';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function drainMicrotasks(turns = 24): Promise<void> {
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

function armIntent(overrides: Partial<RendezvousArmIntent> = {}): RendezvousArmIntent {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-arm',
    queueItemId: Q1,
    runId: 'run-cutover-1',
    revision: 1,
    rendezvousId: 'rv-cutover-1',
    recipientId: PARTICIPANT_ID,
    positionSeconds: 0,
    playbackRate: 1,
    startAtRoomTimeMs: 2_000,
    finalizeByRoomTimeMs: 1_800,
    ...overrides,
  };
}

function finalizeIntent(
  overrides: Partial<RendezvousFinalizeIntent> = {},
): RendezvousFinalizeIntent {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-finalize',
    queueItemId: Q1,
    runId: 'run-cutover-1',
    revision: 1,
    rendezvousId: 'rv-cutover-1',
    recipientId: PARTICIPANT_ID,
    startAtRoomTimeMs: 2_000,
    finalizedAtRoomTimeMs: 1_700,
    ...overrides,
  };
}

function identity(overrides: Partial<PlaybackAttemptIdentity> = {}): PlaybackAttemptIdentity {
  return {
    queueItemId: Q1,
    runId: 'run-cutover-1',
    revision: 1,
    rendezvousId: 'rv-cutover-1',
    ...overrides,
  };
}

function cancelIntent(overrides: Partial<FilePlaybackCancelIntent> = {}): FilePlaybackCancelIntent {
  return {
    kind: 'file-playback-cancel',
    ...identity(),
    reasonCode: 'test-cancel',
    ...overrides,
  };
}

function armedReceipt(intent: RendezvousArmIntent): RendezvousArmReceipt {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-armed',
    queueItemId: intent.queueItemId,
    runId: intent.runId,
    revision: intent.revision,
    rendezvousId: intent.rendezvousId,
    participantId: intent.recipientId,
    status: 'armed',
    observedAtRoomTimeMs: intent.finalizeByRoomTimeMs,
    bufferedAheadSeconds: 8,
    reasonCode: null,
  };
}

function acceptedReceipt(intent: RendezvousFinalizeIntent): RendezvousFinalizeReceipt {
  return {
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
  };
}

interface FakeSourceOptions {
  readonly holdDestroy?: boolean;
  readonly holdArm?: boolean;
  readonly invalidArmResult?: boolean;
  readonly startedPromise?: Promise<FilePlaybackStartEvidence>;
  readonly onArm?: () => void;
}

interface FakeCutoverSource {
  readonly source: FilePlaybackCutoverSource;
  readonly stats: {
    armCalls: number;
    finalizeCalls: number;
    destroyCalls: number;
  };
  resolveStarted(): void;
  resolveInvalidStarted(): void;
  releaseArm(): void;
  releaseDestroy(): void;
}

function makeSource(
  queueItemId: QueueItemId,
  context: FakeAudioContext,
  targetTimeSeconds: number,
  options: FakeSourceOptions = {},
): FakeCutoverSource {
  let phase: FilePlaybackSourcePhase = 'new';
  let revision = 0;
  let run: FilePlaybackSourceSnapshot['run'] = null;
  const targetFrame = Math.round(targetTimeSeconds * context.sampleRate);
  const started = deferred<FilePlaybackStartEvidence>();
  const armGate = deferred<FilePlaybackCutoverArmResult>();
  const destroyGate = deferred<void>();
  const stats = { armCalls: 0, finalizeCalls: 0, destroyCalls: 0 };
  const startedPromise = options.startedPromise ?? started.promise;
  let pendingArmResult: FilePlaybackCutoverArmResult | null = null;
  void startedPromise.then(
    () => undefined,
    () => undefined,
  );

  const snapshot = (): FilePlaybackSourceSnapshot => ({
    schemaVersion: 1,
    queueItemId,
    backend: 'streaming-flac',
    phase,
    revision,
    run,
    durationSeconds: 60,
    positionSeconds: 0,
    bufferedAheadSeconds: phase === 'new' || phase === 'preparing' ? 0 : 8,
    outputSampleRateHz: context.sampleRate,
    channelCount: 2,
    underrunCount: 0,
    errorCode: null,
  });
  const target = () =>
    createFilePlaybackCutoverTarget(
      context as unknown as AudioContext,
      targetTimeSeconds,
      targetFrame,
    );
  const rejectedTransition = (intent: FilePlaybackTransitionIntent): FilePlaybackTransitionResult =>
    createFilePlaybackRejectedTransitionResult(intent, 'wrong-phase', snapshot());

  const source: FilePlaybackCutoverSource = {
    queueItemId,
    backend: 'streaming-flac',
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
      stats.armCalls += 1;
      phase = 'armed';
      revision = intent.revision;
      run = Object.freeze({
        queueItemId: intent.queueItemId,
        runId: intent.runId,
        revision: intent.revision,
      });
      const result = {
        status: 'armed' as const,
        receipt: options.invalidArmResult
          ? { ...armedReceipt(intent), rendezvousId: 'rv-hostile-result' }
          : armedReceipt(intent),
        target: target(),
        started: startedPromise,
      };
      const frozen = Object.freeze(result) as FilePlaybackCutoverArmResult;
      options.onArm?.();
      if (options.holdArm) {
        pendingArmResult = frozen;
        return armGate.promise;
      }
      return frozen;
    },
    async finalize(intent) {
      stats.finalizeCalls += 1;
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
      stats.destroyCalls += 1;
      phase = 'destroyed';
      if (options.holdDestroy) await destroyGate.promise;
    },
  };

  return {
    source,
    stats,
    resolveStarted() {
      phase = 'playing';
      started.resolve(createStreamingFlacPlaybackStartEvidence(targetFrame, targetFrame));
    },
    resolveInvalidStarted() {
      phase = 'playing';
      started.resolve({
        kind: 'worklet-observed',
        targetFrame: targetFrame + 1,
        actualStartFrame: targetFrame + 1,
      });
    },
    releaseArm() {
      if (pendingArmResult === null) throw new Error('No arm result is pending');
      armGate.resolve(pendingArmResult);
      pendingArmResult = null;
    },
    releaseDestroy() {
      destroyGate.resolve();
    },
  };
}

interface StagedFixtureOptions extends FakeSourceOptions {
  readonly queueItemId?: QueueItemId;
  readonly targetTimeSeconds?: number;
  readonly participantId?: string;
  readonly manager?: FilePlaybackManager;
  readonly context?: FakeAudioContext;
}

async function stagedFixture(options: StagedFixtureOptions = {}) {
  const manager = options.manager ?? new FilePlaybackManager();
  const context = options.context ?? new FakeAudioContext();
  const destination = destinationFor(context);
  const fake = makeSource(
    options.queueItemId ?? Q1,
    context,
    options.targetTimeSeconds ?? 1,
    options,
  );
  const port = await manager.stageCutoverCandidate({ source: fake.source, destination });
  const adapter = new ManagerCutoverRendezvousParticipant({
    participantId: options.participantId ?? PARTICIPANT_ID,
    rttP95Ms: 25,
    armP95Ms: 80,
    manager,
    candidatePort: port,
  });
  return { manager, context, destination, fake, port, adapter };
}

async function armAndFinalize(fixture: Awaited<ReturnType<typeof stagedFixture>>): Promise<void> {
  await expect(fixture.adapter.arm(armIntent())).resolves.toMatchObject({ status: 'armed' });
  await expect(fixture.adapter.finalize(finalizeIntent())).resolves.toMatchObject({
    status: 'accepted',
  });
}

describe('ManagerCutoverRendezvousParticipant', () => {
  it('locks exact descriptor-safe public identity and rejects non-concrete managers', () => {
    const manager = new FilePlaybackManager();
    const candidatePort = {} as FilePlaybackCutoverCandidatePort;
    let getterCalls = 0;
    const accessorOptions = {
      participantId: PARTICIPANT_ID,
      rttP95Ms: 20,
      armP95Ms: 60,
      manager,
      candidatePort,
    };
    Object.defineProperty(accessorOptions, 'participantId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return PARTICIPANT_ID;
      },
    });
    expect(() => new ManagerCutoverRendezvousParticipant(accessorOptions)).toThrow(TypeError);
    expect(getterCalls).toBe(0);
    expect(
      () =>
        new ManagerCutoverRendezvousParticipant({
          participantId: 'bad\npeer',
          rttP95Ms: 20,
          armP95Ms: 60,
          manager,
          candidatePort,
        }),
    ).toThrow(TypeError);

    const adapter = new ManagerCutoverRendezvousParticipant({
      participantId: PARTICIPANT_ID,
      rttP95Ms: 20,
      armP95Ms: 60,
      manager,
      candidatePort,
    });
    expect(Object.getOwnPropertyDescriptor(adapter, 'participantId')).toMatchObject({
      value: PARTICIPANT_ID,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    expect(Reflect.set(adapter, 'participantId', 'mutated')).toBe(false);
    expect(() => Object.defineProperty(adapter, 'rttP95Ms', { value: 999 })).toThrow();
    expect(Object.isExtensible(adapter)).toBe(false);

    class HostileSubclass extends FilePlaybackManager {}
    const subclass = new HostileSubclass();
    Object.setPrototypeOf(subclass, FilePlaybackManager.prototype);
    expect(
      () =>
        new ManagerCutoverRendezvousParticipant({
          participantId: PARTICIPANT_ID,
          rttP95Ms: 20,
          armP95Ms: 60,
          manager: subclass,
          candidatePort,
        }),
    ).toThrow(/FilePlaybackManager/);
    expect(
      () =>
        new ManagerCutoverRendezvousParticipant({
          participantId: PARTICIPANT_ID,
          rttP95Ms: 20,
          armP95Ms: 60,
          manager: new Proxy(manager, {}),
          candidatePort,
        }),
    ).toThrow(/FilePlaybackManager/);
  });

  it('uses one stable started promise before finalize, then verifies physical current and commits', async () => {
    const h = await stagedFixture();
    const armOne = h.adapter.arm(armIntent());
    const startedBeforeArm = h.adapter.started(identity());
    const armTwo = h.adapter.arm({ ...armIntent() });
    expect(armTwo).toBe(armOne);
    await expect(armOne).resolves.toMatchObject({ status: 'armed' });
    expect(h.fake.stats.armCalls).toBe(1);

    const startedBeforeFinalize = h.adapter.started({ ...identity() });
    expect(startedBeforeFinalize).toBe(startedBeforeArm);
    const finalizeOne = h.adapter.finalize(finalizeIntent());
    const finalizeTwo = h.adapter.finalize({ ...finalizeIntent() });
    expect(finalizeTwo).toBe(finalizeOne);
    await expect(finalizeOne).resolves.toMatchObject({ status: 'accepted' });
    expect(h.fake.stats.finalizeCalls).toBe(1);
    expect(h.adapter.commitAttempt(identity())).toBe(false);

    h.context.currentTime = 1;
    h.fake.resolveStarted();
    await expect(startedBeforeArm).resolves.toMatchObject({ targetFrame: 48_000 });
    expect(h.manager.currentCutoverPort()).toBe(h.port);
    expect(h.adapter.commitAttempt(identity())).toBe(true);
    expect(h.adapter.commitAttempt({ ...identity() })).toBe(true);
    await h.adapter.cancel(cancelIntent());
    expect(h.manager.currentCutoverPort()).toBe(h.port);
    expect(h.fake.stats.destroyCalls).toBe(0);
  });

  it('integrates coordinator accepted -> exact evidence -> logical commit in controller order', async () => {
    const h = await stagedFixture();
    const coordinator = new HostRendezvousCoordinator({
      nowRoomTimeMs: () => 10_000,
      createRendezvousId: () => 'rv-coordinator-real-manager',
    });
    const attempt = coordinator.start({
      run: { queueItemId: Q1, runId: 'run-coordinator', revision: 1 },
      positionSeconds: 0,
      playbackRate: 1,
      participants: [h.adapter],
    });
    const exactIdentity = {
      queueItemId: Q1,
      runId: 'run-coordinator',
      revision: 1,
      rendezvousId: attempt.rendezvousId,
    };
    const started = h.adapter.started(exactIdentity);
    expect(h.adapter.started({ ...exactIdentity })).toBe(started);
    expect(attempt.commitParticipant(PARTICIPANT_ID)).toBe(false);

    await drainMicrotasks();
    expect(attempt.getSnapshot()).toMatchObject({
      status: 'complete',
      participants: [{ armStatus: 'armed', finalizeStatus: 'accepted' }],
    });
    expect(attempt.commitParticipant(PARTICIPANT_ID)).toBe(false);
    h.context.currentTime = 1;
    h.fake.resolveStarted();
    await expect(started).resolves.toMatchObject({ targetFrame: 48_000 });
    expect(attempt.commitParticipant(PARTICIPANT_ID)).toBe(true);
    expect(h.manager.currentCutoverPort()).toBe(h.port);
  });

  it('rejects an already-returned started promise immediately while cleanup stays pending', async () => {
    const h = await stagedFixture({ holdDestroy: true });
    const arm = h.adapter.arm(armIntent());
    const started = h.adapter.started(identity());
    await arm;
    await h.adapter.finalize(finalizeIntent());
    let cancellationSettled = false;
    const cancellation = h.adapter.cancel(cancelIntent()).then(() => {
      cancellationSettled = true;
    });

    await expect(started).rejects.toThrow('retired');
    expect(h.adapter.started({ ...identity() })).toBe(started);
    expect(cancellationSettled).toBe(false);
    expect(h.fake.stats.destroyCalls).toBe(1);
    h.fake.releaseDestroy();
    await cancellation;
  });

  it('retires an exact promoted current before commit but makes committed cancellation a no-op', async () => {
    const retired = await stagedFixture();
    await armAndFinalize(retired);
    const retiredStarted = retired.adapter.started(identity());
    retired.context.currentTime = 1;
    retired.fake.resolveStarted();
    await retiredStarted;
    await retired.adapter.cancel(cancelIntent());
    expect(retired.manager.currentCutoverPort()).toBeNull();
    expect(retired.fake.stats.destroyCalls).toBe(1);
    expect(retired.adapter.commitAttempt(identity())).toBe(false);

    const committed = await stagedFixture();
    await armAndFinalize(committed);
    const committedStarted = committed.adapter.started(identity());
    committed.context.currentTime = 1;
    committed.fake.resolveStarted();
    await committedStarted;
    expect(committed.adapter.commitAttempt(identity())).toBe(true);
    await committed.adapter.cancel(cancelIntent());
    expect(committed.manager.currentCutoverPort()).toBe(committed.port);
    expect(committed.fake.stats.destroyCalls).toBe(0);
  });

  it('supersedes a one-shot port and keeps the same rejected started promise', async () => {
    const h = await stagedFixture();
    const first = h.adapter.arm(armIntent());
    const started = h.adapter.started(identity());
    await expect(
      h.adapter.arm(
        armIntent({
          revision: 2,
          rendezvousId: 'rv-cutover-2',
          startAtRoomTimeMs: 3_000,
          finalizeByRoomTimeMs: 2_800,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'cutover-attempt-superseded',
    });
    await expect(first).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'cutover-attempt-retired',
    });
    await expect(started).rejects.toThrow('retired');
    expect(h.adapter.started(identity())).toBe(started);
    await h.adapter.cancel(cancelIntent());
    expect(h.fake.stats.armCalls).toBe(0);
    expect(h.fake.stats.destroyCalls).toBe(1);
  });

  it('retires on a conflicting finalize while preserving exact retry identity', async () => {
    const h = await stagedFixture();
    await h.adapter.arm(armIntent());
    const started = h.adapter.started(identity());
    const first = h.adapter.finalize(finalizeIntent());
    await expect(
      h.adapter.finalize(finalizeIntent({ finalizedAtRoomTimeMs: 1_650 })),
    ).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'cutover-finalize-conflict',
    });
    await expect(first).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'cutover-attempt-retired',
    });
    await expect(started).rejects.toThrow('retired');
    expect(h.fake.stats.finalizeCalls).toBe(0);
    await h.adapter.cancel(cancelIntent());
  });

  it('ignores invalid and wrong identities without disturbing the exact operation', async () => {
    const h = await stagedFixture();
    await expect(
      h.adapter.arm(armIntent({ recipientId: 'another-participant' })),
    ).resolves.toMatchObject({ status: 'rejected', reasonCode: 'cutover-participant-mismatch' });
    await expect(h.adapter.started(identity())).rejects.toThrow('unavailable');

    await h.adapter.arm(armIntent());
    const exactStarted = h.adapter.started(identity());
    await expect(
      h.adapter.finalize(finalizeIntent({ rendezvousId: 'rv-wrong' })),
    ).resolves.toMatchObject({ status: 'rejected', reasonCode: 'cutover-attempt-not-armed' });
    await expect(h.adapter.started(identity({ rendezvousId: 'rv-wrong' }))).rejects.toThrow(
      'unavailable',
    );
    expect(h.adapter.commitAttempt(identity({ queueItemId: Q2 }))).toBe(false);
    await h.adapter.cancel(cancelIntent({ queueItemId: Q2 }));
    expect(h.fake.stats.destroyCalls).toBe(0);
    expect(h.adapter.started(identity())).toBe(exactStarted);
    await h.adapter.cancel(cancelIntent());
    await expect(exactStarted).rejects.toThrow('retired');
  });

  it('fails closed on hostile source results and evidence through the real manager boundary', async () => {
    const invalidArm = await stagedFixture({ invalidArmResult: true });
    const invalidArmStarted = (() => {
      const pending = invalidArm.adapter.arm(armIntent());
      const started = invalidArm.adapter.started(identity());
      return { pending, started };
    })();
    await expect(invalidArmStarted.pending).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'cutover-manager-arm-failed',
    });
    await expect(invalidArmStarted.started).rejects.toThrow('retired');
    expect(invalidArm.adapter.commitAttempt(identity())).toBe(false);
    expect(invalidArm.fake.stats.destroyCalls).toBe(1);

    const invalidEvidence = await stagedFixture();
    await armAndFinalize(invalidEvidence);
    const started = invalidEvidence.adapter.started(identity());
    invalidEvidence.context.currentTime = 1;
    invalidEvidence.fake.resolveInvalidStarted();
    await expect(started).rejects.toThrow();
    expect(invalidEvidence.adapter.commitAttempt(identity())).toBe(false);
    expect(invalidEvidence.manager.currentCutoverPort()).toBeNull();
  });

  it('cannot revive after a real source re-enters cancellation from armForCutover', async () => {
    let adapter!: ManagerCutoverRendezvousParticipant;
    let reenteredCancellation: Promise<void> | null = null;
    const h = await stagedFixture({
      onArm: () => {
        reenteredCancellation = adapter.cancel(cancelIntent());
      },
    });
    adapter = h.adapter;
    const pending = adapter.arm(armIntent());
    const started = adapter.started(identity());

    await expect(pending).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'cutover-attempt-retired',
    });
    await expect(started).rejects.toThrow('retired');
    await reenteredCancellation;
    expect(h.fake.stats.armCalls).toBe(1);
    expect(h.fake.stats.destroyCalls).toBe(1);
    expect(h.manager.currentCutoverPort()).toBeNull();
    expect(adapter.commitAttempt(identity())).toBe(false);
  });

  it('cancels a coordinator-dispatched pending manager arm and ignores its late result', async () => {
    const h = await stagedFixture({ holdArm: true });
    const coordinator = new HostRendezvousCoordinator({
      nowRoomTimeMs: () => 10_000,
      createRendezvousId: () => 'rv-pending-cancel',
    });
    const run = { queueItemId: Q1, runId: 'run-pending-cancel', revision: 1 };
    const attempt = coordinator.start({
      run,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [h.adapter],
    });
    const started = h.adapter.started({ ...run, rendezvousId: attempt.rendezvousId });
    await drainMicrotasks();
    expect(h.fake.stats.armCalls).toBe(1);

    attempt.cancel('user-cancelled-pending-arm');
    await expect(started).rejects.toThrow('retired');
    await drainMicrotasks();
    expect(h.fake.stats.destroyCalls).toBe(1);
    h.fake.releaseArm();
    await drainMicrotasks();
    expect(attempt.getSnapshot()).toMatchObject({
      status: 'cancelled',
      participants: [{ armStatus: 'stale', finalizeStatus: 'stale' }],
    });
    expect(h.manager.currentCutoverPort()).toBeNull();
  });

  it('retires a pending manager arm on same-state replacement before late completion', async () => {
    const h = await stagedFixture({ holdArm: true });
    const ids = ['rv-replaced-pending', 'rv-replacement-empty'];
    const coordinator = new HostRendezvousCoordinator({
      nowRoomTimeMs: () => 11_000,
      createRendezvousId: () => ids.shift()!,
    });
    const run = { queueItemId: Q1, runId: 'run-replaced-pending', revision: 1 };
    const replaced = coordinator.start({
      run,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [h.adapter],
    });
    const started = h.adapter.started({ ...run, rendezvousId: replaced.rendezvousId });
    await drainMicrotasks();
    expect(h.fake.stats.armCalls).toBe(1);

    const replacement = coordinator.start({
      run,
      positionSeconds: 1,
      playbackRate: 1,
      participants: [],
    });
    await expect(started).rejects.toThrow('retired');
    await drainMicrotasks();
    expect(h.fake.stats.destroyCalls).toBe(1);
    h.fake.releaseArm();
    await drainMicrotasks();
    expect(replaced.getSnapshot().status).toBe('superseded');
    expect(replacement.getSnapshot().status).toBe('complete');
    expect(h.manager.currentCutoverPort()).toBeNull();
  });

  it('auto-retires pending and armed manager candidates on terminal deadlines', async () => {
    let pendingNow = 12_000;
    const pending = await stagedFixture({ holdArm: true });
    const pendingCoordinator = new HostRendezvousCoordinator({
      nowRoomTimeMs: () => pendingNow,
      createRendezvousId: () => 'rv-expired-pending',
    });
    const pendingRun = { queueItemId: Q1, runId: 'run-expired-pending', revision: 1 };
    const pendingAttempt = pendingCoordinator.start({
      run: pendingRun,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [pending.adapter],
    });
    const pendingStarted = pending.adapter.started({
      ...pendingRun,
      rendezvousId: pendingAttempt.rendezvousId,
    });
    await drainMicrotasks();
    pendingNow = pendingAttempt.finalizeByRoomTimeMs + 1;
    expect(pendingAttempt.expire().status).toBe('complete');
    await expect(pendingStarted).rejects.toThrow('retired');
    await drainMicrotasks();
    expect(pending.fake.stats.destroyCalls).toBe(1);
    pending.fake.releaseArm();
    await drainMicrotasks();
    expect(pending.manager.currentCutoverPort()).toBeNull();

    let lateNow = 13_000;
    const late = await stagedFixture({ holdArm: true });
    const lateCoordinator = new HostRendezvousCoordinator({
      nowRoomTimeMs: () => lateNow,
      createRendezvousId: () => 'rv-late-arm-receipt',
    });
    const lateRun = { queueItemId: Q1, runId: 'run-late-arm', revision: 1 };
    const lateAttempt = lateCoordinator.start({
      run: lateRun,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [late.adapter],
    });
    const lateStarted = late.adapter.started({
      ...lateRun,
      rendezvousId: lateAttempt.rendezvousId,
    });
    await drainMicrotasks();
    lateNow = lateAttempt.finalizeByRoomTimeMs + 1;
    late.fake.releaseArm();
    await drainMicrotasks();
    await expect(lateStarted).rejects.toThrow('retired');
    expect(lateAttempt.getSnapshot()).toMatchObject({
      status: 'complete',
      participants: [{ armStatus: 'armed', finalizeStatus: 'missed-deadline' }],
    });
    expect(late.fake.stats.finalizeCalls).toBe(0);
    expect(late.fake.stats.destroyCalls).toBe(1);
    expect(late.manager.currentCutoverPort()).toBeNull();
  });

  it('rejects commit after manager replacement without retiring the replacement', async () => {
    const h = await stagedFixture();
    await armAndFinalize(h);
    const started = h.adapter.started(identity());
    h.context.currentTime = 1;
    h.fake.resolveStarted();
    await started;

    const replacement = makeSource(Q2, h.context, 2);
    const replacementPort = await h.manager.stageCutoverCandidate({
      source: replacement.source,
      destination: h.destination,
    });
    const replacementArm = armIntent({
      queueItemId: Q2,
      runId: 'run-replacement',
      rendezvousId: 'rv-replacement',
      startAtRoomTimeMs: 3_000,
      finalizeByRoomTimeMs: 2_800,
    });
    await h.manager.armCutoverCandidate(replacementPort, replacementArm);
    const replacementFinalization = await h.manager.finalizeCutoverCandidate(
      replacementPort,
      finalizeIntent({
        queueItemId: Q2,
        runId: 'run-replacement',
        rendezvousId: 'rv-replacement',
        startAtRoomTimeMs: 3_000,
        finalizedAtRoomTimeMs: 2_700,
      }),
    );
    h.context.currentTime = 2;
    replacement.resolveStarted();
    await replacementFinalization.started;
    expect(h.manager.currentCutoverPort()).toBe(replacementPort);

    expect(h.adapter.commitAttempt(identity())).toBe(false);
    await drainMicrotasks();
    expect(h.manager.currentCutoverPort()).toBe(replacementPort);
    await h.manager.retireCurrentCutover(replacementPort);
  });

  it('keeps an old committed current isolated from a silent recovery adapter', async () => {
    const current = await stagedFixture();
    await armAndFinalize(current);
    const currentStarted = current.adapter.started(identity());
    current.context.currentTime = 1;
    current.fake.resolveStarted();
    await currentStarted;
    expect(current.adapter.commitAttempt(identity())).toBe(true);

    const recovery = await stagedFixture({
      manager: current.manager,
      context: current.context,
      queueItemId: Q2,
      targetTimeSeconds: 2,
      participantId: 'recovery-cutover',
    });
    const recoveryArm = armIntent({
      queueItemId: Q2,
      runId: 'run-recovery',
      rendezvousId: 'rv-recovery',
      recipientId: 'recovery-cutover',
      startAtRoomTimeMs: 3_000,
      finalizeByRoomTimeMs: 2_800,
    });
    const recoveryIdentity = identity({
      queueItemId: Q2,
      runId: 'run-recovery',
      rendezvousId: 'rv-recovery',
    });
    await recovery.adapter.arm(recoveryArm);
    const recoveryStarted = recovery.adapter.started(recoveryIdentity);
    await recovery.adapter.finalize(
      finalizeIntent({
        queueItemId: Q2,
        runId: 'run-recovery',
        rendezvousId: 'rv-recovery',
        recipientId: 'recovery-cutover',
        startAtRoomTimeMs: 3_000,
        finalizedAtRoomTimeMs: 2_700,
      }),
    );
    expect(current.manager.currentCutoverPort()).toBe(current.port);
    await recovery.adapter.cancel(
      cancelIntent({
        queueItemId: Q2,
        runId: 'run-recovery',
        rendezvousId: 'rv-recovery',
      }),
    );
    await expect(recoveryStarted).rejects.toThrow('retired');
    expect(current.manager.currentCutoverPort()).toBe(current.port);
    expect(current.adapter.commitAttempt(identity())).toBe(true);
    await current.manager.retireCurrentCutover(current.port);
  });

  it('bypasses hostile own method shadows and cannot forge a commit without manager state', async () => {
    const manager = new FilePlaybackManager();
    const port = Object.freeze(Object.create(null)) as FilePlaybackCutoverCandidatePort;
    const context = new FakeAudioContext();
    const target = createFilePlaybackCutoverTarget(context as unknown as AudioContext, 1, 48_000);
    const evidence = Promise.resolve(createStreamingFlacPlaybackStartEvidence(48_000, 48_000));
    const calls = { arm: 0, finalize: 0, current: 0, retireCandidate: 0, retireCurrent: 0 };
    Object.defineProperties(manager, {
      armCutoverCandidate: {
        value: async (_port: FilePlaybackCutoverCandidatePort, intent: RendezvousArmIntent) => {
          calls.arm += 1;
          return { status: 'armed', receipt: armedReceipt(intent), target, started: evidence };
        },
      },
      finalizeCutoverCandidate: {
        value: async (
          _port: FilePlaybackCutoverCandidatePort,
          intent: RendezvousFinalizeIntent,
        ) => {
          calls.finalize += 1;
          return { receipt: acceptedReceipt(intent), target, started: evidence };
        },
      },
      currentCutoverPort: {
        value: () => {
          calls.current += 1;
          return port;
        },
      },
      retireCutoverCandidate: {
        value: async () => {
          calls.retireCandidate += 1;
          return true;
        },
      },
      retireCurrentCutover: {
        value: async () => {
          calls.retireCurrent += 1;
          return true;
        },
      },
    });
    const adapter = new ManagerCutoverRendezvousParticipant({
      participantId: PARTICIPANT_ID,
      rttP95Ms: 0,
      armP95Ms: 0,
      manager,
      candidatePort: port,
    });
    const pending = adapter.arm(armIntent());
    const started = adapter.started(identity());
    await expect(pending).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'cutover-manager-arm-failed',
    });
    await expect(started).rejects.toThrow('retired');
    expect(adapter.commitAttempt(identity())).toBe(false);
    expect(calls).toEqual({
      arm: 0,
      finalize: 0,
      current: 0,
      retireCandidate: 0,
      retireCurrent: 0,
    });
  });

  it('does not leak an unhandled rejection when a fulfilled value later becomes a hostile thenable', async () => {
    const fulfilledValue = {
      kind: 'worklet-observed' as const,
      targetFrame: 48_000,
      actualStartFrame: 48_000,
    };
    const hostileStarted = Promise.resolve(fulfilledValue);
    Object.defineProperty(fulfilledValue, 'then', {
      configurable: true,
      get() {
        throw new Error('derived promise must not assimilate this value');
      },
    });
    const h = await stagedFixture({
      startedPromise: hostileStarted as Promise<FilePlaybackStartEvidence>,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const pending = h.adapter.arm(armIntent());
      const started = h.adapter.started(identity());
      await expect(pending).resolves.toMatchObject({ status: 'armed' });
      await h.adapter.cancel(cancelIntent());
      await expect(started).rejects.toThrow('retired');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
