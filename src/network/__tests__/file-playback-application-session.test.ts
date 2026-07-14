import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pack, unpack } from 'peerjs-js-binarypack';

import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import type { DataConnection } from '../../types/index.ts';
import {
  FILE_PLAYBACK_CLOCK_PING_TYPE,
  FILE_PLAYBACK_CLOCK_PONG_TYPE,
} from '../file-playback-clock-exchange.ts';
import {
  FilePlaybackApplicationSessionManager,
  installFilePlaybackApplicationSessionHooks,
  type FilePlaybackApplicationSessionHooks,
  type FilePlaybackApplicationSessionManagerOptions,
  type FilePlaybackApplicationReceiveResult,
} from '../file-playback-application-session.ts';
import { getFilePlaybackRoomClock } from '../../player/file-playback-room-clock.ts';
import {
  FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
  FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID,
} from '../../player/file-playback-semantic-cohort.ts';
import {
  FILE_PLAYBACK_SESSION_APPLIED_TYPE,
  FILE_PLAYBACK_SESSION_HELLO_TYPE,
  FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE,
  FILE_PLAYBACK_SESSION_WELCOME_TYPE,
  FilePlaybackHandshakeIdIssuer,
} from '../file-playback-session-handshake.ts';
import { markQueueAuthorityReady } from '../queue-authority.ts';
import type {
  FilePlaybackWireMediaBinding,
  FilePlaybackWireStateLease,
} from '../../player/file-playback-wire-binding.ts';
import {
  FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_MAX_RAW_FRAME_BYTES,
  FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE,
  FILE_MEDIA_SOURCE_OFFER_V2_TYPE,
  FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE,
  FILE_PLAYBACK_PRODUCT_READY_V2_TYPE,
  FILE_PLAYBACK_RUN_BINDING_V2_TYPE,
  FILE_PLAYBACK_TIMELINE_UPDATE_V2_MAX_RAW_FRAME_BYTES,
  FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE,
} from '../file-playback-transport-contract.ts';
import {
  createPeerRangeChunkFrames,
  createPeerRangeReadFrame,
} from '../../player/sources/peer-range-protocol.ts';
import { createFilePlaybackProductReadyV2 } from '../../player/file-playback-product-baseline.ts';

interface QueuedFrame {
  readonly from: 'host' | 'guest';
  readonly value: unknown;
}

type TestConnection = DataConnection & {
  sent: unknown[];
  wireInputs: unknown[];
  close: ReturnType<typeof vi.fn>;
  failWhen: ((value: unknown) => boolean) | null;
  reenterWhen: ((value: unknown) => void) | null;
};

function binaryPackRoundTrip(value: unknown): unknown {
  const encoded = pack(value as never);
  if (encoded instanceof Promise) {
    throw new Error('Application-session fixture unexpectedly produced an asynchronous wire body');
  }
  return unpack(encoded);
}

function manualTimers(): {
  options: FilePlaybackApplicationSessionManagerOptions;
  pending: () => number;
  runNext: () => void;
  runDelay: (delayMs: number) => void;
} {
  let nextId = 1;
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  return {
    options: {
      applicationHandshakeDeadlineMs: 50,
      clockCalibrationRetryMs: 10,
      clockCalibrationDeadlineMs: 100,
      maxClockCalibrationAttempts: 15,
      scheduleTimeout(callback, delayMs) {
        const id = nextId++;
        timers.set(id, { callback, delayMs });
        return id;
      },
      cancelTimeout(handle) {
        timers.delete(handle as number);
      },
    },
    pending: () => timers.size,
    runNext: () => {
      const entry = [...timers.entries()].sort((a, b) => a[1].delayMs - b[1].delayMs)[0];
      if (!entry) throw new Error('No pending timer');
      timers.delete(entry[0]);
      entry[1].callback();
    },
    runDelay: (delayMs) => {
      const entry = [...timers.entries()].find(([, timer]) => timer.delayMs === delayMs);
      if (!entry) throw new Error(`No pending ${delayMs}ms timer`);
      timers.delete(entry[0]);
      entry[1].callback();
    },
  };
}

function leakyCancellationTimers(): {
  options: FilePlaybackApplicationSessionManagerOptions;
  handlesForDelay: (delayMs: number) => number[];
  run: (handle: number) => void;
} {
  let nextId = 1;
  const timers = new Map<number, { callback: () => void; delayMs: number; ran: boolean }>();
  return {
    options: {
      applicationHandshakeDeadlineMs: 50,
      clockCalibrationRetryMs: 10,
      clockCalibrationDeadlineMs: 100,
      maxClockCalibrationAttempts: 15,
      scheduleTimeout(callback, delayMs) {
        const id = nextId++;
        timers.set(id, { callback, delayMs, ran: false });
        return id;
      },
      // Simulate a platform adapter that cannot prevent an already queued
      // callback from running. The session's generation fence must own safety.
      cancelTimeout() {},
    },
    handlesForDelay: (delayMs) =>
      [...timers]
        .filter(([, timer]) => timer.delayMs === delayMs && !timer.ran)
        .map(([handle]) => handle),
    run: (handle) => {
      const timer = timers.get(handle);
      if (!timer || timer.ran) throw new Error(`Timer ${handle} is unavailable`);
      timer.ran = true;
      timer.callback();
    },
  };
}

let fixtureSequence = 0;
const liveManagers = new Set<FilePlaybackApplicationSessionManager>();

function issuer(prefix: string): FilePlaybackHandshakeIdIssuer {
  let session = 0;
  let connection = 0;
  let hello = 0;
  return new FilePlaybackHandshakeIdIssuer({
    createSessionId: () => `${prefix}-session-${++session}`,
    createConnectionId: () => `${prefix}-connection-${++connection}`,
    createHelloId: () => `${prefix}-hello-${++hello}`,
  });
}

function fixture(
  options: {
    readonly guestManager?: FilePlaybackApplicationSessionManager;
    readonly guestManagerOptions?: FilePlaybackApplicationSessionManagerOptions;
    readonly hostManagerOptions?: FilePlaybackApplicationSessionManagerOptions;
    readonly binaryPackSends?: boolean;
    readonly bootstrapList?: readonly unknown[];
  } = {},
) {
  fixtureSequence += 1;
  const prefix = `application-${fixtureSequence}`;
  const queue: QueuedFrame[] = [];
  const connection = (role: 'host' | 'guest', peer: string): TestConnection => {
    const close = vi.fn(function (this: TestConnection) {
      this.open = false;
    });
    const result = {
      peer,
      open: true,
      sent: [] as unknown[],
      wireInputs: [] as unknown[],
      close,
      failWhen: null as ((value: unknown) => boolean) | null,
      reenterWhen: null as ((value: unknown) => void) | null,
      send(value: unknown) {
        if (this.failWhen?.(value)) throw new Error(`${role} send failed`);
        this.wireInputs.push(value);
        const delivered = options.binaryPackSends ? binaryPackRoundTrip(value) : value;
        this.sent.push(delivered);
        queue.push({ from: role, value: delivered });
        this.reenterWhen?.(value);
      },
      on: vi.fn(),
    } as unknown as TestConnection;
    return result;
  };

  const hostConn = connection('host', 'guest-participant');
  const guestConn = connection('guest', 'host-participant');
  const host = new FilePlaybackApplicationSessionManager(
    issuer(`${prefix}-host`),
    options.hostManagerOptions,
  );
  const guest =
    options.guestManager ??
    new FilePlaybackApplicationSessionManager(
      issuer(`${prefix}-guest`),
      options.guestManagerOptions,
    );
  liveManagers.add(host);
  liveManagers.add(guest);
  const hostAuthority = host.beginHostRoom('host-participant');
  expect(host.beginHostConnection(hostConn, 'guest-participant')).toBe(true);

  bus.on('network:peer-bootstrap', (_conn, send, acknowledge) => {
    const sent =
      send({
        type: MSG.PLAYLIST_UPDATE,
        list: options.bootstrapList ?? [],
        currentQueueItemId: null,
        revision: 0,
        bootstrap: true,
      }) &&
      send({ type: MSG.REPEAT_MODE, value: 0, _bootstrap: true }) &&
      send({ type: MSG.SHUFFLE_MODE, value: false, _bootstrap: true });
    acknowledge(sent);
  });
  bus.on('network:peer-bootstrap-apply', (frame, conn, acknowledge) => {
    const data = frame as Record<string, unknown>;
    if (data.type === MSG.PLAYLIST_UPDATE) markQueueAuthorityReady(conn);
    acknowledge(
      data.type === MSG.PLAYLIST_UPDATE ||
        data.type === MSG.REPEAT_MODE ||
        data.type === MSG.SHUFFLE_MODE,
    );
  });

  const delivered: Array<{
    readonly endpoint: 'host' | 'guest';
    readonly value: unknown;
    readonly result: Readonly<FilePlaybackApplicationReceiveResult>;
  }> = [];
  const deliverNext = (): QueuedFrame | null => {
    const frame = queue.shift();
    if (!frame) return null;
    if (frame.from === 'guest') {
      delivered.push({
        endpoint: 'host',
        value: frame.value,
        result: host.receive(frame.value, hostConn),
      });
    } else {
      delivered.push({
        endpoint: 'guest',
        value: frame.value,
        result: guest.receive(frame.value, guestConn),
      });
    }
    return frame;
  };
  const pump = (limit = 100): void => {
    let iterations = 0;
    while (queue.length > 0) {
      if (++iterations > limit) throw new Error('Application-session test pump did not quiesce');
      deliverNext();
    }
  };

  return {
    delivered,
    deliverNext,
    guest,
    guestConn,
    host,
    hostAuthority,
    hostConn,
    pump,
    queue,
    startGuest: () => guest.beginGuestConnection(guestConn, 'guest-participant'),
  };
}

const WIRE_MEDIA: FilePlaybackWireMediaBinding = Object.freeze({
  run: Object.freeze({ queueItemId: 'queue-item-wire', runId: 'run-wire', revision: 500 }),
  sourceIdentity: 'source-wire',
  transferSessionId: 'transfer-wire',
});

const AUXILIARY_TYPES = Object.freeze([
  FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE,
  FILE_PLAYBACK_PRODUCT_READY_V2_TYPE,
  FILE_MEDIA_SOURCE_OFFER_V2_TYPE,
  FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE,
  FILE_PLAYBACK_RUN_BINDING_V2_TYPE,
  FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE,
] as const);

function auxiliaryFrame(type: (typeof AUXILIARY_TYPES)[number], sequence = 1) {
  return {
    protocolVersion: 2,
    type,
    sequence,
    marker: `${type}-${sequence}`,
  };
}

function applicationHooks(
  overrides: Partial<FilePlaybackApplicationSessionHooks> = {},
): FilePlaybackApplicationSessionHooks {
  return {
    adoptWireMessage: (_event, acknowledge) => acknowledge(),
    adoptAuxiliaryMessage: (_event, acknowledge) => acknowledge(),
    adoptPeerRangeMessage: (_event, acknowledge) => acknowledge(),
    onLifecycleEvent: () => undefined,
    ...overrides,
  };
}

function bootstrapWirePair(setup: ReturnType<typeof fixture>): Readonly<{
  hostChannel: NonNullable<ReturnType<typeof setup.host.establishedChannel>>;
  guestChannel: NonNullable<ReturnType<typeof setup.guest.establishedChannel>>;
  hostLease: FilePlaybackWireStateLease;
  guestLease: FilePlaybackWireStateLease;
}> {
  const hostChannel = setup.host.establishedChannel(setup.hostConn);
  const guestChannel = setup.guest.establishedChannel(setup.guestConn);
  if (!hostChannel || !guestChannel) throw new Error('Expected established wire channels');
  return {
    hostChannel,
    guestChannel,
    hostLease: hostChannel.bootstrapCurrentMedia(WIRE_MEDIA),
    guestLease: guestChannel.bootstrapCurrentMedia(WIRE_MEDIA),
  };
}

beforeEach(() => {
  bus.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  for (const manager of liveManagers) manager.endRoom();
  liveManagers.clear();
  bus.clear();
});

describe('FilePlaybackApplicationSessionManager', () => {
  it('returns only the frozen identity of the exact session used by host handshakes', () => {
    const setup = fixture();

    expect(setup.hostAuthority).toEqual({
      applicationSessionId: `application-${fixtureSequence}-host-session-1`,
      hostParticipantId: 'host-participant',
    });
    expect(Object.isFrozen(setup.hostAuthority)).toBe(true);
    expect(Reflect.ownKeys(setup.hostAuthority)).toEqual([
      'applicationSessionId',
      'hostParticipantId',
    ]);
    expect(setup.hostAuthority).not.toHaveProperty('clockLease');
    expect(setup.hostAuthority).not.toHaveProperty('sessionId');

    expect(setup.startGuest()).toBe(true);
    setup.pump();
    const welcome = setup.hostConn.sent.find(
      (value) => (value as { type?: string }).type === FILE_PLAYBACK_SESSION_WELCOME_TYPE,
    ) as { sessionId?: unknown } | undefined;
    expect(welcome?.sessionId).toBe(setup.hostAuthority.applicationSessionId);
  });

  it('validates host identity before replacement and issues a fresh authority after teardown', () => {
    let sessionSequence = 0;
    const manager = new FilePlaybackApplicationSessionManager(
      new FilePlaybackHandshakeIdIssuer({
        createSessionId: () => `host-authority-session-${++sessionSequence}`,
        createConnectionId: () => 'host-authority-connection-1',
        createHelloId: () => 'host-authority-hello-1',
      }),
    );
    const first = manager.beginHostRoom('host-authority-a');
    const live = {
      peer: 'authority-guest',
      open: true,
      send: vi.fn(),
      close: vi.fn(function (this: { open: boolean }) {
        this.open = false;
      }),
    } as unknown as DataConnection;
    expect(manager.beginHostConnection(live, 'authority-guest')).toBe(true);

    expect(() => manager.beginHostRoom('bad host identity')).toThrow(
      'host participant ID is invalid',
    );
    expect(sessionSequence).toBe(1);
    expect(manager.phase(live)).toBe('handshaking');
    expect(live.open).toBe(true);

    const second = manager.beginHostRoom('host-authority-b');
    expect(second.applicationSessionId).not.toBe(first.applicationSessionId);
    expect(second.hostParticipantId).toBe('host-authority-b');
    expect(sessionSequence).toBe(2);
    expect(manager.phase(live)).toBe('none');
    expect(live.close).toHaveBeenCalledOnce();
  });

  it('installs descriptor-safe hooks atomically once before session authority starts', () => {
    const manager = new FilePlaybackApplicationSessionManager(issuer('hook-installer'));
    const invalid = applicationHooks() as FilePlaybackApplicationSessionHooks &
      Record<string, unknown>;
    let getterReads = 0;
    Object.defineProperty(invalid, 'adoptAuxiliaryMessage', {
      enumerable: true,
      get() {
        getterReads += 1;
        return () => undefined;
      },
    });
    expect(() => manager.installHooks(invalid)).toThrow('hooks are invalid');
    expect(getterReads).toBe(0);

    const adopted = vi.fn((_event, acknowledge: () => void) => acknowledge());
    const hooks = applicationHooks({ adoptAuxiliaryMessage: adopted });
    expect(() => manager.installHooks(hooks)).not.toThrow();
    expect(() => manager.installHooks(applicationHooks())).toThrow('already installed');

    const setup = fixture({ guestManager: manager });
    expect(setup.startGuest()).toBe(true);
    setup.pump();
    expect(
      setup.guest.receive(auxiliaryFrame(FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE), setup.guestConn),
    ).toMatchObject({ handled: true });
    expect(adopted).toHaveBeenCalledOnce();
    expect(setup.guest.phase(setup.guestConn)).toBe('established');
  });

  it('permanently closes hook installation after a host room has existed', () => {
    const manager = new FilePlaybackApplicationSessionManager(issuer('late-hook-installer'));
    manager.beginHostRoom('late-hook-host');
    manager.endRoom();

    expect(() => manager.installHooks(applicationHooks())).toThrow(
      'before session authority starts',
    );
  });

  it('exports an atomic one-shot installer for the global manager', () => {
    const invalid = { ...applicationHooks(), extra: true } as FilePlaybackApplicationSessionHooks;
    expect(() => installFilePlaybackApplicationSessionHooks(invalid)).toThrow('hooks are invalid');
    expect(() => installFilePlaybackApplicationSessionHooks(applicationHooks())).not.toThrow();
    expect(() => installFilePlaybackApplicationSessionHooks(applicationHooks())).toThrow(
      'already installed',
    );
  });

  it.each([
    [
      'current guest -> universal host',
      FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID,
      FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
    ],
    [
      'universal guest -> current host',
      FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
      FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID,
    ],
  ] as const)(
    'terminates %s before WELCOME, queue bootstrap, or source authority',
    (_label, hostCohort, guestCohort) => {
      const setup = fixture({
        hostManagerOptions: { semanticPlaybackCohortId: hostCohort },
        guestManagerOptions: { semanticPlaybackCohortId: guestCohort },
      });
      expect(setup.startGuest()).toBe(true);
      expect(setup.queue).toHaveLength(1);

      setup.deliverNext();

      expect(setup.delivered[0]?.result).toEqual({
        handled: true,
        established: false,
        clockBecameReady: false,
        rejectionReason: 'semantic-playback-cohort-mismatch',
        updateRequired: true,
      });
      expect(setup.hostConn.sent).toEqual([]);
      expect(setup.queue).toEqual([]);
      expect(setup.host.phase(setup.hostConn)).toBe('none');
      expect(setup.host.establishedChannel(setup.hostConn)).toBeNull();
      expect(setup.hostConn.close).toHaveBeenCalledOnce();
    },
  );

  it('rejects an exact pre-cohort V2 guest before any host bootstrap side effect', () => {
    const setup = fixture();
    expect(setup.startGuest()).toBe(true);
    const queued = setup.queue.shift();
    if (!queued || queued.from !== 'guest') throw new Error('Missing guest HELLO');
    const hello = queued.value as Record<string, unknown>;
    const { semanticPlaybackCohortId: _cohort, ...preCohortHello } = hello;

    expect(setup.host.receive(preCohortHello, setup.hostConn)).toEqual({
      handled: true,
      established: false,
      clockBecameReady: false,
      rejectionReason: 'semantic-playback-cohort-mismatch',
      updateRequired: true,
    });
    expect(setup.hostConn.sent).toEqual([]);
    expect(setup.host.phase(setup.hostConn)).toBe('none');
    expect(setup.hostConn.close).toHaveBeenCalledOnce();
  });

  it('rejects an exact pre-cohort V2 host WELCOME before guest queue apply', () => {
    const setup = fixture();
    expect(setup.startGuest()).toBe(true);
    setup.deliverNext(); // matching HELLO reaches host; WELCOME is now first on the lane
    const queued = setup.queue.shift();
    if (!queued || queued.from !== 'host') throw new Error('Missing host WELCOME');
    const welcome = queued.value as Record<string, unknown>;
    const { semanticPlaybackCohortId: _cohort, ...preCohortWelcome } = welcome;
    const apply = vi.fn();
    bus.clear('network:peer-bootstrap-apply');
    bus.on('network:peer-bootstrap-apply', apply);

    expect(setup.guest.receive(preCohortWelcome, setup.guestConn)).toEqual({
      handled: true,
      established: false,
      clockBecameReady: false,
      rejectionReason: 'semantic-playback-cohort-mismatch',
      updateRequired: true,
    });
    expect(apply).not.toHaveBeenCalled();
    expect(setup.guest.phase(setup.guestConn)).toBe('none');
    expect(setup.guestConn.close).toHaveBeenCalledOnce();
  });

  it('establishes the exact HELLO/WELCOME/bootstrap/SNAPSHOT/APPLIED flow and five-sample clock', () => {
    const setup = fixture();
    expect(setup.startGuest()).toBe(true);
    setup.pump();

    expect(setup.host.phase(setup.hostConn)).toBe('established');
    expect(setup.guest.phase(setup.guestConn)).toBe('established');
    expect(setup.host.establishedChannel(setup.hostConn)?.clockReady()).toBe(true);
    expect(setup.guest.establishedChannel(setup.guestConn)?.clockReady()).toBe(true);
    expect(
      setup.delivered
        .filter(({ result: receiveResult }) => receiveResult.established)
        .map(({ endpoint }) => endpoint),
    ).toEqual(['guest', 'host']);
    expect(
      setup.delivered.some(
        ({ endpoint, result: receiveResult }) =>
          endpoint === 'guest' && receiveResult.clockBecameReady,
      ),
    ).toBe(true);

    const hostTypes = setup.hostConn.sent.map(
      (value) => (value as { type?: string }).type ?? (value as { kind?: string }).kind,
    );
    expect(hostTypes.slice(0, 5)).toEqual([
      FILE_PLAYBACK_SESSION_WELCOME_TYPE,
      MSG.PLAYLIST_UPDATE,
      MSG.REPEAT_MODE,
      MSG.SHUFFLE_MODE,
      FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE,
    ]);
    expect(hostTypes.filter((type) => type === FILE_PLAYBACK_CLOCK_PONG_TYPE)).toHaveLength(5);
    const guestTypes = setup.guestConn.sent.map((value) => (value as { type?: string }).type);
    expect(guestTypes[0]).toBe(FILE_PLAYBACK_SESSION_HELLO_TYPE);
    expect(guestTypes.filter((type) => type === FILE_PLAYBACK_CLOCK_PING_TYPE)).toHaveLength(5);
    expect(guestTypes).toContain(FILE_PLAYBACK_SESSION_APPLIED_TYPE);
  });

  it('materializes canonical object shells for the exact PeerJS BinaryPack transport', () => {
    const setup = fixture({
      binaryPackSends: true,
      bootstrapList: [
        {
          queueItemId: 'binarypack-track',
          metadata: { title: 'Bounded tone', channels: [1, 2] },
        },
      ],
    });
    expect(setup.startGuest()).toBe(true);
    setup.pump();

    expect(setup.host.phase(setup.hostConn)).toBe('established');
    expect(setup.guest.phase(setup.guestConn)).toBe('established');
    expect(setup.host.establishedChannel(setup.hostConn)?.clockReady()).toBe(true);
    expect(setup.guest.establishedChannel(setup.guestConn)?.clockReady()).toBe(true);

    const hello = setup.guestConn.wireInputs[0] as Record<string, unknown>;
    expect(Object.getPrototypeOf(hello)).toBe(Object.prototype);
    expect(Object.isFrozen(hello)).toBe(true);
    expect(hello.type).toBe(FILE_PLAYBACK_SESSION_HELLO_TYPE);

    const playlist = setup.hostConn.wireInputs.find(
      (value) => (value as { type?: string }).type === MSG.PLAYLIST_UPDATE,
    ) as { list: Array<{ metadata: { channels: number[] } }> };
    expect(Object.getPrototypeOf(playlist)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(playlist.list[0]!)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(playlist.list[0]!.metadata)).toBe(Object.prototype);
    expect(playlist.list[0]!.metadata.channels).toEqual([1, 2]);

    const descriptor = {
      connectionId: 'binarypack-range-connection',
      sourceIdentity: 'binarypack-range-source',
      handleId: 'binarypack-range-handle',
      requestId: 'binarypack-range-request',
      offset: 0,
      totalLength: 4,
    } as const;
    const bulk = createPeerRangeChunkFrames(descriptor, new Uint8Array([11, 22, 33, 44]))[0]!;
    expect(setup.host.sendRequired(setup.hostConn, bulk)).toBe(true);

    const wireBulk = setup.hostConn.wireInputs.at(-1) as { payload: ArrayBuffer };
    const deliveredBulk = setup.hostConn.sent.at(-1) as { payload: ArrayBuffer };
    expect(wireBulk.payload).toBe(bulk.payload);
    expect([...new Uint8Array(deliveredBulk.payload)]).toEqual([11, 22, 33, 44]);
  });

  it('carries a canonical auxiliary frame through the exact PeerJS BinaryPack transport', () => {
    const adopted = vi.fn((_event, acknowledge: () => void) => acknowledge());
    const setup = fixture({
      binaryPackSends: true,
      hostManagerOptions: { adoptAuxiliaryMessage: adopted },
    });
    expect(setup.startGuest()).toBe(true);
    setup.pump();
    const binding = setup.guest.establishedChannel(setup.guestConn)?.establishedBinding();
    if (!binding) throw new Error('Expected an established auxiliary channel');
    const ready = createFilePlaybackProductReadyV2({
      sessionId: binding.sessionId,
      connectionId: binding.connectionId,
      baselineId: 'binarypack-auxiliary-baseline',
      guestParticipantId: binding.guestParticipantId,
      playbackRevision: 0,
      observedAtRoomTimeMs: 1_000,
    });

    expect(setup.guest.sendRequired(setup.guestConn, ready)).toBe(true);
    const wireReady = setup.guestConn.wireInputs.at(-1) as Record<string, unknown>;
    expect(Object.getPrototypeOf(ready)).toBeNull();
    expect(Object.getPrototypeOf(wireReady)).toBe(Object.prototype);
    setup.pump();

    expect(adopted).toHaveBeenCalledOnce();
    expect(adopted.mock.calls[0]![0].frame).toMatchObject({
      type: FILE_PLAYBACK_PRODUCT_READY_V2_TYPE,
      baselineId: 'binarypack-auxiliary-baseline',
    });
  });

  it.each([
    ['Blob', () => new Blob(['unsupported'])],
    ['typed array', () => new Uint8Array([1, 2, 3])],
    [
      'cycle',
      () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      },
    ],
    [
      'sparse array',
      () => {
        const value = new Array<unknown>(2);
        value[0] = 'present';
        return value;
      },
    ],
    [
      '33-key record',
      () => Object.fromEntries(Array.from({ length: 33 }, (_value, index) => [`k${index}`, index])),
    ],
    ['reserved constructor key', () => ({ constructor: 'shadowed' })],
    ['oversized binary body', () => new ArrayBuffer(16 * 1024 + 1)],
  ] as const)('fails closed before transport send for a %s wire value', (_label, createValue) => {
    const setup = fixture();
    expect(setup.startGuest()).toBe(true);
    setup.pump();
    const sendsBefore = setup.hostConn.wireInputs.length;

    expect(setup.host.sendRequired(setup.hostConn, createValue())).toBe(false);
    expect(setup.hostConn.wireInputs).toHaveLength(sendsBefore);
    expect(setup.host.phase(setup.hostConn)).toBe('none');
    expect(setup.hostConn.close).toHaveBeenCalledOnce();
  });

  it('does not invoke a wire accessor before failing closed', () => {
    const setup = fixture();
    expect(setup.startGuest()).toBe(true);
    setup.pump();
    let getterReads = 0;
    const value = {} as Record<string, unknown>;
    Object.defineProperty(value, 'hostile', {
      enumerable: true,
      get() {
        getterReads += 1;
        return 'never';
      },
    });
    const sendsBefore = setup.hostConn.wireInputs.length;

    expect(setup.host.sendRequired(setup.hostConn, value)).toBe(false);
    expect(getterReads).toBe(0);
    expect(setup.hostConn.wireInputs).toHaveLength(sendsBefore);
    expect(setup.host.phase(setup.hostConn)).toBe('none');
  });

  it('does not send after materialization reflection closes the exact connection', () => {
    const setup = fixture();
    expect(setup.startGuest()).toBe(true);
    setup.pump();
    let ownKeyReads = 0;
    const value = new Proxy(
      { type: 'MATERIALIZATION_REENTRY' },
      {
        ownKeys(target) {
          ownKeyReads += 1;
          setup.host.closeConnection(setup.hostConn, false);
          return Reflect.ownKeys(target);
        },
      },
    );
    const sendsBefore = setup.hostConn.wireInputs.length;

    expect(setup.host.sendRequired(setup.hostConn, value)).toBe(false);
    expect(ownKeyReads).toBe(1);
    expect(setup.hostConn.wireInputs).toHaveLength(sendsBefore);
    expect(setup.host.phase(setup.hostConn)).toBe('none');
  });

  it('reads an ArrayBuffer byte length through the captured intrinsic only', () => {
    const setup = fixture({ binaryPackSends: true });
    expect(setup.startGuest()).toBe(true);
    setup.pump();
    let getterReads = 0;
    const payload = new ArrayBuffer(4);
    new Uint8Array(payload).set([5, 6, 7, 8]);
    Object.defineProperty(payload, 'byteLength', {
      configurable: true,
      get() {
        getterReads += 1;
        return 4;
      },
    });
    const frame = { type: 'ARRAY_BUFFER_INTRINSIC', payload };

    expect(setup.host.sendRequired(setup.hostConn, frame)).toBe(true);
    expect(getterReads).toBe(0);
    expect((setup.hostConn.wireInputs.at(-1) as { payload: ArrayBuffer }).payload).toBe(payload);
    expect([
      ...new Uint8Array((setup.hostConn.sent.at(-1) as { payload: ArrayBuffer }).payload),
    ]).toEqual([5, 6, 7, 8]);
  });

  it('adopts recognized auxiliary frames synchronously in receive order with exact authority', () => {
    const adopted = vi.fn((_event, acknowledge: () => void) => acknowledge());
    const setup = fixture({ hostManagerOptions: { adoptAuxiliaryMessage: adopted } });
    expect(setup.startGuest()).toBe(true);
    setup.pump();
    const channel = setup.host.establishedChannel(setup.hostConn);
    if (!channel) throw new Error('Expected an established host channel');
    const token = channel.liveConnectionToken();
    if (!token) throw new Error('Expected a live connection token');

    const originals = AUXILIARY_TYPES.map((type, index) => auxiliaryFrame(type, index + 1));
    for (const frame of originals) {
      expect(setup.host.receive(frame, setup.hostConn)).toEqual({
        handled: true,
        established: false,
        clockBecameReady: false,
      });
    }

    expect(adopted).toHaveBeenCalledTimes(AUXILIARY_TYPES.length);
    expect(adopted.mock.calls.map(([event]) => event.frame.type)).toEqual(AUXILIARY_TYPES);
    for (let index = 0; index < originals.length; index += 1) {
      const event = adopted.mock.calls[index]![0];
      expect(event).toMatchObject({
        connection: setup.hostConn,
        channel,
        connectionToken: token,
      });
      expect(event.frame).toEqual(originals[index]);
      expect(event.frame).not.toBe(originals[index]);
      expect(Object.getPrototypeOf(event.frame)).toBeNull();
      expect(Object.isFrozen(event.frame)).toBe(true);
      expect(Object.isFrozen(event)).toBe(true);
    }
    expect(setup.host.phase(setup.hostConn)).toBe('established');
  });

  it('routes peer-range control and bulk frames through exact live connection authority', () => {
    const hostAdopted = vi.fn((_event, acknowledge: () => void) => acknowledge());
    const guestAdopted = vi.fn((_event, acknowledge: () => void) => acknowledge());
    const setup = fixture({
      hostManagerOptions: { adoptPeerRangeMessage: hostAdopted },
      guestManagerOptions: { adoptPeerRangeMessage: guestAdopted },
    });
    expect(setup.startGuest()).toBe(true);
    setup.pump();

    const descriptor = {
      connectionId: 'range-connection',
      sourceIdentity: 'range-source',
      handleId: 'range-handle',
      requestId: 'range-request',
      offset: 0,
      totalLength: 4,
    } as const;
    const control = createPeerRangeReadFrame(descriptor);
    const bulk = createPeerRangeChunkFrames(descriptor, new Uint8Array([1, 2, 3, 4]))[0]!;

    expect(setup.host.receive(control, setup.hostConn)).toMatchObject({ handled: true });
    expect(setup.guest.receive(bulk, setup.guestConn)).toMatchObject({ handled: true });

    const hostChannel = setup.host.establishedChannel(setup.hostConn);
    const guestChannel = setup.guest.establishedChannel(setup.guestConn);
    expect(hostAdopted).toHaveBeenCalledOnce();
    expect(guestAdopted).toHaveBeenCalledOnce();
    expect(hostAdopted.mock.calls[0]![0]).toMatchObject({
      frame: control,
      lane: 'control',
      role: 'host',
      connection: setup.hostConn,
      channel: hostChannel,
      connectionToken: hostChannel?.liveConnectionToken(),
    });
    expect(guestAdopted.mock.calls[0]![0]).toMatchObject({
      frame: bulk,
      lane: 'bulk',
      role: 'guest',
      connection: setup.guestConn,
      channel: guestChannel,
      connectionToken: guestChannel?.liveConnectionToken(),
    });
    // The range parser/transport consumes this raw frame synchronously. The
    // session layer neither retains it nor pays for a second chunk copy.
    expect(hostAdopted.mock.calls[0]![0].frame).toBe(control);
    expect(guestAdopted.mock.calls[0]![0].frame).toBe(bulk);
    expect(Object.isFrozen(hostAdopted.mock.calls[0]![0])).toBe(true);
    expect(Object.isFrozen(guestAdopted.mock.calls[0]![0])).toBe(true);
    expect(setup.host.phase(setup.hostConn)).toBe('established');
    expect(setup.guest.phase(setup.guestConn)).toBe('established');
  });

  it('claims and closes peer-range traffic sent on the wrong role lane', () => {
    const hostAdopted = vi.fn((_event, acknowledge: () => void) => acknowledge());
    const setup = fixture({ hostManagerOptions: { adoptPeerRangeMessage: hostAdopted } });
    expect(setup.startGuest()).toBe(true);
    setup.pump();
    const descriptor = {
      connectionId: 'range-connection',
      sourceIdentity: 'range-source',
      handleId: 'range-handle',
      requestId: 'wrong-role-lane',
      offset: 0,
      totalLength: 1,
    } as const;
    const guestOnlyBulk = createPeerRangeChunkFrames(descriptor, new Uint8Array([1]))[0]!;

    expect(setup.host.receive(guestOnlyBulk, setup.hostConn)).toMatchObject({ handled: true });
    expect(hostAdopted).not.toHaveBeenCalled();
    expect(setup.host.phase(setup.hostConn)).toBe('none');
    expect(setup.hostConn.close).toHaveBeenCalled();
  });

  it('fails closed on an accessor-shaped peer-range protocol claim without invoking it', () => {
    const adopted = vi.fn((_event, acknowledge: () => void) => acknowledge());
    const setup = fixture({ hostManagerOptions: { adoptPeerRangeMessage: adopted } });
    expect(setup.startGuest()).toBe(true);
    setup.pump();
    let getterReads = 0;
    const hostile = { type: 'read', lane: 'control' } as Record<string, unknown>;
    Object.defineProperty(hostile, 'protocol', {
      enumerable: true,
      get() {
        getterReads += 1;
        return 'musixquare-peer-range';
      },
    });

    expect(setup.host.receive(hostile, setup.hostConn)).toMatchObject({ handled: true });
    expect(getterReads).toBe(0);
    expect(adopted).not.toHaveBeenCalled();
    expect(setup.host.phase(setup.hostConn)).toBe('none');
  });

  it.each(['missing', 'zero', 'twice', 'throw'] as const)(
    'tears down when the peer-range adoption sink is %s',
    (mode) => {
      const hostManagerOptions: FilePlaybackApplicationSessionManagerOptions =
        mode === 'missing'
          ? {}
          : {
              adoptPeerRangeMessage(_event, acknowledge) {
                if (mode === 'zero') return;
                if (mode === 'throw') throw new Error('peer-range adoption failed');
                acknowledge();
                acknowledge();
              },
            };
      const setup = fixture({ hostManagerOptions });
      expect(setup.startGuest()).toBe(true);
      setup.pump();
      const control = createPeerRangeReadFrame({
        connectionId: 'range-connection',
        sourceIdentity: 'range-source',
        handleId: 'range-handle',
        requestId: `range-request-${mode}`,
        offset: 0,
        totalLength: 1,
      });

      expect(setup.host.receive(control, setup.hostConn)).toMatchObject({ handled: true });
      expect(setup.host.phase(setup.hostConn)).toBe('none');
      expect(setup.hostConn.close).toHaveBeenCalled();
    },
  );

  it('fails closed when peer-range adoption re-enters the exact connection', () => {
    let setup!: ReturnType<typeof fixture>;
    setup = fixture({
      hostManagerOptions: {
        adoptPeerRangeMessage(event, acknowledge) {
          acknowledge();
          setup.host.receive(event.frame, setup.hostConn);
        },
      },
    });
    expect(setup.startGuest()).toBe(true);
    setup.pump();
    const control = createPeerRangeReadFrame({
      connectionId: 'range-connection',
      sourceIdentity: 'range-source',
      handleId: 'range-handle',
      requestId: 'range-reentry',
      offset: 0,
      totalLength: 1,
    });

    expect(setup.host.receive(control, setup.hostConn)).toMatchObject({ handled: true });
    expect(setup.host.phase(setup.hostConn)).toBe('none');
    expect(setup.hostConn.close).toHaveBeenCalled();
  });

  it.each(['missing', 'zero', 'twice', 'throw'] as const)(
    'tears down when the auxiliary adoption sink is %s',
    (mode) => {
      const hostManagerOptions: FilePlaybackApplicationSessionManagerOptions =
        mode === 'missing'
          ? {}
          : {
              adoptAuxiliaryMessage(_event, acknowledge) {
                if (mode === 'zero') return;
                if (mode === 'throw') throw new Error('auxiliary adoption failed');
                acknowledge();
                acknowledge();
              },
            };
      const setup = fixture({ hostManagerOptions });
      expect(setup.startGuest()).toBe(true);
      setup.pump();

      expect(
        setup.host.receive(auxiliaryFrame(FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE), setup.hostConn),
      ).toMatchObject({ handled: true });
      expect(setup.host.phase(setup.hostConn)).toBe('none');
      expect(setup.hostConn.close).toHaveBeenCalled();
    },
  );

  it('fails closed on auxiliary adoption reentry and publishes revocation before channel close', () => {
    const lifecycle: Array<{ kind: string; channelClosed: boolean | null }> = [];
    let setup!: ReturnType<typeof fixture>;
    setup = fixture({
      hostManagerOptions: {
        adoptAuxiliaryMessage(event, acknowledge) {
          acknowledge();
          setup.host.receive(event.frame, setup.hostConn);
        },
        onLifecycleEvent(event) {
          lifecycle.push({
            kind: event.kind,
            channelClosed: event.channel ? event.channel.isClosed() : null,
          });
        },
      },
    });
    expect(setup.startGuest()).toBe(true);
    setup.pump();

    expect(
      setup.host.receive(auxiliaryFrame(FILE_PLAYBACK_PRODUCT_READY_V2_TYPE), setup.hostConn),
    ).toMatchObject({ handled: true });
    expect(setup.host.phase(setup.hostConn)).toBe('none');
    expect(lifecycle.map((event) => event.kind)).toEqual(['established', 'clock-ready', 'revoked']);
    expect(lifecycle.at(-1)).toEqual({ kind: 'revoked', channelClosed: false });
  });

  it('leaves unknown legacy types untouched but claims malformed or oversized known auxiliary frames', () => {
    const adopted = vi.fn((_event, acknowledge: () => void) => acknowledge());
    const setup = fixture({ hostManagerOptions: { adoptAuxiliaryMessage: adopted } });
    expect(setup.startGuest()).toBe(true);
    setup.pump();

    expect(
      setup.host.receive({ type: 'LEGACY_PRODUCT_MESSAGE', value: 1 }, setup.hostConn),
    ).toEqual({
      handled: false,
      established: false,
      clockBecameReady: false,
    });
    expect(adopted).not.toHaveBeenCalled();
    expect(setup.host.phase(setup.hostConn)).toBe('established');

    expect(
      setup.host.receive(
        {
          type: FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE,
          nested: { forbidden: true },
        },
        setup.hostConn,
      ),
    ).toMatchObject({ handled: true });
    expect(adopted).not.toHaveBeenCalled();
    expect(setup.host.phase(setup.hostConn)).toBe('none');
  });

  it('rejects an oversized source-offer revoke at its 4 KiB raw budget', () => {
    const adopted = vi.fn((_event, acknowledge: () => void) => acknowledge());
    const oversized = fixture({ hostManagerOptions: { adoptAuxiliaryMessage: adopted } });
    expect(oversized.startGuest()).toBe(true);
    oversized.pump();
    expect(FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_MAX_RAW_FRAME_BYTES).toBe(4 * 1024);
    expect(
      oversized.host.receive(
        {
          type: FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE,
          padding: 'x'.repeat(FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_MAX_RAW_FRAME_BYTES),
        },
        oversized.hostConn,
      ),
    ).toMatchObject({ handled: true });
    expect(adopted).not.toHaveBeenCalled();
    expect(oversized.host.phase(oversized.hostConn)).toBe('none');
    expect(oversized.hostConn.close).toHaveBeenCalled();
  });

  it('admits a flat timeline update only within its primitive auxiliary byte budget', () => {
    const adopted = vi.fn((_event, acknowledge: () => void) => acknowledge());
    const accepted = fixture({ guestManagerOptions: { adoptAuxiliaryMessage: adopted } });
    expect(accepted.startGuest()).toBe(true);
    accepted.pump();

    const frame = auxiliaryFrame(FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE, 19);
    expect(accepted.guest.receive(frame, accepted.guestConn)).toMatchObject({ handled: true });
    expect(adopted).toHaveBeenCalledOnce();
    expect(adopted.mock.calls[0]![0].frame).toEqual(frame);
    expect(accepted.guest.phase(accepted.guestConn)).toBe('established');

    expect(
      accepted.guest.receive(
        {
          type: FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE,
          padding: 'x'.repeat(FILE_PLAYBACK_TIMELINE_UPDATE_V2_MAX_RAW_FRAME_BYTES),
        },
        accepted.guestConn,
      ),
    ).toMatchObject({ handled: true });
    expect(accepted.guest.phase(accepted.guestConn)).toBe('none');
    expect(accepted.guestConn.close).toHaveBeenCalled();
  });

  it('claims recognized auxiliary traffic before APPLIED without invoking the sink', () => {
    const adopted = vi.fn((_event, acknowledge: () => void) => acknowledge());
    const setup = fixture({ hostManagerOptions: { adoptAuxiliaryMessage: adopted } });

    expect(
      setup.host.receive(auxiliaryFrame(FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE), setup.hostConn),
    ).toMatchObject({ handled: true });
    expect(adopted).not.toHaveBeenCalled();
    expect(setup.host.phase(setup.hostConn)).toBe('none');
    expect(setup.hostConn.close).toHaveBeenCalledOnce();
  });

  it('adopts each accepted canonical wire frame synchronously exactly once with exact leases', () => {
    const adopted = vi.fn((_event, acknowledge: () => void) => acknowledge());
    const setup = fixture({
      binaryPackSends: true,
      hostManagerOptions: { adoptWireMessage: adopted },
    });
    expect(setup.startGuest()).toBe(true);
    setup.pump();
    const wire = bootstrapWirePair(setup);
    const observedAtRoomTimeMs = wire.guestChannel.nowRoomTimeMs();

    const sent = setup.guest.sendWire(setup.guestConn, wire.guestLease, {
      kind: 'source-not-ready',
      observedAtRoomTimeMs,
      reasonCode: 'still-loading',
      retryable: true,
    });
    expect(sent).not.toBeNull();
    expect(Object.getPrototypeOf(sent!)).toBeNull();
    expect(Object.getPrototypeOf(setup.guestConn.wireInputs.at(-1)!)).toBe(Object.prototype);
    setup.pump();

    expect(adopted).toHaveBeenCalledTimes(1);
    const event = adopted.mock.calls[0]![0];
    expect(event).toMatchObject({
      message: { kind: 'source-not-ready', controlSequence: 1 },
      connection: setup.hostConn,
      channel: wire.hostChannel,
      stateLease: wire.hostLease,
      attemptLease: null,
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(setup.host.phase(setup.hostConn)).toBe('established');
  });

  it('adopts attempt-scoped wire with the exact remote attempt lease', () => {
    const adopted = vi.fn((_event, acknowledge: () => void) => acknowledge());
    const setup = fixture({ guestManagerOptions: { adoptWireMessage: adopted } });
    expect(setup.startGuest()).toBe(true);
    setup.pump();
    const wire = bootstrapWirePair(setup);
    const hostAttempt = wire.hostChannel.stageAttempt(wire.hostLease, 'rendezvous-wire');
    const guestAttempt = wire.guestChannel.stageAttempt(wire.guestLease, 'rendezvous-wire');
    const now = wire.hostChannel.nowRoomTimeMs();

    expect(
      setup.host.sendWire(setup.hostConn, hostAttempt, {
        kind: 'rendezvous-arm',
        rendezvousId: 'rendezvous-wire',
        positionSeconds: 0,
        playbackRate: 1,
        startAtRoomTimeMs: now + 500,
        finalizeByRoomTimeMs: now + 400,
      }),
    ).not.toBeNull();
    setup.pump();

    expect(adopted).toHaveBeenCalledTimes(1);
    expect(adopted.mock.calls[0]![0]).toMatchObject({
      connection: setup.guestConn,
      channel: wire.guestChannel,
      stateLease: wire.guestLease,
      attemptLease: guestAttempt,
      message: { rendezvousId: 'rendezvous-wire' },
    });
  });

  it.each(['missing', 'zero', 'twice', 'throw'] as const)(
    'tears down when the adoption sink is %s',
    (mode) => {
      const hostManagerOptions: FilePlaybackApplicationSessionManagerOptions =
        mode === 'missing'
          ? {}
          : {
              adoptWireMessage(_event, acknowledge) {
                if (mode === 'zero') return;
                if (mode === 'throw') throw new Error('adoption failed');
                acknowledge();
                acknowledge();
              },
            };
      const setup = fixture({ hostManagerOptions });
      expect(setup.startGuest()).toBe(true);
      setup.pump();
      const wire = bootstrapWirePair(setup);
      const now = wire.guestChannel.nowRoomTimeMs();
      expect(
        setup.guest.sendWire(setup.guestConn, wire.guestLease, {
          kind: 'source-not-ready',
          observedAtRoomTimeMs: now,
          reasonCode: 'adoption-contract',
          retryable: true,
        }),
      ).not.toBeNull();
      setup.pump();

      expect(setup.host.phase(setup.hostConn)).toBe('none');
      expect(setup.hostConn.close).toHaveBeenCalled();
    },
  );

  it('keeps the connection alive while stale-dropping a retired known state without adoption', () => {
    const setup = fixture();
    expect(setup.startGuest()).toBe(true);
    setup.pump();
    const wire = bootstrapWirePair(setup);
    const now = wire.guestChannel.nowRoomTimeMs();
    expect(
      setup.guest.sendWire(setup.guestConn, wire.guestLease, {
        kind: 'source-not-ready',
        observedAtRoomTimeMs: now,
        reasonCode: 'late-retired-state',
        retryable: true,
      }),
    ).not.toBeNull();
    wire.hostChannel.retireMedia(wire.hostLease);
    setup.pump();

    expect(setup.host.phase(setup.hostConn)).toBe('established');
    expect(setup.hostConn.close).not.toHaveBeenCalled();
  });

  it('fails closed on adoption reentry and publishes revocation before channel close', () => {
    const lifecycle: Array<{ kind: string; channelClosed: boolean | null }> = [];
    let setup!: ReturnType<typeof fixture>;
    setup = fixture({
      hostManagerOptions: {
        adoptWireMessage(event, acknowledge) {
          acknowledge();
          setup.host.receive(event.message, setup.hostConn);
        },
        onLifecycleEvent(event) {
          lifecycle.push({
            kind: event.kind,
            channelClosed: event.channel ? event.channel.isClosed() : null,
          });
        },
      },
    });
    expect(setup.startGuest()).toBe(true);
    setup.pump();
    const wire = bootstrapWirePair(setup);
    const now = wire.guestChannel.nowRoomTimeMs();
    expect(
      setup.guest.sendWire(setup.guestConn, wire.guestLease, {
        kind: 'source-not-ready',
        observedAtRoomTimeMs: now,
        reasonCode: 'reentrant-adoption',
        retryable: true,
      }),
    ).not.toBeNull();
    setup.pump();

    expect(setup.host.phase(setup.hostConn)).toBe('none');
    expect(lifecycle.map((event) => event.kind)).toEqual(['established', 'clock-ready', 'revoked']);
    expect(lifecycle.at(-1)).toEqual({ kind: 'revoked', channelClosed: false });
  });

  it('fails closed when an adoption sink re-enters the outbound wire lane', () => {
    let setup!: ReturnType<typeof fixture>;
    setup = fixture({
      guestManagerOptions: {
        adoptWireMessage(event, acknowledge) {
          acknowledge();
          expect(
            setup.guest.sendWire(event.connection, event.stateLease, {
              kind: 'source-not-ready',
              observedAtRoomTimeMs: 2_000,
              reasonCode: 'reentrant-send',
              retryable: true,
            }),
          ).toBeNull();
        },
      },
    });
    expect(setup.startGuest()).toBe(true);
    setup.pump();
    const wire = bootstrapWirePair(setup);
    const hostAttempt = wire.hostChannel.stageAttempt(wire.hostLease, 'rendezvous-reentry');
    wire.guestChannel.stageAttempt(wire.guestLease, 'rendezvous-reentry');
    const now = wire.hostChannel.nowRoomTimeMs();

    expect(
      setup.host.sendWire(setup.hostConn, hostAttempt, {
        kind: 'rendezvous-arm',
        rendezvousId: 'rendezvous-reentry',
        positionSeconds: 0,
        playbackRate: 1,
        startAtRoomTimeMs: now + 500,
        finalizeByRoomTimeMs: now + 400,
      }),
    ).not.toBeNull();
    setup.pump();

    expect(setup.guest.phase(setup.guestConn)).toBe('none');
    expect(setup.guestConn.close).toHaveBeenCalled();
  });

  it('closes exact connections on bootstrap failure without publishing establishment', () => {
    const setup = fixture();
    bus.clear('network:peer-bootstrap');
    bus.on('network:peer-bootstrap', (_conn, _send, acknowledge) => acknowledge(false));

    expect(setup.startGuest()).toBe(true);
    setup.pump();

    expect(setup.hostConn.close).toHaveBeenCalledTimes(1);
    expect(setup.host.phase(setup.hostConn)).toBe('none');
    expect(setup.delivered.some(({ result: receiveResult }) => receiveResult.established)).toBe(
      false,
    );
  });

  it('treats APPLIED send success as mandatory and never activates a failed guest channel', () => {
    const setup = fixture();
    setup.guestConn.failWhen = (value) =>
      (value as { type?: string } | null)?.type === FILE_PLAYBACK_SESSION_APPLIED_TYPE;

    expect(setup.startGuest()).toBe(true);
    setup.pump();

    expect(setup.guestConn.close).toHaveBeenCalledTimes(1);
    expect(setup.guest.phase(setup.guestConn)).toBe('none');
    expect(setup.guest.establishedChannel(setup.guestConn)).toBeNull();
    expect(
      setup.delivered.some(
        ({ endpoint, result: receiveResult }) => endpoint === 'guest' && receiveResult.established,
      ),
    ).toBe(false);
  });

  it('invalidates guest temporal authority on wake and recalibrates over five fresh pings', () => {
    const setup = fixture();
    expect(setup.startGuest()).toBe(true);
    setup.pump();
    const channel = setup.guest.establishedChannel(setup.guestConn);
    expect(channel?.clockReady()).toBe(true);

    expect(setup.guest.handleWake(setup.guestConn)).toBe(true);
    expect(channel?.clockReady()).toBe(false);
    expect(
      setup.guest.sendWire(setup.guestConn, {} as FilePlaybackWireStateLease, {
        kind: 'source-not-ready',
        observedAtRoomTimeMs: 1,
        reasonCode: 'wake',
        retryable: true,
      }),
    ).toBeNull();
    expect(
      setup.queue.filter(
        ({ from, value }) =>
          from === 'guest' && (value as { type?: string }).type === FILE_PLAYBACK_CLOCK_PING_TYPE,
      ),
    ).toHaveLength(5);

    setup.pump();
    expect(channel?.clockReady()).toBe(true);
  });

  it('uses exact connection identity for lookup, close, and stale-frame rejection', () => {
    const setup = fixture();
    const stale = { ...setup.hostConn, peer: setup.hostConn.peer } as DataConnection;
    expect(setup.host.phase(stale)).toBe('none');
    expect(setup.host.receive({ type: FILE_PLAYBACK_SESSION_HELLO_TYPE }, stale)).toEqual({
      handled: false,
      established: false,
      clockBecameReady: false,
    });

    setup.host.closeConnection(stale, true);
    expect(setup.hostConn.close).not.toHaveBeenCalled();
    setup.host.closeConnection(setup.hostConn, true);
    expect(setup.hostConn.close).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a replayed HELLO before any application establishment', () => {
    const setup = fixture();
    expect(setup.startGuest()).toBe(true);
    const queuedHello = setup.queue.shift();
    if (!queuedHello || queuedHello.from !== 'guest') throw new Error('Missing queued HELLO');

    expect(setup.host.receive(queuedHello.value, setup.hostConn)).toMatchObject({ handled: true });
    expect(setup.host.phase(setup.hostConn)).toBe('handshaking');
    expect(setup.host.receive(queuedHello.value, setup.hostConn)).toMatchObject({ handled: true });

    expect(setup.host.phase(setup.hostConn)).toBe('none');
    expect(setup.hostConn.close).toHaveBeenCalledOnce();
    expect(setup.delivered.some(({ result: receiveResult }) => receiveResult.established)).toBe(
      false,
    );
  });

  it('closes a provisional connection that sends playback wire traffic before APPLIED', () => {
    const setup = fixture();

    expect(
      setup.host.receive(
        {
          kind: 'source-ready',
          protocolVersion: 2,
        },
        setup.hostConn,
      ),
    ).toEqual({ handled: true, established: false, clockBecameReady: false });
    expect(setup.host.phase(setup.hostConn)).toBe('none');
    expect(setup.hostConn.close).toHaveBeenCalledOnce();
  });

  it('requires exactly one synchronous bootstrap acknowledgement', () => {
    const setup = fixture();
    bus.clear('network:peer-bootstrap');
    bus.on('network:peer-bootstrap', (_conn, send, acknowledge) => {
      send({
        type: MSG.PLAYLIST_UPDATE,
        list: [],
        currentQueueItemId: null,
        revision: 0,
        bootstrap: true,
      });
      send({ type: MSG.REPEAT_MODE, value: 0, _bootstrap: true });
      send({ type: MSG.SHUFFLE_MODE, value: false, _bootstrap: true });
      acknowledge(true);
      acknowledge(true);
    });

    expect(setup.startGuest()).toBe(true);
    setup.pump();

    expect(setup.host.phase(setup.hostConn)).toBe('none');
    expect(setup.hostConn.close).toHaveBeenCalledOnce();
    expect(setup.delivered.some(({ result: receiveResult }) => receiveResult.established)).toBe(
      false,
    );
  });

  it('tears down when any provisional clock response cannot be sent', () => {
    const setup = fixture();
    setup.hostConn.failWhen = (value) =>
      (value as { type?: string } | null)?.type === FILE_PLAYBACK_CLOCK_PONG_TYPE;

    expect(setup.startGuest()).toBe(true);
    setup.pump();

    expect(setup.host.phase(setup.hostConn)).toBe('none');
    expect(setup.hostConn.close).toHaveBeenCalledOnce();
    expect(
      setup.delivered.some(
        ({ endpoint, result: receiveResult }) => endpoint === 'host' && receiveResult.established,
      ),
    ).toBe(false);
  });

  it('owns the guest room-clock lease per exact record across replacement and stale close', () => {
    const guest = new FilePlaybackApplicationSessionManager(issuer('lease-owner'));
    const first = fixture({ guestManager: guest });
    expect(first.startGuest()).toBe(true);
    first.pump();
    expect(guest.phase(first.guestConn)).toBe('established');

    bus.clear();
    const second = fixture({ guestManager: guest });
    expect(second.startGuest()).toBe(true);
    second.pump();
    expect(first.guestConn.close).toHaveBeenCalled();
    expect(guest.phase(first.guestConn)).toBe('none');
    expect(guest.phase(second.guestConn)).toBe('established');
    expect(getFilePlaybackRoomClock().quality().calibrated).toBe(true);

    guest.closeConnection(first.guestConn, true);
    expect(guest.phase(second.guestConn)).toBe('established');
    expect(getFilePlaybackRoomClock().quality().calibrated).toBe(true);
  });

  it('expires host and guest handshakes on exact injected deadlines', () => {
    const hostTimers = manualTimers();
    const host = new FilePlaybackApplicationSessionManager(
      issuer('host-deadline'),
      hostTimers.options,
    );
    const hostConn = {
      peer: 'guest-deadline',
      open: true,
      send: vi.fn(),
      close: vi.fn(function (this: DataConnection) {
        this.open = false;
      }),
    } as unknown as DataConnection;
    host.beginHostRoom('host-deadline');
    expect(host.beginHostConnection(hostConn, 'guest-deadline')).toBe(true);
    hostTimers.runDelay(50);
    expect(host.phase(hostConn)).toBe('none');
    expect(hostConn.close).toHaveBeenCalledOnce();

    const guestTimers = manualTimers();
    const guest = new FilePlaybackApplicationSessionManager(
      issuer('guest-deadline'),
      guestTimers.options,
    );
    const guestConn = {
      peer: 'host-deadline',
      open: true,
      send: vi.fn(),
      close: vi.fn(function (this: DataConnection) {
        this.open = false;
      }),
    } as unknown as DataConnection;
    expect(guest.beginGuestConnection(guestConn, 'guest-deadline')).toBe(true);
    guestTimers.runDelay(50);
    expect(guest.phase(guestConn)).toBe('none');
    expect(guestConn.close).toHaveBeenCalledOnce();
  });

  it('does not continue after a required send synchronously tears down its record', () => {
    const setup = fixture();
    setup.hostConn.reenterWhen = (value) => {
      if ((value as { type?: string }).type === FILE_PLAYBACK_SESSION_WELCOME_TYPE) {
        setup.host.closeConnection(setup.hostConn, false);
      }
    };
    expect(setup.startGuest()).toBe(true);
    setup.deliverNext();

    expect(setup.host.phase(setup.hostConn)).toBe('none');
    expect(setup.hostConn.close).toHaveBeenCalledOnce();
    expect(
      setup.hostConn.sent.filter(
        (value) => (value as { type?: string }).type === MSG.PLAYLIST_UPDATE,
      ),
    ).toHaveLength(0);
  });

  it('snapshots bootstrap own-data once without invoking accessors', () => {
    const setup = fixture();
    expect(setup.startGuest()).toBe(true);
    setup.deliverNext(); // HELLO -> host
    setup.deliverNext(); // WELCOME -> guest
    let getterReads = 0;
    const hostile = {
      type: MSG.PLAYLIST_UPDATE,
      list: [],
      currentQueueItemId: null,
      revision: 0,
    } as Record<string, unknown>;
    Object.defineProperty(hostile, 'bootstrap', {
      enumerable: true,
      get() {
        getterReads += 1;
        return true;
      },
    });

    expect(setup.guest.receive(hostile, setup.guestConn)).toMatchObject({ handled: true });
    expect(getterReads).toBe(0);
    expect(setup.guest.phase(setup.guestConn)).toBe('none');
    expect(setup.guestConn.close).toHaveBeenCalledOnce();
  });

  it('rechecks exact authority after a hostile bootstrap Proxy descriptor pass', () => {
    const setup = fixture();
    expect(setup.startGuest()).toBe(true);
    setup.deliverNext();
    setup.deliverNext();
    const applied = vi.fn();
    bus.clear('network:peer-bootstrap-apply');
    bus.on('network:peer-bootstrap-apply', applied);
    let propertyGets = 0;
    const frame = new Proxy(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [],
        currentQueueItemId: null,
        revision: 0,
        bootstrap: true,
      },
      {
        get(target, key, receiver) {
          propertyGets += 1;
          return Reflect.get(target, key, receiver);
        },
        ownKeys(target) {
          setup.guest.closeConnection(setup.guestConn, false);
          return Reflect.ownKeys(target);
        },
      },
    );

    expect(setup.guest.receive(frame, setup.guestConn)).toMatchObject({ handled: true });
    expect(propertyGets).toBe(0);
    expect(applied).not.toHaveBeenCalled();
    expect(setup.guest.phase(setup.guestConn)).toBe('none');
    expect(setup.guestConn.close).toHaveBeenCalledOnce();
  });

  it('replenishes a lost calibration batch within bounded attempts and becomes ready', () => {
    const timers = manualTimers();
    const setup = fixture({ guestManagerOptions: timers.options });
    expect(setup.startGuest()).toBe(true);
    while (setup.host.phase(setup.hostConn) !== 'established') {
      if (!setup.deliverNext()) throw new Error('Handshake did not establish');
    }
    setup.queue.splice(
      0,
      setup.queue.length,
      ...setup.queue.filter(
        ({ value }) => (value as { type?: string }).type !== FILE_PLAYBACK_CLOCK_PONG_TYPE,
      ),
    );
    expect(setup.guest.phase(setup.guestConn)).toBe('established');
    expect(setup.guest.clockCalibrationState(setup.guestConn)).toBe('calibrating');

    timers.runDelay(10);
    setup.pump();

    expect(setup.guest.clockCalibrationState(setup.guestConn)).toBe('ready');
    expect(setup.guest.establishedChannel(setup.guestConn)?.clockReady()).toBe(true);
    expect(
      setup.guestConn.sent.filter(
        (value) => (value as { type?: string }).type === FILE_PLAYBACK_CLOCK_PING_TYPE,
      ),
    ).toHaveLength(10);
    expect(timers.pending()).toBe(1);
  });

  it('keeps an established guest clock fresh across repeated lease windows', () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const timers = manualTimers();
      const setup = fixture({ guestManagerOptions: timers.options });
      expect(setup.startGuest()).toBe(true);
      setup.pump();
      const channel = setup.guest.establishedChannel(setup.guestConn);
      expect(channel?.clockReady()).toBe(true);
      expect(timers.pending()).toBe(1);

      for (let cycle = 0; cycle < 8; cycle += 1) {
        now += 1_000;
        timers.runDelay(1_000);
        expect(
          setup.queue.filter(
            ({ from, value }) =>
              from === 'guest' &&
              (value as { type?: string }).type === FILE_PLAYBACK_CLOCK_PING_TYPE,
          ),
        ).toHaveLength(1);
        setup.pump();
        expect(setup.guest.clockCalibrationState(setup.guestConn)).toBe('ready');
        expect(channel?.clockReady()).toBe(true);
        expect(channel?.quality()).toMatchObject({
          calibrated: true,
          sampleCount: 6 + cycle,
          ageMs: 0,
        });
        expect(channel?.nowRoomTimeMs()).toBe(now);
        expect(timers.pending()).toBe(1);
      }

      expect(
        setup.guestConn.sent.filter(
          (value) => (value as { type?: string }).type === FILE_PLAYBACK_CLOCK_PING_TYPE,
        ),
      ).toHaveLength(13);
      setup.guest.closeConnection(setup.guestConn, true);
      expect(timers.pending()).toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('retires lost maintenance pings and recalibrates after the clock lease expires', () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const timers = manualTimers();
      const lifecycle: string[] = [];
      const setup = fixture({
        guestManagerOptions: {
          ...timers.options,
          onLifecycleEvent: (event) => lifecycle.push(event.kind),
        },
      });
      expect(setup.startGuest()).toBe(true);
      setup.pump();
      expect(setup.guest.clockCalibrationState(setup.guestConn)).toBe('ready');

      now = 2_000;
      timers.runDelay(1_000);
      const firstPing = setup.deliverNext();
      expect((firstPing?.value as { type?: string }).type).toBe(FILE_PLAYBACK_CLOCK_PING_TYPE);
      const latePong = setup.queue.shift();
      expect((latePong?.value as { type?: string }).type).toBe(FILE_PLAYBACK_CLOCK_PONG_TYPE);

      now = 3_000;
      timers.runDelay(1_000);
      expect(setup.queue).toHaveLength(0);

      now = 4_101;
      timers.runDelay(1_000);
      expect(setup.guest.clockCalibrationState(setup.guestConn)).toBe('calibrating');
      expect(lifecycle).toContain('clock-degraded');
      expect(
        setup.queue.filter(
          ({ from, value }) =>
            from === 'guest' && (value as { type?: string }).type === FILE_PLAYBACK_CLOCK_PING_TYPE,
        ),
      ).toHaveLength(5);

      setup.pump();
      expect(setup.guest.clockCalibrationState(setup.guestConn)).toBe('ready');
      expect(setup.guest.establishedChannel(setup.guestConn)?.clockReady()).toBe(true);
      expect(latePong).toBeDefined();
      expect(setup.guest.receive(latePong!.value, setup.guestConn)).toMatchObject({
        handled: true,
      });
      expect(setup.guestConn.close).not.toHaveBeenCalled();
      expect(timers.pending()).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('rejects a noisy maintenance pong without interrupting an established clock', () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const timers = manualTimers();
      const lifecycle: string[] = [];
      const setup = fixture({
        guestManagerOptions: {
          ...timers.options,
          onLifecycleEvent: (event) => lifecycle.push(event.kind),
        },
      });
      expect(setup.startGuest()).toBe(true);
      setup.pump();
      const channel = setup.guest.establishedChannel(setup.guestConn);
      expect(channel?.quality()).toMatchObject({ calibrated: true, sampleCount: 5, ageMs: 0 });

      now = 2_000;
      timers.runDelay(1_000);
      expect((setup.deliverNext()?.value as { type?: string }).type).toBe(
        FILE_PLAYBACK_CLOCK_PING_TYPE,
      );
      now = 2_018;
      expect((setup.deliverNext()?.value as { type?: string }).type).toBe(
        FILE_PLAYBACK_CLOCK_PONG_TYPE,
      );
      expect(channel?.quality()).toMatchObject({
        calibrated: true,
        sampleCount: 5,
        ageMs: 1_018,
      });
      expect(setup.guest.clockCalibrationState(setup.guestConn)).toBe('ready');
      expect(setup.guestConn.close).not.toHaveBeenCalled();
      expect(lifecycle.filter((kind) => kind === 'clock-degraded')).toHaveLength(0);

      now = 3_000;
      timers.runDelay(1_000);
      setup.pump();
      expect(channel?.quality()).toMatchObject({ calibrated: true, sampleCount: 6, ageMs: 0 });
      expect(lifecycle.filter((kind) => kind === 'clock-ready')).toHaveLength(1);
      expect(timers.pending()).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('fences cancelled and post-teardown maintenance callbacks by generation', () => {
    const timers = leakyCancellationTimers();
    const setup = fixture({ guestManagerOptions: timers.options });
    expect(setup.startGuest()).toBe(true);
    setup.pump();

    const firstMaintenance = timers.handlesForDelay(1_000);
    expect(firstMaintenance).toHaveLength(1);
    timers.run(firstMaintenance[0]!);
    setup.pump();
    const [cancelledMaintenance, currentMaintenance] = timers.handlesForDelay(1_000);
    expect(cancelledMaintenance).toBeDefined();
    expect(currentMaintenance).toBeDefined();

    const pingCount = () =>
      setup.guestConn.sent.filter(
        (value) => (value as { type?: string }).type === FILE_PLAYBACK_CLOCK_PING_TYPE,
      ).length;
    expect(pingCount()).toBe(6);
    timers.run(cancelledMaintenance!);
    expect(pingCount()).toBe(6);

    timers.run(currentMaintenance!);
    expect(pingCount()).toBe(7);
    const [postTeardownMaintenance] = timers.handlesForDelay(1_000);
    expect(postTeardownMaintenance).toBeDefined();
    setup.guest.closeConnection(setup.guestConn, true);
    timers.run(postTeardownMaintenance!);
    expect(pingCount()).toBe(7);
  });

  it('restarts a quality-failed batch and calibrates without tearing down the room', () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const setup = fixture();
      expect(setup.startGuest()).toBe(true);
      while (setup.host.phase(setup.hostConn) !== 'established') {
        if (!setup.deliverNext()) throw new Error('Handshake did not establish');
      }

      // The first five responses arrive with RTT above the calibration quality
      // threshold (but still within the exchange validity window).
      now = 3_000;
      setup.pump();

      expect(setup.guest.clockCalibrationState(setup.guestConn)).toBe('ready');
      expect(setup.guest.establishedChannel(setup.guestConn)?.clockReady()).toBe(true);
      expect(setup.guestConn.close).not.toHaveBeenCalled();
      expect(
        setup.guestConn.sent.filter(
          (value) => (value as { type?: string }).type === FILE_PLAYBACK_CLOCK_PING_TYPE,
        ),
      ).toHaveLength(10);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('degrades bounded calibration without closing the room and wake starts a fresh epoch', () => {
    const timers = manualTimers();
    const lifecycle: string[] = [];
    const setup = fixture({
      guestManagerOptions: {
        ...timers.options,
        onLifecycleEvent: (event) => lifecycle.push(event.kind),
      },
    });
    expect(setup.startGuest()).toBe(true);
    while (setup.host.phase(setup.hostConn) !== 'established') {
      if (!setup.deliverNext()) throw new Error('Handshake did not establish');
    }
    setup.queue.length = 0;

    timers.runDelay(10);
    timers.runDelay(10);
    timers.runDelay(10);
    expect(setup.guest.clockCalibrationState(setup.guestConn)).toBe('degraded');
    expect(setup.guest.phase(setup.guestConn)).toBe('established');
    expect(setup.guestConn.close).not.toHaveBeenCalled();
    expect(lifecycle).toContain('clock-degraded');
    expect(
      setup.guestConn.sent.filter(
        (value) => (value as { type?: string }).type === FILE_PLAYBACK_CLOCK_PING_TYPE,
      ),
    ).toHaveLength(15);

    expect(setup.guest.handleWake(setup.guestConn)).toBe(true);
    expect(setup.guest.clockCalibrationState(setup.guestConn)).toBe('calibrating');
    expect(
      setup.guestConn.sent.filter(
        (value) => (value as { type?: string }).type === FILE_PLAYBACK_CLOCK_PING_TYPE,
      ),
    ).toHaveLength(20);
  });

  it('room reset closes every known transport before removing its protocol gate', () => {
    const setup = fixture();
    expect(setup.host.phase(setup.hostConn)).toBe('handshaking');

    setup.host.endRoom();

    expect(setup.host.phase(setup.hostConn)).toBe('none');
    expect(setup.hostConn.close).toHaveBeenCalledOnce();
    expect(setup.hostConn.open).toBe(false);
  });
});
