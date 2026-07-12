import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  createAudioBufferPlaybackStartEvidence,
  createFilePlaybackCutoverTarget,
  createStreamingFlacPlaybackStartEvidence,
  type FilePlaybackBackend,
  type FilePlaybackCutoverArmResult,
  type FilePlaybackCutoverSource,
  type FilePlaybackSourcePhase,
  type FilePlaybackSourceSnapshot,
  type FilePlaybackStartEvidence,
} from '../file-playback-source.ts';
import {
  FilePlaybackManager,
  type FilePlaybackCutoverCandidatePort,
} from '../file-playback-manager.ts';
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
  readonly armGate: ReturnType<typeof deferred<FilePlaybackCutoverArmResult>>;
  readonly destroyGate: ReturnType<typeof deferred<void>>;
  readonly connectedTo: AudioNode[];
  phase(value: FilePlaybackSourcePhase): void;
  gatePrepare(): void;
  gateArm(): void;
  gateDestroy(): void;
  rejectFinalize(): void;
  resolveStarted(): void;
}

function makeSource(
  queueItemId: QueueItemId,
  context: FakeAudioContext,
  targetTime: number,
  backend: FilePlaybackBackend = 'streaming-flac',
): FakeCutoverSource {
  let phase: FilePlaybackSourcePhase = 'new';
  let prepareGated = false;
  let armGated = false;
  let destroyGated = false;
  let finalizeRejected = false;
  let armWasCalled = false;
  const started = deferred<FilePlaybackStartEvidence>();
  void started.promise.catch(() => undefined);
  const prepareGate = deferred<FilePlaybackSourceSnapshot>();
  const armGate = deferred<FilePlaybackCutoverArmResult>();
  const destroyGate = deferred<void>();
  const connectedTo: AudioNode[] = [];
  const snapshot = (): FilePlaybackSourceSnapshot => ({
    schemaVersion: 1,
    queueItemId,
    backend,
    phase,
    revision: 0,
    run: null,
    durationSeconds: 60,
    positionSeconds: 0,
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
    arm: vi.fn(async (intent) => createArmResult(intent).receipt),
    armForCutover: vi.fn(async (intent) => {
      armWasCalled = true;
      if (armGated) return armGate.promise;
      phase = 'armed';
      return createArmResult(intent);
    }),
    finalize: vi.fn(async (intent) => {
      if (finalizeRejected) return finalizedReceipt(intent, 'rejected');
      return finalizedReceipt(intent);
    }),
    cancel: vi.fn(async () => snapshot()),
    pause: vi.fn(async () => snapshot()),
    seek: vi.fn(async () => snapshot()),
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
    armGate,
    destroyGate,
    connectedTo,
    phase(value) {
      phase = value;
    },
    gatePrepare() {
      prepareGated = true;
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
      phase = 'connected';
      const frame = Math.round(targetTime * context.sampleRate);
      started.resolve(
        backend === 'audio-buffer'
          ? createAudioBufferPlaybackStartEvidence(frame)
          : createStreamingFlacPlaybackStartEvidence(frame, frame),
      );
    },
  };
}

async function stageArmFinalize(
  manager: FilePlaybackManager,
  fake: FakeCutoverSource,
  destination: AudioNode,
) {
  const port = await manager.stageCutoverCandidate({ source: fake.source, destination });
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
) {
  const result = await stageArmFinalize(manager, fake, destination);
  context.currentTime = result.finalization.target.contextTimeSeconds;
  fake.resolveStarted();
  await result.finalization.started;
  return result;
}

describe('FilePlaybackManager V2 atomic cutover', () => {
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
    source.started.resolve(createStreamingFlacPlaybackStartEvidence(48_000, 48_000));

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
    const candidate = makeSource(Q1, context, 1);
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
});
