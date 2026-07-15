import { describe, expect, it, vi } from 'vitest';

import { REMOTE_SHARE_MAX_BYTES } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import type {
  FilePlaybackApplicationSessionHooks,
  FilePlaybackHostApplicationSessionAuthority,
} from '../../network/file-playback-application-session.ts';
import type { DataConnection, QueueItemId } from '../../types/index.ts';
import {
  FilePlaybackApplicationController,
  type FilePlaybackApplicationControllerConnectionSnapshot,
} from '../file-playback-application-controller.ts';
import { FilePlaybackAssetRegistry } from '../file-playback-asset-registry.ts';
import {
  FILE_PLAYBACK_MP3_M4A_V1_BOUNDED_ROUTE_POLICY,
  type FilePlaybackBoundedRoutePolicy,
} from '../file-playback-bounded-route-policy.ts';
import {
  createPeerRangeFileMediaSourceOfferV2,
  FileMediaOfferRegistry,
} from '../file-media-source-offer.ts';
import { FilePlaybackManager } from '../file-playback-manager.ts';
import type {
  HostLocalTrackSourceLease,
  HostPreparedLocalTrack,
  HostPreparedRemoteParticipant,
  HostPeerPlaybackPublication,
  HostPeerRangeManifestPublication,
  HostPeerRangeSource,
} from '../file-playback-host-first-file-engine.ts';
import { FilePlaybackProductBaselineIdIssuer } from '../file-playback-product-baseline-session.ts';
import type { FilePlaybackProductGuestMediaOwnerOptions } from '../file-playback-product-guest-media-owner.ts';
import {
  FILE_PLAYBACK_PRODUCT_OFFER_LIFETIME_MS,
  FILE_PLAYBACK_PRODUCT_PEER_RANGE_BUFFERED_AMOUNT_LIMIT,
  type FilePlaybackProductHostMediaOwnerOptions,
} from '../file-playback-product-host-media-owner.ts';
import { getFilePlaybackUniversalLifecycleSnapshotForTests } from '../diagnostics/file-playback-universal-lifecycle-diagnostics.ts';
import type {
  ClearFilePlaybackProductHostLocalTrackWarmByLeaseOptions,
  ClearFilePlaybackProductHostLocalTrackWarmOptions,
  FilePlaybackProductHostCurrentOptions,
  FilePlaybackProductHostCurrentWithCohortOptions,
  FilePlaybackProductHostFirstLocalFileCommit,
  FilePlaybackProductHostLocalTrackWarmResult,
  FilePlaybackProductHostLocalTrackCommit,
  FilePlaybackProductHostRoomOptions,
  FilePlaybackProductHostSeekOptions,
  FilePlaybackProductHostSeekWithCohortOptions,
  FilePlaybackProductHostTerminalObservation,
  FilePlaybackProductHostTransitionCommit,
  StartFilePlaybackProductHostFirstLocalFileOptions,
  StartFilePlaybackProductHostLocalTrackWithCohortOptions,
  StartFilePlaybackProductHostLocalTrackOptions,
  WarmFilePlaybackProductHostLocalTrackOptions,
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
  readonly warmLocalTrack: ReturnType<typeof vi.fn>;
  readonly clearWarmLocalTrack: ReturnType<typeof vi.fn>;
  readonly clearWarmLocalTrackByLease: ReturnType<typeof vi.fn>;
  readonly resolveWarmPeerRangeSource: ReturnType<typeof vi.fn>;
  readonly startFirstLocalFile: ReturnType<typeof vi.fn>;
  readonly startLocalTrack: ReturnType<typeof vi.fn>;
  readonly startLocalTrackWithCohort: ReturnType<typeof vi.fn>;
  readonly pauseCurrent: ReturnType<typeof vi.fn>;
  readonly seekPlaying: ReturnType<typeof vi.fn>;
  readonly seekPlayingWithCohort: ReturnType<typeof vi.fn>;
  readonly seekPaused: ReturnType<typeof vi.fn>;
  readonly resumeCurrent: ReturnType<typeof vi.fn>;
  readonly replayCurrent: ReturnType<typeof vi.fn>;
  readonly replayCurrentWithCohort: ReturnType<typeof vi.fn>;
  readonly stopCurrent: ReturnType<typeof vi.fn>;
  readonly settleEndedCurrent: ReturnType<typeof vi.fn>;
  readonly currentTerminalRendererObservation: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  setCurrentPeerPublication(value: Readonly<HostPeerPlaybackPublication> | null): void;
  setTerminalObservation(value: FilePlaybackProductHostTerminalObservation | null): void;
  fatal(error: Error): void;
}

interface HostRoomClosePlan {
  readonly gate?: ReturnType<typeof deferred<void>>;
  readonly failure?: Error;
}

interface RuntimeHarnessOptions {
  readonly enabled?: boolean;
  readonly boundedRoutePolicy?: Readonly<FilePlaybackBoundedRoutePolicy>;
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
    let warmSequence = 0;
    const warmSources = new WeakMap<HostLocalTrackSourceLease, File>();
    const warmLocalTrack = vi.fn(
      async (
        input: WarmFilePlaybackProductHostLocalTrackOptions,
      ): Promise<Readonly<FilePlaybackProductHostLocalTrackWarmResult>> => {
        warmSequence += 1;
        const sourceLease = freezeCanonical({}) as HostLocalTrackSourceLease;
        warmSources.set(sourceLease, input.file);
        return freezeCanonical({
          schemaVersion: 1 as const,
          roomGeneration: roomOptions.hostRoomSnapshot.roomGeneration,
          applicationSessionId: roomOptions.hostRoomSnapshot.applicationSessionId,
          hostParticipantId: roomOptions.hostRoomSnapshot.hostParticipantId,
          status: 'warmed' as const,
          backend: 'bounded-stream' as const,
          asset: freezeCanonical({
            kind: 'blob' as const,
            binding: freezeCanonical({
              queueItemId: input.queueItemId,
              sourceIdentity: `fixture-warm-source-${index}-${warmSequence}`,
              transferSessionId: `fixture-warm-transfer-${index}-${warmSequence}`,
            }),
            metadata: freezeCanonical({
              name: input.file.name,
              mime: input.file.type || 'application/octet-stream',
            }),
            encodedSize: input.file.size,
            peerRangeManifest: null,
          }),
          readiness: freezeCanonical({
            durationSeconds: 120,
            bufferedAheadSeconds: 8,
            outputSampleRateHz: 48_000,
            channelCount: 2,
          }),
          sourceLease,
        });
      },
    );
    const clearWarmLocalTrack = vi.fn(
      async (_input: ClearFilePlaybackProductHostLocalTrackWarmOptions) => true,
    );
    const clearWarmLocalTrackByLease = vi.fn(
      async (_input: ClearFilePlaybackProductHostLocalTrackWarmByLeaseOptions) => true,
    );
    const resolveWarmPeerRangeSource = vi.fn(
      async (input: Readonly<{ sourceLease: HostLocalTrackSourceLease }>) => {
        const source = warmSources.get(input.sourceLease);
        if (!source) throw new Error('fixture warm source lease is stale');
        return source;
      },
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
    const seekPlayingWithCohort = vi.fn(
      async (_input: FilePlaybackProductHostSeekWithCohortOptions) => {
        events.push(`host-room:${index}:seek-playing-cohort`);
        return candidate('seek-playing-cohort');
      },
    );
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
    const replayCurrentWithCohort = vi.fn(
      async (_input: FilePlaybackProductHostCurrentWithCohortOptions) => {
        events.push(`host-room:${index}:replay-cohort`);
        return candidate('replay-cohort');
      },
    );
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
    let peerPublication: Readonly<HostPeerPlaybackPublication> | null = null;
    const currentPeerPublication = vi.fn(() => peerPublication);
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
      warmLocalTrack,
      clearWarmLocalTrack,
      clearWarmLocalTrackByLease,
      resolveWarmPeerRangeSource,
      startFirstLocalFile,
      startLocalTrack,
      startLocalTrackWithCohort,
      pauseCurrent,
      seekPlaying,
      seekPlayingWithCohort,
      seekPaused,
      resumeCurrent,
      replayCurrent,
      replayCurrentWithCohort,
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
      warmLocalTrack,
      clearWarmLocalTrack,
      clearWarmLocalTrackByLease,
      resolveWarmPeerRangeSource,
      startFirstLocalFile,
      startLocalTrack,
      startLocalTrackWithCohort,
      pauseCurrent,
      seekPlaying,
      seekPlayingWithCohort,
      seekPaused,
      resumeCurrent,
      replayCurrent,
      replayCurrentWithCohort,
      stopCurrent,
      settleEndedCurrent,
      currentTerminalRendererObservation,
      close,
      setCurrentPeerPublication: (value) => void (peerPublication = value),
      setTerminalObservation: (value) => void (terminalObservation = value),
      fatal: (error) => roomOptions.onFatalRoom(error),
    };
    hostRooms.push(room);
    return port;
  });
  const runtime = new FilePlaybackProductRuntime({
    enabled: options.enabled ?? true,
    ...(options.boundedRoutePolicy ? { boundedRoutePolicy: options.boundedRoutePolicy } : {}),
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

function hostReadySnapshot(
  setup: RuntimeHarness,
  context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
): Readonly<FilePlaybackApplicationControllerConnectionSnapshot> {
  return freezeCanonical({
    schemaVersion: 1 as const,
    roomGeneration: setup.controller().snapshot().roomGeneration,
    epoch: 1,
    role: 'host' as const,
    sessionId: context.sessionId,
    connectionId: context.connectionId,
    baselineStatus: 'ready' as const,
    baselineId: `runtime-ready-${context.connectionId}`,
    playbackRevision: setup.controller().timelineSnapshot().revision,
    clockReady: true,
    ready: true,
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
    const speculative = {
      queueItemId: Q1,
      file: localFile('gate-off-warm.flac'),
      signal: new AbortController().signal,
    };
    await expect(setup.runtime.warmLocalTrack(speculative)).resolves.toBeNull();
    await expect(
      setup.runtime.warmNextLocalTrack({
        queueItemId: speculative.queueItemId,
        file: speculative.file,
      }),
    ).resolves.toBe(false);
    await expect(setup.runtime.clearNextLocalTrackWarm()).resolves.toBe(false);
    await expect(
      setup.runtime.clearWarmLocalTrack({
        queueItemId: Q1,
        signal: speculative.signal,
      }),
    ).resolves.toBe(false);
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

  it.each([
    ['rejects the current Q2 occurrence', Q2, false, 0],
    ['allows Q2 while Q1 is current', Q1, true, 1],
  ] as const)('%s at next-warm admission', async (_label, currentQueueItemId, expected, calls) => {
    const setup = harness();
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom(`current-warm-admission-${currentQueueItemId}`);
    const room = setup.hostRooms[0]!;
    room.setCurrentPeerPublication(
      freezeCanonical({
        schemaVersion: 1 as const,
        state: freezeCanonical({ queueItemId: currentQueueItemId }),
      }) as unknown as Readonly<HostPeerPlaybackPublication>,
    );
    const file = localFile('current-warm-admission.flac');

    await expect(setup.runtime.warmNextLocalTrack({ queueItemId: Q2, file })).resolves.toBe(
      expected,
    );
    expect(room.warmLocalTrack).toHaveBeenCalledTimes(calls);

    if (expected) await expect(setup.runtime.clearNextLocalTrackWarm()).resolves.toBe(true);
    setup.runtime.endRoom();
  });

  it('rejects Q2 warm admission while a live Q2 prepared cohort is in flight', async () => {
    const setup = harness();
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('prepared-warm-admission-host');
    const room = setup.hostRooms[0]!;
    const file = localFile('prepared-warm-admission.flac');
    const prepared = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: room.options.hostRoomSnapshot.roomGeneration,
      backend: 'bounded-stream' as const,
      state: freezeCanonical({ queueItemId: Q2, runId: 'prepared-admission-run', revision: 1 }),
      positionSeconds: 0,
      playbackRate: 1,
      asset: freezeCanonical({
        kind: 'encoded' as const,
        binding: freezeCanonical({
          queueItemId: Q2,
          sourceIdentity: 'prepared-admission-source',
          transferSessionId: 'prepared-admission-transfer',
        }),
        metadata: freezeCanonical({ name: file.name, mime: file.type }),
        encodedSize: file.size,
        peerRangeManifest: null,
      }),
      sourceLease: null,
    }) as unknown as Readonly<HostPreparedLocalTrack>;
    const timeline = freezeCanonical({
      revision: 1,
      phase: 'playing' as const,
      run: freezeCanonical({ queueItemId: Q2, runId: prepared.state.runId }),
      positionSeconds: 0,
      rate: 1,
      anchorMonotonicMs: 11_000,
    }) as Readonly<PlaybackTimelineSnapshot>;
    const preparedEntered = deferred<void>();
    const commitGate = deferred<Readonly<FilePlaybackProductHostLocalTrackCommit>>();
    room.startLocalTrackWithCohort.mockImplementationOnce(async (input) => {
      await input.prepareRemoteParticipants(
        freezeCanonical({
          prepared,
          signal: input.signal,
          resolveSource: vi.fn(async () => file),
        }),
      );
      preparedEntered.resolve();
      return commitGate.promise;
    });
    const start = setup.runtime.startLocalTrack({
      queueItemId: Q2,
      file,
      positionSeconds: 0,
      signal: new AbortController().signal,
    });
    await preparedEntered.promise;

    await expect(setup.runtime.warmNextLocalTrack({ queueItemId: Q2, file })).resolves.toBe(false);
    expect(room.warmLocalTrack).not.toHaveBeenCalled();

    const commit = freezeCanonical({
      ...candidateResult(
        prepared.roomGeneration,
        room.options.hostRoomSnapshot.applicationSessionId,
        'prepared-admission',
      ),
      timeline,
    }) as Readonly<FilePlaybackProductHostLocalTrackCommit>;
    commitGate.resolve(commit);
    await expect(start).resolves.toBe(commit);
    setup.runtime.endRoom();
  });

  it('coalesces one exact next-file warm and aborts it before warming a replacement', async () => {
    const setup = harness();
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('next-warm-host');
    const room = setup.hostRooms[0]!;
    const firstGate = deferred<Readonly<FilePlaybackProductHostLocalTrackWarmResult>>();
    let firstSignal: AbortSignal | null = null;
    room.warmLocalTrack.mockImplementationOnce(
      (input: WarmFilePlaybackProductHostLocalTrackOptions) => {
        firstSignal = input.signal;
        return firstGate.promise;
      },
    );
    const firstFile = localFile('first-next.wav');
    const secondFile = localFile('replacement-next.caf');

    const first = setup.runtime.warmNextLocalTrack({ queueItemId: Q1, file: firstFile });
    const duplicate = setup.runtime.warmNextLocalTrack({ queueItemId: Q1, file: firstFile });
    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(room.warmLocalTrack).toHaveBeenCalledOnce());

    const replacement = setup.runtime.warmNextLocalTrack({
      queueItemId: Q2,
      file: secondFile,
    });
    expect(firstSignal?.aborted).toBe(true);
    firstGate.reject(firstSignal?.reason);

    await expect(first).resolves.toBe(false);
    await expect(replacement).resolves.toBe(true);
    expect(room.warmLocalTrack).toHaveBeenCalledTimes(2);
    expect(room.warmLocalTrack.mock.calls[1]?.[0]).toMatchObject({
      queueItemId: Q2,
      file: secondFile,
    });
  });

  it('serializes exact clear before the same queue occurrence can warm again', async () => {
    const setup = harness();
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('next-warm-clear-host');
    const room = setup.hostRooms[0]!;
    const file = localFile('same-occurrence.aiff');

    await expect(setup.runtime.warmNextLocalTrack({ queueItemId: Q1, file })).resolves.toBe(true);
    const clearing = setup.runtime.clearNextLocalTrackWarm();
    const rewarming = setup.runtime.warmNextLocalTrack({ queueItemId: Q1, file });

    await expect(clearing).resolves.toBe(true);
    await expect(rewarming).resolves.toBe(true);
    expect(room.warmLocalTrack).toHaveBeenCalledTimes(2);
    expect(room.clearWarmLocalTrackByLease).toHaveBeenCalledOnce();
    expect(room.clearWarmLocalTrackByLease.mock.invocationCallOrder[0]).toBeLessThan(
      room.warmLocalTrack.mock.invocationCallOrder[1]!,
    );
  });

  it('detaches an abort-ignoring warm lane when its room ends', async () => {
    const setup = harness();
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('stale-warm-room');
    const staleRoom = setup.hostRooms[0]!;
    const staleGate = deferred<Readonly<FilePlaybackProductHostLocalTrackWarmResult>>();
    let staleSignal: AbortSignal | null = null;
    staleRoom.warmLocalTrack.mockImplementationOnce(
      (input: WarmFilePlaybackProductHostLocalTrackOptions) => {
        staleSignal = input.signal;
        return staleGate.promise;
      },
    );
    const stale = setup.runtime.warmNextLocalTrack({
      queueItemId: Q1,
      file: localFile('stale-long.wav'),
    });
    await vi.waitFor(() => expect(staleRoom.warmLocalTrack).toHaveBeenCalledOnce());

    setup.runtime.endRoom();
    expect(staleSignal?.aborted).toBe(true);
    setup.runtime.beginHostRoom('fresh-warm-room');
    const freshRoom = setup.hostRooms[1]!;

    await expect(
      setup.runtime.warmNextLocalTrack({
        queueItemId: Q2,
        file: localFile('fresh-long.m4a'),
      }),
    ).resolves.toBe(true);
    expect(freshRoom.warmLocalTrack).toHaveBeenCalledOnce();

    staleGate.reject(staleSignal?.reason);
    await expect(stale).resolves.toBe(false);
  });

  it.each([
    ['WAV', 'next.wav', 'audio/wav'],
    ['AIFF', 'next.aiff', 'audio/aiff'],
    ['CAF', 'next.caf', 'audio/x-caf'],
    ['FLAC', 'next.flac', 'audio/flac'],
    ['MP3', 'next.mp3', 'audio/mpeg'],
    ['AAC', 'next.aac', 'audio/aac'],
    ['M4A', 'next.m4a', 'audio/mp4'],
  ] as const)(
    'retains and clears one exact codec-neutral %s source lease',
    async (_label, name, mime) => {
      const setup = harness();
      setup.runtime.initializeBeforeProtocol();
      setup.runtime.beginHostRoom(`codec-neutral-${name}`);
      const room = setup.hostRooms[0]!;
      const file = new File([new Uint8Array([1, 2, 3, 4])], name, { type: mime });

      await expect(setup.runtime.warmNextLocalTrack({ queueItemId: Q1, file })).resolves.toBe(true);
      const authority = await room.warmLocalTrack.mock.results[0]!.value;
      await expect(setup.runtime.clearNextLocalTrackWarm()).resolves.toBe(true);

      expect(authority).toMatchObject({
        status: 'warmed',
        backend: 'bounded-stream',
        asset: {
          binding: { queueItemId: Q1 },
          metadata: { name, mime },
          encodedSize: file.size,
          peerRangeManifest: null,
        },
      });
      expect(room.clearWarmLocalTrackByLease).toHaveBeenCalledWith({
        sourceLease: authority.sourceLease,
        signal: expect.any(AbortSignal),
      });
    },
  );

  it('retains the exact warm result and publishes it only after one late owner is READY', async () => {
    const routers: ProductRouterHarness[] = [];
    let ownerOptions: Readonly<FilePlaybackProductHostMediaOwnerOptions> | null = null;
    const publishSourceLease = vi.fn(
      async (authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult>) => {
        const resolver = ownerOptions?.resolveWarmPeerRangeSource;
        if (!resolver || !authority.sourceLease)
          throw new Error('fixture warm resolver unavailable');
        const source = await resolver({
          sourceLease: authority.sourceLease,
          sourceIdentity: authority.asset.binding.sourceIdentity,
          peerRangeManifest: null,
          signal: new AbortController().signal,
        });
        expect(source).toBe(file);
        return freezeCanonical({ schemaVersion: 1, sourceLease: authority.sourceLease }) as never;
      },
    );
    const owner = Object.freeze({
      onHostReady: vi.fn(),
      adoptWireMessage: vi.fn(),
      adoptPeerRangeControl: vi.fn(),
      revoke: vi.fn(),
      stageCurrentTransition: vi.fn(),
      stageRemoteEnd: vi.fn(),
      commitCurrentTimeline: vi.fn(),
      publishCurrent: vi.fn(async () => freezeCanonical({ schemaVersion: 1 }) as never),
      publishSourceLease,
      retireSourceLease: vi.fn(async () => undefined),
      publishPrepared: vi.fn(),
      bindPrepared: vi.fn(),
      whenPreparedRemoteReady: vi.fn(),
      activatePrepared: vi.fn(),
      retirePrepared: vi.fn(),
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
          return owner;
        },
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('late-ready-warm-host');
    const context = routerContext('host', { suffix: 'late-ready-warm' });
    const wrapped = routers[0]!.options.createHostMediaOwner(context);
    const file = new File([new Uint8Array([4, 5, 6])], 'late-ready.flac', {
      type: 'audio/flac',
    });

    await expect(setup.runtime.warmNextLocalTrack({ queueItemId: Q1, file })).resolves.toBe(true);
    const authority = await setup.hostRooms[0]!.warmLocalTrack.mock.results[0]!.value;
    expect(publishSourceLease).not.toHaveBeenCalled();

    wrapped.onHostReady?.(hostReadySnapshot(setup, context));
    await vi.waitFor(() => expect(publishSourceLease).toHaveBeenCalledOnce());

    expect(publishSourceLease.mock.calls[0]?.[0]).toBe(authority);
    expect(owner.publishCurrent).not.toHaveBeenCalled();
    expect(ownerOptions?.hostRoom).toBe(setup.hostRooms[0]!.port);
  });

  it('keeps owner barriers independent and orders current publication before next OFFER-only', async () => {
    const routers: ProductRouterHarness[] = [];
    const slowCurrent = deferred<void>();
    const events: string[] = [];
    const owners = [0, 1].map((index) =>
      Object.freeze({
        onHostReady: vi.fn(),
        adoptWireMessage: vi.fn(),
        adoptPeerRangeControl: vi.fn(),
        revoke: vi.fn(),
        stageCurrentTransition: vi.fn(),
        stageRemoteEnd: vi.fn(),
        commitCurrentTimeline: vi.fn(),
        publishCurrent: vi.fn(async () => {
          events.push(`current-${index}`);
          if (index === 0) await slowCurrent.promise;
          return freezeCanonical({ schemaVersion: 1 }) as never;
        }),
        publishSourceLease: vi.fn(
          async (authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult>) => {
            events.push(`next-${index}`);
            return freezeCanonical({
              schemaVersion: 1,
              sourceLease: authority.sourceLease,
            }) as never;
          },
        ),
        retireSourceLease: vi.fn(async () => undefined),
        publishPrepared: vi.fn(),
        bindPrepared: vi.fn(),
        whenPreparedRemoteReady: vi.fn(),
        activatePrepared: vi.fn(),
        retirePrepared: vi.fn(),
      }),
    );
    let ownerIndex = 0;
    const setup = harness({
      mediaFactoriesForTests: {
        createSessionRouter: (options) => {
          const candidate = productRouterHarness(options);
          routers.push(candidate);
          return candidate.port;
        },
        createHostMediaOwner: () => owners[ownerIndex++]!,
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('independent-warm-owner-host');
    setup.hostRooms[0]!.setCurrentPeerPublication(
      freezeCanonical({ schemaVersion: 1 }) as unknown as Readonly<HostPeerPlaybackPublication>,
    );
    const contexts = [0, 1].map((index) =>
      routerContext('host', { suffix: `independent-warm-${index}` }),
    );
    const wrapped = contexts.map((context) => routers[0]!.options.createHostMediaOwner(context));
    wrapped.forEach((port, index) =>
      port.onHostReady?.(hostReadySnapshot(setup, contexts[index]!)),
    );
    const file = new File([new Uint8Array([7, 8, 9])], 'barrier.wav', { type: 'audio/wav' });

    await expect(setup.runtime.warmNextLocalTrack({ queueItemId: Q1, file })).resolves.toBe(true);
    await vi.waitFor(() => expect(owners[1]!.publishSourceLease).toHaveBeenCalledOnce());

    expect(owners[0]!.publishSourceLease).not.toHaveBeenCalled();
    expect(events.indexOf('current-1')).toBeLessThan(events.indexOf('next-1'));
    slowCurrent.resolve();
    await vi.waitFor(() => expect(owners[0]!.publishSourceLease).toHaveBeenCalledOnce());
    expect(events.indexOf('current-0')).toBeLessThan(events.indexOf('next-0'));
  });

  it('fail-closes an exact READY owner when its required current publication fails', async () => {
    const routers: ProductRouterHarness[] = [];
    const publishSourceLease = vi.fn();
    const owner = Object.freeze({
      onHostReady: vi.fn(),
      adoptWireMessage: vi.fn(),
      adoptPeerRangeControl: vi.fn(),
      revoke: vi.fn(),
      stageCurrentTransition: vi.fn(),
      stageRemoteEnd: vi.fn(),
      commitCurrentTimeline: vi.fn(),
      publishCurrent: vi.fn(async () => {
        throw new Error('required current publication failed');
      }),
      publishSourceLease,
      retireSourceLease: vi.fn(async () => undefined),
      publishPrepared: vi.fn(),
      bindPrepared: vi.fn(),
      whenPreparedRemoteReady: vi.fn(),
      activatePrepared: vi.fn(),
      retirePrepared: vi.fn(),
    });
    const setup = harness({
      mediaFactoriesForTests: {
        createSessionRouter: (options) => {
          const candidate = productRouterHarness(options);
          routers.push(candidate);
          return candidate.port;
        },
        createHostMediaOwner: () => owner,
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('failed-ready-current-host');
    setup.hostRooms[0]!.setCurrentPeerPublication(
      freezeCanonical({ schemaVersion: 1 }) as unknown as Readonly<HostPeerPlaybackPublication>,
    );
    const context = routerContext('host', { suffix: 'failed-ready-current' });
    const wrapped = routers[0]!.options.createHostMediaOwner(context);

    wrapped.onHostReady?.(hostReadySnapshot(setup, context));
    await vi.waitFor(() =>
      expect(setup.sessions.closeConnection).toHaveBeenCalledWith(context.connection),
    );
    const file = new File([new Uint8Array([1, 2])], 'after-current-failure.wav', {
      type: 'audio/wav',
    });
    await expect(setup.runtime.warmNextLocalTrack({ queueItemId: Q1, file })).resolves.toBe(true);
    await Promise.resolve();

    expect(publishSourceLease).not.toHaveBeenCalled();
  });

  it('releases a failed prepared barrier so the same live owner can receive a later warm lease', async () => {
    const routers: ProductRouterHarness[] = [];
    const preparedPublicationGate = deferred<void>();
    const publishSourceLease = vi.fn(
      async (authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult>) =>
        freezeCanonical({ schemaVersion: 1, sourceLease: authority.sourceLease }) as never,
    );
    const owner = Object.freeze({
      onHostReady: vi.fn(),
      adoptWireMessage: vi.fn(),
      adoptPeerRangeControl: vi.fn(),
      revoke: vi.fn(),
      stageCurrentTransition: vi.fn(),
      stageRemoteEnd: vi.fn(),
      commitCurrentTimeline: vi.fn(),
      publishCurrent: vi.fn(),
      publishSourceLease,
      retireSourceLease: vi.fn(async () => undefined),
      publishPrepared: vi.fn(async () => {
        await preparedPublicationGate.promise;
        throw new Error('prepared publication failed');
      }),
      bindPrepared: vi.fn(),
      whenPreparedRemoteReady: vi.fn(),
      activatePrepared: vi.fn(),
      retirePrepared: vi.fn(async () => undefined),
    });
    const setup = harness({
      mediaFactoriesForTests: {
        createSessionRouter: (options) => {
          const candidate = productRouterHarness(options);
          routers.push(candidate);
          return candidate.port;
        },
        createHostMediaOwner: () => owner,
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('failed-prepared-barrier-host');
    const context = routerContext('host', { suffix: 'failed-prepared-barrier' });
    const wrapped = routers[0]!.options.createHostMediaOwner(context);
    wrapped.onHostReady?.(hostReadySnapshot(setup, context));
    const room = setup.hostRooms[0]!;
    const failedFile = new File([new Uint8Array([3, 4])], 'failed-current.mp3', {
      type: 'audio/mpeg',
    });
    const prepared = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: room.options.hostRoomSnapshot.roomGeneration,
      backend: 'bounded-stream' as const,
      state: freezeCanonical({ queueItemId: Q1, runId: 'failed-barrier-run', revision: 1 }),
      positionSeconds: 0,
      playbackRate: 1,
      asset: freezeCanonical({
        kind: 'encoded' as const,
        binding: freezeCanonical({
          queueItemId: Q1,
          sourceIdentity: 'failed-barrier-source',
          transferSessionId: 'failed-barrier-transfer',
        }),
        metadata: freezeCanonical({ name: failedFile.name, mime: failedFile.type }),
        encodedSize: failedFile.size,
        peerRangeManifest: null,
      }),
      sourceLease: null,
    }) as unknown as Readonly<HostPreparedLocalTrack>;
    room.startLocalTrackWithCohort.mockImplementationOnce(async (input) => {
      await input.prepareRemoteParticipants(
        freezeCanonical({
          prepared,
          signal: input.signal,
          resolveSource: vi.fn(async () => failedFile),
        }),
      );
      throw new Error('candidate failed after prepared barrier');
    });

    const failedStart = setup.runtime.startLocalTrack({
      queueItemId: Q1,
      file: failedFile,
      positionSeconds: 0,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(owner.publishPrepared).toHaveBeenCalledOnce());

    const blockedFile = new File([new Uint8Array([5, 6])], 'blocked-next.flac', {
      type: 'audio/flac',
    });
    await expect(
      setup.runtime.warmNextLocalTrack({ queueItemId: Q2, file: blockedFile }),
    ).resolves.toBe(true);
    expect(publishSourceLease).not.toHaveBeenCalled();

    preparedPublicationGate.resolve();
    await expect(failedStart).rejects.toThrow(/candidate failed/u);
    expect(setup.sessions.closeConnection).not.toHaveBeenCalled();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(publishSourceLease).not.toHaveBeenCalled();

    const nextFile = new File([new Uint8Array([7, 8])], 'valid-next.flac', {
      type: 'audio/flac',
    });
    await expect(
      setup.runtime.warmNextLocalTrack({ queueItemId: Q2, file: nextFile }),
    ).resolves.toBe(true);
    await vi.waitFor(() => expect(publishSourceLease).toHaveBeenCalledOnce());
    expect(publishSourceLease.mock.calls[0]?.[0].asset.metadata.name).toBe(nextFile.name);
  });

  it('retires the exact old lease before same-queue File replacement and exact clear', async () => {
    const routers: ProductRouterHarness[] = [];
    const publishSourceLease = vi.fn(
      async (authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult>) =>
        freezeCanonical({ schemaVersion: 1, sourceLease: authority.sourceLease }) as never,
    );
    const retireSourceLease = vi.fn(async () => undefined);
    const owner = Object.freeze({
      onHostReady: vi.fn(),
      adoptWireMessage: vi.fn(),
      adoptPeerRangeControl: vi.fn(),
      revoke: vi.fn(),
      stageCurrentTransition: vi.fn(),
      stageRemoteEnd: vi.fn(),
      commitCurrentTimeline: vi.fn(),
      publishCurrent: vi.fn(),
      publishSourceLease,
      retireSourceLease,
      publishPrepared: vi.fn(),
      bindPrepared: vi.fn(),
      whenPreparedRemoteReady: vi.fn(),
      activatePrepared: vi.fn(),
      retirePrepared: vi.fn(),
    });
    const setup = harness({
      mediaFactoriesForTests: {
        createSessionRouter: (options) => {
          const candidate = productRouterHarness(options);
          routers.push(candidate);
          return candidate.port;
        },
        createHostMediaOwner: () => owner,
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('same-queue-file-aba-host');
    const context = routerContext('host', { suffix: 'same-queue-file-aba' });
    const wrapped = routers[0]!.options.createHostMediaOwner(context);
    wrapped.onHostReady?.(hostReadySnapshot(setup, context));
    const firstFile = new File([new Uint8Array([1])], 'first.wav', { type: 'audio/wav' });
    const secondFile = new File([new Uint8Array([2])], 'second.wav', { type: 'audio/wav' });

    await expect(
      setup.runtime.warmNextLocalTrack({ queueItemId: Q1, file: firstFile }),
    ).resolves.toBe(true);
    await vi.waitFor(() => expect(publishSourceLease).toHaveBeenCalledTimes(1));
    const firstAuthority = publishSourceLease.mock.calls[0]![0];
    await expect(
      setup.runtime.warmNextLocalTrack({ queueItemId: Q1, file: secondFile }),
    ).resolves.toBe(true);
    await vi.waitFor(() => expect(publishSourceLease).toHaveBeenCalledTimes(2));
    const secondAuthority = publishSourceLease.mock.calls[1]![0];

    expect(secondAuthority.sourceLease).not.toBe(firstAuthority.sourceLease);
    expect(retireSourceLease).toHaveBeenNthCalledWith(
      1,
      firstAuthority.sourceLease,
      expect.any(Error),
    );
    expect(setup.hostRooms[0]!.clearWarmLocalTrackByLease).toHaveBeenNthCalledWith(1, {
      sourceLease: firstAuthority.sourceLease,
      signal: expect.any(AbortSignal),
    });
    expect(retireSourceLease.mock.invocationCallOrder[0]).toBeLessThan(
      setup.hostRooms[0]!.clearWarmLocalTrackByLease.mock.invocationCallOrder[0]!,
    );
    expect(setup.hostRooms[0]!.clearWarmLocalTrackByLease.mock.invocationCallOrder[0]).toBeLessThan(
      setup.hostRooms[0]!.warmLocalTrack.mock.invocationCallOrder[1]!,
    );

    await expect(setup.runtime.clearNextLocalTrackWarm()).resolves.toBe(true);
    expect(retireSourceLease).toHaveBeenNthCalledWith(
      2,
      secondAuthority.sourceLease,
      expect.any(Error),
    );
    expect(setup.hostRooms[0]!.clearWarmLocalTrackByLease).toHaveBeenNthCalledWith(2, {
      sourceLease: secondAuthority.sourceLease,
      signal: expect.any(AbortSignal),
    });
  });

  it('holds next warm publication behind the exact prepared OFFER and RUN barrier', async () => {
    const routers: ProductRouterHarness[] = [];
    const bindGate = deferred<void>();
    const capability = freezeCanonical({
      participant: freezeCanonical({ participantId: 'warm-during-cohort-guest' }),
      bindAttempt: vi.fn(async () => undefined),
    }) as unknown as Readonly<HostPreparedRemoteParticipant>;
    const publishSourceLease = vi.fn(
      async (authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult>) =>
        freezeCanonical({ schemaVersion: 1, sourceLease: authority.sourceLease }) as never,
    );
    const owner = Object.freeze({
      onHostReady: vi.fn(),
      adoptWireMessage: vi.fn(),
      adoptPeerRangeControl: vi.fn(),
      revoke: vi.fn(),
      stageCurrentTransition: vi.fn(),
      stageRemoteEnd: vi.fn(),
      commitCurrentTimeline: vi.fn(),
      publishCurrent: vi.fn(),
      publishSourceLease,
      retireSourceLease: vi.fn(async () => undefined),
      publishPrepared: vi.fn(
        async (prepared: Readonly<HostPreparedLocalTrack>) =>
          freezeCanonical({ schemaVersion: 1, prepared }) as never,
      ),
      bindPrepared: vi.fn(async (prepared: Readonly<HostPreparedLocalTrack>) => {
        await bindGate.promise;
        return freezeCanonical({ schemaVersion: 1, prepared }) as never;
      }),
      whenPreparedRemoteReady: vi.fn(async () => capability),
      activatePrepared: vi.fn(() => freezeCanonical({ schemaVersion: 1 }) as never),
      retirePrepared: vi.fn(async () => undefined),
    });
    const setup = harness({
      mediaFactoriesForTests: {
        createSessionRouter: (options) => {
          const candidate = productRouterHarness(options);
          routers.push(candidate);
          return candidate.port;
        },
        createHostMediaOwner: () => owner,
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('warm-during-cohort-host');
    const context = routerContext('host', { suffix: 'warm-during-cohort' });
    const wrapped = routers[0]!.options.createHostMediaOwner(context);
    wrapped.onHostReady?.(hostReadySnapshot(setup, context));
    const room = setup.hostRooms[0]!;
    const currentFile = new File([new Uint8Array([1, 2])], 'current.wav', {
      type: 'audio/wav',
    });
    const nextFile = new File([new Uint8Array([3, 4])], 'next.flac', {
      type: 'audio/flac',
    });
    const prepared = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: room.options.hostRoomSnapshot.roomGeneration,
      backend: 'bounded-stream' as const,
      state: freezeCanonical({ queueItemId: Q1, runId: 'warm-cohort-run', revision: 1 }),
      positionSeconds: 0,
      playbackRate: 1,
      asset: freezeCanonical({
        kind: 'encoded' as const,
        binding: freezeCanonical({
          queueItemId: Q1,
          sourceIdentity: 'warm-cohort-current-source',
          transferSessionId: 'warm-cohort-current-transfer',
        }),
        metadata: freezeCanonical({ name: currentFile.name, mime: currentFile.type }),
        encodedSize: currentFile.size,
        peerRangeManifest: null,
      }),
      sourceLease: null,
    }) as unknown as Readonly<HostPreparedLocalTrack>;
    const timeline = freezeCanonical({
      revision: 1,
      phase: 'playing' as const,
      run: freezeCanonical({ queueItemId: Q1, runId: prepared.state.runId }),
      positionSeconds: 0,
      rate: 1,
      anchorMonotonicMs: 12_000,
    }) as Readonly<PlaybackTimelineSnapshot>;
    room.startLocalTrackWithCohort.mockImplementationOnce(async (input) => {
      await input.prepareRemoteParticipants(
        freezeCanonical({
          prepared,
          signal: input.signal,
          resolveSource: vi.fn(async () => currentFile),
        }),
      );
      return freezeCanonical({
        ...candidateResult(
          prepared.roomGeneration,
          room.options.hostRoomSnapshot.applicationSessionId,
          'warm-during-cohort',
        ),
        timeline,
      }) as Readonly<FilePlaybackProductHostLocalTrackCommit>;
    });

    const start = setup.runtime.startLocalTrack({
      queueItemId: Q1,
      file: currentFile,
      positionSeconds: 0,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(owner.bindPrepared).toHaveBeenCalledWith(prepared));
    await expect(
      setup.runtime.warmNextLocalTrack({ queueItemId: Q2, file: nextFile }),
    ).resolves.toBe(true);
    expect(publishSourceLease).not.toHaveBeenCalled();

    bindGate.resolve();
    await expect(start).resolves.toMatchObject({ timeline });
    await vi.waitFor(() => expect(publishSourceLease).toHaveBeenCalledOnce());
    expect(owner.bindPrepared.mock.invocationCallOrder[0]).toBeLessThan(
      publishSourceLease.mock.invocationCallOrder[0]!,
    );
  });

  it('fences a same-queue in-flight warm before prepared publication and retires its late lease', async () => {
    const routers: ProductRouterHarness[] = [];
    const warmGate = deferred<Readonly<FilePlaybackProductHostLocalTrackWarmResult>>();
    let warmSignal: AbortSignal | null = null;
    const capability = freezeCanonical({
      participant: freezeCanonical({ participantId: 'same-queue-warm-guest' }),
      bindAttempt: vi.fn(async () => undefined),
    }) as unknown as Readonly<HostPreparedRemoteParticipant>;
    const publishSourceLease = vi.fn(
      async (authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult>) =>
        freezeCanonical({ schemaVersion: 1, sourceLease: authority.sourceLease }) as never,
    );
    const owner = Object.freeze({
      onHostReady: vi.fn(),
      adoptWireMessage: vi.fn(),
      adoptPeerRangeControl: vi.fn(),
      revoke: vi.fn(),
      stageCurrentTransition: vi.fn(),
      stageRemoteEnd: vi.fn(),
      commitCurrentTimeline: vi.fn(),
      publishCurrent: vi.fn(),
      publishSourceLease,
      retireSourceLease: vi.fn(async () => undefined),
      publishPrepared: vi.fn(async (prepared: Readonly<HostPreparedLocalTrack>) => {
        expect(warmSignal?.aborted).toBe(true);
        return freezeCanonical({ schemaVersion: 1, prepared }) as never;
      }),
      bindPrepared: vi.fn(
        async (prepared: Readonly<HostPreparedLocalTrack>) =>
          freezeCanonical({ schemaVersion: 1, prepared }) as never,
      ),
      whenPreparedRemoteReady: vi.fn(async () => capability),
      activatePrepared: vi.fn(() => freezeCanonical({ schemaVersion: 1 }) as never),
      retirePrepared: vi.fn(async () => undefined),
    });
    const setup = harness({
      mediaFactoriesForTests: {
        createSessionRouter: (options) => {
          const candidate = productRouterHarness(options);
          routers.push(candidate);
          return candidate.port;
        },
        createHostMediaOwner: () => owner,
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('same-queue-in-flight-warm-host');
    const context = routerContext('host', { suffix: 'same-queue-in-flight-warm' });
    const wrapped = routers[0]!.options.createHostMediaOwner(context);
    wrapped.onHostReady?.(hostReadySnapshot(setup, context));
    const room = setup.hostRooms[0]!;
    const file = new File([new Uint8Array([9, 8, 7])], 'same-queue-in-flight.flac', {
      type: 'audio/flac',
    });
    room.warmLocalTrack.mockImplementationOnce(
      (input: WarmFilePlaybackProductHostLocalTrackOptions) => {
        warmSignal = input.signal;
        return warmGate.promise;
      },
    );
    const warming = setup.runtime.warmNextLocalTrack({ queueItemId: Q2, file });
    await vi.waitFor(() => expect(room.warmLocalTrack).toHaveBeenCalledOnce());

    const prepared = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: room.options.hostRoomSnapshot.roomGeneration,
      backend: 'bounded-stream' as const,
      state: freezeCanonical({ queueItemId: Q2, runId: 'same-queue-prepared-run', revision: 1 }),
      positionSeconds: 0,
      playbackRate: 1,
      asset: freezeCanonical({
        kind: 'encoded' as const,
        binding: freezeCanonical({
          queueItemId: Q2,
          sourceIdentity: 'same-queue-prepared-source',
          transferSessionId: 'same-queue-prepared-transfer',
        }),
        metadata: freezeCanonical({ name: file.name, mime: file.type }),
        encodedSize: file.size,
        peerRangeManifest: null,
      }),
      sourceLease: null,
    }) as unknown as Readonly<HostPreparedLocalTrack>;
    const timeline = freezeCanonical({
      revision: 1,
      phase: 'playing' as const,
      run: freezeCanonical({ queueItemId: Q2, runId: prepared.state.runId }),
      positionSeconds: 0,
      rate: 1,
      anchorMonotonicMs: 13_000,
    }) as Readonly<PlaybackTimelineSnapshot>;
    room.startLocalTrackWithCohort.mockImplementationOnce(async (input) => {
      const remotes = await input.prepareRemoteParticipants(
        freezeCanonical({
          prepared,
          signal: input.signal,
          resolveSource: vi.fn(async () => file),
        }),
      );
      expect(remotes).toEqual([capability]);
      return freezeCanonical({
        ...candidateResult(
          prepared.roomGeneration,
          room.options.hostRoomSnapshot.applicationSessionId,
          'same-queue-prepared',
        ),
        timeline,
      }) as Readonly<FilePlaybackProductHostLocalTrackCommit>;
    });

    await expect(
      setup.runtime.startLocalTrack({
        queueItemId: Q2,
        file,
        positionSeconds: 0,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ timeline });
    expect(warmSignal?.aborted).toBe(true);
    expect(publishSourceLease).not.toHaveBeenCalled();

    const sourceLease = freezeCanonical({}) as HostLocalTrackSourceLease;
    const lateAuthority = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: room.options.hostRoomSnapshot.roomGeneration,
      applicationSessionId: room.options.hostRoomSnapshot.applicationSessionId,
      hostParticipantId: room.options.hostRoomSnapshot.hostParticipantId,
      status: 'warmed' as const,
      backend: 'bounded-stream' as const,
      asset: freezeCanonical({
        kind: 'blob' as const,
        binding: freezeCanonical({
          queueItemId: Q2,
          sourceIdentity: 'same-queue-late-warm-source',
          transferSessionId: 'same-queue-late-warm-transfer',
        }),
        metadata: freezeCanonical({ name: file.name, mime: file.type }),
        encodedSize: file.size,
        peerRangeManifest: null,
      }),
      readiness: freezeCanonical({
        durationSeconds: 120,
        bufferedAheadSeconds: 8,
        outputSampleRateHz: 48_000,
        channelCount: 2,
      }),
      sourceLease,
    }) as unknown as Readonly<FilePlaybackProductHostLocalTrackWarmResult>;
    warmGate.resolve(lateAuthority);

    await expect(warming).resolves.toBe(false);
    expect(publishSourceLease).not.toHaveBeenCalled();
    expect(room.clearWarmLocalTrackByLease).toHaveBeenCalledOnce();
    expect(room.clearWarmLocalTrackByLease).toHaveBeenCalledWith({
      sourceLease,
      signal: expect.any(AbortSignal),
    });
    await expect(setup.runtime.clearNextLocalTrackWarm()).resolves.toBe(false);
    setup.runtime.endRoom();
  });

  it('consumes an exact promoted warm lease only after canonical candidate commit', async () => {
    const setup = harness();
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('promoted-warm-consume-host');
    const room = setup.hostRooms[0]!;
    const file = new File([new Uint8Array([5, 6])], 'promoted.m4a', { type: 'audio/mp4' });
    await expect(setup.runtime.warmNextLocalTrack({ queueItemId: Q2, file })).resolves.toBe(true);
    const authority = await room.warmLocalTrack.mock.results[0]!.value;
    const prepared = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: authority.roomGeneration,
      backend: authority.backend,
      state: freezeCanonical({ queueItemId: Q2, runId: 'promoted-warm-run', revision: 1 }),
      positionSeconds: 0,
      playbackRate: 1,
      asset: authority.asset,
      sourceLease: authority.sourceLease,
    }) as unknown as Readonly<HostPreparedLocalTrack>;
    const timeline = freezeCanonical({
      revision: 1,
      phase: 'playing' as const,
      run: freezeCanonical({ queueItemId: Q2, runId: prepared.state.runId }),
      positionSeconds: 0,
      rate: 1,
      anchorMonotonicMs: 14_000,
    }) as Readonly<PlaybackTimelineSnapshot>;
    room.startLocalTrackWithCohort.mockImplementationOnce(async (input) => {
      await input.prepareRemoteParticipants(
        freezeCanonical({
          prepared,
          signal: input.signal,
          resolveSource: vi.fn(async () => file),
        }),
      );
      return freezeCanonical({
        ...candidateResult(
          prepared.roomGeneration,
          room.options.hostRoomSnapshot.applicationSessionId,
          'promoted-warm',
        ),
        timeline,
      }) as Readonly<FilePlaybackProductHostLocalTrackCommit>;
    });

    await expect(
      setup.runtime.startLocalTrack({
        queueItemId: Q2,
        file,
        positionSeconds: 0,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ timeline });

    await expect(setup.runtime.clearNextLocalTrackWarm()).resolves.toBe(false);
    expect(room.clearWarmLocalTrackByLease).not.toHaveBeenCalled();
  });

  it('preserves the exact warm lease when its prepared candidate fails before commit', async () => {
    const setup = harness();
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('failed-promoted-warm-host');
    const room = setup.hostRooms[0]!;
    const file = new File([new Uint8Array([7, 8])], 'failed-promoted.aac', {
      type: 'audio/aac',
    });
    await expect(setup.runtime.warmNextLocalTrack({ queueItemId: Q2, file })).resolves.toBe(true);
    const authority = await room.warmLocalTrack.mock.results[0]!.value;
    const prepared = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: authority.roomGeneration,
      backend: authority.backend,
      state: freezeCanonical({ queueItemId: Q2, runId: 'failed-promoted-run', revision: 1 }),
      positionSeconds: 0,
      playbackRate: 1,
      asset: authority.asset,
      sourceLease: authority.sourceLease,
    }) as unknown as Readonly<HostPreparedLocalTrack>;
    room.startLocalTrackWithCohort.mockImplementationOnce(async (input) => {
      await input.prepareRemoteParticipants(
        freezeCanonical({
          prepared,
          signal: input.signal,
          resolveSource: vi.fn(async () => file),
        }),
      );
      throw new Error('prepared candidate failed before commit');
    });

    await expect(
      setup.runtime.startLocalTrack({
        queueItemId: Q2,
        file,
        positionSeconds: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/failed before commit/u);
    await expect(setup.runtime.clearNextLocalTrackWarm()).resolves.toBe(true);
    expect(room.clearWarmLocalTrackByLease).toHaveBeenCalledWith({
      sourceLease: authority.sourceLease,
      signal: expect.any(AbortSignal),
    });
  });

  it('closes a late encoded warm resolver settlement after exact room replacement', async () => {
    const routers: ProductRouterHarness[] = [];
    const sourceGate = deferred<HostPeerRangeSource>();
    let ownerOptions: Readonly<FilePlaybackProductHostMediaOwnerOptions> | null = null;
    const publishSourceLease = vi.fn(
      async (authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult>) => {
        const resolver = ownerOptions?.resolveWarmPeerRangeSource;
        if (!resolver || !authority.sourceLease)
          throw new Error('fixture warm resolver unavailable');
        await resolver({
          sourceLease: authority.sourceLease,
          sourceIdentity: authority.asset.binding.sourceIdentity,
          peerRangeManifest: null,
          signal: new AbortController().signal,
        });
        return freezeCanonical({ schemaVersion: 1, sourceLease: authority.sourceLease }) as never;
      },
    );
    const retireSourceLease = vi.fn(async () => undefined);
    const owner = Object.freeze({
      onHostReady: vi.fn(),
      adoptWireMessage: vi.fn(),
      adoptPeerRangeControl: vi.fn(),
      revoke: vi.fn(),
      stageCurrentTransition: vi.fn(),
      stageRemoteEnd: vi.fn(),
      commitCurrentTimeline: vi.fn(),
      publishCurrent: vi.fn(),
      publishSourceLease,
      retireSourceLease,
      publishPrepared: vi.fn(),
      bindPrepared: vi.fn(),
      whenPreparedRemoteReady: vi.fn(),
      activatePrepared: vi.fn(),
      retirePrepared: vi.fn(),
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
          return owner;
        },
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('late-warm-source-old-host');
    const oldRoom = setup.hostRooms[0]!;
    oldRoom.resolveWarmPeerRangeSource.mockImplementationOnce(() => sourceGate.promise);
    const context = routerContext('host', { suffix: 'late-warm-source' });
    const wrapped = routers[0]!.options.createHostMediaOwner(context);
    wrapped.onHostReady?.(hostReadySnapshot(setup, context));
    const file = new File([new Uint8Array([9, 10])], 'late-source.caf', {
      type: 'audio/x-caf',
    });

    await expect(setup.runtime.warmNextLocalTrack({ queueItemId: Q1, file })).resolves.toBe(true);
    await vi.waitFor(() => expect(oldRoom.resolveWarmPeerRangeSource).toHaveBeenCalledOnce());
    const authority = await oldRoom.warmLocalTrack.mock.results[0]!.value;
    setup.runtime.endRoom();
    setup.runtime.beginHostRoom('late-warm-source-new-host');
    const close = vi.fn(async () => undefined);
    sourceGate.resolve({
      kind: 'peer-range',
      size: file.size,
      identity: authority.asset.binding.sourceIdentity,
      metadata: authority.asset.metadata,
      readAt: vi.fn(async () => new Uint8Array()),
      close,
    });

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(retireSourceLease).toHaveBeenCalledWith(authority.sourceLease, expect.any(Error));
    expect(setup.runtime.hostRoomSnapshot()?.hostParticipantId).toBe('late-warm-source-new-host');
  });

  it('closes an encoded warm source when its exact resolver signal aborts in flight', async () => {
    const routers: ProductRouterHarness[] = [];
    const sourceGate = deferred<HostPeerRangeSource>();
    const resolverController = new AbortController();
    let ownerOptions: Readonly<FilePlaybackProductHostMediaOwnerOptions> | null = null;
    const publishSourceLease = vi.fn(
      async (authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult>) => {
        const resolver = ownerOptions?.resolveWarmPeerRangeSource;
        if (!resolver || !authority.sourceLease) {
          throw new Error('fixture warm resolver unavailable');
        }
        await resolver({
          sourceLease: authority.sourceLease,
          sourceIdentity: authority.asset.binding.sourceIdentity,
          peerRangeManifest: null,
          signal: resolverController.signal,
        });
        return freezeCanonical({ schemaVersion: 1, sourceLease: authority.sourceLease }) as never;
      },
    );
    const owner = Object.freeze({
      onHostReady: vi.fn(),
      adoptWireMessage: vi.fn(),
      adoptPeerRangeControl: vi.fn(),
      revoke: vi.fn(),
      stageCurrentTransition: vi.fn(),
      stageRemoteEnd: vi.fn(),
      commitCurrentTimeline: vi.fn(),
      publishCurrent: vi.fn(),
      publishSourceLease,
      retireSourceLease: vi.fn(async () => undefined),
      publishPrepared: vi.fn(),
      bindPrepared: vi.fn(),
      whenPreparedRemoteReady: vi.fn(),
      activatePrepared: vi.fn(),
      retirePrepared: vi.fn(),
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
          return owner;
        },
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('aborted-warm-source-host');
    const room = setup.hostRooms[0]!;
    room.resolveWarmPeerRangeSource.mockImplementationOnce(() => sourceGate.promise);
    const context = routerContext('host', { suffix: 'aborted-warm-source' });
    const wrapped = routers[0]!.options.createHostMediaOwner(context);
    wrapped.onHostReady?.(hostReadySnapshot(setup, context));
    const file = new File([new Uint8Array([11, 12])], 'abort-source.aiff', {
      type: 'audio/aiff',
    });

    await expect(setup.runtime.warmNextLocalTrack({ queueItemId: Q1, file })).resolves.toBe(true);
    await vi.waitFor(() => expect(room.resolveWarmPeerRangeSource).toHaveBeenCalledOnce());
    const authority = await room.warmLocalTrack.mock.results[0]!.value;
    resolverController.abort(new Error('exact warm range request was cancelled'));
    const close = vi.fn(async () => undefined);
    sourceGate.resolve({
      kind: 'peer-range',
      size: file.size,
      identity: authority.asset.binding.sourceIdentity,
      metadata: authority.asset.metadata,
      readAt: vi.fn(async () => new Uint8Array()),
      close,
    });

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(setup.runtime.hostRoomSnapshot()?.hostParticipantId).toBe('aborted-warm-source-host');
    expect(setup.sessions.closeConnection).not.toHaveBeenCalled();
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
      stageCurrentTransition: vi.fn(),
      stageRemoteEnd: vi.fn(),
      commitCurrentTimeline: vi.fn(),
      publishCurrent: vi.fn(),
      publishSourceLease: vi.fn(),
      retireSourceLease: vi.fn(),
      publishPrepared: vi.fn(),
      bindPrepared: vi.fn(),
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
    expect(hostOwnerOptions).not.toHaveProperty('boundedRoutePolicy');
    expect(wrappedOwner).not.toBe(hostOwner);
    expect(hostOwnerOptions?.sendRequired(peer, freezeCanonical({ type: 'fixture' }))).toBe(true);
    expect(setup.sessions.sendRequired).toHaveBeenCalledWith(peer, { type: 'fixture' });

    hostOwnerOptions?.closeConnection(peer);
    expect(setup.sessions.closeConnection).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(setup.sessions.closeConnection).toHaveBeenCalledOnce();
    expect(setup.sessions.closeConnection).toHaveBeenCalledWith(peer);
    vi.mocked(setup.sessions.closeConnection).mockClear();

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
    const bindGate = deferred<void>();
    const peerRangeManifest = freezeCanonical({
      codec: 'adts-aac-lc' as const,
      manifestByteLength: 96,
      manifestSha256B64: 'runtime-cohort-manifest-sha256',
    }) satisfies Readonly<HostPeerRangeManifestPublication>;
    const publishPrepared = vi.fn(async (prepared: Readonly<HostPreparedLocalTrack>) => {
      const resolver = ownerOptions?.resolvePreparedPeerRangeSource;
      if (!resolver) throw new Error('prepared resolver unavailable');
      const source = await resolver({
        prepared,
        sourceIdentity: prepared.asset.binding.sourceIdentity,
        peerRangeManifest,
        signal: new AbortController().signal,
      });
      expect(source).toBe(blob);
      return freezeCanonical({ schemaVersion: 1, prepared }) as never;
    });
    const bindPrepared = vi.fn(async (prepared: Readonly<HostPreparedLocalTrack>) => {
      await bindGate.promise;
      return freezeCanonical({ schemaVersion: 1, prepared }) as never;
    });
    const whenPreparedRemoteReady = vi.fn(async () => capability);
    const activatePrepared = vi.fn(() => freezeCanonical({ schemaVersion: 1 }) as never);
    const hostOwner = Object.freeze({
      onHostReady: vi.fn(),
      adoptWireMessage: vi.fn(),
      adoptPeerRangeControl: vi.fn(),
      revoke: vi.fn(),
      stageCurrentTransition: vi.fn(),
      stageRemoteEnd: vi.fn(),
      commitCurrentTimeline: vi.fn(),
      publishCurrent: vi.fn(async () => freezeCanonical({ schemaVersion: 1 }) as never),
      publishSourceLease: vi.fn(async () => freezeCanonical({ schemaVersion: 1 }) as never),
      retireSourceLease: vi.fn(async () => undefined),
      publishPrepared,
      bindPrepared,
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
      backend: 'bounded-stream' as const,
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
        peerRangeManifest: null,
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

    const timersBeforeCommit = getFilePlaybackUniversalLifecycleSnapshotForTests().kinds.timers;
    const commitTask = setup.runtime.startLocalTrack({
      queueItemId: Q1,
      file: blob,
      positionSeconds: 0,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(bindPrepared).toHaveBeenCalledWith(prepared));
    expect(whenPreparedRemoteReady).not.toHaveBeenCalled();
    bindGate.resolve();
    const committed = await commitTask;

    expect(committed.timeline).toBe(timeline);
    expect(publishPrepared).toHaveBeenCalledWith(prepared);
    expect(bindPrepared).toHaveBeenCalledWith(prepared);
    expect(whenPreparedRemoteReady).toHaveBeenCalledWith(prepared);
    expect(publishPrepared.mock.invocationCallOrder[0]).toBeLessThan(
      bindPrepared.mock.invocationCallOrder[0]!,
    );
    expect(bindPrepared.mock.invocationCallOrder[0]).toBeLessThan(
      whenPreparedRemoteReady.mock.invocationCallOrder[0]!,
    );
    expect(resolveSource).toHaveBeenCalledWith(
      prepared.asset.binding.sourceIdentity,
      peerRangeManifest,
      expect.any(AbortSignal),
    );
    expect(activatePrepared).toHaveBeenCalledWith({
      prepared,
      timeline,
      initialCohortAdmitted: true,
    });
    expect(getFilePlaybackUniversalLifecycleSnapshotForTests().kinds.timers).toMatchObject({
      live: timersBeforeCommit.live,
      retiring: timersBeforeCommit.retiring,
      unconfirmed: timersBeforeCommit.unconfirmed,
    });
  });

  it('runs a playing seek through prepared cohort publication instead of direct room seek', async () => {
    const routers: ProductRouterHarness[] = [];
    const capability = freezeCanonical({
      participant: freezeCanonical({ participantId: 'runtime-seek-cohort-guest' }),
      bindAttempt: vi.fn(async () => undefined),
    }) as unknown as Readonly<HostPreparedRemoteParticipant>;
    const publishPrepared = vi.fn(
      async (prepared: Readonly<HostPreparedLocalTrack>) =>
        freezeCanonical({ schemaVersion: 1, prepared }) as never,
    );
    const bindPrepared = vi.fn(
      async (prepared: Readonly<HostPreparedLocalTrack>) =>
        freezeCanonical({ schemaVersion: 1, prepared }) as never,
    );
    const whenPreparedRemoteReady = vi.fn(async () => capability);
    const activatePrepared = vi.fn(() => freezeCanonical({ schemaVersion: 1 }) as never);
    const hostOwner = Object.freeze({
      onHostReady: vi.fn(),
      adoptWireMessage: vi.fn(),
      adoptPeerRangeControl: vi.fn(),
      revoke: vi.fn(),
      stageCurrentTransition: vi.fn(),
      stageRemoteEnd: vi.fn(),
      commitCurrentTimeline: vi.fn(),
      publishCurrent: vi.fn(async () => freezeCanonical({ schemaVersion: 1 }) as never),
      publishSourceLease: vi.fn(async () => freezeCanonical({ schemaVersion: 1 }) as never),
      retireSourceLease: vi.fn(async () => undefined),
      publishPrepared,
      bindPrepared,
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
        createHostMediaOwner: () => hostOwner,
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('seek-cohort-runtime-host');
    routers[0]!.options.createHostMediaOwner(
      routerContext('host', { suffix: 'seek-cohort-runtime' }),
    );
    const room = setup.hostRooms[0]!;
    const prepared = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: room.options.hostRoomSnapshot.roomGeneration,
      backend: 'bounded-stream' as const,
      state: freezeCanonical({
        queueItemId: Q1,
        runId: 'runtime-seek-cohort-run',
        revision: 2,
      }),
      positionSeconds: 24,
      playbackRate: 1,
      asset: freezeCanonical({
        kind: 'encoded' as const,
        binding: freezeCanonical({
          queueItemId: Q1,
          sourceIdentity: 'runtime-seek-cohort-source',
          transferSessionId: 'runtime-seek-cohort-transfer',
        }),
        metadata: freezeCanonical({ name: 'runtime-seek.wav', mime: 'audio/wav' }),
        encodedSize: 1_024,
        peerRangeManifest: null,
      }),
    }) as unknown as Readonly<HostPreparedLocalTrack>;
    const timeline = freezeCanonical({
      revision: prepared.state.revision,
      phase: 'playing' as const,
      run: freezeCanonical({ queueItemId: Q1, runId: prepared.state.runId }),
      positionSeconds: prepared.positionSeconds,
      rate: prepared.playbackRate,
      anchorMonotonicMs: 10_000,
    }) as Readonly<PlaybackTimelineSnapshot>;
    const resolveSource = vi.fn(async () => {
      throw new Error('same-run seek must not reacquire source bytes');
    });
    room.seekPlayingWithCohort.mockImplementationOnce(async (input) => {
      const remotes = await input.prepareRemoteParticipants(
        freezeCanonical({ prepared, signal: input.signal, resolveSource }),
      );
      expect(remotes).toEqual([capability]);
      return freezeCanonical({
        ...candidateResult(
          prepared.roomGeneration,
          room.options.hostRoomSnapshot.applicationSessionId,
          'seek-playing-cohort',
        ),
        timeline,
      }) as Readonly<FilePlaybackProductHostLocalTrackCommit>;
    });
    const signal = new AbortController().signal;

    await expect(setup.runtime.seekPlaying({ positionSeconds: 24, signal })).resolves.toMatchObject(
      {
        timeline,
      },
    );

    expect(room.seekPlayingWithCohort).toHaveBeenCalledWith(
      expect.objectContaining({ positionSeconds: 24, signal }),
    );
    expect(room.seekPlaying).not.toHaveBeenCalled();
    expect(publishPrepared).toHaveBeenCalledWith(prepared);
    expect(bindPrepared).toHaveBeenCalledWith(prepared);
    expect(whenPreparedRemoteReady).toHaveBeenCalledWith(prepared);
    expect(activatePrepared).toHaveBeenCalledWith({
      prepared,
      timeline,
      initialCohortAdmitted: true,
    });
    expect(resolveSource).not.toHaveBeenCalled();
  });

  it('publishes and binds the prepared remote cohort before starting a replay run', async () => {
    const routers: ProductRouterHarness[] = [];
    const order: string[] = [];
    const capability = freezeCanonical({
      participant: freezeCanonical({ participantId: 'runtime-replay-cohort-guest' }),
      bindAttempt: vi.fn(async () => undefined),
    }) as unknown as Readonly<HostPreparedRemoteParticipant>;
    const publishPrepared = vi.fn(async (prepared: Readonly<HostPreparedLocalTrack>) => {
      order.push('remote:offer');
      return freezeCanonical({ schemaVersion: 1, prepared }) as never;
    });
    const bindPrepared = vi.fn(async (prepared: Readonly<HostPreparedLocalTrack>) => {
      order.push('remote:bind');
      return freezeCanonical({ schemaVersion: 1, prepared }) as never;
    });
    const whenPreparedRemoteReady = vi.fn(async () => {
      order.push('remote:ready');
      return capability;
    });
    const activatePrepared = vi.fn(() => freezeCanonical({ schemaVersion: 1 }) as never);
    const hostOwner = Object.freeze({
      onHostReady: vi.fn(),
      adoptWireMessage: vi.fn(),
      adoptPeerRangeControl: vi.fn(),
      revoke: vi.fn(),
      stageCurrentTransition: vi.fn(),
      stageRemoteEnd: vi.fn(),
      commitCurrentTimeline: vi.fn(),
      publishCurrent: vi.fn(async () => freezeCanonical({ schemaVersion: 1 }) as never),
      publishSourceLease: vi.fn(async () => freezeCanonical({ schemaVersion: 1 }) as never),
      retireSourceLease: vi.fn(async () => undefined),
      publishPrepared,
      bindPrepared,
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
        createHostMediaOwner: () => hostOwner,
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('replay-cohort-runtime-host');
    routers[0]!.options.createHostMediaOwner(
      routerContext('host', { suffix: 'replay-cohort-runtime' }),
    );
    const room = setup.hostRooms[0]!;
    const prepared = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: room.options.hostRoomSnapshot.roomGeneration,
      backend: 'bounded-stream' as const,
      state: freezeCanonical({
        queueItemId: Q1,
        runId: 'runtime-replay-cohort-run',
        revision: 3,
      }),
      positionSeconds: 0,
      playbackRate: 1,
      asset: freezeCanonical({
        kind: 'encoded' as const,
        binding: freezeCanonical({
          queueItemId: Q1,
          sourceIdentity: 'runtime-replay-cohort-source',
          transferSessionId: 'runtime-replay-cohort-transfer',
        }),
        metadata: freezeCanonical({ name: 'runtime-replay.wav', mime: 'audio/wav' }),
        encodedSize: 1_024,
        peerRangeManifest: null,
      }),
      sourceLease: null,
    }) as Readonly<HostPreparedLocalTrack>;
    const timeline = freezeCanonical({
      revision: prepared.state.revision,
      phase: 'playing' as const,
      run: freezeCanonical({ queueItemId: Q1, runId: prepared.state.runId }),
      positionSeconds: 0,
      rate: 1,
      anchorMonotonicMs: 12_000,
    }) as Readonly<PlaybackTimelineSnapshot>;
    room.replayCurrentWithCohort.mockImplementationOnce(async (input) => {
      const remotes = await input.prepareRemoteParticipants(
        freezeCanonical({
          prepared,
          signal: input.signal,
          resolveSource: vi.fn(async () => localFile('runtime-replay.wav')),
        }),
      );
      expect(remotes).toEqual([capability]);
      order.push('room:replay-start');
      return freezeCanonical({
        ...candidateResult(
          prepared.roomGeneration,
          room.options.hostRoomSnapshot.applicationSessionId,
          'replay-cohort',
        ),
        timeline,
      }) as Readonly<FilePlaybackProductHostLocalTrackCommit>;
    });
    const signal = new AbortController().signal;

    await expect(setup.runtime.replayCurrent({ signal })).resolves.toMatchObject({ timeline });

    expect(room.replayCurrentWithCohort).toHaveBeenCalledWith(expect.objectContaining({ signal }));
    expect(room.replayCurrent).not.toHaveBeenCalled();
    expect(order).toEqual(['remote:offer', 'remote:bind', 'remote:ready', 'room:replay-start']);
    expect(activatePrepared).toHaveBeenCalledWith({
      prepared,
      timeline,
      initialCohortAdmitted: true,
    });
  });

  it('serializes a late READY owner from the previous seek revision into canonical truth', async () => {
    const routers: ProductRouterHarness[] = [];
    const previousPublication = freezeCanonical({
      schemaVersion: 1,
      fixtureRevision: 'previous',
    }) as unknown as Readonly<HostPeerPlaybackPublication>;
    const canonicalPublication = freezeCanonical({
      schemaVersion: 1,
      fixtureRevision: 'canonical',
    }) as unknown as Readonly<HostPeerPlaybackPublication>;
    const previousPublicationGate = deferred<void>();
    const publicationEvents: string[] = [];
    const observedPublications: Array<Readonly<HostPeerPlaybackPublication> | null> = [];
    let publicationSequence = 0;
    let room: ProductHostRoomHarness | null = null;
    const publishCurrent = vi.fn(async () => {
      publicationSequence += 1;
      const sequence = publicationSequence;
      publicationEvents.push(`start-${sequence}`);
      observedPublications.push(room?.port.currentPeerPublication() ?? null);
      if (sequence === 1) await previousPublicationGate.promise;
      publicationEvents.push(`end-${sequence}`);
      return freezeCanonical({ schemaVersion: 1 }) as never;
    });
    const lateOwner = Object.freeze({
      onHostReady: vi.fn(),
      adoptWireMessage: vi.fn(),
      adoptPeerRangeControl: vi.fn(),
      revoke: vi.fn(),
      stageCurrentTransition: vi.fn(),
      stageRemoteEnd: vi.fn(),
      commitCurrentTimeline: vi.fn(),
      publishCurrent,
      publishSourceLease: vi.fn(async () => freezeCanonical({ schemaVersion: 1 }) as never),
      retireSourceLease: vi.fn(async () => undefined),
      publishPrepared: vi.fn(),
      bindPrepared: vi.fn(),
      whenPreparedRemoteReady: vi.fn(),
      activatePrepared: vi.fn(),
      retirePrepared: vi.fn(async () => undefined),
    });
    const setup = harness({
      mediaFactoriesForTests: {
        createSessionRouter: (options) => {
          const candidate = productRouterHarness(options);
          routers.push(candidate);
          return candidate.port;
        },
        createHostMediaOwner: () => lateOwner,
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('seek-late-ready-host');
    room = setup.hostRooms[0]!;
    room.setCurrentPeerPublication(previousPublication);
    const lateContext = routerContext('host', { suffix: 'seek-late-ready' });
    const prepared = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: room.options.hostRoomSnapshot.roomGeneration,
      backend: 'bounded-stream' as const,
      state: freezeCanonical({
        queueItemId: Q1,
        runId: 'seek-late-ready-run',
        revision: 2,
      }),
      positionSeconds: 36,
      playbackRate: 1,
      asset: freezeCanonical({
        kind: 'encoded' as const,
        binding: freezeCanonical({
          queueItemId: Q1,
          sourceIdentity: 'seek-late-ready-source',
          transferSessionId: 'seek-late-ready-transfer',
        }),
        metadata: freezeCanonical({ name: 'seek-late-ready.wav', mime: 'audio/wav' }),
        encodedSize: 2_048,
        peerRangeManifest: null,
      }),
    }) as unknown as Readonly<HostPreparedLocalTrack>;
    const timeline = freezeCanonical({
      revision: prepared.state.revision,
      phase: 'playing' as const,
      run: freezeCanonical({ queueItemId: Q1, runId: prepared.state.runId }),
      positionSeconds: prepared.positionSeconds,
      rate: prepared.playbackRate,
      anchorMonotonicMs: 12_000,
    }) as Readonly<PlaybackTimelineSnapshot>;
    room.seekPlayingWithCohort.mockImplementationOnce(async (input) => {
      const remotes = await input.prepareRemoteParticipants(
        freezeCanonical({
          prepared,
          signal: input.signal,
          resolveSource: vi.fn(async () => {
            throw new Error('same-run seek must not reacquire source bytes');
          }),
        }),
      );
      expect(remotes).toEqual([]);
      const wrapped = routers[0]!.options.createHostMediaOwner(lateContext);
      wrapped.onHostReady?.(hostReadySnapshot(setup, lateContext));
      await vi.waitFor(() => expect(publishCurrent).toHaveBeenCalledOnce());
      room?.setCurrentPeerPublication(canonicalPublication);
      return freezeCanonical({
        ...candidateResult(
          prepared.roomGeneration,
          room!.options.hostRoomSnapshot.applicationSessionId,
          'seek-late-ready',
        ),
        timeline,
      }) as Readonly<FilePlaybackProductHostLocalTrackCommit>;
    });

    await expect(
      setup.runtime.seekPlaying({
        positionSeconds: prepared.positionSeconds,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ timeline });

    expect(publishCurrent).toHaveBeenCalledOnce();
    expect(observedPublications).toEqual([previousPublication]);
    expect(setup.sessions.closeConnection).not.toHaveBeenCalled();
    previousPublicationGate.resolve();
    await vi.waitFor(() => expect(publishCurrent).toHaveBeenCalledTimes(2));
    expect(observedPublications).toEqual([previousPublication, canonicalPublication]);
    expect(publicationEvents).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
    expect(lateOwner.publishPrepared).not.toHaveBeenCalled();
    expect(lateOwner.bindPrepared).not.toHaveBeenCalled();
    expect(lateOwner.activatePrepared).not.toHaveBeenCalled();
    expect(setup.sessions.closeConnection).not.toHaveBeenCalled();
  });

  it('binds each fast owner after its own OFFER without waiting for a slow owner', async () => {
    const routers: ProductRouterHarness[] = [];
    const firstOfferGate = deferred<void>();
    const capabilities = [0, 1].map(
      (index) =>
        freezeCanonical({
          participant: freezeCanonical({ participantId: `offer-barrier-guest-${index}` }),
          bindAttempt: vi.fn(async () => undefined),
        }) as unknown as Readonly<HostPreparedRemoteParticipant>,
    );
    const owners = capabilities.map((capability, index) =>
      Object.freeze({
        onHostReady: vi.fn(),
        adoptWireMessage: vi.fn(),
        adoptPeerRangeControl: vi.fn(),
        revoke: vi.fn(),
        stageCurrentTransition: vi.fn(),
        stageRemoteEnd: vi.fn(),
        commitCurrentTimeline: vi.fn(),
        publishCurrent: vi.fn(async () => freezeCanonical({ schemaVersion: 1 }) as never),
        publishSourceLease: vi.fn(async () => freezeCanonical({ schemaVersion: 1 }) as never),
        retireSourceLease: vi.fn(async () => undefined),
        publishPrepared: vi.fn(async (prepared: Readonly<HostPreparedLocalTrack>) => {
          if (index === 0) await firstOfferGate.promise;
          return freezeCanonical({ schemaVersion: 1, prepared }) as never;
        }),
        bindPrepared: vi.fn(
          async (prepared: Readonly<HostPreparedLocalTrack>) =>
            freezeCanonical({ schemaVersion: 1, prepared }) as never,
        ),
        whenPreparedRemoteReady: vi.fn(async () => capability),
        activatePrepared: vi.fn(() => freezeCanonical({ schemaVersion: 1 }) as never),
        retirePrepared: vi.fn(async () => undefined),
      }),
    );
    let ownerIndex = 0;
    const setup = harness({
      mediaFactoriesForTests: {
        createSessionRouter: (options) => {
          const candidate = productRouterHarness(options);
          routers.push(candidate);
          return candidate.port;
        },
        createHostMediaOwner: () => owners[ownerIndex++]!,
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('offer-barrier-host');
    routers[0]!.options.createHostMediaOwner(routerContext('host', { suffix: 'offer-barrier-a' }));
    routers[0]!.options.createHostMediaOwner(routerContext('host', { suffix: 'offer-barrier-b' }));
    const room = setup.hostRooms[0]!;
    const file = localFile('offer-barrier.wav');
    const prepared = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: room.options.hostRoomSnapshot.roomGeneration,
      backend: 'bounded-stream' as const,
      state: freezeCanonical({
        queueItemId: Q1,
        runId: 'offer-barrier-run',
        revision: 1,
      }),
      positionSeconds: 0,
      playbackRate: 1,
      asset: freezeCanonical({
        kind: 'encoded' as const,
        binding: freezeCanonical({
          queueItemId: Q1,
          sourceIdentity: 'offer-barrier-source',
          transferSessionId: 'offer-barrier-transfer',
        }),
        metadata: freezeCanonical({ name: file.name, mime: file.type }),
        encodedSize: file.size,
        peerRangeManifest: null,
      }),
    }) as unknown as Readonly<HostPreparedLocalTrack>;
    const timeline = freezeCanonical({
      revision: 1,
      phase: 'playing' as const,
      run: freezeCanonical({ queueItemId: Q1, runId: prepared.state.runId }),
      positionSeconds: 0,
      rate: 1,
      anchorMonotonicMs: 9_000,
    }) as Readonly<PlaybackTimelineSnapshot>;
    room.startLocalTrackWithCohort.mockImplementationOnce(async (input) => {
      const remotes = await input.prepareRemoteParticipants(
        freezeCanonical({
          prepared,
          signal: input.signal,
          resolveSource: vi.fn(async () => file),
        }),
      );
      expect(remotes).toEqual(capabilities);
      return freezeCanonical({
        ...candidateResult(
          prepared.roomGeneration,
          room.options.hostRoomSnapshot.applicationSessionId,
          'offer-barrier',
        ),
        timeline,
      }) as Readonly<FilePlaybackProductHostLocalTrackCommit>;
    });

    const committed = setup.runtime.startLocalTrack({
      queueItemId: Q1,
      file,
      positionSeconds: 0,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => {
      expect(owners[0]?.publishPrepared).toHaveBeenCalledOnce();
      expect(owners[1]?.publishPrepared).toHaveBeenCalledOnce();
      expect(owners[1]?.bindPrepared).toHaveBeenCalledWith(prepared);
      expect(owners[1]?.whenPreparedRemoteReady).toHaveBeenCalledWith(prepared);
    });
    expect(owners[0]?.bindPrepared).not.toHaveBeenCalled();

    firstOfferGate.resolve();
    await committed;

    expect(owners[0]?.bindPrepared).toHaveBeenCalledWith(prepared);
    expect(owners[1]!.bindPrepared.mock.invocationCallOrder[0]).toBeLessThan(
      owners[0]!.bindPrepared.mock.invocationCallOrder[0]!,
    );
  });

  it('activates late success independently and expires only a never-settling peer', async () => {
    vi.useFakeTimers();
    try {
      const routers: ProductRouterHarness[] = [];
      const lateSourceGate = deferred<HostPeerRangeSource>();
      const neverSettlingGate = deferred<void>();
      const lateOwnerSourceAuthority = new AbortController();
      const events: string[] = [];
      const ownerOptions: Readonly<FilePlaybackProductHostMediaOwnerOptions>[] = [];
      const capabilities = [0, 1, 2].map(
        (index) =>
          freezeCanonical({
            participant: freezeCanonical({ participantId: `late-cohort-guest-${index}` }),
            bindAttempt: vi.fn(async () => undefined),
          }) as unknown as Readonly<HostPreparedRemoteParticipant>,
      );
      const owners = capabilities.map((capability, index) =>
        Object.freeze({
          onHostReady: vi.fn(),
          adoptWireMessage: vi.fn(),
          adoptPeerRangeControl: vi.fn(),
          revoke: vi.fn(),
          stageCurrentTransition: vi.fn(),
          stageRemoteEnd: vi.fn(),
          commitCurrentTimeline: vi.fn(),
          publishCurrent: vi.fn(async () => freezeCanonical({ schemaVersion: 1 }) as never),
          publishSourceLease: vi.fn(async () => freezeCanonical({ schemaVersion: 1 }) as never),
          retireSourceLease: vi.fn(async () => undefined),
          publishPrepared: vi.fn(async (prepared: Readonly<HostPreparedLocalTrack>) => {
            if (index === 1) {
              const resolver = ownerOptions[index]?.resolvePreparedPeerRangeSource;
              if (!resolver) throw new Error('fixture prepared resolver is unavailable');
              const source = await resolver({
                prepared,
                sourceIdentity: prepared.asset.binding.sourceIdentity,
                peerRangeManifest: null,
                signal: lateOwnerSourceAuthority.signal,
              });
              expect(source).toBe(file);
            }
            if (index === 2) await neverSettlingGate.promise;
            events.push(`offer-complete-${index}`);
            return freezeCanonical({ schemaVersion: 1, prepared }) as never;
          }),
          bindPrepared: vi.fn(async (prepared: Readonly<HostPreparedLocalTrack>) => {
            events.push(`bind-${index}`);
            return freezeCanonical({ schemaVersion: 1, prepared }) as never;
          }),
          whenPreparedRemoteReady: vi.fn(async () => capability),
          activatePrepared: vi.fn(() => {
            events.push(`activate-${index}`);
            return freezeCanonical({ schemaVersion: 1 }) as never;
          }),
          retirePrepared: vi.fn(async () => undefined),
        }),
      );
      let ownerIndex = 0;
      const setup = harness({
        mediaFactoriesForTests: {
          createSessionRouter: (options) => {
            const candidate = productRouterHarness(options);
            routers.push(candidate);
            return candidate.port;
          },
          createHostMediaOwner: (options) => {
            ownerOptions.push(options);
            return owners[ownerIndex++]!;
          },
        },
      });
      setup.runtime.initializeBeforeProtocol();
      setup.runtime.beginHostRoom('late-cohort-host');
      const contexts = [0, 1, 2].map((index) =>
        routerContext('host', { suffix: `late-cohort-${index}` }),
      );
      for (const context of contexts) routers[0]!.options.createHostMediaOwner(context);

      const room = setup.hostRooms[0]!;
      const file = localFile('late-cohort.wav');
      const prepared = freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: room.options.hostRoomSnapshot.roomGeneration,
        backend: 'bounded-stream' as const,
        state: freezeCanonical({
          queueItemId: Q1,
          runId: 'late-cohort-run',
          revision: 1,
        }),
        positionSeconds: 0,
        playbackRate: 1,
        asset: freezeCanonical({
          kind: 'encoded' as const,
          binding: freezeCanonical({
            queueItemId: Q1,
            sourceIdentity: 'late-cohort-source',
            transferSessionId: 'late-cohort-transfer',
          }),
          metadata: freezeCanonical({ name: file.name, mime: file.type }),
          encodedSize: file.size,
          peerRangeManifest: null,
        }),
      }) as unknown as Readonly<HostPreparedLocalTrack>;
      const timeline = freezeCanonical({
        revision: 1,
        phase: 'playing' as const,
        run: freezeCanonical({ queueItemId: Q1, runId: prepared.state.runId }),
        positionSeconds: 0,
        rate: 1,
        anchorMonotonicMs: 9_500,
      }) as Readonly<PlaybackTimelineSnapshot>;
      room.startLocalTrackWithCohort.mockImplementationOnce(async (input) => {
        const remotes = await input.prepareRemoteParticipants(
          freezeCanonical({
            prepared,
            signal: input.signal,
            resolveSource: vi.fn(
              (
                _sourceIdentity: string,
                _peerRangeManifest: Readonly<HostPeerRangeManifestPublication> | null,
                signal: AbortSignal,
              ) => {
                expect(signal).toBe(lateOwnerSourceAuthority.signal);
                return lateSourceGate.promise;
              },
            ),
          }),
        );
        expect(remotes).toEqual([capabilities[0]]);
        return freezeCanonical({
          ...candidateResult(
            prepared.roomGeneration,
            room.options.hostRoomSnapshot.applicationSessionId,
            'late-cohort',
          ),
          timeline,
        }) as Readonly<FilePlaybackProductHostLocalTrackCommit>;
      });

      const committedTask = setup.runtime.startLocalTrack({
        queueItemId: Q1,
        file,
        positionSeconds: 0,
        signal: new AbortController().signal,
      });
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
      expect(owners.every((owner) => owner.publishPrepared.mock.calls.length === 1)).toBe(true);
      expect(owners[0]?.bindPrepared).toHaveBeenCalledWith(prepared);
      expect(owners[1]?.bindPrepared).not.toHaveBeenCalled();
      expect(owners[2]?.bindPrepared).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_500);
      await expect(committedTask).resolves.toMatchObject({ timeline });
      expect(owners[0]?.activatePrepared).toHaveBeenCalledWith({
        prepared,
        timeline,
        initialCohortAdmitted: true,
      });
      expect(owners[1]?.activatePrepared).not.toHaveBeenCalled();
      expect(owners[2]?.activatePrepared).not.toHaveBeenCalled();
      expect(setup.sessions.closeConnection).not.toHaveBeenCalled();

      lateSourceGate.resolve(file);
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
      expect(events).toContain('offer-complete-1');
      expect(owners[0]?.bindPrepared).toHaveBeenCalledWith(prepared);
      expect(owners[1]?.bindPrepared).toHaveBeenCalledWith(prepared);
      expect(owners[2]?.bindPrepared).not.toHaveBeenCalled();
      expect(owners[0]?.activatePrepared).toHaveBeenCalledWith({
        prepared,
        timeline,
        initialCohortAdmitted: true,
      });
      expect(owners[1]?.activatePrepared).toHaveBeenCalledWith({
        prepared,
        timeline,
        initialCohortAdmitted: false,
      });
      expect(owners[2]?.activatePrepared).not.toHaveBeenCalled();
      expect(setup.sessions.closeConnection).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(FILE_PLAYBACK_PRODUCT_OFFER_LIFETIME_MS - 2_500);
      for (let index = 0; index < 32; index += 1) await Promise.resolve();

      expect(setup.sessions.closeConnection).toHaveBeenCalledOnce();
      expect(setup.sessions.closeConnection).toHaveBeenCalledWith(contexts[2]?.connection);
      expect(owners[0]?.revoke).not.toHaveBeenCalled();
      expect(owners[1]?.revoke).not.toHaveBeenCalled();
      expect(events.indexOf('offer-complete-1')).toBeLessThan(events.indexOf('bind-1'));
      expect(vi.getTimerCount()).toBe(0);
      setup.runtime.endRoom();
    } finally {
      vi.useRealTimers();
    }
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
    expect(guestOwnerOptions).not.toHaveProperty('boundedRoutePolicy');
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

    const dataChannel = {
      readyState: 'open',
      bufferedAmount: 0,
    };
    const controlChannel = {
      readyState: 'open',
      bufferedAmount: 0,
    };
    Object.assign(peer, { dataChannel, controlChannel });
    const peerControl = freezeCanonical({
      lane: 'control' as const,
      type: 'close-handle' as const,
      connectionId: context.connectionId,
      sourceIdentity: 'runtime-peer-source',
      handleId: 'runtime-peer-handle',
    });
    const sendsBeforePeerGate = setup.sessions.sendRequired.mock.calls.length;
    expect(guestOwnerOptions?.canSendPeerControl(context, peerControl)).toBe(true);
    expect(setup.sessions.sendRequired).toHaveBeenCalledTimes(sendsBeforePeerGate);
    expect(guestOwnerOptions?.sendRequired(context, peerControl)).toBe(true);
    expect(setup.sessions.sendRequired).toHaveBeenCalledTimes(sendsBeforePeerGate + 1);
    expect(setup.sessions.sendRequired).toHaveBeenLastCalledWith(peer, peerControl);

    dataChannel.bufferedAmount = FILE_PLAYBACK_PRODUCT_PEER_RANGE_BUFFERED_AMOUNT_LIMIT + 1;
    expect(guestOwnerOptions?.canSendPeerControl(context, peerControl)).toBe(true);
    controlChannel.bufferedAmount = FILE_PLAYBACK_PRODUCT_PEER_RANGE_BUFFERED_AMOUNT_LIMIT + 1;
    expect(guestOwnerOptions?.canSendPeerControl(context, peerControl)).toBe(false);
    controlChannel.bufferedAmount = 0;
    controlChannel.readyState = 'closing';
    expect(guestOwnerOptions?.canSendPeerControl(context, peerControl)).toBe(false);
    controlChannel.readyState = 'open';
    expect(
      guestOwnerOptions?.canSendPeerControl(
        routerContext('guest', { suffix: 'foreign-peer-control' }),
        peerControl,
      ),
    ).toBe(false);
    expect(setup.sessions.sendRequired).toHaveBeenCalledTimes(sendsBeforePeerGate + 1);

    const projected = vi.fn();
    const stopProjectionObservation = bus.on('player:v2-guest-timeline-rendered', projected);
    const renderedTimeline = freezeCanonical({
      schemaVersion: 1 as const,
      revision: 1,
      phase: 'playing' as const,
      run: freezeCanonical({ queueItemId: Q1, runId: 'runtime-guest-rendered-run' }),
      positionSeconds: 12,
      anchorMonotonicMs: 1_000,
      rate: 1,
    });
    guestOwnerOptions?.onTimelineRendered(renderedTimeline);
    expect(projected).toHaveBeenCalledOnce();
    expect(projected).toHaveBeenCalledWith(Q1, 'playing', 12);

    guestOwnerOptions?.onFatalConnection(
      context,
      new Error('guest media fatal') as Parameters<
        FilePlaybackProductGuestMediaOwnerOptions['onFatalConnection']
      >[1],
    );
    expect(setup.sessions.closeConnection).not.toHaveBeenCalled();
    wrappedOwner.revoke(context);
    await Promise.resolve();
    expect(setup.sessions.closeConnection).toHaveBeenCalledOnce();
    expect(setup.sessions.closeConnection).toHaveBeenCalledWith(peer);
    guestOwnerOptions?.onTimelineRendered(renderedTimeline);
    expect(projected).toHaveBeenCalledOnce();
    stopProjectionObservation();

    Reflect.apply(registryFatal!, undefined, [registryRoomToken!, new Error('registry fatal')]);
    await Promise.resolve();

    expect(setup.endRoom).toHaveBeenCalledOnce();
    expect(routers[0]?.close).not.toHaveBeenCalled();
    expect(manager.clear).toHaveBeenCalledOnce();
    expect(registry?.close).toHaveBeenCalledWith(registryRoomToken);
  });

  it('marks guest room ownership unconfirmed when physical manager cleanup rejects', async () => {
    const failure = new Error('guest manager physical cleanup failed');
    const manager = new FilePlaybackManager();
    vi.spyOn(manager, 'clear').mockRejectedValue(failure);
    const setup = harness({
      mediaFactoriesForTests: {
        createGuestRegistry: (roomToken, onFatalRoom) =>
          new FilePlaybackAssetRegistry({ liveRoomToken: roomToken, onFatalRoom }),
        createGuestManager: () => manager,
      },
    });
    const before = getFilePlaybackUniversalLifecycleSnapshotForTests();

    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginGuestRoom();
    expect(getFilePlaybackUniversalLifecycleSnapshotForTests().kinds.roomOwners.live).toBe(
      before.kinds.roomOwners.live + 1,
    );

    setup.runtime.endRoom();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    const retired = getFilePlaybackUniversalLifecycleSnapshotForTests();
    expect(retired.kinds.roomOwners).toMatchObject({
      live: before.kinds.roomOwners.live,
      retiring: before.kinds.roomOwners.retiring,
      unconfirmed: before.kinds.roomOwners.unconfirmed + 1,
      acquiredTotal: before.kinds.roomOwners.acquiredTotal + 1,
      releasedTotal: before.kinds.roomOwners.releasedTotal,
    });
    expect(retired.forcedRetirements).toBe(before.forcedRetirements + 1);
    expect(manager.clear).toHaveBeenCalledOnce();
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
    expect(setup.hostRooms[0]?.options).not.toHaveProperty('boundedRoutePolicy');
    expect(() => setup.runtime.beginHostRoom('reconnect-must-not-begin-a-room')).toThrow(
      /already owns an active room/u,
    );
    expect(setup.beginHostRoom).toHaveBeenCalledOnce();
  });

  it('pins one opt-in bounded route policy across host and guest room owners', () => {
    const routers: ProductRouterHarness[] = [];
    let hostOwnerOptions: Readonly<FilePlaybackProductHostMediaOwnerOptions> | null = null;
    let guestOwnerOptions: Readonly<FilePlaybackProductGuestMediaOwnerOptions> | null = null;
    const hostOwner = Object.freeze({
      onHostReady: vi.fn(),
      adoptWireMessage: vi.fn(),
      adoptPeerRangeControl: vi.fn(),
      revoke: vi.fn(),
      stageCurrentTransition: vi.fn(),
      stageRemoteEnd: vi.fn(),
      commitCurrentTimeline: vi.fn(),
      publishCurrent: vi.fn(),
      publishSourceLease: vi.fn(),
      retireSourceLease: vi.fn(),
      publishPrepared: vi.fn(),
      bindPrepared: vi.fn(),
      whenPreparedRemoteReady: vi.fn(),
      activatePrepared: vi.fn(),
      retirePrepared: vi.fn(),
    });
    const guestOwner = Object.freeze({
      onTimelineAdopted: vi.fn(),
      onTimelineUpdated: vi.fn(),
      adoptAuxiliaryMessage: vi.fn(),
      adoptWireMessage: vi.fn(),
      adoptPeerRangeBulk: vi.fn(),
      revoke: vi.fn(),
    });
    const setup = harness({
      boundedRoutePolicy: FILE_PLAYBACK_MP3_M4A_V1_BOUNDED_ROUTE_POLICY,
      mediaFactoriesForTests: {
        createSessionRouter: (options) => {
          const candidate = productRouterHarness(options);
          routers.push(candidate);
          return candidate.port;
        },
        createHostMediaOwner: (options) => {
          hostOwnerOptions = options;
          return hostOwner;
        },
        createGuestMediaOwner: (options) => {
          guestOwnerOptions = options;
          return guestOwner;
        },
      },
    });
    setup.runtime.initializeBeforeProtocol();

    setup.runtime.beginHostRoom('bounded-policy-host');
    expect(setup.hostRooms[0]?.options.boundedRoutePolicy).toBe(
      FILE_PLAYBACK_MP3_M4A_V1_BOUNDED_ROUTE_POLICY,
    );
    const hostContext = routerContext('host', {
      connection: connection(),
      suffix: 'bounded-policy-host-owner',
    });
    routers[0]!.options.createHostMediaOwner(hostContext);
    expect(hostOwnerOptions?.boundedRoutePolicy).toBe(
      FILE_PLAYBACK_MP3_M4A_V1_BOUNDED_ROUTE_POLICY,
    );
    setup.runtime.endRoom();

    setup.runtime.beginGuestRoom();
    const context = routerContext('guest', {
      connection: connection(),
      suffix: 'bounded-policy-guest',
    });
    routers[0]!.options.createGuestMediaOwner(context);
    expect(guestOwnerOptions?.boundedRoutePolicy).toBe(
      FILE_PLAYBACK_MP3_M4A_V1_BOUNDED_ROUTE_POLICY,
    );
    setup.runtime.endRoom();
  });

  it('fans scheduled current transitions out to READY owners and isolates one broken peer', async () => {
    const routers: ProductRouterHarness[] = [];
    const owners = [0, 1].map((index) =>
      Object.freeze({
        onHostReady: vi.fn(),
        adoptWireMessage: vi.fn(),
        adoptPeerRangeControl: vi.fn(),
        revoke: vi.fn(),
        stageCurrentTransition: vi.fn(() => {
          if (index === 1) throw new Error('fixture successor send failed');
        }),
        stageRemoteEnd: vi.fn(),
        commitCurrentTimeline: vi.fn(),
        publishCurrent: vi.fn(async () => freezeCanonical({ schemaVersion: 1 }) as never),
        publishSourceLease: vi.fn(),
        retireSourceLease: vi.fn(),
        publishPrepared: vi.fn(),
        bindPrepared: vi.fn(),
        whenPreparedRemoteReady: vi.fn(),
        activatePrepared: vi.fn(),
        retirePrepared: vi.fn(),
      }),
    );
    let ownerIndex = 0;
    const setup = harness({
      mediaFactoriesForTests: {
        createSessionRouter: (options) => {
          const candidate = productRouterHarness(options);
          routers.push(candidate);
          return candidate.port;
        },
        createHostMediaOwner: () => owners[ownerIndex++]!,
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('current-transition-fanout-host');
    setup.hostRooms[0]?.setCurrentPeerPublication(
      freezeCanonical({ schemaVersion: 1 }) as unknown as Readonly<HostPeerPlaybackPublication>,
    );
    const contexts = [
      routerContext('host', { suffix: 'current-transition-good' }),
      routerContext('host', { suffix: 'current-transition-broken' }),
    ];
    const wrapped = contexts.map((context) => routers[0]!.options.createHostMediaOwner(context));
    wrapped.forEach((owner, index) =>
      owner.onHostReady?.(hostReadySnapshot(setup, contexts[index]!)),
    );
    await Promise.resolve();

    const previous = freezeCanonical({
      schemaVersion: 1 as const,
      revision: 1,
      phase: 'playing' as const,
      run: freezeCanonical({ queueItemId: Q1, runId: 'runtime-current-transition-run' }),
      positionSeconds: 3,
      anchorMonotonicMs: 1_000,
      rate: 1,
    });
    const timeline = freezeCanonical({
      ...previous,
      revision: 2,
      phase: 'paused' as const,
      anchorMonotonicMs: 1_200,
    });
    const scheduled = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: setup.controller().snapshot().roomGeneration,
      kind: 'pause' as const,
      from: freezeCanonical({
        queueItemId: Q1,
        runId: 'runtime-current-transition-run',
        revision: 1,
      }),
      to: freezeCanonical({
        queueItemId: Q1,
        runId: 'runtime-current-transition-run',
        revision: 2,
      }),
      atRoomTimeMs: 1_200,
      positionSeconds: null,
    });
    const committed = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: scheduled.roomGeneration,
      kind: 'pause' as const,
      previous,
      timeline,
    });

    setup.hostRooms[0]?.options.onTransitionScheduled?.(scheduled);
    setup.hostRooms[0]?.options.onTimelineCommitted?.(committed);

    expect(owners[0]?.stageCurrentTransition).toHaveBeenCalledWith(scheduled);
    expect(owners[0]?.commitCurrentTimeline).toHaveBeenCalledWith(committed);
    expect(owners[1]?.stageCurrentTransition).toHaveBeenCalledWith(scheduled);
    expect(owners[1]?.commitCurrentTimeline).not.toHaveBeenCalled();
    expect(setup.sessions.closeConnection).toHaveBeenCalledOnce();
    expect(setup.sessions.closeConnection).toHaveBeenCalledWith(contexts[1]?.connection);

    setup.hostRooms[0]?.options.onTimelineCommitted?.(
      freezeCanonical({ ...committed, kind: 'ended' as const }),
    );
    expect(owners[0]?.commitCurrentTimeline).toHaveBeenCalledOnce();
    setup.runtime.endRoom();
  });

  it('fans natural end to the exact READY cohort and isolates a broken remote retirement', async () => {
    const routers: ProductRouterHarness[] = [];
    const owners = [0, 1].map((index) =>
      Object.freeze({
        onHostReady: vi.fn(),
        adoptWireMessage: vi.fn(),
        adoptPeerRangeControl: vi.fn(),
        revoke: vi.fn(),
        stageCurrentTransition: vi.fn(),
        stageRemoteEnd: vi.fn(() => {
          if (index === 1) throw new Error('fixture remote-end send failed');
        }),
        commitCurrentTimeline: vi.fn(),
        publishCurrent: vi.fn(async () => freezeCanonical({ schemaVersion: 1 }) as never),
        publishSourceLease: vi.fn(),
        retireSourceLease: vi.fn(),
        publishPrepared: vi.fn(),
        bindPrepared: vi.fn(),
        whenPreparedRemoteReady: vi.fn(),
        activatePrepared: vi.fn(),
        retirePrepared: vi.fn(),
      }),
    );
    let ownerIndex = 0;
    const setup = harness({
      mediaFactoriesForTests: {
        createSessionRouter: (options) => {
          const candidate = productRouterHarness(options);
          routers.push(candidate);
          return candidate.port;
        },
        createHostMediaOwner: () => owners[ownerIndex++]!,
      },
    });
    setup.runtime.initializeBeforeProtocol();
    setup.runtime.beginHostRoom('natural-end-fanout-host');
    setup.hostRooms[0]?.setCurrentPeerPublication(
      freezeCanonical({ schemaVersion: 1 }) as unknown as Readonly<HostPeerPlaybackPublication>,
    );
    const contexts = [
      routerContext('host', { suffix: 'natural-end-good' }),
      routerContext('host', { suffix: 'natural-end-broken' }),
    ];
    const wrapped = contexts.map((context) => routers[0]!.options.createHostMediaOwner(context));
    wrapped.forEach((owner, index) =>
      owner.onHostReady?.(hostReadySnapshot(setup, contexts[index]!)),
    );
    await Promise.resolve();

    const previous = freezeCanonical({
      schemaVersion: 1 as const,
      revision: 1,
      phase: 'playing' as const,
      run: freezeCanonical({ queueItemId: Q1, runId: 'runtime-natural-end-run' }),
      positionSeconds: 3,
      anchorMonotonicMs: 1_000,
      rate: 1,
    });
    const from = freezeCanonical({
      queueItemId: Q1,
      runId: 'runtime-natural-end-run',
      revision: 1,
    });
    const to = freezeCanonical({ ...from, revision: 2 });
    const required = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: setup.controller().snapshot().roomGeneration,
      from,
      to,
      hostObservedAtRoomTimeMs: 1_500,
    });
    const committed = freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: required.roomGeneration,
      kind: 'ended' as const,
      previous,
      timeline: freezeCanonical({
        schemaVersion: 1 as const,
        revision: 2,
        phase: 'stopped' as const,
        run: null,
        positionSeconds: 0,
        anchorMonotonicMs: 1_500,
        rate: 1,
      }),
    });

    setup.hostRooms[0]?.options.onRemoteEndRequired?.(required);
    setup.hostRooms[0]?.setCurrentPeerPublication(null);
    setup.hostRooms[0]?.options.onTimelineCommitted?.(committed);

    expect(owners[0]?.stageRemoteEnd).toHaveBeenCalledWith(required);
    expect(owners[0]?.commitCurrentTimeline).toHaveBeenCalledWith(committed);
    expect(owners[1]?.stageRemoteEnd).toHaveBeenCalledWith(required);
    expect(owners[1]?.commitCurrentTimeline).not.toHaveBeenCalled();
    expect(setup.sessions.closeConnection).toHaveBeenCalledOnce();
    expect(setup.sessions.closeConnection).toHaveBeenCalledWith(contexts[1]?.connection);
    setup.runtime.endRoom();
  });

  it('never invokes a route-policy accessor and rejects an invalid cohort', () => {
    let reads = 0;
    expect(
      () =>
        new FilePlaybackProductRuntime({
          enabled: false,
          get boundedRoutePolicy() {
            reads += 1;
            return FILE_PLAYBACK_MP3_M4A_V1_BOUNDED_ROUTE_POLICY;
          },
        }),
    ).toThrow(/own enumerable data/i);
    expect(reads).toBe(0);

    expect(
      () =>
        new FilePlaybackProductRuntime({
          enabled: false,
          boundedRoutePolicy: {
            mode: 'format-gated-v1',
            mp3: 'bounded-stream',
            m4aAacLc: 'webcodecs',
            rawAdtsAac: 'automatic',
          } as unknown as FilePlaybackBoundedRoutePolicy,
        }),
    ).toThrow(/raw ADTS AAC route is not supported/i);
  });

  it.each([
    ['ordinary', 'audio-buffer'],
    ['streaming FLAC', 'bounded-stream'],
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

  it.each([
    'warmLocalTrack',
    'clearWarmLocalTrack',
    'seekPlaying',
    'seekPlayingWithCohort',
    'replayCurrentWithCohort',
    'currentTerminalRendererObservation',
  ] as const)('fails host entry when the expanded structural room port omits %s', (method) => {
    const setup = harness({ omitHostRoomMethod: method });
    setup.runtime.initializeBeforeProtocol();

    expect(() => setup.runtime.beginHostRoom('incomplete-port-host')).toThrow(
      /host room factory is invalid/u,
    );

    expect(setup.hostRooms[0]?.close).toHaveBeenCalledOnce();
    expect(setup.runtime.hostRoomSnapshot()).toBeNull();
    expect(setup.controller().snapshot().roomRole).toBeNull();
  });

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
    const warmIntent = { queueItemId: Q2, file: localFile('next-warm.aiff'), signal };
    const warmClear = { queueItemId: Q2, signal };

    const results = [
      await setup.runtime.warmLocalTrack(warmIntent),
      await setup.runtime.clearWarmLocalTrack(warmClear),
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
    expect(room?.warmLocalTrack).toHaveBeenCalledWith(warmIntent);
    expect(room?.clearWarmLocalTrack).toHaveBeenCalledWith(warmClear);
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
    expect(room?.seekPlayingWithCohort).toHaveBeenCalledWith(expect.objectContaining(seek));
    expect(room?.seekPlaying).not.toHaveBeenCalled();
    expect(room?.replayCurrentWithCohort).toHaveBeenCalledWith(expect.objectContaining(current));
    expect(room?.replayCurrent).not.toHaveBeenCalled();
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
    expect(room?.seekPlayingWithCohort).not.toHaveBeenCalled();
    expect(room?.seekPaused).not.toHaveBeenCalled();
    expect(room?.resumeCurrent).not.toHaveBeenCalled();
    expect(room?.replayCurrent).not.toHaveBeenCalled();
    expect(room?.replayCurrentWithCohort).not.toHaveBeenCalled();
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
