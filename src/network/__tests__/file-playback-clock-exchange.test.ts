import { describe, expect, it } from 'vitest';

import {
  FILE_PLAYBACK_CLOCK_PONG_TYPE,
  FILE_PLAYBACK_CLOCK_PROTOCOL_VERSION,
  FilePlaybackClockExchange,
  MAX_FILE_PLAYBACK_CLOCK_TIMESTAMP_MS,
  parseFilePlaybackClockPingV2,
  parseFilePlaybackClockPongV2,
  type FilePlaybackClockPingV2,
  type FilePlaybackClockPongV2,
} from '../file-playback-clock-exchange.ts';

function fakeNow(initial = 1_000) {
  let value = initial;
  return {
    now: () => value,
    set: (next: number) => {
      value = next;
    },
  };
}

function pongFor(
  ping: Readonly<FilePlaybackClockPingV2>,
  t1: number,
  t2 = t1,
): Readonly<FilePlaybackClockPongV2> {
  return Object.freeze({
    type: FILE_PLAYBACK_CLOCK_PONG_TYPE,
    version: FILE_PLAYBACK_CLOCK_PROTOCOL_VERSION,
    sessionId: ping.sessionId,
    connectionId: ping.connectionId,
    pingId: ping.pingId,
    sequence: ping.sequence,
    t0: ping.t0,
    t1,
    t2,
  });
}

function exchangeSample(
  guest: FilePlaybackClockExchange,
  host: FilePlaybackClockExchange,
  guestNow: ReturnType<typeof fakeNow>,
  hostNow: ReturnType<typeof fakeNow>,
  t0: number,
  offsetMs = 100,
  rttMs = 20,
) {
  guestNow.set(t0);
  const ping = guest.createPing();
  hostNow.set(t0 + offsetMs + rttMs / 2);
  const hostResult = host.handlePing(ping);
  expect(hostResult.accepted).toBe(true);
  if (!hostResult.accepted) throw new Error(hostResult.reason);
  guestNow.set(t0 + rttMs);
  return {
    ping,
    pong: hostResult.pong,
    result: guest.handlePong(hostResult.pong),
  };
}

describe('FilePlaybackClockExchange', () => {
  it('feeds an exact four-timestamp offset and RTT sample into the room clock', () => {
    const guestNow = fakeNow();
    const hostNow = fakeNow();
    const guest = new FilePlaybackClockExchange({
      role: 'guest',
      sessionId: 'room-1',
      connectionId: 'connection-1',
      now: guestNow.now,
    });
    const host = new FilePlaybackClockExchange({
      role: 'host',
      sessionId: 'room-1',
      connectionId: 'connection-1',
      now: hostNow.now,
    });

    const { ping, pong, result } = exchangeSample(guest, host, guestNow, hostNow, 1_000);

    expect(ping).toEqual({
      type: 'FILE_PLAYBACK_CLOCK_PING_V2',
      version: 2,
      sessionId: 'room-1',
      connectionId: 'connection-1',
      pingId: 1,
      sequence: 1,
      t0: 1_000,
    });
    expect(pong).toMatchObject({ t0: 1_000, t1: 1_110, t2: 1_110 });
    expect(result).toMatchObject({ accepted: true, rttMs: 20, offsetMs: 100 });
    expect(guest.hostNow()).toBe(1_120);
    expect(guest.nowRoomTimeMs()).toBe(1_120);
    expect(Object.isFrozen(ping)).toBe(true);
    expect(Object.isFrozen(pong)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.accepted) expect(Object.isFrozen(result.quality)).toBe(true);
  });

  it('binds AudioContext mappings to the same calibrated connection clock', () => {
    const guestNow = fakeNow();
    const hostNow = fakeNow();
    const guest = new FilePlaybackClockExchange({
      role: 'guest',
      sessionId: 'room-audio',
      connectionId: 'connection-audio',
      now: guestNow.now,
    });
    const host = new FilePlaybackClockExchange({
      role: 'host',
      sessionId: 'room-audio',
      connectionId: 'connection-audio',
      now: hostNow.now,
    });

    for (let index = 0; index < 5; index += 1) {
      exchangeSample(guest, host, guestNow, hostNow, 1_000 + index * 100, 100, 20);
    }

    const context = { currentTime: 5 } as AudioContext;
    const bindings = guest.bindAudioContext(context);
    expect(bindings.nowRoomTimeMs()).toBe(1_520);
    // Room 1,720ms is local 1,620ms, 200ms after the current local clock.
    expect(bindings.roomTimeMsToContextTime(1_720)).toBeCloseTo(5.2, 10);
    expect(bindings.localPerformanceMsToContextTime(1_620)).toBeCloseTo(5.2, 10);
  });

  it('requires five stable samples before reporting calibrated guest quality', () => {
    const guestNow = fakeNow();
    const hostNow = fakeNow();
    const guest = new FilePlaybackClockExchange({
      role: 'guest',
      sessionId: 'room-2',
      connectionId: 'connection-2',
      now: guestNow.now,
    });
    const host = new FilePlaybackClockExchange({
      role: 'host',
      sessionId: 'room-2',
      connectionId: 'connection-2',
      now: hostNow.now,
    });

    for (let index = 0; index < 4; index += 1) {
      const sample = exchangeSample(
        guest,
        host,
        guestNow,
        hostNow,
        2_000 + index * 100,
        75 + index,
        18 + index,
      );
      expect(sample.result.accepted).toBe(true);
    }
    expect(guest.quality()).toMatchObject({ calibrated: false, sampleCount: 4 });

    exchangeSample(guest, host, guestNow, hostNow, 2_400, 79, 22);
    expect(guest.quality()).toMatchObject({
      calibrated: true,
      offsetMs: 77,
      sampleCount: 5,
    });
  });

  it('rejects malformed and outlier responses without poisoning established samples', () => {
    const now = fakeNow(1_000);
    const guest = new FilePlaybackClockExchange({
      role: 'guest',
      sessionId: 'room-3',
      connectionId: 'connection-3',
      now: now.now,
    });

    expect(guest.handlePong({ type: FILE_PLAYBACK_CLOCK_PONG_TYPE })).toEqual({
      accepted: false,
      reason: 'malformed-message',
    });

    for (let index = 0; index < 3; index += 1) {
      now.set(1_000 + index * 100);
      const ping = guest.createPing();
      now.set(ping.t0 + 20);
      expect(guest.handlePong(pongFor(ping, ping.t0 + 110 + index))).toMatchObject({
        accepted: true,
      });
    }
    const before = guest.quality();

    now.set(1_300);
    const outlierPing = guest.createPing();
    now.set(1_320);
    expect(guest.handlePong(pongFor(outlierPing, outlierPing.t0 + 20_010))).toEqual({
      accepted: false,
      reason: 'offset-outlier',
    });
    expect(guest.quality()).toMatchObject({ sampleCount: 3, offsetMs: before.offsetMs });
  });

  it('snapshots hostile wire records once without invoking accessors', () => {
    const getter = { calls: 0 };
    const accessorPing = {
      type: 'FILE_PLAYBACK_CLOCK_PING_V2',
      version: 2,
      sessionId: 'room-snapshot',
      connectionId: 'connection-snapshot',
      pingId: 1,
      sequence: 1,
      get t0() {
        getter.calls += 1;
        return 1_000;
      },
    };
    const originalPrototypeValue = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
    let pollutedValueReads = 0;
    Object.defineProperty(Object.prototype, 'value', {
      configurable: true,
      get() {
        pollutedValueReads += 1;
        return 1_000;
      },
    });
    let accessorParseResult: ReturnType<typeof parseFilePlaybackClockPingV2>;
    try {
      accessorParseResult = parseFilePlaybackClockPingV2(accessorPing);
    } finally {
      if (originalPrototypeValue) {
        Object.defineProperty(Object.prototype, 'value', originalPrototypeValue);
      } else {
        Reflect.deleteProperty(Object.prototype, 'value');
      }
    }
    expect(accessorParseResult).toBeNull();
    expect(getter.calls).toBe(0);
    expect(pollutedValueReads).toBe(0);

    const descriptorReads = new Map<PropertyKey, number>();
    const target: FilePlaybackClockPingV2 = {
      type: 'FILE_PLAYBACK_CLOCK_PING_V2',
      version: 2,
      sessionId: 'room-snapshot',
      connectionId: 'connection-snapshot',
      pingId: 1,
      sequence: 1,
      t0: 1_000,
    };
    const hostile = new Proxy(target, {
      get() {
        throw new Error('wire fields must never be read through [[Get]]');
      },
      getOwnPropertyDescriptor(object, property) {
        descriptorReads.set(property, (descriptorReads.get(property) ?? 0) + 1);
        const descriptor = Reflect.getOwnPropertyDescriptor(object, property);
        if (!descriptor) return undefined;
        return property === 't0' ? { ...descriptor, value: 1_000 } : descriptor;
      },
    });

    const parsed = parseFilePlaybackClockPingV2(hostile);
    expect(parsed).toEqual(target);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect([...descriptorReads.values()]).toEqual(Array(7).fill(1));
  });

  it('rejects timestamps outside the bounded browser monotonic domain', () => {
    const ping: FilePlaybackClockPingV2 = {
      type: 'FILE_PLAYBACK_CLOCK_PING_V2',
      version: 2,
      sessionId: 'room-bounds',
      connectionId: 'connection-bounds',
      pingId: 1,
      sequence: 1,
      t0: 1_000,
    };
    expect(
      parseFilePlaybackClockPingV2({
        ...ping,
        t0: MAX_FILE_PLAYBACK_CLOCK_TIMESTAMP_MS + 1,
      }),
    ).toBeNull();
    expect(parseFilePlaybackClockPingV2({ ...ping, t0: 1e300 })).toBeNull();
    expect(parseFilePlaybackClockPongV2({ ...pongFor(ping, 1_100), t1: 1e300 })).toBeNull();

    let capturedNow = 1_000;
    const poisonedNow = new FilePlaybackClockExchange({
      role: 'guest',
      sessionId: 'room-bounds',
      connectionId: 'connection-bounds',
      now: () => capturedNow,
    });
    poisonedNow.createPing();
    capturedNow = 1e300;
    expect(() => poisonedNow.createPing()).toThrow(/supported clock range/);
    expect(() => poisonedNow.hostNow()).toThrow(/supported clock range/);
    expect(poisonedNow.pendingPingCount()).toBe(0);
    capturedNow = 1_001;
    expect(poisonedNow.quality().sampleCount).toBe(0);
  });

  it('correlates responses once and isolates wrong identities and echoed fields', () => {
    const now = fakeNow(1_000);
    const guest = new FilePlaybackClockExchange({
      role: 'guest',
      sessionId: 'room-4',
      connectionId: 'connection-4',
      now: now.now,
    });
    const ping = guest.createPing();
    const pong = pongFor(ping, 1_110);

    expect(guest.handlePong({ ...pong, sessionId: 'other-room' })).toEqual({
      accepted: false,
      reason: 'wrong-session',
    });
    expect(guest.handlePong({ ...pong, connectionId: 'other-connection' })).toEqual({
      accepted: false,
      reason: 'wrong-connection',
    });
    expect(guest.pendingPingCount()).toBe(1);

    now.set(1_020);
    expect(guest.handlePong(pong)).toMatchObject({ accepted: true });
    expect(guest.handlePong(pong)).toEqual({ accepted: false, reason: 'unknown-ping' });

    now.set(1_100);
    const corruptPing = guest.createPing();
    expect(guest.handlePong({ ...pongFor(corruptPing, 1_210), t0: corruptPing.t0 + 1 })).toEqual({
      accepted: false,
      reason: 'mismatched-t0',
    });
    expect(guest.handlePong(pongFor(corruptPing, 1_210))).toEqual({
      accepted: false,
      reason: 'unknown-ping',
    });
    expect(guest.quality().sampleCount).toBe(1);
  });

  it('expires and bounds pending pings without accepting their late responses', () => {
    const now = fakeNow(1_000);
    const guest = new FilePlaybackClockExchange({
      role: 'guest',
      sessionId: 'room-5',
      connectionId: 'connection-5',
      now: now.now,
      maxPendingPings: 2,
      pingTimeoutMs: 100,
    });
    const first = guest.createPing();
    now.set(1_010);
    guest.createPing();
    now.set(1_020);
    guest.createPing();
    expect(guest.pendingPingCount()).toBe(2);
    expect(guest.handlePong(pongFor(first, 1_050))).toEqual({
      accepted: false,
      reason: 'unknown-ping',
    });

    now.set(1_200);
    const latest = guest.createPing();
    now.set(1_301);
    expect(guest.handlePong(pongFor(latest, 1_310))).toEqual({
      accepted: false,
      reason: 'expired-ping',
    });
    expect(guest.quality().sampleCount).toBe(0);
  });

  it('invalidates calibration and pending exchanges on wake and session changes', () => {
    const now = fakeNow(1_000);
    const guest = new FilePlaybackClockExchange({
      role: 'guest',
      sessionId: 'room-old',
      connectionId: 'connection-old',
      now: now.now,
    });
    const calibratedPing = guest.createPing();
    now.set(1_020);
    guest.handlePong(pongFor(calibratedPing, 1_110));
    now.set(1_100);
    const wakePending = guest.createPing();

    guest.handleWake();
    expect(guest.pendingPingCount()).toBe(0);
    expect(guest.quality().sampleCount).toBe(0);
    expect(guest.handlePong(pongFor(wakePending, 1_210))).toEqual({
      accepted: false,
      reason: 'unknown-ping',
    });

    now.set(1_200);
    const oldSessionPing = guest.createPing();
    guest.bindSession('room-new', 'connection-new');
    expect(guest.handlePong(pongFor(oldSessionPing, 1_310))).toEqual({
      accepted: false,
      reason: 'wrong-session',
    });
    expect(guest.quality().sampleCount).toBe(0);
  });

  it('makes the host an identity clock and resets samples across role changes', () => {
    const now = fakeNow(4_000);
    const exchange = new FilePlaybackClockExchange({
      role: 'guest',
      sessionId: 'room-6',
      connectionId: 'connection-6',
      now: now.now,
    });
    const ping = exchange.createPing();
    now.set(4_020);
    exchange.handlePong(pongFor(ping, 4_110));
    expect(exchange.quality().sampleCount).toBe(1);

    exchange.setRole('host');
    expect(exchange.hostNow()).toBe(4_020);
    expect(exchange.quality()).toEqual({
      calibrated: true,
      offsetMs: 0,
      minRttMs: 0,
      rttP95Ms: 0,
      offsetSpreadMs: 0,
      sampleCount: 0,
      ageMs: 0,
    });

    exchange.setRole('guest');
    expect(exchange.quality()).toMatchObject({ calibrated: false, sampleCount: 0 });
  });

  it('fails closed and clears temporal state if performance.now reverses', () => {
    const now = fakeNow(1_000);
    const guest = new FilePlaybackClockExchange({
      role: 'guest',
      sessionId: 'room-7',
      connectionId: 'connection-7',
      now: now.now,
    });
    const first = guest.createPing();
    now.set(1_020);
    guest.handlePong(pongFor(first, 1_110));
    now.set(1_100);
    const pending = guest.createPing();

    now.set(1_099);
    expect(guest.handlePong(pongFor(pending, 1_210))).toEqual({
      accepted: false,
      reason: 'performance-clock-reversed',
    });
    expect(guest.pendingPingCount()).toBe(0);
    expect(guest.quality().sampleCount).toBe(0);

    now.set(1_098);
    expect(() => guest.createPing()).toThrow(/moved backwards/);
  });

  it.each(['quality', 'hostNow'] as const)(
    'shares reversal detection with %s and clears pending correlations',
    (readMethod) => {
      const now = fakeNow(1_000);
      const guest = new FilePlaybackClockExchange({
        role: 'guest',
        sessionId: `room-shared-${readMethod}`,
        connectionId: `connection-shared-${readMethod}`,
        now: now.now,
      });
      const calibrated = guest.createPing();
      now.set(1_020);
      expect(guest.handlePong(pongFor(calibrated, 1_110))).toMatchObject({ accepted: true });
      now.set(1_100);
      guest.createPing();
      expect(guest.pendingPingCount()).toBe(1);

      now.set(1_099);
      if (readMethod === 'quality') {
        expect(() => guest.quality()).toThrow(/moved backwards/);
      } else {
        expect(() => guest.hostNow()).toThrow(/moved backwards/);
      }
      expect(guest.pendingPingCount()).toBe(0);
      expect(guest.quality().sampleCount).toBe(0);
    },
  );

  it('rejects and removes a sample if the shared clock reverses during estimator capture', () => {
    const reads = [1_000, 1_020, 1_019];
    const guest = new FilePlaybackClockExchange({
      role: 'guest',
      sessionId: 'room-mid-sample-reversal',
      connectionId: 'connection-mid-sample-reversal',
      now: () => reads.shift() ?? 1_019,
    });
    const ping = guest.createPing();

    expect(guest.handlePong(pongFor(ping, 1_110))).toEqual({
      accepted: false,
      reason: 'performance-clock-reversed',
    });
    expect(guest.pendingPingCount()).toBe(0);
    expect(guest.quality().sampleCount).toBe(0);
  });

  it('reads the local source exactly once for each quality and hostNow call', () => {
    let sourceReads = 0;
    const guest = new FilePlaybackClockExchange({
      role: 'guest',
      sessionId: 'room-single-observation',
      connectionId: 'connection-single-observation',
      now: () => {
        sourceReads += 1;
        return 1_000;
      },
    });

    expect(guest.quality().sampleCount).toBe(0);
    expect(sourceReads).toBe(1);
    expect(guest.hostNow()).toBe(1_000);
    expect(sourceReads).toBe(2);
  });

  it('invalidates pending pings and calibration if the injected source throws', () => {
    const sourceError = new Error('clock source failed');
    let nowMs = 1_000;
    let shouldThrow = false;
    const guest = new FilePlaybackClockExchange({
      role: 'guest',
      sessionId: 'room-source-throw',
      connectionId: 'connection-source-throw',
      now: () => {
        if (shouldThrow) throw sourceError;
        return nowMs;
      },
    });
    const calibrated = guest.createPing();
    nowMs = 1_020;
    expect(guest.handlePong(pongFor(calibrated, 1_110))).toMatchObject({ accepted: true });
    nowMs = 1_100;
    const pending = guest.createPing();
    const pong = pongFor(pending, 1_210);

    shouldThrow = true;
    expect(() => guest.handlePong(pong)).toThrow(sourceError);
    shouldThrow = false;
    nowMs = 1_110;
    expect(guest.pendingPingCount()).toBe(0);
    expect(guest.quality().sampleCount).toBe(0);
    expect(guest.handlePong(pong)).toEqual({ accepted: false, reason: 'unknown-ping' });
  });

  it('tombstones retired connection epochs and keeps a failed rebind atomic', () => {
    const now = fakeNow();
    const guest = new FilePlaybackClockExchange({
      role: 'guest',
      sessionId: 'room-a',
      connectionId: 'connection-a',
      now: now.now,
    });

    guest.bindSession('room-b', 'connection-b');
    expect(() => guest.bindSession('room-a', 'connection-a')).toThrow(/must not be reused/);
    expect(guest.createPing()).toMatchObject({
      sessionId: 'room-b',
      connectionId: 'connection-b',
    });

    guest.clearSession();
    expect(() => guest.bindSession('room-c', 'connection-b')).toThrow(/must not be reused/);
    guest.bindSession('room-c', 'connection-c');
    expect(guest.createPing()).toMatchObject({
      sessionId: 'room-c',
      connectionId: 'connection-c',
    });
  });

  it('never forgets a retired connection epoch during the exchange lifetime', () => {
    const guest = new FilePlaybackClockExchange({
      role: 'guest',
      sessionId: 'room-lifetime-0',
      connectionId: 'connection-lifetime-0',
      now: () => 1_000,
    });
    for (let index = 1; index <= 70; index += 1) {
      guest.bindSession(`room-lifetime-${index}`, `connection-lifetime-${index}`);
    }

    expect(() => guest.bindSession('room-replay', 'connection-lifetime-0')).toThrow(
      /must not be reused/,
    );
    expect(guest.createPing()).toMatchObject({
      sessionId: 'room-lifetime-70',
      connectionId: 'connection-lifetime-70',
    });
  });

  it('validates runtime role changes before mutating state', () => {
    const guest = new FilePlaybackClockExchange({
      role: 'guest',
      sessionId: 'room-role-validation',
      connectionId: 'connection-role-validation',
      now: () => 1_000,
    });
    guest.createPing();

    expect(() => guest.setRole('observer' as never)).toThrow(/host or guest/);
    expect(guest.role()).toBe('guest');
    expect(guest.pendingPingCount()).toBe(1);
  });

  it('rejects replayed host-side sequences without creating a second pong', () => {
    const now = fakeNow(5_000);
    const host = new FilePlaybackClockExchange({
      role: 'host',
      sessionId: 'room-8',
      connectionId: 'connection-8',
      now: now.now,
    });
    const ping: FilePlaybackClockPingV2 = {
      type: 'FILE_PLAYBACK_CLOCK_PING_V2',
      version: 2,
      sessionId: 'room-8',
      connectionId: 'connection-8',
      pingId: 9,
      sequence: 9,
      t0: 4_900,
    };

    expect(host.handlePing(ping)).toMatchObject({ accepted: true });
    expect(host.handlePing(ping)).toEqual({ accepted: false, reason: 'stale-sequence' });
  });
});
