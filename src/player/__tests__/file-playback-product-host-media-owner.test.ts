import { describe, expect, it, vi } from 'vitest';

import {
  FilePlaybackGuestSessionHandshake,
  FilePlaybackHandshakeIdIssuer,
  FilePlaybackHostSessionHandshake,
} from '../../network/file-playback-session-handshake.ts';
import { FilePlaybackConnectionChannel } from '../../network/file-playback-connection-channel.ts';
import type { DataConnection, QueueItemId } from '../../types/index.ts';
import type {
  HostPeerPlaybackPublication,
  HostRemoteRecoveryCommit,
  RecoverHostRemoteParticipantOptions,
} from '../file-playback-host-first-file-engine.ts';
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
  backend: 'audio-buffer' | 'streaming-flac',
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
        name: backend === 'streaming-flac' ? 'owner.flac' : 'owner.mp3',
        mime: backend === 'streaming-flac' ? 'audio/flac' : 'audio/mpeg',
      }),
      encodedSize: blob.size,
    }),
  });
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
  it('defers READY publication so no upload or send re-enters the READY hook', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([new Uint8Array([1])], { type: 'audio/flac' });
    const current = publication('streaming-flac', blob);
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
    const current = publication('streaming-flac', blob);
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
    const current = publication('streaming-flac', blob, 'paused');
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
    const current = publication('streaming-flac', blob);
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
    let current: Readonly<HostPeerPlaybackPublication> | null = publication('streaming-flac', blob);
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
