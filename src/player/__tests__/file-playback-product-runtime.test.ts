import { describe, expect, it, vi } from 'vitest';

import type {
  FilePlaybackApplicationSessionHooks,
  FilePlaybackHostApplicationSessionAuthority,
} from '../../network/file-playback-application-session.ts';
import type { DataConnection, QueueItemId } from '../../types/index.ts';
import { FilePlaybackApplicationController } from '../file-playback-application-controller.ts';
import { FilePlaybackProductBaselineIdIssuer } from '../file-playback-product-baseline-session.ts';
import type {
  FilePlaybackProductHostFirstLocalFileResult,
  FilePlaybackProductHostRoomOptions,
  StartFilePlaybackProductHostFirstLocalFileOptions,
} from '../file-playback-product-host-room.ts';
import {
  FilePlaybackProductRuntime,
  type FilePlaybackProductRuntimeControllerFactoryInput,
  type FilePlaybackProductRuntimeHostRoomPort,
  type FilePlaybackProductRuntimeSessionAdapter,
} from '../file-playback-product-runtime.ts';
import type { PlaybackTimelineSnapshot } from '../playback-timeline.ts';

const Q1 = '98000000-0000-4000-8000-000000000001' as QueueItemId;

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
  readonly close: ReturnType<typeof vi.fn>;
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
    const startFirstLocalFile = vi.fn(
      async (
        _input: StartFilePlaybackProductHostFirstLocalFileOptions,
      ): Promise<FilePlaybackProductHostFirstLocalFileResult> => {
        events.push(`host-room:${index}:start`);
        return Object.freeze({
          schemaVersion: 1 as const,
          status: 'rejected' as const,
          reason: 'replacement-not-supported' as const,
          roomGeneration: roomOptions.hostRoomSnapshot.roomGeneration,
          applicationSessionId: roomOptions.hostRoomSnapshot.applicationSessionId,
          currentQueueItemId: Q1,
        });
      },
    );
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
      close,
      currentRendererSnapshot: vi.fn(() => null),
      positionAt: vi.fn(() => null),
    };
    const room: ProductHostRoomHarness = {
      port,
      options: roomOptions,
      startFirstLocalFile,
      close,
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
    expect(setup.runtime.hostPositionAt(1_000)).toBeNull();
    await expect(
      setup.runtime.startHostFirstLocalFile({
        queueItemId: Q1,
        file: localFile(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/disabled/u);
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

  it('creates the controller and installs its hooks exactly once before protocol', () => {
    const setup = harness({ monotonicNow: 4_321 });

    expect(setup.runtime.initializeBeforeProtocol()).toBe(true);
    const controller = setup.runtime.controller();
    expect(setup.runtime.initializeBeforeProtocol()).toBe(true);

    expect(controller).toBe(setup.controller());
    expect(setup.createController).toHaveBeenCalledOnce();
    expect(setup.installHooks).toHaveBeenCalledOnce();
    expect(setup.installHooks).toHaveBeenCalledWith(controller?.applicationSessionHooks());
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
    expect(setup.createHostRoom).not.toHaveBeenCalled();
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

    expect(setup.hostRooms[1]?.startFirstLocalFile).not.toHaveBeenCalled();
    cleanupGate.resolve();
    await expect(startPromise).resolves.toMatchObject({
      status: 'rejected',
      reason: 'replacement-not-supported',
    });
    expect(setup.hostRooms[1]?.startFirstLocalFile).toHaveBeenCalledOnce();
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

    expect(setup.hostRooms[1]?.startFirstLocalFile).not.toHaveBeenCalled();
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
