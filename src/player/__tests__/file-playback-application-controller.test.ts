import { describe, expect, it, vi } from 'vitest';

import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import {
  FilePlaybackApplicationSessionManager,
  type FilePlaybackApplicationLifecycleEvent,
  type FilePlaybackAuxiliaryAdoptionEvent,
} from '../../network/file-playback-application-session.ts';
import { FilePlaybackConnectionChannel } from '../../network/file-playback-connection-channel.ts';
import {
  FilePlaybackGuestSessionHandshake,
  FilePlaybackHandshakeIdIssuer,
  FilePlaybackHostSessionHandshake,
} from '../../network/file-playback-session-handshake.ts';
import {
  FILE_MEDIA_SOURCE_OFFER_V2_TYPE,
  FILE_PLAYBACK_RUN_BINDING_V2_TYPE,
} from '../../network/file-playback-transport-contract.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import type { DataConnection, QueueItemId } from '../../types/index.ts';
import {
  FilePlaybackApplicationController,
  type FilePlaybackApplicationControllerOptions,
} from '../file-playback-application-controller.ts';
import {
  createFilePlaybackProductBaselineV2,
  parseFilePlaybackProductBaselineV2,
  parseFilePlaybackProductReadyV2,
  type FilePlaybackProductBaselineV2,
  type FilePlaybackProductReadyV2,
} from '../file-playback-product-baseline.ts';
import { FilePlaybackProductBaselineIdIssuer } from '../file-playback-product-baseline-session.ts';
import { createPlaybackRunIdentity } from '../playback-identity.ts';
import {
  createStoppedPlaybackTimeline,
  type PlaybackTimelineSnapshot,
} from '../playback-timeline.ts';

const HOST_ID = 'controller-host';
const GUEST_ID = 'controller-guest';
const QUEUE_ID = '00000000-0000-4000-8000-0000000000c1' as QueueItemId;
const RUN_ID = '00000000-0000-4000-8000-0000000000c2';
const OTHER_QUEUE_ID = '00000000-0000-4000-8000-0000000000c3' as QueueItemId;
const OTHER_RUN_ID = '00000000-0000-4000-8000-0000000000c4';

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

function fakeNow(initial = 1_000): FakeNow {
  let value = initial;
  return { now: () => value, set: (next) => void (value = next) };
}

function connection(peer: string): DataConnection {
  return {
    peer,
    open: true,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as DataConnection;
}

let sequence = 0;

function issuer(prefix: string): FilePlaybackHandshakeIdIssuer {
  return new FilePlaybackHandshakeIdIssuer({
    createSessionId: () => `${prefix}-session`,
    createConnectionId: () => `${prefix}-connection`,
    createHelloId: () => `${prefix}-hello`,
  });
}

function channelPair(
  connections: Partial<Pick<ChannelPair, 'hostConnection' | 'guestConnection'>> = {},
): ChannelPair {
  sequence += 1;
  const prefix = `controller-pair-${sequence}`;
  const hostIssuer = issuer(prefix);
  const guestIssuer = issuer(`${prefix}-guest`);
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
  const welcomed = guestHandshake.handleWelcome(welcome.welcome);
  if (!welcomed.accepted) throw new Error(welcomed.reason);
  const snapshot = hostHandshake.createSnapshot();
  if (!snapshot.accepted) throw new Error(snapshot.reason);
  const accepted = guestHandshake.acceptSnapshot(snapshot.snapshot);
  if (!accepted.accepted) throw new Error(accepted.reason);
  const applied = guestHandshake.createApplied();
  if (!applied.accepted) throw new Error(applied.reason);
  const hostApplied = hostHandshake.handleApplied(applied.applied);
  if (!hostApplied.accepted) throw new Error(hostApplied.reason);

  const hostConnection = connections.hostConnection ?? connection(`${prefix}-guest-peer`);
  const guestConnection = connections.guestConnection ?? connection(`${prefix}-host-peer`);
  const hostNow = fakeNow();
  const guestNow = fakeNow();
  return {
    hostConnection,
    guestConnection,
    hostNow,
    guestNow,
    host: new FilePlaybackConnectionChannel(hostHandshake, hostConnection, { now: hostNow.now }),
    guest: new FilePlaybackConnectionChannel(guestHandshake, guestConnection, {
      now: guestNow.now,
      guestAppliedSendConfirmed: true,
    }),
  };
}

function calibrate(pair: ChannelPair): void {
  for (let index = 0; index < 5; index += 1) {
    const t0 = 1_000 + index * 100;
    pair.guestNow.set(t0);
    const ping = pair.guest.createClockPing();
    pair.hostNow.set(t0 + 110);
    const host = pair.host.receive(ping, pair.hostConnection);
    if (!host.accepted || host.frame !== 'clock-ping') throw new Error('Host clock rejected ping');
    pair.guestNow.set(t0 + 20);
    const guest = pair.guest.receive(host.pong, pair.guestConnection);
    if (!guest.accepted || guest.frame !== 'clock-pong') {
      throw new Error('Guest clock rejected pong');
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
  frame: Readonly<FilePlaybackProductBaselineV2 | FilePlaybackProductReadyV2> | object,
  connectionValue: DataConnection,
  channel: FilePlaybackConnectionChannel,
): FilePlaybackAuxiliaryAdoptionEvent {
  return Object.freeze({
    frame: frame as FilePlaybackAuxiliaryAdoptionEvent['frame'],
    connection: connectionValue,
    channel,
    connectionToken: connectionValue,
  });
}

function playingTimeline(revision: number, queueItemId = QUEUE_ID, runId = RUN_ID) {
  return Object.freeze({
    schemaVersion: 1 as const,
    revision,
    phase: 'playing' as const,
    run: createPlaybackRunIdentity({ queueItemId, runId }),
    positionSeconds: 12,
    anchorMonotonicMs: 1_000,
    rate: 1,
  });
}

function baselineForGuest(
  pair: ChannelPair,
  revision: number,
  queueItemId = QUEUE_ID,
  runId = RUN_ID,
) {
  const binding = pair.guest.establishedBinding();
  if (!binding) throw new Error('Guest binding is missing');
  return createFilePlaybackProductBaselineV2({
    sessionId: binding.sessionId,
    connectionId: binding.connectionId,
    baselineId: `controller-manual-baseline-${++sequence}`,
    hostParticipantId: binding.hostParticipantId,
    guestParticipantId: binding.guestParticipantId,
    playbackRevision: revision,
    phase: 'playing',
    queueItemId,
    runId,
    positionSeconds: 12,
    rate: 1,
    anchorRoomTimeMs: 1_000,
  });
}

function controller(
  options: Partial<FilePlaybackApplicationControllerOptions> & {
    readonly initialTimeline?: PlaybackTimelineSnapshot;
  } = {},
): FilePlaybackApplicationController {
  const suffix = ++sequence;
  return new FilePlaybackApplicationController({
    initialTimeline: options.initialTimeline ?? createStoppedPlaybackTimeline(1_000, 0),
    idIssuer:
      options.idIssuer ??
      new FilePlaybackProductBaselineIdIssuer({
        createBaselineId: () => `controller-baseline-${suffix}`,
      }),
    sendRequired: options.sendRequired ?? (() => true),
    closeConnection: options.closeConnection ?? (() => undefined),
    ...(options.onHostReady ? { onHostReady: options.onHostReady } : {}),
    ...(options.onTimelineAdopted ? { onTimelineAdopted: options.onTimelineAdopted } : {}),
  });
}

describe('FilePlaybackApplicationController', () => {
  it('completes host-to-guest baseline/READY and adopts an arbitrary higher revision before ACK', () => {
    const pair = channelPair();
    const hostFrames: unknown[] = [];
    const guestFrames: unknown[] = [];
    const adoptionOrder: string[] = [];
    const hostReady = vi.fn();
    const adopted = vi.fn(() => adoptionOrder.push('callback'));
    const host = controller({
      initialTimeline: playingTimeline(137),
      sendRequired: (_connection, frame) => (hostFrames.push(frame), true),
      onHostReady: hostReady,
    });
    const guest = controller({
      initialTimeline: createStoppedPlaybackTimeline(500, 3),
      sendRequired: (_connection, frame) => (guestFrames.push(frame), true),
      onTimelineAdopted: adopted,
    });
    const stableHooks = host.applicationSessionHooks();
    expect(stableHooks).toBe(host.applicationSessionHooks());
    expect(Object.isFrozen(stableHooks)).toBe(true);
    expect(Object.getPrototypeOf(stableHooks)).toBeNull();
    expect(Object.keys(stableHooks).sort()).toEqual([
      'adoptAuxiliaryMessage',
      'adoptPeerRangeMessage',
      'adoptWireMessage',
      'onLifecycleEvent',
    ]);

    guest
      .applicationSessionHooks()
      .onLifecycleEvent(lifecycle('established', 'guest', pair.guestConnection, pair.guest));
    host
      .applicationSessionHooks()
      .onLifecycleEvent(lifecycle('established', 'host', pair.hostConnection, pair.host));
    const baseline = parseFilePlaybackProductBaselineV2(hostFrames[0]);
    if (!baseline) throw new Error('Host did not send a baseline');
    expect(baseline.playbackRevision).toBe(137);

    calibrate(pair);
    guest
      .applicationSessionHooks()
      .onLifecycleEvent(lifecycle('clock-ready', 'guest', pair.guestConnection, pair.guest));
    const guestAck = vi.fn(() => adoptionOrder.push('ack'));
    guest
      .applicationSessionHooks()
      .adoptAuxiliaryMessage(auxiliary(baseline, pair.guestConnection, pair.guest), guestAck);
    expect(guestAck).toHaveBeenCalledOnce();
    expect(guest.timelineSnapshot()).toMatchObject({
      revision: 137,
      phase: 'playing',
      run: { queueItemId: QUEUE_ID, runId: RUN_ID },
    });
    expect(adopted).toHaveBeenCalledOnce();
    expect(adoptionOrder).toEqual(['ack', 'callback']);
    const ready = parseFilePlaybackProductReadyV2(guestFrames[0]);
    if (!ready) throw new Error('Guest did not send READY');

    const hostAck = vi.fn();
    host
      .applicationSessionHooks()
      .adoptAuxiliaryMessage(auxiliary(ready, pair.hostConnection, pair.host), hostAck);
    expect(hostAck).toHaveBeenCalledOnce();
    expect(hostReady).toHaveBeenCalledOnce();
    expect(host.connectionSnapshot(pair.hostConnection)).toMatchObject({
      baselineStatus: 'ready',
      ready: true,
      playbackRevision: 137,
    });
    expect(JSON.parse(JSON.stringify(host.snapshot()))).toEqual(host.snapshot());
    expect(JSON.parse(JSON.stringify(guest.snapshot()))).toEqual(guest.snapshot());
  });

  it('relays baseline/READY through real application-session managers without ACK teardown', () => {
    bus.clear();
    const frames: Array<{ readonly from: 'host' | 'guest'; readonly value: unknown }> = [];
    const relayConnection = (from: 'host' | 'guest', peer: string): DataConnection =>
      ({
        peer,
        open: true,
        send(value: unknown) {
          frames.push({ from, value });
        },
        close() {
          this.open = false;
        },
        on: vi.fn(),
      }) as unknown as DataConnection;
    const hostConnection = relayConnection('host', 'controller-manager-guest');
    const guestConnection = relayConnection('guest', 'controller-manager-host');
    const hostManager = new FilePlaybackApplicationSessionManager(
      issuer('controller-manager-host'),
    );
    const guestManager = new FilePlaybackApplicationSessionManager(
      issuer('controller-manager-guest'),
    );
    const hostReady = vi.fn();
    const hostController = controller({
      initialTimeline: createStoppedPlaybackTimeline(0, 33),
      sendRequired: (connectionValue, frame) => hostManager.sendRequired(connectionValue, frame),
      closeConnection: (connectionValue) => hostManager.closeConnection(connectionValue, true),
      onHostReady: hostReady,
    });
    const guestController = controller({
      sendRequired: (connectionValue, frame) => guestManager.sendRequired(connectionValue, frame),
      closeConnection: (connectionValue) => guestManager.closeConnection(connectionValue, true),
    });
    hostManager.installHooks(hostController.applicationSessionHooks());
    guestManager.installHooks(guestController.applicationSessionHooks());
    bus.on('network:peer-bootstrap', (_connection, send, acknowledge) => {
      acknowledge(
        send({
          type: MSG.PLAYLIST_UPDATE,
          list: [],
          currentQueueItemId: null,
          revision: 0,
          bootstrap: true,
        }) &&
          send({ type: MSG.REPEAT_MODE, value: 0, _bootstrap: true }) &&
          send({ type: MSG.SHUFFLE_MODE, value: false, _bootstrap: true }),
      );
    });
    bus.on('network:peer-bootstrap-apply', (frame, connectionValue, acknowledge) => {
      const value = frame as Record<string, unknown>;
      if (value.type === MSG.PLAYLIST_UPDATE) markQueueAuthorityReady(connectionValue);
      acknowledge(
        value.type === MSG.PLAYLIST_UPDATE ||
          value.type === MSG.REPEAT_MODE ||
          value.type === MSG.SHUFFLE_MODE,
      );
    });

    try {
      hostManager.beginHostRoom('controller-manager-host');
      expect(hostManager.beginHostConnection(hostConnection, 'controller-manager-guest')).toBe(
        true,
      );
      expect(guestManager.beginGuestConnection(guestConnection, 'controller-manager-guest')).toBe(
        true,
      );
      let deliveries = 0;
      while (frames.length > 0) {
        if (++deliveries > 200) throw new Error('Application-session relay did not quiesce');
        const frame = frames.shift()!;
        if (frame.from === 'host') guestManager.receive(frame.value, guestConnection);
        else hostManager.receive(frame.value, hostConnection);
      }

      expect(hostManager.phase(hostConnection)).toBe('established');
      expect(guestManager.phase(guestConnection)).toBe('established');
      expect(hostReady).toHaveBeenCalledOnce();
      expect(hostController.connectionSnapshot(hostConnection)).toMatchObject({
        baselineStatus: 'ready',
        ready: true,
      });
      expect(guestController.timelineSnapshot()).toMatchObject({
        revision: 33,
        phase: 'stopped',
      });
      expect(hostConnection.open).toBe(true);
      expect(guestConnection.open).toBe(true);
    } finally {
      hostManager.endRoom();
      guestManager.endRoom();
      bus.clear();
    }
  });

  it('rejects an equal-revision foreign baseline without ACK and signals exact closure', () => {
    const pair = channelPair();
    const closeConnection = vi.fn();
    const guest = controller({
      initialTimeline: playingTimeline(7),
      closeConnection,
    });
    const hooks = guest.applicationSessionHooks();
    hooks.onLifecycleEvent(lifecycle('established', 'guest', pair.guestConnection, pair.guest));
    const signal = guest.connectionSignal(pair.guestConnection);
    const binding = pair.guest.establishedBinding();
    if (!binding) throw new Error('Guest binding is missing');
    const conflict = createFilePlaybackProductBaselineV2({
      sessionId: binding.sessionId,
      connectionId: binding.connectionId,
      baselineId: 'controller-conflict-baseline',
      hostParticipantId: binding.hostParticipantId,
      guestParticipantId: binding.guestParticipantId,
      playbackRevision: 7,
      phase: 'playing',
      queueItemId: OTHER_QUEUE_ID,
      runId: OTHER_RUN_ID,
      positionSeconds: 12,
      rate: 1,
      anchorRoomTimeMs: 1_000,
    });
    const acknowledge = vi.fn();

    expect(() =>
      hooks.adoptAuxiliaryMessage(
        auxiliary(conflict, pair.guestConnection, pair.guest),
        acknowledge,
      ),
    ).toThrow(/equal local playback revision/u);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(closeConnection).toHaveBeenCalledOnce();
    expect(closeConnection).toHaveBeenCalledWith(pair.guestConnection);
    expect(signal?.aborted).toBe(true);
    expect(guest.connectionSnapshot(pair.guestConnection)).toBeNull();
    expect(guest.timelineSnapshot()).toEqual(playingTimeline(7));
  });

  it('revokes baseline before abort/removal and resets revision only through beginRoom', () => {
    const pair = channelPair();
    const closeConnection = vi.fn();
    const guest = controller({ initialTimeline: playingTimeline(22), closeConnection });
    const hooks = guest.applicationSessionHooks();
    const established = lifecycle('established', 'guest', pair.guestConnection, pair.guest);
    hooks.onLifecycleEvent(established);
    const signal = guest.connectionSignal(pair.guestConnection);
    expect(signal?.aborted).toBe(false);
    expect(guest.connectionEpoch(pair.guestConnection)).toBe(1);

    hooks.onLifecycleEvent(lifecycle('revoked', 'guest', pair.guestConnection, pair.guest));
    expect(signal?.aborted).toBe(true);
    expect(guest.connectionEpoch(pair.guestConnection)).toBe(2);
    expect(guest.connectionSnapshot(pair.guestConnection)).toBeNull();
    expect(guest.timelineSnapshot().revision).toBe(22);
    expect(closeConnection).not.toHaveBeenCalled();
    hooks.onLifecycleEvent(lifecycle('revoked', 'guest', pair.guestConnection, pair.guest));
    expect(guest.connectionEpoch(pair.guestConnection)).toBe(2);

    const sameObjectReplacement = channelPair({ guestConnection: pair.guestConnection });
    expect(() =>
      hooks.onLifecycleEvent(
        lifecycle('established', 'guest', pair.guestConnection, sameObjectReplacement.guest),
      ),
    ).toThrow(/one-shot/u);
    expect(guest.connectionEpoch(pair.guestConnection)).toBe(2);
    expect(closeConnection).toHaveBeenCalledWith(pair.guestConnection);

    const replacement = channelPair();
    hooks.onLifecycleEvent(
      lifecycle('established', 'guest', replacement.guestConnection, replacement.guest),
    );
    const replacementSignal = guest.connectionSignal(replacement.guestConnection);
    const room = guest.beginRoom(createStoppedPlaybackTimeline(9_000, 0));
    expect(room.roomGeneration).toBe(2);
    expect(room.timeline.revision).toBe(0);
    expect(room.activeConnectionCount).toBe(0);
    expect(replacementSignal?.aborted).toBe(true);
    expect(closeConnection).toHaveBeenCalledWith(replacement.guestConnection);
    expect(() =>
      hooks.onLifecycleEvent(
        lifecycle('clock-ready', 'guest', replacement.guestConnection, replacement.guest),
      ),
    ).toThrow(/no exact live record/u);
  });

  it('fails duplicate/reentrant establishment closed', () => {
    const duplicatePair = channelPair();
    const duplicateClose = vi.fn();
    const duplicate = controller({ closeConnection: duplicateClose });
    const duplicateHooks = duplicate.applicationSessionHooks();
    const duplicateEvent = lifecycle(
      'established',
      'guest',
      duplicatePair.guestConnection,
      duplicatePair.guest,
    );
    duplicateHooks.onLifecycleEvent(duplicateEvent);
    const signal = duplicate.connectionSignal(duplicatePair.guestConnection);
    expect(() => duplicateHooks.onLifecycleEvent(duplicateEvent)).toThrow(/duplicate|replaced/u);
    expect(signal?.aborted).toBe(true);
    expect(duplicateClose).toHaveBeenCalledOnce();

    const replacementPair = channelPair();
    const foreignChannelPair = channelPair();
    const replacementClose = vi.fn();
    const replacement = controller({ closeConnection: replacementClose });
    const replacementHooks = replacement.applicationSessionHooks();
    replacementHooks.onLifecycleEvent(
      lifecycle('established', 'guest', replacementPair.guestConnection, replacementPair.guest),
    );
    const replacementSignal = replacement.connectionSignal(replacementPair.guestConnection);
    expect(() =>
      replacementHooks.onLifecycleEvent(
        lifecycle(
          'established',
          'guest',
          replacementPair.guestConnection,
          foreignChannelPair.guest,
        ),
      ),
    ).toThrow(/duplicate|replaced/u);
    expect(replacementSignal?.aborted).toBe(true);
    expect(replacementClose).toHaveBeenCalledOnce();

    const reentrantPair = channelPair();
    let reentrant!: FilePlaybackApplicationController;
    let nestedError: unknown = null;
    reentrant = controller({
      initialTimeline: playingTimeline(2),
      sendRequired: () => {
        try {
          reentrant
            .applicationSessionHooks()
            .onLifecycleEvent(
              lifecycle('established', 'host', reentrantPair.hostConnection, reentrantPair.host),
            );
        } catch (error) {
          nestedError = error;
        }
        return true;
      },
    });
    expect(() =>
      reentrant
        .applicationSessionHooks()
        .onLifecycleEvent(
          lifecycle('established', 'host', reentrantPair.hostConnection, reentrantPair.host),
        ),
    ).toThrow(/re-entry|revoked|superseded/u);
    expect(nestedError).toBeInstanceOf(Error);
    expect(reentrant.connectionSnapshot(reentrantPair.hostConnection)).toBeNull();
  });

  it('defers abort callbacks until room reset commits and still closes every connection', () => {
    const first = channelPair();
    const second = channelPair();
    const closed: DataConnection[] = [];
    const room = controller({
      initialTimeline: playingTimeline(8),
      closeConnection: (connectionValue) => {
        closed.push(connectionValue);
        if (closed.length === 1) throw new Error('first close callback failed');
      },
    });
    const hooks = room.applicationSessionHooks();
    hooks.onLifecycleEvent(lifecycle('established', 'guest', first.guestConnection, first.guest));
    hooks.onLifecycleEvent(lifecycle('established', 'guest', second.guestConnection, second.guest));
    const firstSignal = room.connectionSignal(first.guestConnection);
    const secondSignal = room.connectionSignal(second.guestConnection);
    let nestedError: unknown = null;
    firstSignal?.addEventListener('abort', () => {
      try {
        room.beginRoom(playingTimeline(999));
      } catch (error) {
        nestedError = error;
      }
    });

    const reset = room.beginRoom(createStoppedPlaybackTimeline(4_000, 0));

    expect(nestedError).toBeInstanceOf(Error);
    expect(String((nestedError as Error).message)).toMatch(/deferred-effect re-entry/u);
    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal?.aborted).toBe(true);
    expect(closed).toEqual([first.guestConnection, second.guestConnection]);
    expect(reset).toMatchObject({
      roomGeneration: 2,
      roomRole: null,
      activeConnectionCount: 0,
      timeline: { revision: 0, phase: 'stopped' },
    });
    expect(room.timelineSnapshot().revision).toBe(0);
  });

  it('publishes guest callbacks only after ACK and keeps durable adoption on callback failure', () => {
    for (const mode of ['throw', 'reenter'] as const) {
      const pair = channelPair();
      const order: string[] = [];
      const closeConnection = vi.fn();
      let nestedError: unknown = null;
      let guest!: FilePlaybackApplicationController;
      guest = controller({
        closeConnection,
        onTimelineAdopted: () => {
          order.push('callback');
          if (mode === 'throw') throw new Error('timeline callback failed');
          try {
            guest.beginRoom(createStoppedPlaybackTimeline(9_000, 0));
          } catch (error) {
            nestedError = error;
          }
        },
      });
      const hooks = guest.applicationSessionHooks();
      hooks.onLifecycleEvent(lifecycle('established', 'guest', pair.guestConnection, pair.guest));
      calibrate(pair);
      hooks.onLifecycleEvent(lifecycle('clock-ready', 'guest', pair.guestConnection, pair.guest));
      const acknowledge = vi.fn(() => order.push('ack'));

      expect(() =>
        hooks.adoptAuxiliaryMessage(
          auxiliary(baselineForGuest(pair, 11), pair.guestConnection, pair.guest),
          acknowledge,
        ),
      ).toThrow(mode === 'throw' ? /timeline callback failed/u : /superseded by re-entry/u);
      expect(order).toEqual(['ack', 'callback']);
      expect(acknowledge).toHaveBeenCalledOnce();
      expect(guest.timelineSnapshot().revision).toBe(11);
      expect(guest.snapshot().roomGeneration).toBe(1);
      expect(closeConnection).toHaveBeenCalledOnce();
      if (mode === 'reenter') expect(nestedError).toBeInstanceOf(Error);
    }
  });

  it('binds one role per room generation and resets that role only in beginRoom', () => {
    const hostPair = channelPair();
    const guestPair = channelPair();
    const closeConnection = vi.fn();
    const room = controller({ initialTimeline: playingTimeline(6), closeConnection });
    const hooks = room.applicationSessionHooks();
    hooks.onLifecycleEvent(
      lifecycle('established', 'host', hostPair.hostConnection, hostPair.host),
    );
    expect(room.snapshot().roomRole).toBe('host');

    expect(() =>
      hooks.onLifecycleEvent(
        lifecycle('established', 'guest', guestPair.guestConnection, guestPair.guest),
      ),
    ).toThrow(/room role cannot change/u);
    expect(closeConnection).toHaveBeenCalledWith(guestPair.guestConnection);
    expect(room.connectionSnapshot(hostPair.hostConnection)).not.toBeNull();
    expect(room.timelineSnapshot().revision).toBe(6);

    room.beginRoom(createStoppedPlaybackTimeline(2_000, 0));
    const nextGuest = channelPair();
    hooks.onLifecycleEvent(
      lifecycle('established', 'guest', nextGuest.guestConnection, nextGuest.guest),
    );
    expect(room.snapshot().roomRole).toBe('guest');
  });

  it('accepts a lower prior-room revision only after explicit beginRoom and ignores stale revoke', () => {
    const oldPair = channelPair();
    const room = controller({ initialTimeline: playingTimeline(20) });
    const hooks = room.applicationSessionHooks();
    hooks.onLifecycleEvent(
      lifecycle('established', 'guest', oldPair.guestConnection, oldPair.guest),
    );
    const oldAck = vi.fn();
    expect(() =>
      hooks.adoptAuxiliaryMessage(
        auxiliary(baselineForGuest(oldPair, 1), oldPair.guestConnection, oldPair.guest),
        oldAck,
      ),
    ).toThrow(/roll playback back/u);
    expect(oldAck).not.toHaveBeenCalled();
    expect(room.timelineSnapshot().revision).toBe(20);

    room.beginRoom(createStoppedPlaybackTimeline(2_000, 0));
    const currentPair = channelPair();
    hooks.onLifecycleEvent(
      lifecycle('established', 'guest', currentPair.guestConnection, currentPair.guest),
    );
    calibrate(currentPair);
    hooks.onLifecycleEvent(
      lifecycle('clock-ready', 'guest', currentPair.guestConnection, currentPair.guest),
    );
    const currentAck = vi.fn();
    hooks.adoptAuxiliaryMessage(
      auxiliary(baselineForGuest(currentPair, 1), currentPair.guestConnection, currentPair.guest),
      currentAck,
    );
    expect(currentAck).toHaveBeenCalledOnce();
    expect(room.timelineSnapshot().revision).toBe(1);

    hooks.onLifecycleEvent(lifecycle('revoked', 'guest', oldPair.guestConnection, oldPair.guest));
    expect(room.connectionSnapshot(currentPair.guestConnection)).not.toBeNull();
    expect(room.timelineSnapshot().revision).toBe(1);
  });

  it('throws before ACK for wire, source-offer, run-binding, and peer-range Phase-1 traffic', () => {
    const cases = ['wire', 'source-offer', 'run-binding', 'peer-range'] as const;
    for (const kind of cases) {
      const pair = channelPair();
      const closeConnection = vi.fn();
      const guest = controller({ closeConnection });
      const hooks = guest.applicationSessionHooks();
      hooks.onLifecycleEvent(lifecycle('established', 'guest', pair.guestConnection, pair.guest));
      const acknowledge = vi.fn();

      if (kind === 'wire') {
        expect(() =>
          hooks.adoptWireMessage(
            {
              message: {} as never,
              connection: pair.guestConnection,
              channel: pair.guest,
              stateLease: {} as never,
              attemptLease: null,
            },
            acknowledge,
          ),
        ).toThrow(/does not support file-playback wire/u);
      } else if (kind === 'peer-range') {
        expect(() =>
          hooks.adoptPeerRangeMessage(
            {
              frame: Object.freeze({ protocol: 'FILE_PLAYBACK_PEER_RANGE_V2' }),
              lane: 'bulk',
              role: 'guest',
              connection: pair.guestConnection,
              channel: pair.guest,
              connectionToken: pair.guestConnection,
            },
            acknowledge,
          ),
        ).toThrow(/does not support peer-range/u);
      } else {
        const type =
          kind === 'source-offer'
            ? FILE_MEDIA_SOURCE_OFFER_V2_TYPE
            : FILE_PLAYBACK_RUN_BINDING_V2_TYPE;
        expect(() =>
          hooks.adoptAuxiliaryMessage(
            auxiliary(Object.freeze({ type }), pair.guestConnection, pair.guest),
            acknowledge,
          ),
        ).toThrow(/does not support this auxiliary/u);
      }
      expect(acknowledge).not.toHaveBeenCalled();
      expect(closeConnection).toHaveBeenCalledOnce();
      expect(guest.connectionSnapshot(pair.guestConnection)).toBeNull();
    }
  });

  it('rejects accessor options without invoking them', () => {
    let reads = 0;
    const options = {
      get initialTimeline() {
        reads += 1;
        return createStoppedPlaybackTimeline();
      },
      idIssuer: new FilePlaybackProductBaselineIdIssuer(),
      sendRequired: () => true,
      closeConnection: () => undefined,
    };
    expect(() => new FilePlaybackApplicationController(options)).toThrow(/options/u);
    expect(reads).toBe(0);
  });
});
