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
import type { FilePlaybackWireMediaBinding } from '../../player/file-playback-wire.ts';

const HOST_ID = 'host-participant-1';
const GUEST_ID = 'guest-participant-1';
const MEDIA: FilePlaybackWireMediaBinding = Object.freeze({
  run: Object.freeze({ queueItemId: 'queue-item-1', runId: 'run-1', revision: 1 }),
  sourceIdentity: 'source-identity-1',
  transferSessionId: 'transfer-session-1',
  rendezvousId: 'rendezvous-1',
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
    setup.host.bindMedia(MEDIA);
    setup.guest.bindMedia(MEDIA);
    setup.hostNow.set(2_100);
    setup.guestNow.set(2_000);

    const ready = setup.guest.createWire({
      kind: 'source-ready',
      observedAtRoomTimeMs: 2_100,
      readyLeaseUntilRoomTimeMs: 12_100,
      backend: 'streaming-flac',
      durationSeconds: 600,
      bufferedAheadSeconds: 12,
      outputSampleRateHz: 48_000,
      channelCount: 2,
    });
    expect(setup.host.receive(ready, setup.hostToken)).toEqual({
      accepted: true,
      frame: 'wire',
      message: ready,
    });

    const pause = setup.host.createWire({
      kind: 'file-playback-pause',
      atRoomTimeMs: 2_100,
    });
    expect(setup.guest.receive(pause, setup.guestToken)).toEqual({
      accepted: true,
      frame: 'wire',
      message: pause,
    });

    expect(Object.getPrototypeOf(ready)).toBeNull();
    expect(Object.isFrozen(ready)).toBe(true);
  });

  it('enforces the exhaustive role-kind table before outbound sequence and inbound watermark', () => {
    const setup = channels();
    calibrate(setup);
    setup.host.bindMedia(MEDIA);
    setup.guest.bindMedia(MEDIA);
    setup.hostNow.set(2_100);
    setup.guestNow.set(2_000);

    expect(() =>
      setup.host.createWire({
        kind: 'source-not-ready',
        observedAtRoomTimeMs: 2_100,
        reasonCode: 'illegal-host-kind',
        retryable: true,
      }),
    ).toThrow(/host cannot send source-not-ready/u);
    expect(() =>
      setup.guest.createWire({
        kind: 'rendezvous-arm',
        rendezvousId: 'rendezvous-1',
        positionSeconds: 0,
        playbackRate: 1,
        startAtRoomTimeMs: 2_300,
        finalizeByRoomTimeMs: 2_200,
      }),
    ).toThrow(/guest cannot send rendezvous-arm/u);

    const hostArm = setup.host.createWire({
      kind: 'rendezvous-arm',
      rendezvousId: 'rendezvous-1',
      positionSeconds: 0,
      playbackRate: 1,
      startAtRoomTimeMs: 2_300,
      finalizeByRoomTimeMs: 2_200,
    });
    const guestNotReady = setup.guest.createWire({
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
    setup.host.bindMedia(MEDIA);
    setup.guest.bindMedia(MEDIA);
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
      setup.guest.createWire({
        kind: 'source-not-ready',
        observedAtRoomTimeMs: 1_100,
        reasonCode: 'not-calibrated',
        retryable: true,
      }),
    ).toThrow(/not calibrated/u);

    const preCalibrationPause = setup.host.createWire({
      kind: 'file-playback-pause',
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
    const postWakeSeek = setup.host.createWire({
      kind: 'file-playback-seek',
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
    setup.guest.bindMedia(MEDIA);
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
      setup.guest.createWire({ kind: 'file-playback-cancel', reasonCode: 'closed' }),
    ).toThrow(/closed/u);
    expect(() => setup.guest.bindMedia(MEDIA)).toThrow(/closed/u);
    expect(() => setup.guest.clearMedia()).toThrow(/closed/u);
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
    setup.host.bindMedia(MEDIA);
    setup.guest.bindMedia(MEDIA);
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
    const ownHostFrame = setup.host.createWire({
      kind: 'file-playback-pause',
      atRoomTimeMs: 2_100,
    });
    const hostReads = setup.hostNow.reads();
    expect(setup.host.receive(ownHostFrame, setup.hostToken)).toEqual({
      accepted: false,
      reason: 'wrong-direction',
    });
    expect(setup.hostNow.reads()).toBe(hostReads);

    const guestFrame = setup.guest.createWire({
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
    setup.host.bindMedia(MEDIA);
    setup.guest.bindMedia(MEDIA);
    setup.guestNow.set(2_000);
    setup.hostNow.set(2_100);
    const first = setup.guest.createWire({
      kind: 'source-not-ready',
      observedAtRoomTimeMs: 2_100,
      reasonCode: 'first',
      retryable: true,
    });
    const second = setup.guest.createWire({
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

  it('uses the latest media authority after hostile classification side effects', () => {
    const setup = channels();
    calibrate(setup);
    setup.host.bindMedia(MEDIA);
    setup.guest.bindMedia(MEDIA);
    setup.guestNow.set(2_000);
    setup.hostNow.set(2_100);
    const message = setup.guest.createWire({
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
          setup.host.bindMedia({
            run: { queueItemId: 'queue-item-2', runId: 'run-2', revision: 2 },
            sourceIdentity: 'source-identity-2',
            transferSessionId: null,
          });
        }
        return Reflect.ownKeys(target);
      },
    });

    expect(setup.host.receive(hostile, setup.hostToken)).toEqual({
      accepted: false,
      reason: 'wire-rejected',
    });
    setup.host.bindMedia(MEDIA);
    expect(setup.host.receive(message, setup.hostToken)).toMatchObject({
      accepted: true,
      frame: 'wire',
    });
  });

  it('prevents an outer hostile bind from overwriting re-entrant clear or newer media', () => {
    const setup = channels();
    calibrate(setup);
    setup.host.bindMedia(MEDIA);
    setup.guest.bindMedia(MEDIA);
    const media2: FilePlaybackWireMediaBinding = {
      run: { queueItemId: 'queue-item-2', runId: 'run-2', revision: 2 },
      sourceIdentity: 'source-identity-2',
      transferSessionId: null,
      rendezvousId: 'rendezvous-2',
    };
    const media3: FilePlaybackWireMediaBinding = {
      run: { queueItemId: 'queue-item-3', runId: 'run-3', revision: 3 },
      sourceIdentity: 'source-identity-3',
      transferSessionId: null,
      rendezvousId: 'rendezvous-3',
    };

    let cleared = false;
    const clearDuringBind = new Proxy(media3, {
      ownKeys(target) {
        if (!cleared) {
          cleared = true;
          setup.host.clearMedia();
        }
        return Reflect.ownKeys(target);
      },
    });
    expect(() => setup.host.bindMedia(clearDuringBind)).toThrow(/authority changed/u);
    expect(() =>
      setup.host.createWire({ kind: 'file-playback-cancel', reasonCode: 'must-have-no-media' }),
    ).toThrow(/no media binding/u);

    setup.host.bindMedia(MEDIA);
    let rebound = false;
    const rebindDuringBind = new Proxy(media3, {
      ownKeys(target) {
        if (!rebound) {
          rebound = true;
          setup.host.bindMedia(media2);
        }
        return Reflect.ownKeys(target);
      },
    });
    expect(() => setup.host.bindMedia(rebindDuringBind)).toThrow(/authority changed/u);
    const cancel = setup.host.createWire({
      kind: 'file-playback-cancel',
      reasonCode: 'newer-media-wins',
    });
    expect(cancel.sourceIdentity).toBe('source-identity-2');
    expect(cancel.queueItemId).toBe('queue-item-2');

    setup.guest.bindMedia(media2);
    setup.hostNow.set(2_100);
    setup.guestNow.set(2_000);
    const ready = setup.guest.createWire({
      kind: 'source-not-ready',
      observedAtRoomTimeMs: 2_100,
      reasonCode: 'receiver-kept-newer-media',
      retryable: true,
    });
    expect(setup.host.receive(ready, setup.hostToken)).toMatchObject({
      accepted: true,
      frame: 'wire',
      message: { sourceIdentity: 'source-identity-2' },
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
