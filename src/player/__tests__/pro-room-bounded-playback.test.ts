import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bus } from '../../core/events.ts';
import { setState } from '../../core/state.ts';
import { ProRoomMediaRangeCompatibilityError } from '../../pro-room/media-transfer.ts';
import {
  createProPlaybackAuthorityToken,
  type ProPlaybackAuthorityToken,
  type ProPlaybackCommitRequest,
  type ProPlaybackPrepareRequest,
} from '../../pro-room/playback-authority-hooks.ts';
import type { QueueItemId } from '../../types/index.ts';
import { FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY } from '../file-playback-bounded-route-policy.ts';
import {
  createFilePlaybackCutoverTarget,
  createFilePlaybackScheduledTransitionResult,
  createFilePlaybackTransitionEvidence,
  createStreamingPlaybackStartEvidence,
  type FilePlaybackCutoverArmResult,
  type FilePlaybackCutoverSource,
  type FilePlaybackSourcePhase,
  type FilePlaybackSourceSnapshot,
  type FilePlaybackTransitionIntent,
  type FilePlaybackTransitionResult,
} from '../file-playback-source.ts';
import {
  UnsupportedOrdinaryEncodedSourceError,
  type BlobFilePlaybackSourceResult,
} from '../file-playback-source-factory.ts';
import {
  ProRoomBoundedPlaybackAdapter,
  type ProRoomBoundedPlaybackDependencies,
} from '../pro-room-bounded-playback.ts';
import {
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
} from '../sources/encoded-audio-source.ts';
import type {
  RendezvousArmIntent,
  RendezvousArmReceipt,
  RendezvousFinalizeIntent,
  RendezvousFinalizeReceipt,
  RevisionedPlaybackRun,
} from '../rendezvous-contract.ts';

const ROOM_CODE = '000001';
const ROOM_EPOCH = 7;
const Q1 = '10000000-0000-4000-8000-000000000001' as QueueItemId;

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
  currentTime = 1;
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

function armReceipt(intent: RendezvousArmIntent): RendezvousArmReceipt {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-armed',
    queueItemId: intent.queueItemId,
    runId: intent.runId,
    revision: intent.revision,
    rendezvousId: intent.rendezvousId,
    participantId: intent.recipientId,
    status: 'armed',
    observedAtRoomTimeMs: intent.finalizeByRoomTimeMs - 1,
    bufferedAheadSeconds: 8,
    reasonCode: null,
  };
}

function finalizeReceipt(intent: RendezvousFinalizeIntent): RendezvousFinalizeReceipt {
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

function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

interface FakeCutoverSource {
  readonly source: FilePlaybackCutoverSource;
  readonly encodedSource: EncodedAudioSource;
  readonly primeGate: ReturnType<typeof deferred<void>>;
  gatePrime(): void;
  setPhase(phase: FilePlaybackSourcePhase): void;
  fail(errorCode: string): void;
}

function makeCutoverSource(
  queueItemId: QueueItemId,
  context: FakeAudioContext,
  encodedSource: EncodedAudioSource,
): FakeCutoverSource {
  let phase: FilePlaybackSourcePhase = 'new';
  let revision = 0;
  let run: RevisionedPlaybackRun | null = null;
  let positionSeconds = 0;
  let errorCode: string | null = null;
  let primeGated = false;
  const primeGate = deferred<void>();

  const snapshot = (): FilePlaybackSourceSnapshot => ({
    schemaVersion: 1,
    queueItemId,
    backend: 'bounded-stream',
    phase,
    revision,
    run,
    durationSeconds: 180,
    positionSeconds,
    bufferedAheadSeconds: phase === 'new' || phase === 'preparing' ? 0 : 8,
    outputSampleRateHz: context.sampleRate,
    channelCount: 2,
    underrunCount: 0,
    errorCode,
  });

  const transition = async (
    intent: FilePlaybackTransitionIntent,
  ): Promise<FilePlaybackTransitionResult> => {
    const before = snapshot();
    const targetTime = context.currentTime + 0.03;
    const targetFrame = Math.round(targetTime * context.sampleRate);
    phase = 'paused';
    revision = intent.to.revision;
    run = Object.freeze({ ...intent.to });
    if (intent.kind === 'file-playback-seek-transition') {
      positionSeconds = intent.positionSeconds;
    }
    return createFilePlaybackScheduledTransitionResult(
      intent,
      createFilePlaybackCutoverTarget(context as unknown as AudioContext, targetTime, targetFrame),
      before,
      Promise.resolve(
        createFilePlaybackTransitionEvidence(intent, 'worklet-observed', targetFrame, targetFrame),
      ),
    );
  };

  const source: FilePlaybackCutoverSource = {
    queueItemId,
    backend: 'bounded-stream',
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
      if (primeGated) await Promise.race([primeGate.promise, abortPromise(signal)]);
      signal.throwIfAborted();
      positionSeconds = nextPositionSeconds;
      return snapshot();
    }),
    arm: vi.fn(async (intent) => armReceipt(intent)),
    armForCutover: vi.fn(async (intent): Promise<FilePlaybackCutoverArmResult> => {
      phase = 'armed';
      revision = intent.revision;
      run = Object.freeze({
        queueItemId: intent.queueItemId,
        runId: intent.runId,
        revision: intent.revision,
      });
      const targetTime = context.currentTime + 0.25;
      const targetFrame = Math.round(targetTime * context.sampleRate);
      return {
        status: 'armed',
        receipt: armReceipt(intent),
        target: createFilePlaybackCutoverTarget(
          context as unknown as AudioContext,
          targetTime,
          targetFrame,
        ),
        started: Promise.resolve(createStreamingPlaybackStartEvidence(targetFrame, targetFrame)),
      };
    }),
    finalize: vi.fn(async (intent) => {
      phase = 'playing';
      return finalizeReceipt(intent);
    }),
    cancel: vi.fn(async () => snapshot()),
    pause: vi.fn(async () => snapshot()),
    seek: vi.fn(async () => snapshot()),
    pauseRevisioned: vi.fn(transition),
    seekRevisioned: vi.fn(transition),
    positionAt: vi.fn(() => ({
      queueItemId,
      run,
      phase,
      positionSeconds,
      bufferedAheadSeconds: 8,
      underrunCount: 0,
    })),
    getSnapshot: vi.fn(snapshot),
    destroy: vi.fn(async () => {
      phase = 'destroyed';
      await encodedSource.close();
    }),
  };

  return {
    source,
    encodedSource,
    primeGate,
    gatePrime() {
      primeGated = true;
    },
    setPhase(nextPhase) {
      phase = nextPhase;
    },
    fail(nextErrorCode) {
      phase = 'failed';
      errorCode = nextErrorCode;
    },
  };
}

function encodedSource(identity: string): EncodedAudioSource {
  return {
    kind: 'r2-records',
    identity,
    size: 1024,
    metadata: { name: `${identity}.flac`, mime: 'audio/flac' },
    readAt: vi.fn(async (_offset, length, signal) => {
      signal.throwIfAborted();
      return new Uint8Array(length);
    }),
    close: vi.fn(async () => undefined),
  };
}

interface AdapterHarness {
  readonly adapter: ProRoomBoundedPlaybackAdapter;
  readonly context: FakeAudioContext;
  readonly resolveRangeSource: ReturnType<
    typeof vi.fn<
      (queueItemId: QueueItemId, signal: AbortSignal) => Promise<EncodedAudioSource | null> | null
    >
  >;
  readonly createSource: ReturnType<
    typeof vi.fn<ProRoomBoundedPlaybackDependencies['createSource']>
  >;
  readonly routeEnded: ReturnType<typeof vi.fn>;
  readonly restoreLegacy: ReturnType<typeof vi.fn>;
  readonly getBuildProfile: ReturnType<typeof vi.fn>;
  readonly nowRoomTimeMs: ReturnType<typeof vi.fn>;
  readonly created: FakeCutoverSource[];
  gateNextPrime(): void;
  advanceRoomTime(ms: number): void;
}

const adapters: ProRoomBoundedPlaybackAdapter[] = [];

function harness(): AdapterHarness {
  const context = new FakeAudioContext();
  const destination = destinationFor(context);
  let sourceSequence = 0;
  let gateNextPrime = false;
  let roomTimeMs = 10_000;
  const resolveRangeSource = vi.fn(
    async (_queueItemId: QueueItemId, signal: AbortSignal): Promise<EncodedAudioSource> => {
      signal.throwIfAborted();
      sourceSequence += 1;
      return encodedSource(`asset-${sourceSequence}`);
    },
  );
  const created: FakeCutoverSource[] = [];
  const createSource = vi.fn<ProRoomBoundedPlaybackDependencies['createSource']>(
    async (options) => {
      const fake = makeCutoverSource(options.queueItemId, context, options.encodedSource);
      if (gateNextPrime) {
        gateNextPrime = false;
        fake.gatePrime();
      }
      created.push(fake);
      return {
        backend: 'bounded-stream',
        source: fake.source,
        sourceIdentity: options.encodedSource.identity,
        releaseConstructionLease: () => undefined,
      } as unknown as BlobFilePlaybackSourceResult;
    },
  );
  const routeEnded = vi.fn(() => true);
  const restoreLegacy = vi.fn(async () => true);
  const nowRoomTimeMs = vi.fn(() => roomTimeMs);
  const getBuildProfile = vi.fn<ProRoomBoundedPlaybackDependencies['getBuildProfile']>(() => ({
    id: 'v2-universal-v1',
    engine: 'v2',
    boundedRouteMode: 'universal-v1',
    boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
    semanticPlaybackCohortId: 'test-v2-universal-v1',
  }));
  const adapter = new ProRoomBoundedPlaybackAdapter({
    resolveRangeSource,
    createSource,
    getAudioRuntime: async () => ({
      audioContext: context as unknown as AudioContext,
      destination,
    }),
    nowRoomTimeMs,
    routeEnded,
    restoreLegacy,
    getBuildProfile,
  });
  adapters.push(adapter);
  return {
    adapter,
    context,
    resolveRangeSource,
    createSource,
    routeEnded,
    restoreLegacy,
    getBuildProfile,
    nowRoomTimeMs,
    created,
    gateNextPrime() {
      gateNextPrime = true;
    },
    advanceRoomTime(ms) {
      roomTimeMs += ms;
      context.currentTime += ms / 1_000;
    },
  };
}

function authority(
  basePlaybackRevision: number,
  transitionId: string | null = `transition-${basePlaybackRevision}`,
  roomId = ROOM_CODE,
  roomEpoch = ROOM_EPOCH,
): ProPlaybackAuthorityToken {
  return createProPlaybackAuthorityToken({
    roomId,
    roomEpoch,
    basePlaybackRevision,
    transitionId,
  });
}

function prepareRequest(
  token: ProPlaybackAuthorityToken,
  overrides: Partial<ProPlaybackPrepareRequest> = {},
): ProPlaybackPrepareRequest {
  return {
    authority: token,
    queueItemId: Q1,
    positionSeconds: 12,
    state: 'playing',
    prepareBudgetMs: 1_000,
    isCurrent: () => true,
    ...overrides,
  };
}

function commitRequest(
  token: ProPlaybackAuthorityToken,
  committedPlaybackRevision: number,
  overrides: Partial<ProPlaybackCommitRequest> = {},
): ProPlaybackCommitRequest {
  return {
    authority: token,
    committedPlaybackRevision,
    queueItemId: Q1,
    state: 'playing',
    positionSeconds: 12,
    scheduleDelayMs: 30,
    timingMode: 'scheduled-control',
    isCurrent: () => true,
    ...overrides,
  };
}

async function prepareAndCommit(
  adapterHarness: AdapterHarness,
  token: ProPlaybackAuthorityToken,
  committedPlaybackRevision: number,
  positionSeconds = 12,
) {
  await expect(
    adapterHarness.adapter.prepare(
      prepareRequest(token, {
        positionSeconds,
      }),
    ),
  ).resolves.toEqual({ status: 'ready', durationSeconds: 180 });
  return adapterHarness.adapter.commit(
    commitRequest(token, committedPlaybackRevision, {
      positionSeconds,
    }),
  );
}

beforeEach(() => {
  setState('room.context', {
    kind: 'pro',
    roomId: ROOM_CODE,
    role: 'member',
    coordinatorId: null,
    epoch: ROOM_EPOCH,
    snapshotRevision: 1,
    capabilities: ['playback.control'],
  });
});

afterEach(async () => {
  await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.clear()));
  vi.useRealTimers();
  setState('room.context', {
    kind: 'standard',
    roomId: null,
    role: 'idle',
    coordinatorId: null,
    epoch: 0,
    snapshotRevision: 0,
    capabilities: [],
  });
});

describe('PRO bounded playback adapter', () => {
  it('silently stages and primes on PREPARE, then publishes only a matching COMMIT', async () => {
    const h = harness();
    const token = authority(0);

    await expect(h.adapter.prepare(prepareRequest(token))).resolves.toEqual({
      status: 'ready',
      durationSeconds: 180,
    });

    const fake = h.created[0];
    expect(fake).toBeDefined();
    expect(fake!.source.prepare).toHaveBeenCalledOnce();
    expect(fake!.source.connect).toHaveBeenCalledOnce();
    expect(fake!.source.primeForCutover).toHaveBeenCalledWith(12, expect.any(AbortSignal));
    expect(fake!.source.armForCutover).not.toHaveBeenCalled();
    expect(fake!.source.finalize).not.toHaveBeenCalled();
    expect(h.adapter.hasCurrent()).toBe(false);
    expect(h.adapter.currentSnapshot()).toBeNull();
    expect(h.restoreLegacy).not.toHaveBeenCalled();

    await expect(
      h.adapter.commit(commitRequest(authority(0, 'other-transition'), 1)),
    ).resolves.toBeNull();
    expect(h.adapter.hasCurrent()).toBe(false);

    await expect(h.adapter.commit(commitRequest(token, 1))).resolves.toMatchObject({
      status: 'applied',
      phase: 'playing',
      durationSeconds: 180,
      positionSeconds: 12,
    });
    expect(fake!.source.armForCutover).toHaveBeenCalledOnce();
    expect(fake!.source.finalize).toHaveBeenCalledOnce();
    expect(h.adapter.hasCurrent(Q1)).toBe(true);
    expect(h.adapter.currentSnapshot()).toMatchObject({
      queueItemId: Q1,
      phase: 'playing',
      revision: 1,
    });
  });

  it('shares one in-flight same-authority PREPARE without reporting READY before prime evidence', async () => {
    const h = harness();
    const token = authority(0, 'duplicate-prepare');
    h.gateNextPrime();

    let firstSettled = false;
    let duplicateSettled = false;
    const first = h.adapter.prepare(prepareRequest(token)).finally(() => {
      firstSettled = true;
    });
    await vi.waitFor(() => {
      expect(h.created).toHaveLength(1);
      expect(h.created[0]!.source.primeForCutover).toHaveBeenCalledOnce();
    });
    const duplicate = h.adapter.prepare(prepareRequest(token)).finally(() => {
      duplicateSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(firstSettled).toBe(false);
    expect(duplicateSettled).toBe(false);
    expect(h.resolveRangeSource).toHaveBeenCalledOnce();
    expect(h.createSource).toHaveBeenCalledOnce();

    h.created[0]!.primeGate.resolve();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { status: 'ready', durationSeconds: 180 },
      { status: 'ready', durationSeconds: 180 },
    ]);
  });

  it('keeps pause, resume, and playing seek on bounded candidates without legacy restore', async () => {
    const h = harness();
    const initial = authority(0);
    await expect(prepareAndCommit(h, initial, 1, 8)).resolves.toMatchObject({
      status: 'applied',
      phase: 'playing',
    });

    const pause = authority(1, null);
    await expect(
      h.adapter.commit(
        commitRequest(pause, 2, {
          state: 'paused',
          positionSeconds: 8,
        }),
      ),
    ).resolves.toMatchObject({ status: 'applied', phase: 'paused' });
    expect(h.created[0]!.source.pauseRevisioned).toHaveBeenCalledOnce();

    const resume = authority(2);
    await expect(prepareAndCommit(h, resume, 3, 8)).resolves.toMatchObject({
      status: 'applied',
      phase: 'playing',
      positionSeconds: 8,
    });

    const playingSeek = authority(3);
    await expect(prepareAndCommit(h, playingSeek, 4, 95)).resolves.toMatchObject({
      status: 'applied',
      phase: 'playing',
      positionSeconds: 95,
    });

    expect(h.createSource).toHaveBeenCalledTimes(3);
    expect(h.resolveRangeSource).toHaveBeenCalledTimes(3);
    expect(h.restoreLegacy).not.toHaveBeenCalled();
    expect(h.adapter.currentSnapshot()).toMatchObject({
      queueItemId: Q1,
      phase: 'playing',
      revision: 4,
      positionSeconds: 95,
    });
  });

  it('keeps a paused late-join checkpoint metadata-only until a later bounded PLAY', async () => {
    const h = harness();
    const paused = authority(0, 'paused-late-join');

    await expect(
      h.adapter.prepare(
        prepareRequest(paused, {
          state: 'paused',
          positionSeconds: 33.5,
        }),
      ),
    ).resolves.toEqual({ status: 'ready', durationSeconds: null });
    expect(h.resolveRangeSource).not.toHaveBeenCalled();
    expect(h.createSource).not.toHaveBeenCalled();

    await expect(
      h.adapter.commit(
        commitRequest(paused, 1, {
          state: 'paused',
          positionSeconds: 33.5,
          scheduleDelayMs: 0,
        }),
      ),
    ).resolves.toEqual({
      status: 'applied',
      phase: 'paused',
      durationSeconds: null,
      positionSeconds: 33.5,
    });
    expect(h.resolveRangeSource).not.toHaveBeenCalled();
    expect(h.createSource).not.toHaveBeenCalled();
    expect(h.restoreLegacy).not.toHaveBeenCalled();
    expect(h.adapter.hasCurrent()).toBe(false);

    const playing = authority(1, 'resume-late-join');
    await expect(
      h.adapter.prepare(
        prepareRequest(playing, {
          state: 'playing',
          positionSeconds: 33.5,
        }),
      ),
    ).resolves.toEqual({ status: 'ready', durationSeconds: 180 });
    expect(h.resolveRangeSource).toHaveBeenCalledOnce();
    expect(h.createSource).toHaveBeenCalledOnce();
    expect(h.restoreLegacy).not.toHaveBeenCalled();
  });

  it('fences superseded preparation and exact cancellation while releasing every source', async () => {
    const h = harness();
    const first = authority(0, 'first');
    const second = authority(0, 'second');

    h.gateNextPrime();
    const firstPrepare = h.adapter.prepare(prepareRequest(first));
    await vi.waitFor(() => expect(h.created).toHaveLength(1));

    const secondPrepare = h.adapter.prepare(prepareRequest(second));
    await expect(firstPrepare).resolves.toEqual({ status: 'superseded' });
    await expect(secondPrepare).resolves.toEqual({ status: 'ready', durationSeconds: 180 });
    await vi.waitFor(() => expect(h.created[0]!.source.destroy).toHaveBeenCalledOnce());

    // Restart with a genuinely pending prime so cancellation must abort native
    // preparation rather than merely removing an already-ready candidate.
    await h.adapter.clear();
    const pendingToken = authority(1, 'pending');
    h.gateNextPrime();
    const pending = h.adapter.prepare(prepareRequest(pendingToken));
    await vi.waitFor(() => expect(h.created).toHaveLength(3));
    await Promise.resolve();
    h.adapter.cancel(authority(1, 'wrong'));
    expect(h.created[2]!.source.destroy).not.toHaveBeenCalled();
    h.adapter.cancel(pendingToken);
    await expect(pending).resolves.toEqual({ status: 'superseded' });
    await vi.waitFor(() => expect(h.created[2]!.source.destroy).toHaveBeenCalledOnce());
    expect(h.adapter.hasCurrent()).toBe(false);
  });

  it('makes clear abort late preparation and prevents it from becoming current', async () => {
    const h = harness();
    const token = authority(0);
    const pending = deferred<EncodedAudioSource | null>();
    h.resolveRangeSource.mockImplementationOnce(() => pending.promise);

    const preparing = h.adapter.prepare(prepareRequest(token));
    await vi.waitFor(() => expect(h.resolveRangeSource).toHaveBeenCalledOnce());
    const clearing = h.adapter.clear();
    pending.resolve(encodedSource('late-after-clear'));

    await expect(preparing).resolves.toEqual({ status: 'superseded' });
    await clearing;
    expect(h.adapter.hasCurrent()).toBe(false);
    expect(h.adapter.currentSnapshot()).toBeNull();
  });

  it('falls back before touching media when the immutable build profile rolls back', async () => {
    const h = harness();
    h.getBuildProfile.mockReturnValueOnce({
      id: 'legacy-current',
      engine: 'legacy',
      boundedRouteMode: 'current',
      boundedRoutePolicy: null,
      semanticPlaybackCohortId: 'test-legacy-current',
    });

    await expect(h.adapter.prepare(prepareRequest(authority(0)))).resolves.toEqual({
      status: 'fallback',
    });
    expect(h.resolveRangeSource).not.toHaveBeenCalled();
    expect(h.createSource).not.toHaveBeenCalled();
  });

  it('fails fast at the hydration-adjusted PREPARE deadline without entering legacy fallback', async () => {
    vi.useFakeTimers();
    const h = harness();
    const stalledResolver = deferred<EncodedAudioSource | null>();
    const lateSource = encodedSource('late-after-admission-deadline');
    const emit = vi.spyOn(bus, 'emit');
    // A dependency bug or stalled presign may ignore AbortSignal entirely.
    // The adapter's own admission deadline must still settle the endpoint.
    h.resolveRangeSource.mockImplementationOnce(() => stalledResolver.promise);

    const preparing = h.adapter.prepare(
      prepareRequest(authority(0), {
        // Runtime already consumed the playlist hydration time. Only 50ms of
        // admission remains after the adapter's fixed 200ms commit reserve.
        prepareBudgetMs: 250,
      }),
    );
    const deadlineFailure = expect(preparing).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'PRO bounded preparation deadline',
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(h.createSource).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await deadlineFailure;
    expect(h.createSource).not.toHaveBeenCalled();
    expect(h.restoreLegacy).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      'player:v2-file-loading-settled',
      expect.objectContaining({
        owner: 'pro-prepare',
      }),
    );

    stalledResolver.resolve(lateSource);
    await vi.waitFor(() => expect(lateSource.close).toHaveBeenCalledOnce());
    expect(h.createSource).not.toHaveBeenCalled();

    const reserveOnly = h.adapter.prepare(
      prepareRequest(authority(1), {
        prepareBudgetMs: 200,
      }),
    );
    await expect(reserveOnly).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(h.resolveRangeSource).toHaveBeenCalledOnce();
    expect(h.restoreLegacy).not.toHaveBeenCalled();
  });

  it('keeps a late integrity failure fail-closed behind the authoritative PREPARE deadline', async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = deferred<EncodedAudioSource | null>();
    h.resolveRangeSource.mockImplementationOnce(() => pending.promise);
    const corruption = new EncodedSourceIntegrityError('late range identity mismatch');

    const preparing = h.adapter.prepare(
      prepareRequest(authority(0, 'deadline-integrity-race'), {
        prepareBudgetMs: 250,
      }),
    );
    const deadlineFailure = expect(preparing).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'PRO bounded preparation deadline',
    });
    await vi.advanceTimersByTimeAsync(50);
    pending.reject(corruption);

    await deadlineFailure;
    await Promise.resolve();
    expect(h.createSource).not.toHaveBeenCalled();
    expect(h.restoreLegacy).not.toHaveBeenCalled();
  });

  it('rebases a catch-up candidate from the latest COMMIT position and only its added local lead', async () => {
    const late = harness();
    const lateToken = authority(0, 'late-catch-up');
    await expect(
      late.adapter.prepare(
        prepareRequest(lateToken, {
          positionSeconds: 10,
          prepareBudgetMs: undefined,
        }),
      ),
    ).resolves.toEqual({ status: 'ready', durationSeconds: 180 });

    await expect(
      late.adapter.commit(
        commitRequest(lateToken, 1, {
          positionSeconds: 15,
          scheduleDelayMs: 0,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'applied',
      phase: 'playing',
      // The COMMIT was already rebased through receipt time. Only the
      // adapter-added 750ms snapshot horizon advances its canonical timeline.
      positionSeconds: 15.75,
    });
    expect(late.created[0]!.source.armForCutover).toHaveBeenCalledWith(
      expect.objectContaining({ positionSeconds: 15.75 }),
    );

    const future = harness();
    const futureToken = authority(0, 'future-catch-up');
    await expect(
      future.adapter.prepare(
        prepareRequest(futureToken, {
          positionSeconds: 15,
          prepareBudgetMs: undefined,
        }),
      ),
    ).resolves.toEqual({ status: 'ready', durationSeconds: 180 });

    await expect(
      future.adapter.commit(
        commitRequest(futureToken, 1, {
          positionSeconds: 15,
          scheduleDelayMs: 300,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'applied',
      phase: 'playing',
      // This position already belongs to the server's future executeAt; the
      // 300ms wire delay is subtracted from the 750ms local horizon.
      positionSeconds: 15.45,
    });
    expect(future.created[0]!.source.armForCutover).toHaveBeenCalledWith(
      expect.objectContaining({ positionSeconds: 15.45 }),
    );
  });

  it('recomputes catch-up position and a future arm target after deferred prime latency', async () => {
    const h = harness();
    const token = authority(0, 'slow-catch-up-prime');
    h.gateNextPrime();
    await expect(
      h.adapter.prepare(
        prepareRequest(token, {
          positionSeconds: 10,
          prepareBudgetMs: undefined,
        }),
      ),
    ).resolves.toEqual({ status: 'ready', durationSeconds: 180 });
    expect(h.created[0]!.source.primeForCutover).not.toHaveBeenCalled();

    const committing = h.adapter.commit(
      commitRequest(token, 1, {
        positionSeconds: 15,
        scheduleDelayMs: 0,
      }),
    );
    await vi.waitFor(() => expect(h.created[0]!.source.primeForCutover).toHaveBeenCalledOnce());

    // Decoder admission itself consumed 500ms, leaving 250ms of the fixed
    // receipt-relative horizon. The target and projected position must not
    // drift forward merely because decoding was slow.
    h.advanceRoomTime(500);
    h.created[0]!.primeGate.resolve();

    await expect(committing).resolves.toMatchObject({
      status: 'applied',
      phase: 'playing',
      // 15s at COMMIT receipt + the 750ms snapshot horizon. After the 500ms
      // prime, the target remains 250ms in the future with no timeline drift.
      positionSeconds: 15.75,
    });
    expect(h.created[0]!.source.armForCutover).toHaveBeenCalledWith(
      expect.objectContaining({
        positionSeconds: 15.75,
        startAtRoomTimeMs: 10_750,
      }),
    );
  });

  it('accepts the exact 30ms catch-up boundary and fails closed once the 750ms horizon is missed', async () => {
    const edge = harness();
    const edgeToken = authority(0, 'catch-up-edge');
    edge.gateNextPrime();
    await expect(
      edge.adapter.prepare(
        prepareRequest(edgeToken, {
          positionSeconds: 10,
          prepareBudgetMs: undefined,
        }),
      ),
    ).resolves.toEqual({ status: 'ready', durationSeconds: 180 });
    const edgeCommit = edge.adapter.commit(
      commitRequest(edgeToken, 1, {
        positionSeconds: 15,
        scheduleDelayMs: 0,
      }),
    );
    await vi.waitFor(() => expect(edge.created[0]!.source.primeForCutover).toHaveBeenCalledOnce());
    edge.advanceRoomTime(720);
    edge.created[0]!.primeGate.resolve();

    await expect(edgeCommit).resolves.toMatchObject({
      status: 'applied',
      phase: 'playing',
      positionSeconds: 15.75,
    });
    expect(edge.created[0]!.source.armForCutover).toHaveBeenCalledWith(
      expect.objectContaining({
        positionSeconds: 15.75,
        startAtRoomTimeMs: 10_750,
      }),
    );

    const missed = harness();
    const missedToken = authority(0, 'catch-up-missed');
    missed.gateNextPrime();
    await expect(
      missed.adapter.prepare(
        prepareRequest(missedToken, {
          positionSeconds: 10,
          prepareBudgetMs: undefined,
        }),
      ),
    ).resolves.toEqual({ status: 'ready', durationSeconds: 180 });
    const missedCommit = missed.adapter.commit(
      commitRequest(missedToken, 1, {
        positionSeconds: 15,
        scheduleDelayMs: 0,
      }),
    );
    await vi.waitFor(() =>
      expect(missed.created[0]!.source.primeForCutover).toHaveBeenCalledOnce(),
    );
    missed.advanceRoomTime(721);
    missed.created[0]!.primeGate.resolve();

    await expect(missedCommit).resolves.toEqual({ status: 'failed' });
    expect(missed.created[0]!.source.armForCutover).not.toHaveBeenCalled();
    expect(missed.adapter.hasCurrent()).toBe(false);
    expect(missed.restoreLegacy).not.toHaveBeenCalled();
  });

  it('represents canonical paused-at-zero as an exact stop and revokes the advanced renderer', async () => {
    vi.useFakeTimers();
    const h = harness();
    const initial = authority(0);
    await expect(prepareAndCommit(h, initial, 1, 1)).resolves.toMatchObject({
      status: 'applied',
      phase: 'playing',
      positionSeconds: 1,
    });

    const stoppingAtZero = h.adapter.commit(
      commitRequest(authority(1, null), 2, {
        state: 'paused',
        positionSeconds: 0,
        scheduleDelayMs: 0,
      }),
    );
    await Promise.resolve();
    h.context.currentTime += 1;
    await vi.advanceTimersByTimeAsync(100);
    await expect(stoppingAtZero).resolves.toMatchObject({
      status: 'applied',
      phase: 'paused',
      positionSeconds: 0,
    });
    expect(h.adapter.hasCurrent()).toBe(false);
    expect(h.adapter.currentSnapshot()).toBeNull();
    await vi.waitFor(() => expect(h.created[0]!.source.destroy).toHaveBeenCalledOnce());
  });

  it('submits one ended observation for one current run', async () => {
    vi.useFakeTimers();
    const h = harness();
    const token = authority(0);
    await expect(prepareAndCommit(h, token, 1)).resolves.toMatchObject({
      status: 'applied',
      phase: 'playing',
    });
    h.created[0]!.setPhase('ended');

    await vi.advanceTimersByTimeAsync(100);
    expect(h.routeEnded).toHaveBeenCalledOnce();
    expect(h.routeEnded).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ended',
        queueItemId: Q1,
        durationSeconds: 180,
        mediaKind: 'file',
      }),
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(h.routeEnded).toHaveBeenCalledOnce();
  });

  it('suppresses stale ENDED and recovery while a newer authority is preparing', async () => {
    vi.useFakeTimers();
    const ended = harness();
    await expect(
      prepareAndCommit(ended, authority(0, 'ended-current'), 1, 10),
    ).resolves.toMatchObject({
      status: 'applied',
      phase: 'playing',
    });
    ended.gateNextPrime();
    const endedSuccessor = ended.adapter.prepare(
      prepareRequest(authority(1, 'ended-successor'), {
        positionSeconds: 20,
      }),
    );
    await vi.waitFor(() => expect(ended.created).toHaveLength(2));
    ended.created[0]!.setPhase('ended');
    await vi.advanceTimersByTimeAsync(100);
    expect(ended.routeEnded).not.toHaveBeenCalled();
    await ended.adapter.clear();
    await expect(endedSuccessor).resolves.toEqual({ status: 'superseded' });

    const failed = harness();
    await expect(
      prepareAndCommit(failed, authority(0, 'failed-current'), 1, 10),
    ).resolves.toMatchObject({
      status: 'applied',
      phase: 'playing',
    });
    failed.gateNextPrime();
    const failedSuccessor = failed.adapter.prepare(
      prepareRequest(authority(1, 'failed-successor'), {
        positionSeconds: 20,
      }),
    );
    await vi.waitFor(() => expect(failed.created).toHaveLength(2));
    failed.created[0]!.fail('decoder-unavailable');
    await vi.advanceTimersByTimeAsync(100);
    expect(failed.restoreLegacy).not.toHaveBeenCalled();
    await failed.adapter.clear();
    await expect(failedSuccessor).resolves.toEqual({ status: 'superseded' });
  });

  it('fails closed on an integrity failure instead of masking it with whole-file restore', async () => {
    vi.useFakeTimers();
    const h = harness();
    await expect(prepareAndCommit(h, authority(0), 1, 10)).resolves.toMatchObject({
      status: 'applied',
      phase: 'playing',
    });
    h.created[0]!.fail('PRO_ROOM_MEDIA_RANGE_CONTENT_MISMATCH');

    await vi.advanceTimersByTimeAsync(100);
    expect(h.restoreLegacy).not.toHaveBeenCalled();
    expect(h.adapter.hasCurrent()).toBe(false);
  });

  it('retires only the stale committed renderer after successor failure and preserves a newer candidate', async () => {
    vi.useFakeTimers();
    const h = harness();
    await expect(
      prepareAndCommit(h, authority(0, 'current-revision-1'), 1, 10),
    ).resolves.toMatchObject({
      status: 'applied',
      phase: 'playing',
    });
    const outgoing = h.created[0]!;

    const failedCanonical = authority(1, 'failed-canonical-revision-2');
    const corruption = new EncodedSourceIntegrityError('successor content identity changed');
    h.createSource.mockRejectedValueOnce(corruption);
    await expect(
      h.adapter.prepare(
        prepareRequest(failedCanonical, {
          positionSeconds: 20,
        }),
      ),
    ).rejects.toBe(corruption);

    const newer = authority(2, 'newer-candidate-revision-3');
    await expect(
      h.adapter.prepare(
        prepareRequest(newer, {
          positionSeconds: 30,
        }),
      ),
    ).resolves.toEqual({ status: 'ready', durationSeconds: 180 });
    const newerCandidate = h.created.at(-1)!;

    const invalidating = h.adapter.invalidateCommitted(
      commitRequest(failedCanonical, 2, {
        positionSeconds: 20,
        scheduleDelayMs: 0,
      }),
    );
    await Promise.resolve();
    h.context.currentTime += 0.1;
    await vi.advanceTimersByTimeAsync(100);
    await invalidating;

    expect(h.adapter.hasCurrent()).toBe(false);
    expect(h.adapter.currentSnapshot()).toBeNull();
    expect(outgoing.source.destroy).toHaveBeenCalledOnce();
    expect(newerCandidate.source.destroy).not.toHaveBeenCalled();
    expect(h.restoreLegacy).not.toHaveBeenCalled();

    await expect(
      h.adapter.commit(
        commitRequest(newer, 3, {
          positionSeconds: 30,
          scheduleDelayMs: 30,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'applied',
      phase: 'playing',
      positionSeconds: 30,
    });
    expect(h.adapter.hasCurrent(Q1)).toBe(true);
    expect(h.adapter.currentSnapshot()).toMatchObject({
      queueItemId: Q1,
      revision: 3,
      positionSeconds: 30,
    });
  });

  it('never resurrects a failed paused renderer as audible legacy playback', async () => {
    vi.useFakeTimers();
    const h = harness();
    await expect(prepareAndCommit(h, authority(0), 1, 5)).resolves.toMatchObject({
      status: 'applied',
      phase: 'playing',
    });
    await expect(
      h.adapter.commit(
        commitRequest(authority(1, null), 2, {
          state: 'paused',
          positionSeconds: 5,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'applied',
      phase: 'paused',
    });
    h.created[0]!.fail('decoder-unavailable');

    await vi.advanceTimersByTimeAsync(100);
    expect(h.restoreLegacy).not.toHaveBeenCalled();
    expect(h.adapter.hasCurrent()).toBe(false);
  });

  it('signals compatibility fallback but fails closed on source integrity errors', async () => {
    const compatible = harness();
    compatible.createSource.mockRejectedValueOnce(
      new ProRoomMediaRangeCompatibilityError('PRO_ROOM_MEDIA_RANGE_UNSUPPORTED'),
    );
    await expect(
      compatible.adapter.prepare(prepareRequest(authority(0, 'compatibility'))),
    ).resolves.toEqual({ status: 'fallback' });
    expect(compatible.restoreLegacy).not.toHaveBeenCalled();

    const unsupported = harness();
    unsupported.createSource.mockRejectedValueOnce(new UnsupportedOrdinaryEncodedSourceError());
    await expect(
      unsupported.adapter.prepare(prepareRequest(authority(0, 'unsupported-ordinary'))),
    ).resolves.toEqual({ status: 'fallback' });
    expect(unsupported.restoreLegacy).not.toHaveBeenCalled();

    const integrity = harness();
    const corruption = new EncodedSourceIntegrityError('content range changed identity');
    integrity.createSource.mockRejectedValueOnce(corruption);
    await expect(integrity.adapter.prepare(prepareRequest(authority(0, 'integrity')))).rejects.toBe(
      corruption,
    );
    expect(integrity.restoreLegacy).not.toHaveBeenCalled();
  });

  it('does not resolve, construct, or restore media for a standard room', async () => {
    const h = harness();
    setState('room.context', {
      kind: 'standard',
      roomId: null,
      role: 'idle',
      coordinatorId: null,
      epoch: 0,
      snapshotRevision: 0,
      capabilities: [],
    });

    await expect(h.adapter.prepare(prepareRequest(authority(0)))).resolves.toEqual({
      status: 'superseded',
    });
    expect(h.resolveRangeSource).not.toHaveBeenCalled();
    expect(h.createSource).not.toHaveBeenCalled();
    expect(h.restoreLegacy).not.toHaveBeenCalled();
    expect(h.adapter.hasCurrent()).toBe(false);
  });
});
