import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import type { FilePlaybackEndedTransitionIntent } from '../file-playback-ended-transition.ts';
import type { FilePlaybackRemoteEndedTransitionIntent } from '../file-playback-remote-ended-transition.ts';
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
  type FilePlaybackTransitionEvidence,
  type FilePlaybackTransitionIntent,
  type FilePlaybackTransitionResult,
} from '../file-playback-source.ts';
import {
  FilePlaybackManager,
  isExactFilePlaybackManager,
  type FilePlaybackCutoverCandidatePort,
} from '../file-playback-manager.ts';
import type { FilePlaybackStopTransitionIntent } from '../file-playback-stop-transition.ts';
import type {
  RendezvousArmIntent,
  RendezvousArmReceipt,
  RendezvousFinalizeIntent,
  RendezvousFinalizeReceipt,
} from '../rendezvous-contract.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface GainEvent {
  readonly value: number;
  readonly time: number;
}

class FakeAudioParam {
  readonly events: GainEvent[] = [];
  throwOnValue: number | null = null;
  onSet: ((value: number, time: number) => void) | null = null;

  cancelScheduledValues(time: number): AudioParam {
    const retained = this.events.filter((event) => event.time < time);
    this.events.splice(0, this.events.length, ...retained);
    return this as unknown as AudioParam;
  }

  setValueAtTime(value: number, time: number): AudioParam {
    if (this.throwOnValue === value) throw new Error('gate automation failed');
    this.events.push({ value, time });
    this.onSet?.(value, time);
    return this as unknown as AudioParam;
  }

  valueAt(time: number): number {
    return (
      this.events
        .filter((event) => event.time <= time)
        .sort((left, right) => left.time - right.time)
        .at(-1)?.value ?? 1
    );
  }
}

class FakeGainNode {
  readonly gain = new FakeAudioParam();
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();

  constructor(readonly context: FakeAudioContext) {}
}

class FakeAudioContext {
  #currentTime = 0;
  readonly sampleRate = 48_000;
  state: AudioContextState = 'running';
  readonly gains: FakeGainNode[] = [];
  onCurrentTimeRead: (() => void) | null = null;

  get currentTime(): number {
    this.onCurrentTimeRead?.();
    return this.#currentTime;
  }

  set currentTime(value: number) {
    this.#currentTime = value;
  }

  createGain(): GainNode {
    const gain = new FakeGainNode(this);
    this.gains.push(gain);
    return gain as unknown as GainNode;
  }
}

function destinationFor(context: FakeAudioContext): AudioNode {
  return { context } as unknown as AudioNode;
}

const Q1 = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const Q2 = '00000000-0000-4000-8000-000000000002' as QueueItemId;
const Q3 = '00000000-0000-4000-8000-000000000003' as QueueItemId;

function armIntent(
  queueItemId: QueueItemId,
  rendezvousId = `rv-${queueItemId}`,
): RendezvousArmIntent {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-arm',
    queueItemId,
    runId: `run-${queueItemId}`,
    revision: 1,
    rendezvousId,
    recipientId: 'local-peer',
    positionSeconds: 0,
    playbackRate: 1,
    startAtRoomTimeMs: 5_000,
    finalizeByRoomTimeMs: 4_000,
  };
}

function finalizeIntent(arm: RendezvousArmIntent): RendezvousFinalizeIntent {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-finalize',
    queueItemId: arm.queueItemId,
    runId: arm.runId,
    revision: arm.revision,
    rendezvousId: arm.rendezvousId,
    recipientId: arm.recipientId,
    startAtRoomTimeMs: arm.startAtRoomTimeMs,
    finalizedAtRoomTimeMs: 3_900,
  };
}

function currentPauseIntent(queueItemId = Q1) {
  return {
    kind: 'file-playback-pause-transition' as const,
    from: { queueItemId, runId: `run-${queueItemId}`, revision: 1 },
    to: { queueItemId, runId: `run-${queueItemId}`, revision: 2 },
    atRoomTimeMs: 2_000,
  };
}

function currentStopIntent(
  context: FakeAudioContext,
  contextTimeSeconds: number,
  revision = 1,
): FilePlaybackStopTransitionIntent {
  return {
    kind: 'file-playback-stop-transition',
    from: { queueItemId: Q1, runId: `run-${Q1}`, revision },
    to: { queueItemId: Q1, runId: `run-${Q1}`, revision: revision + 1 },
    atRoomTimeMs: contextTimeSeconds * 1_000,
    target: createFilePlaybackCutoverTarget(
      context as unknown as AudioContext,
      contextTimeSeconds,
      Math.round(contextTimeSeconds * context.sampleRate),
    ),
  };
}

function currentEndedIntent(revision = 1): FilePlaybackEndedTransitionIntent {
  return {
    kind: 'file-playback-ended-transition',
    from: { queueItemId: Q1, runId: `run-${Q1}`, revision },
    to: { queueItemId: Q1, runId: `run-${Q1}`, revision: revision + 1 },
    observedAtRoomTimeMs: 60_000,
  };
}

function currentRemoteEndedIntent(revision = 1): FilePlaybackRemoteEndedTransitionIntent {
  return {
    kind: 'file-playback-remote-ended-transition',
    from: { queueItemId: Q1, runId: `run-${Q1}`, revision },
    to: { queueItemId: Q1, runId: `run-${Q1}`, revision: revision + 1 },
    hostObservedAtRoomTimeMs: 60_000,
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
    observedAtRoomTimeMs: 3_500,
    bufferedAheadSeconds: 8,
    reasonCode: null,
  };
}

function finalizedReceipt(
  intent: RendezvousFinalizeIntent,
  status: RendezvousFinalizeReceipt['status'] = 'accepted',
): RendezvousFinalizeReceipt {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-finalized',
    queueItemId: intent.queueItemId,
    runId: intent.runId,
    revision: intent.revision,
    rendezvousId: intent.rendezvousId,
    participantId: intent.recipientId,
    status,
    observedAtRoomTimeMs: 3_950,
    reasonCode: status === 'accepted' ? null : 'backend-rejected',
  };
}

interface FakeCutoverSource {
  readonly source: FilePlaybackCutoverSource;
  readonly started: ReturnType<typeof deferred<FilePlaybackStartEvidence>>;
  readonly prepareGate: ReturnType<typeof deferred<FilePlaybackSourceSnapshot>>;
  readonly primeGate: ReturnType<typeof deferred<void>>;
  readonly armGate: ReturnType<typeof deferred<FilePlaybackCutoverArmResult>>;
  readonly destroyGate: ReturnType<typeof deferred<void>>;
  readonly connectedTo: AudioNode[];
  phase(value: FilePlaybackSourcePhase): void;
  gatePrepare(): void;
  gatePrime(): void;
  gateArm(): void;
  gateDestroy(): void;
  rejectFinalize(): void;
  resolveStarted(): void;
  applyTransition(appliedFrame?: number): void;
}

function makeSource(
  queueItemId: QueueItemId,
  context: FakeAudioContext,
  targetTime: number,
  backend: FilePlaybackBackend = 'bounded-stream',
): FakeCutoverSource {
  let phase: FilePlaybackSourcePhase = 'new';
  let prepareGated = false;
  let primeGated = false;
  let armGated = false;
  let destroyGated = false;
  let finalizeRejected = false;
  let armWasCalled = false;
  let revision = 0;
  let run: FilePlaybackSourceSnapshot['run'] = null;
  let positionSeconds = 0;
  let pendingTransition: {
    readonly intent: FilePlaybackTransitionIntent;
    readonly targetFrame: number;
    readonly evidence: ReturnType<typeof deferred<FilePlaybackTransitionEvidence>>;
  } | null = null;
  const started = deferred<FilePlaybackStartEvidence>();
  void started.promise.catch(() => undefined);
  const prepareGate = deferred<FilePlaybackSourceSnapshot>();
  const primeGate = deferred<void>();
  const armGate = deferred<FilePlaybackCutoverArmResult>();
  const destroyGate = deferred<void>();
  const connectedTo: AudioNode[] = [];
  const snapshot = (): FilePlaybackSourceSnapshot => ({
    schemaVersion: 1,
    queueItemId,
    backend,
    phase,
    revision,
    run,
    durationSeconds: 60,
    positionSeconds,
    bufferedAheadSeconds: phase === 'new' || phase === 'preparing' ? 0 : 8,
    outputSampleRateHz: context.sampleRate,
    channelCount: 2,
    underrunCount: 0,
    errorCode: null,
  });
  const createArmResult = (intent: RendezvousArmIntent): FilePlaybackCutoverArmResult =>
    Object.freeze({
      status: 'armed' as const,
      receipt: armedReceipt(intent),
      target: createFilePlaybackCutoverTarget(
        context as unknown as AudioContext,
        targetTime,
        Math.round(targetTime * context.sampleRate),
      ),
      started: started.promise,
    });
  const source: FilePlaybackCutoverSource = {
    queueItemId,
    backend,
    prepare: vi.fn(async () => {
      phase = 'preparing';
      if (prepareGated) return prepareGate.promise;
      phase = 'ready';
      return snapshot();
    }),
    connect: vi.fn(async (destination) => {
      connectedTo.push(destination);
      phase = 'connected';
      return snapshot();
    }),
    primeForCutover: vi.fn(async (nextPositionSeconds, signal) => {
      signal.throwIfAborted();
      if (primeGated) await primeGate.promise;
      signal.throwIfAborted();
      positionSeconds = nextPositionSeconds;
      return snapshot();
    }),
    arm: vi.fn(async (intent) => createArmResult(intent).receipt),
    armForCutover: vi.fn(async (intent) => {
      armWasCalled = true;
      if (armGated) return armGate.promise;
      phase = 'armed';
      revision = intent.revision;
      run = Object.freeze({
        queueItemId: intent.queueItemId,
        runId: intent.runId,
        revision: intent.revision,
      });
      return createArmResult(intent);
    }),
    finalize: vi.fn(async (intent) => {
      if (finalizeRejected) return finalizedReceipt(intent, 'rejected');
      return finalizedReceipt(intent);
    }),
    cancel: vi.fn(async () => snapshot()),
    pause: vi.fn(async () => snapshot()),
    seek: vi.fn(async () => snapshot()),
    pauseRevisioned: vi.fn(async (intent): Promise<FilePlaybackTransitionResult> => {
      const evidence = deferred<FilePlaybackTransitionEvidence>();
      void evidence.promise.catch(() => undefined);
      const targetFrame = Math.round((targetTime + 1) * context.sampleRate);
      pendingTransition = { intent, targetFrame, evidence };
      return createFilePlaybackScheduledTransitionResult(
        intent,
        createFilePlaybackCutoverTarget(
          context as unknown as AudioContext,
          targetTime + 1,
          targetFrame,
        ),
        snapshot(),
        evidence.promise,
      );
    }),
    seekRevisioned: vi.fn(async (intent): Promise<FilePlaybackTransitionResult> => {
      const evidence = deferred<FilePlaybackTransitionEvidence>();
      void evidence.promise.catch(() => undefined);
      const targetFrame = Math.round((targetTime + 1) * context.sampleRate);
      pendingTransition = { intent, targetFrame, evidence };
      return createFilePlaybackScheduledTransitionResult(
        intent,
        createFilePlaybackCutoverTarget(
          context as unknown as AudioContext,
          targetTime + 1,
          targetFrame,
        ),
        snapshot(),
        evidence.promise,
      );
    }),
    positionAt: vi.fn(() => ({
      queueItemId,
      run: null,
      phase,
      positionSeconds: 0,
      bufferedAheadSeconds: 8,
      underrunCount: 0,
    })),
    getSnapshot: vi.fn(snapshot),
    destroy: vi.fn(async () => {
      phase = 'destroyed';
      if (armWasCalled) started.reject(new Error('source retired'));
      if (destroyGated) await destroyGate.promise;
    }),
  };
  return {
    source,
    started,
    prepareGate,
    primeGate,
    armGate,
    destroyGate,
    connectedTo,
    phase(value) {
      phase = value;
    },
    gatePrepare() {
      prepareGated = true;
    },
    gatePrime() {
      primeGated = true;
    },
    gateArm() {
      armGated = true;
    },
    gateDestroy() {
      destroyGated = true;
    },
    rejectFinalize() {
      finalizeRejected = true;
    },
    resolveStarted() {
      phase = 'playing';
      const frame = Math.round(targetTime * context.sampleRate);
      started.resolve(
        backend === 'audio-buffer'
          ? createAudioBufferPlaybackStartEvidence(frame)
          : createStreamingPlaybackStartEvidence(frame, frame),
      );
    },
    applyTransition(appliedFrame) {
      const pending = pendingTransition;
      if (!pending) throw new Error('No transition is pending');
      pendingTransition = null;
      revision = pending.intent.to.revision;
      run = Object.freeze({ ...pending.intent.to });
      phase = 'paused';
      if (pending.intent.kind === 'file-playback-seek-transition') {
        positionSeconds = pending.intent.positionSeconds;
      }
      pending.evidence.resolve(
        createFilePlaybackTransitionEvidence(
          pending.intent,
          backend === 'audio-buffer' ? 'webaudio-schedule-passed' : 'worklet-observed',
          pending.targetFrame,
          appliedFrame ?? pending.targetFrame,
        ),
      );
    },
  };
}

async function stageArmFinalize(
  manager: FilePlaybackManager,
  fake: FakeCutoverSource,
  destination: AudioNode,
  authority?: () => boolean,
) {
  const port = await manager.stageCutoverCandidate({
    source: fake.source,
    destination,
    ...(authority ? { authority } : {}),
  });
  const arm = armIntent(fake.source.queueItemId);
  await manager.armCutoverCandidate(port, arm);
  const finalization = await manager.finalizeCutoverCandidate(port, finalizeIntent(arm));
  return { port, arm, finalization };
}

async function startFirst(
  manager: FilePlaybackManager,
  fake: FakeCutoverSource,
  destination: AudioNode,
  context: FakeAudioContext,
  authority?: () => boolean,
) {
  const result = await stageArmFinalize(manager, fake, destination, authority);
  context.currentTime = result.finalization.target.contextTimeSeconds;
  fake.resolveStarted();
  await result.finalization.started;
  return result;
}

describe('FilePlaybackManager V2 atomic cutover', () => {
  it('brands only exact module-created manager objects', () => {
    const exact = new FilePlaybackManager();
    class ManagerSubclass extends FilePlaybackManager {}
    const subclass = new ManagerSubclass();
    class PrototypeResetSubclass extends FilePlaybackManager {
      constructor() {
        super();
        Object.setPrototypeOf(this, FilePlaybackManager.prototype);
      }
    }
    const prototypeResetSubclass = new PrototypeResetSubclass();
    const transparentProxy = new Proxy(exact, {});
    const lyingProxy = new Proxy(Object.create(null) as object, {
      getPrototypeOf: () => FilePlaybackManager.prototype,
    });

    expect(isExactFilePlaybackManager(exact)).toBe(true);
    expect(isExactFilePlaybackManager(subclass)).toBe(false);
    expect(isExactFilePlaybackManager(prototypeResetSubclass)).toBe(false);
    expect(isExactFilePlaybackManager(transparentProxy)).toBe(false);
    expect(isExactFilePlaybackManager(lyingProxy)).toBe(false);
    expect(isExactFilePlaybackManager(null)).toBe(false);
  });

  it('keeps unprimed compatibility but fences every declared prime to its exact target', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);

    const compatibilityManager = new FilePlaybackManager();
    const compatibilitySource = makeSource(Q1, context, 5);
    const compatibilityPort = await compatibilityManager.stageCutoverCandidate({
      source: compatibilitySource.source,
      destination,
    });
    await expect(
      compatibilityManager.primeCutoverCandidate(
        compatibilityPort,
        Number.NaN,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/prime input/u);
    expect(compatibilitySource.source.primeForCutover).not.toHaveBeenCalled();
    await expect(
      compatibilityManager.armCutoverCandidate(compatibilityPort, armIntent(Q1)),
    ).resolves.toMatchObject({ status: 'armed' });

    const manager = new FilePlaybackManager();
    const source = makeSource(Q2, context, 5);
    source.gatePrime();
    const port = await manager.stageCutoverCandidate({ source: source.source, destination });
    const signal = new AbortController().signal;
    const exactArm = Object.freeze({ ...armIntent(Q2), positionSeconds: 12 });
    const priming = manager.primeCutoverCandidate(port, 12, signal);
    await Promise.resolve();
    expect(manager.primeCutoverCandidate(port, 12, signal)).toBe(priming);
    await expect(manager.primeCutoverCandidate(port, 13, signal)).rejects.toThrow(
      /already bound to another prime/u,
    );

    await expect(manager.armCutoverCandidate(port, exactArm)).rejects.toThrow(
      /not primed for the exact arm target/u,
    );
    expect(source.source.armForCutover).not.toHaveBeenCalled();

    source.primeGate.resolve();
    await expect(priming).resolves.toMatchObject({
      phase: 'connected',
      positionSeconds: 12,
    });
    await expect(
      manager.armCutoverCandidate(port, { ...exactArm, positionSeconds: 13 }),
    ).rejects.toThrow(/not primed for the exact arm target/u);
    expect(source.source.armForCutover).not.toHaveBeenCalled();
    await expect(manager.armCutoverCandidate(port, exactArm)).resolves.toMatchObject({
      status: 'armed',
    });
    expect(source.source.armForCutover).toHaveBeenCalledOnce();
  });

  it('retires a candidate when its declared prime aborts or returns an invalid snapshot', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);

    const abortedManager = new FilePlaybackManager();
    const abortedSource = makeSource(Q2, context, 5);
    abortedSource.gatePrime();
    const abortedPort = await abortedManager.stageCutoverCandidate({
      source: abortedSource.source,
      destination,
    });
    const controller = new AbortController();
    const abortedPrime = abortedManager.primeCutoverCandidate(abortedPort, 12, controller.signal);
    await Promise.resolve();
    controller.abort(new Error('fixture prime authority expired'));
    abortedSource.primeGate.resolve();

    await expect(abortedPrime).rejects.toThrow(/authority expired/u);
    await vi.waitFor(() => expect(abortedSource.source.destroy).toHaveBeenCalledOnce());
    expect(abortedManager.currentCutoverPort()).toBeNull();

    const invalidManager = new FilePlaybackManager();
    const invalidSource = makeSource(Q3, context, 5);
    const invalidPort = await invalidManager.stageCutoverCandidate({
      source: invalidSource.source,
      destination,
    });
    vi.mocked(invalidSource.source.primeForCutover).mockResolvedValueOnce({
      ...invalidSource.source.getSnapshot(),
      queueItemId: Q1,
    });

    await expect(
      invalidManager.primeCutoverCandidate(invalidPort, 12, new AbortController().signal),
    ).rejects.toThrow(/invalid prime snapshot/u);
    await vi.waitFor(() => expect(invalidSource.source.destroy).toHaveBeenCalledOnce());
    expect(invalidManager.currentCutoverPort()).toBeNull();
  });

  it('keeps the first source silent until exact evidence promotes its opaque port', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const first = makeSource(Q1, context, 1);

    const { port, finalization } = await stageArmFinalize(manager, first, destination);
    const gate = context.gains[0]!;
    expect(first.connectedTo).toEqual([gate]);
    expect(gate.gain.valueAt(0.5)).toBe(0);
    expect(gate.gain.events).toContainEqual({ value: 1, time: 1 });
    expect(manager.currentCutoverPort()).toBeNull();

    context.currentTime = 1;
    first.resolveStarted();
    await expect(finalization.started).resolves.toMatchObject({ targetFrame: 48_000 });
    expect(manager.currentCutoverPort()).toBe(port);
    expect(manager.currentCutoverSnapshot(port)?.queueItemId).toBe(Q1);
    expect(manager.snapshot().active?.queueItemId).toBe(Q1);
    expect(JSON.stringify(port)).toBe('{}');
  });

  it('promotes exact Worklet start evidence even before the main-thread clock reaches target', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const source = makeSource(Q1, context, 1, 'bounded-stream');
    const { port, finalization } = await stageArmFinalize(manager, source, destination);
    context.currentTime = 0.999;

    source.resolveStarted();

    await expect(finalization.started).resolves.toEqual(
      createStreamingPlaybackStartEvidence(48_000, 48_000),
    );
    expect(manager.currentCutoverPort()).toBe(port);
    expect(source.source.destroy).not.toHaveBeenCalled();
  });

  it('still rejects AudioBuffer schedule evidence before the target clock passes', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const source = makeSource(Q1, context, 1, 'audio-buffer');
    const { finalization } = await stageArmFinalize(manager, source, destination);
    context.currentTime = 0.999;

    source.resolveStarted();

    await expect(finalization.started).rejects.toThrow('evidence');
    expect(manager.currentCutoverPort()).toBeNull();
    expect(manager.cutoverRecoveryRequired()).toBe(false);
    expect(source.source.destroy).toHaveBeenCalledOnce();
  });

  it('still rejects mismatched Worklet start evidence before the target clock passes', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const source = makeSource(Q1, context, 1, 'bounded-stream');
    const { finalization } = await stageArmFinalize(manager, source, destination);
    context.currentTime = 0.999;

    source.started.resolve(createStreamingPlaybackStartEvidence(47_999, 47_999));

    await expect(finalization.started).rejects.toThrow('evidence');
    expect(manager.currentCutoverPort()).toBeNull();
    expect(manager.cutoverRecoveryRequired()).toBe(false);
    expect(source.source.destroy).toHaveBeenCalledOnce();
  });

  it('observes a hostile fulfilled start value without re-assimilating it', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const candidate = makeSource(Q1, context, 1);
    const port = await manager.stageCutoverCandidate({ source: candidate.source, destination });
    const arm = armIntent(Q1, 'rv-hostile-start-value');
    const hostileValue = {} as Record<PropertyKey, unknown>;
    const hostileStarted = Promise.resolve(hostileValue as unknown as FilePlaybackStartEvidence);
    await hostileStarted;
    Object.defineProperty(hostileValue, 'then', {
      configurable: true,
      get() {
        throw new Error('fulfilled value was re-assimilated');
      },
    });
    vi.mocked(candidate.source.armForCutover).mockResolvedValueOnce({
      status: 'armed',
      receipt: armedReceipt(arm),
      target: createFilePlaybackCutoverTarget(
        context as unknown as AudioContext,
        1,
        context.sampleRate,
      ),
      started: hostileStarted,
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(manager.armCutoverCandidate(port, arm)).resolves.toMatchObject({
        status: 'armed',
      });
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      await manager.clear();
    }
  });

  it('keeps old audio audible during prepare and arm, then schedules an exact simultaneous step', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    await startFirst(manager, current, destination, context);
    const oldGate = context.gains[0]!;
    const candidate = makeSource(Q2, context, 2);
    candidate.gatePrepare();

    const staging = manager.stageCutoverCandidate({ source: candidate.source, destination });
    await vi.waitFor(() => expect(candidate.source.prepare).toHaveBeenCalledOnce());
    expect(oldGate.gain.valueAt(1.5)).toBe(1);
    expect(current.source.destroy).not.toHaveBeenCalled();
    candidate.phase('ready');
    candidate.prepareGate.resolve(candidate.source.getSnapshot());
    const port = await staging;
    const arm = armIntent(Q2);
    await manager.armCutoverCandidate(port, arm);
    expect(oldGate.gain.valueAt(1.5)).toBe(1);

    const finalization = await manager.finalizeCutoverCandidate(port, finalizeIntent(arm));
    const candidateGate = context.gains[1]!;
    expect(candidateGate.gain.events).toContainEqual({ value: 1, time: 2 });
    expect(oldGate.gain.events).toContainEqual({ value: 0, time: 2 });
    expect(current.source.destroy).not.toHaveBeenCalled();

    context.currentTime = 2;
    candidate.resolveStarted();
    await finalization.started;
    expect(manager.currentCutoverPort()).toBe(port);
    expect(current.source.destroy).toHaveBeenCalledOnce();
    expect(candidate.source.destroy).not.toHaveBeenCalled();
  });

  it('leaves old audio untouched when finalization is rejected', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    await startFirst(manager, current, destination, context);
    const oldPort = manager.currentCutoverPort()!;
    const oldGate = context.gains[0]!;
    const candidate = makeSource(Q2, context, 2);
    candidate.rejectFinalize();
    const port = await manager.stageCutoverCandidate({ source: candidate.source, destination });
    const arm = armIntent(Q2);
    await manager.armCutoverCandidate(port, arm);

    await expect(manager.finalizeCutoverCandidate(port, finalizeIntent(arm))).rejects.toThrow(
      'finalization',
    );
    expect(manager.currentCutoverPort()).toBe(oldPort);
    expect(oldGate.gain.valueAt(2)).toBe(1);
    expect(current.source.destroy).not.toHaveBeenCalled();
    expect(candidate.source.destroy).toHaveBeenCalledOnce();
  });

  it('rolls back exact gates on cancellation before target', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    await startFirst(manager, current, destination, context);
    const oldPort = manager.currentCutoverPort()!;
    const candidate = makeSource(Q2, context, 3);
    const { port, finalization } = await stageArmFinalize(manager, candidate, destination);
    context.currentTime = 2;

    await expect(manager.retireCutoverCandidate(port)).resolves.toBe(true);
    expect(manager.currentCutoverPort()).toBe(oldPort);
    expect(context.gains[0]!.gain.valueAt(3)).toBe(1);
    expect(context.gains[1]!.gain.valueAt(3)).toBe(0);
    expect(current.source.destroy).not.toHaveBeenCalled();
    expect(candidate.source.destroy).toHaveBeenCalledOnce();
    candidate.started.reject(new Error('late retired evidence'));
    await expect(finalization.started).rejects.toThrow('source retired');
    expect(manager.currentCutoverPort()).toBe(oldPort);
  });

  it('never resurrects old audio when cancellation occurs after the target', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    await startFirst(manager, current, destination, context);
    const candidate = makeSource(Q2, context, 2);
    const { port } = await stageArmFinalize(manager, candidate, destination);
    context.currentTime = 2;

    await expect(manager.retireCutoverCandidate(port)).resolves.toBe(true);
    expect(manager.currentCutoverPort()).toBeNull();
    expect(manager.cutoverRecoveryRequired()).toBe(true);
    expect(context.gains[0]!.gain.valueAt(2)).toBe(0);
    expect(context.gains[1]!.gain.valueAt(2)).toBe(0);
    expect(current.source.destroy).toHaveBeenCalledOnce();
    expect(candidate.source.destroy).toHaveBeenCalledOnce();
  });

  it('waits for every fail-silent cleanup before replaying an exact post-target failure', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    current.gateDestroy();
    await startFirst(manager, current, destination, context);
    const candidate = makeSource(Q2, context, 2);
    candidate.gateDestroy();
    const { port } = await stageArmFinalize(manager, candidate, destination);
    const failure = new Error('fixture post-target candidate cleanup failed');
    context.currentTime = 2;

    const exact = manager.retireExactCutoverPort(port);
    let settled = false;
    void exact.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => {
      expect(candidate.source.destroy).toHaveBeenCalledOnce();
      expect(current.source.destroy).toHaveBeenCalledOnce();
    });
    candidate.destroyGate.reject(failure);
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(manager.currentCutoverPort()).toBeNull();
    expect(manager.cutoverRecoveryRequired()).toBe(true);
    current.destroyGate.resolve();
    await expect(exact).rejects.toBe(failure);
    await expect(manager.retireExactCutoverPort(port)).rejects.toBe(failure);
    expect(candidate.source.destroy).toHaveBeenCalledOnce();
    expect(current.source.destroy).toHaveBeenCalledOnce();
  });

  it('rejects a source target from another AudioContext without touching current audio', async () => {
    const context = new FakeAudioContext();
    const otherContext = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const candidate = makeSource(Q1, otherContext, 1);
    const port = await manager.stageCutoverCandidate({ source: candidate.source, destination });

    await expect(manager.armCutoverCandidate(port, armIntent(Q1))).rejects.toThrow('arm result');
    expect(manager.currentCutoverPort()).toBeNull();
    expect(candidate.source.destroy).toHaveBeenCalledOnce();
    expect(context.gains[0]!.gain.valueAt(1)).toBe(0);
  });

  it('rejects forged and ABA ports without mutating the successor', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const stale = makeSource(Q1, context, 1);
    const stalePort = await manager.stageCutoverCandidate({ source: stale.source, destination });
    const successor = makeSource(Q2, context, 1);
    const successorPort = await manager.stageCutoverCandidate({
      source: successor.source,
      destination,
    });

    await expect(
      manager.armCutoverCandidate({} as FilePlaybackCutoverCandidatePort, armIntent(Q2)),
    ).rejects.toThrow('stale');
    await expect(manager.armCutoverCandidate(stalePort, armIntent(Q1))).rejects.toThrow('stale');
    expect(await manager.retireCutoverCandidate(stalePort)).toBe(false);
    await expect(manager.armCutoverCandidate(successorPort, armIntent(Q2))).resolves.toMatchObject({
      status: 'armed',
    });
    expect(stale.source.destroy).toHaveBeenCalledOnce();
    expect(successor.source.destroy).not.toHaveBeenCalled();
  });

  it('does not admit a third renderer while an exact target is scheduled', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    await startFirst(manager, current, destination, context);
    const candidate = makeSource(Q2, context, 3);
    await stageArmFinalize(manager, candidate, destination);
    const third = makeSource(Q3, context, 4);

    await expect(
      manager.stageCutoverCandidate({ source: third.source, destination }),
    ).rejects.toThrow('second renderer slot');
    expect(context.gains).toHaveLength(2);
    expect(third.source.prepare).not.toHaveBeenCalled();
    expect(third.source.destroy).toHaveBeenCalledOnce();
    expect(current.source.destroy).not.toHaveBeenCalled();
  });

  it('waits for candidate destruction before installing its replacement', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const stale = makeSource(Q1, context, 1);
    stale.gateDestroy();
    const stalePort = await manager.stageCutoverCandidate({ source: stale.source, destination });
    const replacement = makeSource(Q2, context, 1);

    const staging = manager.stageCutoverCandidate({ source: replacement.source, destination });
    await vi.waitFor(() => expect(stale.source.destroy).toHaveBeenCalledOnce());
    expect(context.gains).toHaveLength(1);
    expect(replacement.source.prepare).not.toHaveBeenCalled();
    stale.destroyGate.resolve();
    await expect(staging).resolves.not.toBe(stalePort);
    expect(context.gains).toHaveLength(2);
  });

  it('ignores a late arm completion after clear and destroys exactly once', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const stale = makeSource(Q1, context, 1);
    stale.gateArm();
    const port = await manager.stageCutoverCandidate({ source: stale.source, destination });
    const arm = armIntent(Q1);
    const arming = manager.armCutoverCandidate(port, arm);

    await manager.clear();
    stale.armGate.resolve({
      status: 'armed',
      receipt: armedReceipt(arm),
      target: createFilePlaybackCutoverTarget(
        context as unknown as AudioContext,
        1,
        context.sampleRate,
      ),
      started: stale.started.promise,
    });
    await expect(arming).rejects.toThrow('expired');
    expect(manager.currentCutoverPort()).toBeNull();
    expect(stale.source.destroy).toHaveBeenCalledOnce();
  });

  it('fails closed when a proxied authority callback re-enters clear', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const stale = makeSource(Q1, context, 1);
    const authority = new Proxy(
      vi.fn(() => true),
      {
        apply(target, thisArgument, argumentsList) {
          void manager.clear();
          return Reflect.apply(target, thisArgument, argumentsList) as boolean;
        },
      },
    );

    await expect(
      manager.stageCutoverCandidate({ source: stale.source, destination, authority }),
    ).rejects.toThrow('authority expired');
    expect(stale.source.prepare).not.toHaveBeenCalled();
    expect(stale.source.destroy).toHaveBeenCalledOnce();
    expect(manager.currentCutoverPort()).toBeNull();
  });

  it('returns the same cached arm and finalize promises on exact retries', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const source = makeSource(Q1, context, 1);
    const port = await manager.stageCutoverCandidate({ source: source.source, destination });
    const arm = armIntent(Q1);

    const firstArm = manager.armCutoverCandidate(port, arm);
    expect(manager.armCutoverCandidate(port, { ...arm })).toBe(firstArm);
    await firstArm;
    const finalize = finalizeIntent(arm);
    const firstFinalize = manager.finalizeCutoverCandidate(port, finalize);
    expect(manager.finalizeCutoverCandidate(port, { ...finalize })).toBe(firstFinalize);
    const committed = await firstFinalize;
    context.currentTime = 1;
    source.resolveStarted();
    await committed.started;

    expect(manager.armCutoverCandidate(port, { ...arm })).toBe(firstArm);
    expect(manager.finalizeCutoverCandidate(port, { ...finalize })).toBe(firstFinalize);
    expect(source.source.armForCutover).toHaveBeenCalledOnce();
    expect(source.source.finalize).toHaveBeenCalledOnce();
  });

  it('joins an exact candidate retirement that is already physically cleaning up', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const source = makeSource(Q1, context, 1);
    source.gateDestroy();
    const port = await manager.stageCutoverCandidate({ source: source.source, destination });

    const retirement = manager.retireCutoverCandidate(port);
    await vi.waitFor(() => expect(source.source.destroy).toHaveBeenCalledOnce());
    let exactSettled = false;
    const exact = manager.retireExactCutoverPort(port).then(() => {
      exactSettled = true;
    });
    await Promise.resolve();

    expect(exactSettled).toBe(false);
    expect(source.source.destroy).toHaveBeenCalledOnce();
    source.destroyGate.resolve();
    await expect(retirement).resolves.toBe(true);
    await expect(exact).resolves.toBeUndefined();
    await expect(manager.retireExactCutoverPort(port)).resolves.toBeUndefined();
    expect(source.source.destroy).toHaveBeenCalledOnce();
  });

  it('replays an exact physical cleanup rejection without repeating destruction', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const source = makeSource(Q1, context, 1);
    const failure = new Error('fixture cutover cleanup failed');
    source.gateDestroy();
    const port = await manager.stageCutoverCandidate({ source: source.source, destination });

    const exact = manager.retireExactCutoverPort(port);
    await vi.waitFor(() => expect(source.source.destroy).toHaveBeenCalledOnce());
    source.destroyGate.reject(failure);

    await expect(exact).rejects.toBe(failure);
    await expect(manager.retireExactCutoverPort(port)).rejects.toBe(failure);
    expect(source.source.destroy).toHaveBeenCalledOnce();
  });

  it('tombstones the strict exact-port postcondition failure itself', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const source = makeSource(Q1, context, 1);
    source.gateDestroy();
    const port = await manager.stageCutoverCandidate({ source: source.source, destination });
    const exactRecord = Reflect.get(manager, 'cutoverCandidate');
    expect(exactRecord).not.toBeNull();

    const first = manager.retireExactCutoverPort(port);
    await vi.waitFor(() => expect(source.source.destroy).toHaveBeenCalledOnce());
    expect(manager.retireExactCutoverPort(port)).toBe(first);
    expect(Reflect.set(manager, 'cutoverCandidate', exactRecord)).toBe(true);
    source.destroyGate.resolve();

    let postconditionFailure: unknown;
    try {
      await first;
    } catch (error) {
      postconditionFailure = error;
    }
    expect(postconditionFailure).toBeInstanceOf(Error);
    expect((postconditionFailure as Error).message).toContain(
      'exact port remained owned after terminal cleanup',
    );
    const replay = manager.retireExactCutoverPort(port);
    expect(replay).toBe(first);
    await expect(replay).rejects.toBe(postconditionFailure);
    expect(source.source.destroy).toHaveBeenCalledOnce();
  });

  it('treats a completely unknown exact cutover capability as an idempotent no-op', async () => {
    const manager = new FilePlaybackManager();

    await expect(
      manager.retireExactCutoverPort({} as FilePlaybackCutoverCandidatePort),
    ).resolves.toBeUndefined();
  });

  it('forgets a retired candidate capability after exact cleanup settles', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const source = makeSource(Q1, context, 1);
    source.gateDestroy();
    const port = await manager.stageCutoverCandidate({ source: source.source, destination });
    const arm = armIntent(Q1, 'rv-retired-candidate');
    await manager.armCutoverCandidate(port, arm);

    const retirement = manager.retireCutoverCandidate(port);
    await vi.waitFor(() => expect(source.source.destroy).toHaveBeenCalledOnce());
    await expect(manager.retireCutoverCandidate(port)).resolves.toBe(false);
    await expect(manager.armCutoverCandidate(port, { ...arm })).rejects.toThrow('stale');

    source.destroyGate.resolve();
    await expect(retirement).resolves.toBe(true);
    await expect(manager.armCutoverCandidate(port, { ...arm })).rejects.toThrow('stale');
    await expect(manager.finalizeCutoverCandidate(port, finalizeIntent(arm))).rejects.toThrow(
      'stale',
    );
    expect(source.source.destroy).toHaveBeenCalledOnce();
  });

  it('forgets a retired current capability without repeating physical cleanup', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const source = makeSource(Q1, context, 1);
    source.gateDestroy();
    const { port } = await startFirst(manager, source, destination, context);

    const retirement = manager.retireCurrentCutover(port);
    await vi.waitFor(() => expect(source.source.destroy).toHaveBeenCalledOnce());
    expect(manager.currentCutoverSnapshot(port)).toBeNull();
    await expect(manager.retireCurrentCutover(port)).resolves.toBe(false);
    await expect(manager.pauseCurrentCutover(port, currentPauseIntent())).rejects.toThrow('stale');

    source.destroyGate.resolve();
    await expect(retirement).resolves.toBe(true);
    expect(manager.currentCutoverSnapshot(port)).toBeNull();
    await expect(manager.pauseCurrentCutover(port, currentPauseIntent())).rejects.toThrow('stale');
    expect(source.source.destroy).toHaveBeenCalledOnce();
  });

  it('forgets an errored candidate port after cleanup instead of reviving cached work', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const source = makeSource(Q1, context, 1);
    source.gateDestroy();
    source.rejectFinalize();
    const port = await manager.stageCutoverCandidate({ source: source.source, destination });
    const arm = armIntent(Q1, 'rv-errored-candidate');
    const firstArm = manager.armCutoverCandidate(port, arm);
    await firstArm;
    const finalize = finalizeIntent(arm);

    await expect(manager.finalizeCutoverCandidate(port, finalize)).rejects.toThrow('finalization');
    await vi.waitFor(() => expect(source.source.destroy).toHaveBeenCalledOnce());
    await expect(manager.armCutoverCandidate(port, { ...arm })).rejects.toThrow('stale');

    source.destroyGate.resolve();
    await manager.clear();
    await expect(manager.armCutoverCandidate(port, { ...arm })).rejects.toThrow('stale');
    await expect(manager.finalizeCutoverCandidate(port, { ...finalize })).rejects.toThrow('stale');
    expect(source.source.armForCutover).toHaveBeenCalledOnce();
    expect(source.source.finalize).toHaveBeenCalledOnce();
    expect(source.source.destroy).toHaveBeenCalledOnce();
  });

  it('rejects a partial gate automation and preserves only old audio before target', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    const { port: currentPort } = await startFirst(manager, current, destination, context);
    const candidate = makeSource(Q2, context, 3);
    const port = await manager.stageCutoverCandidate({ source: candidate.source, destination });
    const arm = armIntent(Q2);
    await manager.armCutoverCandidate(port, arm);
    context.gains[1]!.gain.throwOnValue = 1;

    await expect(manager.finalizeCutoverCandidate(port, finalizeIntent(arm))).rejects.toThrow(
      'gate automation failed',
    );
    expect(manager.currentCutoverPort()).toBe(currentPort);
    expect(context.gains[0]!.gain.valueAt(3)).toBe(1);
    expect(context.gains[1]!.disconnect).toHaveBeenCalled();
    expect(candidate.source.destroy).toHaveBeenCalledOnce();
    expect(current.source.destroy).not.toHaveBeenCalled();
  });

  it.each(['expires', 'throws', 're-enters'] as const)(
    'rolls back old gate automation when authority %s immediately after scheduling',
    async (failureMode) => {
      const context = new FakeAudioContext();
      const destination = destinationFor(context);
      const manager = new FilePlaybackManager();
      const current = makeSource(Q1, context, 1);
      const { port: currentPort } = await startFirst(manager, current, destination, context);
      const candidate = makeSource(Q2, context, 3);
      const authorityError = { code: 'post-schedule-authority' };
      let candidatePort: FilePlaybackCutoverCandidatePort | null = null;
      const authority = vi.fn(() => {
        const oldMuteWasScheduled = context.gains[0]?.gain.events.some(
          (event) => event.value === 0 && event.time === 3,
        );
        if (!oldMuteWasScheduled) return true;
        if (failureMode === 'throws') throw authorityError;
        if (failureMode === 're-enters' && candidatePort) {
          void manager.retireCutoverCandidate(candidatePort);
          return true;
        }
        return false;
      });
      const port = await manager.stageCutoverCandidate({
        source: candidate.source,
        destination,
        authority,
      });
      candidatePort = port;
      const arm = armIntent(Q2);
      await manager.armCutoverCandidate(port, arm);

      const finalization = manager.finalizeCutoverCandidate(port, finalizeIntent(arm));
      if (failureMode === 'throws') {
        await expect(finalization).rejects.toBe(authorityError);
      } else {
        await expect(finalization).rejects.toThrow('expired');
      }
      expect(manager.currentCutoverPort()).toBe(currentPort);
      expect(context.gains[0]!.gain.valueAt(3)).toBe(1);
      expect(context.gains[0]!.gain.events).not.toContainEqual({ value: 0, time: 3 });
      expect(context.gains[1]!.gain.valueAt(3)).toBe(0);
      expect(candidate.source.destroy).toHaveBeenCalledOnce();
      expect(current.source.destroy).not.toHaveBeenCalled();
    },
  );

  it('rolls back a target mute when gate automation synchronously retires the candidate', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    const { port: currentPort } = await startFirst(manager, current, destination, context);
    const candidate = makeSource(Q2, context, 3);
    const port = await manager.stageCutoverCandidate({ source: candidate.source, destination });
    const arm = armIntent(Q2);
    await manager.armCutoverCandidate(port, arm);
    context.gains[0]!.gain.onSet = (value, time) => {
      if (value === 0 && time === 3) void manager.retireCutoverCandidate(port);
    };

    await expect(manager.finalizeCutoverCandidate(port, finalizeIntent(arm))).rejects.toThrow(
      'revoked',
    );
    expect(manager.currentCutoverPort()).toBe(currentPort);
    expect(context.gains[0]!.gain.valueAt(3)).toBe(1);
    expect(context.gains[0]!.gain.events).not.toContainEqual({ value: 0, time: 3 });
    expect(context.gains[1]!.gain.valueAt(3)).toBe(0);
    expect(candidate.source.destroy).toHaveBeenCalledOnce();
    expect(current.source.destroy).not.toHaveBeenCalled();
  });

  it('fails silent instead of upgrading evidence from the wrong backend class', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const source = makeSource(Q1, context, 1, 'audio-buffer');
    const { finalization } = await stageArmFinalize(manager, source, destination);
    context.currentTime = 1;
    source.started.resolve(createStreamingPlaybackStartEvidence(48_000, 48_000));

    await expect(finalization.started).rejects.toThrow('evidence');
    expect(manager.currentCutoverPort()).toBeNull();
    expect(manager.cutoverRecoveryRequired()).toBe(true);
    expect(source.source.destroy).toHaveBeenCalledOnce();
  });

  it('keeps the promoted port as the only exact current authority', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    const { port } = await startFirst(manager, current, destination, context);

    expect(manager.currentCutoverPosition({} as FilePlaybackCutoverCandidatePort, 10)).toBeNull();
    expect(manager.currentCutoverPosition(port, 10)?.queueItemId).toBe(Q1);
    await expect(
      manager.retireCurrentCutover({} as FilePlaybackCutoverCandidatePort),
    ).resolves.toBe(false);
    await expect(manager.retireCurrentCutover(port)).resolves.toBe(true);
    expect(manager.currentCutoverPort()).toBeNull();
    expect(current.source.destroy).toHaveBeenCalledOnce();
  });

  it('exposes revisioned pause only through the exact opaque current port', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    const { port } = await startFirst(manager, current, destination, context);
    const intent = currentPauseIntent();

    await expect(
      manager.pauseCurrentCutover({} as FilePlaybackCutoverCandidatePort, intent),
    ).rejects.toThrow('stale');
    const first = manager.pauseCurrentCutover(port, intent);
    const retry = manager.pauseCurrentCutover(port, { ...intent });
    expect(retry).toBe(first);
    const scheduled = await first;
    expect(scheduled).toMatchObject({
      status: 'scheduled',
      snapshot: { phase: 'playing', revision: 1 },
      from: { revision: 1 },
      to: { revision: 2 },
    });
    expect(current.source.pauseRevisioned).toHaveBeenCalledOnce();
    if (scheduled.status !== 'scheduled') throw new Error('Expected scheduled pause');

    current.applyTransition();
    await expect(scheduled.applied).resolves.toMatchObject({
      kind: 'pause-applied',
      observation: 'worklet-observed',
      from: { revision: 1 },
      to: { revision: 2 },
    });
    expect(manager.currentCutoverSnapshot(port)).toMatchObject({
      phase: 'paused',
      revision: 2,
      run: { revision: 2 },
    });
  });

  it('rejects a wrong current from-state before invoking the backend', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    const { port } = await startFirst(manager, current, destination, context);
    const wrong = currentPauseIntent();
    const wrongIntent = {
      ...wrong,
      from: { ...wrong.from, runId: 'wrong-current-run' },
      to: { ...wrong.to, runId: 'wrong-current-run' },
    };

    await expect(manager.pauseCurrentCutover(port, wrongIntent)).rejects.toThrow(
      'from state is not current',
    );
    expect(current.source.pauseRevisioned).not.toHaveBeenCalled();
    expect(manager.currentCutoverPort()).toBe(port);
    expect(current.source.destroy).not.toHaveBeenCalled();
  });

  it('fails silent on hostile rejected and scheduled snapshots from another backend', async () => {
    const rejectedContext = new FakeAudioContext();
    const rejectedDestination = destinationFor(rejectedContext);
    const rejectedManager = new FilePlaybackManager();
    const rejectedSource = makeSource(Q1, rejectedContext, 1);
    const rejectedCurrent = await startFirst(
      rejectedManager,
      rejectedSource,
      rejectedDestination,
      rejectedContext,
    );
    vi.mocked(rejectedSource.source.pauseRevisioned).mockImplementationOnce(async (intent) =>
      createFilePlaybackRejectedTransitionResult(intent, 'wrong-phase', {
        ...rejectedSource.source.getSnapshot(),
        backend: 'audio-buffer',
      }),
    );
    await expect(
      rejectedManager.pauseCurrentCutover(rejectedCurrent.port, currentPauseIntent()),
    ).rejects.toThrow('snapshot is not current');
    expect(rejectedManager.currentCutoverPort()).toBeNull();
    expect(rejectedManager.cutoverRecoveryRequired()).toBe(true);

    const scheduledContext = new FakeAudioContext();
    const scheduledDestination = destinationFor(scheduledContext);
    const scheduledManager = new FilePlaybackManager();
    const scheduledSource = makeSource(Q1, scheduledContext, 1);
    const scheduledCurrent = await startFirst(
      scheduledManager,
      scheduledSource,
      scheduledDestination,
      scheduledContext,
    );
    const hostileEvidence = deferred<FilePlaybackTransitionEvidence>();
    void hostileEvidence.promise.catch(() => undefined);
    vi.mocked(scheduledSource.source.pauseRevisioned).mockImplementationOnce(async (intent) =>
      createFilePlaybackScheduledTransitionResult(
        intent,
        createFilePlaybackCutoverTarget(scheduledContext as unknown as AudioContext, 2, 96_000),
        { ...scheduledSource.source.getSnapshot(), backend: 'audio-buffer' },
        hostileEvidence.promise,
      ),
    );
    await expect(
      scheduledManager.pauseCurrentCutover(scheduledCurrent.port, currentPauseIntent()),
    ).rejects.toThrow('snapshot is not current');
    hostileEvidence.reject(new Error('hostile result retired'));
    expect(scheduledManager.currentCutoverPort()).toBeNull();
    expect(scheduledManager.cutoverRecoveryRequired()).toBe(true);
  });

  it('fails silent when current authority expires before transition evidence', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    let authorized = true;
    let authorityCalls = 0;
    const authority = () => {
      authorityCalls += 1;
      return authorized;
    };
    const { port } = await startFirst(manager, current, destination, context, authority);
    const scheduled = await manager.pauseCurrentCutover(port, currentPauseIntent());
    if (scheduled.status !== 'scheduled') throw new Error('Expected scheduled pause');
    const callsBeforeEvidence = authorityCalls;

    authorized = false;
    current.applyTransition();
    await expect(scheduled.applied).rejects.toThrow('invalid or revoked');
    expect(authorityCalls).toBe(callsBeforeEvidence + 1);
    expect(manager.currentCutoverPort()).toBeNull();
    expect(manager.cutoverRecoveryRequired()).toBe(true);
    expect(current.source.destroy).toHaveBeenCalledOnce();
  });

  it('fails silent when a backend reports an unsafe partial-schedule rejection', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    const { port } = await startFirst(manager, current, destination, context);
    vi.mocked(current.source.pauseRevisioned).mockImplementationOnce(async (intent) =>
      createFilePlaybackRejectedTransitionResult(
        intent,
        'schedule-failed',
        current.source.getSnapshot(),
      ),
    );

    await expect(manager.pauseCurrentCutover(port, currentPauseIntent())).rejects.toThrow(
      'schedule-failed',
    );
    expect(manager.currentCutoverPort()).toBeNull();
    expect(manager.cutoverRecoveryRequired()).toBe(true);
    expect(current.source.destroy).toHaveBeenCalledOnce();
  });

  it('rechecks exact current ownership after a transition snapshot re-enters clear', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    const { port } = await startFirst(manager, current, destination, context);
    const scheduled = await manager.pauseCurrentCutover(port, currentPauseIntent());
    if (scheduled.status !== 'scheduled') throw new Error('Expected scheduled pause');
    const originalSnapshot = current.source.getSnapshot;
    vi.mocked(current.source.getSnapshot).mockImplementationOnce(() => {
      void manager.clear();
      return originalSnapshot();
    });

    current.applyTransition();
    await expect(scheduled.applied).rejects.toThrow('did not match evidence');
    expect(manager.currentCutoverPort()).toBeNull();
  });

  it('rejects cached exact retries after their opaque port is replaced', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const first = makeSource(Q1, context, 1);
    const firstRun = await startFirst(manager, first, destination, context);
    const successor = makeSource(Q2, context, 2);
    await startFirst(manager, successor, destination, context);

    await expect(manager.armCutoverCandidate(firstRun.port, { ...firstRun.arm })).rejects.toThrow(
      'stale',
    );
    await expect(
      manager.finalizeCutoverCandidate(firstRun.port, finalizeIntent(firstRun.arm)),
    ).rejects.toThrow('stale');
    expect(manager.currentCutoverPort()).not.toBe(firstRun.port);
    expect(first.source.destroy).toHaveBeenCalledOnce();
    expect(successor.source.destroy).not.toHaveBeenCalled();
  });

  it('fails silent when rollback cannot cancel the old gate target mute', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    await startFirst(manager, current, destination, context);
    const candidate = makeSource(Q2, context, 3);
    const port = await manager.stageCutoverCandidate({ source: candidate.source, destination });
    const arm = armIntent(Q2);
    await manager.armCutoverCandidate(port, arm);
    const oldParam = context.gains[0]!.gain;
    oldParam.onSet = (value, time) => {
      if (value !== 0 || time !== 3) return;
      oldParam.throwOnValue = 1;
      void manager.retireCutoverCandidate(port);
    };

    await expect(manager.finalizeCutoverCandidate(port, finalizeIntent(arm))).rejects.toThrow();
    expect(manager.currentCutoverPort()).toBeNull();
    expect(manager.cutoverRecoveryRequired()).toBe(true);
    expect(context.gains[0]!.disconnect).toHaveBeenCalled();
    expect(context.gains[1]!.disconnect).toHaveBeenCalled();
    expect(current.source.destroy).toHaveBeenCalledOnce();
    expect(candidate.source.destroy).toHaveBeenCalledOnce();
  });

  it('does not resolve start evidence when the target clock getter revokes the candidate', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const candidate = makeSource(Q1, context, 1, 'audio-buffer');
    const { finalization } = await stageArmFinalize(manager, candidate, destination);
    context.currentTime = 1;
    context.onCurrentTimeRead = () => {
      context.onCurrentTimeRead = null;
      void manager.clear();
    };

    candidate.resolveStarted();
    await expect(finalization.started).rejects.toThrow('revocation');
    expect(manager.currentCutoverPort()).toBeNull();
    expect(candidate.source.destroy).toHaveBeenCalledOnce();
  });

  it('rejects V2 staging while legacy active or pending slots are owned', async () => {
    const activeContext = new FakeAudioContext();
    const activeDestination = destinationFor(activeContext);
    const activeManager = new FilePlaybackManager();
    const legacyActive = makeSource(Q1, activeContext, 1);
    await expect(
      activeManager.activate(legacyActive.source, activeDestination),
    ).resolves.toMatchObject({ published: true });
    const blockedByActive = makeSource(Q2, activeContext, 2);
    await expect(
      activeManager.stageCutoverCandidate({
        source: blockedByActive.source,
        destination: activeDestination,
      }),
    ).rejects.toThrow('legacy playback slots');
    expect(blockedByActive.source.destroy).toHaveBeenCalledOnce();
    expect(legacyActive.source.destroy).not.toHaveBeenCalled();

    const pendingContext = new FakeAudioContext();
    const pendingDestination = destinationFor(pendingContext);
    const pendingManager = new FilePlaybackManager();
    const legacyPending = makeSource(Q1, pendingContext, 1);
    legacyPending.gatePrepare();
    const pending = pendingManager.prepareStandby(legacyPending.source);
    await vi.waitFor(() => expect(legacyPending.source.prepare).toHaveBeenCalledOnce());
    const blockedByPending = makeSource(Q2, pendingContext, 2);
    await expect(
      pendingManager.stageCutoverCandidate({
        source: blockedByPending.source,
        destination: pendingDestination,
      }),
    ).rejects.toThrow('legacy playback slots');
    expect(blockedByPending.source.destroy).toHaveBeenCalledOnce();
    expect(legacyPending.source.destroy).not.toHaveBeenCalled();
    legacyPending.phase('ready');
    legacyPending.prepareGate.resolve(legacyPending.source.getSnapshot());
    await expect(pending).resolves.toMatchObject({ published: true });
  });

  it('rejects V2 staging while legacy standby or pending-active slots are owned', async () => {
    const standbyContext = new FakeAudioContext();
    const standbyDestination = destinationFor(standbyContext);
    const standbyManager = new FilePlaybackManager();
    const legacyStandby = makeSource(Q1, standbyContext, 1);
    await expect(standbyManager.prepareStandby(legacyStandby.source)).resolves.toMatchObject({
      published: true,
    });
    const blockedByStandby = makeSource(Q2, standbyContext, 2);
    await expect(
      standbyManager.stageCutoverCandidate({
        source: blockedByStandby.source,
        destination: standbyDestination,
      }),
    ).rejects.toThrow('legacy playback slots');
    expect(blockedByStandby.source.destroy).toHaveBeenCalledOnce();
    expect(legacyStandby.source.destroy).not.toHaveBeenCalled();

    const activeContext = new FakeAudioContext();
    const activeDestination = destinationFor(activeContext);
    const activeManager = new FilePlaybackManager();
    const legacyPendingActive = makeSource(Q1, activeContext, 1);
    legacyPendingActive.gatePrepare();
    const activation = activeManager.activate(legacyPendingActive.source, activeDestination);
    await vi.waitFor(() => expect(legacyPendingActive.source.prepare).toHaveBeenCalledOnce());
    const blockedByPendingActive = makeSource(Q2, activeContext, 2);
    await expect(
      activeManager.stageCutoverCandidate({
        source: blockedByPendingActive.source,
        destination: activeDestination,
      }),
    ).rejects.toThrow('legacy playback slots');
    expect(blockedByPendingActive.source.destroy).toHaveBeenCalledOnce();
    expect(legacyPendingActive.source.destroy).not.toHaveBeenCalled();
    legacyPendingActive.phase('ready');
    legacyPendingActive.prepareGate.resolve(legacyPendingActive.source.getSnapshot());
    await expect(activation).resolves.toMatchObject({ published: true });
  });

  it('clears a hung V2 stage reservation so legacy activation can proceed', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const stale = makeSource(Q1, context, 1);
    stale.gatePrepare();
    const staging = manager.stageCutoverCandidate({ source: stale.source, destination });
    void staging.catch(() => undefined);
    await vi.waitFor(() => expect(stale.source.prepare).toHaveBeenCalledOnce());

    await expect(manager.clear()).resolves.toBeUndefined();
    expect(stale.source.destroy).toHaveBeenCalledOnce();

    const legacy = makeSource(Q2, context, 2);
    await expect(manager.activate(legacy.source, destination)).resolves.toMatchObject({
      published: true,
    });
    expect(manager.activeSource()).toBe(legacy.source);

    stale.phase('ready');
    stale.prepareGate.resolve(stale.source.getSnapshot());
    await expect(staging).rejects.toThrow('expired or was superseded');
    expect(stale.source.connect).not.toHaveBeenCalled();
    expect(manager.activeSource()).toBe(legacy.source);
    expect(legacy.source.destroy).not.toHaveBeenCalled();
  });

  it('does not let an old stage finalizer release a next-generation reservation', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const stale = makeSource(Q1, context, 1);
    stale.gatePrepare();
    const staleStaging = manager.stageCutoverCandidate({ source: stale.source, destination });
    void staleStaging.catch(() => undefined);
    await vi.waitFor(() => expect(stale.source.prepare).toHaveBeenCalledOnce());
    await manager.clear();

    const current = makeSource(Q2, context, 2);
    current.gatePrepare();
    const currentStaging = manager.stageCutoverCandidate({ source: current.source, destination });
    await vi.waitFor(() => expect(current.source.prepare).toHaveBeenCalledOnce());

    stale.phase('ready');
    stale.prepareGate.resolve(stale.source.getSnapshot());
    await expect(staleStaging).rejects.toThrow('expired or was superseded');

    const blockedLegacy = makeSource(Q3, context, 3);
    await expect(manager.activate(blockedLegacy.source, destination)).resolves.toMatchObject({
      published: false,
      reason: 'superseded',
    });
    expect(blockedLegacy.source.destroy).toHaveBeenCalledOnce();

    current.phase('ready');
    current.prepareGate.resolve(current.source.getSnapshot());
    await expect(currentStaging).resolves.not.toBeNull();
    expect(current.source.destroy).not.toHaveBeenCalled();
  });

  it('rejects legacy activation and standby without disturbing V2 ownership', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    const { port } = await startFirst(manager, current, destination, context);
    const legacyActive = makeSource(Q2, context, 2);
    const legacyStandby = makeSource(Q3, context, 3);

    await expect(manager.activate(legacyActive.source, destination)).resolves.toMatchObject({
      published: false,
      reason: 'superseded',
    });
    await expect(manager.prepareStandby(legacyStandby.source)).resolves.toMatchObject({
      published: false,
      reason: 'superseded',
    });
    expect(legacyActive.source.destroy).toHaveBeenCalledOnce();
    expect(legacyStandby.source.destroy).toHaveBeenCalledOnce();
    expect(manager.currentCutoverPort()).toBe(port);
    expect(current.source.destroy).not.toHaveBeenCalled();
    expect(manager.activeSource()).toBeNull();
    expect(manager.standbySource()).toBeNull();
  });

  it('rechecks V2 mode after a legacy activation authority callback re-enters staging', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const v2 = makeSource(Q1, context, 1);
    const legacy = makeSource(Q2, context, 2);
    let staging: Promise<FilePlaybackCutoverCandidatePort> | null = null;
    const authority = () => {
      staging = manager.stageCutoverCandidate({ source: v2.source, destination });
      return true;
    };

    await expect(manager.activate(legacy.source, destination, authority)).resolves.toMatchObject({
      published: false,
      reason: 'superseded',
    });
    const port = await staging;
    expect(port).not.toBeNull();
    expect(manager.activeSource()).toBeNull();
    expect(legacy.source.destroy).toHaveBeenCalledOnce();
    expect(v2.source.destroy).not.toHaveBeenCalled();
  });

  it('commits STOP only after the exact outer-gate frame and never calls backend control', async () => {
    vi.useFakeTimers();
    try {
      const context = new FakeAudioContext();
      const destination = destinationFor(context);
      const manager = new FilePlaybackManager();
      const current = makeSource(Q1, context, 1);
      const { port } = await startFirst(manager, current, destination, context);
      const intent = currentStopIntent(context, 2);

      const first = manager.stopCurrentCutover(port, intent);
      const retry = manager.stopCurrentCutover(port, { ...intent });
      expect(retry).toBe(first);
      const scheduled = await first;
      expect(context.gains[0]!.gain.events).toContainEqual({ value: 0, time: 2 });
      expect(current.source.pause).not.toHaveBeenCalled();
      expect(current.source.seek).not.toHaveBeenCalled();
      expect(current.source.cancel).not.toHaveBeenCalled();
      expect(manager.currentCutoverPort()).toBe(port);

      context.currentTime = 2;
      await vi.advanceTimersByTimeAsync(50);
      await expect(scheduled.applied).resolves.toMatchObject({
        kind: 'stop-applied',
        observation: 'webaudio-schedule-passed',
        targetFrame: 96_000,
        appliedFrame: 96_000,
      });
      expect(manager.currentCutoverPort()).toBeNull();
      expect(manager.snapshot().active).toBeNull();
      expect(current.source.destroy).toHaveBeenCalledOnce();
      const completedRetry = manager.stopCurrentCutover(port, { ...intent });
      expect(completedRetry).toBe(first);
      expect(await completedRetry).toBe(scheduled);
      await expect(
        manager.stopCurrentCutover(port, { ...intent, atRoomTimeMs: intent.atRoomTimeMs + 1 }),
      ).rejects.toThrow('stale');
      expect(current.source.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires an exact failed current source while AudioContext is suspended without claiming scheduled evidence', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    const { port } = await startFirst(manager, current, destination, context);
    current.phase('failed');
    current.gateDestroy();
    context.state = 'suspended';
    const intent = currentStopIntent(context, 2);

    const first = manager.stopCurrentCutover(port, intent);
    const retry = manager.stopCurrentCutover(port, { ...intent });
    expect(retry).toBe(first);
    const retired = await first;

    expect(retired).toMatchObject({
      status: 'failed-retired',
      from: intent.from,
      to: intent.to,
      target: intent.target,
    });
    expect(manager.currentCutoverPort()).toBeNull();
    expect(manager.snapshot().active).toBeNull();
    expect(manager.cutoverRecoveryRequired()).toBe(false);
    expect(current.source.pause).not.toHaveBeenCalled();
    expect(current.source.seek).not.toHaveBeenCalled();
    expect(current.source.cancel).not.toHaveBeenCalled();
    expect(current.source.destroy).toHaveBeenCalledOnce();
    expect(context.gains[0]!.gain.events).not.toContainEqual({ value: 0, time: 2 });

    let appliedSettled = false;
    void retired.applied.finally(() => {
      appliedSettled = true;
    });
    await Promise.resolve();
    expect(appliedSettled).toBe(false);

    current.destroyGate.resolve();
    await expect(retired.applied).resolves.toEqual({
      kind: 'failed-stop-applied',
      observation: 'source-failed-retired',
      from: intent.from,
      to: intent.to,
    });
    expect(appliedSettled).toBe(true);

    const completedRetry = manager.stopCurrentCutover(port, { ...intent });
    expect(completedRetry).toBe(first);
    expect(await completedRetry).toBe(retired);
    await expect(
      manager.stopCurrentCutover(port, { ...intent, atRoomTimeMs: intent.atRoomTimeMs + 1 }),
    ).rejects.toThrow('stale');
  });

  it('commits a consecutive paused-to-stopped revision on the same exact gate', async () => {
    vi.useFakeTimers();
    try {
      const context = new FakeAudioContext();
      const destination = destinationFor(context);
      const manager = new FilePlaybackManager();
      const current = makeSource(Q1, context, 1);
      const { port } = await startFirst(manager, current, destination, context);
      const pausing = await manager.pauseCurrentCutover(port, currentPauseIntent());
      context.currentTime = 2;
      current.applyTransition(96_000);
      if (pausing.status === 'scheduled') await pausing.applied;
      expect(manager.currentCutoverSnapshot(port)).toMatchObject({ phase: 'paused', revision: 2 });

      const stopped = await manager.stopCurrentCutover(port, currentStopIntent(context, 3, 2));
      context.currentTime = 3;
      await vi.advanceTimersByTimeAsync(50);
      await expect(stopped.applied).resolves.toMatchObject({
        from: { revision: 2 },
        to: { revision: 3 },
        targetFrame: 144_000,
      });
      expect(manager.currentCutoverPort()).toBeNull();
      expect(current.source.cancel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the exact current renderer when pre-target stop automation rolls back', async () => {
    vi.useFakeTimers();
    try {
      const context = new FakeAudioContext();
      const destination = destinationFor(context);
      const manager = new FilePlaybackManager();
      const current = makeSource(Q1, context, 1);
      const { port } = await startFirst(manager, current, destination, context);
      context.gains[0]!.gain.throwOnValue = 0;

      await expect(manager.stopCurrentCutover(port, currentStopIntent(context, 2))).rejects.toThrow(
        'gate automation failed',
      );
      expect(manager.currentCutoverPort()).toBe(port);
      expect(manager.cutoverRecoveryRequired()).toBe(false);
      expect(current.source.destroy).not.toHaveBeenCalled();
      expect(context.gains[0]!.gain.valueAt(context.currentTime)).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails silent when STOP rollback crosses the target between native clock reads', async () => {
    vi.useFakeTimers();
    try {
      const context = new FakeAudioContext();
      const destination = destinationFor(context);
      const manager = new FilePlaybackManager();
      const current = makeSource(Q1, context, 1);
      const { port } = await startFirst(manager, current, destination, context);
      let rollbackClockReads = 0;
      context.gains[0]!.gain.onSet = (value, time) => {
        if (value !== 0 || time !== 2) return;
        context.onCurrentTimeRead = () => {
          rollbackClockReads += 1;
          if (rollbackClockReads === 2) context.currentTime = 2;
        };
        throw new Error('native stop automation failed before rollback');
      };

      await expect(manager.stopCurrentCutover(port, currentStopIntent(context, 2))).rejects.toThrow(
        'native stop automation failed',
      );
      context.onCurrentTimeRead = null;
      expect(rollbackClockReads).toBeGreaterThanOrEqual(2);
      expect(manager.currentCutoverPort()).toBeNull();
      expect(manager.cutoverRecoveryRequired()).toBe(true);
      expect(current.source.destroy).toHaveBeenCalledOnce();
      expect(context.gains[0]!.gain.valueAt(2)).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not restore a stale STOP gate after a rollback clock read retires current', async () => {
    vi.useFakeTimers();
    try {
      const context = new FakeAudioContext();
      const destination = destinationFor(context);
      const manager = new FilePlaybackManager();
      const current = makeSource(Q1, context, 1);
      const { port } = await startFirst(manager, current, destination, context);
      context.gains[0]!.gain.onSet = (value, time) => {
        if (value !== 0 || time !== 2) return;
        context.onCurrentTimeRead = () => {
          context.onCurrentTimeRead = null;
          void manager.retireCurrentCutover(port);
        };
        throw new Error('native stop automation entered stale rollback');
      };

      await expect(manager.stopCurrentCutover(port, currentStopIntent(context, 2))).rejects.toThrow(
        'stale rollback',
      );
      const lastGateEvent = context.gains[0]!.gain.events.at(-1);
      expect(manager.currentCutoverPort()).toBeNull();
      expect(current.source.destroy).toHaveBeenCalledOnce();
      expect(lastGateEvent?.value).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails silent when native stop automation crosses its target before throwing', async () => {
    vi.useFakeTimers();
    try {
      const context = new FakeAudioContext();
      const destination = destinationFor(context);
      const manager = new FilePlaybackManager();
      const current = makeSource(Q1, context, 1);
      const { port } = await startFirst(manager, current, destination, context);
      context.gains[0]!.gain.onSet = (value, time) => {
        if (value !== 0 || time !== 2) return;
        context.currentTime = 2;
        throw new Error('native callback crossed target');
      };

      await expect(manager.stopCurrentCutover(port, currentStopIntent(context, 2))).rejects.toThrow(
        'crossed target',
      );
      expect(manager.currentCutoverPort()).toBeNull();
      expect(manager.cutoverRecoveryRequired()).toBe(true);
      expect(current.source.destroy).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when native gate automation re-enters current retirement', async () => {
    vi.useFakeTimers();
    try {
      const context = new FakeAudioContext();
      const destination = destinationFor(context);
      const manager = new FilePlaybackManager();
      const current = makeSource(Q1, context, 1);
      const { port } = await startFirst(manager, current, destination, context);
      context.gains[0]!.gain.onSet = (value, time) => {
        if (value !== 0 || time !== 2) return;
        context.gains[0]!.gain.onSet = null;
        void manager.retireCurrentCutover(port);
      };

      await expect(manager.stopCurrentCutover(port, currentStopIntent(context, 2))).rejects.toThrow(
        'authority',
      );
      expect(manager.currentCutoverPort()).toBeNull();
      expect(current.source.destroy).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects and retires finite stop evidence when the AudioContext is interrupted', async () => {
    vi.useFakeTimers();
    try {
      const context = new FakeAudioContext();
      const destination = destinationFor(context);
      const manager = new FilePlaybackManager();
      const current = makeSource(Q1, context, 1);
      const { port } = await startFirst(manager, current, destination, context);
      const scheduled = await manager.stopCurrentCutover(port, currentStopIntent(context, 2));

      context.state = 'suspended';
      await vi.advanceTimersByTimeAsync(50);
      await expect(scheduled.applied).rejects.toThrow('AudioContext stopped');
      expect(manager.currentCutoverPort()).toBeNull();
      expect(manager.cutoverRecoveryRequired()).toBe(true);
      expect(current.source.destroy).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechecks current authority after native clock reads before committing STOP', async () => {
    vi.useFakeTimers();
    try {
      const context = new FakeAudioContext();
      const destination = destinationFor(context);
      const manager = new FilePlaybackManager();
      const current = makeSource(Q1, context, 1);
      let authorized = true;
      const { port } = await startFirst(manager, current, destination, context, () => authorized);
      const scheduled = await manager.stopCurrentCutover(port, currentStopIntent(context, 2));

      context.currentTime = 2;
      context.onCurrentTimeRead = () => {
        context.onCurrentTimeRead = null;
        authorized = false;
      };
      await vi.advanceTimersByTimeAsync(50);

      await expect(scheduled.applied).rejects.toThrow(/lost authority|authority expired/u);
      expect(manager.currentCutoverPort()).toBeNull();
      expect(manager.cutoverRecoveryRequired()).toBe(true);
      expect(current.source.destroy).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails silent if the product destination changes AudioContext before STOP', async () => {
    const context = new FakeAudioContext();
    let destinationContext = context;
    const destination = Object.defineProperty({}, 'context', {
      configurable: true,
      enumerable: true,
      get: () => destinationContext,
    }) as AudioNode;
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    const { port } = await startFirst(manager, current, destination, context);

    destinationContext = new FakeAudioContext();
    await expect(manager.stopCurrentCutover(port, currentStopIntent(context, 2))).rejects.toThrow(
      'one AudioContext clock',
    );
    expect(manager.currentCutoverPort()).toBeNull();
    expect(manager.cutoverRecoveryRequired()).toBe(true);
    expect(current.source.destroy).toHaveBeenCalledOnce();
  });

  it('bounds a running-but-frozen AudioContext and clears the evidence timer', async () => {
    vi.useFakeTimers();
    try {
      const context = new FakeAudioContext();
      const destination = destinationFor(context);
      const manager = new FilePlaybackManager();
      const current = makeSource(Q1, context, 1);
      const { port } = await startFirst(manager, current, destination, context);
      const scheduled = await manager.stopCurrentCutover(port, currentStopIntent(context, 2));

      await vi.advanceTimersByTimeAsync(3_100);
      await expect(scheduled.applied).rejects.toThrow('deadline');
      expect(manager.currentCutoverPort()).toBeNull();
      expect(manager.cutoverRecoveryRequired()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending stop on teardown without leaving a timer or promise behind', async () => {
    vi.useFakeTimers();
    try {
      const context = new FakeAudioContext();
      const destination = destinationFor(context);
      const manager = new FilePlaybackManager();
      const current = makeSource(Q1, context, 1);
      const { port } = await startFirst(manager, current, destination, context);
      const scheduled = await manager.stopCurrentCutover(port, currentStopIntent(context, 2));

      await manager.clear();
      await expect(scheduled.applied).rejects.toThrow('retired before stop evidence');
      expect(manager.currentCutoverPort()).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a strictly later candidate replace a pending stop without stale retirement', async () => {
    vi.useFakeTimers();
    try {
      const context = new FakeAudioContext();
      const destination = destinationFor(context);
      const manager = new FilePlaybackManager();
      const current = makeSource(Q1, context, 1);
      const { port: oldPort } = await startFirst(manager, current, destination, context);
      const stopped = await manager.stopCurrentCutover(oldPort, currentStopIntent(context, 4));

      const successor = makeSource(Q1, context, 2);
      const successorPort = await manager.stageCutoverCandidate({
        source: successor.source,
        destination,
      });
      const successorArm: RendezvousArmIntent = {
        ...armIntent(Q1, 'rv-successor'),
        revision: 3,
      };
      await manager.armCutoverCandidate(successorPort, successorArm);
      const finalized = await manager.finalizeCutoverCandidate(
        successorPort,
        finalizeIntent(successorArm),
      );
      await expect(stopped.applied).rejects.toThrow('superseded');

      context.currentTime = 2;
      successor.resolveStarted();
      await finalized.started;
      expect(manager.currentCutoverPort()).toBe(successorPort);
      context.currentTime = 4;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(manager.currentCutoverPort()).toBe(successorPort);
      expect(successor.source.destroy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails silent if a candidate that superseded STOP loses start evidence', async () => {
    vi.useFakeTimers();
    try {
      const context = new FakeAudioContext();
      const destination = destinationFor(context);
      const manager = new FilePlaybackManager();
      const current = makeSource(Q1, context, 1);
      const { port: oldPort } = await startFirst(manager, current, destination, context);
      const stopped = await manager.stopCurrentCutover(oldPort, currentStopIntent(context, 4));

      const successor = makeSource(Q1, context, 2);
      const successorPort = await manager.stageCutoverCandidate({
        source: successor.source,
        destination,
      });
      const successorArm: RendezvousArmIntent = {
        ...armIntent(Q1, 'rv-failing-successor'),
        revision: 3,
      };
      await manager.armCutoverCandidate(successorPort, successorArm);
      const finalized = await manager.finalizeCutoverCandidate(
        successorPort,
        finalizeIntent(successorArm),
      );
      await expect(stopped.applied).rejects.toThrow('superseded');

      successor.started.reject(new Error('successor start failed'));
      await expect(finalized.started).rejects.toThrow('successor start failed');
      expect(manager.currentCutoverPort()).toBeNull();
      expect(manager.cutoverRecoveryRequired()).toBe(true);
      expect(current.source.destroy).toHaveBeenCalledOnce();
      expect(successor.source.destroy).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the pending STOP if a later candidate gate fails before replacement', async () => {
    vi.useFakeTimers();
    try {
      const context = new FakeAudioContext();
      const destination = destinationFor(context);
      const manager = new FilePlaybackManager();
      const current = makeSource(Q1, context, 1);
      const { port: oldPort } = await startFirst(manager, current, destination, context);
      const stopped = await manager.stopCurrentCutover(oldPort, currentStopIntent(context, 4));

      const successor = makeSource(Q1, context, 2);
      const successorPort = await manager.stageCutoverCandidate({
        source: successor.source,
        destination,
      });
      const successorArm: RendezvousArmIntent = {
        ...armIntent(Q1, 'rv-gate-failing-successor'),
        revision: 3,
      };
      await manager.armCutoverCandidate(successorPort, successorArm);
      context.gains[1]!.gain.throwOnValue = 1;
      await expect(
        manager.finalizeCutoverCandidate(successorPort, finalizeIntent(successorArm)),
      ).rejects.toThrow('gate automation failed');
      expect(manager.currentCutoverPort()).toBe(oldPort);
      expect(context.gains[0]!.gain.events).toContainEqual({ value: 0, time: 4 });

      context.currentTime = 4;
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(stopped.applied).resolves.toMatchObject({ targetFrame: 192_000 });
      expect(manager.currentCutoverPort()).toBeNull();
      expect(successor.source.destroy).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects stale, conflicting, and unbounded STOP without disturbing current audio', async () => {
    vi.useFakeTimers();
    try {
      const context = new FakeAudioContext();
      const destination = destinationFor(context);
      const manager = new FilePlaybackManager();
      const current = makeSource(Q1, context, 1);
      const { port } = await startFirst(manager, current, destination, context);
      const stale = currentStopIntent(context, 2, 2);
      await expect(manager.stopCurrentCutover(port, stale)).rejects.toThrow('not current');
      const far = currentStopIntent(context, 32);
      await expect(manager.stopCurrentCutover(port, far)).rejects.toThrow('bounded future');

      const exact = currentStopIntent(context, 3);
      const scheduled = await manager.stopCurrentCutover(port, exact);
      const conflicting = currentStopIntent(context, 4);
      await expect(manager.stopCurrentCutover(port, conflicting)).rejects.toThrow(
        'another current transition',
      );
      await expect(manager.pauseCurrentCutover(port, currentPauseIntent())).rejects.toThrow(
        'another current transition',
      );
      expect(manager.currentCutoverPort()).toBe(port);
      expect(current.source.destroy).not.toHaveBeenCalled();
      await manager.clear();
      await expect(scheduled.applied).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocks STOP while pause evidence owns the revision transition slot', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    const { port } = await startFirst(manager, current, destination, context);
    const pausing = await manager.pauseCurrentCutover(port, currentPauseIntent());
    await expect(manager.stopCurrentCutover(port, currentStopIntent(context, 2))).rejects.toThrow(
      'another current transition',
    );
    current.applyTransition();
    if (pausing.status === 'scheduled') await pausing.applied;
  });

  it('retires an exact ended renderer and returns idempotent body-free evidence', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    const { port } = await startFirst(manager, current, destination, context);
    current.phase('ended');
    current.gateDestroy();
    const intent = currentEndedIntent();

    const first = manager.retireEndedCurrent(port, intent);
    const retry = manager.retireEndedCurrent(port, { ...intent });

    expect(retry).toBe(first);
    expect(manager.currentCutoverPort()).toBeNull();
    expect(current.source.destroy).toHaveBeenCalledOnce();
    current.destroyGate.resolve();
    await expect(first).resolves.toEqual({
      kind: 'ended-renderer-retired',
      from: intent.from,
      to: intent.to,
      observedAtRoomTimeMs: intent.observedAtRoomTimeMs,
    });
    expect(JSON.stringify(await first)).not.toContain('AudioContext');
    expect(manager.currentCutoverSnapshot(port)).toBeNull();
  });

  it('never retires a playing renderer or an ended renderer with a staged successor', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    const { port } = await startFirst(manager, current, destination, context);

    await expect(manager.retireEndedCurrent(port, currentEndedIntent())).rejects.toThrow(
      'has not ended',
    );
    expect(manager.currentCutoverPort()).toBe(port);
    expect(current.source.destroy).not.toHaveBeenCalled();

    current.phase('ended');
    const successor = makeSource(Q2, context, 3);
    await manager.stageCutoverCandidate({ source: successor.source, destination });
    await expect(manager.retireEndedCurrent(port, currentEndedIntent())).rejects.toThrow(
      'conflicting transition',
    );
    expect(manager.currentCutoverPort()).toBe(port);
    expect(current.source.destroy).not.toHaveBeenCalled();
  });

  it.each(['playing', 'paused', 'ended'] as const)(
    'atomically retires the exact remote-ended renderer observed while %s',
    async (observedPhase) => {
      const context = new FakeAudioContext();
      const destination = destinationFor(context);
      const manager = new FilePlaybackManager();
      const current = makeSource(Q1, context, 1);
      const { port } = await startFirst(manager, current, destination, context);
      current.phase(observedPhase);
      current.gateDestroy();
      const intent = currentRemoteEndedIntent();

      const first = manager.retireRemoteEndedCurrent(port, intent);
      const retry = manager.retireRemoteEndedCurrent(port, { ...intent });

      expect(retry).toBe(first);
      expect(manager.currentCutoverPort()).toBeNull();
      expect(context.gains[0]?.gain.valueAt(context.currentTime)).toBe(0);
      expect(context.gains[0]?.disconnect).toHaveBeenCalledOnce();
      expect(current.source.destroy).toHaveBeenCalledOnce();
      current.destroyGate.resolve();
      await expect(first).resolves.toEqual({
        kind: 'remote-ended-renderer-retired',
        from: intent.from,
        to: intent.to,
        hostObservedAtRoomTimeMs: intent.hostObservedAtRoomTimeMs,
        observedPhase,
      });
      expect(JSON.stringify(await first)).not.toContain('targetFrame');
    },
  );

  it('publishes the exact remote-ended retry tombstone before native gate retirement can re-enter', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    const { port } = await startFirst(manager, current, destination, context);
    current.gateDestroy();
    const intent = currentRemoteEndedIntent();
    let reentrantRetry: Promise<unknown> | null = null;
    context.gains[0]!.gain.onSet = (value) => {
      if (value === 0 && reentrantRetry === null) {
        reentrantRetry = manager.retireRemoteEndedCurrent(port, { ...intent });
      }
    };

    const first = manager.retireRemoteEndedCurrent(port, intent);

    expect(reentrantRetry).toBe(first);
    expect(manager.currentCutoverPort()).toBeNull();
    expect(current.source.destroy).toHaveBeenCalledOnce();
    current.destroyGate.resolve();
    await expect(first).resolves.toMatchObject({
      kind: 'remote-ended-renderer-retired',
      from: intent.from,
      to: intent.to,
    });
  });

  it('never emits remote-ended evidence after current authority expires', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    let authorityLive = true;
    const { port } = await startFirst(manager, current, destination, context, () => authorityLive);
    const intent = currentRemoteEndedIntent();
    authorityLive = false;

    await expect(manager.retireRemoteEndedCurrent(port, intent)).rejects.toThrow(
      'authority expired',
    );
    expect(manager.currentCutoverPort()).toBeNull();
    expect(manager.cutoverRecoveryRequired()).toBe(true);
    expect(current.source.destroy).toHaveBeenCalledOnce();
    await expect(manager.retireRemoteEndedCurrent(port, { ...intent })).rejects.toThrow('stale');
  });

  it('never emits remote-ended evidence when its authority callback re-entrantly retires current', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    let port: FilePlaybackCutoverCandidatePort | null = null;
    let reenterAuthority = false;
    let reentrantCleanup: Promise<boolean> | null = null;
    const authority = (): boolean => {
      if (reenterAuthority && reentrantCleanup === null) {
        if (!port) throw new Error('Remote-ended authority re-entry has no exact port');
        reentrantCleanup = manager.retireCurrentCutover(port);
      }
      return true;
    };
    ({ port } = await startFirst(manager, current, destination, context, authority));
    current.gateDestroy();
    const intent = currentRemoteEndedIntent();
    reenterAuthority = true;

    await expect(manager.retireRemoteEndedCurrent(port, intent)).rejects.toThrow(
      'authority expired',
    );
    expect(reentrantCleanup).not.toBeNull();
    expect(manager.currentCutoverPort()).toBeNull();
    await expect(manager.retireRemoteEndedCurrent(port, { ...intent })).rejects.toThrow('stale');
    current.destroyGate.resolve();
    await expect(reentrantCleanup!).resolves.toBe(true);
    expect(current.source.destroy).toHaveBeenCalledOnce();
  });

  it('rejects stale remote-ended state and every live replacement candidate', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    const { port } = await startFirst(manager, current, destination, context);

    await expect(
      manager.retireRemoteEndedCurrent(port, currentRemoteEndedIntent(2)),
    ).rejects.toThrow('not current');
    expect(manager.currentCutoverPort()).toBe(port);

    const successor = makeSource(Q2, context, 3);
    const staging = manager.stageCutoverCandidate({ source: successor.source, destination });
    await expect(
      manager.retireRemoteEndedCurrent(port, currentRemoteEndedIntent()),
    ).rejects.toThrow('conflicting transition');
    await staging;
    await expect(
      manager.retireRemoteEndedCurrent(port, currentRemoteEndedIntent()),
    ).rejects.toThrow('conflicting transition');
    expect(manager.currentCutoverPort()).toBe(port);
    expect(current.source.destroy).not.toHaveBeenCalled();
    await manager.clear();
  });

  it('rejects remote-ended retirement while a physical revision transition is pending', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    const { port } = await startFirst(manager, current, destination, context);
    const pausing = await manager.pauseCurrentCutover(port, currentPauseIntent());

    await expect(
      manager.retireRemoteEndedCurrent(port, currentRemoteEndedIntent()),
    ).rejects.toThrow('conflicting transition');
    expect(manager.currentCutoverPort()).toBe(port);
    current.applyTransition();
    if (pausing.status === 'scheduled') await pausing.applied;
    await manager.clear();
  });

  it('never emits remote-ended evidence from a snapshot that re-entrantly retires current', async () => {
    const context = new FakeAudioContext();
    const destination = destinationFor(context);
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, context, 1);
    const { port } = await startFirst(manager, current, destination, context);
    const snapshot = current.source.getSnapshot();
    vi.mocked(current.source.getSnapshot).mockImplementationOnce(() => {
      void manager.retireCurrentCutover(port);
      return snapshot;
    });

    await expect(
      manager.retireRemoteEndedCurrent(port, currentRemoteEndedIntent()),
    ).rejects.toThrow('changed during snapshot preflight');
    expect(manager.currentCutoverPort()).toBeNull();
    expect(current.source.destroy).toHaveBeenCalledOnce();
  });
});
