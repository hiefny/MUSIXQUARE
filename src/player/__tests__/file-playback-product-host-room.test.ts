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
  HostFirstLocalFilePlaybackCommit,
  StartHostFirstLocalFileOptions,
} from '../file-playback-host-first-file-engine.ts';
import { FilePlaybackProductBaselineIdIssuer } from '../file-playback-product-baseline-session.ts';
import {
  FilePlaybackProductHostRoom,
  type FilePlaybackProductHostFirstEnginePort,
  type FilePlaybackProductHostFirstLocalFileResult,
} from '../file-playback-product-host-room.ts';
import { FilePlaybackRoomClock } from '../file-playback-room-clock.ts';
import type {
  FilePlaybackBackend,
  FilePlaybackPosition,
  FilePlaybackSourceSnapshot,
} from '../file-playback-source.ts';
import type { OrdinaryAudioDecoder } from '../file-playback-source-factory.ts';
import { createStoppedPlaybackTimeline } from '../playback-timeline.ts';

const Q1 = '97000000-0000-4000-8000-000000000001' as QueueItemId;
const Q2 = '97000000-0000-4000-8000-000000000002' as QueueItemId;
let connectionSequence = 0;

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

interface StartPlan {
  readonly beforeCommit?: ReturnType<typeof deferred<void>>;
  readonly afterCommit?: ReturnType<typeof deferred<void>>;
  readonly ignoreAbortWhileWaiting?: boolean;
  readonly failure?: Error;
  readonly bodyLeak?: boolean;
}

interface EnginePlan {
  readonly starts?: StartPlan[];
  readonly closeGate?: ReturnType<typeof deferred<void>>;
  readonly closeFailure?: Error;
}

async function waitForPlanGate(
  gate: ReturnType<typeof deferred<void>> | undefined,
  signal: AbortSignal,
  ignoreAbortWhileWaiting: boolean,
): Promise<void> {
  if (!gate) return;
  if (ignoreAbortWhileWaiting) {
    await gate.promise;
    return;
  }
  await Promise.race([
    gate.promise,
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  ]);
}

class FixtureEngine implements FilePlaybackProductHostFirstEnginePort {
  readonly starts: StartPlan[];
  readonly startFirstLocalFile = vi.fn(
    async (
      input: StartHostFirstLocalFileOptions,
    ): Promise<Readonly<HostFirstLocalFilePlaybackCommit>> => {
      const plan = this.starts.shift() ?? {};
      await waitForPlanGate(plan.beforeCommit, input.signal, plan.ignoreAbortWhileWaiting === true);
      input.signal.throwIfAborted();
      if (plan.failure) throw plan.failure;

      const backend: FilePlaybackBackend =
        input.mime === 'audio/flac' || input.name.toLowerCase().endsWith('.flac')
          ? 'streaming-flac'
          : 'audio-buffer';
      const previous = this.options.controller.timelineSnapshot();
      const attempt = Object.freeze({
        queueItemId: input.queueItemId,
        runId: `fixture-run-${++this.sequence}`,
        revision: previous.revision + 1,
        rendezvousId: `fixture-rendezvous-${this.sequence}`,
      });
      const schedule = Object.freeze({
        createdAtRoomTimeMs: 1_000,
        finalizeByRoomTimeMs: 1_300,
        leadTimeMs: 500,
        playbackRate: 1,
        positionSeconds: 0,
        startAtRoomTimeMs: 1_500,
      });
      const startEvidence =
        backend === 'audio-buffer'
          ? Object.freeze({ kind: 'webaudio-schedule-passed' as const, targetFrame: 72_000 })
          : Object.freeze({
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
      this.queueItemId = input.queueItemId;
      this.runId = attempt.runId;
      this.revision = attempt.revision;
      await waitForPlanGate(plan.afterCommit, input.signal, true);

      return Object.freeze({
        schemaVersion: 1 as const,
        roomGeneration: this.options.roomGeneration,
        backend,
        asset: plan.bodyLeak
          ? (Object.freeze({ queueItemId: input.queueItemId, blob: input.blob }) as never)
          : Object.freeze({
              queueItemId: input.queueItemId,
              sourceIdentity: `fixture-source-${this.sequence}`,
              transferSessionId: `fixture-transfer-${this.sequence}`,
              kind: 'blob' as const,
              size: input.blob.size,
              name: input.name,
              mime: input.mime || 'application/octet-stream',
            }),
        attempt,
        schedule,
        startEvidence,
        timeline: committed.timeline,
      });
    },
  );
  readonly close = vi.fn((): Promise<void> => {
    if (!this.closePromise) {
      this.events.push(`engine:${this.index}:close-called`);
      this.closePromise = (async () => {
        if (this.plan.closeGate) await this.plan.closeGate.promise;
        if (this.plan.closeFailure) throw this.plan.closeFailure;
        this.events.push(`engine:${this.index}:close-settled`);
      })();
    }
    return this.closePromise;
  });
  readonly currentRendererSnapshot = vi.fn((): FilePlaybackSourceSnapshot | null => {
    if (!this.queueItemId || !this.backend || !this.runId) return null;
    return Object.freeze({
      schemaVersion: 1 as const,
      queueItemId: this.queueItemId,
      backend: this.backend,
      phase: 'playing' as const,
      revision: this.revision,
      run: Object.freeze({
        queueItemId: this.queueItemId,
        runId: this.runId,
        revision: this.revision,
      }),
      durationSeconds: 180,
      positionSeconds: 1,
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
    return Object.freeze({
      queueItemId: snapshot.queueItemId,
      run: snapshot.run,
      phase: snapshot.phase,
      positionSeconds: snapshot.positionSeconds,
      bufferedAheadSeconds: snapshot.bufferedAheadSeconds,
      underrunCount: snapshot.underrunCount,
    });
  });
  private closePromise: Promise<void> | null = null;
  private backend: FilePlaybackBackend | null = null;
  private queueItemId: QueueItemId | null = null;
  private runId: string | null = null;
  private revision = 0;
  private sequence = 0;

  constructor(
    readonly index: number,
    readonly options: Readonly<FilePlaybackHostFirstFileEngineOptions>,
    readonly plan: EnginePlan,
    readonly events: string[],
  ) {
    this.starts = [...(plan.starts ?? [{}])];
  }

  fatal(error: Error): void {
    this.options.onFatalRoom(error);
  }
}

interface HarnessOptions {
  readonly enginePlans?: EnginePlan[];
  readonly initGate?: ReturnType<typeof deferred<void>>;
  readonly destination?: AudioNode | null;
  readonly onCreateEngine?: (engine: FixtureEngine) => void;
  readonly onReferencesReleased?: () => void;
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
  readonly decoder: OrdinaryAudioDecoder;
  readonly events: string[];
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
  const enginePlans = [...(options.enginePlans ?? [{}])];
  const fatal = vi.fn();
  const initAudio = vi.fn(async () => {
    events.push('graph:init');
    if (options.initGate) await options.initGate.promise;
  });
  const ensureRunning = vi.fn(async () => void events.push('graph:running'));
  const decoder: OrdinaryAudioDecoder = vi.fn(async () => ({
    audioBuffer: {} as AudioBuffer,
    release: vi.fn(),
  }));
  const createEngine = vi.fn((engineOptions: Readonly<FilePlaybackHostFirstFileEngineOptions>) => {
    const engine = new FixtureEngine(
      engines.length + 1,
      engineOptions,
      enginePlans.shift() ?? {},
      events,
    );
    engines.push(engine);
    options.onCreateEngine?.(engine);
    return engine;
  });
  const room = new FilePlaybackProductHostRoom({
    controller,
    hostRoomSnapshot: Object.freeze({
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
      getAudioContextForTests: () => context as unknown as AudioContext,
      getFilePlaybackDestinationForTests: () => destination,
      decodeOrdinaryAudioForTests: decoder,
      createRoomTokenForTests: () => Object.freeze({ harness: harnessSequence }),
      createEngineForTests: createEngine,
      onTerminalReferencesReleasedForTests: () => {
        events.push('references:released');
        options.onReferencesReleased?.();
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
    decoder,
    events,
  };
}

function file(name: string, type = 'audio/mpeg'): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type, lastModified: 7 });
}

function start(room: FilePlaybackProductHostRoom, queueItemId: QueueItemId, value: File) {
  return room.startFirstLocalFile({
    queueItemId,
    file: value,
    signal: new AbortController().signal,
  });
}

function containsBody(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value))
    return true;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(Object.getOwnPropertyDescriptors(value)).some(
    (descriptor) => Object.hasOwn(descriptor, 'value') && containsBody(descriptor.value, seen),
  );
}

describe('FilePlaybackProductHostRoom', () => {
  it.each([
    ['ordinary AudioBuffer', file('mix.mp3'), 'audio-buffer'],
    ['native FLAC stream', file('orchestra.flac', 'audio/flac'), 'streaming-flac'],
  ] as const)(
    'assembles the real controller/clock facade for %s',
    async (_label, media, backend) => {
      const setup = makeHarness();

      const result = await start(setup.room, Q1, media);

      expect(result).toMatchObject({ status: 'committed', backend });
      expect(Object.isFrozen(result)).toBe(true);
      expect(containsBody(result)).toBe(false);
      expect(setup.engines[0]?.startFirstLocalFile).toHaveBeenCalledWith(
        expect.objectContaining({
          blob: media,
          name: media.name,
          mime: media.type,
          decodeOrdinaryAudio: setup.decoder,
        }),
      );
      expect(setup.room.currentRendererSnapshot()?.queueItemId).toBe(Q1);
      expect(setup.room.positionAt(2_000)?.queueItemId).toBe(Q1);
    },
  );

  it('retries the exact same queue/File/metadata on the same private engine', async () => {
    const firstFailure = new Error('fixture decode failed');
    const setup = makeHarness({
      enginePlans: [{ starts: [{ failure: firstFailure }, {}] }],
    });
    const media = file('retry.mp3');

    await expect(start(setup.room, Q1, media)).rejects.toBe(firstFailure);
    await expect(start(setup.room, Q1, media)).resolves.toMatchObject({ status: 'committed' });

    expect(setup.engines).toHaveLength(1);
    expect(setup.engines[0]?.startFirstLocalFile).toHaveBeenCalledTimes(2);
    expect(setup.engines[0]?.close).not.toHaveBeenCalled();
  });

  it('aborts an uncommitted Q1, closes it, and builds a fresh Q2 engine', async () => {
    const pending = deferred<void>();
    const setup = makeHarness({
      enginePlans: [{ starts: [{ beforeCommit: pending }] }, { starts: [{}] }],
    });
    const q1 = start(setup.room, Q1, file('one.mp3'));
    await drainMicrotasks();

    const q2 = start(setup.room, Q2, file('two.flac', 'audio/flac'));

    await expect(q1).rejects.toBeTruthy();
    await expect(q2).resolves.toMatchObject({
      status: 'committed',
      backend: 'streaming-flac',
    });
    expect(setup.engines).toHaveLength(2);
    expect(setup.engines[0]?.close).toHaveBeenCalledOnce();
    expect(setup.room.currentRendererSnapshot()?.queueItemId).toBe(Q2);
  });

  it('returns a controlled rejection when Q1 commits while Q2 is arriving', async () => {
    const afterCommit = deferred<void>();
    const setup = makeHarness({
      enginePlans: [{ starts: [{ afterCommit, ignoreAbortWhileWaiting: true }] }],
    });
    const q1 = start(setup.room, Q1, file('one.mp3'));
    await drainMicrotasks();
    expect(setup.controller.timelineSnapshot().run?.queueItemId).toBe(Q1);

    const q2 = start(setup.room, Q2, file('two.mp3'));
    afterCommit.resolve();

    await expect(q1).resolves.toMatchObject({ status: 'committed' });
    await expect(q2).resolves.toEqual(
      expect.objectContaining({
        status: 'rejected',
        reason: 'replacement-not-supported',
        currentQueueItemId: Q1,
      }),
    );
    expect(setup.engines).toHaveLength(1);
    expect(setup.engines[0]?.close).not.toHaveBeenCalled();
    expect(setup.room.currentRendererSnapshot()?.queueItemId).toBe(Q1);
  });

  it('returns the same controlled rejection for a normal post-commit replacement intent', async () => {
    const setup = makeHarness();
    await start(setup.room, Q1, file('one.mp3'));

    const result = await start(setup.room, Q2, file('two.mp3'));

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'replacement-not-supported',
      currentQueueItemId: Q1,
    });
    expect(containsBody(result)).toBe(false);
    expect(setup.engines[0]?.close).not.toHaveBeenCalled();
  });

  it('fences factory close re-entry and closes the unpublished candidate without starting it', async () => {
    let room: FilePlaybackProductHostRoom | null = null;
    let terminal: Promise<void> | null = null;
    const setup = makeHarness({
      onCreateEngine: () => {
        terminal = room?.close() ?? null;
      },
    });
    room = setup.room;

    await expect(start(setup.room, Q1, file('reentry.mp3'))).rejects.toBeTruthy();
    await expect(terminal).resolves.toBeUndefined();
    expect(setup.engines[0]?.close).toHaveBeenCalledOnce();
    expect(setup.engines[0]?.startFirstLocalFile).not.toHaveBeenCalled();
    expect(setup.room.currentRendererSnapshot()).toBeNull();
  });

  it('invokes engine.close immediately, hides projection, and releases references after pending work', async () => {
    const pending = deferred<void>();
    const setup = makeHarness({
      enginePlans: [{ starts: [{ beforeCommit: pending, ignoreAbortWhileWaiting: true }] }],
      onReferencesReleased: () => {
        throw new Error('diagnostic observer failure');
      },
    });
    const active = start(setup.room, Q1, file('pending.mp3'));
    await drainMicrotasks();

    const firstClose = setup.room.close();
    const secondClose = setup.room.close();

    expect(firstClose).toBe(secondClose);
    expect(setup.engines[0]?.close).toHaveBeenCalledOnce();
    expect(setup.room.currentRendererSnapshot()).toBeNull();
    expect(setup.events).not.toContain('references:released');
    pending.resolve();
    await expect(active).rejects.toBeTruthy();
    await expect(firstClose).resolves.toBeUndefined();
    expect(setup.events).toContain('references:released');
  });

  it('quarantines the room and notifies its owner when cross-Q engine cleanup fails', async () => {
    const cleanupFailure = new Error('fixture close failed');
    const setup = makeHarness({
      enginePlans: [
        { starts: [{ failure: new Error('first start failed') }], closeFailure: cleanupFailure },
      ],
    });
    await expect(start(setup.room, Q1, file('one.mp3'))).rejects.toBeTruthy();

    await expect(start(setup.room, Q2, file('two.mp3'))).rejects.toBe(cleanupFailure);
    await drainMicrotasks();

    expect(setup.fatal).toHaveBeenCalledOnce();
    await expect(start(setup.room, Q1, file('again.mp3'))).rejects.toBe(cleanupFailure);
    expect(setup.engines).toHaveLength(1);
  });

  it('propagates unpublished candidate cleanup failure through a reentrant room close', async () => {
    const cleanupFailure = new Error('unpublished candidate close failed');
    let room: FilePlaybackProductHostRoom | null = null;
    let terminal: Promise<void> | null = null;
    const setup = makeHarness({
      enginePlans: [{ closeFailure: cleanupFailure }],
      onCreateEngine: () => {
        terminal = room?.close() ?? null;
      },
    });
    room = setup.room;

    await expect(start(setup.room, Q1, file('candidate.mp3'))).rejects.toMatchObject({
      name: 'ProductHostRoomCleanupError',
    });
    await expect(terminal).rejects.toMatchObject({ name: 'ProductHostRoomCleanupError' });
    expect(setup.engines[0]?.startFirstLocalFile).not.toHaveBeenCalled();
  });

  it.each(['generation', 'role', 'clock'] as const)(
    'rejects stale %s authority without creating a mixed engine',
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

      await expect(start(setup.room, Q1, file('stale.mp3'))).rejects.toBeTruthy();
      expect(setup.engines).toHaveLength(0);
    },
  );

  it('rejects a first-file start after an exact guest connection becomes active', async () => {
    const setup = makeHarness();
    const active = establishedHostChannel();
    setup.controller.applicationSessionHooks().onLifecycleEvent(
      Object.freeze({
        kind: 'established' as const,
        role: 'host' as const,
        connection: active.connection,
        channel: active.channel,
      }),
    );
    expect(setup.controller.snapshot().activeConnectionCount).toBe(1);

    await expect(start(setup.room, Q1, file('connected.mp3'))).rejects.toBeTruthy();
    expect(setup.engines).toHaveLength(0);
  });

  it('rejects a destination owned by another AudioContext before engine creation', async () => {
    const wrongContext = new FakeAudioContext();
    const setup = makeHarness({ destination: destinationFor(wrongContext) });

    await expect(start(setup.room, Q1, file('wrong-context.mp3'))).rejects.toThrow(/destination/i);
    expect(setup.engines).toHaveLength(0);
  });

  it('keeps a stale graph-preparation completion inert', async () => {
    const initGate = deferred<void>();
    const setup = makeHarness({ initGate });
    const pending = start(setup.room, Q1, file('stale-graph.mp3'));
    await drainMicrotasks();
    expect(setup.initAudio).toHaveBeenCalledOnce();
    setup.controller.beginRoom(createStoppedPlaybackTimeline(2_000, 0));
    setup.controller.claimRoomRole('host');

    initGate.resolve();

    await expect(pending).rejects.toBeTruthy();
    expect(setup.ensureRunning).not.toHaveBeenCalled();
    expect(setup.engines).toHaveLength(0);
  });

  it('rejects an engine result that tries to expose a Blob', async () => {
    const setup = makeHarness({ enginePlans: [{ starts: [{ bodyLeak: true }] }] });

    await expect(start(setup.room, Q1, file('leak.mp3'))).rejects.toThrow(/body/i);
    await drainMicrotasks();
    expect(setup.engines[0]?.close).toHaveBeenCalledOnce();
    expect(setup.room.currentRendererSnapshot()).toBeNull();
    expect(setup.fatal).toHaveBeenCalledOnce();
    await expect(start(setup.room, Q1, file('retry.mp3'))).rejects.toThrow(/body/i);
  });

  it('closes and reports an engine fatal exact-once after terminal cleanup', async () => {
    const closeGate = deferred<void>();
    const setup = makeHarness({ enginePlans: [{ closeGate }] });
    await start(setup.room, Q1, file('fatal.mp3'));
    const fatal = new Error('fixture fatal');

    setup.engines[0]?.fatal(fatal);
    setup.engines[0]?.fatal(new Error('duplicate fatal'));

    expect(setup.engines[0]?.close).toHaveBeenCalledOnce();
    expect(setup.room.currentRendererSnapshot()).toBeNull();
    expect(setup.fatal).not.toHaveBeenCalled();
    closeGate.resolve();
    await setup.room.close().catch(() => undefined);
    await drainMicrotasks();
    expect(setup.fatal).toHaveBeenCalledOnce();
    expect(setup.fatal).toHaveBeenCalledWith(fatal);
  });
});
