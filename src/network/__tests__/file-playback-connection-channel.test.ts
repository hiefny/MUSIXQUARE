import { describe, expect, it } from 'vitest';

import {
  FILE_PLAYBACK_CONNECTION_CHANNEL_MAX_FRAME_BYTES,
  FilePlaybackConnectionChannel,
} from '../file-playback-connection-channel.ts';
import { FilePlaybackClockExchange } from '../file-playback-clock-exchange.ts';
import {
  FilePlaybackHandshakeIdIssuer,
  FilePlaybackGuestSessionHandshake,
  FilePlaybackHostSessionHandshake,
} from '../file-playback-session-handshake.ts';
import type {
  FilePlaybackWireAttemptLease,
  FilePlaybackWireMediaBinding,
  FilePlaybackWireStateLease,
} from '../../player/file-playback-wire-binding.ts';

const HOST_ID = 'host-participant-1';
const GUEST_ID = 'guest-participant-1';
const MEDIA: FilePlaybackWireMediaBinding = Object.freeze({
  run: Object.freeze({ queueItemId: 'queue-item-1', runId: 'run-1', revision: 1 }),
  sourceIdentity: 'source-identity-1',
  transferSessionId: 'transfer-session-1',
});
const SUCCESSOR: FilePlaybackWireMediaBinding = Object.freeze({
  run: Object.freeze({ queueItemId: 'queue-item-1', runId: 'run-1', revision: 2 }),
  sourceIdentity: 'source-identity-1',
  transferSessionId: 'transfer-session-1',
});

function fakeNow(initial = 1_000) {
  let value = initial;
  let reads = 0;
  return {
    now: () => {
      reads += 1;
      return value;
    },
    set: (next: number) => {
      value = next;
    },
    reads: () => reads,
  };
}

let pairSequence = 0;

function issuer(prefix: string): FilePlaybackHandshakeIdIssuer {
  return new FilePlaybackHandshakeIdIssuer({
    createSessionId: () => `${prefix}-session`,
    createConnectionId: () => `${prefix}-connection`,
    createHelloId: () => `${prefix}-hello`,
  });
}

function handshakePair() {
  pairSequence += 1;
  const prefix = `pair-${pairSequence}`;
  const hostIssuer = issuer(prefix);
  const guestIssuer = issuer(`${prefix}-guest`);
  const host = new FilePlaybackHostSessionHandshake({
    idIssuer: hostIssuer,
    sessionId: hostIssuer.issueSessionId(),
    connectionId: hostIssuer.issueConnectionId(),
    hostParticipantId: HOST_ID,
    guestParticipantId: GUEST_ID,
  });
  const guest = new FilePlaybackGuestSessionHandshake({
    idIssuer: guestIssuer,
    guestParticipantId: GUEST_ID,
  });
  return { host, guest };
}

function establishPair() {
  const pair = handshakePair();
  const hello = pair.guest.createHello();
  if (!hello.accepted) throw new Error(hello.reason);
  const welcome = pair.host.handleHello(hello.hello);
  if (!welcome.accepted) throw new Error(welcome.reason);
  const welcomeAccepted = pair.guest.handleWelcome(welcome.welcome);
  if (!welcomeAccepted.accepted) throw new Error(welcomeAccepted.reason);
  const snapshot = pair.host.createSnapshot();
  if (!snapshot.accepted) throw new Error(snapshot.reason);
  const snapshotAccepted = pair.guest.acceptSnapshot(snapshot.snapshot);
  if (!snapshotAccepted.accepted) throw new Error(snapshotAccepted.reason);
  const applied = pair.guest.createApplied();
  if (!applied.accepted) throw new Error(applied.reason);
  const hostApplied = pair.host.handleApplied(applied.applied);
  if (!hostApplied.accepted) throw new Error(hostApplied.reason);
  return pair;
}

function channels() {
  const handshakes = establishPair();
  const hostNow = fakeNow();
  const guestNow = fakeNow();
  const hostToken = Object.freeze({ endpoint: 'host' });
  const guestToken = Object.freeze({ endpoint: 'guest' });
  const host = new FilePlaybackConnectionChannel(handshakes.host, hostToken, {
    now: hostNow.now,
  });
  const guest = new FilePlaybackConnectionChannel(handshakes.guest, guestToken, {
    now: guestNow.now,
    guestAppliedSendConfirmed: true,
  });
  return { guest, guestNow, guestToken, handshakes, host, hostNow, hostToken };
}

function exchangeSample(
  setup: ReturnType<typeof channels>,
  t0: number,
  offsetMs = 100,
  rttMs = 20,
) {
  setup.guestNow.set(t0);
  const ping = setup.guest.createClockPing();
  setup.hostNow.set(t0 + offsetMs + rttMs / 2);
  const hostResult = setup.host.receive(ping, setup.hostToken);
  expect(hostResult).toMatchObject({ accepted: true, frame: 'clock-ping' });
  if (!hostResult.accepted || hostResult.frame !== 'clock-ping') {
    throw new Error('Host did not accept clock ping');
  }
  setup.guestNow.set(t0 + rttMs);
  const guestResult = setup.guest.receive(hostResult.pong, setup.guestToken);
  expect(guestResult).toMatchObject({ accepted: true, frame: 'clock-pong' });
  return guestResult;
}

function calibrate(setup: ReturnType<typeof channels>, startAtMs = 1_000): void {
  for (let index = 0; index < 5; index += 1) {
    exchangeSample(setup, startAtMs + index * 100);
  }
}

function wireEnvelope(
  setup: ReturnType<typeof channels>,
  sender: 'host' | 'guest',
  controlSequence = 1,
) {
  const binding = setup.host.establishedBinding();
  if (!binding) throw new Error('Missing established test binding');
  return {
    protocolVersion: 2 as const,
    sessionId: binding.sessionId,
    connectionId: binding.connectionId,
    senderParticipantId: sender === 'host' ? HOST_ID : GUEST_ID,
    recipientParticipantId: sender === 'host' ? GUEST_ID : HOST_ID,
    controlSequence,
    queueItemId: MEDIA.run.queueItemId,
    runId: MEDIA.run.runId,
    revision: MEDIA.run.revision,
    sourceIdentity: MEDIA.sourceIdentity,
    transferSessionId: MEDIA.transferSessionId,
  };
}

function bindCurrent(
  channel: FilePlaybackConnectionChannel,
  binding: FilePlaybackWireMediaBinding = MEDIA,
  rendezvousId = 'rendezvous-1',
): Readonly<{
  state: FilePlaybackWireStateLease;
  attempt: FilePlaybackWireAttemptLease;
}> {
  const state = channel.bootstrapCurrentMedia(binding);
  const attempt = channel.stageAttempt(state, rendezvousId);
  return { state, attempt };
}

function bindPair(setup: ReturnType<typeof channels>) {
  return {
    host: bindCurrent(setup.host),
    guest: bindCurrent(setup.guest),
  };
}

const expectedCurrent = Object.freeze({
  expectedQueueItemId: MEDIA.run.queueItemId,
  expectedRunId: MEDIA.run.runId,
  expectedRevision: MEDIA.run.revision,
});

describe('FilePlaybackConnectionChannel', () => {
  it('derives immutable endpoint scope from one fully APPLIED handshake pair', () => {
    const setup = channels();
    const binding = setup.handshakes.host.establishedBinding();

    expect(setup.host.role()).toBe('host');
    expect(setup.guest.role()).toBe('guest');
    expect(setup.host.establishedBinding()).toEqual(binding);
    expect(setup.guest.establishedBinding()).toEqual(binding);
    expect(setup.host.establishedBinding()).not.toBe(binding);
    expect(Object.isFrozen(setup.host.establishedBinding())).toBe(true);
    expect(Object.getPrototypeOf(setup.host.establishedBinding())).toBeNull();
    expect(setup.host.liveConnectionToken()).toBe(setup.hostToken);
    expect(setup.guest.liveConnectionToken()).toBe(setup.guestToken);
  });

  it('calibrates the exact guest connection clock with five canonical exchanges', () => {
    const setup = channels();

    for (let index = 0; index < 5; index += 1) {
      const result = exchangeSample(setup, 1_000 + index * 100);
      expect(result).toMatchObject({
        accepted: true,
        frame: 'clock-pong',
        sample: { accepted: true, offsetMs: 100, rttMs: 20 },
      });
    }

    expect(setup.guest.quality()).toMatchObject({
      calibrated: true,
      offsetMs: 100,
      sampleCount: 5,
    });
    expect(setup.guest.nowRoomTimeMs()).toBe(1_520);
    expect(setup.host.quality()).toMatchObject({ calibrated: true, offsetMs: 0 });
  });

  it('adopts the exact provisional clock without losing its calibrated epoch', () => {
    const handshakes = establishPair();
    const binding = handshakes.guest.establishedBinding();
    if (!binding) throw new Error('Missing established test binding');
    const guestNow = fakeNow();
    const hostNow = fakeNow();
    const guestClock = new FilePlaybackClockExchange({
      role: 'guest',
      sessionId: binding.sessionId,
      connectionId: binding.connectionId,
      now: guestNow.now,
    });
    const hostClock = new FilePlaybackClockExchange({
      role: 'host',
      sessionId: binding.sessionId,
      connectionId: binding.connectionId,
      now: hostNow.now,
    });

    for (let index = 0; index < 5; index += 1) {
      const t0 = 1_000 + index * 100;
      guestNow.set(t0);
      const ping = guestClock.createPing();
      hostNow.set(t0 + 110);
      const pong = hostClock.handlePing(ping);
      if (!pong.accepted) throw new Error(pong.reason);
      guestNow.set(t0 + 20);
      expect(guestClock.handlePong(pong.pong)).toMatchObject({
        accepted: true,
        offsetMs: 100,
        rttMs: 20,
      });
    }

    const channel = new FilePlaybackConnectionChannel(
      handshakes.guest,
      {},
      {
        clockExchange: guestClock,
        guestAppliedSendConfirmed: true,
      },
    );
    expect(channel.clockReady()).toBe(true);
    expect(channel.quality()).toMatchObject({ calibrated: true, offsetMs: 100, sampleCount: 5 });
    expect(channel.nowRoomTimeMs()).toBe(1_520);

    channel.handleWake();
    expect(channel.clockReady()).toBe(false);
    expect(guestClock.quality()).toMatchObject({ calibrated: false, sampleCount: 0 });
  });

  it('rejects mismatched or inactive adopted clocks without consuming the handshake', () => {
    const handshakes = establishPair();
    const binding = handshakes.host.establishedBinding();
    if (!binding) throw new Error('Missing established test binding');
    const wrongRole = new FilePlaybackClockExchange({
      role: 'guest',
      sessionId: binding.sessionId,
      connectionId: binding.connectionId,
      now: () => 1_000,
    });
    const wrongSession = new FilePlaybackClockExchange({
      role: 'host',
      sessionId: `${binding.sessionId}-other`,
      connectionId: binding.connectionId,
      now: () => 1_000,
    });
    const inactive = new FilePlaybackClockExchange({
      role: 'host',
      sessionId: binding.sessionId,
      connectionId: binding.connectionId,
      now: () => 1_000,
    });
    inactive.clearSession();

    for (const clockExchange of [wrongRole, wrongSession, inactive]) {
      expect(
        () => new FilePlaybackConnectionChannel(handshakes.host, {}, { clockExchange }),
      ).toThrow(/does not match/u);
    }

    const exact = new FilePlaybackClockExchange({
      role: 'host',
      sessionId: binding.sessionId,
      connectionId: binding.connectionId,
      now: () => 1_000,
    });
    expect(
      new FilePlaybackConnectionChannel(handshakes.host, {}, { clockExchange: exact }).clockReady(),
    ).toBe(true);
  });

  it('does not allow an adopted clock to be paired with a second monotonic source', () => {
    const handshakes = establishPair();
    const binding = handshakes.host.establishedBinding();
    if (!binding) throw new Error('Missing established test binding');
    const clockExchange = new FilePlaybackClockExchange({
      role: 'host',
      sessionId: binding.sessionId,
      connectionId: binding.connectionId,
      now: () => 1_000,
    });

    expect(
      () =>
        new FilePlaybackConnectionChannel(
          handshakes.host,
          {},
          {
            clockExchange,
            now: () => 1_000,
          },
        ),
    ).toThrow(/cannot override/u);
    expect(
      new FilePlaybackConnectionChannel(handshakes.host, {}, { clockExchange }).clockReady(),
    ).toBe(true);
  });

  it('round-trips exact wire traffic in both participant directions', () => {
    const setup = channels();
    calibrate(setup);
    const leases = bindPair(setup);
    setup.hostNow.set(2_100);
    setup.guestNow.set(2_000);

    const ready = setup.guest.createWire(leases.guest.state, {
      kind: 'source-ready',
      observedAtRoomTimeMs: 2_100,
      readyLeaseUntilRoomTimeMs: 12_100,
      backend: 'streaming-flac',
      durationSeconds: 600,
      bufferedAheadSeconds: 12,
      outputSampleRateHz: 48_000,
      channelCount: 2,
    });
    expect(setup.host.receive(ready, setup.hostToken)).toMatchObject({
      accepted: true,
      frame: 'wire',
      message: ready,
      stateLease: leases.host.state,
      attemptLease: null,
    });

    const hostSuccessor = setup.host.stageMedia(SUCCESSOR);
    const guestSuccessor = setup.guest.stageMedia(SUCCESSOR);
    const pause = setup.host.createWire(hostSuccessor, {
      kind: 'file-playback-pause',
      ...expectedCurrent,
      atRoomTimeMs: 2_100,
    });
    expect(setup.guest.receive(pause, setup.guestToken)).toMatchObject({
      accepted: true,
      frame: 'wire',
      message: pause,
      stateLease: guestSuccessor,
      attemptLease: null,
    });

    expect(Object.getPrototypeOf(ready)).toBeNull();
    expect(Object.isFrozen(ready)).toBe(true);
  });

  it('enforces the exhaustive role-kind table before outbound sequence and inbound watermark', () => {
    const setup = channels();
    calibrate(setup);
    const leases = bindPair(setup);
    setup.hostNow.set(2_100);
    setup.guestNow.set(2_000);

    expect(() =>
      setup.host.createWire(leases.host.state, {
        kind: 'source-not-ready',
        observedAtRoomTimeMs: 2_100,
        reasonCode: 'illegal-host-kind',
        retryable: true,
      }),
    ).toThrow(/host cannot send source-not-ready/u);
    expect(() =>
      setup.guest.createWire(leases.guest.attempt, {
        kind: 'rendezvous-arm',
        rendezvousId: 'rendezvous-1',
        positionSeconds: 0,
        playbackRate: 1,
        startAtRoomTimeMs: 2_300,
        finalizeByRoomTimeMs: 2_200,
      }),
    ).toThrow(/guest cannot send rendezvous-arm/u);

    const hostArm = setup.host.createWire(leases.host.attempt, {
      kind: 'rendezvous-arm',
      rendezvousId: 'rendezvous-1',
      positionSeconds: 0,
      playbackRate: 1,
      startAtRoomTimeMs: 2_300,
      finalizeByRoomTimeMs: 2_200,
    });
    const guestNotReady = setup.guest.createWire(leases.guest.state, {
      kind: 'source-not-ready',
      observedAtRoomTimeMs: 2_100,
      reasonCode: 'legal-guest-kind',
      retryable: true,
    });
    expect(hostArm.controlSequence).toBe(1);
    expect(guestNotReady.controlSequence).toBe(1);

    const illegalGuestArm = {
      ...wireEnvelope(setup, 'guest'),
      kind: 'rendezvous-arm',
      rendezvousId: 'rendezvous-1',
      positionSeconds: 0,
      playbackRate: 1,
      startAtRoomTimeMs: 2_300,
      finalizeByRoomTimeMs: 2_200,
    };
    expect(setup.host.receive(illegalGuestArm, setup.hostToken)).toEqual({
      accepted: false,
      reason: 'wrong-role-kind',
    });
    expect(setup.host.receive(guestNotReady, setup.hostToken)).toMatchObject({
      accepted: true,
      frame: 'wire',
      message: { controlSequence: 1 },
    });

    const illegalHostNotReady = {
      ...wireEnvelope(setup, 'host'),
      kind: 'source-not-ready',
      observedAtRoomTimeMs: 2_100,
      reasonCode: 'illegal-host-kind',
      retryable: true,
    };
    expect(setup.guest.receive(illegalHostNotReady, setup.guestToken)).toEqual({
      accepted: false,
      reason: 'wrong-role-kind',
    });
    expect(setup.guest.receive(hostArm, setup.guestToken)).toMatchObject({
      accepted: true,
      frame: 'wire',
      message: { controlSequence: 1 },
    });
  });

  it('gates guest temporal authority before calibration and across wake/recalibration', () => {
    const setup = channels();
    const leases = bindPair(setup);
    const hostSuccessor = setup.host.stageMedia(SUCCESSOR);
    setup.guest.stageMedia(SUCCESSOR);
    setup.hostNow.set(1_000);
    setup.guestNow.set(1_000);

    expect(setup.host.clockReady()).toBe(true);
    expect(setup.guest.clockReady()).toBe(false);
    expect(setup.guest.quality()).toMatchObject({ calibrated: false, sampleCount: 0 });
    expect(() => setup.guest.nowRoomTimeMs()).toThrow(/not calibrated/u);
    expect(() => setup.guest.bindAudioContext({ currentTime: 5 } as AudioContext)).toThrow(
      /not calibrated/u,
    );
    expect(() =>
      setup.guest.createWire(leases.guest.state, {
        kind: 'source-not-ready',
        observedAtRoomTimeMs: 1_100,
        reasonCode: 'not-calibrated',
        retryable: true,
      }),
    ).toThrow(/not calibrated/u);

    const preCalibrationPause = setup.host.createWire(hostSuccessor, {
      kind: 'file-playback-pause',
      ...expectedCurrent,
      atRoomTimeMs: 1_100,
    });
    expect(preCalibrationPause.controlSequence).toBe(1);
    expect(setup.guest.receive(preCalibrationPause, setup.guestToken)).toEqual({
      accepted: false,
      reason: 'clock-uncalibrated',
    });

    calibrate(setup, 1_200);
    expect(setup.guest.clockReady()).toBe(true);
    expect(setup.guest.receive(preCalibrationPause, setup.guestToken)).toMatchObject({
      accepted: true,
      frame: 'wire',
      message: { controlSequence: 1 },
    });
    const bindings = setup.guest.bindAudioContext({ currentTime: 5 } as AudioContext);
    expect(bindings.nowRoomTimeMs()).toBeGreaterThan(0);

    setup.guest.handleWake();
    expect(setup.guest.clockReady()).toBe(false);
    expect(() => bindings.nowRoomTimeMs()).toThrow(/not calibrated/u);
    expect(() => bindings.roomTimeMsToContextTime(2_000)).toThrow(/not calibrated/u);
    expect(() => bindings.localPerformanceMsToContextTime(2_000)).toThrow(/not calibrated/u);

    setup.hostNow.set(2_100);
    const postWakeSeek = setup.host.createWire(hostSuccessor, {
      kind: 'file-playback-seek',
      ...expectedCurrent,
      positionSeconds: 4,
      atRoomTimeMs: 2_100,
    });
    expect(postWakeSeek.controlSequence).toBe(2);
    expect(setup.guest.receive(postWakeSeek, setup.guestToken)).toEqual({
      accepted: false,
      reason: 'clock-uncalibrated',
    });

    calibrate(setup, 3_000);
    expect(setup.guest.clockReady()).toBe(true);
    expect(bindings.nowRoomTimeMs()).toBeGreaterThan(0);
    expect(setup.guest.receive(postWakeSeek, setup.guestToken)).toMatchObject({
      accepted: true,
      frame: 'wire',
      message: { controlSequence: 2 },
    });
  });

  it('requires the exact live token and never inspects a wrong-token frame', () => {
    const setup = channels();
    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          traps += 1;
          throw new Error('must not inspect stale transport data');
        },
      },
    );

    expect(setup.host.receive(hostile, {})).toEqual({
      accepted: false,
      reason: 'wrong-connection-token',
    });
    expect(setup.host.receive(hostile, setup.guestToken)).toEqual({
      accepted: false,
      reason: 'wrong-connection-token',
    });
    expect(traps).toBe(0);

    const replacement = channels();
    expect(replacement.host.receive(hostile, setup.hostToken)).toEqual({
      accepted: false,
      reason: 'wrong-connection-token',
    });
    expect(traps).toBe(0);
  });

  it('rejects host and guest provisional handshakes before constructing authority', () => {
    const pair = handshakePair();
    expect(() => new FilePlaybackConnectionChannel(pair.host, {})).toThrow(/APPLIED/u);
    expect(() => new FilePlaybackConnectionChannel(pair.guest, {})).toThrow(/APPLIED/u);

    const hello = pair.guest.createHello();
    if (!hello.accepted) throw new Error(hello.reason);
    const welcome = pair.host.handleHello(hello.hello);
    if (!welcome.accepted) throw new Error(welcome.reason);
    expect(pair.guest.handleWelcome(welcome.welcome)).toEqual({ accepted: true });
    expect(() => new FilePlaybackConnectionChannel(pair.host, {})).toThrow(/APPLIED/u);
    expect(() => new FilePlaybackConnectionChannel(pair.guest, {})).toThrow(/APPLIED/u);
  });

  it('claims each APPLIED handshake once and never revives it after close', () => {
    const pair = establishPair();
    const firstHostToken = {};
    const host = new FilePlaybackConnectionChannel(pair.host, firstHostToken, {
      now: () => 1_000,
    });
    expect(() => new FilePlaybackConnectionChannel(pair.host, {}, { now: () => 1_000 })).toThrow(
      /already claimed/u,
    );
    host.close();
    expect(() => new FilePlaybackConnectionChannel(pair.host, {}, { now: () => 1_000 })).toThrow(
      /already claimed/u,
    );

    expect(() => new FilePlaybackConnectionChannel(pair.guest, {}, { now: () => 1_000 })).toThrow(
      /confirmed APPLIED transport delivery/u,
    );
    const guest = new FilePlaybackConnectionChannel(
      pair.guest,
      {},
      {
        now: () => 1_000,
        guestAppliedSendConfirmed: true,
      },
    );
    guest.close();
    expect(
      () =>
        new FilePlaybackConnectionChannel(
          pair.guest,
          {},
          {
            now: () => 1_000,
            guestAppliedSendConfirmed: true,
          },
        ),
    ).toThrow(/already claimed/u);
  });

  it('blocks simultaneous re-entrant claims while allowing retry after invalid options', () => {
    const pair = establishPair();
    let nestedError: unknown = null;
    let attempted = false;
    const reentrantOptions = new Proxy(
      {},
      {
        ownKeys(target) {
          if (!attempted) {
            attempted = true;
            try {
              void new FilePlaybackConnectionChannel(pair.host, {}, { now: () => 1_000 });
            } catch (error) {
              nestedError = error;
            }
          }
          return Reflect.ownKeys(target);
        },
      },
    );
    const outer = new FilePlaybackConnectionChannel(pair.host, {}, reentrantOptions);
    expect(nestedError).toBeInstanceOf(Error);
    expect((nestedError as Error).message).toMatch(/already claimed/u);
    expect(outer.isClosed()).toBe(false);

    const retryPair = establishPair();
    const invalid = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(invalid, 'now', { enumerable: true, get: () => () => 1_000 });
    expect(() => new FilePlaybackConnectionChannel(retryPair.host, {}, invalid)).toThrow(
      /options/u,
    );
    expect(
      new FilePlaybackConnectionChannel(retryPair.host, {}, { now: () => 1_000 }).isClosed(),
    ).toBe(false);
  });

  it('fails closed and revokes media, clock, token, binding, and old audio bindings', () => {
    const setup = channels();
    calibrate(setup);
    const lease = bindCurrent(setup.guest);
    const audioBindings = setup.guest.bindAudioContext({ currentTime: 5 } as AudioContext);

    setup.guest.close();
    setup.guest.close();
    expect(setup.guest.isClosed()).toBe(true);
    expect(setup.guest.establishedBinding()).toBeNull();
    expect(setup.guest.liveConnectionToken()).toBeNull();
    expect(setup.guest.receive({}, setup.guestToken)).toEqual({
      accepted: false,
      reason: 'closed',
    });
    expect(() => setup.guest.createClockPing()).toThrow(/closed/u);
    expect(() =>
      setup.guest.createWire(lease.attempt, {
        kind: 'file-playback-cancel',
        rendezvousId: 'rendezvous-1',
        reasonCode: 'closed',
      }),
    ).toThrow(/closed/u);
    expect(() => setup.guest.stageMedia(MEDIA)).toThrow(/closed/u);
    expect(() => setup.guest.retireMedia(lease.state)).toThrow(/closed/u);
    expect(() => setup.guest.quality()).toThrow(/closed/u);
    expect(() => setup.guest.nowRoomTimeMs()).toThrow(/closed/u);
    expect(() => setup.guest.handleWake()).toThrow(/closed/u);
    expect(() => setup.guest.bindAudioContext({ currentTime: 5 } as AudioContext)).toThrow(
      /closed/u,
    );
    expect(() => audioBindings.nowRoomTimeMs()).toThrow(/closed/u);
    expect(() => audioBindings.roomTimeMsToContextTime(1_500)).toThrow(/closed/u);
    expect(() => audioBindings.localPerformanceMsToContextTime(1_500)).toThrow(/closed/u);
  });

  it('rejects clock and wire direction errors without advancing either clock or watermark', () => {
    const setup = channels();
    calibrate(setup);
    const leases = bindPair(setup);
    const hostSuccessor = setup.host.stageMedia(SUCCESSOR);
    setup.guest.stageMedia(SUCCESSOR);
    expect(() => setup.host.createClockPing()).toThrow(/guest channel/u);
    setup.guestNow.set(2_000);
    const ping = setup.guest.createClockPing();
    const guestReads = setup.guestNow.reads();

    expect(setup.guest.receive(ping, setup.guestToken)).toEqual({
      accepted: false,
      reason: 'wrong-direction',
    });
    expect(setup.guestNow.reads()).toBe(guestReads);

    setup.hostNow.set(2_100);
    const ownHostFrame = setup.host.createWire(hostSuccessor, {
      kind: 'file-playback-pause',
      ...expectedCurrent,
      atRoomTimeMs: 2_100,
    });
    const hostReads = setup.hostNow.reads();
    expect(setup.host.receive(ownHostFrame, setup.hostToken)).toEqual({
      accepted: false,
      reason: 'wrong-direction',
    });
    expect(setup.hostNow.reads()).toBe(hostReads);

    const guestFrame = setup.guest.createWire(leases.guest.state, {
      kind: 'source-not-ready',
      observedAtRoomTimeMs: 2_100,
      reasonCode: 'still-sequence-one',
      retryable: true,
    });
    expect(guestFrame.controlSequence).toBe(1);
    expect(setup.host.receive(guestFrame, setup.hostToken)).toMatchObject({
      accepted: true,
      frame: 'wire',
    });
  });

  it('rejects malformed and oversized materialized frames without reading the clock', () => {
    const setup = channels();
    const before = setup.hostNow.reads();
    expect(setup.host.receive({ type: 'FILE_PLAYBACK_CLOCK_PING_V2' }, setup.hostToken)).toEqual({
      accepted: false,
      reason: 'malformed-frame',
    });
    expect(
      setup.host.receive(
        {
          type: 'FILE_PLAYBACK_CLOCK_PING_V2',
          version: 2,
          sessionId: 'x'.repeat(FILE_PLAYBACK_CONNECTION_CHANNEL_MAX_FRAME_BYTES),
          connectionId: 'connection',
          pingId: 1,
          sequence: 1,
          t0: 1,
        },
        setup.hostToken,
      ),
    ).toEqual({ accepted: false, reason: 'malformed-frame' });
    expect(setup.host.receive('{"type":"FILE_PLAYBACK_CLOCK_PING_V2"}', setup.hostToken)).toEqual({
      accepted: false,
      reason: 'malformed-frame',
    });
    expect(setup.hostNow.reads()).toBe(before);
  });

  it('classifies hostile frames once, blocks re-entry, and commits only the outer frame', () => {
    const setup = channels();
    calibrate(setup);
    const leases = bindPair(setup);
    setup.guestNow.set(2_000);
    setup.hostNow.set(2_100);
    const first = setup.guest.createWire(leases.guest.state, {
      kind: 'source-not-ready',
      observedAtRoomTimeMs: 2_100,
      reasonCode: 'first',
      retryable: true,
    });
    const second = setup.guest.createWire(leases.guest.state, {
      kind: 'source-not-ready',
      observedAtRoomTimeMs: 2_100,
      reasonCode: 'second',
      retryable: true,
    });
    let nested: ReturnType<typeof setup.host.receive> | null = null;
    let reentered = false;
    let kindDescriptorReads = 0;
    const hostile = new Proxy(first, {
      ownKeys(target) {
        if (!reentered) {
          reentered = true;
          nested = setup.host.receive(second, setup.hostToken);
        }
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === 'kind') kindDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    expect(setup.host.receive(hostile, setup.hostToken)).toMatchObject({
      accepted: true,
      frame: 'wire',
      message: { controlSequence: 1 },
    });
    expect(nested).toEqual({ accepted: false, reason: 'reentrant-call' });
    expect(kindDescriptorReads).toBe(1);
    expect(setup.host.receive(second, setup.hostToken)).toMatchObject({
      accepted: true,
      frame: 'wire',
      message: { controlSequence: 2 },
    });
  });

  it('reads a hostile clock type descriptor once while rejecting classifier re-entry', () => {
    const setup = channels();
    setup.guestNow.set(1_000);
    const ping = setup.guest.createClockPing();
    setup.hostNow.set(1_110);
    let nested: ReturnType<typeof setup.host.receive> | null = null;
    let reentered = false;
    let typeDescriptorReads = 0;
    const hostile = new Proxy(ping, {
      ownKeys(target) {
        if (!reentered) {
          reentered = true;
          nested = setup.host.receive(target, setup.hostToken);
        }
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === 'type') typeDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    expect(setup.host.receive(hostile, setup.hostToken)).toMatchObject({
      accepted: true,
      frame: 'clock-ping',
    });
    expect(nested).toEqual({ accepted: false, reason: 'reentrant-call' });
    expect(typeDescriptorReads).toBe(1);
  });

  it('stale-drops an exact retired state after hostile classification side effects', () => {
    const setup = channels();
    calibrate(setup);
    const leases = bindPair(setup);
    setup.guestNow.set(2_000);
    setup.hostNow.set(2_100);
    const message = setup.guest.createWire(leases.guest.state, {
      kind: 'source-not-ready',
      observedAtRoomTimeMs: 2_100,
      reasonCode: 'old-media',
      retryable: true,
    });
    let rebound = false;
    const hostile = new Proxy(message, {
      ownKeys(target) {
        if (!rebound) {
          rebound = true;
          setup.host.retireMedia(leases.host.state);
          const replacement = setup.host.stageMedia({
            run: { queueItemId: 'queue-item-2', runId: 'run-2', revision: 2 },
            sourceIdentity: 'source-identity-2',
            transferSessionId: null,
          });
          setup.host.commitMedia(replacement);
        }
        return Reflect.ownKeys(target);
      },
    });

    expect(setup.host.receive(hostile, setup.hostToken)).toEqual({
      accepted: true,
      frame: 'wire-stale',
      scope: 'state',
      controlSequence: 1,
    });
    expect(setup.host.receive(message, setup.hostToken)).toMatchObject({
      accepted: false,
      reason: 'wire-rejected',
    });
  });

  it('enforces two state slots and never revives a candidate retired during Proxy detachment', () => {
    const setup = channels();
    calibrate(setup);
    bindPair(setup);
    const media2: FilePlaybackWireMediaBinding = {
      ...SUCCESSOR,
    };
    const media3: FilePlaybackWireMediaBinding = {
      ...SUCCESSOR,
      run: { ...SUCCESSOR.run, revision: 3 },
    };
    const hostCandidate2 = setup.host.stageMedia(media2);
    expect(() => setup.host.stageMedia(media3)).toThrow(/candidate/u);

    let retired = false;
    const retireDuringStage = new Proxy(media3, {
      ownKeys(target) {
        if (!retired) {
          retired = true;
          setup.host.retireMedia(hostCandidate2);
        }
        return Reflect.ownKeys(target);
      },
    });
    const hostCandidate3 = setup.host.stageMedia(retireDuringStage);
    const guestCandidate2 = setup.guest.stageMedia(media2);
    setup.guest.retireMedia(guestCandidate2);
    const guestCandidate3 = setup.guest.stageMedia(media3);
    setup.hostNow.set(2_100);
    setup.guestNow.set(2_000);
    const pause = setup.host.createWire(hostCandidate3, {
      kind: 'file-playback-pause',
      ...expectedCurrent,
      atRoomTimeMs: 2_100,
    });
    expect(setup.guest.receive(pause, setup.guestToken)).toMatchObject({
      accepted: true,
      frame: 'wire',
      message: { revision: 3 },
      stateLease: guestCandidate3,
    });
    setup.host.retireMedia(hostCandidate3);
    expect(() => setup.host.stageMedia(media3)).toThrow(/exact next/u);
  });

  it('uses stop as a successor state and stale-drops late old-current work after commit', () => {
    const setup = channels();
    calibrate(setup);
    const leases = bindPair(setup);
    const hostStop = setup.host.stageMedia(SUCCESSOR);
    setup.hostNow.set(2_100);
    setup.guestNow.set(2_000);
    const stop = setup.host.createWire(hostStop, {
      kind: 'file-playback-stop',
      ...expectedCurrent,
      atRoomTimeMs: 2_100,
    });
    const oldArm = setup.host.createWire(leases.host.attempt, {
      kind: 'rendezvous-arm',
      rendezvousId: 'rendezvous-1',
      positionSeconds: 0,
      playbackRate: 1,
      startAtRoomTimeMs: 2_300,
      finalizeByRoomTimeMs: 2_200,
    });

    const receivedStop = setup.guest.receive(stop, setup.guestToken);
    expect(receivedStop).toMatchObject({
      accepted: true,
      frame: 'wire',
      attemptLease: null,
      message: { kind: 'file-playback-stop', revision: 2, expectedRevision: 1 },
    });
    if (!receivedStop.accepted || receivedStop.frame !== 'wire') {
      throw new Error('Expected remote stop admission');
    }
    setup.guest.commitStop(receivedStop.stateLease, MEDIA.run);
    setup.host.commitStop(hostStop, MEDIA.run);
    expect(setup.guest.receive(oldArm, setup.guestToken)).toEqual({
      accepted: true,
      frame: 'wire-stale',
      scope: 'attempt',
      controlSequence: 2,
    });
    expect(() => setup.guest.stageMedia(SUCCESSOR)).toThrow(/active or retired|exact next/u);
    const next = setup.guest.stageMedia({
      run: { queueItemId: 'queue-item-next', runId: 'run-next', revision: 3 },
      sourceIdentity: 'sha256:source-next',
      transferSessionId: null,
    });
    setup.guest.commitMedia(next);
    expect(() => setup.guest.stageAttempt(next, 'rendezvous-next')).not.toThrow();
    expect(() =>
      setup.host.createWire(leases.host.attempt, {
        kind: 'file-playback-stop',
        ...expectedCurrent,
        atRoomTimeMs: 2_100,
      }),
    ).toThrow(/forged|retired/u);
  });

  it('keeps current and recovery attempts live together and stale-drops promoted candidate cancel', () => {
    const setup = channels();
    calibrate(setup);
    const leases = bindPair(setup);
    setup.host.commitAttempt(leases.host.attempt);
    setup.guest.commitAttempt(leases.guest.attempt);
    const hostRecovery = setup.host.stageAttempt(leases.host.state, 'rendezvous-recovery');
    const guestRecovery = setup.guest.stageAttempt(leases.guest.state, 'rendezvous-recovery');
    expect(() => setup.host.stageAttempt(leases.host.state, 'rendezvous-third')).toThrow(
      /candidate/u,
    );
    setup.hostNow.set(2_100);
    setup.guestNow.set(2_000);

    const currentReceipt = setup.guest.createWire(leases.guest.attempt, {
      kind: 'rendezvous-armed',
      rendezvousId: 'rendezvous-1',
      status: 'armed',
      observedAtRoomTimeMs: 2_100,
      bufferedAheadSeconds: 5,
      reasonCode: null,
    });
    const recoveryReceipt = setup.guest.createWire(guestRecovery, {
      kind: 'rendezvous-armed',
      rendezvousId: 'rendezvous-recovery',
      status: 'armed',
      observedAtRoomTimeMs: 2_100,
      bufferedAheadSeconds: 5,
      reasonCode: null,
    });
    expect(setup.host.receive(currentReceipt, setup.hostToken)).toMatchObject({
      accepted: true,
      frame: 'wire',
      attemptLease: leases.host.attempt,
    });
    expect(setup.host.receive(recoveryReceipt, setup.hostToken)).toMatchObject({
      accepted: true,
      frame: 'wire',
      attemptLease: hostRecovery,
    });

    const lateCurrentHealth = setup.guest.createWire(leases.guest.attempt, {
      kind: 'renderer-health',
      rendezvousId: 'rendezvous-1',
      value: 'healthy',
      observedAtRoomTimeMs: 2_100,
      leaseUntilRoomTimeMs: 7_100,
      renderedFrame: 100,
      underrunCount: 0,
      reasonCode: null,
    });
    const candidateCancel = setup.host.createWire(hostRecovery, {
      kind: 'file-playback-cancel',
      rendezvousId: 'rendezvous-recovery',
      reasonCode: 'candidate-retired',
    });
    setup.host.commitAttempt(hostRecovery);
    setup.guest.commitAttempt(guestRecovery);

    expect(setup.host.receive(lateCurrentHealth, setup.hostToken)).toEqual({
      accepted: true,
      frame: 'wire-stale',
      scope: 'attempt',
      controlSequence: 3,
    });
    expect(setup.guest.receive(candidateCancel, setup.guestToken)).toEqual({
      accepted: true,
      frame: 'wire-stale',
      scope: 'attempt',
      controlSequence: 1,
    });
  });

  it('validates opaque tokens and constructor options without invoking accessors', () => {
    const pair = establishPair();
    expect(() => new FilePlaybackConnectionChannel(pair.host, null as never)).toThrow(/token/u);
    expect(() => new FilePlaybackConnectionChannel(pair.guest, 'peer' as never)).toThrow(/token/u);

    let reads = 0;
    const options = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(options, 'now', {
      enumerable: true,
      get() {
        reads += 1;
        return () => 1_000;
      },
    });
    expect(() => new FilePlaybackConnectionChannel(pair.host, {}, options)).toThrow(/options/u);
    expect(reads).toBe(0);
  });
});
