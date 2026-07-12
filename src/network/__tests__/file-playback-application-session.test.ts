import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import type { DataConnection } from '../../types/index.ts';
import {
  FILE_PLAYBACK_CLOCK_PING_TYPE,
  FILE_PLAYBACK_CLOCK_PONG_TYPE,
} from '../file-playback-clock-exchange.ts';
import {
  FilePlaybackApplicationSessionManager,
  type FilePlaybackApplicationSessionManagerOptions,
  type FilePlaybackApplicationReceiveResult,
} from '../file-playback-application-session.ts';
import { getFilePlaybackRoomClock } from '../../player/file-playback-room-clock.ts';
import {
  FILE_PLAYBACK_SESSION_APPLIED_TYPE,
  FILE_PLAYBACK_SESSION_HELLO_TYPE,
  FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE,
  FILE_PLAYBACK_SESSION_WELCOME_TYPE,
  FilePlaybackHandshakeIdIssuer,
} from '../file-playback-session-handshake.ts';
import { markQueueAuthorityReady } from '../queue-authority.ts';

interface QueuedFrame {
  readonly from: 'host' | 'guest';
  readonly value: unknown;
}

type TestConnection = DataConnection & {
  sent: unknown[];
  close: ReturnType<typeof vi.fn>;
  failWhen: ((value: unknown) => boolean) | null;
  reenterWhen: ((value: unknown) => void) | null;
};

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

let fixtureSequence = 0;

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
      close,
      failWhen: null as ((value: unknown) => boolean) | null,
      reenterWhen: null as ((value: unknown) => void) | null,
      send(value: unknown) {
        if (this.failWhen?.(value)) throw new Error(`${role} send failed`);
        this.sent.push(value);
        queue.push({ from: role, value });
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
  host.beginHostRoom('host-participant');
  expect(host.beginHostConnection(hostConn, 'guest-participant')).toBe(true);

  bus.on('network:peer-bootstrap', (_conn, send, acknowledge) => {
    const sent =
      send({
        type: MSG.PLAYLIST_UPDATE,
        list: [],
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
    hostConn,
    pump,
    queue,
    startGuest: () => guest.beginGuestConnection(guestConn, 'guest-participant'),
  };
}

beforeEach(() => {
  bus.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  bus.clear();
});

describe('FilePlaybackApplicationSessionManager', () => {
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
      setup.guest.sendWire(setup.guestConn, {
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
    expect(timers.pending()).toBe(0);
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
    const setup = fixture({ guestManagerOptions: timers.options });
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
