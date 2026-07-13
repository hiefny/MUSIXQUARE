import { describe, expect, it, vi } from 'vitest';

import {
  FilePlaybackGuestSessionHandshake,
  FilePlaybackHandshakeIdIssuer,
  FilePlaybackHostSessionHandshake,
} from '../../network/file-playback-session-handshake.ts';
import { FilePlaybackConnectionChannel } from '../../network/file-playback-connection-channel.ts';
import type { DataConnection, QueueItemId } from '../../types/index.ts';
import type {
  HostPreparedLocalTrack,
  HostPeerPlaybackPublication,
  HostPeerRangeSource,
  HostRemoteRecoveryCommit,
  RecoverHostRemoteParticipantOptions,
} from '../file-playback-host-first-file-engine.ts';
import { fileMediaSourceRevokeMatchesOfferV2 } from '../file-media-source-revoke.ts';
import {
  FilePlaybackProductHostMediaOwner,
  type FilePlaybackProductHostMediaRoomPort,
} from '../file-playback-product-host-media-owner.ts';
import { FilePlaybackR2WholeBlobPublisher } from '../file-playback-r2-whole-blob-publisher.ts';
import type { HostRendezvousAttempt } from '../rendezvous-coordinator.ts';
import type { FilePlaybackWireMessage } from '../file-playback-wire.ts';
import { createPeerRangeReadFrame } from '../sources/peer-range-protocol.ts';
import type { EncodedAudioSource } from '../sources/encoded-audio-source.ts';

const QID = '98000000-0000-4000-8000-000000000001' as QueueItemId;
const RUN_ID = '98000000-0000-4000-8000-000000000002';
const QID_2 = '98000000-0000-4000-8000-000000000003' as QueueItemId;
const RUN_ID_2 = '98000000-0000-4000-8000-000000000004';

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

async function drain(turns = 32): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

interface ConnectionPair {
  readonly connection: DataConnection;
  readonly host: FilePlaybackConnectionChannel;
  readonly guest: FilePlaybackConnectionChannel;
  readonly hostToken: object;
  readonly guestToken: object;
  readonly context: Readonly<{
    schemaVersion: 1;
    role: 'host';
    connection: DataConnection;
    channel: FilePlaybackConnectionChannel;
    connectionToken: object;
    routerToken: object;
    sessionId: string;
    connectionId: string;
    hostParticipantId: string;
    guestParticipantId: string;
  }>;
}

function connectionPair(now: () => number): ConnectionPair {
  const hostIds = new FilePlaybackHandshakeIdIssuer({
    createSessionId: () => 'host-owner-session',
    createConnectionId: () => 'host-owner-connection',
    createHelloId: () => 'host-owner-hello',
  });
  const guestIds = new FilePlaybackHandshakeIdIssuer({
    createSessionId: () => 'host-owner-guest-session',
    createConnectionId: () => 'host-owner-guest-connection',
    createHelloId: () => 'host-owner-guest-hello',
  });
  const hostHandshake = new FilePlaybackHostSessionHandshake({
    idIssuer: hostIds,
    sessionId: hostIds.issueSessionId(),
    connectionId: hostIds.issueConnectionId(),
    hostParticipantId: 'host-owner-host',
    guestParticipantId: 'host-owner-guest',
  });
  const guestHandshake = new FilePlaybackGuestSessionHandshake({
    idIssuer: guestIds,
    guestParticipantId: 'host-owner-guest',
  });
  const hello = guestHandshake.createHello();
  if (!hello.accepted) throw new Error(hello.reason);
  const welcome = hostHandshake.handleHello(hello.hello);
  if (!welcome.accepted) throw new Error(welcome.reason);
  if (!guestHandshake.handleWelcome(welcome.welcome).accepted) throw new Error('welcome failed');
  const snapshot = hostHandshake.createSnapshot();
  if (!snapshot.accepted) throw new Error(snapshot.reason);
  if (!guestHandshake.acceptSnapshot(snapshot.snapshot).accepted)
    throw new Error('snapshot failed');
  const applied = guestHandshake.createApplied();
  if (!applied.accepted) throw new Error(applied.reason);
  if (!hostHandshake.handleApplied(applied.applied).accepted) throw new Error('applied failed');
  const connection = {
    peer: 'host-owner-peer',
    open: true,
    dataChannel: { readyState: 'open', bufferedAmount: 0 },
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as DataConnection;
  const host = new FilePlaybackConnectionChannel(hostHandshake, connection, { now });
  const guest = new FilePlaybackConnectionChannel(guestHandshake, connection, {
    now,
    guestAppliedSendConfirmed: true,
  });
  const binding = host.establishedBinding();
  if (!binding) throw new Error('host binding unavailable');
  const hostToken = host.liveConnectionToken();
  const guestToken = guest.liveConnectionToken();
  if (!hostToken || !guestToken) throw new Error('connection token unavailable');
  for (let sample = 0; sample < 5; sample += 1) {
    const ping = guest.createClockPing();
    const pong = host.receive(ping, hostToken);
    if (!pong.accepted || pong.frame !== 'clock-ping') throw new Error('clock ping failed');
    const calibrated = guest.receive(pong.pong, guestToken);
    if (!calibrated.accepted || calibrated.frame !== 'clock-pong') {
      throw new Error('clock calibration failed');
    }
  }
  return {
    connection,
    host,
    guest,
    hostToken,
    guestToken,
    context: freezeCanonical({
      schemaVersion: 1 as const,
      role: 'host' as const,
      connection,
      channel: host,
      connectionToken: hostToken,
      routerToken: freezeCanonical({ owner: 'router' }),
      sessionId: binding.sessionId,
      connectionId: binding.connectionId,
      hostParticipantId: binding.hostParticipantId,
      guestParticipantId: binding.guestParticipantId,
    }),
  };
}

function publication(
  backend: 'audio-buffer' | 'bounded-stream',
  blob: Blob,
  phase: 'paused' | 'playing' = 'playing',
): Readonly<HostPeerPlaybackPublication> {
  const state = freezeCanonical({ queueItemId: QID, runId: RUN_ID, revision: 1 });
  return freezeCanonical({
    schemaVersion: 1 as const,
    roomGeneration: 1,
    backend,
    state,
    timeline: freezeCanonical({
      schemaVersion: 1 as const,
      revision: 1,
      phase,
      run: freezeCanonical({ queueItemId: QID, runId: RUN_ID }),
      positionSeconds: 3,
      anchorMonotonicMs: 1_000,
      rate: 1,
    }),
    asset: freezeCanonical({
      kind: 'blob' as const,
      binding: freezeCanonical({
        queueItemId: QID,
        sourceIdentity: 'host-owner-source',
        transferSessionId: 'host-owner-transfer',
      }),
      metadata: freezeCanonical({
        name: backend === 'bounded-stream' ? 'owner.flac' : 'owner.mp3',
        mime: backend === 'bounded-stream' ? 'audio/flac' : 'audio/mpeg',
      }),
      encodedSize: blob.size,
    }),
  });
}

function preparedTrack(
  backend: 'audio-buffer' | 'bounded-stream',
  encodedSize: number,
  state = freezeCanonical({ queueItemId: QID, runId: RUN_ID, revision: 1 }),
): Readonly<HostPreparedLocalTrack> {
  return freezeCanonical({
    schemaVersion: 1 as const,
    roomGeneration: 1,
    backend,
    state,
    positionSeconds: 3,
    playbackRate: 1,
    asset: freezeCanonical({
      kind: 'blob' as const,
      binding: freezeCanonical({
        queueItemId: state.queueItemId,
        sourceIdentity: 'host-owner-source',
        transferSessionId: 'host-owner-transfer',
      }),
      metadata: freezeCanonical({
        name: backend === 'bounded-stream' ? 'owner.flac' : 'owner.mp3',
        mime: backend === 'bounded-stream' ? 'audio/flac' : 'audio/mpeg',
      }),
      encodedSize,
    }),
  });
}

function committedTimeline() {
  return freezeCanonical({
    schemaVersion: 1 as const,
    revision: 1,
    phase: 'playing' as const,
    run: freezeCanonical({ queueItemId: QID, runId: RUN_ID }),
    positionSeconds: 3,
    anchorMonotonicMs: 2_000,
    rate: 1,
  });
}

function committedPreparedPublication(
  prepared: Readonly<HostPreparedLocalTrack>,
  timeline: ReturnType<typeof committedTimeline>,
): Readonly<HostPeerPlaybackPublication> {
  return freezeCanonical({
    schemaVersion: 1 as const,
    roomGeneration: prepared.roomGeneration,
    backend: prepared.backend,
    state: prepared.state,
    timeline,
    asset: prepared.asset,
  });
}

function encodedPreparedSource(
  prepared: Readonly<HostPreparedLocalTrack>,
  close = vi.fn(async () => undefined),
): EncodedAudioSource {
  return {
    kind: 'peer-range',
    size: prepared.asset.encodedSize,
    identity: prepared.asset.binding.sourceIdentity,
    metadata: {
      name: prepared.asset.metadata.name,
      mime: prepared.asset.metadata.mime,
    },
    readAt: vi.fn(async (offset: number, length: number) =>
      new Uint8Array(length).fill(offset + 1),
    ),
    close,
  };
}

function fakeAttempt(rendezvousId: string): HostRendezvousAttempt {
  return {
    rendezvousId,
    startAtRoomTimeMs: 2_000,
    finalizeByRoomTimeMs: 1_900,
    getSnapshot: vi.fn(),
    whenFirstParticipantAccepted: vi.fn(),
    expire: vi.fn(),
    commitParticipant: vi.fn(),
    cancel: vi.fn(),
  } as unknown as HostRendezvousAttempt;
}

function roomPort(
  current: () => Readonly<HostPeerPlaybackPublication> | null,
  source: () => Blob,
  recoveries: RecoverHostRemoteParticipantOptions[],
): FilePlaybackProductHostMediaRoomPort {
  let rendezvous = 0;
  return {
    currentPeerPublication: current,
    resolveCurrentPeerRangeSource: vi.fn(async () => source()),
    recoverRemoteParticipant: vi.fn(async (options) => {
      recoveries.push(options);
      const attempt = fakeAttempt(`host-owner-rendezvous-${++rendezvous}`);
      const evidence = options.bindAttempt(attempt);
      const arm = await options.participant.arm({
        protocolVersion: 2,
        kind: 'rendezvous-arm',
        ...options.publication.state,
        rendezvousId: attempt.rendezvousId,
        recipientId: options.participant.participantId,
        positionSeconds: 4,
        playbackRate: 1,
        startAtRoomTimeMs: 2_000,
        finalizeByRoomTimeMs: 1_900,
      });
      if (arm.status !== 'armed') throw new Error('fixture ARM rejected');
      const finalized = await options.participant.finalize({
        protocolVersion: 2,
        kind: 'rendezvous-finalize',
        ...options.publication.state,
        rendezvousId: attempt.rendezvousId,
        recipientId: options.participant.participantId,
        startAtRoomTimeMs: 2_000,
        finalizedAtRoomTimeMs: 1_500,
      });
      if (finalized.status !== 'accepted') throw new Error('fixture FINALIZE rejected');
      await evidence;
      if (
        !options.participant.commitAttempt({
          ...options.publication.state,
          rendezvousId: attempt.rendezvousId,
        })
      ) {
        throw new Error('fixture renderer evidence rejected');
      }
      return freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: options.publication.roomGeneration,
        participantId: options.participant.participantId,
        publication: options.publication,
        attempt: freezeCanonical({
          ...options.publication.state,
          rendezvousId: attempt.rendezvousId,
        }),
        schedule: freezeCanonical({
          positionSeconds: 4,
          playbackRate: 1,
          createdAtRoomTimeMs: 1_000,
          leadTimeMs: 1_000,
          finalizeByRoomTimeMs: 1_900,
          startAtRoomTimeMs: 2_000,
        }),
        timeline: options.publication.timeline,
      }) satisfies Readonly<HostRemoteRecoveryCommit>;
    }),
  };
}

function publisher(): FilePlaybackR2WholeBlobPublisher {
  return new FilePlaybackR2WholeBlobPublisher({
    roomToken: freezeCanonical({ room: 'host-owner' }),
    runtime: { createStorageRoomId: () => 'host_owner_room' },
  });
}

function receiveWire(
  pair: ConnectionPair,
  message: FilePlaybackWireMessage,
): Extract<
  ReturnType<FilePlaybackConnectionChannel['receive']>,
  { accepted: true; frame: 'wire' }
> {
  const result = pair.host.receive(message, pair.hostToken);
  if (!result.accepted || result.frame !== 'wire') {
    throw new Error(`wire rejected: ${JSON.stringify(result)}`);
  }
  return result;
}

function adoptWire(
  pair: ConnectionPair,
  owner: FilePlaybackProductHostMediaOwner,
  message: FilePlaybackWireMessage,
): void {
  const received = receiveWire(pair, message);
  const acknowledge = vi.fn();
  owner.port().adoptWireMessage(
    freezeCanonical({
      message: received.message,
      connection: pair.connection,
      channel: pair.host,
      stateLease: received.stateLease,
      attemptLease: received.attemptLease,
    }),
    acknowledge,
  );
  expect(acknowledge).toHaveBeenCalledOnce();
}

function ids() {
  const values = [
    '98000000-0000-4000-8000-000000000011',
    '98000000-0000-4000-8000-000000000012',
    '98000000-0000-4000-8000-000000000013',
    '98000000-0000-4000-8000-000000000014',
  ];
  let index = 0;
  return () => values[index++] ?? values.at(-1)!;
}

describe('FilePlaybackProductHostMediaOwner', () => {
  it('offers an exact prepared candidate, serves peer ranges, then binds one shared cohort', async () => {
    let now = 1_000;
    const pair = connectionPair(() => now);
    const prepared = preparedTrack('bounded-stream', 4);
    const required: unknown[] = [];
    const wire: FilePlaybackWireMessage[] = [];
    const closeConnection = vi.fn();
    let current: Readonly<HostPeerPlaybackPublication> | null = null;
    const resolvePrepared = vi.fn(
      async (options: {
        prepared: Readonly<HostPreparedLocalTrack>;
        sourceIdentity: string;
        signal: AbortSignal;
      }): Promise<HostPeerRangeSource> => {
        if (
          options.prepared !== prepared ||
          options.sourceIdentity !== prepared.asset.binding.sourceIdentity ||
          options.signal.aborted
        ) {
          throw new Error('fixture prepared authority is stale');
        }
        return encodedPreparedSource(prepared);
      },
    );
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => current,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: resolvePrepared,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, lease, payload) => {
        const message = pair.host.createWire(lease, payload);
        wire.push(message);
        return message;
      },
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-prepared-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    const published = await owner.publishPrepared(prepared);
    expect(await owner.publishPrepared(prepared)).toBe(published);
    await expect(
      owner.publishPrepared(
        freezeCanonical({
          ...prepared,
          state: freezeCanonical({ ...prepared.state }),
        }),
      ),
    ).rejects.toThrow(/already has exact authority/u);
    expect(resolvePrepared).toHaveBeenCalledOnce();
    expect(required).toEqual([
      expect.objectContaining({
        type: 'FILE_MEDIA_SOURCE_OFFER_V2',
        transport: 'peer-range',
      }),
    ]);
    expect(Object.keys(published).sort()).toEqual([
      'binding',
      'offer',
      'prepared',
      'schemaVersion',
    ]);
    expect(JSON.stringify(published)).not.toContain('readAt');
    if (published.offer.transport !== 'peer-range') throw new Error('candidate offer unavailable');
    const readAcknowledge = vi.fn();
    owner.port().adoptPeerRangeControl(
      freezeCanonical({
        frame: createPeerRangeReadFrame({
          connectionId: pair.context.connectionId,
          sourceIdentity: prepared.asset.binding.sourceIdentity,
          handleId: published.offer.handleId,
          requestId: '98000000-0000-4000-8000-000000000077',
          offset: 0,
          totalLength: prepared.asset.encodedSize,
        }),
        lane: 'control' as const,
        role: 'host' as const,
        connection: pair.connection,
        channel: pair.host,
        connectionToken: pair.hostToken,
      }),
      readAcknowledge,
    );
    expect(readAcknowledge).toHaveBeenCalledOnce();
    await drain(64);
    expect(resolvePrepared).toHaveBeenCalledTimes(2);
    expect(required.some((frame) => (frame as { type?: string }).type === 'chunk')).toBe(true);

    await expect(owner.whenPreparedRemoteReady(prepared)).rejects.toThrow(/stale/u);
    const binding = owner.bindPrepared(prepared);
    expect(owner.bindPrepared(prepared)).toBe(binding);
    await expect(
      owner.bindPrepared(
        freezeCanonical({
          ...prepared,
          state: freezeCanonical({ ...prepared.state }),
        }),
      ),
    ).rejects.toThrow(/stale/u);
    expect(await binding).toBe(published);
    expect(await owner.bindPrepared(prepared)).toBe(published);
    expect(
      required.filter(
        (frame) => (frame as { type?: string }).type === 'FILE_PLAYBACK_RUN_BINDING_V2',
      ),
    ).toEqual([
      expect.objectContaining({
        type: 'FILE_PLAYBACK_RUN_BINDING_V2',
        playbackRevision: 1,
      }),
    ]);

    const ready = owner.whenPreparedRemoteReady(prepared);
    expect(owner.whenPreparedRemoteReady(prepared)).toBe(ready);
    pair.guest.bootstrapStopped(0);
    const guestState = pair.guest.stageMedia({
      run: prepared.state,
      sourceIdentity: prepared.asset.binding.sourceIdentity,
      transferSessionId: prepared.asset.binding.transferSessionId,
    });
    adoptWire(
      pair,
      owner,
      pair.guest.createWire(guestState, {
        kind: 'source-ready',
        observedAtRoomTimeMs: now,
        readyLeaseUntilRoomTimeMs: 10_000,
        backend: prepared.backend,
        durationSeconds: 180,
        bufferedAheadSeconds: 8,
        outputSampleRateHz: 48_000,
        channelCount: 2,
      }),
    );
    const capability = await ready;
    expect(Object.keys(capability).sort()).toEqual(['bindAttempt', 'participant']);
    expect(Object.isFrozen(capability)).toBe(true);

    let acceptParticipant!: (value: unknown) => void;
    const accepted = new Promise<unknown>((resolve) => {
      acceptParticipant = resolve;
    });
    const attempt = {
      rendezvousId: 'host-owner-prepared-attempt',
      startAtRoomTimeMs: 2_000,
      finalizeByRoomTimeMs: 1_900,
      getSnapshot: vi.fn(),
      whenFirstParticipantAccepted: vi.fn(),
      whenParticipantAccepted: vi.fn(() => accepted),
      expire: vi.fn(),
      commitParticipant: vi.fn(),
      cancel: vi.fn(),
    } as unknown as HostRendezvousAttempt;
    const evidence = capability.bindAttempt(attempt);
    expect(capability.bindAttempt(attempt)).toBe(evidence);
    const armTask = capability.participant.arm({
      protocolVersion: 2,
      kind: 'rendezvous-arm',
      ...prepared.state,
      rendezvousId: attempt.rendezvousId,
      recipientId: capability.participant.participantId,
      positionSeconds: prepared.positionSeconds,
      playbackRate: prepared.playbackRate,
      startAtRoomTimeMs: 2_000,
      finalizeByRoomTimeMs: 1_900,
    });
    await drain();
    const arm = wire.at(-1)!;
    if (arm.kind !== 'rendezvous-arm') throw new Error('prepared ARM unavailable');
    const guestAttempt = pair.guest.stageAttempt(guestState, arm.rendezvousId);
    now = 1_500;
    adoptWire(
      pair,
      owner,
      pair.guest.createWire(guestAttempt, {
        kind: 'rendezvous-armed',
        rendezvousId: arm.rendezvousId,
        status: 'armed',
        observedAtRoomTimeMs: now,
        bufferedAheadSeconds: 8,
        reasonCode: null,
      }),
    );
    await expect(armTask).resolves.toMatchObject({ status: 'armed' });
    const finalizeTask = capability.participant.finalize({
      protocolVersion: 2,
      kind: 'rendezvous-finalize',
      ...prepared.state,
      rendezvousId: attempt.rendezvousId,
      recipientId: capability.participant.participantId,
      startAtRoomTimeMs: 2_000,
      finalizedAtRoomTimeMs: now,
    });
    await drain();
    const finalize = wire.at(-1)!;
    if (finalize.kind !== 'rendezvous-finalize') {
      throw new Error('prepared FINALIZE unavailable');
    }
    adoptWire(
      pair,
      owner,
      pair.guest.createWire(guestAttempt, {
        kind: 'rendezvous-finalized',
        rendezvousId: finalize.rendezvousId,
        status: 'accepted',
        observedAtRoomTimeMs: now,
        reasonCode: null,
      }),
    );
    await expect(finalizeTask).resolves.toMatchObject({ status: 'accepted' });
    now = 2_000;
    adoptWire(
      pair,
      owner,
      pair.guest.createWire(guestAttempt, {
        kind: 'renderer-health',
        rendezvousId: attempt.rendezvousId,
        value: 'healthy',
        observedAtRoomTimeMs: 2_000,
        leaseUntilRoomTimeMs: 10_000,
        renderedFrame: 96_000,
        underrunCount: 0,
        reasonCode: null,
      }),
    );
    await expect(evidence).resolves.toBeUndefined();

    const timeline = committedTimeline();
    current = committedPreparedPublication(prepared, timeline);
    const activated = owner.activatePrepared({ prepared, timeline });
    expect(activated.publication).toBe(current);
    expect(required.at(-1)).toMatchObject({
      type: 'FILE_PLAYBACK_TIMELINE_UPDATE_V2',
      roomGeneration: 1,
      queueItemId: QID,
      runId: RUN_ID,
      revision: 1,
    });
    acceptParticipant({ participantId: capability.participant.participantId });
    await drain();
    expect(closeConnection).not.toHaveBeenCalled();
    expect(() => owner.activatePrepared({ prepared, timeline })).toThrow(/stale/u);
    owner.port().revoke(pair.context);
  });

  it('keeps current publication and recovery authority intact while a successor is offer-only', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/flac' });
    const current = publication('bounded-stream', blob);
    const prepared = preparedTrack(
      'bounded-stream',
      3,
      freezeCanonical({ queueItemId: QID_2, runId: RUN_ID_2, revision: 2 }),
    );
    const recoveries: RecoverHostRemoteParticipantOptions[] = [];
    const required: unknown[] = [];
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => current,
        () => blob,
        recoveries,
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: vi.fn(async () => encodedPreparedSource(prepared)),
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-offer-only-current-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    const currentCommit = await owner.publishCurrent();
    const guestCurrent = pair.guest.bootstrapCurrentMedia({
      run: current.state,
      sourceIdentity: current.asset.binding.sourceIdentity,
      transferSessionId: current.asset.binding.transferSessionId,
    });
    await owner.publishPrepared(prepared);

    expect(await owner.publishCurrent()).toBe(currentCommit);
    expect(
      required.filter(
        (frame) => (frame as { type?: string }).type === 'FILE_PLAYBACK_RUN_BINDING_V2',
      ),
    ).toHaveLength(1);

    adoptWire(
      pair,
      owner,
      pair.guest.createWire(guestCurrent, {
        kind: 'source-ready',
        observedAtRoomTimeMs: 1_000,
        readyLeaseUntilRoomTimeMs: 10_000,
        backend: current.backend,
        durationSeconds: 180,
        bufferedAheadSeconds: 8,
        outputSampleRateHz: 48_000,
        channelCount: 2,
      }),
    );
    await drain();
    expect(recoveries).toHaveLength(1);
    owner.port().revoke(pair.context);
  });

  it('commits a prepared state without waiting for a slow remote SOURCE_READY', async () => {
    const pair = connectionPair(() => 1_000);
    const prepared = preparedTrack('bounded-stream', 3);
    const required: unknown[] = [];
    let current: Readonly<HostPeerPlaybackPublication> | null = null;
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => current,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: vi.fn(async (options) => {
        if (options.prepared !== prepared) throw new Error('wrong prepared capability');
        return encodedPreparedSource(prepared);
      }),
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        nowEpochMsForTests: () => 1_000,
        scheduleIntervalForTests: () => 'host-owner-slow-health',
        cancelIntervalForTests: vi.fn(),
      },
    });
    await owner.publishPrepared(prepared);
    await owner.bindPrepared(prepared);
    const readiness = owner.whenPreparedRemoteReady(prepared);
    const timeline = committedTimeline();
    current = committedPreparedPublication(prepared, timeline);
    const activated = owner.activatePrepared({ prepared, timeline });
    expect(activated.publication.state).toBe(prepared.state);
    await expect(readiness).rejects.toThrow(/committed before/u);
    expect(required.at(-1)).toMatchObject({ type: 'FILE_PLAYBACK_TIMELINE_UPDATE_V2' });
    owner.port().revoke(pair.context);
  });

  it('revokes a delayed exact prepared source without publishing or leaking it', async () => {
    const pair = connectionPair(() => 1_000);
    const prepared = preparedTrack('bounded-stream', 3);
    let resolveSource!: (source: HostPeerRangeSource) => void;
    const source = new Promise<HostPeerRangeSource>((resolve) => {
      resolveSource = resolve;
    });
    const closeSource = vi.fn(async () => undefined);
    const sendRequired = vi.fn(() => true);
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: vi.fn(() => source),
      sendRequired,
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-delayed-prepared-health',
        cancelIntervalForTests: vi.fn(),
      },
    });
    const pending = owner.publishPrepared(prepared);
    await drain();
    owner.port().revoke(pair.context);
    resolveSource(encodedPreparedSource(prepared, closeSource));
    await expect(pending).rejects.toThrow(/stale|closed/u);
    expect(closeSource).toHaveBeenCalledOnce();
    expect(sendRequired).not.toHaveBeenCalled();
  });

  it('fail-closes only the exact connection when a prepared OFFER cannot be sent', async () => {
    const pair = connectionPair(() => 1_000);
    const prepared = preparedTrack('bounded-stream', 3);
    const closeConnection = vi.fn();
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: vi.fn(async () => encodedPreparedSource(prepared)),
      sendRequired: vi.fn(() => false),
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-failed-prepared-health',
        cancelIntervalForTests: vi.fn(),
      },
    });
    await expect(owner.publishPrepared(prepared)).rejects.toThrow(/connection failed/u);
    expect(closeConnection).toHaveBeenCalledOnce();
    expect(closeConnection).toHaveBeenCalledWith(pair.connection);
    await expect(owner.publishPrepared(prepared)).rejects.toThrow(/closed/u);
  });

  it('rejects an expired offer before claiming a wire revision', async () => {
    let now = 1_000;
    const pair = connectionPair(() => now);
    const prepared = preparedTrack('bounded-stream', 3);
    const closeConnection = vi.fn();
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: vi.fn(async () => encodedPreparedSource(prepared)),
      sendRequired: vi.fn(() => true),
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-expired-offer-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    const offered = await owner.publishPrepared(prepared);
    now = offered.offer.expiresAtRoomTimeMs;
    await expect(owner.bindPrepared(prepared)).rejects.toThrow(/expired/u);
    expect(closeConnection).not.toHaveBeenCalled();
    await expect(owner.bindPrepared(prepared)).rejects.toThrow(/stale|retired/u);
    owner.port().revoke(pair.context);
  });

  it('fail-closes the exact connection when a prepared RUN cannot be sent', async () => {
    const pair = connectionPair(() => 1_000);
    const prepared = preparedTrack('bounded-stream', 3);
    const closeConnection = vi.fn();
    const required: unknown[] = [];
    const sendRequired = vi.fn((_connection: DataConnection, frame: unknown) => {
      required.push(frame);
      return required.length === 1;
    });
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: vi.fn(async () => encodedPreparedSource(prepared)),
      sendRequired,
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-failed-run-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    await expect(owner.publishPrepared(prepared)).resolves.toMatchObject({ prepared });
    await expect(owner.bindPrepared(prepared)).rejects.toThrow(/connection failed/u);
    expect(required.map((frame) => (frame as { type?: string }).type)).toEqual([
      'FILE_MEDIA_SOURCE_OFFER_V2',
      'FILE_PLAYBACK_RUN_BINDING_V2',
    ]);
    expect(closeConnection).toHaveBeenCalledOnce();
    expect(closeConnection).toHaveBeenCalledWith(pair.connection);
    await expect(owner.bindPrepared(prepared)).rejects.toThrow(/closed/u);
  });

  it('retires an unstaged pending candidate idempotently before allowing the next lane turn', async () => {
    const pair = connectionPair(() => 1_000);
    const first = preparedTrack('bounded-stream', 3);
    const second = preparedTrack('bounded-stream', 3);
    let resolveFirst!: (source: HostPeerRangeSource) => void;
    const pendingSource = new Promise<HostPeerRangeSource>((resolve) => {
      resolveFirst = resolve;
    });
    let resolution = 0;
    const closeFirst = vi.fn(async () => undefined);
    const closeConnection = vi.fn();
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: vi.fn(async (options) => {
        resolution += 1;
        return resolution === 1 ? pendingSource : encodedPreparedSource(options.prepared);
      }),
      sendRequired: vi.fn(() => true),
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-retire-pending-health',
        cancelIntervalForTests: vi.fn(),
      },
    });
    const pending = owner.publishPrepared(first);
    await drain();
    const retirement = owner.retirePrepared(first, new Error('candidate superseded'));
    expect(owner.retirePrepared(first, new Error('retry reason is ignored'))).toBe(retirement);
    await expect(owner.publishPrepared(second)).rejects.toThrow(/retirement is settling/u);
    resolveFirst(encodedPreparedSource(first, closeFirst));
    await expect(pending).rejects.toThrow(/retired|stale/u);
    await expect(retirement).resolves.toBeUndefined();
    expect(owner.retirePrepared(first, new Error('settled retry'))).toBe(retirement);
    expect(closeFirst).toHaveBeenCalledOnce();
    expect(closeConnection).not.toHaveBeenCalled();
    await expect(owner.publishPrepared(second)).resolves.toMatchObject({ prepared: second });
    owner.port().revoke(pair.context);
  });

  it('revokes an offer-only handle without renewing the connection', async () => {
    const pair = connectionPair(() => 1_000);
    const prepared = preparedTrack('bounded-stream', 3);
    const successor = preparedTrack(
      'bounded-stream',
      3,
      freezeCanonical({ queueItemId: QID_2, runId: RUN_ID_2, revision: 1 }),
    );
    const closeConnection = vi.fn();
    const resolvePrepared = vi.fn(async (options) => encodedPreparedSource(options.prepared));
    const required: unknown[] = [];
    let owner!: FilePlaybackProductHostMediaOwner;
    let reentrantRetirement: Promise<void> | null = null;
    const sendRequired = vi.fn((_connection: DataConnection, frame: unknown) => {
      required.push(frame);
      if ((frame as { type?: string }).type === 'FILE_MEDIA_SOURCE_OFFER_REVOKE_V2') {
        reentrantRetirement = owner.retirePrepared(
          prepared,
          new Error('reentrant offer-only retirement'),
        );
      }
      return true;
    });
    owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: resolvePrepared,
      sendRequired,
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-retire-offered-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    const offered = await owner.publishPrepared(prepared);
    if (offered.offer.transport !== 'peer-range') throw new Error('peer offer unavailable');
    const staleRead = freezeCanonical({
      frame: createPeerRangeReadFrame({
        connectionId: pair.context.connectionId,
        sourceIdentity: prepared.asset.binding.sourceIdentity,
        handleId: offered.offer.handleId,
        requestId: '98000000-0000-4000-8000-000000000079',
        offset: 0,
        totalLength: prepared.asset.encodedSize,
      }),
      lane: 'control' as const,
      role: 'host' as const,
      connection: pair.connection,
      channel: pair.host,
      connectionToken: pair.hostToken,
    });

    const retirement = owner.retirePrepared(prepared, new Error('offer-only candidate cancelled'));
    expect(reentrantRetirement).toBe(retirement);
    await expect(retirement).resolves.toBeUndefined();
    expect(owner.retirePrepared(prepared, new Error('settled replay'))).toBe(retirement);
    expect(required.map((frame) => (frame as { type?: string }).type)).toEqual([
      'FILE_MEDIA_SOURCE_OFFER_V2',
      'FILE_MEDIA_SOURCE_OFFER_REVOKE_V2',
    ]);
    expect(
      required.filter(
        (frame) => (frame as { type?: string }).type === 'FILE_MEDIA_SOURCE_OFFER_REVOKE_V2',
      ),
    ).toHaveLength(1);
    expect(fileMediaSourceRevokeMatchesOfferV2(required[1], offered.offer)).toBe(true);
    expect(closeConnection).not.toHaveBeenCalled();
    expect(() => owner.port().adoptPeerRangeControl(staleRead, vi.fn())).toThrow(
      /current publication/u,
    );
    expect(resolvePrepared).toHaveBeenCalledOnce();
    await expect(owner.publishPrepared(successor)).resolves.toMatchObject({ prepared: successor });
    expect(closeConnection).not.toHaveBeenCalled();
    owner.port().revoke(pair.context);
  });

  it('fail-closes the exact connection when an offer-only revoke cannot be sent', async () => {
    const pair = connectionPair(() => 1_000);
    const prepared = preparedTrack('bounded-stream', 3);
    const required: unknown[] = [];
    const closeConnection = vi.fn();
    const sendRequired = vi.fn((_connection: DataConnection, frame: unknown) => {
      required.push(frame);
      return (frame as { type?: string }).type !== 'FILE_MEDIA_SOURCE_OFFER_REVOKE_V2';
    });
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: vi.fn(async () => encodedPreparedSource(prepared)),
      sendRequired,
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-failed-revoke-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    const offered = await owner.publishPrepared(prepared);
    const retirement = owner.retirePrepared(prepared, new Error('cancel offered source'));
    await expect(retirement).resolves.toBeUndefined();

    expect(required.map((frame) => (frame as { type?: string }).type)).toEqual([
      'FILE_MEDIA_SOURCE_OFFER_V2',
      'FILE_MEDIA_SOURCE_OFFER_REVOKE_V2',
    ]);
    expect(fileMediaSourceRevokeMatchesOfferV2(required[1], offered.offer)).toBe(true);
    expect(sendRequired).toHaveBeenCalledTimes(2);
    expect(closeConnection).toHaveBeenCalledOnce();
    expect(closeConnection).toHaveBeenCalledWith(pair.connection);
    expect(owner.retirePrepared(prepared, new Error('failed revoke replay'))).toBe(retirement);
    await expect(owner.bindPrepared(prepared)).rejects.toThrow(/closed|stale/u);
  });

  it('renews the exact connection after retiring a staged revision tombstone', async () => {
    const pair = connectionPair(() => 1_000);
    const prepared = preparedTrack('bounded-stream', 3);
    const closeConnection = vi.fn();
    const required: unknown[] = [];
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: vi.fn(async () => encodedPreparedSource(prepared)),
      sendRequired: vi.fn((_connection, frame) => {
        required.push(frame);
        return true;
      }),
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-retire-staged-health',
        cancelIntervalForTests: vi.fn(),
      },
    });
    await owner.publishPrepared(prepared);
    await owner.bindPrepared(prepared);
    const retirement = owner.retirePrepared(prepared, new Error('host candidate failed'));
    expect(owner.retirePrepared(prepared, new Error('retry'))).toBe(retirement);
    await expect(retirement).resolves.toBeUndefined();
    expect(owner.retirePrepared(prepared, new Error('settled retry'))).toBe(retirement);
    expect(required.map((frame) => (frame as { type?: string }).type)).toEqual([
      'FILE_MEDIA_SOURCE_OFFER_V2',
      'FILE_PLAYBACK_RUN_BINDING_V2',
    ]);
    expect(
      required.some(
        (frame) => (frame as { type?: string }).type === 'FILE_MEDIA_SOURCE_OFFER_REVOKE_V2',
      ),
    ).toBe(false);
    expect(closeConnection).toHaveBeenCalledOnce();
    expect(closeConnection).toHaveBeenCalledWith(pair.connection);
    await expect(owner.publishPrepared(preparedTrack('bounded-stream', 3))).rejects.toThrow(
      /closed/u,
    );
  });

  it('waits for an uncancellable R2 publish to settle and safely reuses its room object', async () => {
    const pair = connectionPair(() => 1_000);
    const first = preparedTrack('audio-buffer', 3);
    const second = preparedTrack('audio-buffer', 3);
    let resolveUpload!: (value: {
      objectId: string;
      expiresAt: number;
      cleanupToken: string;
    }) => void;
    const uploadResult = new Promise<{
      objectId: string;
      expiresAt: number;
      cleanupToken: string;
    }>((resolve) => {
      resolveUpload = resolve;
    });
    const upload = vi.fn(() => uploadResult);
    const deleteObject = vi.fn(async () => 'deleted' as const);
    const r2 = new FilePlaybackR2WholeBlobPublisher({
      roomToken: freezeCanonical({ room: 'r2-retire-owner' }),
      runtime: {
        createStorageRoomId: () => 'host_owner_retire_r2',
        encrypt: vi.fn(async (blob) => ({
          encryptedBlob: new Blob([new Uint8Array(blob.size + 16)]),
          keyB64: btoa('\0'.repeat(32)),
          ivB64: btoa('\0'.repeat(12)),
          plaintextSize: blob.size,
          encryptedSize: blob.size + 16,
        })),
        upload: upload as never,
        deleteObject: deleteObject as never,
        reserveTransport: vi.fn(() => ({ release: vi.fn() })) as never,
        resolveMemoryBudget: vi.fn(() => ({ tier: 'desktop' })) as never,
        livePcmBytes: () => 0,
      },
    });
    const closeConnection = vi.fn();
    const sendRequired = vi.fn(() => true);
    const sourceBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: r2,
      resolvePreparedPeerRangeSource: vi.fn(async () => sourceBlob),
      sendRequired,
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        nowEpochMsForTests: () => 1_000,
        scheduleIntervalForTests: () => 'host-owner-retire-r2-health',
        cancelIntervalForTests: vi.fn(),
      },
    });
    const pending = owner.publishPrepared(first);
    await drain(64);
    expect(upload).toHaveBeenCalledOnce();
    const retirement = owner.retirePrepared(first, new Error('cancel R2 candidate'));
    await expect(owner.publishPrepared(second)).rejects.toThrow(/retirement is settling/u);
    resolveUpload({
      objectId: '98000000-0000-4000-8000-000000000099',
      expiresAt: 61_000,
      cleanupToken: 'cleanup-token',
    });
    await expect(pending).rejects.toThrow(/stale/u);
    await expect(retirement).resolves.toBeUndefined();
    expect(closeConnection).not.toHaveBeenCalled();
    expect(sendRequired).not.toHaveBeenCalled();

    await expect(owner.publishPrepared(second)).resolves.toMatchObject({ prepared: second });
    expect(upload).toHaveBeenCalledOnce();
    expect(sendRequired).toHaveBeenCalledOnce();
    owner.port().revoke(pair.context);
    await r2.close();
    expect(deleteObject).toHaveBeenCalledOnce();
  });

  it('switches activated peer reads from the operation resolver to canonical room authority', async () => {
    const pair = connectionPair(() => 1_000);
    const prepared = preparedTrack('bounded-stream', 4);
    let current: Readonly<HostPeerPlaybackPublication> | null = null;
    const resolveCurrent = vi.fn(async () => encodedPreparedSource(prepared));
    const room: FilePlaybackProductHostMediaRoomPort = {
      currentPeerPublication: () => current,
      resolveCurrentPeerRangeSource: resolveCurrent,
      recoverRemoteParticipant: vi.fn(),
    };
    const resolvePrepared = vi.fn(async () => encodedPreparedSource(prepared));
    const required: unknown[] = [];
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: room,
      publisher: publisher(),
      resolvePreparedPeerRangeSource: resolvePrepared,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-activated-source-health',
        cancelIntervalForTests: vi.fn(),
      },
    });
    const candidate = await owner.publishPrepared(prepared);
    await owner.bindPrepared(prepared);
    const timeline = committedTimeline();
    current = committedPreparedPublication(prepared, timeline);
    owner.activatePrepared({ prepared, timeline });
    if (candidate.offer.transport !== 'peer-range') throw new Error('peer candidate unavailable');
    const acknowledge = vi.fn();
    owner.port().adoptPeerRangeControl(
      freezeCanonical({
        frame: createPeerRangeReadFrame({
          connectionId: pair.context.connectionId,
          sourceIdentity: prepared.asset.binding.sourceIdentity,
          handleId: candidate.offer.handleId,
          requestId: '98000000-0000-4000-8000-000000000078',
          offset: 0,
          totalLength: prepared.asset.encodedSize,
        }),
        lane: 'control' as const,
        role: 'host' as const,
        connection: pair.connection,
        channel: pair.host,
        connectionToken: pair.hostToken,
      }),
      acknowledge,
    );
    expect(acknowledge).toHaveBeenCalledOnce();
    await drain(64);
    expect(resolvePrepared).toHaveBeenCalledOnce();
    expect(resolveCurrent).toHaveBeenCalledOnce();
    expect(resolveCurrent).toHaveBeenCalledWith({
      publication: current,
      sourceIdentity: prepared.asset.binding.sourceIdentity,
      signal: expect.any(AbortSignal),
    });
    expect(required.some((frame) => (frame as { type?: string }).type === 'chunk')).toBe(true);
    owner.port().revoke(pair.context);
  });

  it('serializes baseline publication before a prepared successor publication', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([new Uint8Array([1])], { type: 'audio/flac' });
    const current = publication('bounded-stream', blob);
    const prepared = preparedTrack(
      'bounded-stream',
      3,
      freezeCanonical({ queueItemId: QID_2, runId: RUN_ID_2, revision: 2 }),
    );
    const required: unknown[] = [];
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => current,
        () => blob,
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: vi.fn(async () => encodedPreparedSource(prepared)),
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-publication-lane-health',
        cancelIntervalForTests: vi.fn(),
      },
    });
    const baselineTask = owner.publishCurrent();
    const candidateTask = owner.publishPrepared(prepared);
    await Promise.all([baselineTask, candidateTask]);
    expect(
      required
        .filter((frame) => (frame as { type?: string }).type === 'FILE_MEDIA_SOURCE_OFFER_V2')
        .map((frame) => (frame as { queueItemId: QueueItemId }).queueItemId),
    ).toEqual([QID, QID_2]);
    owner.port().revoke(pair.context);
  });

  it('defers READY publication so no upload or send re-enters the READY hook', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([new Uint8Array([1])], { type: 'audio/flac' });
    const current = publication('bounded-stream', blob);
    const sendRequired = vi.fn(() => true);
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => current,
        () => blob,
        [],
      ),
      publisher: publisher(),
      sendRequired,
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-ready-health',
        cancelIntervalForTests: vi.fn(),
      },
    });
    owner.port().onHostReady?.(
      freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: 1,
        epoch: 1,
        role: 'host' as const,
        sessionId: pair.context.sessionId,
        connectionId: pair.context.connectionId,
        baselineStatus: 'ready' as const,
        baselineId: 'host-owner-baseline',
        playbackRevision: 1,
        clockReady: true,
        ready: true,
      }),
    );
    expect(sendRequired).not.toHaveBeenCalled();
    await drain();
    expect(sendRequired).toHaveBeenCalledTimes(2);
    owner.port().revoke(pair.context);
  });

  it('publishes peer OFFER then RUN_BINDING and completes SOURCE_READY recovery', async () => {
    let now = 1_000;
    const pair = connectionPair(() => now);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/flac' });
    const current = publication('bounded-stream', blob);
    const recoveries: RecoverHostRemoteParticipantOptions[] = [];
    const room = roomPort(
      () => current,
      () => blob,
      recoveries,
    );
    const required: unknown[] = [];
    const wire: FilePlaybackWireMessage[] = [];
    let healthTick = (): void => undefined;
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: room,
      publisher: publisher(),
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, lease, payload) => {
        const message = pair.host.createWire(lease, payload);
        wire.push(message);
        return message;
      },
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: (callback) => {
          healthTick = callback;
          return 'host-owner-health';
        },
        cancelIntervalForTests: vi.fn(),
      },
    });

    const committed = await owner.publishCurrent();
    expect(required).toHaveLength(2);
    expect(required[0]).toMatchObject({
      type: 'FILE_MEDIA_SOURCE_OFFER_V2',
      transport: 'peer-range',
    });
    expect(required[1]).toMatchObject({ type: 'FILE_PLAYBACK_RUN_BINDING_V2', runId: RUN_ID });
    expect(committed.publication).toBe(current);
    expect(Object.getPrototypeOf(owner.port())).toBeNull();
    expect(Object.isFrozen(owner.port())).toBe(true);

    const guestState = pair.guest.bootstrapCurrentMedia({
      run: current.state,
      sourceIdentity: current.asset.binding.sourceIdentity,
      transferSessionId: current.asset.binding.transferSessionId,
    });
    const sourceReady = pair.guest.createWire(guestState, {
      kind: 'source-ready',
      observedAtRoomTimeMs: now,
      readyLeaseUntilRoomTimeMs: 10_000,
      backend: current.backend,
      durationSeconds: 180,
      bufferedAheadSeconds: 8,
      outputSampleRateHz: 48_000,
      channelCount: 2,
    });
    adoptWire(pair, owner, sourceReady);
    expect(wire).toHaveLength(0);
    await drain();
    expect(recoveries).toHaveLength(1);
    expect(wire.at(-1)).toMatchObject({ kind: 'rendezvous-arm' });

    const arm = wire.at(-1)!;
    if (arm.kind !== 'rendezvous-arm') throw new Error('ARM unavailable');
    const guestAttempt = pair.guest.stageAttempt(guestState, arm.rendezvousId);
    now = 1_500;
    adoptWire(
      pair,
      owner,
      pair.guest.createWire(guestAttempt, {
        kind: 'rendezvous-armed',
        rendezvousId: arm.rendezvousId,
        status: 'armed',
        observedAtRoomTimeMs: 1_500,
        bufferedAheadSeconds: 8,
        reasonCode: null,
      }),
    );
    await drain();
    expect(wire.at(-1)).toMatchObject({ kind: 'rendezvous-finalize' });
    const finalize = wire.at(-1)!;
    if (finalize.kind !== 'rendezvous-finalize') throw new Error('FINALIZE unavailable');
    adoptWire(
      pair,
      owner,
      pair.guest.createWire(guestAttempt, {
        kind: 'rendezvous-finalized',
        rendezvousId: finalize.rendezvousId,
        status: 'accepted',
        observedAtRoomTimeMs: 1_500,
        reasonCode: null,
      }),
    );
    await drain();
    now = 2_000;
    adoptWire(
      pair,
      owner,
      pair.guest.createWire(guestAttempt, {
        kind: 'renderer-health',
        rendezvousId: finalize.rendezvousId,
        value: 'healthy',
        observedAtRoomTimeMs: now,
        leaseUntilRoomTimeMs: 10_000,
        renderedFrame: 96_000,
        underrunCount: 0,
        reasonCode: null,
      }),
    );
    await drain();
    healthTick();
    expect(pair.host.createWire).toBeDefined();
    owner.port().revoke(pair.context);
  });

  it('uses one room publisher for ordinary Blob and emits an exact R2 offer', async () => {
    let now = 1_000;
    const pair = connectionPair(() => now);
    const blob = new Blob([new Uint8Array([7, 8, 9])], { type: 'audio/mpeg' });
    const current = publication('audio-buffer', blob);
    const recoveries: RecoverHostRemoteParticipantOptions[] = [];
    const room = roomPort(
      () => current,
      () => blob,
      recoveries,
    );
    const encryptedBlob = new Blob([new Uint8Array(blob.size + 16)]);
    const upload = vi.fn(async () => ({
      objectId: '98000000-0000-4000-8000-000000000099',
      cleanupToken: 'cleanup-token',
      expiresAt: 61_000,
    }));
    const r2 = new FilePlaybackR2WholeBlobPublisher({
      roomToken: freezeCanonical({ room: 'r2-owner' }),
      runtime: {
        createStorageRoomId: () => 'host_owner_r2',
        encrypt: vi.fn(async () => ({
          encryptedBlob,
          keyB64: btoa('\0'.repeat(32)),
          ivB64: btoa('\0'.repeat(12)),
          plaintextSize: blob.size,
          encryptedSize: blob.size + 16,
        })),
        upload: upload as never,
        reserveTransport: vi.fn(() => ({ release: vi.fn() })) as never,
        resolveMemoryBudget: vi.fn(() => ({ tier: 'desktop' })) as never,
        livePcmBytes: () => 0,
      },
    });
    const required: unknown[] = [];
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: room,
      publisher: r2,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        nowEpochMsForTests: () => 1_000,
        scheduleIntervalForTests: () => 'host-owner-r2-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    await owner.publishCurrent();
    expect(upload).toHaveBeenCalledOnce();
    expect(required[0]).toMatchObject({
      type: 'FILE_MEDIA_SOURCE_OFFER_V2',
      transport: 'r2-whole-blob',
      encodedSize: blob.size,
      encryptedSize: blob.size + 16,
      expiresAtRoomTimeMs: 61_000,
    });
    expect(required[1]).toMatchObject({ type: 'FILE_PLAYBACK_RUN_BINDING_V2' });
    expect(await owner.publishCurrent()).toBe(await owner.publishCurrent());
    owner.port().revoke(pair.context);
    await r2.close();
    now += 1;
  });

  it('keeps a paused late join prepared without starting a recovery rendezvous', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([new Uint8Array([1])], { type: 'audio/flac' });
    const current = publication('bounded-stream', blob, 'paused');
    const recoveries: RecoverHostRemoteParticipantOptions[] = [];
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => current,
        () => blob,
        recoveries,
      ),
      publisher: publisher(),
      sendRequired: () => true,
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-paused-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    await owner.publishCurrent();
    const guestState = pair.guest.bootstrapCurrentMedia({
      run: current.state,
      sourceIdentity: current.asset.binding.sourceIdentity,
      transferSessionId: current.asset.binding.transferSessionId,
    });
    adoptWire(
      pair,
      owner,
      pair.guest.createWire(guestState, {
        kind: 'source-ready',
        observedAtRoomTimeMs: 1_000,
        readyLeaseUntilRoomTimeMs: 10_000,
        backend: current.backend,
        durationSeconds: 180,
        bufferedAheadSeconds: 8,
        outputSampleRateHz: 48_000,
        channelCount: 2,
      }),
    );
    await drain();

    expect(recoveries).toHaveLength(0);
    owner.port().revoke(pair.context);
  });

  it('does not treat visibility as failure and emits one gray message after 1.5s degradation', async () => {
    let now = 1_000;
    const pair = connectionPair(() => now);
    const blob = new Blob([new Uint8Array([1])], { type: 'audio/flac' });
    const current = publication('bounded-stream', blob);
    const messages = vi.fn();
    let tick = (): void => undefined;
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => current,
        () => blob,
        [],
      ),
      publisher: publisher(),
      sendRequired: () => true,
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: messages,
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: (callback) => {
          tick = callback;
          return 'host-owner-message-health';
        },
        cancelIntervalForTests: vi.fn(),
      },
    });
    owner.setDocumentHidden(true);
    now = 2_600;
    tick();
    expect(messages).not.toHaveBeenCalled();

    pair.connection.open = false;
    now = 2_601;
    tick();
    now = 4_100;
    tick();
    expect(messages).not.toHaveBeenCalled();
    now = 4_101;
    tick();
    expect(messages).toHaveBeenCalledOnce();
    expect(messages).toHaveBeenCalledWith({
      schemaVersion: 1,
      participantId: pair.context.guestParticipantId,
      messageKey: 'participant-connection-unstable-recovering',
    });
    now = 4_500;
    tick();
    expect(messages).toHaveBeenCalledOnce();
    owner.port().revoke(pair.context);
  });

  it('fences delayed publication after revoke without sending or closing the shared publisher', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([new Uint8Array([5])], { type: 'audio/mpeg' });
    const current = publication('audio-buffer', blob);
    let resolveSource!: (value: Blob) => void;
    const source = new Promise<Blob>((resolve) => {
      resolveSource = resolve;
    });
    const room: FilePlaybackProductHostMediaRoomPort = {
      currentPeerPublication: () => current,
      resolveCurrentPeerRangeSource: vi.fn(() => source),
      recoverRemoteParticipant: vi.fn(),
    };
    const sendRequired = vi.fn(() => true);
    const r2 = publisher();
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: room,
      publisher: r2,
      sendRequired,
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-revoke-health',
        cancelIntervalForTests: vi.fn(),
      },
    });
    const pending = owner.publishCurrent();
    await drain();
    owner.port().revoke(pair.context);
    resolveSource(blob);
    await expect(pending).rejects.toThrow(/stale|closed|aborted/u);
    expect(sendRequired).not.toHaveBeenCalled();
    await expect(r2.close()).resolves.toBeUndefined();
  });

  it('closes an encoded peer lease when publication authority changes during resolution', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([new Uint8Array([3])], { type: 'audio/flac' });
    let current: Readonly<HostPeerPlaybackPublication> | null = publication('bounded-stream', blob);
    let resolveSource!: (source: EncodedAudioSource) => void;
    const pendingSource = new Promise<EncodedAudioSource>((resolve) => {
      resolveSource = resolve;
    });
    const closeSource = vi.fn(async () => undefined);
    const room: FilePlaybackProductHostMediaRoomPort = {
      currentPeerPublication: () => current,
      resolveCurrentPeerRangeSource: vi.fn(() => pendingSource),
      recoverRemoteParticipant: vi.fn(),
    };
    const required: unknown[] = [];
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: room,
      publisher: publisher(),
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-source-health',
        cancelIntervalForTests: vi.fn(),
      },
    });
    const published = await owner.publishCurrent();
    if (published.offer.transport !== 'peer-range') throw new Error('peer offer unavailable');
    const frame = createPeerRangeReadFrame({
      connectionId: pair.context.connectionId,
      sourceIdentity: current!.asset.binding.sourceIdentity,
      handleId: published.offer.handleId,
      requestId: '98000000-0000-4000-8000-000000000077',
      offset: 0,
      totalLength: 1,
    });
    const acknowledge = vi.fn();
    owner.port().adoptPeerRangeControl(
      freezeCanonical({
        frame,
        lane: 'control' as const,
        role: 'host' as const,
        connection: pair.connection,
        channel: pair.host,
        connectionToken: pair.hostToken,
      }),
      acknowledge,
    );
    expect(acknowledge).toHaveBeenCalledOnce();
    await drain();
    expect(room.resolveCurrentPeerRangeSource).toHaveBeenCalledOnce();
    current = null;
    resolveSource({
      kind: 'peer-range',
      size: 1,
      identity: 'host-owner-source',
      metadata: { name: 'owner.flac', mime: 'audio/flac' },
      readAt: vi.fn(async () => new Uint8Array([3])),
      close: closeSource,
    });
    await drain(64);
    expect(closeSource).toHaveBeenCalledOnce();
    expect(required.some((value) => (value as { type?: string }).type === 'error')).toBe(true);
    owner.port().revoke(pair.context);
  });
});
