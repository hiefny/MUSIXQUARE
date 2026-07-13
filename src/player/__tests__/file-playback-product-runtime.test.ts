import { describe, expect, it, vi } from 'vitest';

import { REMOTE_SHARE_MAX_BYTES } from '../../core/constants.ts';
import type {
  FilePlaybackApplicationSessionHooks,
  FilePlaybackHostApplicationSessionAuthority,
} from '../../network/file-playback-application-session.ts';
import type { DataConnection, QueueItemId } from '../../types/index.ts';
import { FilePlaybackApplicationController } from '../file-playback-application-controller.ts';
import { FilePlaybackAssetRegistry } from '../file-playback-asset-registry.ts';
import {
  createPeerRangeFileMediaSourceOfferV2,
  FileMediaOfferRegistry,
} from '../file-media-source-offer.ts';
import { FilePlaybackManager } from '../file-playback-manager.ts';
import type {
  HostPreparedLocalTrack,
  HostPreparedRemoteParticipant,
} from '../file-playback-host-first-file-engine.ts';
import { FilePlaybackProductBaselineIdIssuer } from '../file-playback-product-baseline-session.ts';
import type { FilePlaybackProductGuestMediaOwnerOptions } from '../file-playback-product-guest-media-owner.ts';
import type { FilePlaybackProductHostMediaOwnerOptions } from '../file-playback-product-host-media-owner.ts';
import type {
  FilePlaybackProductHostCurrentOptions,
  FilePlaybackProductHostFirstLocalFileCommit,
  FilePlaybackProductHostLocalTrackCommit,
  FilePlaybackProductHostRoomOptions,
  FilePlaybackProductHostSeekOptions,
  FilePlaybackProductHostTerminalObservation,
  FilePlaybackProductHostTransitionCommit,
  StartFilePlaybackProductHostFirstLocalFileOptions,
  StartFilePlaybackProductHostLocalTrackWithCohortOptions,
  StartFilePlaybackProductHostLocalTrackOptions,
} from '../file-playback-product-host-room.ts';
import {
  FilePlaybackProductRuntime,
  type FilePlaybackProductRuntimeControllerFactoryInput,
  type FilePlaybackProductRuntimeHostRoomPort,
  type FilePlaybackProductRuntimeOptions,
  type FilePlaybackProductRuntimeSessionAdapter,
} from '../file-playback-product-runtime.ts';
import { FilePlaybackR2WholeBlobPublisher } from '../file-playback-r2-whole-blob-publisher.ts';
import type {
  FilePlaybackProductSessionRouterConnectionContext,
  FilePlaybackProductSessionRouterOptions,
  FilePlaybackProductSessionRouterSnapshot,
} from '../file-playback-product-session-router.ts';
import type { PlaybackTimelineSnapshot } from '../playback-timeline.ts';

type FilePlaybackProductRuntimeMediaFactoriesForTests = NonNullable<
  FilePlaybackProductRuntimeOptions['mediaFactoriesForTests']
>;
type FilePlaybackProductRuntimeSessionRouterPort = ReturnType<
  NonNullable<FilePlaybackProductRuntimeMediaFactoriesForTests['createSessionRouter']>
>;

const Q1 = '98000000-0000-4000-8000-000000000001' as QueueItemId;
const Q2 = '98000000-0000-4000-8000-000000000002' as QueueItemId;

interface RuntimeHarness {
  readonly runtime: FilePlaybackProductRuntime;
  readonly sessions: FilePlaybackProductRuntimeSessionAdapter;
  readonly createController: ReturnType<typeof vi.fn>;
  readonly installHooks: ReturnType<typeof vi.fn>;
  readonly beginHostRoom: ReturnType<typeof vi.fn>;
  readonly endRoom: ReturnType<typeof vi.fn>;
  readonly handleWake: ReturnType<typeof vi.fn>;
  readonly roomNow: ReturnType<typeof vi.fn>;
  readonly monotonicNow: ReturnType<typeof vi.fn>;
  readonly createHostRoom: ReturnType<typeof vi.fn>;
  readonly hostRooms: ProductHostRoomHarness[];
  readonly events: string[];
  controller(): FilePlaybackApplicationController;
  setRoomNow(value: number): void;
}

interface ProductHostRoomHarness {
  readonly port: FilePlaybackProductRuntimeHostRoomPort;
  readonly options: Readonly<FilePlaybackProductHostRoomOptions>;
  readonly startFirstLocalFile: ReturnType<typeof vi.fn>;
  readonly startLocalTrack: ReturnType<typeof vi.fn>;
  readonly startLocalTrackWithCohort: ReturnType<typeof vi.fn>;
  readonly pauseCurrent: ReturnType<typeof vi.fn>;
  readonly seekPlaying: ReturnType<typeof vi.fn>;
  readonly seekPaused: ReturnType<typeof vi.fn>;
  readonly resumeCurrent: ReturnType<typeof vi.fn>;
  readonly replayCurrent: ReturnType<typeof vi.fn>;
  readonly stopCurrent: ReturnType<typeof vi.fn>;
  readonly settleEndedCurrent: ReturnType<typeof vi.fn>;
  readonly currentTerminalRendererObservation: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  setTerminalObservation(value: FilePlaybackProductHostTerminalObservation | null): void;
  fatal(error: Error): void;
}

interface HostRoomClosePlan {
  readonly gate?: ReturnType<typeof deferred<void>>;
  readonly failure?: Error;
}

interface RuntimeHarnessOptions {
  readonly enabled?: boolean;
  readonly installFailure?: Error;
  readonly endFailure?: Error;
  readonly roomNow?: number;
  readonly monotonicNow?: number;
  readonly hostRoomClosePlans?: readonly HostRoomClosePlan[];
  readonly omitHostRoomMethod?: keyof FilePlaybackProductRuntimeHostRoomPort;
  readonly mediaFactoriesForTests?: Readonly<FilePlaybackProductRuntimeMediaFactoriesForTests>;
  readonly onHealthSystemMessage?: FilePlaybackProductRuntimeOptions['onHealthSystemMessage'];
}

let harnessSequence = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function candidateResult(
  roomGeneration: number,
  applicationSessionId: string,
  operation: string,
): Readonly<FilePlaybackProductHostLocalTrackCommit> {
  return Object.freeze({
    schemaVersion: 1,
    status: 'committed',
    roomGeneration,
    applicationSessionId,
    fixtureOperation: operation,
  }) as unknown as Readonly<FilePlaybackProductHostLocalTrackCommit>;
}

function transitionResult(
  roomGeneration: number,
  applicationSessionId: string,
  operation: string,
): Readonly<FilePlaybackProductHostTransitionCommit> {
  return Object.freeze({
    schemaVersion: 1,
    status: 'committed',
    roomGeneration,
    applicationSessionId,
    fixtureOperation: operation,
  }) as unknown as Readonly<FilePlaybackProductHostTransitionCommit>;
}

function harness(options: RuntimeHarnessOptions = {}): RuntimeHarness {
  const events: string[] = [];
  let roomTime = options.roomNow ?? 7_000;
  let monotonicTime = options.monotonicNow ?? 3_000;
  let currentController: FilePlaybackApplicationController | null = null;
  let hostRoomSequence = 0;
  harnessSequence += 1;

  const installHooks = vi.fn((_hooks: Readonly<FilePlaybackApplicationSessionHooks>) => {
    events.push('sessions:install-hooks');
    if (options.installFailure) throw options.installFailure;
  });
  const beginHostRoom = vi.fn((participantId: string) => {
    events.push('sessions:begin-host');
    hostRoomSequence += 1;
    return Object.freeze({
      applicationSessionId: `product-runtime-session-${harnessSequence}-${hostRoomSequence}`,
      hostParticipantId: participantId,
    }) satisfies Readonly<FilePlaybackHostApplicationSessionAuthority>;
  });
  const endRoom = vi.fn(() => {
    events.push('sessions:end-room');
    if (options.endFailure) throw options.endFailure;
  });
  const handleWake = vi.fn((_connection?: DataConnection) => {
    events.push('sessions:wake');
    return true;
  });
  const roomNow = vi.fn(() => {
    events.push('clock:room-now');
    return roomTime;
  });
  const monotonicNow = vi.fn(() => {
    events.push('clock:monotonic-now');
    return monotonicTime;
  });
  const sessions: FilePlaybackProductRuntimeSessionAdapter = {
    installHooks,
    beginHostRoom,
    endRoom,
    handleWake,
    nowRoomTimeMs: roomNow,
    sendRequired: vi.fn(() => true),
    sendWire: vi.fn(() => Object.freeze({ kind: 'source-ready' }) as never),
    closeConnection: vi.fn(),
  };
  const createController = vi.fn(
    (input: Readonly<FilePlaybackProductRuntimeControllerFactoryInput>) => {
      events.push('controller:create');
      const controller = new FilePlaybackApplicationController({
        initialTimeline: input.initialTimeline,
        idIssuer: new FilePlaybackProductBaselineIdIssuer({
          createBaselineId: () => `product-runtime-baseline-${harnessSequence}`,
        }),
        sendRequired: (connection, frame) => input.sessions.sendRequired(connection, frame),
        closeConnection: (connection) => input.sessions.closeConnection(connection),
        onHostReady: input.onHostReady,
        onTimelineAdopted: input.onTimelineAdopted,
        onTimelineUpdated: input.onTimelineUpdated,
      });
      const beginRoom = controller.beginRoom.bind(controller);
      const claimRoomRole = controller.claimRoomRole.bind(controller);
      vi.spyOn(controller, 'beginRoom').mockImplementation((timeline) => {
        events.push('controller:begin-room');
        return beginRoom(timeline);
      });
      vi.spyOn(controller, 'claimRoomRole').mockImplementation((role) => {
        events.push(`controller:claim-${role}`);
        return claimRoomRole(role);
      });
      currentController = controller;
      return controller;
    },
  );
  const hostRooms: ProductHostRoomHarness[] = [];
  const createHostRoom = vi.fn((roomOptions: Readonly<FilePlaybackProductHostRoomOptions>) => {
    const index = hostRooms.length + 1;
    const closePlan = options.hostRoomClosePlans?.[index - 1];
    let closePromise: Promise<void> | null = null;
    events.push('host-room:create');
    const candidate = (operation: string) =>
      candidateResult(
        roomOptions.hostRoomSnapshot.roomGeneration,
        roomOptions.hostRoomSnapshot.applicationSessionId,
        operation,
      );
    const transition = (operation: string) =>
      transitionResult(
        roomOptions.hostRoomSnapshot.roomGeneration,
        roomOptions.hostRoomSnapshot.applicationSessionId,
        operation,
      );
    const startFirstLocalFile = vi.fn(
      async (
        _input: StartFilePlaybackProductHostFirstLocalFileOptions,
      ): Promise<Readonly<FilePlaybackProductHostFirstLocalFileCommit>> => {
        events.push(`host-room:${index}:first`);
        return candidate('first');
      },
    );
    const startLocalTrack = vi.fn(async (_input: StartFilePlaybackProductHostLocalTrackOptions) => {
      events.push(`host-room:${index}:track`);
      return candidate('track');
    });
    const startLocalTrackWithCohort = vi.fn(
      async (_input: StartFilePlaybackProductHostLocalTrackWithCohortOptions) => {
        events.push(`host-room:${index}:track-cohort`);
        return candidate('track-cohort');
      },
    );
    const pauseCurrent = vi.fn(async (_input: FilePlaybackProductHostCurrentOptions) => {
      events.push(`host-room:${index}:pause`);
      return transition('pause');
    });
    const seekPlaying = vi.fn(async (_input: FilePlaybackProductHostSeekOptions) => {
      events.push(`host-room:${index}:seek-playing`);
      return candidate('seek-playing');
    });
    const seekPaused = vi.fn(async (_input: FilePlaybackProductHostSeekOptions) => {
      events.push(`host-room:${index}:seek-paused`);
      return transition('seek-paused');
    });
    const resumeCurrent = vi.fn(async (_input: FilePlaybackProductHostCurrentOptions) => {
      events.push(`host-room:${index}:resume`);
      return candidate('resume');
    });
    const replayCurrent = vi.fn(async (_input: FilePlaybackProductHostCurrentOptions) => {
      events.push(`host-room:${index}:replay`);
      return candidate('replay');
    });
    const stopCurrent = vi.fn(async (_input: FilePlaybackProductHostCurrentOptions) => {
      events.push(`host-room:${index}:stop`);
      return transition('stop');
    });
    const settleEndedCurrent = vi.fn(async (_input: FilePlaybackProductHostCurrentOptions) => {
      events.push(`host-room:${index}:ended`);
      return transition('ended');
    });
    let terminalObservation: FilePlaybackProductHostTerminalObservation | null = null;
    const currentTerminalRendererObservation = vi.fn(() => terminalObservation);
    const currentPeerPublication = vi.fn(() => null);
    const resolveCurrentPeerRangeSource = vi.fn(async () => {
      throw new Error('fixture has no peer source');
    });
    const recoverRemoteParticipant = vi.fn(async () => {
      throw new Error('fixture has no remote participant');
    });
    const close = vi.fn(() => {
      if (!closePromise) {
        events.push(`host-room:${index}:close`);
        closePromise = (async () => {
          if (closePlan?.gate) await closePlan.gate.promise;
          if (closePlan?.failure) throw closePlan.failure;
          events.push(`host-room:${index}:closed`);
        })();
      }
      return closePromise;
    });
    const port: FilePlaybackProductRuntimeHostRoomPort = {
      startFirstLocalFile,
      startLocalTrack,
      startLocalTrackWithCohort,
      pauseCurrent,
      seekPlaying,
      seekPaused,
      resumeCurrent,
      replayCurrent,
      stopCurrent,
      settleEndedCurrent,
      currentPeerPublication,
      resolveCurrentPeerRangeSource,
      recoverRemoteParticipant,
      close,
      currentRendererSnapshot: vi.fn(() => null),
      currentTerminalRendererObservation,
      positionAt: vi.fn(() => null),
    };
    if (options.omitHostRoomMethod) {
      Reflect.deleteProperty(
        port as unknown as Record<string, unknown>,
        options.omitHostRoomMethod,
      );
    }
    const room: ProductHostRoomHarness = {
      port,
      options: roomOptions,
      startFirstLocalFile,
      startLocalTrack,
      startLocalTrackWithCohort,
      pauseCurrent,
      seekPlaying,
      seekPaused,
      resumeCurrent,
      replayCurrent,
      stopCurrent,
      settleEndedCurrent,
      currentTerminalRendererObservation,
      close,
      setTerminalObservation: (value) => void (terminalObservation = value),
      fatal: (error) => roomOptions.onFatalRoom(error),
    };
    hostRooms.push(room);
    return port;
  });
  const runtime = new FilePlaybackProductRuntime({
    enabled: options.enabled ?? true,
    sessions,
    createController,
    nowMonotonicMs: monotonicNow,
    createHostRoom,
    mediaFactoriesForTests: options.mediaFactoriesForTests,
    onHealthSystemMessage: options.onHealthSystemMessage,
  });

  return {
    runtime,
    sessions,
    createController,
    installHooks,
    beginHostRoom,
    endRoom,
    handleWake,
    roomNow,
    monotonicNow,
    createHostRoom,
    hostRooms,
    events,
    controller: () => {
      if (!currentController) throw new Error('Controller has not been created');
      return currentController;
    },
    setRoomNow: (value) => void (roomTime = value),
  };
}

function connection(): DataConnection {
  return {
    peer: 'product-runtime-peer',
    open: true,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as DataConnection;
}

function localFile(name = 'product-runtime.mp3'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'audio/mpeg' });
}

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

interface ProductRouterHarness {
  readonly port: FilePlaybackProductRuntimeSessionRouterPort;
  readonly options: Readonly<FilePlaybackProductSessionRouterOptions>;
  readonly notifyHostReady: ReturnType<typeof vi.fn>;
  readonly notifyTimelineAdopted: ReturnType<typeof vi.fn>;
  readonly notifyTimelineUpdated: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
}

function productRouterHarness(
  options: Readonly<FilePlaybackProductSessionRouterOptions>,
): ProductRouterHarness {
  let closed = false;
  const hooks: Readonly<FilePlaybackApplicationSessionHooks> = Object.freeze({
    onLifecycleEvent: vi.fn(),
    adoptAuxiliaryMessage: vi.fn(),
    adoptWireMessage: vi.fn(),
    adoptPeerRangeMessage: vi.fn(),
  });
  const notifyHostReady = vi.fn(() => true);
  const notifyTimelineAdopted = vi.fn(() => true);
  const notifyTimelineUpdated = vi.fn(() => true);
  const close = vi.fn(() => {
    closed = true;
  });
  const port: FilePlaybackProductRuntimeSessionRouterPort = {
    applicationSessionHooks: () => hooks,
    notifyHostReady,
    notifyTimelineAdopted,
    notifyTimelineUpdated,
    snapshot: () =>
      Object.freeze({
        schemaVersion: 1,
        closed,
        activeConnectionCount: 0,
        connections: Object.freeze([]),
      }) satisfies Readonly<FilePlaybackProductSessionRouterSnapshot>,
    close,
  };
  return {
    port,
    options,
    notifyHostReady,
    notifyTimelineAdopted,
    notifyTimelineUpdated,
    close,
  };
}

function routerContext(
  role: 'host' | 'guest',
  input: Readonly<{ connection?: DataConnection; suffix?: string }> = {},
): Readonly<FilePlaybackProductSessionRouterConnectionContext> {
  const suffix = input.suffix ?? role;
  const peer = input.connection ?? connection();
  return freezeCanonical({
    schemaVersion: 1 as const,
    role,
    connection: peer,
    channel: Object.freeze({}) as never,
    connectionToken: peer as unknown as object,
    routerToken: Object.freeze(Object.create(null) as object),
    sessionId: `product-router-session-${suffix}`,
    connectionId: `product-router-connection-${suffix}`,
    hostParticipantId: `product-router-host-${suffix}`,
    guestParticipantId: `product-router-guest-${suffix}`,
  });
}

function commitHostPlayingForTerminalObservation(
  setup: RuntimeHarness,
  input: Readonly<{
    queueItemId?: QueueItemId;
    runId?: string;
    backend?: FilePlaybackProductHostTerminalObservation['backend'];
  }> = {},
): FilePlaybackProductHostTerminalObservation {
  const controller = setup.controller();
  const previous = controller.timelineSnapshot();
  const queueItemId = input.queueItemId ?? Q1;
  const runId = input.runId ?? `product-runtime-run-${harnessSequence}-${previous.revision + 1}`;
  const revision = previous.revision + 1;
  const attempt = freezeCanonical({
    queueItemId,
    runId,
    revision,
    rendezvousId: `product-runtime-rendezvous-${harnessSequence}-${revision}`,
  });
  const createdAtRoomTimeMs = Math.max(previous.anchorMonotonicMs, 1_000);
  const committed = controller.commitHostStartedPlayback({
    roomGeneration: controller.snapshot().roomGeneration,
    expectedPreviousRevision: previous.revision,
    attempt,
    schedule: freezeCanonical({
      createdAtRoomTimeMs,
      finalizeByRoomTimeMs: createdAtRoomTimeMs + 300,
      leadTimeMs: 500,
      playbackRate: 1,
      positionSeconds: 0,
      startAtRoomTimeMs: createdAtRoomTimeMs + 500,
    }),
    startEvidence: freezeCanonical({
      kind: 'webaudio-schedule-passed' as const,
      targetFrame: 72_000,
    }),
  });
  const run = freezeCanonical({ queueItemId, runId, revision });
  return freezeCanonical({
    schemaVersion: 1 as const,
    queueItemId,
    backend: input.backend ?? 'audio-buffer',
    phase: 'ended' as const,
    revision,
    run,
    durationSeconds: 180,
    positionSeconds: committed.timeline.positionSeconds,
    bufferedAheadSeconds: 0,
    outputSampleRateHz: 48_000,
    channelCount: 2,
    underrunCount: 0,
    errorCode: null,
  });
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

function lastBeganTimeline(setup: RuntimeHarness): PlaybackTimelineSnapshot {
  const calls = vi.mocked(setup.controller().beginRoom).mock.calls;
  const timeline = calls.at(-1)?.[0];
  if (!timeline) throw new Error('Controller did not begin a room');
  return timeline;
}

describe('FilePlaybackProductRuntime', () => {
  it('is a complete no-op while its fixed gate is off', async () => {
    const setup = harness({ enabled: false });

    expect(setup.runtime.enabled()).toBe(false);
    expect(setup.runtime.initializeBeforeProtocol()).toBe(false);
    expect(setup.runtime.initializeBeforeProtocol()).toBe(false);
    expect(setup.runtime.controller()).toBeNull();
    expect(setup.runtime.hostRoomSnapshot()).toBeNull();
    expect(setup.runtime.beginHostRoom('host-off')).toBe(false);
    expect(setup.runtime.beginGuestRoom()).toBe(false);
    expect(setup.runtime.handleWake(connection())).toBe(false);
    expect(setup.runtime.currentHostRendererSnapshot()).toBeNull();
    expect(setup.runtime.currentHostTerminalRendererObservation()).toBeNull();
    expect(setup.runtime.hostPositionAt(1_000)).toBeNull();
    await expect(
      setup.runtime.startHostFirstLocalFile({
        queueItemId: Q1,
        file: localFile(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/disabled/u);
    const current = { signal: new AbortController().signal };
    const seek = { ...current, positionSeconds: 12 };
    await expect(
      setup.runtime.startLocalTrack({
        queueItemId: Q1,
        file: localFile(),
        positionSeconds: 0,
        signal: current.signal,
      }),
    ).rejects.toThrow(/disabled/u);
    await expect(setup.runtime.pauseCurrent(current)).rejects.toThrow(/disabled/u);
    await expect(setup.runtime.seekPlaying(seek)).rejects.toThrow(/disabled/u);
    await expect(setup.runtime.seekPaused(seek)).rejects.toThrow(/disabled/u);
    await expect(setup.runtime.resumeCurrent(current)).rejects.toThrow(/disabled/u);
    await expect(setup.runtime.replayCurrent(current)).rejects.toThrow(/disabled/u);
    await expect(setup.runtime.stopCurrent(current)).rejects.toThrow(/disabled/u);
    await expect(setup.runtime.settleEndedCurrent(current)).rejects.toThrow(/disabled/u);
    expect(() => setup.runtime.endRoom()).not.toThrow();

    expect(setup.createController).not.toHaveBeenCalled();
    expect(setup.installHooks).not.toHaveBeenCalled();
    expect(setup.beginHostRoom).not.toHaveBeenCalled();
    expect(setup.endRoom).not.toHaveBeenCalled();
    expect(setup.handleWake).not.toHaveBeenCalled();
    expect(setup.roomNow).not.toHaveBeenCalled();
    expect(setup.monotonicNow).not.toHaveBeenCalled();
    expect(setup.createHostRoom).not.toHaveBeenCalled();
    expect(setup.events).toEqual([]);
  });

  it('creates the controller and installs router-owned hooks exactly once before protocol', () => {
    const setup = harness({ monotonicNow: 4_321 });

    expect(setup.runtime.initializeBeforeProtocol()).toBe(true);
    const controller = setup.runtime.controller();
    expect(setup.runtime.initializeBeforeProtocol()).toBe(true);

    expect(controller).toBe(setup.controller());
    expect(setup.createController).toHaveBeenCalledOnce();
    expect(setup.installHooks).toHaveBeenCalledOnce();
    expect(setup.installHooks.mock.calls[0]?.[0]).not.toBe(controller?.applicationSessionHooks());
    expect(setup.installHooks.mock.calls[0]?.[0]).toMatchObject({
      onLifecycleEvent: expect.any(Function),
      adoptAuxiliaryMessage: expect.any(Function),
      adoptWireMessage: expect.any(Function),
      adoptPeerRangeMessage: expect.any(Function),
    });
    expect(setup.createController.mock.calls[0]?.[0].initialTimeline).toMatchObject({
      revision: 0,
      phase: 'stopped',
      anchorMonotonicMs: 4_321,
    });
    expect(setup.events).toEqual([
      'clock:monotonic-now',
      'controller:create',
      'sessions:install-hooks',
    ]);
  });

  it('defers controller media notifications out of router mutation and targets one exact router', async () => {
    const routers: ProductRouterHarness[] = [];
    const setup = harness({
      mediaFactoriesForTests: {
        createSessionRouter: (options) => {
          const candidate = productRouterHarness(options);
          routers.push(candidate);
          return candidate.port;
        },
      },
    });
    setup.runtime.initializeBeforeProtocol();
    const controllerInput = setup.createController.mock
      .calls[0]?.[0] as Readonly<FilePlaybackProductRuntimeControllerFactoryInput>;
    const hostReady = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: setup.controller().snapshot().roomGeneration,
      epoch: 1,
      role: 'host' as const,
      sessionId: 'deferred-host-session',
      connectionId: 'deferred-host-connection',
      baselineStatus: 'ready' as const,
      baselineId: 'deferred-host-baseline',
      playbackRevision: 0,
      clockReady: true,
      ready: true,
    });
    const timelineAdopted = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: setup.controller().snapshot().roomGeneration,
      sessionId: 'deferred-guest-session',
      connectionId: 'deferred-guest-connection',
      status: 'adopted' as const,
      timeline: setup.controller().timelineSnapshot(),
    });
    const timelineUpdated = freezeCanonical({
      schemaVersion: 1 as const,
      // Remote host generation: it must not be compared with this guest's
      // local controller room generation.
      roomGeneration: 73,
      sessionId: 'deferred-guest-session',
      connectionId: 'deferred-guest-connection',
      timeline: setup.controller().timelineSnapshot(),
    });

    controllerInput.onHostReady(hostReady);
    controllerInput.onTimelineAdopted(timelineAdopted);
    controllerInput.onTimelineUpdated(timelineUpdated);
    expect(routers[0]?.notifyHostReady).not.toHaveBeenCalled();
    expect(routers[0]?.notifyTimelineAdopted).not.toHaveBeenCalled();
    expect(routers[0]?.notifyTimelineUpdated).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(routers[0]?.notifyHostReady).toHaveBeenCalledWith(hostReady);
    expect(routers[0]?.notifyTimelineAdopted).toHaveBeenCalledWith(timelineAdopted);
    expect(routers[0]?.notifyTimelineUpdated).toHaveBeenCalledWith(timelineUpdated);

    controllerInput.onHostReady(hostReady);
    controllerInput.onTimelineAdopted(timelineAdopted);
    controllerInput.onTimelineUpdated(timelineUpdated);
    setup.runtime.beginGuestRoom();
    await Promise.resolve();
    expect(routers[0]?.notifyHostReady).toHaveBeenCalledTimes(1);
    expect(routers[0]?.notifyTimelineAdopted).toHaveBeenCalledTimes(1);
    expect(routers[0]?.notifyTimelineUpdated).toHaveBeenCalledTimes(1);
    setup.runtime.endRoom();
  });

  it('wires the exact active host room, shared publisher, health callback, and failed-notification close', async () => {
    const routers: ProductRouterHarness[] = [];
    let publisher: FilePlaybackR2WholeBlobPublisher | null = null;
    let hostOwnerOptions: Readonly<FilePlaybackProductHostMediaOwnerOptions> | null = null;
    const onHealthSystemMessage = vi.fn();
    const hostOwner = Object.freeze({
      onHostReady: vi.fn(),
      adoptWireMessage: vi.fn(),
      adoptPeerRangeControl: vi.fn(),
      revoke: vi.fn(),
      publishCurrent: vi.fn(),
      publishPrepared: vi.fn(),
      whenPreparedRemoteReady: vi.fn(),
      activatePrepared: vi.fn(),
      retirePrepared: vi.fn(),
    });
    const setup = harness({
      onHealthSystemMessage,
      mediaFactoriesForTests: {
        createSessionRouter: (options) => {
          const candidate = productRouterHarness(options);
          routers.push(candidate);
          return candidate.port;
        },
        createHostPublisher: (roomToken) => {
          publisher = new FilePlaybackR2WholeBlobPublisher({ roomToken });
          vi.spyOn(publisher, 'close');
          return publisher;
        },
        createHostMediaOwner: (options) => {
          hostOwnerOptions = options;
          return hostOwner;
        },
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('product-media-host');
    const peer = connection();
    const context = routerContext('host', { connection: peer, suffix: 'host-wiring' });

    const wrappedOwner = routers[0]!.options.createHostMediaOwner(context);
    expect(hostOwnerOptions?.context).toBe(context);
    expect(hostOwnerOptions?.hostRoom).toBe(setup.hostRooms[0]?.port);
    expect(hostOwnerOptions?.publisher).toBe(publisher);
    expect(wrappedOwner).not.toBe(hostOwner);
    expect(hostOwnerOptions?.sendRequired(peer, freezeCanonical({ type: 'fixture' }))).toBe(true);
    expect(setup.sessions.sendRequired).toHaveBeenCalledWith(peer, { type: 'fixture' });

    const healthMessage = freezeCanonical({
      schemaVersion: 1 as const,
      participantId: context.guestParticipantId,
      messageKey: 'participant-connection-unstable-recovering' as const,
    });
    hostOwnerOptions?.onHealthSystemMessage(healthMessage);
    expect(onHealthSystemMessage).toHaveBeenCalledWith(healthMessage);

    routers[0]!.notifyHostReady.mockImplementationOnce(() => {
      wrappedOwner.revoke(context);
      throw new Error('deferred host notification failed');
    });
    const controllerInput = setup.createController.mock
      .calls[0]?.[0] as Readonly<FilePlaybackProductRuntimeControllerFactoryInput>;
    controllerInput.onHostReady(
      freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: setup.controller().snapshot().roomGeneration,
        epoch: 1,
        role: 'host' as const,
        sessionId: context.sessionId,
        connectionId: context.connectionId,
        baselineStatus: 'ready' as const,
        baselineId: 'failed-host-notification',
        playbackRevision: 0,
        clockReady: true,
        ready: true,
      }),
    );
    expect(setup.sessions.closeConnection).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(setup.sessions.closeConnection).toHaveBeenCalledWith(peer);

    setup.runtime.endRoom();
    expect(routers[0]?.close).not.toHaveBeenCalled();
    expect(publisher?.close).toHaveBeenCalledOnce();
  });

  it('publishes ready host owners into one prepared cohort and activates canonical truth', async () => {
    const routers: ProductRouterHarness[] = [];
    let ownerOptions: Readonly<FilePlaybackProductHostMediaOwnerOptions> | null = null;
    const blob = localFile('cohort.flac');
    const capability = freezeCanonical({
      participant: freezeCanonical({ participantId: 'runtime-ready-guest' }),
      bindAttempt: vi.fn(async () => undefined),
    }) as unknown as Readonly<HostPreparedRemoteParticipant>;
    const publishPrepared = vi.fn(async (prepared: Readonly<HostPreparedLocalTrack>) => {
      const resolver = ownerOptions?.resolvePreparedPeerRangeSource;
      if (!resolver) throw new Error('prepared resolver unavailable');
      const source = await resolver({
        prepared,
        sourceIdentity: prepared.asset.binding.sourceIdentity,
        signal: new AbortController().signal,
      });
      expect(source).toBe(blob);
      return freezeCanonical({ schemaVersion: 1, prepared }) as never;
    });
    const whenPreparedRemoteReady = vi.fn(async () => capability);
    const activatePrepared = vi.fn(() => freezeCanonical({ schemaVersion: 1 }) as never);
    const hostOwner = Object.freeze({
      onHostReady: vi.fn(),
      adoptWireMessage: vi.fn(),
      adoptPeerRangeControl: vi.fn(),
      revoke: vi.fn(),
      publishCurrent: vi.fn(async () => freezeCanonical({ schemaVersion: 1 }) as never),
      publishPrepared,
      whenPreparedRemoteReady,
      activatePrepared,
      retirePrepared: vi.fn(async () => undefined),
    });
    const setup = harness({
      mediaFactoriesForTests: {
        createSessionRouter: (options) => {
          const candidate = productRouterHarness(options);
          routers.push(candidate);
          return candidate.port;
        },
        createHostMediaOwner: (options) => {
          ownerOptions = options;
          return hostOwner;
        },
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('cohort-runtime-host');
    const context = routerContext('host', { suffix: 'cohort-runtime' });
    routers[0]!.options.createHostMediaOwner(context);
    const room = setup.hostRooms[0]!;
    const prepared = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: room.options.hostRoomSnapshot.roomGeneration,
      backend: 'streaming-flac' as const,
      state: freezeCanonical({
        queueItemId: Q1,
        runId: 'runtime-cohort-run',
        revision: 1,
      }),
      positionSeconds: 0,
      playbackRate: 1,
      asset: freezeCanonical({
        kind: 'encoded' as const,
        binding: freezeCanonical({
          queueItemId: Q1,
          sourceIdentity: 'runtime-cohort-source',
          transferSessionId: 'runtime-cohort-transfer',
        }),
        metadata: freezeCanonical({ name: blob.name, mime: blob.type }),
        encodedSize: blob.size,
      }),
    }) as unknown as Readonly<HostPreparedLocalTrack>;
    const timeline = freezeCanonical({
      revision: 1,
      phase: 'playing' as const,
      run: freezeCanonical({ queueItemId: Q1, runId: prepared.state.runId }),
      positionSeconds: 0,
      rate: 1,
      anchorMonotonicMs: 8_000,
    }) as Readonly<PlaybackTimelineSnapshot>;
    const resolveSource = vi.fn(async () => blob);
    room.startLocalTrackWithCohort.mockImplementationOnce(async (input) => {
      const remotes = await input.prepareRemoteParticipants(
        freezeCanonical({
          prepared,
          signal: input.signal,
          resolveSource,
        }),
      );
      expect(remotes).toEqual([capability]);
      return freezeCanonical({
        ...candidateResult(
          prepared.roomGeneration,
          room.options.hostRoomSnapshot.applicationSessionId,
          'cohort',
        ),
        timeline,
      }) as Readonly<FilePlaybackProductHostLocalTrackCommit>;
    });

    const committed = await setup.runtime.startLocalTrack({
      queueItemId: Q1,
      file: blob,
      positionSeconds: 0,
      signal: new AbortController().signal,
    });

    expect(committed.timeline).toBe(timeline);
    expect(publishPrepared).toHaveBeenCalledWith(prepared);
    expect(whenPreparedRemoteReady).toHaveBeenCalledWith(prepared);
    expect(resolveSource).toHaveBeenCalledWith(prepared.asset.binding.sourceIdentity);
    expect(activatePrepared).toHaveBeenCalledWith({ prepared, timeline });
  });

  it('wires one guest room registry/manager and fail-closes exact room resources', async () => {
    const routers: ProductRouterHarness[] = [];
    let guestOwnerOptions: Readonly<FilePlaybackProductGuestMediaOwnerOptions> | null = null;
    let registry: FilePlaybackAssetRegistry | null = null;
    let registryRoomToken: object | null = null;
    let registryFatal: ((token: object, error: Error) => void) | null = null;
    const manager = new FilePlaybackManager();
    vi.spyOn(manager, 'clear');
    const guestOwner = Object.freeze({
      onTimelineAdopted: vi.fn(),
      onTimelineUpdated: vi.fn(),
      adoptAuxiliaryMessage: vi.fn(),
      adoptWireMessage: vi.fn(),
      adoptPeerRangeBulk: vi.fn(),
      revoke: vi.fn(),
    });
    const setup = harness({
      mediaFactoriesForTests: {
        createSessionRouter: (options) => {
          const candidate = productRouterHarness(options);
          routers.push(candidate);
          return candidate.port;
        },
        createGuestRegistry: (roomToken, onFatalRoom) => {
          registryRoomToken = roomToken;
          registryFatal = onFatalRoom;
          registry = new FilePlaybackAssetRegistry({ liveRoomToken: roomToken, onFatalRoom });
          vi.spyOn(registry, 'close');
          return registry;
        },
        createGuestManager: () => manager,
        createGuestMediaOwner: (options) => {
          guestOwnerOptions = options;
          return guestOwner;
        },
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginGuestRoom();
    const peer = connection();
    const context = routerContext('guest', { connection: peer, suffix: 'guest-wiring' });

    const wrappedOwner = routers[0]!.options.createGuestMediaOwner(context);
    expect(guestOwnerOptions?.context).toBe(context);
    expect(guestOwnerOptions?.registry).toBe(registry);
    expect(guestOwnerOptions?.manager).toBe(manager);
    expect(guestOwnerOptions?.roomToken).toBe(registryRoomToken);
    expect(wrappedOwner).not.toBe(guestOwner);
    const timelineUpdated = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: 19,
      sessionId: context.sessionId,
      connectionId: context.connectionId,
      timeline: setup.controller().timelineSnapshot(),
    });
    wrappedOwner.onTimelineUpdated?.(timelineUpdated);
    expect(guestOwner.onTimelineUpdated).toHaveBeenCalledWith(timelineUpdated);
    expect(guestOwnerOptions!.maxEncodedSize).toBe(5 * 1024 * 1024 * 1024);
    expect(guestOwnerOptions!.maxEncodedSize).toBeGreaterThan(REMOTE_SHARE_MAX_BYTES);
    const offerToken = Object.freeze({});
    const offers = new FileMediaOfferRegistry({
      liveConnectionToken: offerToken,
      sessionId: context.sessionId,
      connectionId: context.connectionId,
      maxEncodedSize: guestOwnerOptions!.maxEncodedSize,
      nowRoomTimeMs: () => 1_000,
      onFatalConnection: vi.fn(),
    });
    expect(offers.admitQueueItem(offerToken, Q1)).toBe(true);
    expect(
      offers.accept(
        offerToken,
        createPeerRangeFileMediaSourceOfferV2({
          sessionId: context.sessionId,
          connectionId: context.connectionId,
          prepareId: Q2,
          prepareRevision: 1,
          queueItemId: Q1,
          sourceIdentity: 'runtime-large-flac-source',
          transferSessionId: 'runtime-large-flac-transfer',
          handleId: 'runtime-large-flac-handle',
          encodedSize: REMOTE_SHARE_MAX_BYTES + 1,
          name: 'large-orchestra.flac',
          mime: 'audio/flac',
          expiresAtRoomTimeMs: 2_000,
        }),
      ),
    ).toMatchObject({ accepted: true, status: 'accepted' });
    expect(guestOwnerOptions?.sendRequired(context, freezeCanonical({ type: 'guest-frame' }))).toBe(
      true,
    );
    expect(setup.sessions.sendRequired).toHaveBeenCalledWith(peer, { type: 'guest-frame' });
    expect(
      guestOwnerOptions?.sendRequired(
        routerContext('guest', { suffix: 'foreign' }),
        freezeCanonical({ type: 'foreign-frame' }),
      ),
    ).toBe(false);

    guestOwnerOptions?.onFatalConnection(
      context,
      new Error('guest media fatal') as Parameters<
        FilePlaybackProductGuestMediaOwnerOptions['onFatalConnection']
      >[1],
    );
    expect(setup.sessions.closeConnection).toHaveBeenCalledWith(peer);

    Reflect.apply(registryFatal!, undefined, [registryRoomToken!, new Error('registry fatal')]);
    await Promise.resolve();

    expect(setup.endRoom).toHaveBeenCalledOnce();
    expect(routers[0]?.close).not.toHaveBeenCalled();
    expect(manager.clear).toHaveBeenCalledOnce();
    expect(registry?.close).toHaveBeenCalledWith(registryRoomToken);
  });

  it('reuses its one-shot document router across consecutive room generations', () => {
    const routers: ProductRouterHarness[] = [];
    const setup = harness({
      mediaFactoriesForTests: {
        createSessionRouter: (options) => {
          const candidate = productRouterHarness(options);
          routers.push(candidate);
          return candidate.port;
        },
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('router-generation-host');
    setup.runtime.endRoom();
    setup.runtime.beginGuestRoom();

    expect(routers).toHaveLength(1);
    expect(routers[0]?.close).not.toHaveBeenCalled();
    expect(setup.installHooks).toHaveBeenCalledOnce();
  });

  it('makes an initialization failure permanent and never falls back at runtime', () => {
    const failure = new Error('hook installation failed');
    const setup = harness({ installFailure: failure });

    expect(() => setup.runtime.initializeBeforeProtocol()).toThrow(failure);
    expect(() => setup.runtime.initializeBeforeProtocol()).toThrow(failure);
    expect(() => setup.runtime.controller()).toThrow(failure);
    expect(() => setup.runtime.beginHostRoom('host-after-failure')).toThrow(failure);
    expect(setup.runtime.enabled()).toBe(true);
    expect(setup.runtime.hostRoomSnapshot()).toBeNull();
    expect(setup.runtime.handleWake()).toBe(false);
    expect(setup.createController).toHaveBeenCalledOnce();
    expect(setup.installHooks).toHaveBeenCalledOnce();
    expect(setup.beginHostRoom).not.toHaveBeenCalled();
  });

  it('rejects room entry and controller access before selected V2 initialization', () => {
    const setup = harness();

    expect(() => setup.runtime.controller()).toThrow(/not initialized before protocol/u);
    expect(() => setup.runtime.beginHostRoom('host-too-early')).toThrow(
      /not initialized before protocol/u,
    );
    expect(() => setup.runtime.beginGuestRoom()).toThrow(/not initialized before protocol/u);
    expect(() => setup.runtime.endRoom()).toThrow(/not initialized before protocol/u);
    expect(setup.runtime.handleWake()).toBe(false);
    expect(setup.beginHostRoom).not.toHaveBeenCalled();
  });

  it('begins a host manager first, then anchors revision zero and claims host authority', () => {
    const setup = harness({ roomNow: 8_765 });
    setup.runtime.initializeBeforeProtocol();
    setup.events.length = 0;

    expect(setup.runtime.beginHostRoom('host-1')).toBe(true);

    expect(setup.beginHostRoom).toHaveBeenCalledWith('host-1');
    expect(setup.events).toEqual([
      'sessions:begin-host',
      'clock:room-now',
      'controller:begin-room',
      'controller:claim-host',
      'host-room:create',
    ]);
    expect(lastBeganTimeline(setup)).toMatchObject({
      revision: 0,
      phase: 'stopped',
      anchorMonotonicMs: 8_765,
    });
    expect(setup.controller().snapshot().roomRole).toBe('host');
    const hostRoom = setup.runtime.hostRoomSnapshot();
    expect(hostRoom).toEqual({
      schemaVersion: 1,
      roomGeneration: setup.controller().snapshot().roomGeneration,
      applicationSessionId: `product-runtime-session-${harnessSequence}-1`,
      hostParticipantId: 'host-1',
    });
    expect(Object.isFrozen(hostRoom)).toBe(true);
    expect(Reflect.ownKeys(hostRoom ?? {})).toEqual([
      'schemaVersion',
      'roomGeneration',
      'applicationSessionId',
      'hostParticipantId',
    ]);
    expect(setup.createHostRoom).toHaveBeenCalledOnce();
    expect(setup.hostRooms[0]?.options.controller).toBe(setup.controller());
    expect(setup.hostRooms[0]?.options.hostRoomSnapshot).toBe(hostRoom);
    expect(() => setup.runtime.beginHostRoom('reconnect-must-not-begin-a-room')).toThrow(
      /already owns an active room/u,
    );
    expect(setup.beginHostRoom).toHaveBeenCalledOnce();
  });

  it.each([
    ['ordinary', 'audio-buffer'],
    ['streaming FLAC', 'streaming-flac'],
  ] as const)(
    'returns the exact active %s terminal observation without weakening normal projection',
    (_label, backend) => {
      const setup = harness();
      setup.runtime.initializeBeforeProtocol();
      setup.runtime.beginHostRoom(`terminal-${backend}`);
      const observation = commitHostPlayingForTerminalObservation(setup, { backend });
      const room = setup.hostRooms[0];
      room?.setTerminalObservation(observation);

      expect(setup.runtime.currentHostRendererSnapshot()).toBeNull();
      expect(setup.runtime.currentHostTerminalRendererObservation()).toBe(observation);
      expect(room?.currentTerminalRendererObservation).toHaveBeenCalledOnce();
    },
  );

  it.each(['phase', 'queueItemId', 'runId', 'revision'] as const)(
    'rejects a terminal port observation with a mismatched %s',
    (kind) => {
      const setup = harness();
      setup.runtime.initializeBeforeProtocol();
      setup.runtime.beginHostRoom(`terminal-mismatch-${kind}`);
      const exact = commitHostPlayingForTerminalObservation(setup);
      let invalid: unknown;
      if (kind === 'phase') {
        invalid = freezeCanonical({ ...exact, phase: 'playing' as const });
      } else if (kind === 'queueItemId') {
        invalid = freezeCanonical({
          ...exact,
          queueItemId: Q2,
          run: freezeCanonical({ ...exact.run, queueItemId: Q2 }),
        });
      } else if (kind === 'runId') {
        invalid = freezeCanonical({
          ...exact,
          run: freezeCanonical({ ...exact.run, runId: `${exact.run.runId}-stale-aba` }),
        });
      } else {
        invalid = freezeCanonical({
          ...exact,
          revision: exact.revision + 1,
          run: freezeCanonical({ ...exact.run, revision: exact.run.revision + 1 }),
        });
      }
      setup.hostRooms[0]?.setTerminalObservation(
        invalid as FilePlaybackProductHostTerminalObservation,
      );

      expect(setup.runtime.currentHostTerminalRendererObservation()).toBeNull();
    },
  );

  it('rejects a terminal observation when its exact port retires during the read', () => {
    const setup = harness();
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('terminal-old-host');
    const observation = commitHostPlayingForTerminalObservation(setup);
    const oldRoom = setup.hostRooms[0];
    oldRoom?.currentTerminalRendererObservation.mockImplementationOnce(() => {
      setup.runtime.endRoom();
      setup.runtime.beginHostRoom('terminal-new-host');
      return observation;
    });

    expect(setup.runtime.currentHostTerminalRendererObservation()).toBeNull();
    expect(setup.runtime.hostRoomSnapshot()?.hostParticipantId).toBe('terminal-new-host');
  });

  it('fail-closes terminal reads from a throwing or fatally retired exact port', () => {
    const throwing = harness();
    throwing.runtime.initializeBeforeProtocol();
    throwing.runtime.beginHostRoom('terminal-throwing-host');
    commitHostPlayingForTerminalObservation(throwing);
    throwing.hostRooms[0]?.currentTerminalRendererObservation.mockImplementationOnce(() => {
      throw new Error('terminal observation failed');
    });
    expect(throwing.runtime.currentHostTerminalRendererObservation()).toBeNull();

    const fatal = harness();
    fatal.runtime.initializeBeforeProtocol();
    fatal.runtime.beginHostRoom('terminal-fatal-host');
    const observation = commitHostPlayingForTerminalObservation(fatal);
    fatal.hostRooms[0]?.setTerminalObservation(observation);
    expect(fatal.runtime.currentHostTerminalRendererObservation()).toBe(observation);
    fatal.hostRooms[0]?.fatal(new Error('terminal host fatal'));
    expect(fatal.runtime.currentHostTerminalRendererObservation()).toBeNull();
  });

  it('begins a guest generation from the safe zero anchor without starting a guest connection', () => {
    const setup = harness({ monotonicNow: 9_876 });
    setup.runtime.initializeBeforeProtocol();
    setup.events.length = 0;

    expect(setup.runtime.beginGuestRoom()).toBe(true);

    expect(setup.events).toEqual(['controller:begin-room', 'controller:claim-guest']);
    expect(lastBeganTimeline(setup)).toMatchObject({
      revision: 0,
      phase: 'stopped',
      anchorMonotonicMs: 0,
    });
    expect(setup.beginHostRoom).not.toHaveBeenCalled();
    expect(setup.controller().snapshot().roomRole).toBe('guest');
    expect(setup.runtime.hostRoomSnapshot()).toBeNull();
    expect(setup.runtime.currentHostTerminalRendererObservation()).toBeNull();
    expect(setup.createHostRoom).not.toHaveBeenCalled();
  });

  it('rejects every host transport operation in a guest room', async () => {
    const setup = harness();
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginGuestRoom();
    const signal = new AbortController().signal;
    const attempts = [
      setup.runtime.startHostFirstLocalFile({ queueItemId: Q1, file: localFile(), signal }),
      setup.runtime.startLocalTrack({
        queueItemId: Q1,
        file: localFile(),
        positionSeconds: 0,
        signal,
      }),
      setup.runtime.pauseCurrent({ signal }),
      setup.runtime.seekPlaying({ positionSeconds: 1, signal }),
      setup.runtime.seekPaused({ positionSeconds: 1, signal }),
      setup.runtime.resumeCurrent({ signal }),
      setup.runtime.replayCurrent({ signal }),
      setup.runtime.stopCurrent({ signal }),
      setup.runtime.settleEndedCurrent({ signal }),
    ];

    const results = await Promise.allSettled(attempts);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(setup.createHostRoom).not.toHaveBeenCalled();
  });

  it.each(['seekPlaying', 'currentTerminalRendererObservation'] as const)(
    'fails host entry when the expanded structural room port omits %s',
    (method) => {
      const setup = harness({ omitHostRoomMethod: method });
      setup.runtime.initializeBeforeProtocol();

      expect(() => setup.runtime.beginHostRoom('incomplete-port-host')).toThrow(
        /host room factory is invalid/u,
      );

      expect(setup.hostRooms[0]?.close).toHaveBeenCalledOnce();
      expect(setup.runtime.hostRoomSnapshot()).toBeNull();
      expect(setup.controller().snapshot().roomRole).toBeNull();
    },
  );

  it('routes the complete transport surface through one exact stable host-room port', async () => {
    const setup = harness();
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('transport-host');
    const signal = new AbortController().signal;
    const first = { queueItemId: Q1, file: localFile('first.mp3'), signal };
    const replacement = {
      queueItemId: Q2,
      file: localFile('replacement.flac'),
      positionSeconds: 3,
      signal,
    };
    const current = { signal };
    const seek = { positionSeconds: 24, signal };

    const results = [
      await setup.runtime.startHostFirstLocalFile(first),
      await setup.runtime.startLocalTrack(replacement),
      await setup.runtime.pauseCurrent(current),
      await setup.runtime.seekPaused(seek),
      await setup.runtime.resumeCurrent(current),
      await setup.runtime.seekPlaying(seek),
      await setup.runtime.replayCurrent(current),
      await setup.runtime.stopCurrent(current),
      await setup.runtime.settleEndedCurrent(current),
    ];

    const room = setup.hostRooms[0];
    expect(setup.createHostRoom).toHaveBeenCalledOnce();
    expect(room?.startFirstLocalFile).not.toHaveBeenCalled();
    expect(room?.startLocalTrack).not.toHaveBeenCalled();
    expect(room?.startLocalTrackWithCohort).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ ...first, positionSeconds: 0 }),
    );
    expect(room?.startLocalTrackWithCohort).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining(replacement),
    );
    expect(room?.pauseCurrent).toHaveBeenCalledWith(current);
    expect(room?.seekPaused).toHaveBeenCalledWith(seek);
    expect(room?.resumeCurrent).toHaveBeenCalledWith(current);
    expect(room?.seekPlaying).toHaveBeenCalledWith(seek);
    expect(room?.replayCurrent).toHaveBeenCalledWith(current);
    expect(room?.stopCurrent).toHaveBeenCalledWith(current);
    expect(room?.settleEndedCurrent).toHaveBeenCalledWith(current);
    expect(results.every((result) => Object.isFrozen(result))).toBe(true);
    expect(results.some((result) => containsBody(result))).toBe(false);
  });

  it('never dispatches any captured operation after the exact room retires', async () => {
    const oldCleanup = deferred<void>();
    const setup = harness({ hostRoomClosePlans: [{ gate: oldCleanup }, {}] });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('old-host');
    setup.runtime.endRoom();
    setup.runtime.beginHostRoom('captured-host');
    const signal = new AbortController().signal;
    const room = setup.hostRooms[1];
    const pending = [
      setup.runtime.startHostFirstLocalFile({ queueItemId: Q1, file: localFile(), signal }),
      setup.runtime.startLocalTrack({
        queueItemId: Q2,
        file: localFile('two.mp3'),
        positionSeconds: 0,
        signal,
      }),
      setup.runtime.pauseCurrent({ signal }),
      setup.runtime.seekPlaying({ positionSeconds: 1, signal }),
      setup.runtime.seekPaused({ positionSeconds: 2, signal }),
      setup.runtime.resumeCurrent({ signal }),
      setup.runtime.replayCurrent({ signal }),
      setup.runtime.stopCurrent({ signal }),
      setup.runtime.settleEndedCurrent({ signal }),
    ];
    await Promise.resolve();
    setup.runtime.endRoom();
    oldCleanup.resolve();

    const settlements = await Promise.allSettled(pending);
    expect(settlements.every((settlement) => settlement.status === 'rejected')).toBe(true);
    expect(room?.startFirstLocalFile).not.toHaveBeenCalled();
    expect(room?.startLocalTrackWithCohort).not.toHaveBeenCalled();
    expect(room?.pauseCurrent).not.toHaveBeenCalled();
    expect(room?.seekPlaying).not.toHaveBeenCalled();
    expect(room?.seekPaused).not.toHaveBeenCalled();
    expect(room?.resumeCurrent).not.toHaveBeenCalled();
    expect(room?.replayCurrent).not.toHaveBeenCalled();
    expect(room?.stopCurrent).not.toHaveBeenCalled();
    expect(room?.settleEndedCurrent).not.toHaveBeenCalled();
  });

  it('keeps a dispatched commit-dominant task while endRoom fences its port immediately', async () => {
    const gate = deferred<Readonly<FilePlaybackProductHostLocalTrackCommit>>();
    const setup = harness();
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('commit-dominant-host');
    const room = setup.hostRooms[0];
    room?.startLocalTrackWithCohort.mockImplementationOnce(async () => gate.promise);
    const task = setup.runtime.startLocalTrack({
      queueItemId: Q1,
      file: localFile(),
      positionSeconds: 0,
      signal: new AbortController().signal,
    });
    await Promise.resolve();

    setup.runtime.endRoom();

    expect(room?.startLocalTrackWithCohort).toHaveBeenCalledOnce();
    expect(room?.close).toHaveBeenCalledOnce();
    const committed = candidateResult(
      room?.options.hostRoomSnapshot.roomGeneration ?? 1,
      room?.options.hostRoomSnapshot.applicationSessionId ?? 'fixture-session',
      'commit-dominant',
    );
    gate.resolve(committed);
    await expect(task).resolves.toBe(committed);
    expect(setup.runtime.hostRoomSnapshot()).toBeNull();
  });

  it('drops a captured operation when an exact fatal retires the room before dispatch', async () => {
    const setup = harness();
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('fatal-race-host');
    const room = setup.hostRooms[0];

    const pending = setup.runtime.pauseCurrent({ signal: new AbortController().signal });
    room?.fatal(new Error('exact host renderer fatal'));

    await expect(pending).rejects.toThrow(/host room changed/u);
    expect(room?.pauseCurrent).not.toHaveBeenCalled();
    expect(room?.close).toHaveBeenCalledOnce();
    expect(setup.runtime.hostRoomSnapshot()).toBeNull();
  });

  it('fences the host renderer before session and controller teardown', () => {
    const setup = harness();
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('ordered-host');
    setup.events.length = 0;

    setup.runtime.endRoom();

    const closeIndex = setup.events.indexOf('host-room:1:close');
    const sessionIndex = setup.events.indexOf('sessions:end-room');
    const controllerIndex = setup.events.indexOf('controller:begin-room');
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeLessThan(sessionIndex);
    expect(sessionIndex).toBeLessThan(controllerIndex);
    expect(setup.hostRooms[0]?.close).toHaveBeenCalledOnce();
    expect(setup.runtime.currentHostRendererSnapshot()).toBeNull();
    expect(setup.runtime.currentHostTerminalRendererObservation()).toBeNull();
    expect(setup.runtime.hostPositionAt(1_000)).toBeNull();
  });

  it('waits for the previous native renderer cleanup before starting media in a new room', async () => {
    const cleanupGate = deferred<void>();
    const setup = harness({ hostRoomClosePlans: [{ gate: cleanupGate }, {}] });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('host-a');
    setup.runtime.endRoom();
    setup.runtime.beginHostRoom('host-b');

    const startPromise = setup.runtime.startHostFirstLocalFile({
      queueItemId: Q1,
      file: localFile(),
      signal: new AbortController().signal,
    });
    await Promise.resolve();

    expect(setup.hostRooms[1]?.startLocalTrackWithCohort).not.toHaveBeenCalled();
    cleanupGate.resolve();
    await expect(startPromise).resolves.toMatchObject({ status: 'committed' });
    expect(setup.hostRooms[1]?.startLocalTrackWithCohort).toHaveBeenCalledOnce();
  });

  it('fail-closes the new room when an older native renderer cleanup failed', async () => {
    const cleanupFailure = new Error('old native renderer cleanup failed');
    const setup = harness({ hostRoomClosePlans: [{ failure: cleanupFailure }, {}] });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('host-a');
    setup.runtime.endRoom();
    setup.runtime.beginHostRoom('host-b');

    await expect(
      setup.runtime.startHostFirstLocalFile({
        queueItemId: Q1,
        file: localFile(),
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(cleanupFailure);

    expect(setup.hostRooms[1]?.startLocalTrackWithCohort).not.toHaveBeenCalled();
    expect(setup.hostRooms[1]?.close).toHaveBeenCalledOnce();
    expect(setup.runtime.hostRoomSnapshot()).toBeNull();
    expect(setup.controller().snapshot().roomRole).toBeNull();
  });

  it('ignores a stale host-room fatal callback but retires the exact active room', () => {
    const setup = harness();
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('host-a');
    setup.runtime.endRoom();
    setup.runtime.beginHostRoom('host-b');
    const active = setup.runtime.hostRoomSnapshot();

    setup.hostRooms[0]?.fatal(new Error('stale fatal'));
    expect(setup.runtime.hostRoomSnapshot()).toBe(active);

    setup.hostRooms[1]?.fatal(new Error('active fatal'));
    expect(setup.runtime.hostRoomSnapshot()).toBeNull();
    expect(setup.controller().snapshot().roomRole).toBeNull();
    expect(setup.endRoom).toHaveBeenCalledTimes(2);
  });

  it('ends the manager before advancing a stopped revision-zero continuation fence', () => {
    const setup = harness({ monotonicNow: 1_111 });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginGuestRoom();
    const activeGeneration = setup.controller().snapshot().roomGeneration;
    setup.events.length = 0;

    setup.runtime.endRoom();

    expect(setup.events).toEqual(['sessions:end-room', 'controller:begin-room']);
    expect(lastBeganTimeline(setup)).toMatchObject({
      revision: 0,
      phase: 'stopped',
      anchorMonotonicMs: 0,
    });
    expect(setup.controller().snapshot()).toMatchObject({
      roomGeneration: activeGeneration + 1,
      roomRole: null,
      activeConnectionCount: 0,
    });

    setup.runtime.endRoom();
    expect(setup.endRoom).toHaveBeenCalledOnce();
    expect(setup.controller().snapshot().roomGeneration).toBe(activeGeneration + 1);
  });

  it('still fences the controller and retires the room when manager teardown throws', () => {
    const failure = new Error('manager teardown failed');
    const setup = harness({ endFailure: failure });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginGuestRoom();
    const activeGeneration = setup.controller().snapshot().roomGeneration;
    setup.events.length = 0;

    expect(() => setup.runtime.endRoom()).toThrow(failure);

    expect(setup.events).toEqual(['sessions:end-room', 'controller:begin-room']);
    expect(setup.controller().snapshot()).toMatchObject({
      roomGeneration: activeGeneration + 1,
      roomRole: null,
      timeline: {
        revision: 0,
        phase: 'stopped',
        anchorMonotonicMs: 0,
      },
    });
    setup.runtime.endRoom();
    expect(setup.endRoom).toHaveBeenCalledOnce();
  });

  it('delegates wake only after selected V2 initialization and preserves the connection', () => {
    const setup = harness();
    const peer = connection();

    expect(setup.runtime.handleWake(peer)).toBe(false);
    setup.runtime.initializeBeforeProtocol();
    expect(setup.runtime.handleWake(peer)).toBe(true);
    expect(setup.handleWake).toHaveBeenCalledOnce();
    expect(setup.handleWake).toHaveBeenCalledWith(peer);
  });

  it('fail-closes the manager when host room clock setup fails, without changing the gate', () => {
    const setup = harness({ roomNow: Number.NaN });
    setup.runtime.initializeBeforeProtocol();
    const initialGeneration = setup.controller().snapshot().roomGeneration;
    setup.events.length = 0;

    expect(() => setup.runtime.beginHostRoom('host-invalid-clock')).toThrow(
      /finite non-negative monotonic time/u,
    );
    expect(setup.events).toEqual([
      'sessions:begin-host',
      'clock:room-now',
      'sessions:end-room',
      'controller:begin-room',
    ]);
    expect(setup.controller().snapshot()).toMatchObject({
      roomGeneration: initialGeneration + 1,
      roomRole: null,
      timeline: {
        revision: 0,
        phase: 'stopped',
        anchorMonotonicMs: 0,
      },
    });
    expect(setup.runtime.enabled()).toBe(true);
    expect(setup.runtime.hostRoomSnapshot()).toBeNull();

    setup.setRoomNow(5_000);
    setup.events.length = 0;
    expect(setup.runtime.beginHostRoom('host-retry-v2')).toBe(true);
    expect(setup.events).toEqual([
      'sessions:begin-host',
      'clock:room-now',
      'controller:begin-room',
      'controller:claim-host',
      'host-room:create',
    ]);
  });

  it('fences a partially advanced controller generation after host start fails', () => {
    const failure = new Error('controller role claim failed');
    const setup = harness();
    setup.runtime.initializeBeforeProtocol();
    const initialGeneration = setup.controller().snapshot().roomGeneration;
    vi.mocked(setup.controller().claimRoomRole).mockImplementationOnce(() => {
      setup.events.push('controller:claim-host');
      throw failure;
    });
    setup.events.length = 0;

    expect(() => setup.runtime.beginHostRoom('host-controller-failure')).toThrow(failure);

    expect(setup.events).toEqual([
      'sessions:begin-host',
      'clock:room-now',
      'controller:begin-room',
      'controller:claim-host',
      'sessions:end-room',
      'controller:begin-room',
    ]);
    expect(setup.controller().snapshot()).toMatchObject({
      roomGeneration: initialGeneration + 2,
      roomRole: null,
      timeline: {
        revision: 0,
        phase: 'stopped',
        anchorMonotonicMs: 0,
      },
    });
    expect(setup.runtime.enabled()).toBe(true);
    expect(setup.runtime.hostRoomSnapshot()).toBeNull();
  });

  it('rejects non-canonical adapter authority without invoking getters or retaining identity', () => {
    const setup = harness();
    setup.runtime.initializeBeforeProtocol();
    let getterReads = 0;
    const malformed = {
      applicationSessionId: 'adapter-session',
      hostParticipantId: 'malformed-host',
    } as Record<string, unknown>;
    Object.defineProperty(malformed, 'hostParticipantId', {
      enumerable: true,
      get() {
        getterReads += 1;
        return 'malformed-host';
      },
    });
    setup.beginHostRoom.mockImplementationOnce(() => {
      setup.events.push('sessions:begin-host');
      return malformed as unknown as Readonly<FilePlaybackHostApplicationSessionAuthority>;
    });
    setup.events.length = 0;

    expect(() => setup.runtime.beginHostRoom('malformed-host')).toThrow(
      'Host application-session authority is invalid',
    );
    expect(getterReads).toBe(0);
    expect(setup.runtime.hostRoomSnapshot()).toBeNull();
    expect(setup.events).toEqual([
      'sessions:begin-host',
      'sessions:end-room',
      'controller:begin-room',
    ]);

    setup.beginHostRoom.mockImplementationOnce(() => {
      setup.events.push('sessions:begin-host');
      return Object.freeze({
        applicationSessionId: 'adapter-session-2',
        hostParticipantId: 'different-host',
      });
    });
    setup.events.length = 0;
    expect(() => setup.runtime.beginHostRoom('expected-host')).toThrow(
      'Host application-session authority is invalid',
    );
    expect(setup.runtime.hostRoomSnapshot()).toBeNull();
  });

  it('clears host identity before teardown callbacks and never leaks it across ABA rooms', () => {
    const setup = harness();
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('host-a');
    const first = setup.runtime.hostRoomSnapshot();
    let observedDuringEnd: unknown = 'not-called';
    setup.endRoom.mockImplementationOnce(() => {
      setup.events.push('sessions:end-room');
      observedDuringEnd = setup.runtime.hostRoomSnapshot();
    });

    setup.runtime.endRoom();

    expect(observedDuringEnd).toBeNull();
    expect(setup.runtime.hostRoomSnapshot()).toBeNull();
    expect(first).not.toBeNull();

    setup.runtime.beginHostRoom('host-b');
    const second = setup.runtime.hostRoomSnapshot();
    expect(second).not.toBe(first);
    expect(second?.applicationSessionId).not.toBe(first?.applicationSessionId);
    expect(second?.hostParticipantId).toBe('host-b');
    expect(second?.roomGeneration).toBeGreaterThan(first?.roomGeneration ?? 0);
  });

  it('does not advance the room generation for wake or host transport reconnect work', () => {
    const setup = harness();
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('stable-host-room');
    const roomGeneration = setup.controller().snapshot().roomGeneration;

    setup.runtime.handleWake();

    expect(setup.controller().snapshot().roomGeneration).toBe(roomGeneration);
    expect(setup.beginHostRoom).toHaveBeenCalledOnce();
  });
});
