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
import type {
  FilePlaybackHostFirstFileEngineOptions,
  HostCurrentPlaybackOperationOptions,
  HostCurrentPlaybackTransitionCommit,
  HostFirstLocalFilePlaybackCommit,
  SeekHostPausedOptions,
  SeekHostPlayingOptions,
  StartHostFirstLocalFileOptions,
  StartHostLocalTrackOptions,
} from '../file-playback-host-first-file-engine.ts';
import { FilePlaybackProductBaselineIdIssuer } from '../file-playback-product-baseline-session.ts';
import {
  FilePlaybackProductHostRoom,
  type FilePlaybackProductHostFirstEnginePort,
} from '../file-playback-product-host-room.ts';
import { FilePlaybackRoomClock } from '../file-playback-room-clock.ts';
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
  readonly startFirstLocalFile = vi.fn(
    (input: StartHostFirstLocalFileOptions): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> =>
      this.#commitFileCandidate(input, 0),
  );
  readonly startLocalTrack = vi.fn(
    (input: StartHostLocalTrackOptions): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> =>
      this.#commitFileCandidate(input, input.positionSeconds),
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
  private phase: FilePlaybackSourcePhase = 'stopped';
  private asset: FixtureAsset | null = null;
  private audioContext: AudioContext | null = null;
  private sequence = 0;

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

  async #commitFileCandidate(
    input: StartHostFirstLocalFileOptions,
    positionSeconds: number,
  ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> {
    const backend: FilePlaybackBackend =
      input.mime === 'audio/flac' || input.name.toLowerCase().endsWith('.flac')
        ? 'streaming-flac'
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
    return this.#commitCandidate(
      input.queueItemId,
      backend,
      asset,
      positionSeconds,
      true,
      input.signal,
    );
  }

  async #commitCurrentCandidate(
    action: 'playing-seek' | 'replay' | 'resume',
    positionSeconds: number,
    signal: AbortSignal,
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
    );
  }

  async #commitCandidate(
    queueItemId: QueueItemId,
    backend: FilePlaybackBackend,
    asset: FixtureAsset,
    positionSeconds: number,
    newRun: boolean,
    signal: AbortSignal,
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
    const runId = newRun || !this.runId ? `fixture-run-${++this.sequence}` : this.runId;
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
  readonly initGate?: ReturnType<typeof deferred<void>>;
  readonly ensureGate?: ReturnType<typeof deferred<void>>;
  readonly destination?: AudioNode | null;
  readonly onCreateEngine?: (engine: FixtureEngine) => void;
  readonly onGetAudioContext?: () => void;
  readonly onGetDestination?: () => void;
  readonly onReferencesReleased?: (snapshot: Readonly<Record<string, false>>) => void;
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
    onFatalRoom: fatal,
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

function track(
  room: FilePlaybackProductHostRoom,
  queueItemId: QueueItemId,
  value: File,
  positionSeconds = 0,
  signal = new AbortController().signal,
) {
  return room.startLocalTrack({ queueItemId, file: value, positionSeconds, signal });
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
  it.each([
    ['ordinary to FLAC', file('one.mp3'), file('two.flac', 'audio/flac'), 'streaming-flac'],
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
      expect(setup.engines[0]?.startLocalTrack).toHaveBeenCalledTimes(2);
      expect(setup.engines[0]?.close).not.toHaveBeenCalled();
      expect(setup.room.currentRendererSnapshot()).toMatchObject({ queueItemId: Q2, backend });
      expect(setup.room.positionAt(2_000)?.queueItemId).toBe(Q2);
      expect(containsBody(result)).toBe(false);
    },
  );

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
      backend: 'streaming-flac',
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
      backend: 'streaming-flac',
      attempt: { queueItemId: Q2 },
    });
    expect(setup.engines).toHaveLength(1);
  });

  it('settles natural end and leaves stopped room truth', async () => {
    const setup = makeHarness();
    await first(setup.room, Q1, file('one.mp3'));

    const ended = await setup.room.settleEndedCurrent(signalOptions());

    expect(ended).toMatchObject({
      status: 'committed',
      kind: 'ended',
      evidence: { kind: 'ended-renderer-retired' },
      timeline: { phase: 'stopped', run: null },
    });
    expect(setup.room.currentRendererSnapshot()).toBeNull();
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
    let engine: FixtureEngine | null = null;
    const setup = makeHarness({
      enginePlan: {
        onClose: () => engine?.fatal(new Error('duplicate-during-close')),
      },
      onCreateEngine: (created) => {
        engine = created;
      },
    });
    await first(setup.room, Q1, file('fatal.mp3'));
    const fatal = new Error('fixture fatal');

    engine?.fatal(fatal);
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
