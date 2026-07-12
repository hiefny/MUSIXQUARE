import { describe, expect, it, vi } from 'vitest';

import { FilePlaybackConnectionChannel } from '../../network/file-playback-connection-channel.ts';
import {
  FilePlaybackHandshakeIdIssuer,
  FilePlaybackGuestSessionHandshake,
  FilePlaybackHostSessionHandshake,
} from '../../network/file-playback-session-handshake.ts';
import type {
  FilePlaybackApplicationLifecycleEvent,
  FilePlaybackAuxiliaryAdoptionEvent,
} from '../../network/file-playback-application-session.ts';
import type { DataConnection, QueueItemId } from '../../types/index.ts';
import {
  createFilePlaybackProductBaselineV2,
  parseFilePlaybackProductBaselineV2,
  parseFilePlaybackProductReadyV2,
  type FilePlaybackProductBaselineV2,
  type FilePlaybackProductReadyV2,
} from '../file-playback-product-baseline.ts';
import {
  FilePlaybackProductBaselineIdIssuer,
  FilePlaybackProductBaselineSession,
} from '../file-playback-product-baseline-session.ts';
import {
  applyPlaybackTimelineIntent,
  createStoppedPlaybackTimeline,
  type PlaybackTimelineSnapshot,
} from '../playback-timeline.ts';

const HOST_ID = 'host-product-session';
const GUEST_ID = 'guest-product-session';
const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000081' as QueueItemId;
const RUN_ID = '00000000-0000-4000-8000-000000000082';
const OTHER_QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000083' as QueueItemId;
const OTHER_RUN_ID = '00000000-0000-4000-8000-000000000084';

interface FakeNow {
  readonly now: () => number;
  set(value: number): void;
}

interface ChannelPair {
  readonly host: FilePlaybackConnectionChannel;
  readonly guest: FilePlaybackConnectionChannel;
  readonly hostConnection: DataConnection;
  readonly guestConnection: DataConnection;
  readonly hostNow: FakeNow;
  readonly guestNow: FakeNow;
}

function fakeNow(initial = 1_000, onRead?: () => void): FakeNow {
  let value = initial;
  return {
    now: () => {
      onRead?.();
      return value;
    },
    set(next) {
      value = next;
    },
  };
}

function connection(peer: string): DataConnection {
  return {
    peer,
    open: true,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as DataConnection;
}

let pairSequence = 0;

function handshakeIssuer(prefix: string): FilePlaybackHandshakeIdIssuer {
  return new FilePlaybackHandshakeIdIssuer({
    createSessionId: () => `${prefix}-session`,
    createConnectionId: () => `${prefix}-connection`,
    createHelloId: () => `${prefix}-hello`,
  });
}

function channelPair(options: { readonly onHostNow?: () => void } = {}): ChannelPair {
  pairSequence += 1;
  const prefix = `product-pair-${pairSequence}`;
  const hostIssuer = handshakeIssuer(prefix);
  const guestIssuer = handshakeIssuer(`${prefix}-guest`);
  const hostHandshake = new FilePlaybackHostSessionHandshake({
    idIssuer: hostIssuer,
    sessionId: hostIssuer.issueSessionId(),
    connectionId: hostIssuer.issueConnectionId(),
    hostParticipantId: HOST_ID,
    guestParticipantId: GUEST_ID,
  });
  const guestHandshake = new FilePlaybackGuestSessionHandshake({
    idIssuer: guestIssuer,
    guestParticipantId: GUEST_ID,
  });
  const hello = guestHandshake.createHello();
  if (!hello.accepted) throw new Error(hello.reason);
  const welcome = hostHandshake.handleHello(hello.hello);
  if (!welcome.accepted) throw new Error(welcome.reason);
  const acceptedWelcome = guestHandshake.handleWelcome(welcome.welcome);
  if (!acceptedWelcome.accepted) throw new Error(acceptedWelcome.reason);
  const handshakeSnapshot = hostHandshake.createSnapshot();
  if (!handshakeSnapshot.accepted) throw new Error(handshakeSnapshot.reason);
  const acceptedSnapshot = guestHandshake.acceptSnapshot(handshakeSnapshot.snapshot);
  if (!acceptedSnapshot.accepted) throw new Error(acceptedSnapshot.reason);
  const applied = guestHandshake.createApplied();
  if (!applied.accepted) throw new Error(applied.reason);
  const acceptedApplied = hostHandshake.handleApplied(applied.applied);
  if (!acceptedApplied.accepted) throw new Error(acceptedApplied.reason);

  const hostConnection = connection(`${prefix}-guest-peer`);
  const guestConnection = connection(`${prefix}-host-peer`);
  const hostNow = fakeNow(1_000, options.onHostNow);
  const guestNow = fakeNow(1_000);
  return {
    host: new FilePlaybackConnectionChannel(hostHandshake, hostConnection, { now: hostNow.now }),
    guest: new FilePlaybackConnectionChannel(guestHandshake, guestConnection, {
      now: guestNow.now,
      guestAppliedSendConfirmed: true,
    }),
    hostConnection,
    guestConnection,
    hostNow,
    guestNow,
  };
}

function calibrate(pair: ChannelPair, startAtMs = 1_000): void {
  for (let index = 0; index < 5; index += 1) {
    const t0 = startAtMs + index * 100;
    pair.guestNow.set(t0);
    const ping = pair.guest.createClockPing();
    pair.hostNow.set(t0 + 110);
    const hostResult = pair.host.receive(ping, pair.hostConnection);
    if (!hostResult.accepted || hostResult.frame !== 'clock-ping') {
      throw new Error('Host test channel rejected calibration ping');
    }
    pair.guestNow.set(t0 + 20);
    const guestResult = pair.guest.receive(hostResult.pong, pair.guestConnection);
    if (!guestResult.accepted || guestResult.frame !== 'clock-pong') {
      throw new Error('Guest test channel rejected calibration pong');
    }
  }
}

function lifecycle(
  kind: FilePlaybackApplicationLifecycleEvent['kind'],
  role: 'host' | 'guest',
  connectionValue: DataConnection,
  channel: FilePlaybackConnectionChannel | null,
): FilePlaybackApplicationLifecycleEvent {
  return Object.freeze({ kind, role, connection: connectionValue, channel });
}

function auxiliary(
  frame: Readonly<FilePlaybackProductBaselineV2 | FilePlaybackProductReadyV2>,
  connectionValue: DataConnection,
  channel: FilePlaybackConnectionChannel,
): FilePlaybackAuxiliaryAdoptionEvent {
  return Object.freeze({
    frame,
    connection: connectionValue,
    channel,
    connectionToken: connectionValue,
  });
}

function playingTimeline(): PlaybackTimelineSnapshot {
  const initial = createStoppedPlaybackTimeline(1_000, 0);
  const applied = applyPlaybackTimelineIntent(
    initial,
    {
      type: 'play',
      revision: 1,
      run: { queueItemId: QUEUE_ITEM_ID, runId: RUN_ID },
      positionSeconds: 12,
      rate: 2,
    },
    1_000,
  );
  if (!applied.applied) throw new Error(applied.reason);
  return applied.snapshot;
}

function machine(
  options: {
    readonly timeline?: PlaybackTimelineSnapshot | (() => PlaybackTimelineSnapshot);
    readonly sendRequired?: (connection: DataConnection, frame: unknown) => boolean;
    readonly onReady?: ConstructorParameters<
      typeof FilePlaybackProductBaselineSession
    >[0]['onReady'];
    readonly baselineId?: string;
  } = {},
) {
  const timeline = options.timeline ?? createStoppedPlaybackTimeline(1_000, 0);
  return new FilePlaybackProductBaselineSession({
    idIssuer: new FilePlaybackProductBaselineIdIssuer({
      createBaselineId: () => options.baselineId ?? `baseline-${pairSequence + 1}`,
    }),
    getTimelineSnapshot: typeof timeline === 'function' ? timeline : () => timeline,
    sendRequired: options.sendRequired ?? (() => true),
    ...(options.onReady ? { onReady: options.onReady } : {}),
  });
}

function baselineForGuest(pair: ChannelPair, revision = 1) {
  const binding = pair.guest.establishedBinding();
  if (!binding) throw new Error('Missing guest binding');
  return createFilePlaybackProductBaselineV2({
    sessionId: binding.sessionId,
    connectionId: binding.connectionId,
    baselineId: `manual-baseline-${pairSequence}`,
    hostParticipantId: binding.hostParticipantId,
    guestParticipantId: binding.guestParticipantId,
    playbackRevision: revision,
    phase: 'playing',
    queueItemId: QUEUE_ITEM_ID,
    runId: RUN_ID,
    positionSeconds: 4,
    rate: 1,
    anchorRoomTimeMs: 2_000,
  });
}

describe('FilePlaybackProductBaselineSession', () => {
  it('derives and sends one deterministic playing baseline on host establishment', () => {
    const order: string[] = [];
    const pair = channelPair({ onHostNow: () => order.push('room-time') });
    pair.hostNow.set(1_500);
    const sent = vi.fn((_connection: DataConnection, _frame: unknown) => {
      order.push('send');
      return true;
    });
    const session = machine({
      timeline: () => {
        order.push('timeline');
        return playingTimeline();
      },
      sendRequired: sent,
      baselineId: 'baseline-playing',
    });

    const snapshot = session.handleLifecycle(
      lifecycle('established', 'host', pair.hostConnection, pair.host),
    );
    const baseline = parseFilePlaybackProductBaselineV2(sent.mock.calls[0]?.[1]);

    expect(order).toEqual(['timeline', 'room-time', 'send']);
    expect(sent).toHaveBeenCalledOnce();
    expect(sent).toHaveBeenCalledWith(pair.hostConnection, baseline);
    expect(baseline).toMatchObject({
      baselineId: 'baseline-playing',
      playbackRevision: 1,
      phase: 'playing',
      queueItemId: QUEUE_ITEM_ID,
      runId: RUN_ID,
      positionSeconds: 13,
      rate: 2,
      anchorRoomTimeMs: 1_500,
    });
    expect(snapshot).toMatchObject({
      role: 'host',
      status: 'awaiting-ready',
      clockReady: false,
      baselineId: 'baseline-playing',
    });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);

    expect(
      session.handleLifecycle(lifecycle('established', 'host', pair.hostConnection, pair.host)),
    ).toEqual(snapshot);
    session.handleLifecycle(lifecycle('clock-ready', 'host', pair.hostConnection, pair.host));
    expect(sent).toHaveBeenCalledOnce();
    expect(session.snapshot(pair.hostConnection)).toMatchObject({ clockReady: true });
  });

  it('emits a canonical stopped baseline without inventing active media identity', () => {
    const pair = channelPair();
    pair.hostNow.set(2_500);
    const sent = vi.fn(() => true);
    const session = machine({
      timeline: createStoppedPlaybackTimeline(2_000, 4),
      sendRequired: sent,
      baselineId: 'baseline-stopped',
    });

    session.handleLifecycle(lifecycle('established', 'host', pair.hostConnection, pair.host));

    expect(parseFilePlaybackProductBaselineV2(sent.mock.calls[0]?.[1])).toMatchObject({
      playbackRevision: 4,
      phase: 'stopped',
      queueItemId: null,
      runId: null,
      positionSeconds: 0,
      rate: 1,
      anchorRoomTimeMs: 2_500,
    });
  });

  it('completes baseline and READY exactly once in both lifecycle orderings', () => {
    const pair = channelPair();
    const hostSent = vi.fn(() => true);
    const guestSent = vi.fn(() => true);
    const hostReady = vi.fn();
    const guestReady = vi.fn();
    const hostSession = machine({
      timeline: playingTimeline(),
      sendRequired: hostSent,
      onReady: hostReady,
      baselineId: 'baseline-round-trip',
    });
    const guestSession = machine({ sendRequired: guestSent, onReady: guestReady });
    hostSession.handleLifecycle(lifecycle('established', 'host', pair.hostConnection, pair.host));
    guestSession.handleLifecycle(
      lifecycle('established', 'guest', pair.guestConnection, pair.guest),
    );
    const baseline = parseFilePlaybackProductBaselineV2(hostSent.mock.calls[0]?.[1]);
    if (!baseline) throw new Error('Missing host baseline');

    calibrate(pair);
    guestSession.handleLifecycle(
      lifecycle('clock-ready', 'guest', pair.guestConnection, pair.guest),
    );
    expect(guestSent).not.toHaveBeenCalled();
    expect(guestSession.snapshot(pair.guestConnection)).toMatchObject({
      status: 'awaiting-baseline',
      clockReady: true,
    });

    expect(guestSession.adoptAuxiliary(auxiliary(baseline, pair.guestConnection, pair.guest))).toBe(
      true,
    );
    const ready = parseFilePlaybackProductReadyV2(guestSent.mock.calls[0]?.[1]);
    if (!ready) throw new Error('Missing guest READY');
    expect(ready).toMatchObject({
      baselineId: baseline.baselineId,
      playbackRevision: baseline.playbackRevision,
      guestParticipantId: GUEST_ID,
    });
    expect(guestReady).toHaveBeenCalledOnce();
    expect(guestSession.snapshot(pair.guestConnection)).toMatchObject({ status: 'ready' });

    expect(guestSession.adoptAuxiliary(auxiliary(baseline, pair.guestConnection, pair.guest))).toBe(
      true,
    );
    guestSession.handleLifecycle(
      lifecycle('clock-ready', 'guest', pair.guestConnection, pair.guest),
    );
    expect(guestSent).toHaveBeenCalledOnce();
    expect(guestReady).toHaveBeenCalledOnce();

    expect(hostSession.adoptAuxiliary(auxiliary(ready, pair.hostConnection, pair.host))).toBe(true);
    expect(hostReady).toHaveBeenCalledOnce();
    expect(hostSession.adoptAuxiliary(auxiliary(ready, pair.hostConnection, pair.host))).toBe(true);
    expect(hostReady).toHaveBeenCalledOnce();
    expect(hostSession.snapshot(pair.hostConnection)).toMatchObject({ status: 'ready' });
    const conflictingReady = Object.freeze({
      ...ready,
      observedAtRoomTimeMs: ready.observedAtRoomTimeMs + 1,
    }) as Readonly<FilePlaybackProductReadyV2>;
    expect(() =>
      hostSession.adoptAuxiliary(auxiliary(conflictingReady, pair.hostConnection, pair.host)),
    ).toThrow(/conflicts/u);
    expect(hostReady).toHaveBeenCalledOnce();
    expect(hostSession.snapshot(pair.hostConnection)).toBeNull();

    const secondPair = channelPair();
    calibrate(secondPair);
    const secondSent = vi.fn(() => true);
    const secondGuest = machine({ sendRequired: secondSent });
    secondGuest.handleLifecycle(
      lifecycle('established', 'guest', secondPair.guestConnection, secondPair.guest),
    );
    const secondBaseline = baselineForGuest(secondPair);
    secondGuest.adoptAuxiliary(
      auxiliary(secondBaseline, secondPair.guestConnection, secondPair.guest),
    );
    expect(secondSent).not.toHaveBeenCalled();
    secondGuest.handleLifecycle(
      lifecycle('clock-ready', 'guest', secondPair.guestConnection, secondPair.guest),
    );
    expect(secondSent).toHaveBeenCalledOnce();
  });

  it('rejects wrong direction, scope, rollback, and conflicting duplicates', () => {
    const hostPair = channelPair();
    const hostSession = machine({ baselineId: 'baseline-direction' });
    hostSession.handleLifecycle(
      lifecycle('established', 'host', hostPair.hostConnection, hostPair.host),
    );
    const hostBaseline = hostSession.snapshot(hostPair.hostConnection)?.baseline;
    if (!hostBaseline) throw new Error('Missing direction baseline');
    expect(() =>
      hostSession.adoptAuxiliary(auxiliary(hostBaseline, hostPair.hostConnection, hostPair.host)),
    ).toThrow(/cannot receive/u);
    expect(hostSession.snapshot(hostPair.hostConnection)).toBeNull();

    const guestPair = channelPair();
    const guestSession = machine({ timeline: createStoppedPlaybackTimeline(1_000, 2) });
    guestSession.handleLifecycle(
      lifecycle('established', 'guest', guestPair.guestConnection, guestPair.guest),
    );
    expect(() =>
      guestSession.adoptAuxiliary(
        auxiliary(baselineForGuest(guestPair, 1), guestPair.guestConnection, guestPair.guest),
      ),
    ).toThrow(/roll/u);
    expect(guestSession.snapshot(guestPair.guestConnection)).toBeNull();

    const duplicatePair = channelPair();
    const duplicateSession = machine();
    duplicateSession.handleLifecycle(
      lifecycle('established', 'guest', duplicatePair.guestConnection, duplicatePair.guest),
    );
    const baseline = baselineForGuest(duplicatePair);
    expect(
      duplicateSession.adoptAuxiliary(
        auxiliary(baseline, duplicatePair.guestConnection, duplicatePair.guest),
      ),
    ).toBe(true);
    const conflicting = Object.freeze({
      ...baseline,
      positionSeconds: baseline.positionSeconds + 1,
    }) as Readonly<FilePlaybackProductBaselineV2>;
    expect(() =>
      duplicateSession.adoptAuxiliary(
        auxiliary(conflicting, duplicatePair.guestConnection, duplicatePair.guest),
      ),
    ).toThrow(/conflicts/u);
    expect(duplicateSession.snapshot(duplicatePair.guestConnection)).toBeNull();

    const scopePair = channelPair();
    const scopeSession = machine();
    scopeSession.handleLifecycle(
      lifecycle('established', 'guest', scopePair.guestConnection, scopePair.guest),
    );
    const wrongScope = Object.freeze({
      ...baselineForGuest(scopePair),
      guestParticipantId: 'different-guest',
    }) as Readonly<FilePlaybackProductBaselineV2>;
    expect(() =>
      scopeSession.adoptAuxiliary(
        auxiliary(wrongScope, scopePair.guestConnection, scopePair.guest),
      ),
    ).toThrow(/scope/u);

    const equalPair = channelPair();
    const equalSession = machine({ timeline: playingTimeline() });
    equalSession.handleLifecycle(
      lifecycle('established', 'guest', equalPair.guestConnection, equalPair.guest),
    );
    const equalForeign = Object.freeze({
      ...baselineForGuest(equalPair, 1),
      queueItemId: OTHER_QUEUE_ITEM_ID,
      runId: OTHER_RUN_ID,
      rate: 2,
    }) as Readonly<FilePlaybackProductBaselineV2>;
    expect(() =>
      equalSession.adoptAuxiliary(
        auxiliary(equalForeign, equalPair.guestConnection, equalPair.guest),
      ),
    ).toThrow(/equal local playback revision/u);

    const trajectoryPair = channelPair();
    const trajectorySession = machine({ timeline: playingTimeline() });
    trajectorySession.handleLifecycle(
      lifecycle('established', 'guest', trajectoryPair.guestConnection, trajectoryPair.guest),
    );
    const forgedTrajectory = Object.freeze({
      ...baselineForGuest(trajectoryPair, 1),
      positionSeconds: 13,
      rate: 2,
    }) as Readonly<FilePlaybackProductBaselineV2>;
    expect(() =>
      trajectorySession.adoptAuxiliary(
        auxiliary(forgedTrajectory, trajectoryPair.guestConnection, trajectoryPair.guest),
      ),
    ).toThrow(/equal local playback revision/u);

    const equivalentPair = channelPair();
    const equivalentSession = machine({ timeline: playingTimeline() });
    equivalentSession.handleLifecycle(
      lifecycle('established', 'guest', equivalentPair.guestConnection, equivalentPair.guest),
    );
    const equivalentTrajectory = Object.freeze({
      ...baselineForGuest(equivalentPair, 1),
      positionSeconds: 14,
      rate: 2,
    }) as Readonly<FilePlaybackProductBaselineV2>;
    expect(
      equivalentSession.adoptAuxiliary(
        auxiliary(equivalentTrajectory, equivalentPair.guestConnection, equivalentPair.guest),
      ),
    ).toBe(true);
  });

  it('revalidates a pending baseline against timeline changes before READY', () => {
    const pair = channelPair();
    let timeline = createStoppedPlaybackTimeline(1_000, 0);
    const sent = vi.fn(() => true);
    const session = machine({ timeline: () => timeline, sendRequired: sent });
    session.handleLifecycle(lifecycle('established', 'guest', pair.guestConnection, pair.guest));
    session.adoptAuxiliary(auxiliary(baselineForGuest(pair, 1), pair.guestConnection, pair.guest));

    const playing = applyPlaybackTimelineIntent(
      timeline,
      {
        type: 'play',
        revision: 1,
        run: { queueItemId: QUEUE_ITEM_ID, runId: RUN_ID },
        positionSeconds: 4,
        rate: 1,
      },
      1_000,
    );
    if (!playing.applied) throw new Error(playing.reason);
    const paused = applyPlaybackTimelineIntent(
      playing.snapshot,
      {
        type: 'pause',
        revision: 2,
        run: { queueItemId: QUEUE_ITEM_ID, runId: RUN_ID },
      },
      1_100,
    );
    if (!paused.applied) throw new Error(paused.reason);
    timeline = paused.snapshot;

    calibrate(pair);
    expect(() =>
      session.handleLifecycle(lifecycle('clock-ready', 'guest', pair.guestConnection, pair.guest)),
    ).toThrow(/stale before READY/u);
    expect(sent).not.toHaveBeenCalled();
    expect(session.snapshot(pair.guestConnection)).toBeNull();
  });

  it('fails closed on required-send loss and swallowed re-entry', () => {
    const failedPair = channelPair();
    const failedSession = machine({ sendRequired: () => false, baselineId: 'baseline-send-loss' });
    expect(() =>
      failedSession.handleLifecycle(
        lifecycle('established', 'host', failedPair.hostConnection, failedPair.host),
      ),
    ).toThrow(/send failed/u);
    expect(failedSession.snapshot(failedPair.hostConnection)).toBeNull();

    const guestPair = channelPair();
    calibrate(guestPair);
    const failedGuest = machine({ sendRequired: () => false });
    failedGuest.handleLifecycle(
      lifecycle('established', 'guest', guestPair.guestConnection, guestPair.guest),
    );
    failedGuest.adoptAuxiliary(
      auxiliary(baselineForGuest(guestPair), guestPair.guestConnection, guestPair.guest),
    );
    expect(() =>
      failedGuest.handleLifecycle(
        lifecycle('clock-ready', 'guest', guestPair.guestConnection, guestPair.guest),
      ),
    ).toThrow(/READY send failed/u);
    expect(failedGuest.snapshot(guestPair.guestConnection)).toBeNull();

    const reentrantPair = channelPair();
    let reentrantSession!: FilePlaybackProductBaselineSession;
    reentrantSession = machine({
      baselineId: 'baseline-reentrant',
      sendRequired: () => {
        reentrantSession.handleLifecycle(
          lifecycle('revoked', 'host', reentrantPair.hostConnection, reentrantPair.host),
        );
        return true;
      },
    });
    expect(() =>
      reentrantSession.handleLifecycle(
        lifecycle('established', 'host', reentrantPair.hostConnection, reentrantPair.host),
      ),
    ).toThrow(/re-entry|revoked/u);
    expect(reentrantSession.snapshot(reentrantPair.hostConnection)).toBeNull();
  });

  it('binds replacement connections independently and revokes only the exact record', () => {
    const first = channelPair();
    const replacement = channelPair();
    const session = machine();
    session.handleLifecycle(lifecycle('established', 'guest', first.guestConnection, first.guest));
    session.handleLifecycle(
      lifecycle('established', 'guest', replacement.guestConnection, replacement.guest),
    );

    session.handleLifecycle(lifecycle('revoked', 'guest', first.guestConnection, first.guest));
    expect(session.snapshot(first.guestConnection)).toBeNull();
    expect(session.snapshot(replacement.guestConnection)).toMatchObject({
      status: 'awaiting-baseline',
    });
    expect(() =>
      session.adoptAuxiliary(
        auxiliary(baselineForGuest(first), first.guestConnection, first.guest),
      ),
    ).toThrow(/no matching session/u);
    expect(session.snapshot(replacement.guestConnection)).not.toBeNull();
  });

  it('rejects hostile accessors without invoking them or exposing live authority', () => {
    let getterReads = 0;
    const badOptions = {
      get idIssuer() {
        getterReads += 1;
        return new FilePlaybackProductBaselineIdIssuer();
      },
      getTimelineSnapshot: () => createStoppedPlaybackTimeline(),
      sendRequired: () => true,
    };
    expect(() => new FilePlaybackProductBaselineSession(badOptions)).toThrow(/options/u);
    expect(getterReads).toBe(0);

    const pair = channelPair();
    const hostileTimeline = { ...playingTimeline() } as Record<string, unknown>;
    Object.defineProperty(hostileTimeline, 'phase', {
      enumerable: true,
      get() {
        getterReads += 1;
        return 'playing';
      },
    });
    const session = machine({
      timeline: () => hostileTimeline as unknown as PlaybackTimelineSnapshot,
    });
    expect(() =>
      session.handleLifecycle(lifecycle('established', 'host', pair.hostConnection, pair.host)),
    ).toThrow(/timeline/u);
    expect(getterReads).toBe(0);
    expect(session.snapshot(pair.hostConnection)).toBeNull();

    const guestSession = machine();
    guestSession.handleLifecycle(
      lifecycle('established', 'guest', pair.guestConnection, pair.guest),
    );
    const hostileFrame = { ...baselineForGuest(pair) } as Record<string, unknown>;
    Object.defineProperty(hostileFrame, 'type', {
      enumerable: true,
      get() {
        getterReads += 1;
        return 'FILE_PLAYBACK_PRODUCT_BASELINE_V2';
      },
    });
    expect(() =>
      guestSession.adoptAuxiliary({
        frame: hostileFrame as never,
        connection: pair.guestConnection,
        channel: pair.guest,
        connectionToken: pair.guestConnection,
      }),
    ).toThrow(/malformed/u);
    expect(getterReads).toBe(0);

    const publicSnapshot = guestSession.snapshot(pair.guestConnection);
    expect(publicSnapshot).not.toHaveProperty('connection');
    expect(publicSnapshot).not.toHaveProperty('channel');
    expect(publicSnapshot).not.toHaveProperty('connectionToken');
    expect(JSON.parse(JSON.stringify(publicSnapshot))).toEqual(publicSnapshot);
  });

  it('bounds issuer history while rejecting IDs still inside the recent window', () => {
    let next = 0;
    let forced: string | null = null;
    const issuer = new FilePlaybackProductBaselineIdIssuer({
      createBaselineId: () => forced ?? `recent-baseline-${next++}`,
    });
    for (let index = 0; index <= 4_096; index += 1) issuer.issueBaselineId();

    forced = 'recent-baseline-0';
    expect(issuer.issueBaselineId()).toBe('recent-baseline-0');
    forced = 'recent-baseline-4096';
    expect(() => issuer.issueBaselineId()).toThrow(/must not be reused/u);
  });

  it('fails closed when an ID factory swallows its own re-entry error', () => {
    let issuer!: FilePlaybackProductBaselineIdIssuer;
    issuer = new FilePlaybackProductBaselineIdIssuer({
      createBaselineId: () => {
        try {
          issuer.issueBaselineId();
        } catch {
          // A hostile callback must not turn a detected nested issuance into a
          // successful outer issuance merely by swallowing the inner error.
        }
        return 'baseline-after-swallowed-reentry';
      },
    });

    expect(() => issuer.issueBaselineId()).toThrow(/re-entry/u);
  });
});
