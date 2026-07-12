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
  type FilePlaybackHostAcceptedRendezvousCommitInput,
  type FilePlaybackHostEndedCommitInput,
  type FilePlaybackHostStartedPlaybackCommitInput,
  type FilePlaybackHostTransitionCommitInput,
} from '../file-playback-application-controller.ts';
import { createFilePlaybackEndedTransitionEvidence } from '../file-playback-ended-transition.ts';
import {
  createFilePlaybackProductBaselineV2,
  parseFilePlaybackProductBaselineV2,
  parseFilePlaybackProductReadyV2,
  type FilePlaybackProductBaselineV2,
  type FilePlaybackProductReadyV2,
} from '../file-playback-product-baseline.ts';
import { FilePlaybackProductBaselineIdIssuer } from '../file-playback-product-baseline-session.ts';
import {
  createAudioBufferPlaybackStartEvidence,
  createFilePlaybackCutoverTarget,
  createFilePlaybackTransitionEvidence,
  type FilePlaybackPauseTransitionIntent,
  type FilePlaybackSeekTransitionIntent,
} from '../file-playback-source.ts';
import {
  createFilePlaybackStopTransitionEvidence,
  type FilePlaybackStopTransitionIntent,
} from '../file-playback-stop-transition.ts';
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

function hostStartedCommit(
  room: FilePlaybackApplicationController,
  overrides: Partial<FilePlaybackHostStartedPlaybackCommitInput> = {},
): FilePlaybackHostStartedPlaybackCommitInput {
  const snapshot = room.snapshot();
  const startAtRoomTimeMs = snapshot.timeline.anchorMonotonicMs + 450;
  return {
    roomGeneration: snapshot.roomGeneration,
    expectedPreviousRevision: snapshot.timeline.revision,
    attempt: Object.freeze({
      queueItemId: QUEUE_ID,
      runId: RUN_ID,
      revision: snapshot.timeline.revision + 1,
      rendezvousId: `controller-rendezvous-${++sequence}`,
    }),
    schedule: Object.freeze({
      positionSeconds: 7.25,
      playbackRate: 1.25,
      createdAtRoomTimeMs: snapshot.timeline.anchorMonotonicMs,
      leadTimeMs: 450,
      finalizeByRoomTimeMs: startAtRoomTimeMs - 100,
      startAtRoomTimeMs,
    }),
    startEvidence: createAudioBufferPlaybackStartEvidence(96_000),
    ...overrides,
  };
}

function hostAcceptedRendezvousCommit(
  room: FilePlaybackApplicationController,
  overrides: Partial<FilePlaybackHostAcceptedRendezvousCommitInput> = {},
): FilePlaybackHostAcceptedRendezvousCommitInput {
  const started = hostStartedCommit(room);
  return {
    roomGeneration: started.roomGeneration,
    expectedPreviousRevision: started.expectedPreviousRevision,
    attempt: started.attempt,
    schedule: started.schedule,
    ...overrides,
  };
}

function transitionStates(previous: PlaybackTimelineSnapshot) {
  if (!previous.run) throw new Error('Transition helper requires an active run');
  const from = Object.freeze({
    queueItemId: previous.run.queueItemId,
    runId: previous.run.runId,
    revision: previous.revision,
  });
  const to = Object.freeze({ ...from, revision: previous.revision + 1 });
  return Object.freeze({ from, to });
}

function hostPauseCommit(
  room: FilePlaybackApplicationController,
  atRoomTimeMs = room.timelineSnapshot().anchorMonotonicMs + 500,
): Extract<FilePlaybackHostTransitionCommitInput, { readonly kind: 'pause' }> {
  const snapshot = room.snapshot();
  const states = transitionStates(snapshot.timeline);
  const intent: FilePlaybackPauseTransitionIntent = Object.freeze({
    kind: 'file-playback-pause-transition',
    ...states,
    atRoomTimeMs,
  });
  const evidence = createFilePlaybackTransitionEvidence(
    intent,
    'webaudio-schedule-passed',
    72_000,
    72_000,
  );
  if (evidence.kind !== 'pause-applied') throw new Error('Pause evidence helper failed');
  return Object.freeze({
    kind: 'pause',
    roomGeneration: snapshot.roomGeneration,
    expectedPrevious: snapshot.timeline,
    intent,
    evidence,
  });
}

function hostSeekCommit(
  room: FilePlaybackApplicationController,
  positionSeconds = 42,
  atRoomTimeMs = room.timelineSnapshot().anchorMonotonicMs + 100,
): Extract<FilePlaybackHostTransitionCommitInput, { readonly kind: 'seek' }> {
  const snapshot = room.snapshot();
  const states = transitionStates(snapshot.timeline);
  const intent: FilePlaybackSeekTransitionIntent = Object.freeze({
    kind: 'file-playback-seek-transition',
    ...states,
    positionSeconds,
    atRoomTimeMs,
  });
  const evidence = createFilePlaybackTransitionEvidence(
    intent,
    'webaudio-schedule-passed',
    76_800,
    76_800,
  );
  if (evidence.kind !== 'seek-applied') throw new Error('Seek evidence helper failed');
  return Object.freeze({
    kind: 'seek',
    roomGeneration: snapshot.roomGeneration,
    expectedPrevious: snapshot.timeline,
    intent,
    evidence,
  });
}

function hostStopCommit(
  room: FilePlaybackApplicationController,
  atRoomTimeMs = room.timelineSnapshot().anchorMonotonicMs + 100,
): Extract<FilePlaybackHostTransitionCommitInput, { readonly kind: 'stop' }> {
  const snapshot = room.snapshot();
  const states = transitionStates(snapshot.timeline);
  const audioContext = Object.freeze({ sampleRate: 48_000 }) as unknown as AudioContext;
  const target = createFilePlaybackCutoverTarget(audioContext, 2, 96_000);
  const intent: FilePlaybackStopTransitionIntent = Object.freeze({
    kind: 'file-playback-stop-transition',
    ...states,
    atRoomTimeMs,
    target,
  });
  return Object.freeze({
    kind: 'stop',
    roomGeneration: snapshot.roomGeneration,
    expectedPrevious: snapshot.timeline,
    intent,
    evidence: createFilePlaybackStopTransitionEvidence(intent, target.targetFrame),
  });
}

function hostEndedCommit(
  room: FilePlaybackApplicationController,
  observedAtRoomTimeMs = room.timelineSnapshot().anchorMonotonicMs + 60_000,
): FilePlaybackHostEndedCommitInput {
  const snapshot = room.snapshot();
  const states = transitionStates(snapshot.timeline);
  const intent = Object.freeze({
    kind: 'file-playback-ended-transition' as const,
    ...states,
    observedAtRoomTimeMs,
  });
  return Object.freeze({
    roomGeneration: snapshot.roomGeneration,
    expectedPrevious: snapshot.timeline,
    intent,
    evidence: createFilePlaybackEndedTransitionEvidence(intent),
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

  it('claims one room role idempotently and resets the claim only through beginRoom', () => {
    const room = controller();
    expect(room.snapshot().roomRole).toBeNull();

    const first = room.claimRoomRole('host');
    expect(first.roomRole).toBe('host');
    expect(room.claimRoomRole('host').roomRole).toBe('host');
    expect(() => room.claimRoomRole('guest')).toThrow(/cannot change/u);
    expect(room.snapshot()).toMatchObject({ roomGeneration: 1, roomRole: 'host' });

    const reset = room.beginRoom(createStoppedPlaybackTimeline(5_000, 0));
    expect(reset).toMatchObject({ roomGeneration: 2, roomRole: null });
    expect(room.claimRoomRole('guest').roomRole).toBe('guest');

    const pair = channelPair();
    room
      .applicationSessionHooks()
      .onLifecycleEvent(lifecycle('established', 'guest', pair.guestConnection, pair.guest));
    expect(() => room.claimRoomRole('host')).toThrow(/conflicts|cannot change/u);
    expect(room.snapshot().roomRole).toBe('guest');
    expect(room.connectionSnapshot(pair.guestConnection)?.role).toBe('guest');
    expect(() => room.claimRoomRole('invalid' as 'host')).toThrow(/role is invalid/u);
  });

  it('commits room truth from an accepted rendezvous without local-renderer evidence', () => {
    const room = controller();
    room.claimRoomRole('host');
    const input = hostAcceptedRendezvousCommit(room);
    const previous = room.timelineSnapshot();

    const result = room.commitHostAcceptedRendezvous(input);
    expect(result.previous).toBe(previous);
    expect(result.timeline).toMatchObject({
      revision: 1,
      phase: 'playing',
      run: { queueItemId: QUEUE_ID, runId: RUN_ID },
      positionSeconds: input.schedule.positionSeconds,
      anchorMonotonicMs: input.schedule.startAtRoomTimeMs,
      rate: input.schedule.playbackRate,
    });
    expect(JSON.stringify(result)).not.toMatch(/evidence|rendezvousId/u);

    const exactRoom = controller();
    exactRoom.claimRoomRole('host');
    const exactInput = hostAcceptedRendezvousCommit(exactRoom);
    expect(() =>
      exactRoom.commitHostAcceptedRendezvous({
        ...exactInput,
        startEvidence: createAudioBufferPlaybackStartEvidence(96_000),
      } as never),
    ).toThrow(/commit is invalid/u);
    expect(exactRoom.timelineSnapshot().revision).toBe(0);
  });

  it('keeps the physical-start commit as an exact compatibility boundary', () => {
    const sendRequired = vi.fn(() => true);
    const hostReady = vi.fn();
    const room = controller({ sendRequired, onHostReady: hostReady });
    room.claimRoomRole('host');
    const input = hostStartedCommit(room);
    const beforeEvidence = room.timelineSnapshot();

    expect(beforeEvidence).toMatchObject({ revision: 0, phase: 'stopped' });
    const result = room.commitHostStartedPlayback(input);

    expect(result.previous).toBe(beforeEvidence);
    expect(result).toMatchObject({ schemaVersion: 1, roomGeneration: 1 });
    expect(result.timeline).toMatchObject({
      revision: 1,
      phase: 'playing',
      run: { queueItemId: QUEUE_ID, runId: RUN_ID },
      positionSeconds: input.schedule.positionSeconds,
      anchorMonotonicMs: input.schedule.startAtRoomTimeMs,
      rate: input.schedule.playbackRate,
    });
    expect(room.timelineSnapshot()).toBe(result.timeline);
    expect(sendRequired).not.toHaveBeenCalled();
    expect(hostReady).not.toHaveBeenCalled();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.previous)).toBe(true);
    expect(Object.isFrozen(result.timeline)).toBe(true);
    expect(Object.isFrozen(result.timeline.run)).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(JSON.stringify(result)).not.toContain('startEvidence');
    expect(JSON.stringify(result)).not.toContain('rendezvousId');
  });

  it('advances stopped N and replacement playback through exact consecutive revisions', () => {
    const room = controller({ initialTimeline: createStoppedPlaybackTimeline(2_000, 8) });
    room.claimRoomRole('host');
    const firstInput = hostStartedCommit(room);
    const first = room.commitHostStartedPlayback(firstInput);
    expect(first.timeline).toMatchObject({ revision: 9, phase: 'playing' });

    const replacementInput = hostStartedCommit(room, {
      attempt: Object.freeze({
        queueItemId: OTHER_QUEUE_ID,
        runId: OTHER_RUN_ID,
        revision: 10,
        rendezvousId: 'controller-replacement-rendezvous',
      }),
      schedule: Object.freeze({
        ...firstInput.schedule,
        positionSeconds: 0,
        createdAtRoomTimeMs: first.timeline.anchorMonotonicMs,
        finalizeByRoomTimeMs: first.timeline.anchorMonotonicMs + 350,
        startAtRoomTimeMs: first.timeline.anchorMonotonicMs + 450,
      }),
      startEvidence: Object.freeze({
        kind: 'worklet-observed',
        targetFrame: 144_000,
        actualStartFrame: 144_000,
      }),
    });
    const replacement = room.commitHostStartedPlayback(replacementInput);

    expect(replacement.previous).toBe(first.timeline);
    expect(replacement.timeline).toMatchObject({
      revision: 10,
      phase: 'playing',
      run: { queueItemId: OTHER_QUEUE_ID, runId: OTHER_RUN_ID },
      positionSeconds: 0,
      anchorMonotonicMs: replacementInput.schedule.startAtRoomTimeMs,
    });
  });

  it('leaves timeline truth unchanged for wrong authority, revisions, anchors, and duplicates', () => {
    const unchangedAfter = (
      room: FilePlaybackApplicationController,
      input: FilePlaybackHostStartedPlaybackCommitInput,
      pattern: RegExp,
    ) => {
      const before = room.timelineSnapshot();
      expect(() => room.commitHostStartedPlayback(input)).toThrow(pattern);
      expect(room.timelineSnapshot()).toBe(before);
    };

    const unclaimed = controller();
    unchangedAfter(unclaimed, hostStartedCommit(unclaimed), /host room role/u);

    const guest = controller();
    guest.claimRoomRole('guest');
    unchangedAfter(guest, hostStartedCommit(guest), /host room role/u);

    const staleRoom = controller();
    staleRoom.claimRoomRole('host');
    unchangedAfter(
      staleRoom,
      hostStartedCommit(staleRoom, { roomGeneration: 2 }),
      /stale room generation/u,
    );

    const mismatchedPrevious = controller();
    mismatchedPrevious.claimRoomRole('host');
    unchangedAfter(
      mismatchedPrevious,
      hostStartedCommit(mismatchedPrevious, { expectedPreviousRevision: 1 }),
      /previous revision/u,
    );

    for (const revision of [4, 5, 7]) {
      const room = controller({ initialTimeline: createStoppedPlaybackTimeline(1_000, 5) });
      room.claimRoomRole('host');
      const base = hostStartedCommit(room);
      unchangedAfter(
        room,
        {
          ...base,
          attempt: Object.freeze({ ...base.attempt, revision }),
        },
        /exact next revision/u,
      );
    }

    const pastAnchor = controller();
    pastAnchor.claimRoomRole('host');
    const past = hostStartedCommit(pastAnchor);
    unchangedAfter(
      pastAnchor,
      {
        ...past,
        schedule: Object.freeze({
          ...past.schedule,
          finalizeByRoomTimeMs: 900,
          startAtRoomTimeMs: 900,
        }),
      },
      /precedes the current timeline anchor/u,
    );

    const exhausted = controller({
      initialTimeline: createStoppedPlaybackTimeline(1_000, Number.MAX_SAFE_INTEGER),
    });
    exhausted.claimRoomRole('host');
    unchangedAfter(
      exhausted,
      hostStartedCommit(exhausted, {
        attempt: Object.freeze({
          queueItemId: QUEUE_ID,
          runId: RUN_ID,
          revision: Number.MAX_SAFE_INTEGER,
          rendezvousId: 'controller-exhausted-rendezvous',
        }),
      }),
      /revision was exhausted/u,
    );

    const duplicate = controller();
    duplicate.claimRoomRole('host');
    const duplicateInput = hostStartedCommit(duplicate);
    const committed = duplicate.commitHostStartedPlayback(duplicateInput).timeline;
    expect(() => duplicate.commitHostStartedPlayback(duplicateInput)).toThrow(/previous revision/u);
    expect(duplicate.timelineSnapshot()).toBe(committed);
  });

  it('rejects noncanonical schedules and start evidence without changing the timeline', () => {
    const invalidInputs = (
      room: FilePlaybackApplicationController,
    ): FilePlaybackHostStartedPlaybackCommitInput[] => {
      const base = hostStartedCommit(room);
      return [
        { ...base, schedule: { ...base.schedule, playbackRate: 0 } },
        { ...base, schedule: { ...base.schedule, positionSeconds: Number.NaN } },
        {
          ...base,
          schedule: {
            ...base.schedule,
            finalizeByRoomTimeMs: base.schedule.startAtRoomTimeMs + 1,
          },
        },
        {
          ...base,
          startEvidence: {
            kind: 'worklet-observed',
            targetFrame: 96_000,
            actualStartFrame: 96_001,
          },
        },
        {
          ...base,
          startEvidence: { kind: 'webaudio-schedule-passed', targetFrame: 1.5 },
        },
        { ...base, attempt: { ...base.attempt, extra: true } as never },
        { ...base, schedule: { ...base.schedule, extra: true } as never },
        { ...base, extra: true } as never,
      ];
    };

    const room = controller();
    room.claimRoomRole('host');
    for (const input of invalidInputs(room)) {
      const before = room.timelineSnapshot();
      expect(() => room.commitHostStartedPlayback(input)).toThrow(/commit is invalid/u);
      expect(room.timelineSnapshot()).toBe(before);
    }
  });

  it('fences prior-generation async start results after beginRoom ABA', async () => {
    const room = controller();
    room.claimRoomRole('host');
    const delayedResult = Promise.resolve(hostStartedCommit(room));

    room.beginRoom(createStoppedPlaybackTimeline(10_000, 0));
    room.claimRoomRole('host');
    const stale = await delayedResult;
    const before = room.timelineSnapshot();

    expect(() => room.commitHostStartedPlayback(stale)).toThrow(/stale room generation/u);
    expect(room.timelineSnapshot()).toBe(before);
    expect(room.snapshot()).toMatchObject({ roomGeneration: 2, roomRole: 'host' });
  });

  it('does not invoke hostile accessors and rejects descriptor re-entry before timeline mutation', () => {
    const accessorRoom = controller();
    accessorRoom.claimRoomRole('host');
    const base = hostStartedCommit(accessorRoom);
    let reads = 0;
    const hostileAttempt = {
      get queueItemId() {
        reads += 1;
        return QUEUE_ID;
      },
      runId: RUN_ID,
      revision: 1,
      rendezvousId: 'controller-hostile-accessor',
    };
    const beforeAccessor = accessorRoom.timelineSnapshot();
    expect(() =>
      accessorRoom.commitHostStartedPlayback({ ...base, attempt: hostileAttempt } as never),
    ).toThrow(/commit is invalid/u);
    expect(reads).toBe(0);
    expect(accessorRoom.timelineSnapshot()).toBe(beforeAccessor);

    const reentrantRoom = controller();
    reentrantRoom.claimRoomRole('host');
    const reentrantBase = hostStartedCommit(reentrantRoom);
    let nestedError: unknown = null;
    const hostileInput = new Proxy(reentrantBase, {
      ownKeys(target) {
        try {
          reentrantRoom.beginRoom(createStoppedPlaybackTimeline(99_000, 0));
        } catch (error) {
          nestedError = error;
        }
        return Reflect.ownKeys(target);
      },
    });
    const beforeReentry = reentrantRoom.timelineSnapshot();
    expect(() => reentrantRoom.commitHostStartedPlayback(hostileInput)).toThrow(/superseded/u);
    expect(nestedError).toBeInstanceOf(Error);
    expect(reentrantRoom.timelineSnapshot()).toBe(beforeReentry);
    expect(reentrantRoom.snapshot()).toMatchObject({ roomGeneration: 1, roomRole: 'host' });
  });

  it('commits pause, paused seek, and stop only after their exact physical evidence', () => {
    const sendRequired = vi.fn(() => true);
    const hostReady = vi.fn();
    const timelineAdopted = vi.fn();
    const room = controller({
      initialTimeline: playingTimeline(4),
      sendRequired,
      onHostReady: hostReady,
      onTimelineAdopted: timelineAdopted,
    });
    room.claimRoomRole('host');

    const pauseInput = hostPauseCommit(room);
    const pause = room.commitHostPlaybackTransition(pauseInput);
    expect(pause.previous).toBe(pauseInput.expectedPrevious);
    expect(pause).toMatchObject({ schemaVersion: 1, kind: 'pause', roomGeneration: 1 });
    expect(pause.timeline).toMatchObject({
      revision: 5,
      phase: 'paused',
      run: { queueItemId: QUEUE_ID, runId: RUN_ID },
      positionSeconds: 12.5,
      anchorMonotonicMs: 1_500,
      rate: 1,
    });
    expect(room.timelineSnapshot()).toBe(pause.timeline);

    const seekInput = hostSeekCommit(room, 42, 1_600);
    const seek = room.commitHostPlaybackTransition(seekInput);
    expect(seek.previous).toBe(pause.timeline);
    expect(seek).toMatchObject({ schemaVersion: 1, kind: 'seek', roomGeneration: 1 });
    expect(seek.timeline).toMatchObject({
      revision: 6,
      phase: 'paused',
      run: { queueItemId: QUEUE_ID, runId: RUN_ID },
      positionSeconds: 42,
      anchorMonotonicMs: 1_600,
      rate: 1,
    });

    const stopInput = hostStopCommit(room, 1_700);
    const stop = room.commitHostPlaybackTransition(stopInput);
    expect(stop.previous).toBe(seek.timeline);
    expect(stop).toMatchObject({ schemaVersion: 1, kind: 'stop', roomGeneration: 1 });
    expect(stop.timeline).toMatchObject({
      revision: 7,
      phase: 'stopped',
      run: null,
      positionSeconds: 0,
      anchorMonotonicMs: 1_700,
      rate: 1,
    });
    expect(room.timelineSnapshot()).toBe(stop.timeline);

    for (const result of [pause, seek, stop]) {
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.previous)).toBe(true);
      expect(Object.isFrozen(result.timeline)).toBe(true);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
      expect(JSON.stringify(result)).not.toMatch(/evidence|intent|audioContext|targetFrame/u);
    }
    expect(sendRequired).not.toHaveBeenCalled();
    expect(hostReady).not.toHaveBeenCalled();
    expect(timelineAdopted).not.toHaveBeenCalled();
  });

  it('commits natural end only after exact renderer-retirement evidence', () => {
    const sendRequired = vi.fn(() => true);
    const room = controller({ initialTimeline: playingTimeline(9), sendRequired });
    room.claimRoomRole('host');
    const input = hostEndedCommit(room, 61_000);

    const result = room.commitHostEndedPlayback(input);

    expect(result.previous).toBe(input.expectedPrevious);
    expect(result.timeline).toMatchObject({
      revision: 10,
      phase: 'stopped',
      run: null,
      positionSeconds: 0,
      anchorMonotonicMs: 61_000,
      rate: 1,
    });
    expect(room.timelineSnapshot()).toBe(result.timeline);
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/evidence|intent|renderer/u);
    expect(sendRequired).not.toHaveBeenCalled();
  });

  it('leaves timeline truth unchanged for stale, wrong-phase, and mismatched ended evidence', () => {
    const room = controller({ initialTimeline: playingTimeline(9) });
    room.claimRoomRole('host');
    const input = hostEndedCommit(room);
    const before = room.timelineSnapshot();

    expect(() =>
      room.commitHostEndedPlayback({ ...input, roomGeneration: input.roomGeneration + 1 }),
    ).toThrow(/stale room generation/u);
    expect(room.timelineSnapshot()).toBe(before);

    expect(() =>
      room.commitHostEndedPlayback({
        ...input,
        evidence: { ...input.evidence, observedAtRoomTimeMs: 1 },
      }),
    ).toThrow(/commit is invalid/u);
    expect(room.timelineSnapshot()).toBe(before);

    const paused = room.commitHostPlaybackTransition(hostPauseCommit(room)).timeline;
    const pausedEnd = hostEndedCommit(room);
    expect(() => room.commitHostEndedPlayback(pausedEnd)).toThrow(/current playing truth/u);
    expect(room.timelineSnapshot()).toBe(paused);

    room.beginRoom(playingTimeline(9));
    room.claimRoomRole('host');
    const replacement = room.timelineSnapshot();
    expect(() =>
      room.commitHostEndedPlayback({
        ...input,
        roomGeneration: room.snapshot().roomGeneration,
      }),
    ).toThrow(/expected previous timeline/u);
    expect(room.timelineSnapshot()).toBe(replacement);
  });

  it('keeps transition truth unchanged for authority, generation, identity, phase, and time failures', () => {
    const unchangedAfter = (
      room: FilePlaybackApplicationController,
      input: FilePlaybackHostTransitionCommitInput,
      pattern: RegExp,
    ) => {
      const before = room.timelineSnapshot();
      expect(() => room.commitHostPlaybackTransition(input)).toThrow(pattern);
      expect(room.timelineSnapshot()).toBe(before);
    };

    const unclaimed = controller({ initialTimeline: playingTimeline(4) });
    unchangedAfter(unclaimed, hostPauseCommit(unclaimed), /host room role/u);

    const guest = controller({ initialTimeline: playingTimeline(4) });
    guest.claimRoomRole('guest');
    unchangedAfter(guest, hostPauseCommit(guest), /host room role/u);

    const staleGeneration = controller({ initialTimeline: playingTimeline(4) });
    staleGeneration.claimRoomRole('host');
    const stale = hostPauseCommit(staleGeneration);
    unchangedAfter(
      staleGeneration,
      { ...stale, roomGeneration: stale.roomGeneration + 1 },
      /stale room generation/u,
    );

    const wrongPhase = controller({ initialTimeline: playingTimeline(4) });
    wrongPhase.claimRoomRole('host');
    unchangedAfter(wrongPhase, hostSeekCommit(wrongPhase), /requires paused truth/u);

    const backwards = controller({ initialTimeline: playingTimeline(4) });
    backwards.claimRoomRole('host');
    unchangedAfter(backwards, hostPauseCommit(backwards, 999), /precedes/u);

    const wrongRun = controller({ initialTimeline: playingTimeline(4) });
    wrongRun.claimRoomRole('host');
    const base = hostPauseCommit(wrongRun);
    const from = Object.freeze({
      queueItemId: OTHER_QUEUE_ID,
      runId: OTHER_RUN_ID,
      revision: base.intent.from.revision,
    });
    const to = Object.freeze({ ...from, revision: from.revision + 1 });
    const intent: FilePlaybackPauseTransitionIntent = Object.freeze({
      kind: 'file-playback-pause-transition',
      from,
      to,
      atRoomTimeMs: base.intent.atRoomTimeMs,
    });
    const evidence = createFilePlaybackTransitionEvidence(
      intent,
      'webaudio-schedule-passed',
      72_000,
      72_000,
    );
    if (evidence.kind !== 'pause-applied') throw new Error('Pause evidence helper failed');
    unchangedAfter(wrongRun, { ...base, intent, evidence }, /from identity/u);
  });

  it('rejects structurally equal ABA snapshots and mismatched evidence without committing', () => {
    const room = controller({ initialTimeline: playingTimeline(4) });
    room.claimRoomRole('host');
    const stale = hostPauseCommit(room);
    const beforeGeneration = room.timelineSnapshot();

    room.beginRoom(playingTimeline(4));
    room.claimRoomRole('host');
    const replacement = room.timelineSnapshot();
    expect(replacement).not.toBe(beforeGeneration);
    expect(replacement).toEqual(beforeGeneration);
    expect(() =>
      room.commitHostPlaybackTransition({
        ...stale,
        roomGeneration: room.snapshot().roomGeneration,
      }),
    ).toThrow(/expected previous timeline/u);
    expect(room.timelineSnapshot()).toBe(replacement);

    const current = hostPauseCommit(room);
    const mismatchedEvidence = {
      ...current.evidence,
      from: Object.freeze({ ...current.evidence.from, runId: OTHER_RUN_ID }),
      to: Object.freeze({ ...current.evidence.to, runId: OTHER_RUN_ID }),
    };
    expect(() =>
      room.commitHostPlaybackTransition({
        ...current,
        evidence: mismatchedEvidence,
      } as FilePlaybackHostTransitionCommitInput),
    ).toThrow(/commit is invalid/u);
    expect(room.timelineSnapshot()).toBe(replacement);

    const nonConsecutive = {
      ...current,
      intent: {
        ...current.intent,
        to: Object.freeze({ ...current.intent.to, revision: current.intent.to.revision + 1 }),
      },
    } as FilePlaybackHostTransitionCommitInput;
    expect(() => room.commitHostPlaybackTransition(nonConsecutive)).toThrow(/commit is invalid/u);
    expect(room.timelineSnapshot()).toBe(replacement);

    const stop = hostStopCommit(room);
    const mismatchedStopEvidence = {
      ...stop.evidence,
      targetFrame: stop.evidence.targetFrame - 1,
    };
    expect(() =>
      room.commitHostPlaybackTransition({
        ...stop,
        evidence: mismatchedStopEvidence,
      } as FilePlaybackHostTransitionCommitInput),
    ).toThrow(/commit is invalid/u);
    expect(room.timelineSnapshot()).toBe(replacement);
  });

  it('does not invoke transition accessors and fences descriptor re-entry before commit', () => {
    const accessorRoom = controller({ initialTimeline: playingTimeline(4) });
    accessorRoom.claimRoomRole('host');
    const base = hostPauseCommit(accessorRoom);
    let reads = 0;
    const hostileEvidence = {
      get kind() {
        reads += 1;
        return 'pause-applied';
      },
      observation: base.evidence.observation,
      from: base.evidence.from,
      to: base.evidence.to,
      targetFrame: base.evidence.targetFrame,
      appliedFrame: base.evidence.appliedFrame,
    };
    const beforeAccessor = accessorRoom.timelineSnapshot();
    expect(() =>
      accessorRoom.commitHostPlaybackTransition({
        ...base,
        evidence: hostileEvidence,
      } as never),
    ).toThrow(/commit is invalid/u);
    expect(reads).toBe(0);
    expect(accessorRoom.timelineSnapshot()).toBe(beforeAccessor);

    const reentrantRoom = controller({ initialTimeline: playingTimeline(4) });
    reentrantRoom.claimRoomRole('host');
    const reentrantBase = hostPauseCommit(reentrantRoom);
    let nestedError: unknown = null;
    const hostileInput = new Proxy(reentrantBase, {
      ownKeys(target) {
        try {
          reentrantRoom.beginRoom(playingTimeline(4));
        } catch (error) {
          nestedError = error;
        }
        return Reflect.ownKeys(target);
      },
    });
    const beforeReentry = reentrantRoom.timelineSnapshot();
    expect(() => reentrantRoom.commitHostPlaybackTransition(hostileInput)).toThrow(/superseded/u);
    expect(nestedError).toBeInstanceOf(Error);
    expect(reentrantRoom.timelineSnapshot()).toBe(beforeReentry);
    expect(reentrantRoom.snapshot()).toMatchObject({ roomGeneration: 1, roomRole: 'host' });
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
