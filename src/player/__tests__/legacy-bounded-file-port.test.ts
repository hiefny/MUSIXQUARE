import { describe, expect, it, vi } from 'vitest';

import {
  createFilePlaybackCutoverTarget,
  createFilePlaybackRejectedTransitionResult,
  createFilePlaybackScheduledTransitionResult,
  createFilePlaybackTransitionEvidence,
  createStreamingPlaybackStartEvidence,
  type FilePlaybackCutoverArmResult,
  type FilePlaybackCutoverSource,
  type FilePlaybackBackend,
  type FilePlaybackPauseTransitionIntent,
  type FilePlaybackSeekTransitionIntent,
  type FilePlaybackStartEvidence,
  type FilePlaybackSourcePhase,
  type FilePlaybackSourceSnapshot,
  type FilePlaybackTransitionIntent,
  type FilePlaybackTransitionResult,
} from '../file-playback-source.ts';
import type {
  RendezvousArmIntent,
  RendezvousArmReceipt,
  RendezvousFinalizeIntent,
  RendezvousFinalizeReceipt,
  RevisionedPlaybackRun,
} from '../rendezvous-contract.ts';
import type {
  LegacyBoundedFileLease,
  LegacyBoundedFileScope,
} from '../legacy-bounded-file-port-contract.ts';
import {
  createLegacyBoundedFilePort,
  LegacyBoundedFilePortForTests as LegacyBoundedFilePort,
} from '../legacy-bounded-file-port.ts';

const Q1 = '00000000-0000-4000-8000-000000000001';
const Q2 = '00000000-0000-4000-8000-000000000002';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeAudioParam {
  readonly events: Array<Readonly<{ value: number; time: number }>> = [];

  cancelScheduledValues(time: number): AudioParam {
    const retained = this.events.filter((event) => event.time < time);
    this.events.splice(0, this.events.length, ...retained);
    return this as unknown as AudioParam;
  }

  setValueAtTime(value: number, time: number): AudioParam {
    this.events.push({ value, time });
    return this as unknown as AudioParam;
  }
}

class FakeGainNode {
  readonly gain = new FakeAudioParam();
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();

  constructor(readonly context: FakeAudioContext) {}
}

class FakeAudioContext {
  currentTime = 0;
  readonly sampleRate = 48_000;
  state: AudioContextState = 'running';
  readonly gains: FakeGainNode[] = [];

  createGain(): GainNode {
    const gain = new FakeGainNode(this);
    this.gains.push(gain);
    return gain as unknown as GainNode;
  }
}

function destinationFor(context: FakeAudioContext): AudioNode {
  return { context } as unknown as AudioNode;
}

function armReceipt(intent: RendezvousArmIntent, nowRoomTimeMs: number): RendezvousArmReceipt {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-armed',
    queueItemId: intent.queueItemId,
    runId: intent.runId,
    revision: intent.revision,
    rendezvousId: intent.rendezvousId,
    participantId: intent.recipientId,
    status: 'armed',
    observedAtRoomTimeMs: nowRoomTimeMs,
    bufferedAheadSeconds: 8,
    reasonCode: null,
  };
}

function finalizeReceipt(
  intent: RendezvousFinalizeIntent,
  nowRoomTimeMs: number,
): RendezvousFinalizeReceipt {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-finalized',
    queueItemId: intent.queueItemId,
    runId: intent.runId,
    revision: intent.revision,
    rendezvousId: intent.rendezvousId,
    participantId: intent.recipientId,
    status: 'accepted',
    observedAtRoomTimeMs: nowRoomTimeMs,
    reasonCode: null,
  };
}

interface FakeSource {
  readonly source: FilePlaybackCutoverSource;
  readonly primeGate: ReturnType<typeof deferred<void>>;
  readonly startedGate: ReturnType<typeof deferred<FilePlaybackStartEvidence>>;
  readonly destroyGate: ReturnType<typeof deferred<void>>;
  gatePrime(): void;
  releasePrime(): void;
  gateStarted(): void;
  resolveStarted(): void;
  rejectStarted(error?: unknown): void;
  markEnded(): void;
  throwPosition(): void;
  gateDestroy(): void;
  releaseDestroy(): void;
  rejectDestroy(error?: unknown): void;
}

function makeSource(
  queueItemId: string,
  context: FakeAudioContext,
  nowRoomTimeMs: () => number,
  backend: FilePlaybackBackend = 'bounded-stream',
): FakeSource {
  let phase: FilePlaybackSourcePhase = 'new';
  let revision = 0;
  let run: RevisionedPlaybackRun | null = null;
  let positionSeconds = 0;
  let primeGated = false;
  let startedGated = false;
  let startedTargetFrame: number | null = null;
  let positionThrows = false;
  let destroyGated = false;
  let destroyError: unknown = null;
  const primeGate = deferred<void>();
  const startedGate = deferred<FilePlaybackStartEvidence>();
  const destroyGate = deferred<void>();
  void startedGate.promise.catch(() => undefined);

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

  const transition = async (
    intent: FilePlaybackTransitionIntent,
  ): Promise<FilePlaybackTransitionResult> => {
    const before = snapshot();
    const contextTimeSeconds = context.currentTime + 0.05;
    const targetFrame = Math.round(contextTimeSeconds * context.sampleRate);
    revision = intent.to.revision;
    run = Object.freeze({ ...intent.to });
    phase = 'paused';
    if (intent.kind === 'file-playback-seek-transition') {
      positionSeconds = intent.positionSeconds;
    }
    return createFilePlaybackScheduledTransitionResult(
      intent,
      createFilePlaybackCutoverTarget(
        context as unknown as AudioContext,
        contextTimeSeconds,
        targetFrame,
      ),
      before,
      Promise.resolve(
        createFilePlaybackTransitionEvidence(intent, 'worklet-observed', targetFrame, targetFrame),
      ),
    );
  };

  const source: FilePlaybackCutoverSource = {
    queueItemId,
    backend,
    prepare: vi.fn(async () => {
      phase = 'ready';
      return snapshot();
    }),
    connect: vi.fn(async () => {
      phase = 'connected';
      return snapshot();
    }),
    primeForCutover: vi.fn(async (nextPositionSeconds, signal) => {
      signal.throwIfAborted();
      if (primeGated) {
        await primeGate.promise;
        signal.throwIfAborted();
      }
      positionSeconds = nextPositionSeconds;
      return snapshot();
    }),
    arm: vi.fn(async (intent) => armReceipt(intent, nowRoomTimeMs())),
    armForCutover: vi.fn(async (intent): Promise<FilePlaybackCutoverArmResult> => {
      phase = 'armed';
      revision = intent.revision;
      run = Object.freeze({
        queueItemId: intent.queueItemId,
        runId: intent.runId,
        revision: intent.revision,
      });
      const contextTimeSeconds = context.currentTime + 0.1;
      const targetFrame = Math.round(contextTimeSeconds * context.sampleRate);
      startedTargetFrame = targetFrame;
      return {
        status: 'armed',
        receipt: armReceipt(intent, nowRoomTimeMs()),
        target: createFilePlaybackCutoverTarget(
          context as unknown as AudioContext,
          contextTimeSeconds,
          targetFrame,
        ),
        started: startedGated
          ? startedGate.promise
          : Promise.resolve(createStreamingPlaybackStartEvidence(targetFrame, targetFrame)),
      };
    }),
    finalize: vi.fn(async (intent) => {
      phase = 'playing';
      return finalizeReceipt(intent, nowRoomTimeMs());
    }),
    cancel: vi.fn(async () => snapshot()),
    pause: vi.fn(async () => snapshot()),
    seek: vi.fn(async () => snapshot()),
    pauseRevisioned: vi.fn((intent: FilePlaybackPauseTransitionIntent) => transition(intent)),
    seekRevisioned: vi.fn((intent: FilePlaybackSeekTransitionIntent) => transition(intent)),
    positionAt: vi.fn(() => {
      if (positionThrows) throw new Error('position unavailable');
      return {
        queueItemId,
        run,
        phase,
        positionSeconds,
        bufferedAheadSeconds: 8,
        underrunCount: 0,
      };
    }),
    getSnapshot: vi.fn(snapshot),
    destroy: vi.fn(async () => {
      phase = 'destroyed';
      if (destroyGated) await destroyGate.promise;
      if (destroyError !== null) throw destroyError;
    }),
  };

  return {
    source,
    primeGate,
    startedGate,
    destroyGate,
    gatePrime() {
      primeGated = true;
    },
    releasePrime() {
      primeGate.resolve();
    },
    gateStarted() {
      startedGated = true;
    },
    resolveStarted() {
      if (startedTargetFrame === null) throw new Error('source was not armed');
      startedGate.resolve(
        createStreamingPlaybackStartEvidence(startedTargetFrame, startedTargetFrame),
      );
    },
    rejectStarted(error = new Error('start evidence rejected')) {
      startedGate.reject(error);
    },
    markEnded() {
      phase = 'ended';
      positionSeconds = 180;
    },
    throwPosition() {
      positionThrows = true;
    },
    gateDestroy() {
      destroyGated = true;
    },
    releaseDestroy() {
      destroyGate.resolve();
    },
    rejectDestroy(error = new Error('destroy rejected')) {
      destroyError = error;
    },
  };
}

function scope(overrides: Partial<LegacyBoundedFileScope> = {}): LegacyBoundedFileScope {
  return {
    roomEpoch: 'room-epoch-7',
    bridgeGeneration: 'bridge-generation-3',
    bindingId: 'binding-1',
    queueItemId: Q1,
    sourceIdentity: 'source-1',
    descriptorId: 'descriptor-1',
    descriptorVersion: 2,
    ...overrides,
  };
}

function harness() {
  let roomTimeMs = 1_000;
  const context = new FakeAudioContext();
  const port = new LegacyBoundedFilePort({ nowRoomTimeMs: () => roomTimeMs });
  return {
    port,
    context,
    source(queueItemId = Q1, backend: FilePlaybackBackend = 'bounded-stream') {
      return makeSource(queueItemId, context, () => roomTimeMs, backend);
    },
    setRoomTime(value: number) {
      roomTimeMs = value;
    },
  };
}

async function prepareReady(
  h: ReturnType<typeof harness>,
  exactScope: LegacyBoundedFileScope,
  fake: FakeSource,
) {
  const preparation = h.port.prepare({
    scope: exactScope,
    open: async () => ({
      source: fake.source,
      destination: destinationFor(h.context),
    }),
  });
  expect(await preparation.ready).toMatchObject({ status: 'ready' });
  return preparation.lease;
}

async function startCurrent(
  h: ReturnType<typeof harness>,
  exactScope: LegacyBoundedFileScope,
  fake: FakeSource,
) {
  const lease = await prepareReady(h, exactScope, fake);
  expect(
    await h.port.commitPlay(lease, exactScope, {
      startAtRoomTimeMs: 1_200,
      positionSeconds: 12,
    }),
  ).toMatchObject({
    status: 'applied',
    snapshot: { phase: 'playing', run: { revision: 1 } },
  });
  return lease;
}

describe('LegacyBoundedFilePort', () => {
  it('constructs the production lease-scoped contract without exporting the concrete class', async () => {
    const port = createLegacyBoundedFilePort({ nowRoomTimeMs: () => 1_000 });

    expect(port).toMatchObject({
      prepare: expect.any(Function),
      schedulePlay: expect.any(Function),
      commitPlay: expect.any(Function),
      pause: expect.any(Function),
      seek: expect.any(Function),
      stop: expect.any(Function),
      snapshot: expect.any(Function),
      position: expect.any(Function),
      retire: expect.any(Function),
      clearRoom: expect.any(Function),
      clear: expect.any(Function),
    });
    await expect(port.clear()).resolves.toBeUndefined();
  });

  it('reports a scheduled play before exact native start evidence settles', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    fake.gateStarted();
    const lease = await prepareReady(h, exactScope, fake);

    const outcome = await h.port.schedulePlay(lease, exactScope, {
      startAtRoomTimeMs: 1_200,
      positionSeconds: 12,
    });
    expect(outcome).toMatchObject({
      status: 'scheduled',
      startAtRoomTimeMs: 1_200,
      snapshot: {
        queueItemId: exactScope.queueItemId,
        positionSeconds: 12,
      },
    });
    if (outcome.status !== 'scheduled') throw new Error('play was not scheduled');
    expect(h.port.snapshot(lease, exactScope)).toBeNull();
    let settled = false;
    void outcome.settled.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    fake.resolveStarted();
    await expect(outcome.settled).resolves.toMatchObject({
      status: 'applied',
      snapshot: { phase: 'playing', run: { revision: 1 } },
    });
    expect(h.port.snapshot(lease, exactScope)).toMatchObject({
      queueItemId: exactScope.queueItemId,
      phase: 'playing',
    });

    await h.port.clear();
  });

  it('rejects a zero post-prime lead before consuming the staged candidate', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    const lease = await prepareReady(h, exactScope, fake);

    await expect(
      h.port.schedulePlay(lease, exactScope, {
        startAtRoomTimeMs: 1_200,
        minimumLeadAfterPrimeMs: 0,
        positionSeconds: 12,
      }),
    ).resolves.toMatchObject({ status: 'failed', error: expect.any(TypeError) });
    expect(fake.source.primeForCutover).not.toHaveBeenCalled();
    await h.port.clear();
  });

  it('keeps commitPlay pending until exact native start evidence settles', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    fake.gateStarted();
    const lease = await prepareReady(h, exactScope, fake);

    let settled = false;
    const commit = h.port
      .commitPlay(lease, exactScope, {
        startAtRoomTimeMs: 1_200,
        positionSeconds: 12,
      })
      .then((outcome) => {
        settled = true;
        return outcome;
      });
    await vi.waitFor(() => expect(fake.source.finalize).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    fake.resolveStarted();
    await expect(commit).resolves.toMatchObject({ status: 'applied' });
    await h.port.clear();
  });

  it('settles a scheduled play as superseded when retired before native start', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    fake.gateStarted();
    fake.gateDestroy();
    const lease = await prepareReady(h, exactScope, fake);

    const outcome = await h.port.schedulePlay(lease, exactScope, {
      startAtRoomTimeMs: 1_200,
      positionSeconds: 12,
    });
    if (outcome.status !== 'scheduled') throw new Error('play was not scheduled');

    let retired = false;
    const retirement = h.port.retire(lease, exactScope).then(() => {
      retired = true;
    });
    await expect(outcome.settled).resolves.toEqual({ status: 'superseded' });
    expect(retired).toBe(false);
    expect(h.port.snapshot(lease, exactScope)).toBeNull();
    expect(fake.source.destroy).toHaveBeenCalledOnce();
    fake.releaseDestroy();
    await retirement;
    await expect(h.port.clear()).resolves.toBeUndefined();
  });

  it('joins an exact duplicate schedule and rejects a different pre-schedule request', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    fake.gatePrime();
    const lease = await prepareReady(h, exactScope, fake);

    const first = h.port.schedulePlay(lease, exactScope, {
      startAtRoomTimeMs: 1_200,
      positionSeconds: 12,
    });
    await vi.waitFor(() => expect(fake.source.primeForCutover).toHaveBeenCalledOnce());
    const duplicate = h.port.schedulePlay(lease, exactScope, {
      startAtRoomTimeMs: 1_200,
      positionSeconds: 12,
    });
    expect(duplicate).toBe(first);
    await expect(
      h.port.schedulePlay(lease, exactScope, {
        startAtRoomTimeMs: 1_200,
        positionSeconds: 13,
      }),
    ).resolves.toEqual({ status: 'rejected', reason: 'busy' });

    fake.releasePrime();
    const outcome = await first;
    if (outcome.status !== 'scheduled') throw new Error('play was not scheduled');
    await expect(outcome.settled).resolves.toMatchObject({ status: 'applied' });
    await h.port.clear();
  });

  it('uses a fieldless opaque lease and the real manager to stage, start, and observe a source', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    const lease = await prepareReady(h, exactScope, fake);
    expect(fake.source.primeForCutover).not.toHaveBeenCalled();
    expect(
      await h.port.commitPlay(lease, exactScope, {
        startAtRoomTimeMs: 1_200,
        positionSeconds: 12,
      }),
    ).toMatchObject({
      status: 'applied',
      snapshot: { phase: 'playing', run: { revision: 1 } },
    });

    expect(Object.isFrozen(lease)).toBe(true);
    expect(Reflect.ownKeys(lease)).toEqual([]);
    expect(h.port.snapshot(lease, exactScope)).toMatchObject({
      queueItemId: exactScope.queueItemId,
      phase: 'playing',
      revision: 1,
    });
    expect(h.port.position(lease, exactScope, 10)).toMatchObject({
      queueItemId: exactScope.queueItemId,
      positionSeconds: 12,
    });
    expect(fake.source.prepare).toHaveBeenCalledOnce();
    expect(fake.source.connect).toHaveBeenCalledOnce();
    expect(fake.source.primeForCutover).toHaveBeenCalledWith(12, expect.any(AbortSignal));

    await h.port.clear();
    expect(fake.source.destroy).toHaveBeenCalledOnce();
  });

  it('uses the fresh commit position rather than an earlier preparation position', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    const lease = await prepareReady(h, exactScope, fake);

    expect(fake.source.primeForCutover).not.toHaveBeenCalled();
    await h.port.commitPlay(lease, exactScope, {
      startAtRoomTimeMs: 1_200,
      positionSeconds: 37,
    });
    expect(fake.source.primeForCutover).toHaveBeenCalledWith(37, expect.any(AbortSignal));

    await h.port.clear();
  });

  it('joins an exact duplicate commit while rejecting a different in-flight commit as busy', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    fake.gatePrime();
    const lease = await prepareReady(h, exactScope, fake);

    const first = h.port.commitPlay(lease, exactScope, {
      startAtRoomTimeMs: 1_200,
      positionSeconds: 12,
    });
    await vi.waitFor(() => expect(fake.source.primeForCutover).toHaveBeenCalledOnce());

    const duplicate = h.port.commitPlay(lease, exactScope, {
      startAtRoomTimeMs: 1_200,
      positionSeconds: 12,
    });
    expect(duplicate).toBe(first);
    await expect(
      h.port.commitPlay(lease, exactScope, {
        startAtRoomTimeMs: 1_200,
        positionSeconds: 13,
      }),
    ).resolves.toEqual({ status: 'rejected', reason: 'busy' });

    fake.releasePrime();
    await expect(first).resolves.toMatchObject({ status: 'applied' });
    await h.port.clear();
  });

  it('retires a one-shot candidate whose start expires while prime is pending', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    fake.gatePrime();
    const lease = await prepareReady(h, exactScope, fake);

    const committing = h.port.commitPlay(lease, exactScope, {
      startAtRoomTimeMs: 1_200,
      positionSeconds: 12,
    });
    await vi.waitFor(() => expect(fake.source.primeForCutover).toHaveBeenCalledOnce());
    h.setRoomTime(1_300);
    fake.releasePrime();

    await expect(committing).resolves.toMatchObject({
      status: 'failed',
      error: expect.any(RangeError),
    });
    expect(fake.source.destroy).toHaveBeenCalledOnce();
    await expect(
      h.port.commitPlay(lease, exactScope, {
        startAtRoomTimeMs: 1_500,
        positionSeconds: 12,
      }),
    ).resolves.toEqual({ status: 'superseded' });
    await expect(
      h.port.commitPlay(lease, exactScope, {
        startAtRoomTimeMs: 1_500,
        positionSeconds: 13,
      }),
    ).resolves.toEqual({ status: 'superseded' });

    const replacement = h.source();
    const replacementLease = await prepareReady(h, exactScope, replacement);
    await expect(
      h.port.commitPlay(replacementLease, exactScope, {
        startAtRoomTimeMs: 1_500,
        positionSeconds: 13,
      }),
    ).resolves.toMatchObject({ status: 'applied' });
    await h.port.clear();
  });

  it('rebases a host start after slow prime while preserving the exact primed position', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    fake.gatePrime();
    const lease = await prepareReady(h, exactScope, fake);

    const scheduling = h.port.schedulePlay(lease, exactScope, {
      startAtRoomTimeMs: 1_200,
      minimumLeadAfterPrimeMs: 400,
      positionSeconds: 12,
    });
    await vi.waitFor(() => expect(fake.source.primeForCutover).toHaveBeenCalledOnce());
    h.setRoomTime(1_300);
    fake.releasePrime();

    const scheduled = await scheduling;
    expect(scheduled).toMatchObject({
      status: 'scheduled',
      startAtRoomTimeMs: 1_700,
      snapshot: { positionSeconds: 12 },
    });
    expect(fake.source.armForCutover).toHaveBeenCalledWith(
      expect.objectContaining({ positionSeconds: 12, startAtRoomTimeMs: 1_700 }),
    );
    expect(fake.source.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ startAtRoomTimeMs: 1_700 }),
    );
    if (scheduled.status !== 'scheduled') throw new Error('play was not scheduled');
    await expect(scheduled.settled).resolves.toMatchObject({ status: 'applied' });
    await h.port.clear();
  });

  it('makes forged leases and exact-scope mismatches inert', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    const lease = await prepareReady(h, exactScope, fake);
    const forged = Object.freeze(Object.create(null)) as LegacyBoundedFileLease;

    expect(
      await h.port.commitPlay(forged, exactScope, {
        startAtRoomTimeMs: 1_200,
        positionSeconds: 12,
      }),
    ).toEqual({ status: 'superseded' });
    expect(
      await h.port.commitPlay(lease, scope({ descriptorVersion: 3 }), {
        startAtRoomTimeMs: 1_200,
        positionSeconds: 12,
      }),
    ).toEqual({ status: 'superseded' });
    expect(fake.source.armForCutover).not.toHaveBeenCalled();
    expect(h.port.snapshot(forged, exactScope)).toBeNull();
    await expect(h.port.retire(forged, exactScope)).resolves.toBeUndefined();

    await h.port.clear();
  });

  it('aborts a superseded opener and destroys a source that fulfills late exactly once', async () => {
    const h = harness();
    const firstScope = scope();
    const late = deferred<{
      readonly source: FilePlaybackCutoverSource;
      readonly destination: AudioNode;
    }>();
    const first = h.source();
    const firstSignal: { value: AbortSignal | null } = { value: null };
    const firstPreparation = h.port.prepare({
      scope: firstScope,
      open: (signal) => {
        firstSignal.value = signal;
        return late.promise;
      },
    });

    const secondScope = scope({
      bindingId: 'binding-2',
      queueItemId: Q2,
      sourceIdentity: 'source-2',
      descriptorId: 'descriptor-2',
    });
    const second = h.source(Q2);
    await prepareReady(h, secondScope, second);
    expect(firstSignal.value?.aborted).toBe(true);

    late.resolve({ source: first.source, destination: destinationFor(h.context) });
    await expect(firstPreparation.ready).resolves.toEqual({ status: 'superseded' });
    expect(first.source.destroy).toHaveBeenCalledOnce();
    expect(first.source.prepare).not.toHaveBeenCalled();

    await h.port.clear();
  });

  it('invalidates synchronously and joins manager-owned native destruction on retire', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    fake.gateDestroy();
    const lease = await prepareReady(h, exactScope, fake);

    let retired = false;
    const retirement = h.port.retire(lease, exactScope).then(() => {
      retired = true;
    });
    expect(h.port.snapshot(lease, exactScope)).toBeNull();
    expect(
      await h.port.commitPlay(lease, exactScope, {
        startAtRoomTimeMs: 1_200,
        positionSeconds: 12,
      }),
    ).toEqual({ status: 'superseded' });
    await Promise.resolve();
    expect(fake.source.destroy).toHaveBeenCalledOnce();
    expect(retired).toBe(false);

    fake.releaseDestroy();
    await retirement;
    expect(retired).toBe(true);
  });

  it('forgets a retired record even when native destruction rejects', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    fake.rejectDestroy();
    const lease = await prepareReady(h, exactScope, fake);

    await expect(h.port.retire(lease, exactScope)).rejects.toThrow('destroy rejected');
    expect(h.port.snapshot(lease, exactScope)).toBeNull();
    await expect(h.port.retire(lease, exactScope)).resolves.toBeUndefined();
    await expect(h.port.clear()).resolves.toBeUndefined();
    expect(fake.source.destroy).toHaveBeenCalledOnce();
  });

  it('clears every renderer best-effort and aggregates native cleanup failures', async () => {
    const h = harness();
    const firstScope = scope();
    const first = h.source();
    first.rejectDestroy(new Error('first destroy rejected'));
    const firstLease = await startCurrent(h, firstScope, first);
    const secondScope = scope({
      bindingId: 'binding-2',
      queueItemId: Q2,
      sourceIdentity: 'source-2',
      descriptorId: 'descriptor-2',
    });
    const second = h.source(Q2);
    const secondLease = await prepareReady(h, secondScope, second);

    await expect(h.port.clear()).rejects.toBeInstanceOf(AggregateError);
    expect(first.source.destroy).toHaveBeenCalledOnce();
    expect(second.source.destroy).toHaveBeenCalledOnce();
    expect(h.port.snapshot(firstLease, firstScope)).toBeNull();
    expect(h.port.snapshot(secondLease, secondScope)).toBeNull();
  });

  it('owns consecutive native revisions privately across pause and seek', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    const lease = await startCurrent(h, exactScope, fake);

    expect(await h.port.pause(lease, exactScope, { atRoomTimeMs: 1_050 })).toMatchObject({
      status: 'applied',
      snapshot: { phase: 'paused', run: { revision: 2 } },
    });
    expect(
      await h.port.seek(lease, exactScope, {
        atRoomTimeMs: 1_060,
        positionSeconds: 42,
      }),
    ).toMatchObject({
      status: 'applied',
      snapshot: { phase: 'paused', positionSeconds: 42, run: { revision: 3 } },
    });

    const pauseIntent = vi.mocked(fake.source.pauseRevisioned).mock.calls[0]?.[0];
    const seekIntent = vi.mocked(fake.source.seekRevisioned).mock.calls[0]?.[0];
    expect(pauseIntent).toMatchObject({
      from: { revision: 1 },
      to: { revision: 2 },
    });
    expect(seekIntent).toMatchObject({
      from: { revision: 2 },
      to: { revision: 3 },
    });

    await h.port.clear();
  });

  it('retries only a non-mutating expired pause target once with a fresh lead', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    const lease = await startCurrent(h, exactScope, fake);
    vi.mocked(fake.source.pauseRevisioned).mockImplementationOnce(async (intent) =>
      createFilePlaybackRejectedTransitionResult(
        intent,
        'target-not-in-future',
        fake.source.getSnapshot(),
      ),
    );

    await expect(h.port.pause(lease, exactScope, { atRoomTimeMs: 1_050 })).resolves.toMatchObject({
      status: 'applied',
      snapshot: { phase: 'paused', run: { revision: 2 } },
    });
    expect(fake.source.pauseRevisioned).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fake.source.pauseRevisioned).mock.calls[0]?.[0]).toMatchObject({
      to: { revision: 2 },
      atRoomTimeMs: 1_050,
    });
    expect(vi.mocked(fake.source.pauseRevisioned).mock.calls[1]?.[0]).toMatchObject({
      to: { revision: 2 },
      atRoomTimeMs: 1_100,
    });
    await h.port.clear();
  });

  it('retries only a non-mutating expired seek target once with the same revision and position', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    const lease = await startCurrent(h, exactScope, fake);
    vi.mocked(fake.source.seekRevisioned).mockImplementationOnce(async (intent) =>
      createFilePlaybackRejectedTransitionResult(
        intent,
        'target-not-in-future',
        fake.source.getSnapshot(),
      ),
    );

    await expect(
      h.port.seek(lease, exactScope, {
        atRoomTimeMs: 1_050,
        positionSeconds: 42,
      }),
    ).resolves.toMatchObject({
      status: 'applied',
      snapshot: { phase: 'paused', positionSeconds: 42, run: { revision: 2 } },
    });
    expect(fake.source.seekRevisioned).toHaveBeenCalledTimes(2);
    for (const [intent] of vi.mocked(fake.source.seekRevisioned).mock.calls) {
      expect(intent).toMatchObject({
        to: { revision: 2 },
        positionSeconds: 42,
      });
    }
    expect(vi.mocked(fake.source.seekRevisioned).mock.calls[0]?.[0]).toMatchObject({
      atRoomTimeMs: 1_050,
    });
    expect(vi.mocked(fake.source.seekRevisioned).mock.calls[1]?.[0]).toMatchObject({
      atRoomTimeMs: 1_100,
    });
    await h.port.clear();
  });

  it('does not retry a pause rejection unrelated to an expired target', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    const lease = await startCurrent(h, exactScope, fake);
    vi.mocked(fake.source.pauseRevisioned).mockImplementationOnce(async (intent) =>
      createFilePlaybackRejectedTransitionResult(intent, 'wrong-phase', fake.source.getSnapshot()),
    );

    await expect(h.port.pause(lease, exactScope, { atRoomTimeMs: 1_050 })).resolves.toEqual({
      status: 'rejected',
      reason: 'wrong-phase',
    });
    expect(fake.source.pauseRevisioned).toHaveBeenCalledOnce();
    expect(h.port.snapshot(lease, exactScope)).toMatchObject({ phase: 'playing', revision: 1 });
    await h.port.clear();
  });

  it('stops only the exact current lease and joins its manager cleanup', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    const lease = await startCurrent(h, exactScope, fake);

    const stopping = h.port.stop(lease, exactScope, { atRoomTimeMs: 1_050 });
    h.context.currentTime = 0.06;
    await expect(stopping).resolves.toEqual({ status: 'applied', snapshot: null });
    expect(h.port.snapshot(lease, exactScope)).toBeNull();
    expect(fake.source.destroy).toHaveBeenCalledOnce();
    await expect(h.port.clear()).resolves.toBeUndefined();
    expect(fake.source.destroy).toHaveBeenCalledOnce();
  });

  it('retires an exact naturally ended renderer without scheduling an impossible stop', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    const lease = await startCurrent(h, exactScope, fake);
    fake.markEnded();

    await expect(h.port.stop(lease, exactScope, { atRoomTimeMs: 1_250 })).resolves.toEqual({
      status: 'applied',
      snapshot: null,
    });

    expect(fake.source.destroy).toHaveBeenCalledOnce();
    expect(h.port.snapshot(lease, exactScope)).toBeNull();
    await expect(h.port.clear()).resolves.toBeUndefined();
    expect(fake.source.destroy).toHaveBeenCalledOnce();
  });

  it('invalidates a current lease synchronously when native position observation throws', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    const lease = await startCurrent(h, exactScope, fake);
    fake.throwPosition();

    expect(h.port.position(lease, exactScope, 10)).toBeNull();
    expect(h.port.snapshot(lease, exactScope)).toBeNull();
    await vi.waitFor(() => expect(fake.source.destroy).toHaveBeenCalledOnce());
    await expect(h.port.clear()).resolves.toBeUndefined();
    expect(fake.source.destroy).toHaveBeenCalledOnce();
  });

  it('invalidates the old current when replacement start evidence fails after its target', async () => {
    const h = harness();
    const firstScope = scope();
    const first = h.source();
    const firstLease = await startCurrent(h, firstScope, first);
    const replacementScope = scope({
      bindingId: 'binding-2',
      queueItemId: Q2,
      sourceIdentity: 'source-2',
      descriptorId: 'descriptor-2',
    });
    const replacement = h.source(Q2);
    replacement.gateStarted();
    const replacementLease = await prepareReady(h, replacementScope, replacement);

    const committing = h.port.commitPlay(replacementLease, replacementScope, {
      startAtRoomTimeMs: 1_400,
      positionSeconds: 24,
    });
    await vi.waitFor(() => expect(replacement.source.finalize).toHaveBeenCalledOnce());
    h.context.currentTime = 0.2;
    replacement.rejectStarted();

    await expect(committing).resolves.toMatchObject({
      status: 'failed',
      error: expect.any(Error),
    });
    expect(h.port.snapshot(firstLease, firstScope)).toBeNull();
    expect(h.port.snapshot(replacementLease, replacementScope)).toBeNull();
    await vi.waitFor(() => {
      expect(first.source.destroy).toHaveBeenCalledOnce();
      expect(replacement.source.destroy).toHaveBeenCalledOnce();
    });
    await h.port.clear();
  });

  it('returns fallback without staging when the opener reports an unsupported source', async () => {
    const h = harness();
    const exactScope = scope();
    const preparation = h.port.prepare({
      scope: exactScope,
      open: async () => null,
    });

    await expect(preparation.ready).resolves.toEqual({
      status: 'fallback',
      reason: 'unsupported-source',
    });
    expect(
      await h.port.commitPlay(preparation.lease, exactScope, {
        startAtRoomTimeMs: 1_200,
        positionSeconds: 0,
      }),
    ).toEqual({ status: 'superseded' });
    await h.port.clear();
  });

  it('destroys non-bounded and malformed discovered sources before falling back or failing', async () => {
    const h = harness();
    const audioBuffer = h.source(Q1, 'audio-buffer');
    const fallback = h.port.prepare({
      scope: scope(),
      open: async () => ({
        source: audioBuffer.source,
        destination: destinationFor(h.context),
      }),
    });
    await expect(fallback.ready).resolves.toEqual({
      status: 'fallback',
      reason: 'unsupported-source',
    });
    expect(audioBuffer.source.destroy).toHaveBeenCalledOnce();
    expect(audioBuffer.source.prepare).not.toHaveBeenCalled();

    const malformedScope = scope({
      bindingId: 'binding-malformed',
      descriptorId: 'descriptor-malformed',
    });
    const malformedSource = h.source();
    const malformed = h.port.prepare({
      scope: malformedScope,
      open: async () =>
        ({
          source: malformedSource.source,
          destination: destinationFor(h.context),
          extra: true,
        }) as never,
    });
    await expect(malformed.ready).resolves.toMatchObject({
      status: 'failed',
      error: expect.any(TypeError),
    });
    expect(malformedSource.source.destroy).toHaveBeenCalledOnce();
    expect(malformedSource.source.prepare).not.toHaveBeenCalled();

    const incompleteDestroy = vi.fn(async () => undefined);
    const incomplete = h.port.prepare({
      scope: scope({
        bindingId: 'binding-incomplete',
        descriptorId: 'descriptor-incomplete',
      }),
      open: async () => ({
        source: {
          queueItemId: Q1,
          backend: 'bounded-stream',
          destroy: incompleteDestroy,
        } as never,
        destination: destinationFor(h.context),
      }),
    });
    await expect(incomplete.ready).resolves.toMatchObject({
      status: 'failed',
      error: expect.any(TypeError),
    });
    expect(incompleteDestroy).toHaveBeenCalledOnce();

    await h.port.clear();
  });

  it('retires manager ownership if the post-stage ready snapshot becomes unavailable', async () => {
    const h = harness();
    const fake = h.source();
    const initialSnapshot = fake.source.getSnapshot();
    let reads = 0;
    vi.mocked(fake.source.getSnapshot).mockImplementation(() => {
      reads += 1;
      if (reads >= 4) throw new Error('snapshot unavailable');
      return initialSnapshot;
    });
    const preparation = h.port.prepare({
      scope: scope(),
      open: async () => ({
        source: fake.source,
        destination: destinationFor(h.context),
      }),
    });

    await expect(preparation.ready).resolves.toMatchObject({
      status: 'failed',
      error: expect.any(Error),
    });
    expect(fake.source.destroy).toHaveBeenCalledOnce();
    await h.port.clear();
  });

  it('retires an abort-ignoring opener logically without waiting and cleans a late source', async () => {
    const h = harness();
    const exactScope = scope();
    const late = deferred<{
      readonly source: FilePlaybackCutoverSource;
      readonly destination: AudioNode;
    }>();
    const fake = h.source();
    const signal: { value: AbortSignal | null } = { value: null };
    const preparation = h.port.prepare({
      scope: exactScope,
      open: (nextSignal) => {
        signal.value = nextSignal;
        return late.promise;
      },
    });

    await expect(h.port.retire(preparation.lease, exactScope)).resolves.toBeUndefined();
    expect(signal.value?.aborted).toBe(true);
    expect(fake.source.destroy).not.toHaveBeenCalled();

    late.resolve({ source: fake.source, destination: destinationFor(h.context) });
    await expect(preparation.ready).resolves.toEqual({ status: 'superseded' });
    expect(fake.source.destroy).toHaveBeenCalledOnce();
  });

  it('clears every exact renderer in the same room epoch and bridge generation', async () => {
    const h = harness();
    const firstScope = scope();
    const first = h.source();
    await startCurrent(h, firstScope, first);
    const secondScope = scope({
      bindingId: 'binding-2',
      queueItemId: Q2,
      sourceIdentity: 'source-2',
      descriptorId: 'descriptor-2',
    });
    const second = h.source(Q2);
    await prepareReady(h, secondScope, second);

    await h.port.clearRoom(firstScope);
    expect(first.source.destroy).toHaveBeenCalledOnce();
    expect(second.source.destroy).toHaveBeenCalledOnce();
  });

  it('rejects a late start without consuming the staged candidate', async () => {
    const h = harness();
    const exactScope = scope();
    const fake = h.source();
    const lease = await prepareReady(h, exactScope, fake);
    h.setRoomTime(1_300);

    expect(
      await h.port.commitPlay(lease, exactScope, {
        startAtRoomTimeMs: 1_200,
        positionSeconds: 12,
      }),
    ).toMatchObject({ status: 'failed', error: expect.any(RangeError) });
    expect(fake.source.armForCutover).not.toHaveBeenCalled();

    h.setRoomTime(1_000);
    expect(
      await h.port.commitPlay(lease, exactScope, {
        startAtRoomTimeMs: 1_200,
        positionSeconds: 29,
      }),
    ).toMatchObject({ status: 'applied' });
    expect(fake.source.primeForCutover).toHaveBeenCalledWith(29, expect.any(AbortSignal));

    await h.port.retire(lease, exactScope);
  });
});
