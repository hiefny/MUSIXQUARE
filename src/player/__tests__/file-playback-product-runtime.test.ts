import { describe, expect, it, vi } from 'vitest';

import type {
  FilePlaybackApplicationSessionHooks,
  FilePlaybackHostApplicationSessionAuthority,
} from '../../network/file-playback-application-session.ts';
import type { DataConnection } from '../../types/index.ts';
import { FilePlaybackApplicationController } from '../file-playback-application-controller.ts';
import { FilePlaybackProductBaselineIdIssuer } from '../file-playback-product-baseline-session.ts';
import {
  FilePlaybackProductRuntime,
  type FilePlaybackProductRuntimeControllerFactoryInput,
  type FilePlaybackProductRuntimeSessionAdapter,
} from '../file-playback-product-runtime.ts';
import type { PlaybackTimelineSnapshot } from '../playback-timeline.ts';

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
  readonly events: string[];
  controller(): FilePlaybackApplicationController;
  setRoomNow(value: number): void;
}

let harnessSequence = 0;

function harness(
  options: {
    readonly enabled?: boolean;
    readonly installFailure?: Error;
    readonly endFailure?: Error;
    readonly roomNow?: number;
    readonly monotonicNow?: number;
  } = {},
): RuntimeHarness {
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
  const runtime = new FilePlaybackProductRuntime({
    enabled: options.enabled ?? true,
    sessions,
    createController,
    nowMonotonicMs: monotonicNow,
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

function lastBeganTimeline(setup: RuntimeHarness): PlaybackTimelineSnapshot {
  const calls = vi.mocked(setup.controller().beginRoom).mock.calls;
  const timeline = calls.at(-1)?.[0];
  if (!timeline) throw new Error('Controller did not begin a room');
  return timeline;
}

describe('FilePlaybackProductRuntime', () => {
  it('is a complete no-op while its fixed gate is off', () => {
    const setup = harness({ enabled: false });

    expect(setup.runtime.enabled()).toBe(false);
    expect(setup.runtime.initializeBeforeProtocol()).toBe(false);
    expect(setup.runtime.initializeBeforeProtocol()).toBe(false);
    expect(setup.runtime.controller()).toBeNull();
    expect(setup.runtime.hostRoomSnapshot()).toBeNull();
    expect(setup.runtime.beginHostRoom('host-off')).toBe(false);
    expect(setup.runtime.beginGuestRoom()).toBe(false);
    expect(setup.runtime.handleWake(connection())).toBe(false);
    expect(() => setup.runtime.endRoom()).not.toThrow();

    expect(setup.createController).not.toHaveBeenCalled();
    expect(setup.installHooks).not.toHaveBeenCalled();
    expect(setup.beginHostRoom).not.toHaveBeenCalled();
    expect(setup.endRoom).not.toHaveBeenCalled();
    expect(setup.handleWake).not.toHaveBeenCalled();
    expect(setup.roomNow).not.toHaveBeenCalled();
    expect(setup.monotonicNow).not.toHaveBeenCalled();
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
