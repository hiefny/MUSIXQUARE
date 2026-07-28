import { describe, expect, it, vi } from 'vitest';

import {
  FilePlaybackGuestSessionHandshake,
  FilePlaybackHandshakeIdIssuer,
  FilePlaybackHostSessionHandshake,
} from '../../network/file-playback-session-handshake.ts';
import { FilePlaybackConnectionChannel } from '../../network/file-playback-connection-channel.ts';
import type { DataConnection, QueueItemId } from '../../types/index.ts';
import type {
  HostLocalTrackSourceLease,
  HostPreparedLocalTrack,
  HostPeerPlaybackPublication,
  HostPeerRangeManifestPublication,
  HostPeerRangeSource,
  HostRemoteRecoveryCommit,
  RecoverHostRemoteParticipantOptions,
  ResolveHostPeerRangeSourceOptions,
  ResolvePreparedHostPeerRangeSourceOptions,
  ResolveWarmHostPeerRangeSourceOptions,
} from '../file-playback-host-first-file-engine.ts';
import {
  FILE_PLAYBACK_CURRENT_BOUNDED_ROUTE_POLICY,
  FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
} from '../file-playback-bounded-route-policy.ts';
import {
  derivePeerRangeManifestBundleSize,
  type AnyPeerRangeFileMediaSourceOfferV2,
  type FileMediaSourceOfferV2,
} from '../file-media-source-offer.ts';
import { fileMediaSourceRevokeMatchesOfferV2 } from '../file-media-source-revoke.ts';
import {
  FilePlaybackProductHostMediaOwner,
  type FilePlaybackProductHostMediaRoomPort,
  type FilePlaybackProductHostMediaOwnerOptions,
} from '../file-playback-product-host-media-owner.ts';
import type { FilePlaybackProductHostLocalTrackWarmResult } from '../file-playback-product-host-room.ts';
import { FilePlaybackR2WholeBlobPublisher } from '../file-playback-r2-whole-blob-publisher.ts';
import type { HostRendezvousAttempt } from '../rendezvous-coordinator.ts';
import type { FilePlaybackWireMessage } from '../file-playback-wire.ts';
import {
  createPeerRangeReadFrame,
  parsePeerRangeBulkFrame,
} from '../sources/peer-range-protocol.ts';
import type { EncodedAudioSource } from '../sources/encoded-audio-source.ts';

const QID = '98000000-0000-4000-8000-000000000001' as QueueItemId;
const RUN_ID = '98000000-0000-4000-8000-000000000002';
const QID_2 = '98000000-0000-4000-8000-000000000003' as QueueItemId;
const RUN_ID_2 = '98000000-0000-4000-8000-000000000004';
const MANIFEST_SHA256_B64 = 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=';

type WarmAuthority = Readonly<
  Omit<FilePlaybackProductHostLocalTrackWarmResult, 'sourceLease'> & {
    readonly sourceLease: HostLocalTrackSourceLease;
  }
>;

function requirePeerRangeOffer(
  offer: Readonly<FileMediaSourceOfferV2>,
): Readonly<AnyPeerRangeFileMediaSourceOfferV2> {
  if (offer.transport !== 'peer-range' && offer.transport !== 'peer-range-manifest') {
    throw new Error('peer offer unavailable');
  }
  return offer;
}

function manifestDiagnostics(
  overrides: Partial<HostPeerRangeManifestPublication> = {},
): Readonly<HostPeerRangeManifestPublication> {
  return freezeCanonical({
    codec: 'adts-aac-lc' as const,
    manifestByteLength: 128,
    manifestSha256B64: MANIFEST_SHA256_B64,
    ...overrides,
  });
}

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
  peerRangeManifest: Readonly<HostPeerRangeManifestPublication> | null = null,
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
      peerRangeManifest,
    }),
  });
}

function preparedTrack(
  backend: 'audio-buffer' | 'bounded-stream',
  encodedSize: number,
  state = freezeCanonical({ queueItemId: QID, runId: RUN_ID, revision: 1 }),
  sourceLease: HostLocalTrackSourceLease | null = null,
  peerRangeManifest: Readonly<HostPeerRangeManifestPublication> | null = null,
): Readonly<HostPreparedLocalTrack> {
  return freezeCanonical({
    schemaVersion: 1 as const,
    roomGeneration: 1,
    backend,
    state,
    positionSeconds: 3,
    playbackRate: 1,
    sourceLease,
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
      peerRangeManifest,
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
  timeline: Readonly<HostPeerPlaybackPublication['timeline']>,
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

function sameSourceSuccessorPublication(
  previous: Readonly<HostPeerPlaybackPublication>,
  revision: number,
  phase: 'paused' | 'playing',
  positionSeconds: number,
  anchorMonotonicMs: number,
): Readonly<HostPeerPlaybackPublication> {
  const state = freezeCanonical({
    queueItemId: previous.state.queueItemId,
    runId: previous.state.runId,
    revision,
  });
  return freezeCanonical({
    ...previous,
    state,
    timeline: freezeCanonical({
      schemaVersion: 1 as const,
      revision,
      phase,
      run: previous.timeline.run,
      positionSeconds,
      anchorMonotonicMs,
      rate: previous.timeline.rate,
    }),
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

function encodedBundleSource(
  asset: Readonly<HostPreparedLocalTrack['asset']>,
  bytes: Uint8Array,
  close = vi.fn(async () => undefined),
): EncodedAudioSource {
  return {
    kind: 'peer-range',
    size: bytes.byteLength,
    identity: asset.binding.sourceIdentity,
    metadata: {
      name: asset.metadata.name,
      mime: asset.metadata.mime,
    },
    readAt: vi.fn(async (offset: number, length: number) => bytes.slice(offset, offset + length)),
    close,
  };
}

function manifestBundle(
  manifest: Readonly<HostPeerRangeManifestPublication>,
  media = Uint8Array.of(201, 202, 203, 204),
): Readonly<{ manifestBytes: Uint8Array; mediaBytes: Uint8Array; bytes: Uint8Array }> {
  const manifestBytes = new Uint8Array(manifest.manifestByteLength);
  for (let index = 0; index < manifestBytes.byteLength; index += 1) {
    manifestBytes[index] = (index % 251) + 1;
  }
  const bytes = new Uint8Array(manifestBytes.byteLength + media.byteLength);
  bytes.set(manifestBytes, 0);
  bytes.set(media, manifestBytes.byteLength);
  return Object.freeze({ manifestBytes, mediaBytes: media, bytes });
}

function warmSourceLease(): HostLocalTrackSourceLease {
  return freezeCanonical({}) as unknown as HostLocalTrackSourceLease;
}

function warmAuthority(
  pair: ConnectionPair,
  sourceLease: HostLocalTrackSourceLease,
  suffix = 'warm',
  sourceIdentity = `host-owner-${suffix}-source`,
  peerRangeManifest: Readonly<HostPeerRangeManifestPublication> | null = null,
): WarmAuthority {
  return freezeCanonical({
    schemaVersion: 1 as const,
    roomGeneration: 1,
    applicationSessionId: pair.context.sessionId,
    hostParticipantId: pair.context.hostParticipantId,
    status: 'warmed' as const,
    backend: 'bounded-stream' as const,
    asset: freezeCanonical({
      kind: 'blob' as const,
      binding: freezeCanonical({
        queueItemId: suffix === 'warm' ? QID : QID_2,
        sourceIdentity,
        transferSessionId: `host-owner-${suffix}-transfer`,
      }),
      metadata: freezeCanonical({
        name: `${suffix}.flac`,
        mime: 'audio/flac',
      }),
      encodedSize: 4,
      peerRangeManifest,
    }),
    readiness: freezeCanonical({
      durationSeconds: 120,
      bufferedAheadSeconds: 8,
      outputSampleRateHz: 48_000,
      channelCount: 2,
    }),
    sourceLease,
  });
}

function matchingWarmAuthorityWithManifest(
  pair: ConnectionPair,
  sourceLease: HostLocalTrackSourceLease,
  prepared: Readonly<HostPreparedLocalTrack>,
  peerRangeManifest: Readonly<HostPeerRangeManifestPublication>,
): WarmAuthority {
  return freezeCanonical({
    schemaVersion: 1 as const,
    roomGeneration: prepared.roomGeneration,
    applicationSessionId: pair.context.sessionId,
    hostParticipantId: pair.context.hostParticipantId,
    status: 'warmed' as const,
    backend: 'bounded-stream' as const,
    asset: freezeCanonical({
      ...prepared.asset,
      binding: freezeCanonical({ ...prepared.asset.binding }),
      metadata: freezeCanonical({ ...prepared.asset.metadata }),
      peerRangeManifest,
    }),
    readiness: freezeCanonical({
      durationSeconds: 120,
      bufferedAheadSeconds: 8,
      outputSampleRateHz: 48_000,
      channelCount: 2,
    }),
    sourceLease,
  });
}

function matchingWarmAuthority(
  pair: ConnectionPair,
  sourceLease: HostLocalTrackSourceLease,
  prepared: Readonly<HostPreparedLocalTrack>,
): WarmAuthority {
  return freezeCanonical({
    schemaVersion: 1 as const,
    roomGeneration: prepared.roomGeneration,
    applicationSessionId: pair.context.sessionId,
    hostParticipantId: pair.context.hostParticipantId,
    status: 'warmed' as const,
    backend: 'bounded-stream' as const,
    asset: prepared.asset,
    readiness: freezeCanonical({
      durationSeconds: 120,
      bufferedAheadSeconds: 8,
      outputSampleRateHz: 48_000,
      channelCount: 2,
    }),
    sourceLease,
  });
}

function encodedWarmSource(
  authority: Readonly<FilePlaybackProductHostLocalTrackWarmResult>,
  close = vi.fn(async () => undefined),
): EncodedAudioSource {
  return {
    kind: 'peer-range',
    size: authority.asset.encodedSize,
    identity: authority.asset.binding.sourceIdentity,
    metadata: {
      name: authority.asset.metadata.name,
      mime: authority.asset.metadata.mime,
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

function publisherWithOneFailedUpload(errorMessage: string): Readonly<{
  instance: FilePlaybackR2WholeBlobPublisher;
  upload: ReturnType<typeof vi.fn>;
}> {
  const upload = vi.fn(async () => ({
    objectId: '98000000-0000-4000-8000-000000000099',
    cleanupToken: 'host-owner-cleanup-token',
    expiresAt: 61_000,
  }));
  upload.mockRejectedValueOnce(new Error(errorMessage));
  const instance = new FilePlaybackR2WholeBlobPublisher({
    roomToken: freezeCanonical({ room: `host-owner-${errorMessage}` }),
    runtime: {
      createStorageRoomId: () => 'host_owner_retry_room',
      encrypt: vi.fn(async (blob: Blob) => ({
        encryptedBlob: new Blob([new Uint8Array(blob.size + 16)]),
        keyB64: btoa('\0'.repeat(32)),
        ivB64: btoa('\0'.repeat(12)),
        plaintextSize: blob.size,
        encryptedSize: blob.size + 16,
      })) as never,
      upload: upload as never,
      deleteObject: vi.fn(async () => 'deleted' as const),
      reserveTransport: vi.fn(() => ({ release: vi.fn() })) as never,
      resolveMemoryBudget: vi.fn(() => ({ tier: 'desktop' })) as never,
      livePcmBytes: () => 0,
    },
  });
  return Object.freeze({ instance, upload });
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

function receiveHostWireAtGuest(
  pair: ConnectionPair,
  message: FilePlaybackWireMessage,
): Extract<
  ReturnType<FilePlaybackConnectionChannel['receive']>,
  { accepted: true; frame: 'wire' }
> {
  const result = pair.guest.receive(message, pair.guestToken);
  if (!result.accepted || result.frame !== 'wire') {
    throw new Error(`host wire rejected: ${JSON.stringify(result)}`);
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
    '98000000-0000-4000-8000-000000000015',
    '98000000-0000-4000-8000-000000000016',
    '98000000-0000-4000-8000-000000000017',
    '98000000-0000-4000-8000-000000000018',
  ];
  let index = 0;
  return () => values[index++] ?? values.at(-1)!;
}

function offerTimers() {
  const callbacks = new Map<string, () => void>();
  let sequence = 0;
  const schedule = vi.fn((callback: () => void, delayMs: number) => {
    expect(delayMs).toBe(15 * 60 * 1_000);
    const handle = `warm-offer-${++sequence}`;
    callbacks.set(handle, callback);
    return handle;
  });
  const cancel = vi.fn((handle: string) => {
    callbacks.delete(handle);
  });
  return { callbacks, schedule, cancel };
}

function requestPeerRange(
  pair: ConnectionPair,
  owner: FilePlaybackProductHostMediaOwner,
  options: Readonly<{
    sourceIdentity: string;
    handleId: string;
    offset?: number;
    totalLength: number;
    requestId: string;
  }>,
): void {
  const acknowledge = vi.fn();
  owner.port().adoptPeerRangeControl(
    freezeCanonical({
      frame: createPeerRangeReadFrame({
        connectionId: pair.context.connectionId,
        sourceIdentity: options.sourceIdentity,
        handleId: options.handleId,
        requestId: options.requestId,
        offset: options.offset ?? 0,
        totalLength: options.totalLength,
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
}

function peerRangeChunkBytes(required: readonly unknown[], requestId: string): Uint8Array {
  const frames = required
    .filter((frame) => (frame as { type?: string }).type === 'chunk')
    .map((frame) => parsePeerRangeBulkFrame(frame))
    .filter((frame) => frame.type === 'chunk' && frame.requestId === requestId)
    .sort((left, right) => left.chunkIndex - right.chunkIndex);
  const totalLength = frames.reduce(
    (length, frame) => length + (frame.type === 'chunk' ? frame.payload.byteLength : 0),
    0,
  );
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const frame of frames) {
    if (frame.type !== 'chunk') continue;
    const chunk = new Uint8Array(frame.payload);
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

describe('FilePlaybackProductHostMediaOwner', () => {
  it('offers an exact prepared candidate, serves peer ranges, then binds one shared cohort', async () => {
    let now = 1_000;
    const pair = connectionPair(() => now);
    const prepared = preparedTrack('bounded-stream', 4);
    const required: unknown[] = [];
    const wire: FilePlaybackWireMessage[] = [];
    const recoveries: RecoverHostRemoteParticipantOptions[] = [];
    const closeConnection = vi.fn();
    let current: Readonly<HostPeerPlaybackPublication> | null = null;
    const resolvePrepared = vi.fn(
      async (options: ResolvePreparedHostPeerRangeSourceOptions): Promise<HostPeerRangeSource> => {
        if (
          options.prepared !== prepared ||
          options.sourceIdentity !== prepared.asset.binding.sourceIdentity ||
          options.peerRangeManifest !== null ||
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
        recoveries,
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
    expect(resolvePrepared.mock.calls.map(([options]) => options.peerRangeManifest)).toEqual([
      null,
      null,
    ]);
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
    expect(capability.participant.armP95Ms).toBe(500);

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
    expect(closeConnection).not.toHaveBeenCalled();
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
    expect(closeConnection).not.toHaveBeenCalled();
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
    expect(() => owner.activatePrepared({ prepared, timeline } as never)).toThrow(/stale/u);
    const activated = owner.activatePrepared({
      prepared,
      timeline,
      initialCohortAdmitted: true,
    });
    expect(activated.publication).toBe(current);
    expect(
      required.some(
        (frame) => (frame as { type?: string }).type === 'FILE_PLAYBACK_TIMELINE_UPDATE_V2',
      ),
    ).toBe(false);
    acceptParticipant({ participantId: capability.participant.participantId });
    await drain();
    expect(required.at(-1)).toMatchObject({
      type: 'FILE_PLAYBACK_TIMELINE_UPDATE_V2',
      roomGeneration: 1,
      queueItemId: QID,
      runId: RUN_ID,
      revision: 1,
    });
    expect(closeConnection).not.toHaveBeenCalled();
    expect(recoveries).toHaveLength(0);
    expect(() =>
      owner.activatePrepared({ prepared, timeline, initialCohortAdmitted: true }),
    ).toThrow(/stale/u);
    owner.port().revoke(pair.context);
  });

  it.each(['cancelled', 'failed'] as const)(
    'starts a fresh recovery when an admitted prepared attempt is %s before activation',
    async (outcome) => {
      let now = 1_000;
      const pair = connectionPair(() => now);
      const prepared = preparedTrack('bounded-stream', 4);
      const recoveries: RecoverHostRemoteParticipantOptions[] = [];
      const wire: FilePlaybackWireMessage[] = [];
      const closeConnection = vi.fn();
      let current: Readonly<HostPeerPlaybackPublication> | null = null;
      const owner = new FilePlaybackProductHostMediaOwner({
        context: pair.context,
        hostRoom: roomPort(
          () => current,
          () => new Blob(),
          recoveries,
        ),
        publisher: publisher(),
        resolvePreparedPeerRangeSource: vi.fn(async () => encodedPreparedSource(prepared)),
        sendRequired: () => true,
        sendWire: (_connection, lease, payload) => {
          const message = pair.host.createWire(lease, payload);
          wire.push(message);
          return message;
        },
        closeConnection,
        onHealthSystemMessage: vi.fn(),
        runtimeForTests: {
          createMediaIdForTests: ids(),
          scheduleIntervalForTests: () => `host-owner-${outcome}-attempt-health`,
          cancelIntervalForTests: vi.fn(),
        },
      });

      await owner.publishPrepared(prepared);
      await owner.bindPrepared(prepared);
      const ready = owner.whenPreparedRemoteReady(prepared);
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
      const publishFreshReady = () => {
        now += 100;
        adoptWire(
          pair,
          owner,
          pair.guest.createWire(guestState, {
            kind: 'source-ready',
            observedAtRoomTimeMs: now,
            readyLeaseUntilRoomTimeMs: now + 10_000,
            backend: prepared.backend,
            durationSeconds: 180,
            bufferedAheadSeconds: 8,
            outputSampleRateHz: 48_000,
            channelCount: 2,
          }),
        );
      };
      const capability = await ready;
      const accepted =
        outcome === 'failed'
          ? Promise.reject(new Error('fixture prepared acceptance failed'))
          : new Promise<unknown>(() => undefined);
      const attempt = {
        rendezvousId: `host-owner-prepared-${outcome}`,
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
      void evidence.catch(() => undefined);

      if (outcome === 'cancelled') {
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
        expect(wire.at(-1)).toMatchObject({
          kind: 'rendezvous-arm',
          rendezvousId: attempt.rendezvousId,
        });
        await capability.participant.cancel({
          kind: 'file-playback-cancel',
          ...prepared.state,
          rendezvousId: attempt.rendezvousId,
          reasonCode: 'remote-arm-receipt-late',
        });
        await drain();
        await expect(armTask).resolves.toMatchObject({ status: 'rejected' });
        expect(wire.at(-1)).toMatchObject({
          kind: 'file-playback-cancel',
          rendezvousId: attempt.rendezvousId,
        });
        // Exercise the race where physical re-staging completes before the
        // host publishes canonical activation.
        publishFreshReady();
      } else {
        await expect(evidence).rejects.toThrow('fixture prepared acceptance failed');
      }

      const timeline = committedTimeline();
      current = committedPreparedPublication(prepared, timeline);
      owner.activatePrepared({
        prepared,
        timeline,
        initialCohortAdmitted: true,
      });
      await drain(64);

      expect(recoveries).toHaveLength(outcome === 'cancelled' ? 1 : 0);
      if (outcome === 'failed') {
        publishFreshReady();
        await drain(64);
      }

      expect(recoveries).toHaveLength(1);
      expect(wire.at(-1)).toMatchObject({
        kind: 'rendezvous-arm',
        rendezvousId: 'host-owner-rendezvous-1',
      });
      expect(closeConnection).not.toHaveBeenCalled();
      owner.port().revoke(pair.context);
    },
  );

  it('cancels prepared renderer-start failure exactly once before admitting a later recovery', async () => {
    let now = 1_000;
    const pair = connectionPair(() => now);
    const prepared = preparedTrack('bounded-stream', 4);
    const recoveries: RecoverHostRemoteParticipantOptions[] = [];
    const wire: FilePlaybackWireMessage[] = [];
    const closeConnection = vi.fn();
    let current: Readonly<HostPeerPlaybackPublication> | null = null;
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => current,
        () => new Blob(),
        recoveries,
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: vi.fn(async () => encodedPreparedSource(prepared)),
      sendRequired: () => true,
      sendWire: (_connection, lease, payload) => {
        const message = pair.host.createWire(lease, payload);
        wire.push(message);
        return message;
      },
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-prepared-renderer-failure-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    await owner.publishPrepared(prepared);
    await owner.bindPrepared(prepared);
    const ready = owner.whenPreparedRemoteReady(prepared);
    pair.guest.bootstrapStopped(0);
    const guestState = pair.guest.stageMedia({
      run: prepared.state,
      sourceIdentity: prepared.asset.binding.sourceIdentity,
      transferSessionId: prepared.asset.binding.transferSessionId,
    });
    const publishFreshReady = () => {
      now += 100;
      adoptWire(
        pair,
        owner,
        pair.guest.createWire(guestState, {
          kind: 'source-ready',
          observedAtRoomTimeMs: now,
          readyLeaseUntilRoomTimeMs: now + 10_000,
          backend: prepared.backend,
          durationSeconds: 180,
          bufferedAheadSeconds: 8,
          outputSampleRateHz: 48_000,
          channelCount: 2,
        }),
      );
    };
    publishFreshReady();
    const capability = await ready;
    const attemptId = 'host-owner-prepared-renderer-failure';
    const cancelAttempt = vi.fn((reasonCode = 'cancelled-by-host') => {
      void capability.participant.cancel({
        kind: 'file-playback-cancel',
        ...prepared.state,
        rendezvousId: attemptId,
        reasonCode,
      });
      return {} as ReturnType<HostRendezvousAttempt['cancel']>;
    });
    const attempt = {
      ...fakeAttempt(attemptId),
      whenParticipantAccepted: vi.fn(() => new Promise<unknown>(() => undefined)),
      cancel: cancelAttempt,
    } as unknown as HostRendezvousAttempt;
    const evidence = capability.bindAttempt(attempt);
    const evidenceFailure = expect(evidence).rejects.toThrow(
      'Guest renderer start evidence failed: start-evidence-timeout',
    );
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
    const arm = wire.at(-1);
    if (arm?.kind !== 'rendezvous-arm') throw new Error('prepared failure ARM unavailable');
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
    const finalize = wire.at(-1);
    if (finalize?.kind !== 'rendezvous-finalize') {
      throw new Error('prepared failure FINALIZE unavailable');
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
        rendezvousId: finalize.rendezvousId,
        value: 'unhealthy',
        observedAtRoomTimeMs: now,
        leaseUntilRoomTimeMs: now,
        renderedFrame: 0,
        underrunCount: 0,
        reasonCode: 'start-evidence-timeout',
      }),
    );
    await evidenceFailure;
    await drain(64);

    expect(cancelAttempt).toHaveBeenCalledOnce();
    expect(cancelAttempt).toHaveBeenCalledWith('renderer-start-failed');
    expect(
      wire.filter(
        (message) =>
          message.kind === 'file-playback-cancel' && message.rendezvousId === attempt.rendezvousId,
      ),
    ).toHaveLength(1);
    expect(closeConnection).not.toHaveBeenCalled();

    const timeline = committedTimeline();
    current = committedPreparedPublication(prepared, timeline);
    owner.activatePrepared({
      prepared,
      timeline,
      initialCohortAdmitted: true,
    });
    publishFreshReady();
    await drain(64);

    expect(recoveries).toHaveLength(1);
    expect(wire.at(-1)).toMatchObject({
      kind: 'rendezvous-arm',
      rendezvousId: 'host-owner-rendezvous-1',
    });
    expect(closeConnection).not.toHaveBeenCalled();
    owner.port().revoke(pair.context);
  });

  it('recovers a prepared attempt whose participant acceptance fails after activation', async () => {
    let now = 1_000;
    const pair = connectionPair(() => now);
    const prepared = preparedTrack('bounded-stream', 4);
    const recoveries: RecoverHostRemoteParticipantOptions[] = [];
    const wire: FilePlaybackWireMessage[] = [];
    const required: unknown[] = [];
    const closeConnection = vi.fn();
    let current: Readonly<HostPeerPlaybackPublication> | null = null;
    let rejectAcceptance!: (reason: Error) => void;
    const acceptance = new Promise<unknown>((_resolve, reject) => {
      rejectAcceptance = reject;
    });
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => current,
        () => new Blob(),
        recoveries,
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: vi.fn(async () => encodedPreparedSource(prepared)),
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
        scheduleIntervalForTests: () => 'host-owner-post-activation-failure-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    await owner.publishPrepared(prepared);
    await owner.bindPrepared(prepared);
    const ready = owner.whenPreparedRemoteReady(prepared);
    pair.guest.bootstrapStopped(0);
    const guestState = pair.guest.stageMedia({
      run: prepared.state,
      sourceIdentity: prepared.asset.binding.sourceIdentity,
      transferSessionId: prepared.asset.binding.transferSessionId,
    });
    const publishFreshReady = () => {
      now += 100;
      adoptWire(
        pair,
        owner,
        pair.guest.createWire(guestState, {
          kind: 'source-ready',
          observedAtRoomTimeMs: now,
          readyLeaseUntilRoomTimeMs: now + 10_000,
          backend: prepared.backend,
          durationSeconds: 180,
          bufferedAheadSeconds: 8,
          outputSampleRateHz: 48_000,
          channelCount: 2,
        }),
      );
    };
    publishFreshReady();
    const capability = await ready;
    const attempt = {
      ...fakeAttempt('host-owner-post-activation-failure'),
      whenParticipantAccepted: vi.fn(() => acceptance),
    } as unknown as HostRendezvousAttempt;
    const evidence = capability.bindAttempt(attempt);
    void evidence.catch(() => undefined);

    const timeline = committedTimeline();
    current = committedPreparedPublication(prepared, timeline);
    owner.activatePrepared({
      prepared,
      timeline,
      initialCohortAdmitted: true,
    });
    rejectAcceptance(new Error('fixture acceptance failed after activation'));
    await drain(64);

    expect(closeConnection).not.toHaveBeenCalled();
    expect(recoveries).toHaveLength(0);
    expect(
      required.some(
        (frame) => (frame as { type?: string }).type === 'FILE_PLAYBACK_TIMELINE_UPDATE_V2',
      ),
    ).toBe(false);

    publishFreshReady();
    await drain(64);
    expect(recoveries).toHaveLength(1);
    expect(wire.at(-1)).toMatchObject({
      kind: 'rendezvous-arm',
      rendezvousId: 'host-owner-rendezvous-1',
    });
    expect(closeConnection).not.toHaveBeenCalled();
    owner.port().revoke(pair.context);
  });

  it('dispatches exact CANCEL ahead of an already-queued recovery rejection without touching its successor', async () => {
    let now = 1_000;
    const pair = connectionPair(() => now);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/flac' });
    const current = publication('bounded-stream', blob);
    const recoveries: Array<{
      readonly options: RecoverHostRemoteParticipantOptions;
      readonly reject: (reason: Error) => void;
    }> = [];
    const recoverRemoteParticipant = vi.fn((options: RecoverHostRemoteParticipantOptions) => {
      let rejectRecovery!: (reason: Error) => void;
      const task = new Promise<Readonly<HostRemoteRecoveryCommit>>((_resolve, reject) => {
        rejectRecovery = reject;
      });
      recoveries.push({ options, reject: rejectRecovery });
      return task;
    });
    const wire: FilePlaybackWireMessage[] = [];
    const closeConnection = vi.fn();
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: {
        currentPeerPublication: () => current,
        resolveCurrentPeerRangeSource: vi.fn(async () => blob),
        recoverRemoteParticipant,
      },
      publisher: publisher(),
      sendRequired: () => true,
      sendWire: (_connection, lease, payload) => {
        const message = pair.host.createWire(lease, payload);
        wire.push(message);
        return message;
      },
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-recovery-aba-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    await owner.publishCurrent();
    const guestState = pair.guest.bootstrapCurrentMedia({
      run: current.state,
      sourceIdentity: current.asset.binding.sourceIdentity,
      transferSessionId: current.asset.binding.transferSessionId,
    });
    const publishFreshReady = () => {
      now += 100;
      adoptWire(
        pair,
        owner,
        pair.guest.createWire(guestState, {
          kind: 'source-ready',
          observedAtRoomTimeMs: now,
          readyLeaseUntilRoomTimeMs: now + 10_000,
          backend: current.backend,
          durationSeconds: 180,
          bufferedAheadSeconds: 8,
          outputSampleRateHz: 48_000,
          channelCount: 2,
        }),
      );
    };
    publishFreshReady();
    await drain(64);
    expect(recoveries).toHaveLength(1);

    const first = recoveries[0]!;
    const firstAttempt = fakeAttempt('host-owner-recovery-aba-first');
    const firstEvidence = first.options.bindAttempt(firstAttempt);
    void firstEvidence.catch(() => undefined);
    const firstArm = first.options.participant.arm({
      protocolVersion: 2,
      kind: 'rendezvous-arm',
      ...current.state,
      rendezvousId: firstAttempt.rendezvousId,
      recipientId: first.options.participant.participantId,
      positionSeconds: 4,
      playbackRate: 1,
      startAtRoomTimeMs: 2_000,
      finalizeByRoomTimeMs: 1_900,
    });
    await drain();
    first.reject(new Error('fixture first recovery rejection was already queued'));
    await first.options.participant.cancel({
      kind: 'file-playback-cancel',
      ...current.state,
      rendezvousId: firstAttempt.rendezvousId,
      reasonCode: 'fixture-recovery-retry',
    });
    await drain();
    await expect(firstArm).resolves.toMatchObject({ status: 'rejected' });
    expect(wire.at(-1)).toMatchObject({
      kind: 'file-playback-cancel',
      rendezvousId: firstAttempt.rendezvousId,
    });

    publishFreshReady();
    await drain(64);
    expect(recoveries).toHaveLength(2);
    const second = recoveries[1]!;
    const secondAttemptId = 'host-owner-recovery-aba-second';
    const cancelSecondAttempt = vi.fn((reasonCode = 'cancelled-by-host') => {
      void second.options.participant.cancel({
        kind: 'file-playback-cancel',
        ...current.state,
        rendezvousId: secondAttemptId,
        reasonCode,
      });
      return {} as ReturnType<HostRendezvousAttempt['cancel']>;
    });
    const secondAttempt = {
      ...fakeAttempt(secondAttemptId),
      cancel: cancelSecondAttempt,
    } as HostRendezvousAttempt;
    const secondEvidence = second.options.bindAttempt(secondAttempt);
    const secondEvidenceFailure = expect(secondEvidence).rejects.toThrow(
      'Guest renderer start evidence failed: start-evidence-timeout',
    );
    void secondEvidence.catch(second.reject);

    await drain(64);
    expect(closeConnection).not.toHaveBeenCalled();

    const secondArm = second.options.participant.arm({
      protocolVersion: 2,
      kind: 'rendezvous-arm',
      ...current.state,
      rendezvousId: secondAttempt.rendezvousId,
      recipientId: second.options.participant.participantId,
      positionSeconds: 5,
      playbackRate: 1,
      startAtRoomTimeMs: 2_500,
      finalizeByRoomTimeMs: 2_400,
    });
    await drain();
    expect(wire.at(-1)).toMatchObject({
      kind: 'rendezvous-arm',
      rendezvousId: secondAttempt.rendezvousId,
    });
    expect(
      wire.findIndex(
        (message) =>
          message.kind === 'file-playback-cancel' &&
          message.rendezvousId === firstAttempt.rendezvousId,
      ),
    ).toBeLessThan(
      wire.findIndex(
        (message) =>
          message.kind === 'rendezvous-arm' && message.rendezvousId === secondAttempt.rendezvousId,
      ),
    );
    const secondArmWire = wire.at(-1);
    if (secondArmWire?.kind !== 'rendezvous-arm') {
      throw new Error('renderer failure recovery ARM unavailable');
    }
    const secondGuestAttempt = pair.guest.stageAttempt(guestState, secondArmWire.rendezvousId);
    now = 2_000;
    adoptWire(
      pair,
      owner,
      pair.guest.createWire(secondGuestAttempt, {
        kind: 'rendezvous-armed',
        rendezvousId: secondArmWire.rendezvousId,
        status: 'armed',
        observedAtRoomTimeMs: now,
        bufferedAheadSeconds: 8,
        reasonCode: null,
      }),
    );
    await expect(secondArm).resolves.toMatchObject({ status: 'armed' });
    const secondFinalize = second.options.participant.finalize({
      protocolVersion: 2,
      kind: 'rendezvous-finalize',
      ...current.state,
      rendezvousId: secondAttempt.rendezvousId,
      recipientId: second.options.participant.participantId,
      startAtRoomTimeMs: 2_500,
      finalizedAtRoomTimeMs: now,
    });
    await drain();
    const secondFinalizeWire = wire.at(-1);
    if (secondFinalizeWire?.kind !== 'rendezvous-finalize') {
      throw new Error('renderer failure recovery FINALIZE unavailable');
    }
    adoptWire(
      pair,
      owner,
      pair.guest.createWire(secondGuestAttempt, {
        kind: 'rendezvous-finalized',
        rendezvousId: secondFinalizeWire.rendezvousId,
        status: 'accepted',
        observedAtRoomTimeMs: now,
        reasonCode: null,
      }),
    );
    await expect(secondFinalize).resolves.toMatchObject({ status: 'accepted' });
    now = 2_500;
    adoptWire(
      pair,
      owner,
      pair.guest.createWire(secondGuestAttempt, {
        kind: 'renderer-health',
        rendezvousId: secondFinalizeWire.rendezvousId,
        value: 'unhealthy',
        observedAtRoomTimeMs: now,
        leaseUntilRoomTimeMs: now,
        renderedFrame: 0,
        underrunCount: 0,
        reasonCode: 'start-evidence-timeout',
      }),
    );
    await secondEvidenceFailure;
    await drain(64);

    expect(cancelSecondAttempt).toHaveBeenCalledOnce();
    expect(cancelSecondAttempt).toHaveBeenCalledWith('renderer-start-failed');
    expect(
      wire.filter(
        (message) =>
          message.kind === 'file-playback-cancel' &&
          message.rendezvousId === secondAttempt.rendezvousId,
      ),
    ).toHaveLength(1);
    expect(closeConnection).not.toHaveBeenCalled();

    publishFreshReady();
    await drain(64);
    expect(recoveries).toHaveLength(3);
    await drain();
    expect(closeConnection).not.toHaveBeenCalled();
    owner.port().revoke(pair.context);
  });

  it.each(['reject-before-ready', 'ready-before-reject', 'live-failure'] as const)(
    'handles a pending-timeline recovery %s without weakening live failures',
    async (ordering) => {
      let now = 1_000;
      const pair = connectionPair(() => now);
      const prepared = preparedTrack('bounded-stream', 4);
      let current: Readonly<HostPeerPlaybackPublication> | null = null;
      const recoveries: Array<{
        readonly options: RecoverHostRemoteParticipantOptions;
        readonly reject: (reason: Error) => void;
      }> = [];
      const recoverRemoteParticipant = vi.fn((options: RecoverHostRemoteParticipantOptions) => {
        let rejectRecovery!: (reason: Error) => void;
        const task = new Promise<Readonly<HostRemoteRecoveryCommit>>((_resolve, reject) => {
          rejectRecovery = reject;
        });
        recoveries.push({ options, reject: rejectRecovery });
        return task;
      });
      const wire: FilePlaybackWireMessage[] = [];
      const required: unknown[] = [];
      const closeConnection = vi.fn();
      const owner = new FilePlaybackProductHostMediaOwner({
        context: pair.context,
        hostRoom: {
          currentPeerPublication: () => current,
          resolveCurrentPeerRangeSource: vi.fn(async () => new Blob()),
          recoverRemoteParticipant,
        },
        publisher: publisher(),
        resolvePreparedPeerRangeSource: vi.fn(async () => encodedPreparedSource(prepared)),
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
          scheduleIntervalForTests: () => `host-owner-pending-recovery-${ordering}`,
          cancelIntervalForTests: vi.fn(),
        },
      });

      await owner.publishPrepared(prepared);
      await owner.bindPrepared(prepared);
      const ready = owner.whenPreparedRemoteReady(prepared);
      pair.guest.bootstrapStopped(0);
      const guestState = pair.guest.stageMedia({
        run: prepared.state,
        sourceIdentity: prepared.asset.binding.sourceIdentity,
        transferSessionId: prepared.asset.binding.transferSessionId,
      });
      const publishFreshReady = () => {
        now += 100;
        adoptWire(
          pair,
          owner,
          pair.guest.createWire(guestState, {
            kind: 'source-ready',
            observedAtRoomTimeMs: now,
            readyLeaseUntilRoomTimeMs: now + 10_000,
            backend: prepared.backend,
            durationSeconds: 180,
            bufferedAheadSeconds: 8,
            outputSampleRateHz: 48_000,
            channelCount: 2,
          }),
        );
      };
      publishFreshReady();
      await ready;
      const timeline = committedTimeline();
      current = committedPreparedPublication(prepared, timeline);
      owner.activatePrepared({
        prepared,
        timeline,
        initialCohortAdmitted: false,
      });
      await drain(64);
      expect(recoveries).toHaveLength(1);

      const first = recoveries[0]!;
      const firstAttempt = fakeAttempt(`host-owner-pending-recovery-first-${ordering}`);
      const firstEvidence = first.options.bindAttempt(firstAttempt);
      void firstEvidence.catch(() => undefined);

      if (ordering === 'live-failure') {
        first.reject(new Error('fixture live pending recovery failed'));
        await drain(64);
        expect(closeConnection).toHaveBeenCalledOnce();
        return;
      }

      const firstArm = first.options.participant.arm({
        protocolVersion: 2,
        kind: 'rendezvous-arm',
        ...prepared.state,
        rendezvousId: firstAttempt.rendezvousId,
        recipientId: first.options.participant.participantId,
        positionSeconds: 4,
        playbackRate: 1,
        startAtRoomTimeMs: 2_000,
        finalizeByRoomTimeMs: 1_900,
      });
      await drain();
      await first.options.participant.cancel({
        kind: 'file-playback-cancel',
        ...prepared.state,
        rendezvousId: firstAttempt.rendezvousId,
        reasonCode: 'fixture-pending-recovery-retry',
      });
      await drain();
      await expect(firstArm).resolves.toMatchObject({ status: 'rejected' });
      expect(wire.at(-1)).toMatchObject({
        kind: 'file-playback-cancel',
        rendezvousId: firstAttempt.rendezvousId,
      });

      if (ordering === 'reject-before-ready') {
        first.reject(new Error('fixture cancelled recovery rejected before readiness'));
        await drain(64);
        expect(recoveries).toHaveLength(1);
        expect(closeConnection).not.toHaveBeenCalled();
        publishFreshReady();
        await drain(64);
      } else {
        publishFreshReady();
        await drain(64);
        expect(recoveries).toHaveLength(2);
        first.reject(new Error('fixture cancelled recovery rejected after readiness'));
        await drain(64);
      }

      expect(recoveries).toHaveLength(2);
      expect(closeConnection).not.toHaveBeenCalled();
      expect(
        required.some(
          (frame) => (frame as { type?: string }).type === 'FILE_PLAYBACK_TIMELINE_UPDATE_V2',
        ),
      ).toBe(false);

      const second = recoveries[1]!;
      const secondAttempt = fakeAttempt(`host-owner-pending-recovery-second-${ordering}`);
      const secondEvidence = second.options.bindAttempt(secondAttempt);
      void secondEvidence.catch(() => undefined);
      const secondArm = second.options.participant.arm({
        protocolVersion: 2,
        kind: 'rendezvous-arm',
        ...prepared.state,
        rendezvousId: secondAttempt.rendezvousId,
        recipientId: second.options.participant.participantId,
        positionSeconds: 5,
        playbackRate: 1,
        startAtRoomTimeMs: 2_500,
        finalizeByRoomTimeMs: 2_400,
      });
      await drain();
      expect(wire.at(-1)).toMatchObject({
        kind: 'rendezvous-arm',
        rendezvousId: secondAttempt.rendezvousId,
      });
      await second.options.participant.cancel({
        kind: 'file-playback-cancel',
        ...prepared.state,
        rendezvousId: secondAttempt.rendezvousId,
        reasonCode: 'fixture-cleanup',
      });
      await expect(secondArm).resolves.toMatchObject({ status: 'rejected' });
      second.reject(new Error('fixture current pending recovery cleanup'));
      await drain();
      expect(closeConnection).not.toHaveBeenCalled();
      owner.port().revoke(pair.context);
    },
  );

  it.each(['null', 'throw'] as const)(
    'fails closed when queued recovery rejection races a CANCEL send returning %s',
    async (failureMode) => {
      let now = 1_000;
      const pair = connectionPair(() => now);
      const prepared = preparedTrack('bounded-stream', 4);
      let current: Readonly<HostPeerPlaybackPublication> | null = null;
      const recoveries: RecoverHostRemoteParticipantOptions[] = [];
      let rejectRecovery!: (reason: Error) => void;
      const recoverRemoteParticipant = vi.fn((options: RecoverHostRemoteParticipantOptions) => {
        recoveries.push(options);
        return new Promise<Readonly<HostRemoteRecoveryCommit>>((_resolve, reject) => {
          rejectRecovery = reject;
        });
      });
      const required: unknown[] = [];
      const wire: FilePlaybackWireMessage[] = [];
      const closeConnection = vi.fn();
      const sendWireCalls = vi.fn();
      const sendWire: FilePlaybackProductHostMediaOwnerOptions['sendWire'] = (
        connection,
        lease,
        payload,
      ) => {
        sendWireCalls(connection, lease, payload);
        const message = pair.host.createWire(lease, payload);
        if (payload.kind === 'file-playback-cancel') {
          if (failureMode === 'throw') throw new Error('fixture CANCEL transport threw');
          return null;
        }
        wire.push(message);
        return message;
      };
      const owner = new FilePlaybackProductHostMediaOwner({
        context: pair.context,
        hostRoom: {
          currentPeerPublication: () => current,
          resolveCurrentPeerRangeSource: vi.fn(async () => new Blob()),
          recoverRemoteParticipant,
        },
        publisher: publisher(),
        resolvePreparedPeerRangeSource: vi.fn(async () => encodedPreparedSource(prepared)),
        sendRequired: (_connection, frame) => {
          required.push(frame);
          return true;
        },
        sendWire,
        closeConnection,
        onHealthSystemMessage: vi.fn(),
        runtimeForTests: {
          createMediaIdForTests: ids(),
          scheduleIntervalForTests: () => `host-owner-cancel-send-${failureMode}`,
          cancelIntervalForTests: vi.fn(),
        },
      });

      await owner.publishPrepared(prepared);
      await owner.bindPrepared(prepared);
      const ready = owner.whenPreparedRemoteReady(prepared);
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
          readyLeaseUntilRoomTimeMs: now + 10_000,
          backend: prepared.backend,
          durationSeconds: 180,
          bufferedAheadSeconds: 8,
          outputSampleRateHz: 48_000,
          channelCount: 2,
        }),
      );
      await ready;

      const timeline = committedTimeline();
      current = committedPreparedPublication(prepared, timeline);
      owner.activatePrepared({
        prepared,
        timeline,
        initialCohortAdmitted: false,
      });
      await drain(64);
      expect(recoveries).toHaveLength(1);

      const recovery = recoveries[0]!;
      const attempt = fakeAttempt(`host-owner-cancel-send-${failureMode}`);
      const evidence = recovery.bindAttempt(attempt);
      void evidence.catch(() => undefined);
      const armTask = recovery.participant.arm({
        protocolVersion: 2,
        kind: 'rendezvous-arm',
        ...prepared.state,
        rendezvousId: attempt.rendezvousId,
        recipientId: recovery.participant.participantId,
        positionSeconds: 4,
        playbackRate: 1,
        startAtRoomTimeMs: 2_000,
        finalizeByRoomTimeMs: 1_900,
      });
      await drain();
      expect(wire.at(-1)).toMatchObject({
        kind: 'rendezvous-arm',
        rendezvousId: attempt.rendezvousId,
      });

      rejectRecovery(new Error('fixture recovery rejection was already queued'));
      await recovery.participant.cancel({
        kind: 'file-playback-cancel',
        ...prepared.state,
        rendezvousId: attempt.rendezvousId,
        reasonCode: 'fixture-cancel-send-failure',
      });
      await drain(64);

      await expect(armTask).resolves.toMatchObject({ status: 'rejected' });
      expect(
        sendWireCalls.mock.calls.filter(([, , payload]) => payload.kind === 'file-playback-cancel'),
      ).toHaveLength(1);
      expect(closeConnection).toHaveBeenCalledOnce();
      expect(recoveries).toHaveLength(1);
      expect(
        required.filter(
          (frame) => (frame as { type?: string }).type === 'FILE_PLAYBACK_TIMELINE_UPDATE_V2',
        ),
      ).toHaveLength(0);
    },
  );

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

  it('reuses the exact current offer and handle for a same-run rendezvous seek', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/flac' });
    let current: Readonly<HostPeerPlaybackPublication> | null = publication('bounded-stream', blob);
    const prepared = freezeCanonical({
      ...preparedTrack(
        'bounded-stream',
        blob.size,
        freezeCanonical({ queueItemId: QID, runId: RUN_ID, revision: 2 }),
      ),
      positionSeconds: 12,
    });
    const required: unknown[] = [];
    const wire: FilePlaybackWireMessage[] = [];
    const recoveries: RecoverHostRemoteParticipantOptions[] = [];
    const resolvePrepared = vi.fn(async () => {
      throw new Error('same-run seek must not reacquire its source');
    });
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => current,
        () => blob,
        recoveries,
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
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-same-run-seek-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    const baseline = await owner.publishCurrent();
    pair.guest.bootstrapCurrentMedia({
      run: baseline.publication.state,
      sourceIdentity: baseline.publication.asset.binding.sourceIdentity,
      transferSessionId: baseline.publication.asset.binding.transferSessionId,
    });
    const beforeCandidate = [...required];
    const candidate = await owner.publishPrepared(prepared);
    expect(candidate.offer).toBe(baseline.offer);
    expect(candidate.binding).toBe(baseline.binding);
    expect(required).toEqual(beforeCandidate);
    expect(resolvePrepared).not.toHaveBeenCalled();

    await owner.bindPrepared(prepared);
    const prepare = wire.at(-1);
    if (prepare?.kind !== 'file-playback-prepare') {
      throw new Error('same-run PREPARE unavailable');
    }
    const receivedPrepare = receiveHostWireAtGuest(pair, prepare);
    expect(receivedPrepare.attemptLease).toBeNull();
    adoptWire(
      pair,
      owner,
      pair.guest.createWire(receivedPrepare.stateLease, {
        kind: 'source-ready',
        observedAtRoomTimeMs: 1_000,
        readyLeaseUntilRoomTimeMs: 10_000,
        backend: prepared.backend,
        durationSeconds: 180,
        bufferedAheadSeconds: 8,
        outputSampleRateHz: 48_000,
        channelCount: 2,
      }),
    );
    const capability = await owner.whenPreparedRemoteReady(prepared);
    expect(capability.participant.participantId).toBe(pair.context.guestParticipantId);
    expect(required).toEqual(beforeCandidate);

    const timeline = freezeCanonical({
      schemaVersion: 1 as const,
      revision: 2,
      phase: 'playing' as const,
      run: freezeCanonical({ queueItemId: QID, runId: RUN_ID }),
      positionSeconds: 12,
      anchorMonotonicMs: 2_000,
      rate: 1,
    });
    current = committedPreparedPublication(prepared, timeline);
    const activated = owner.activatePrepared({
      prepared,
      timeline,
      initialCohortAdmitted: false,
    });

    expect(activated.offer).toBe(baseline.offer);
    expect(activated.binding).toBe(baseline.binding);
    expect(resolvePrepared).not.toHaveBeenCalled();
    expect(
      required.filter(
        (frame) => (frame as { type?: string }).type === 'FILE_MEDIA_SOURCE_OFFER_V2',
      ),
    ).toHaveLength(1);
    expect(
      required.filter(
        (frame) => (frame as { type?: string }).type === 'FILE_PLAYBACK_RUN_BINDING_V2',
      ),
    ).toHaveLength(1);
    expect(
      required.some(
        (frame) => (frame as { type?: string }).type === 'FILE_PLAYBACK_TIMELINE_UPDATE_V2',
      ),
    ).toBe(false);
    await drain();
    expect(recoveries).toHaveLength(1);
    expect(wire.some((message) => message.kind === 'file-playback-prepare')).toBe(true);
    expect(wire.at(-1)).toMatchObject({ kind: 'rendezvous-arm', revision: 2 });
    expect(await owner.publishCurrent()).toBe(activated);
    owner.port().revoke(pair.context);
  });

  it('rejects a pre-seek recovery that binds after same-run state promotion', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/flac' });
    let current: Readonly<HostPeerPlaybackPublication> | null = publication('bounded-stream', blob);
    const prepared = preparedTrack(
      'bounded-stream',
      blob.size,
      freezeCanonical({ queueItemId: QID, runId: RUN_ID, revision: 2 }),
    );
    let recoveryOptions: RecoverHostRemoteParticipantOptions | null = null;
    let rejectRecovery!: (reason: Error) => void;
    const recoveryTask = new Promise<Readonly<HostRemoteRecoveryCommit>>((_resolve, reject) => {
      rejectRecovery = reject;
    });
    const recoverRemoteParticipant = vi.fn((options: RecoverHostRemoteParticipantOptions) => {
      recoveryOptions = options;
      return recoveryTask;
    });
    const sendWireCalls = vi.fn();
    const sentWireMessages: FilePlaybackWireMessage[] = [];
    const sendWire: FilePlaybackProductHostMediaOwnerOptions['sendWire'] = (
      connection,
      lease,
      payload,
    ) => {
      sendWireCalls(connection, lease, payload);
      const message = pair.host.createWire(lease, payload);
      sentWireMessages.push(message);
      return message;
    };
    const closeConnection = vi.fn();
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: {
        currentPeerPublication: () => current,
        resolveCurrentPeerRangeSource: vi.fn(async () => blob),
        recoverRemoteParticipant,
      },
      publisher: publisher(),
      resolvePreparedPeerRangeSource: vi.fn(async () => {
        throw new Error('same-run seek must not reacquire its source');
      }),
      sendRequired: vi.fn(() => true),
      sendWire,
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-stale-recovery-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    await owner.publishCurrent();
    const guestCurrent = pair.guest.bootstrapCurrentMedia({
      run: current.state,
      sourceIdentity: current.asset.binding.sourceIdentity,
      transferSessionId: current.asset.binding.transferSessionId,
    });
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
    const staleRecovery = recoveryOptions as RecoverHostRemoteParticipantOptions | null;
    if (!staleRecovery) throw new Error('fixture recovery was not started');

    await owner.publishPrepared(prepared);
    await owner.bindPrepared(prepared);
    const timeline = freezeCanonical({ ...committedTimeline(), revision: 2 });
    current = committedPreparedPublication(prepared, timeline);
    const activated = owner.activatePrepared({
      prepared,
      timeline,
      initialCohortAdmitted: false,
    });

    await expect(
      staleRecovery.bindAttempt(fakeAttempt('host-owner-stale-recovery')),
    ).rejects.toThrow(/stale/u);
    expect(sendWireCalls).toHaveBeenCalledOnce();
    expect(sentWireMessages[0]).toMatchObject({ kind: 'file-playback-prepare' });
    expect(closeConnection).not.toHaveBeenCalled();
    expect(await owner.publishCurrent()).toBe(activated);

    rejectRecovery(new Error('fixture stale recovery retired'));
    await drain();
    expect(closeConnection).not.toHaveBeenCalled();
    owner.port().revoke(pair.context);
  });

  it('commits a prepared state without waiting for a slow remote SOURCE_READY', async () => {
    let now = 1_000;
    const pair = connectionPair(() => now);
    const prepared = preparedTrack('bounded-stream', 3);
    const required: unknown[] = [];
    const wire: FilePlaybackWireMessage[] = [];
    const recoveries: RecoverHostRemoteParticipantOptions[] = [];
    const closeConnection = vi.fn();
    let current: Readonly<HostPeerPlaybackPublication> | null = null;
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => current,
        () => new Blob(),
        recoveries,
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
      sendWire: (_connection, lease, payload) => {
        const message = pair.host.createWire(lease, payload);
        wire.push(message);
        return message;
      },
      closeConnection,
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
    const activated = owner.activatePrepared({
      prepared,
      timeline,
      initialCohortAdmitted: false,
    });
    expect(activated.publication.state).toBe(prepared.state);
    await expect(readiness).rejects.toThrow(/committed before/u);
    expect(
      required.some(
        (frame) => (frame as { type?: string }).type === 'FILE_PLAYBACK_TIMELINE_UPDATE_V2',
      ),
    ).toBe(false);

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
        observedAtRoomTimeMs: 1_000,
        readyLeaseUntilRoomTimeMs: 10_000,
        backend: prepared.backend,
        durationSeconds: 180,
        bufferedAheadSeconds: 8,
        outputSampleRateHz: 48_000,
        channelCount: 2,
      }),
    );
    await drain();
    expect(recoveries).toHaveLength(1);
    const arm = wire.at(-1);
    if (arm?.kind !== 'rendezvous-arm') throw new Error('late recovery ARM unavailable');
    const guestAttempt = pair.guest.stageAttempt(guestState, arm.rendezvousId);
    adoptWire(
      pair,
      owner,
      pair.guest.createWire(guestAttempt, {
        kind: 'rendezvous-armed',
        rendezvousId: arm.rendezvousId,
        status: 'armed',
        observedAtRoomTimeMs: 1_000,
        bufferedAheadSeconds: 8,
        reasonCode: null,
      }),
    );
    await drain();
    const finalize = wire.at(-1);
    if (finalize?.kind !== 'rendezvous-finalize') {
      throw new Error('late recovery FINALIZE unavailable');
    }
    adoptWire(
      pair,
      owner,
      pair.guest.createWire(guestAttempt, {
        kind: 'rendezvous-finalized',
        rendezvousId: finalize.rendezvousId,
        status: 'accepted',
        observedAtRoomTimeMs: 1_000,
        reasonCode: null,
      }),
    );
    await drain();
    pair.guest.commitAttempt(guestAttempt);
    pair.guest.commitMedia(guestState);
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
        renderedFrame: 48_000,
        underrunCount: 0,
        reasonCode: null,
      }),
    );
    await drain(64);
    expect(required.at(-1)).toMatchObject({
      type: 'FILE_PLAYBACK_TIMELINE_UPDATE_V2',
      revision: prepared.state.revision,
    });
    expect(closeConnection).not.toHaveBeenCalled();
    owner.port().revoke(pair.context);
  });

  it('fails closed instead of replacing a publication with a pending peer timeline', async () => {
    const pair = connectionPair(() => 1_000);
    const prepared = preparedTrack('bounded-stream', 3);
    const closeConnection = vi.fn();
    let current: Readonly<HostPeerPlaybackPublication> | null = null;
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => current,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: vi.fn(async () => encodedPreparedSource(prepared)),
      sendRequired: () => true,
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        nowEpochMsForTests: () => 1_000,
        scheduleIntervalForTests: () => 'host-owner-pending-timeline-health',
        cancelIntervalForTests: vi.fn(),
      },
    });
    await owner.publishPrepared(prepared);
    await owner.bindPrepared(prepared);
    const readiness = owner.whenPreparedRemoteReady(prepared);
    const timeline = committedTimeline();
    current = committedPreparedPublication(prepared, timeline);
    const activated = owner.activatePrepared({
      prepared,
      timeline,
      initialCohortAdmitted: false,
    });
    await expect(readiness).rejects.toThrow(/committed before/u);
    await expect(owner.publishCurrent()).resolves.toBe(activated);

    current = publication('bounded-stream', new Blob([new Uint8Array([1, 2, 3])]));
    await expect(owner.publishCurrent()).rejects.toThrow(/connection failed/u);
    expect(closeConnection).toHaveBeenCalledOnce();
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
    await expect(pending).rejects.toThrow(/stale|closed|revoked/u);
    resolveSource(encodedPreparedSource(prepared, closeSource));
    await drain();
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
    await expect(pending).rejects.toThrow(/retired|stale|superseded/u);
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
    const staleAcknowledge = vi.fn();
    expect(() => owner.port().adoptPeerRangeControl(staleRead, staleAcknowledge)).not.toThrow();
    expect(staleAcknowledge).toHaveBeenCalledOnce();
    expect(resolvePrepared).toHaveBeenCalledOnce();
    const wrongSourceAcknowledge = vi.fn();
    expect(() =>
      owner.port().adoptPeerRangeControl(
        freezeCanonical({
          ...staleRead,
          frame: createPeerRangeReadFrame({
            ...staleRead.frame,
            sourceIdentity: 'sha256:wrong-retired-source',
            requestId: '98000000-0000-4000-8000-000000000078',
          }),
        }),
        wrongSourceAcknowledge,
      ),
    ).toThrow(/current publication/u);
    expect(wrongSourceAcknowledge).not.toHaveBeenCalled();
    const unknownHandleAcknowledge = vi.fn();
    expect(() =>
      owner.port().adoptPeerRangeControl(
        freezeCanonical({
          ...staleRead,
          frame: createPeerRangeReadFrame({
            ...staleRead.frame,
            handleId: 'unknown-retired-handle',
            requestId: '98000000-0000-4000-8000-000000000077',
          }),
        }),
        unknownHandleAcknowledge,
      ),
    ).toThrow(/current publication/u);
    expect(unknownHandleAcknowledge).not.toHaveBeenCalled();
    expect(resolvePrepared).toHaveBeenCalledOnce();
    expect(closeConnection).not.toHaveBeenCalled();
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

  it('detaches retirement from an uncancellable shared R2 publish and safely reuses it', async () => {
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
    await expect(pending).rejects.toThrow(/cancel R2 candidate|aborted|stale/u);
    await expect(retirement).resolves.toBeUndefined();
    expect(closeConnection).not.toHaveBeenCalled();
    expect(sendRequired).not.toHaveBeenCalled();

    const replacement = owner.publishPrepared(second);
    await drain(16);
    expect(upload).toHaveBeenCalledOnce();
    resolveUpload({
      objectId: '98000000-0000-4000-8000-000000000099',
      expiresAt: 61_000,
      cleanupToken: 'cleanup-token',
    });
    await expect(replacement).resolves.toMatchObject({ prepared: second });
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
    owner.activatePrepared({ prepared, timeline, initialCohortAdmitted: false });
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
      peerRangeManifest: null,
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

  it('publishes peer OFFER, completes SOURCE_READY recovery, and keeps paused health local', async () => {
    let now = 1_000;
    const pair = connectionPair(() => now);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/flac' });
    let current: Readonly<HostPeerPlaybackPublication> = publication('bounded-stream', blob);
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
    expect(recoveries).toHaveLength(1);

    const playing = current;
    const paused = sameSourceSuccessorPublication(playing, 2, 'paused', 3, 2_200);
    now = 2_200;
    owner.stageCurrentTransition(
      freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: 1,
        kind: 'pause' as const,
        from: playing.state,
        to: paused.state,
        atRoomTimeMs: now,
        positionSeconds: null,
      }),
    );
    current = paused;
    owner.commitCurrentTimeline(
      freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: 1,
        kind: 'pause' as const,
        previous: playing.timeline,
        timeline: paused.timeline,
      }),
    );

    now = 12_000;
    healthTick();
    await drain();
    expect(recoveries).toHaveLength(1);
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
    expect(room.resolveCurrentPeerRangeSource).toHaveBeenCalledWith({
      publication: current,
      sourceIdentity: current.asset.binding.sourceIdentity,
      peerRangeManifest: null,
      signal: expect.any(AbortSignal),
    });
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

  it('routes a bounded remote publication through one shared authenticated R2 record set', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([new Uint8Array([7, 8, 9])], { type: 'audio/flac' });
    const current = publication('bounded-stream', blob);
    const room = roomPort(
      () => current,
      () => blob,
      [],
    );
    const r2 = publisher();
    const setId = '88000000-0000-4000-8000-000000000001';
    const recordObjectId = '89000000-0000-4000-8000-000000000001';
    const publishRecordSet = vi.spyOn(r2, 'publishRecordSet').mockResolvedValue(
      freezeCanonical({
        schemaVersion: 1 as const,
        queueItemId: current.state.queueItemId,
        sourceIdentity: current.asset.binding.sourceIdentity,
        transferSessionId: current.asset.binding.transferSessionId,
        applicationSessionId: pair.context.sessionId,
        storageRoomId: '123456',
        setId,
        encodedSize: blob.size,
        recordSize: 8 * 1024 * 1024,
        recordCount: 1,
        cryptoSecretDescriptor: freezeCanonical({
          formatVersion: 2 as const,
          objectId: setId,
          plaintextSize: blob.size,
          recordSize: 8 * 1024 * 1024,
          recordCount: 1,
          noncePrefixB64: btoa('\0'.repeat(8)),
          keyB64: btoa('\0'.repeat(32)),
        }),
        records: Object.freeze([
          freezeCanonical({
            index: 0,
            objectId: recordObjectId,
            plaintextSize: blob.size,
            encryptedSize: blob.size + 16,
          }),
        ]),
        name: current.asset.metadata.name,
        mime: current.asset.metadata.mime,
        expiresAtEpochMs: 61_000,
      }),
    );
    const required: unknown[] = [];
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: room,
      publisher: r2,
      selectBoundedTransport: () => 'r2-records',
      resolveR2StorageRoomId: () => '123456',
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
        scheduleIntervalForTests: () => 'host-owner-r2-record-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    const committed = await owner.publishCurrent();

    expect(publishRecordSet).toHaveBeenCalledWith(
      {
        queueItemId: current.state.queueItemId,
        sourceIdentity: current.asset.binding.sourceIdentity,
        transferSessionId: current.asset.binding.transferSessionId,
        blob,
        name: current.asset.metadata.name,
        mime: current.asset.metadata.mime,
      },
      {
        storageRoomId: '123456',
        applicationSessionId: pair.context.sessionId,
      },
    );
    expect(room.resolveCurrentPeerRangeSource).toHaveBeenCalledWith({
      publication: current,
      sourceIdentity: current.asset.binding.sourceIdentity,
      peerRangeManifest: null,
      signal: expect.any(AbortSignal),
    });
    expect(committed.offer).toMatchObject({
      transport: 'r2-records',
      encryption: 'aes-256-gcm-record-v2',
      storageRoomId: '123456',
      setId,
      recordCount: 1,
      recordObjectIds: recordObjectId,
      expiresAtRoomTimeMs: 61_000,
    });
    expect(required[0]).toBe(committed.offer);
    expect(required[1]).toBe(committed.binding);
    owner.port().revoke(pair.context);
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

  it('settles a queued rejoin on pause so a later degradation forms a new episode', async () => {
    let now = 1_000;
    const pair = connectionPair(() => now);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/flac' });
    let current: Readonly<HostPeerPlaybackPublication> = publication('bounded-stream', blob);
    const recoveries: RecoverHostRemoteParticipantOptions[] = [];
    const messages = vi.fn();
    const closeConnection = vi.fn();
    let healthTick = (): void => undefined;
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: {
        currentPeerPublication: () => current,
        resolveCurrentPeerRangeSource: vi.fn(async () => blob),
        recoverRemoteParticipant: vi.fn((options: RecoverHostRemoteParticipantOptions) => {
          recoveries.push(options);
          return new Promise<Readonly<HostRemoteRecoveryCommit>>(() => undefined);
        }),
      },
      publisher: publisher(),
      sendRequired: () => true,
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection,
      onHealthSystemMessage: messages,
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: (callback) => {
          healthTick = callback;
          return 'host-owner-paused-rejoin-health';
        },
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
        observedAtRoomTimeMs: now,
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

    now = 3_000;
    healthTick();
    now = 4_500;
    healthTick();
    expect(messages).toHaveBeenCalledOnce();

    const playing = current;
    const paused = sameSourceSuccessorPublication(playing, 2, 'paused', 3, now);
    owner.stageCurrentTransition(
      freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: 1,
        kind: 'pause' as const,
        from: playing.state,
        to: paused.state,
        atRoomTimeMs: now,
        positionSeconds: null,
      }),
    );
    current = paused;
    owner.commitCurrentTimeline(
      freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: 1,
        kind: 'pause' as const,
        previous: playing.timeline,
        timeline: paused.timeline,
      }),
    );
    await drain();
    expect(recoveries).toHaveLength(1);

    now = 4_501;
    healthTick();
    pair.connection.open = false;
    now = 4_502;
    healthTick();
    now = 6_002;
    healthTick();
    expect(messages).toHaveBeenCalledTimes(2);
    await drain();
    expect(recoveries).toHaveLength(1);

    pair.connection.open = true;
    now = 6_003;
    healthTick();
    expect(closeConnection).not.toHaveBeenCalled();
    owner.port().revoke(pair.context);
  });

  it('settles a queued rejoin after stop so a later degradation forms a new episode', async () => {
    let now = 1_000;
    const pair = connectionPair(() => now);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/flac' });
    let current: Readonly<HostPeerPlaybackPublication> | null = publication('bounded-stream', blob);
    const recoveries: RecoverHostRemoteParticipantOptions[] = [];
    const messages = vi.fn();
    const closeConnection = vi.fn();
    let healthTick = (): void => undefined;
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: {
        currentPeerPublication: () => current,
        resolveCurrentPeerRangeSource: vi.fn(async () => blob),
        recoverRemoteParticipant: vi.fn((options: RecoverHostRemoteParticipantOptions) => {
          recoveries.push(options);
          return new Promise<Readonly<HostRemoteRecoveryCommit>>(() => undefined);
        }),
      },
      publisher: publisher(),
      sendRequired: () => true,
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection,
      onHealthSystemMessage: messages,
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: (callback) => {
          healthTick = callback;
          return 'host-owner-stopped-rejoin-health';
        },
        cancelIntervalForTests: vi.fn(),
      },
    });

    await owner.publishCurrent();
    const playing = current;
    if (!playing) throw new Error('fixture playing publication unavailable');
    const guestState = pair.guest.bootstrapCurrentMedia({
      run: playing.state,
      sourceIdentity: playing.asset.binding.sourceIdentity,
      transferSessionId: playing.asset.binding.transferSessionId,
    });
    adoptWire(
      pair,
      owner,
      pair.guest.createWire(guestState, {
        kind: 'source-ready',
        observedAtRoomTimeMs: now,
        readyLeaseUntilRoomTimeMs: 10_000,
        backend: playing.backend,
        durationSeconds: 180,
        bufferedAheadSeconds: 8,
        outputSampleRateHz: 48_000,
        channelCount: 2,
      }),
    );
    await drain();
    expect(recoveries).toHaveLength(1);

    now = 3_000;
    healthTick();
    now = 4_500;
    healthTick();
    expect(messages).toHaveBeenCalledOnce();

    const stoppedState = freezeCanonical({ ...playing.state, revision: 2 });
    const stoppedTimeline = freezeCanonical({
      schemaVersion: 1 as const,
      revision: stoppedState.revision,
      phase: 'stopped' as const,
      run: null,
      positionSeconds: 0,
      anchorMonotonicMs: now,
      rate: 1,
    });
    owner.stageCurrentTransition(
      freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: 1,
        kind: 'stop' as const,
        from: playing.state,
        to: stoppedState,
        atRoomTimeMs: now,
        positionSeconds: null,
      }),
    );
    current = null;
    owner.commitCurrentTimeline(
      freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: 1,
        kind: 'stop' as const,
        previous: playing.timeline,
        timeline: stoppedTimeline,
      }),
    );
    await drain();
    expect(recoveries).toHaveLength(1);

    now = 4_501;
    healthTick();
    pair.connection.open = false;
    now = 4_502;
    healthTick();
    now = 6_002;
    healthTick();
    expect(messages).toHaveBeenCalledTimes(2);
    await drain();
    expect(recoveries).toHaveLength(1);

    pair.connection.open = true;
    now = 6_003;
    healthTick();
    expect(closeConnection).not.toHaveBeenCalled();
    owner.port().revoke(pair.context);
  });

  it('recovers transient RTC disconnect health without closing the session', async () => {
    let now = 1_000;
    const pair = connectionPair(() => now);
    const peerConnection = { connectionState: 'connected' as RTCPeerConnectionState };
    Object.assign(pair.connection, { peerConnection });
    const blob = new Blob([new Uint8Array([1])], { type: 'audio/flac' });
    const current = publication('bounded-stream', blob);
    const messages = vi.fn();
    const closeConnection = vi.fn();
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
      closeConnection,
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

    peerConnection.connectionState = 'disconnected';
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

    peerConnection.connectionState = 'connected';
    now = 4_501;
    tick();
    expect(closeConnection).not.toHaveBeenCalled();

    peerConnection.connectionState = 'disconnected';
    now = 4_502;
    tick();
    now = 6_002;
    tick();
    expect(messages).toHaveBeenCalledTimes(2);
    expect(closeConnection).not.toHaveBeenCalled();
    owner.port().revoke(pair.context);
  });

  it('requests participant-only rejoin after transient RTC disconnect and returns healthy', async () => {
    let now = 1_000;
    const pair = connectionPair(() => now);
    const peerConnection = { connectionState: 'connected' as RTCPeerConnectionState };
    Object.assign(pair.connection, { peerConnection });
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/flac' });
    const current = publication('bounded-stream', blob);
    const recoveries: RecoverHostRemoteParticipantOptions[] = [];
    const wire: FilePlaybackWireMessage[] = [];
    const messages = vi.fn();
    const closeConnection = vi.fn();
    let healthTick = (): void => undefined;
    let recoverySequence = 0;
    const recoverRemoteParticipant = vi.fn(
      async (
        options: RecoverHostRemoteParticipantOptions,
      ): Promise<Readonly<HostRemoteRecoveryCommit>> => {
        recoveries.push(options);
        const scheduledAtRoomTimeMs = now;
        const startAtRoomTimeMs = scheduledAtRoomTimeMs + 1_000;
        const finalizeByRoomTimeMs = scheduledAtRoomTimeMs + 900;
        const rendezvousId = `host-owner-health-recovery-${++recoverySequence}`;
        const attempt = {
          ...fakeAttempt(rendezvousId),
          startAtRoomTimeMs,
          finalizeByRoomTimeMs,
        } as HostRendezvousAttempt;
        const evidence = options.bindAttempt(attempt);
        const arm = await options.participant.arm({
          protocolVersion: 2,
          kind: 'rendezvous-arm',
          ...options.publication.state,
          rendezvousId,
          recipientId: options.participant.participantId,
          positionSeconds: 4,
          playbackRate: 1,
          startAtRoomTimeMs,
          finalizeByRoomTimeMs,
        });
        if (arm.status !== 'armed') throw new Error('fixture ARM rejected');
        const finalizedAtRoomTimeMs = now;
        const finalized = await options.participant.finalize({
          protocolVersion: 2,
          kind: 'rendezvous-finalize',
          ...options.publication.state,
          rendezvousId,
          recipientId: options.participant.participantId,
          startAtRoomTimeMs,
          finalizedAtRoomTimeMs,
        });
        if (finalized.status !== 'accepted') throw new Error('fixture FINALIZE rejected');
        await evidence;
        if (!options.participant.commitAttempt?.({ ...options.publication.state, rendezvousId })) {
          throw new Error('fixture renderer evidence rejected');
        }
        return freezeCanonical({
          schemaVersion: 1 as const,
          roomGeneration: options.publication.roomGeneration,
          participantId: options.participant.participantId,
          publication: options.publication,
          attempt: freezeCanonical({ ...options.publication.state, rendezvousId }),
          schedule: freezeCanonical({
            positionSeconds: 4,
            playbackRate: 1,
            createdAtRoomTimeMs: scheduledAtRoomTimeMs,
            leadTimeMs: 1_000,
            finalizeByRoomTimeMs,
            startAtRoomTimeMs,
          }),
          timeline: options.publication.timeline,
        });
      },
    );
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: {
        currentPeerPublication: () => current,
        resolveCurrentPeerRangeSource: vi.fn(async () => blob),
        recoverRemoteParticipant,
      },
      publisher: publisher(),
      sendRequired: () => true,
      sendWire: (_connection, lease, payload) => {
        const message = pair.host.createWire(lease, payload);
        wire.push(message);
        return message;
      },
      closeConnection,
      onHealthSystemMessage: messages,
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: (callback) => {
          healthTick = callback;
          return 'host-owner-transient-rtc-health';
        },
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
        observedAtRoomTimeMs: now,
        readyLeaseUntilRoomTimeMs: now + 10_000,
        backend: current.backend,
        durationSeconds: 180,
        bufferedAheadSeconds: 8,
        outputSampleRateHz: 48_000,
        channelCount: 2,
      }),
    );

    const recalibrateGuestClock = (): void => {
      for (let sample = 0; sample < 5; sample += 1) {
        const ping = pair.guest.createClockPing();
        const pong = pair.host.receive(ping, pair.hostToken);
        if (!pong.accepted || pong.frame !== 'clock-ping') {
          throw new Error('health recovery clock ping failed');
        }
        const calibrated = pair.guest.receive(pong.pong, pair.guestToken);
        if (!calibrated.accepted || calibrated.frame !== 'clock-pong') {
          throw new Error('health recovery clock calibration failed');
        }
      }
    };
    const completeLatestRecovery = async (): Promise<void> => {
      await drain(64);
      const arm = wire.at(-1);
      if (arm?.kind !== 'rendezvous-arm') throw new Error('health recovery ARM unavailable');
      recalibrateGuestClock();
      const guestAttempt = pair.guest.stageAttempt(guestState, arm.rendezvousId);
      now += 100;
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
      await drain(64);
      const finalize = wire.at(-1);
      if (finalize?.kind !== 'rendezvous-finalize') {
        throw new Error('health recovery FINALIZE unavailable');
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
      await drain(64);
      pair.guest.commitAttempt(guestAttempt);
      now = Math.max(now + 100, arm.startAtRoomTimeMs);
      recalibrateGuestClock();
      adoptWire(
        pair,
        owner,
        pair.guest.createWire(guestAttempt, {
          kind: 'renderer-health',
          rendezvousId: finalize.rendezvousId,
          value: 'healthy',
          observedAtRoomTimeMs: now,
          leaseUntilRoomTimeMs: now + 10_000,
          renderedFrame: 96_000,
          underrunCount: 0,
          reasonCode: null,
        }),
      );
      await drain(64);
    };
    const rejectLatestRecovery = async (): Promise<void> => {
      await drain(64);
      const arm = wire.at(-1);
      const latest = recoveries.at(-1);
      if (arm?.kind !== 'rendezvous-arm' || !latest) {
        throw new Error('health recovery rejection target unavailable');
      }
      await latest.participant.cancel({
        kind: 'file-playback-cancel',
        ...current.state,
        rendezvousId: arm.rendezvousId,
        reasonCode: 'fixture-health-recovery-rejected',
      });
      await drain(64);
    };

    await drain(64);
    expect(recoveries).toHaveLength(1);

    peerConnection.connectionState = 'disconnected';
    now += 1;
    healthTick();
    now += 1_500;
    healthTick();
    await drain(64);
    expect(messages).toHaveBeenCalledOnce();
    // The initial candidate makes this first health-triggered recovery a
    // deliberate no-start. The monitor must leave REJOINING and re-arm.
    expect(recoveries).toHaveLength(1);
    expect(closeConnection).not.toHaveBeenCalled();
    expect(current.timeline.phase).toBe('playing');
    await rejectLatestRecovery();

    now += 1_499;
    healthTick();
    await drain(64);
    expect(recoveries).toHaveLength(1);
    now += 1;
    healthTick();
    await drain(64);
    expect(recoveries).toHaveLength(2);
    expect(messages).toHaveBeenCalledOnce();

    peerConnection.connectionState = 'connected';
    now += 1;
    healthTick();
    // Fresh transport/clock plus the still-leased renderer must not complete
    // REJOINING while this exact recovery authority is active.
    await rejectLatestRecovery();

    const rejectedAt = now;
    peerConnection.connectionState = 'disconnected';
    now = rejectedAt + 1;
    healthTick();
    now = rejectedAt + 1_499;
    healthTick();
    await drain(64);
    expect(recoveries).toHaveLength(2);
    now = rejectedAt + 1_500;
    healthTick();
    await drain(64);
    expect(recoveries).toHaveLength(3);
    expect(messages).toHaveBeenCalledOnce();

    peerConnection.connectionState = 'connected';
    now += 1;
    healthTick();
    await completeLatestRecovery();
    expect(closeConnection).not.toHaveBeenCalled();
    expect(current.timeline.phase).toBe('playing');

    peerConnection.connectionState = 'disconnected';
    now += 1;
    healthTick();
    now += 1_500;
    healthTick();
    expect(messages).toHaveBeenCalledTimes(2);
    expect(closeConnection).not.toHaveBeenCalled();
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
    await expect(pending).rejects.toThrow(/stale|closed|aborted|revoked/u);
    resolveSource(blob);
    await drain();
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

  it('transfers one exact warm OFFER into a prepared candidate without allocating or sending it twice', async () => {
    const pair = connectionPair(() => 1_000);
    const sourceLease = warmSourceLease();
    const prepared = preparedTrack('bounded-stream', 4, undefined, sourceLease);
    const authority = matchingWarmAuthority(pair, sourceLease, prepared);
    const timers = offerTimers();
    const required: unknown[] = [];
    const resolveWarm = vi.fn(async () => new Blob([Uint8Array.of(1, 2, 3, 4)]));
    const resolvePrepared = vi.fn(async () => new Blob([Uint8Array.of(1, 2, 3, 4)]));
    let reentrantPrepared: ReturnType<FilePlaybackProductHostMediaOwner['publishPrepared']> | null =
      null;
    let reentrantWarm: ReturnType<FilePlaybackProductHostMediaOwner['publishSourceLease']> | null =
      null;
    let owner!: FilePlaybackProductHostMediaOwner;
    owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: resolvePrepared,
      resolveWarmPeerRangeSource: resolveWarm,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-warm-transfer-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: (handle) => {
          timers.cancel(handle as string);
          if (reentrantPrepared) return;
          reentrantPrepared = owner.publishPrepared(prepared);
          reentrantWarm = owner.publishSourceLease(authority);
          void reentrantWarm.catch(() => undefined);
        },
      },
    });

    const warm = await owner.publishSourceLease(authority);
    const pendingPrepared = owner.publishPrepared(prepared);
    const transferred = await pendingPrepared;
    expect(transferred.offer).toBe(warm.offer);
    expect(transferred.offer.prepareId).toBe(warm.offer.prepareId);
    expect(transferred.offer.prepareRevision).toBe(warm.offer.prepareRevision);
    expect(transferred.offer.transport).toBe('peer-range');
    if (transferred.offer.transport !== 'peer-range') throw new Error('peer offer unavailable');
    expect(transferred.offer.handleId).toBe(requirePeerRangeOffer(warm.offer).handleId);
    expect(reentrantPrepared).toBe(pendingPrepared);
    if (!reentrantPrepared || !reentrantWarm)
      throw new Error('reentrant transfer probe did not run');
    expect(await reentrantPrepared).toBe(transferred);
    await expect(reentrantWarm).rejects.toThrow(/promoted/u);
    expect(resolveWarm).toHaveBeenCalledOnce();
    expect(resolvePrepared).toHaveBeenCalledOnce();
    expect(timers.callbacks).toHaveLength(0);
    expect(required).toEqual([warm.offer]);

    requestPeerRange(pair, owner, {
      sourceIdentity: transferred.offer.sourceIdentity,
      handleId: transferred.offer.handleId,
      totalLength: transferred.offer.encodedSize,
      requestId: '98000000-0000-4000-8000-000000000081',
    });
    await drain(64);
    expect(resolvePrepared).toHaveBeenCalledTimes(2);
    expect(required.some((frame) => (frame as { type?: string }).type === 'chunk')).toBe(true);

    expect(await owner.bindPrepared(prepared)).toBe(transferred);
    expect(
      required.filter(
        (frame) => (frame as { type?: string }).type === 'FILE_MEDIA_SOURCE_OFFER_V2',
      ),
    ).toEqual([warm.offer]);
    expect(
      required.filter(
        (frame) => (frame as { type?: string }).type === 'FILE_PLAYBACK_RUN_BINDING_V2',
      ),
    ).toEqual([transferred.binding]);
    await expect(
      owner.retireSourceLease(sourceLease, new Error('stale warm retirement')),
    ).rejects.toThrow(/promoted/u);
    owner.port().revoke(pair.context);
  });

  it('awaits an exact pending warm publication and transfers its single OFFER without revoke or replacement', async () => {
    const pair = connectionPair(() => 1_000);
    const sourceLease = warmSourceLease();
    const prepared = preparedTrack('bounded-stream', 4, undefined, sourceLease);
    const authority = matchingWarmAuthority(pair, sourceLease, prepared);
    const timers = offerTimers();
    const required: unknown[] = [];
    let resolveWarmSource!: (source: HostPeerRangeSource) => void;
    const pendingWarmSource = new Promise<HostPeerRangeSource>((resolve) => {
      resolveWarmSource = resolve;
    });
    const resolveWarm = vi.fn(() => pendingWarmSource);
    const resolvePrepared = vi.fn(async () => new Blob([Uint8Array.of(1, 2, 3, 4)]));
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: resolvePrepared,
      resolveWarmPeerRangeSource: resolveWarm,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-pending-warm-transfer-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const pendingWarm = owner.publishSourceLease(authority);
    const pendingPrepared = owner.publishPrepared(prepared);
    await drain();
    expect(resolveWarm).toHaveBeenCalledOnce();
    expect(resolvePrepared).not.toHaveBeenCalled();
    expect(required).toHaveLength(0);

    resolveWarmSource(new Blob([Uint8Array.of(1, 2, 3, 4)]));
    const warm = await pendingWarm;
    const transferred = await pendingPrepared;
    expect(transferred.offer).toBe(warm.offer);
    expect(transferred.offer.prepareId).toBe(warm.offer.prepareId);
    expect(transferred.offer.prepareRevision).toBe(warm.offer.prepareRevision);
    expect(transferred.offer.transport).toBe('peer-range');
    if (transferred.offer.transport !== 'peer-range') throw new Error('peer offer unavailable');
    expect(transferred.offer.handleId).toBe(requirePeerRangeOffer(warm.offer).handleId);
    expect(resolvePrepared).toHaveBeenCalledOnce();
    expect(required).toEqual([warm.offer]);
    expect(timers.callbacks).toHaveLength(0);

    expect(await owner.bindPrepared(prepared)).toBe(transferred);
    expect(required.map((frame) => (frame as { type?: string }).type)).toEqual([
      'FILE_MEDIA_SOURCE_OFFER_V2',
      'FILE_PLAYBACK_RUN_BINDING_V2',
    ]);
    owner.port().revoke(pair.context);
  });

  it('detaches a cancelled candidate from pending warm publication without retiring the warm lease', async () => {
    const pair = connectionPair(() => 1_000);
    const sourceLease = warmSourceLease();
    const prepared = preparedTrack('bounded-stream', 4, undefined, sourceLease);
    const authority = matchingWarmAuthority(pair, sourceLease, prepared);
    const timers = offerTimers();
    const required: unknown[] = [];
    let resolveWarmSource!: (source: HostPeerRangeSource) => void;
    const pendingWarmSource = new Promise<HostPeerRangeSource>((resolve) => {
      resolveWarmSource = resolve;
    });
    const warmSignal = { value: null as AbortSignal | null };
    const resolveWarm = vi.fn((options: ResolveWarmHostPeerRangeSourceOptions) => {
      warmSignal.value = options.signal;
      return pendingWarmSource;
    });
    const resolvePrepared = vi.fn(async () => new Blob([Uint8Array.of(1, 2, 3, 4)]));
    const closeConnection = vi.fn();
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: resolvePrepared,
      resolveWarmPeerRangeSource: resolveWarm,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-pending-warm-detach-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const pendingWarm = owner.publishSourceLease(authority);
    const pendingPrepared = owner.publishPrepared(prepared);
    await drain();
    expect(resolveWarm).toHaveBeenCalledOnce();
    expect(resolvePrepared).not.toHaveBeenCalled();
    const retirement = owner.retirePrepared(prepared, new Error('candidate cancelled'));
    await expect(pendingPrepared).rejects.toThrow(/stale|retired|cancelled|aborted/u);
    await expect(retirement).resolves.toBeUndefined();
    expect(warmSignal.value?.aborted).toBe(false);
    expect(required).toHaveLength(0);

    resolveWarmSource(new Blob([Uint8Array.of(1, 2, 3, 4)]));
    const warm = await pendingWarm;
    expect(await owner.publishSourceLease(authority)).toBe(warm);
    expect(resolvePrepared).not.toHaveBeenCalled();
    expect(required).toEqual([warm.offer]);
    expect(timers.callbacks).toHaveLength(1);
    expect(closeConnection).not.toHaveBeenCalled();

    await owner.retireSourceLease(sourceLease, new Error('warm fixture complete'));
    expect(fileMediaSourceRevokeMatchesOfferV2(required[1], warm.offer)).toBe(true);
    owner.port().revoke(pair.context);
  });

  it('keeps a live warm OFFER valid when prepared preflight fails', async () => {
    const pair = connectionPair(() => 1_000);
    const sourceLease = warmSourceLease();
    const prepared = preparedTrack('bounded-stream', 4, undefined, sourceLease);
    const authority = matchingWarmAuthority(pair, sourceLease, prepared);
    const timers = offerTimers();
    const required: unknown[] = [];
    const resolvePrepared = vi.fn(async (): Promise<HostPeerRangeSource> => {
      throw new Error('prepared preflight failed');
    });
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: resolvePrepared,
      resolveWarmPeerRangeSource: async () => new Blob([Uint8Array.of(1, 2, 3, 4)]),
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-warm-preflight-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const warm = await owner.publishSourceLease(authority);
    await expect(owner.publishPrepared(prepared)).rejects.toThrow(/preflight failed/u);
    expect(await owner.publishSourceLease(authority)).toBe(warm);
    expect(resolvePrepared).toHaveBeenCalledOnce();
    expect(required).toEqual([warm.offer]);
    expect(timers.callbacks).toHaveLength(1);

    await owner.retireSourceLease(sourceLease, new Error('warm fixture complete'));
    expect(fileMediaSourceRevokeMatchesOfferV2(required[1], warm.offer)).toBe(true);
    owner.port().revoke(pair.context);
  });

  it('repairs an expired warm Blob with one fresh prepared OFFER without resolving twice', async () => {
    let now = 1_000;
    const pair = connectionPair(() => now);
    const sourceLease = warmSourceLease();
    const prepared = preparedTrack('bounded-stream', 4, undefined, sourceLease);
    const authority = matchingWarmAuthority(pair, sourceLease, prepared);
    const timers = offerTimers();
    const required: unknown[] = [];
    let resolvePreparedSource!: (source: HostPeerRangeSource) => void;
    const preparedSource = new Promise<HostPeerRangeSource>((resolve) => {
      resolvePreparedSource = resolve;
    });
    const resolvePrepared = vi.fn(() => preparedSource);
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: resolvePrepared,
      resolveWarmPeerRangeSource: async () => new Blob([Uint8Array.of(1, 2, 3, 4)]),
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-warm-expiry-repair-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const warm = await owner.publishSourceLease(authority);
    const pending = owner.publishPrepared(prepared);
    await drain();
    expect(resolvePrepared).toHaveBeenCalledOnce();
    const expiry = [...timers.callbacks.values()][0];
    if (!expiry) throw new Error('warm expiry timer unavailable');
    now = warm.offer.expiresAtRoomTimeMs;
    expiry();
    resolvePreparedSource(new Blob([Uint8Array.of(1, 2, 3, 4)]));

    const repaired = await pending;
    if (repaired.offer.transport !== 'peer-range') throw new Error('peer offer unavailable');
    expect(repaired.offer).not.toBe(warm.offer);
    expect(repaired.offer.prepareId).not.toBe(warm.offer.prepareId);
    expect(repaired.offer.prepareRevision).toBeGreaterThan(warm.offer.prepareRevision);
    expect(repaired.offer.handleId).not.toBe(requirePeerRangeOffer(warm.offer).handleId);
    expect(resolvePrepared).toHaveBeenCalledOnce();
    expect(fileMediaSourceRevokeMatchesOfferV2(required[1], warm.offer)).toBe(true);
    expect(required[2]).toBe(repaired.offer);
    expect(timers.callbacks).toHaveLength(0);
    expect(await owner.bindPrepared(prepared)).toBe(repaired);
    expect(required.map((frame) => (frame as { type?: string }).type)).toEqual([
      'FILE_MEDIA_SOURCE_OFFER_V2',
      'FILE_MEDIA_SOURCE_OFFER_REVOKE_V2',
      'FILE_MEDIA_SOURCE_OFFER_V2',
      'FILE_PLAYBACK_RUN_BINDING_V2',
    ]);
    owner.port().revoke(pair.context);
  });

  it('fails closed before prepared resolution when a live same-lease warm tuple contradicts it', async () => {
    const pair = connectionPair(() => 1_000);
    const sourceLease = warmSourceLease();
    const exactPrepared = preparedTrack('bounded-stream', 4, undefined, sourceLease);
    const authority = matchingWarmAuthority(pair, sourceLease, exactPrepared);
    const contradictory = freezeCanonical({
      ...exactPrepared,
      asset: freezeCanonical({
        ...exactPrepared.asset,
        metadata: freezeCanonical({ ...exactPrepared.asset.metadata, name: 'contradiction.flac' }),
      }),
    });
    const timers = offerTimers();
    const required: unknown[] = [];
    const resolvePrepared = vi.fn(async () => new Blob([Uint8Array.of(1, 2, 3, 4)]));
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: resolvePrepared,
      resolveWarmPeerRangeSource: async () => new Blob([Uint8Array.of(1, 2, 3, 4)]),
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-warm-contradiction-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const warm = await owner.publishSourceLease(authority);
    await expect(owner.publishPrepared(contradictory)).rejects.toThrow(/contradicts/u);
    expect(resolvePrepared).not.toHaveBeenCalled();
    expect(await owner.publishSourceLease(authority)).toBe(warm);
    expect(required).toEqual([warm.offer]);
    expect(timers.callbacks).toHaveLength(1);
    await owner.retireSourceLease(sourceLease, new Error('warm fixture complete'));
    owner.port().revoke(pair.context);
  });

  it('lets an in-flight warm range finish after transfer and closes it on candidate retirement', async () => {
    const pair = connectionPair(() => 1_000);
    const sourceLease = warmSourceLease();
    const prepared = preparedTrack('bounded-stream', 4, undefined, sourceLease);
    const authority = matchingWarmAuthority(pair, sourceLease, prepared);
    const timers = offerTimers();
    const required: unknown[] = [];
    let resolveRange!: (source: HostPeerRangeSource) => void;
    const pendingRange = new Promise<HostPeerRangeSource>((resolve) => {
      resolveRange = resolve;
    });
    let warmResolution = 0;
    const resolveWarm = vi.fn(() => {
      warmResolution += 1;
      return warmResolution === 1
        ? Promise.resolve(new Blob([Uint8Array.of(1, 2, 3, 4)]))
        : pendingRange;
    });
    const closeRange = vi.fn(async () => undefined);
    const closeConnection = vi.fn();
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: async () => new Blob([Uint8Array.of(1, 2, 3, 4)]),
      resolveWarmPeerRangeSource: resolveWarm,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-warm-inflight-retire-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const warm = await owner.publishSourceLease(authority);
    const warmOffer = requirePeerRangeOffer(warm.offer);
    requestPeerRange(pair, owner, {
      sourceIdentity: warmOffer.sourceIdentity,
      handleId: warmOffer.handleId,
      totalLength: warmOffer.encodedSize,
      requestId: '98000000-0000-4000-8000-000000000082',
    });
    await drain();
    expect(resolveWarm).toHaveBeenCalledTimes(2);

    const transferred = await owner.publishPrepared(prepared);
    expect(transferred.offer).toBe(warm.offer);
    expect(timers.callbacks).toHaveLength(0);
    resolveRange(encodedWarmSource(authority, closeRange));
    await drain(64);
    expect(required.some((frame) => (frame as { type?: string }).type === 'chunk')).toBe(true);
    expect(required.some((frame) => (frame as { type?: string }).type === 'error')).toBe(false);
    expect(closeRange).not.toHaveBeenCalled();

    await owner.retirePrepared(prepared, new Error('candidate no longer needed'));
    await drain(64);
    expect(required.some((frame) => fileMediaSourceRevokeMatchesOfferV2(frame, warm.offer))).toBe(
      true,
    );
    expect(closeRange).toHaveBeenCalledOnce();
    expect(closeConnection).not.toHaveBeenCalled();
    await expect(
      owner.retireSourceLease(sourceLease, new Error('stale warm retirement')),
    ).rejects.toThrow(/promoted/u);
    owner.port().revoke(pair.context);
  });

  it('retains an in-flight warm range when the transferred candidate becomes current', async () => {
    const pair = connectionPair(() => 1_000);
    const sourceLease = warmSourceLease();
    const prepared = preparedTrack('bounded-stream', 4, undefined, sourceLease);
    const authority = matchingWarmAuthority(pair, sourceLease, prepared);
    const timers = offerTimers();
    const required: unknown[] = [];
    let current: Readonly<HostPeerPlaybackPublication> | null = null;
    let resolveRange!: (source: HostPeerRangeSource) => void;
    const pendingRange = new Promise<HostPeerRangeSource>((resolve) => {
      resolveRange = resolve;
    });
    let warmResolution = 0;
    const resolveWarm = vi.fn(() => {
      warmResolution += 1;
      return warmResolution === 1
        ? Promise.resolve(new Blob([Uint8Array.of(1, 2, 3, 4)]))
        : pendingRange;
    });
    const closeRange = vi.fn(async () => undefined);
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => current,
        () => new Blob([Uint8Array.of(1, 2, 3, 4)]),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: async () => new Blob([Uint8Array.of(1, 2, 3, 4)]),
      resolveWarmPeerRangeSource: resolveWarm,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-warm-inflight-current-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const warm = await owner.publishSourceLease(authority);
    const warmOffer = requirePeerRangeOffer(warm.offer);
    requestPeerRange(pair, owner, {
      sourceIdentity: warmOffer.sourceIdentity,
      handleId: warmOffer.handleId,
      totalLength: warmOffer.encodedSize,
      requestId: '98000000-0000-4000-8000-000000000083',
    });
    await drain();
    expect(resolveWarm).toHaveBeenCalledTimes(2);

    const transferred = await owner.publishPrepared(prepared);
    await owner.bindPrepared(prepared);
    const timeline = committedTimeline();
    current = committedPreparedPublication(prepared, timeline);
    const activated = owner.activatePrepared({
      prepared,
      timeline,
      initialCohortAdmitted: false,
    });
    expect(activated.offer).toBe(transferred.offer);
    expect(activated.offer).toBe(warm.offer);
    resolveRange(encodedWarmSource(authority, closeRange));
    await drain(64);
    expect(required.some((frame) => (frame as { type?: string }).type === 'chunk')).toBe(true);
    expect(required.some((frame) => (frame as { type?: string }).type === 'error')).toBe(false);
    expect(closeRange).not.toHaveBeenCalled();

    owner.port().revoke(pair.context);
    await drain(64);
    expect(closeRange).toHaveBeenCalledOnce();
  });

  it('keeps an unrelated warm lease live beside a freshly repaired prepared candidate', async () => {
    const pair = connectionPair(() => 1_000);
    const warmLease = warmSourceLease();
    const preparedLease = warmSourceLease();
    const authority = warmAuthority(pair, warmLease);
    const prepared = preparedTrack('bounded-stream', 4, undefined, preparedLease);
    const timers = offerTimers();
    const required: unknown[] = [];
    const resolveWarm = vi.fn(async () => new Blob([Uint8Array.of(1, 2, 3, 4)]));
    const resolvePrepared = vi.fn(async () => new Blob([Uint8Array.of(5, 6, 7, 8)]));
    const closeConnection = vi.fn();
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: resolvePrepared,
      resolveWarmPeerRangeSource: resolveWarm,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-unrelated-warm-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const warm = await owner.publishSourceLease(authority);
    const warmOffer = requirePeerRangeOffer(warm.offer);
    const candidate = await owner.publishPrepared(prepared);
    if (candidate.offer.transport !== 'peer-range') throw new Error('peer offer unavailable');
    expect(candidate.offer).not.toBe(warm.offer);
    expect(
      required.filter((frame) => (frame as { type?: string }).type?.includes('OFFER')),
    ).toEqual([warm.offer, candidate.offer]);
    expect(await owner.publishSourceLease(authority)).toBe(warm);
    expect(timers.callbacks).toHaveLength(1);

    requestPeerRange(pair, owner, {
      sourceIdentity: warmOffer.sourceIdentity,
      handleId: warmOffer.handleId,
      totalLength: warmOffer.encodedSize,
      requestId: '98000000-0000-4000-8000-000000000084',
    });
    requestPeerRange(pair, owner, {
      sourceIdentity: candidate.offer.sourceIdentity,
      handleId: candidate.offer.handleId,
      totalLength: candidate.offer.encodedSize,
      requestId: '98000000-0000-4000-8000-000000000085',
    });
    await drain(64);
    expect(resolveWarm).toHaveBeenCalledTimes(2);
    expect(resolvePrepared).toHaveBeenCalledTimes(2);
    expect(required.filter((frame) => (frame as { type?: string }).type === 'chunk')).toHaveLength(
      2,
    );

    await owner.retirePrepared(prepared, new Error('candidate fixture complete'));
    expect(await owner.publishSourceLease(authority)).toBe(warm);
    expect(timers.callbacks).toHaveLength(1);
    await expect(
      owner.retireSourceLease(preparedLease, new Error('stale prepared lease')),
    ).rejects.toThrow(/promoted/u);
    await owner.retireSourceLease(warmLease, new Error('warm fixture complete'));
    expect(timers.callbacks).toHaveLength(0);
    expect(
      required.some((frame) => fileMediaSourceRevokeMatchesOfferV2(frame, candidate.offer)),
    ).toBe(true);
    expect(required.some((frame) => fileMediaSourceRevokeMatchesOfferV2(frame, warm.offer))).toBe(
      true,
    );
    expect(closeConnection).not.toHaveBeenCalled();
    owner.port().revoke(pair.context);
  });

  it('publishes one exact warm result idempotently and rejects copied or cross-room authority without replacement', async () => {
    const pair = connectionPair(() => 1_000);
    const lease = warmSourceLease();
    const authority = warmAuthority(pair, lease);
    const timers = offerTimers();
    const required: unknown[] = [];
    const closeConnection = vi.fn();
    const resolveWarm = vi.fn(async (options: ResolveWarmHostPeerRangeSourceOptions) => {
      if (options.sourceLease !== lease) throw new Error('fixture warm lease is stale');
      return encodedWarmSource(authority);
    });
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolveWarmPeerRangeSource: resolveWarm,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-warm-identity-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const first = await owner.publishSourceLease(authority);
    expect(await owner.publishSourceLease(authority)).toBe(first);
    expect(resolveWarm).toHaveBeenCalledOnce();
    expect(required).toHaveLength(1);
    if (first.offer.transport !== 'peer-range') throw new Error('peer offer unavailable');
    const acknowledge = vi.fn();
    owner.port().adoptPeerRangeControl(
      freezeCanonical({
        frame: createPeerRangeReadFrame({
          connectionId: pair.context.connectionId,
          sourceIdentity: first.offer.sourceIdentity,
          handleId: first.offer.handleId,
          requestId: '98000000-0000-4000-8000-000000000070',
          offset: 0,
          totalLength: first.offer.encodedSize,
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
    expect(resolveWarm).toHaveBeenCalledTimes(2);
    expect(required.some((frame) => (frame as { type?: string }).type === 'chunk')).toBe(true);

    const copiedAuthority = freezeCanonical({ ...authority });
    expect(copiedAuthority).not.toBe(authority);
    await expect(owner.publishSourceLease(copiedAuthority)).rejects.toThrow(/exact authority/u);
    await expect(
      owner.publishSourceLease(
        freezeCanonical({ ...authority, applicationSessionId: 'wrong-session' }),
      ),
    ).rejects.toThrow(/invalid/u);
    await expect(
      owner.publishSourceLease(freezeCanonical({ ...authority, hostParticipantId: 'wrong-host' })),
    ).rejects.toThrow(/invalid/u);
    expect(resolveWarm).toHaveBeenCalledTimes(2);

    await expect(owner.publishSourceLease(warmAuthority(pair, warmSourceLease()))).rejects.toThrow(
      /stale/u,
    );
    await expect(
      owner.publishSourceLease(warmAuthority(pair, warmSourceLease(), 'cross')),
    ).rejects.toThrow(/stale/u);
    expect(await owner.publishSourceLease(authority)).toBe(first);
    expect(resolveWarm).toHaveBeenCalledTimes(4);
    expect(
      required.filter(
        (frame) => (frame as { type?: string }).type === 'FILE_MEDIA_SOURCE_OFFER_V2',
      ),
    ).toHaveLength(1);
    expect(closeConnection).not.toHaveBeenCalled();
    expect(timers.callbacks).toHaveLength(1);

    owner.port().revoke(pair.context);
    expect(timers.callbacks).toHaveLength(0);
    expect(timers.cancel).toHaveBeenCalledOnce();
  });

  it.each(['send', 'schedule'] as const)(
    'shares the in-flight warm task across synchronous %s reentrancy and rejects both callers',
    async (failurePoint) => {
      const pair = connectionPair(() => 1_000);
      const authority = warmAuthority(pair, warmSourceLease());
      const closeConnection = vi.fn();
      let owner!: FilePlaybackProductHostMediaOwner;
      let reentrant: Promise<unknown> | null = null;
      const sendRequired = vi.fn((_connection: DataConnection, frame: unknown) => {
        if (
          failurePoint === 'send' &&
          (frame as { type?: string }).type === 'FILE_MEDIA_SOURCE_OFFER_V2'
        ) {
          reentrant = owner.publishSourceLease(authority);
          return false;
        }
        return true;
      });
      const scheduleTimeout = vi.fn((_callback: () => void, _delayMs: number) => {
        if (failurePoint === 'schedule') {
          reentrant = owner.publishSourceLease(authority);
          throw new Error('fixture warm expiry scheduling failed');
        }
        return 'host-owner-warm-reentrant-timeout';
      });
      owner = new FilePlaybackProductHostMediaOwner({
        context: pair.context,
        hostRoom: roomPort(
          () => null,
          () => new Blob(),
          [],
        ),
        publisher: publisher(),
        resolveWarmPeerRangeSource: vi.fn(async () => encodedWarmSource(authority)),
        sendRequired,
        sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
        closeConnection,
        onHealthSystemMessage: vi.fn(),
        runtimeForTests: {
          createMediaIdForTests: ids(),
          scheduleIntervalForTests: () => `host-owner-warm-${failurePoint}-health`,
          cancelIntervalForTests: vi.fn(),
          scheduleTimeoutForTests: scheduleTimeout,
          cancelTimeoutForTests: vi.fn(),
        },
      });

      const first = owner.publishSourceLease(authority);
      await drain(32);
      expect(reentrant).toBe(first);
      await expect(first).rejects.toThrow(/connection|failed|scheduling/u);
      await expect(reentrant!).rejects.toThrow(/connection|failed|scheduling/u);
      expect(sendRequired).toHaveBeenCalled();
      expect(closeConnection).toHaveBeenCalledTimes(failurePoint === 'send' ? 1 : 0);
      if (failurePoint === 'schedule') owner.port().revoke(pair.context);
    },
  );

  it('offers and serves the exact room-owned warm Blob without taking Blob cleanup ownership', async () => {
    const pair = connectionPair(() => 1_000);
    const sourceLease = warmSourceLease();
    const authority = warmAuthority(pair, sourceLease);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/flac' });
    const timers = offerTimers();
    const required: unknown[] = [];
    const resolveWarm = vi.fn(async (options: ResolveWarmHostPeerRangeSourceOptions) => {
      if (
        options.sourceLease !== sourceLease ||
        options.sourceIdentity !== authority.asset.binding.sourceIdentity ||
        options.peerRangeManifest !== null ||
        options.signal.aborted
      ) {
        throw new Error('fixture warm Blob authority is stale');
      }
      return blob;
    });
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolveWarmPeerRangeSource: resolveWarm,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-warm-blob-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const published = await owner.publishSourceLease(authority);
    const publishedOffer = requirePeerRangeOffer(published.offer);
    const acknowledge = vi.fn();
    owner.port().adoptPeerRangeControl(
      freezeCanonical({
        frame: createPeerRangeReadFrame({
          connectionId: pair.context.connectionId,
          sourceIdentity: publishedOffer.sourceIdentity,
          handleId: publishedOffer.handleId,
          requestId: '98000000-0000-4000-8000-000000000073',
          offset: 1,
          totalLength: 2,
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
    expect(resolveWarm).toHaveBeenCalledTimes(2);
    expect(resolveWarm.mock.calls.map(([options]) => options.peerRangeManifest)).toEqual([
      null,
      null,
    ]);
    expect(required.some((frame) => (frame as { type?: string }).type === 'chunk')).toBe(true);

    owner.port().revoke(pair.context);
    expect(timers.callbacks).toHaveLength(0);
    await expect(blob.arrayBuffer()).resolves.toHaveProperty('byteLength', 4);
  });

  it('keeps current playback while atomically replacing only the warm offer and its stale handle', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([new Uint8Array([7])], { type: 'audio/flac' });
    const current = publication('bounded-stream', blob);
    const firstAuthority = warmAuthority(pair, warmSourceLease());
    const nextAuthority = warmAuthority(pair, warmSourceLease(), 'next');
    const timers = offerTimers();
    const required: unknown[] = [];
    const closeConnection = vi.fn();
    const resolveWarm = vi.fn(async (options: ResolveWarmHostPeerRangeSourceOptions) => {
      if (options.sourceLease === firstAuthority.sourceLease) {
        return encodedWarmSource(firstAuthority);
      }
      if (options.sourceLease === nextAuthority.sourceLease)
        return encodedWarmSource(nextAuthority);
      throw new Error('fixture warm lease is stale');
    });
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: {
        currentPeerPublication: () => current,
        resolveCurrentPeerRangeSource: vi.fn(
          async (_options: ResolveHostPeerRangeSourceOptions): Promise<HostPeerRangeSource> => ({
            kind: 'peer-range',
            size: blob.size,
            identity: current.asset.binding.sourceIdentity,
            metadata: current.asset.metadata,
            readAt: vi.fn(async () => new Uint8Array([7])),
            close: vi.fn(async () => undefined),
          }),
        ),
        recoverRemoteParticipant: vi.fn(),
      },
      publisher: publisher(),
      resolveWarmPeerRangeSource: resolveWarm,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-warm-current-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const currentCommit = await owner.publishCurrent();
    const first = await owner.publishSourceLease(firstAuthority);
    const next = await owner.publishSourceLease(nextAuthority);
    expect(await owner.publishCurrent()).toBe(currentCommit);
    if (
      currentCommit.offer.transport !== 'peer-range' ||
      first.offer.transport !== 'peer-range' ||
      next.offer.transport !== 'peer-range'
    ) {
      throw new Error('peer offer unavailable');
    }
    expect(next.offer.prepareRevision).toBeGreaterThan(first.offer.prepareRevision);
    expect(next.offer.prepareId).not.toBe(first.offer.prepareId);
    expect(next.offer.handleId).not.toBe(first.offer.handleId);
    expect(required.map((frame) => (frame as { type?: string }).type)).toEqual([
      'FILE_MEDIA_SOURCE_OFFER_V2',
      'FILE_PLAYBACK_RUN_BINDING_V2',
      'FILE_MEDIA_SOURCE_OFFER_V2',
      'FILE_MEDIA_SOURCE_OFFER_REVOKE_V2',
      'FILE_MEDIA_SOURCE_OFFER_V2',
    ]);
    expect(fileMediaSourceRevokeMatchesOfferV2(required[3], first.offer)).toBe(true);
    expect(timers.cancel).toHaveBeenCalledOnce();
    expect(timers.callbacks).toHaveLength(1);

    const staleRead = freezeCanonical({
      frame: createPeerRangeReadFrame({
        connectionId: pair.context.connectionId,
        sourceIdentity: first.offer.sourceIdentity,
        handleId: first.offer.handleId,
        requestId: '98000000-0000-4000-8000-000000000071',
        offset: 0,
        totalLength: first.offer.encodedSize,
      }),
      lane: 'control' as const,
      role: 'host' as const,
      connection: pair.connection,
      channel: pair.host,
      connectionToken: pair.hostToken,
    });
    const staleAcknowledge = vi.fn();
    expect(() => owner.port().adoptPeerRangeControl(staleRead, staleAcknowledge)).not.toThrow();
    expect(staleAcknowledge).toHaveBeenCalledOnce();
    expect(resolveWarm).toHaveBeenCalledTimes(2);
    expect(closeConnection).not.toHaveBeenCalled();
    owner.port().revoke(pair.context);
    expect(timers.callbacks).toHaveLength(0);
  });

  it('routes equal source identities by exact handle across current, candidate, and warm lifecycles', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/flac' });
    const current = publication('bounded-stream', blob);
    const prepared = preparedTrack('bounded-stream', blob.size);
    const warm = warmAuthority(
      pair,
      warmSourceLease(),
      'owner',
      current.asset.binding.sourceIdentity,
    );
    const timers = offerTimers();
    const required: unknown[] = [];
    const resolveCurrent = vi.fn(async () => encodedPreparedSource(prepared));
    const resolvePrepared = vi.fn(async () => encodedPreparedSource(prepared));
    const resolveWarm = vi.fn(async () => encodedWarmSource(warm));
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: {
        currentPeerPublication: () => current,
        resolveCurrentPeerRangeSource: resolveCurrent,
        recoverRemoteParticipant: vi.fn(),
      },
      publisher: publisher(),
      resolvePreparedPeerRangeSource: resolvePrepared,
      resolveWarmPeerRangeSource: resolveWarm,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-equal-source-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const currentCommit = await owner.publishCurrent();
    const candidateCommit = await owner.publishPrepared(prepared);
    const warmCommit = await owner.publishSourceLease(warm);
    if (
      currentCommit.offer.transport !== 'peer-range' ||
      candidateCommit.offer.transport !== 'peer-range'
    ) {
      throw new Error('peer offer unavailable');
    }
    const offers = [
      currentCommit.offer,
      candidateCommit.offer,
      requirePeerRangeOffer(warmCommit.offer),
    ] as const;
    for (const [index, offer] of offers.entries()) {
      const acknowledge = vi.fn();
      owner.port().adoptPeerRangeControl(
        freezeCanonical({
          frame: createPeerRangeReadFrame({
            connectionId: pair.context.connectionId,
            sourceIdentity: current.asset.binding.sourceIdentity,
            handleId: offer.handleId,
            requestId: `98000000-0000-4000-8000-00000000008${index}`,
            offset: index,
            totalLength: 1,
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
    }
    await drain(96);

    expect(resolveCurrent).toHaveBeenCalledOnce();
    expect(resolvePrepared).toHaveBeenCalledTimes(2);
    expect(resolveWarm).toHaveBeenCalledTimes(2);
    expect(resolvePrepared).toHaveBeenLastCalledWith({
      prepared,
      sourceIdentity: current.asset.binding.sourceIdentity,
      peerRangeManifest: null,
      signal: expect.any(AbortSignal),
    });
    expect(resolveWarm).toHaveBeenLastCalledWith({
      sourceLease: warm.sourceLease,
      sourceIdentity: current.asset.binding.sourceIdentity,
      peerRangeManifest: null,
      signal: expect.any(AbortSignal),
    });
    expect(required.filter((frame) => (frame as { type?: string }).type === 'chunk')).toHaveLength(
      3,
    );
    owner.port().revoke(pair.context);
  });

  it('retires a warm offer without disturbing a prepared candidate and revalidates a stale lease', async () => {
    const pair = connectionPair(() => 1_000);
    const sourceLease = warmSourceLease();
    const authority = warmAuthority(pair, sourceLease, 'next');
    const prepared = preparedTrack('bounded-stream', 3);
    const timers = offerTimers();
    const required: unknown[] = [];
    const closeConnection = vi.fn();
    let leaseLive = true;
    const resolveWarm = vi.fn(async (options: ResolveWarmHostPeerRangeSourceOptions) => {
      if (!leaseLive || options.sourceLease !== sourceLease) {
        throw new Error('fixture warm lease is stale');
      }
      return encodedWarmSource(authority);
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
      resolveWarmPeerRangeSource: resolveWarm,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-warm-retire-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const warm = await owner.publishSourceLease(authority);
    await owner.publishPrepared(prepared);
    const retirement = owner.retireSourceLease(sourceLease, new Error('warm no longer needed'));
    expect(owner.retireSourceLease(sourceLease, new Error('reentrant replay'))).toBe(retirement);
    await expect(retirement).resolves.toBeUndefined();
    expect(fileMediaSourceRevokeMatchesOfferV2(required[2], warm.offer)).toBe(true);
    expect(timers.callbacks).toHaveLength(0);
    expect(closeConnection).not.toHaveBeenCalled();
    await expect(owner.bindPrepared(prepared)).resolves.toMatchObject({ prepared });

    leaseLive = false;
    await expect(owner.publishSourceLease(authority)).rejects.toThrow(/retired/u);
    expect(resolveWarm).toHaveBeenCalledOnce();
    expect(closeConnection).not.toHaveBeenCalled();
    owner.port().revoke(pair.context);
  });

  it('preserves exact retirement promise identity across a B to A to B interleave', async () => {
    const pair = connectionPair(() => 1_000);
    const authorityA = warmAuthority(pair, warmSourceLease());
    const authorityB = warmAuthority(pair, warmSourceLease(), 'next');
    const timers = offerTimers();
    const required: unknown[] = [];
    let resolveB!: (source: HostPeerRangeSource) => void;
    const pendingBSource = new Promise<HostPeerRangeSource>((resolve) => {
      resolveB = resolve;
    });
    const lateBClose = vi.fn(async () => undefined);
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolveWarmPeerRangeSource: vi.fn((options: ResolveWarmHostPeerRangeSourceOptions) =>
        options.sourceLease === authorityB.sourceLease
          ? pendingBSource
          : Promise.resolve(encodedWarmSource(authorityA)),
      ),
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-warm-retirement-map-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    await owner.publishSourceLease(authorityA);
    const pendingB = owner.publishSourceLease(authorityB);
    await drain(32);
    const retirementB = owner.retireSourceLease(
      authorityB.sourceLease,
      new Error('retire pending B'),
    );
    const retirementA = owner.retireSourceLease(
      authorityA.sourceLease,
      new Error('retire current A'),
    );
    const retirementBReplay = owner.retireSourceLease(
      authorityB.sourceLease,
      new Error('retire B replay'),
    );

    expect(retirementBReplay).toBe(retirementB);
    expect(retirementA).not.toBe(retirementB);
    await expect(pendingB).rejects.toThrow(/retire pending B|aborted/u);
    await expect(Promise.all([retirementB, retirementA])).resolves.toEqual([undefined, undefined]);
    expect(owner.retireSourceLease(authorityA.sourceLease, new Error('A replay'))).toBe(
      retirementA,
    );

    resolveB(encodedWarmSource(authorityB, lateBClose));
    await drain(64);
    expect(lateBClose).toHaveBeenCalledOnce();
    expect(required.map((frame) => (frame as { type?: string }).type)).toEqual([
      'FILE_MEDIA_SOURCE_OFFER_V2',
      'FILE_MEDIA_SOURCE_OFFER_REVOKE_V2',
    ]);
    expect(timers.callbacks).toHaveLength(0);
    owner.port().revoke(pair.context);
  });

  it('fences the expired warm record before cancelTimeout can synchronously republish it', async () => {
    const pair = connectionPair(() => 1_000);
    const authority = warmAuthority(pair, warmSourceLease());
    const timers = offerTimers();
    const required: unknown[] = [];
    let owner!: FilePlaybackProductHostMediaOwner;
    const reentrant = {
      value: null as ReturnType<FilePlaybackProductHostMediaOwner['publishSourceLease']> | null,
    };
    let shouldReenter = true;
    const cancelTimeout = vi.fn((handle: string) => {
      timers.cancel(handle);
      if (!shouldReenter) return;
      shouldReenter = false;
      reentrant.value = owner.publishSourceLease(authority);
    });
    owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolveWarmPeerRangeSource: vi.fn(async () => encodedWarmSource(authority)),
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-warm-cancel-reentrant-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: cancelTimeout,
      },
    });

    const first = await owner.publishSourceLease(authority);
    const expire = [...timers.callbacks.values()][0];
    if (!expire) throw new Error('warm expiry timer unavailable');
    expire();
    if (!reentrant.value) throw new Error('cancelTimeout did not synchronously republish');
    const second = await reentrant.value;
    const firstOffer = requirePeerRangeOffer(first.offer);
    const secondOffer = requirePeerRangeOffer(second.offer);

    expect(second).not.toBe(first);
    expect(second.offer.prepareRevision).toBeGreaterThan(first.offer.prepareRevision);
    expect(second.offer.prepareId).not.toBe(first.offer.prepareId);
    expect(secondOffer.handleId).not.toBe(firstOffer.handleId);
    expect(required.map((frame) => (frame as { type?: string }).type)).toEqual([
      'FILE_MEDIA_SOURCE_OFFER_V2',
      'FILE_MEDIA_SOURCE_OFFER_REVOKE_V2',
      'FILE_MEDIA_SOURCE_OFFER_V2',
    ]);
    expect(timers.callbacks).toHaveLength(1);
    owner.port().revoke(pair.context);
    expect(timers.callbacks).toHaveLength(0);
  });

  it('expires only the exact warm offer and republishes the same live lease with fresh IDs', async () => {
    let now = 1_000;
    const pair = connectionPair(() => now);
    const sourceLease = warmSourceLease();
    const authority = warmAuthority(pair, sourceLease);
    const timers = offerTimers();
    const required: unknown[] = [];
    const closeConnection = vi.fn();
    const resolveWarm = vi.fn(async () => encodedWarmSource(authority));
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolveWarmPeerRangeSource: resolveWarm,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-warm-expiry-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const first = await owner.publishSourceLease(authority);
    if (first.offer.transport !== 'peer-range') throw new Error('peer offer unavailable');
    const firstTimer = [...timers.callbacks.values()][0];
    if (!firstTimer) throw new Error('warm expiry timer unavailable');
    now = first.offer.expiresAtRoomTimeMs;
    firstTimer();
    expect(closeConnection).not.toHaveBeenCalled();
    expect(timers.callbacks).toHaveLength(0);
    expect(fileMediaSourceRevokeMatchesOfferV2(required[1], first.offer)).toBe(true);

    const expiredRead = freezeCanonical({
      frame: createPeerRangeReadFrame({
        connectionId: pair.context.connectionId,
        sourceIdentity: first.offer.sourceIdentity,
        handleId: first.offer.handleId,
        requestId: '98000000-0000-4000-8000-000000000072',
        offset: 0,
        totalLength: first.offer.encodedSize,
      }),
      lane: 'control' as const,
      role: 'host' as const,
      connection: pair.connection,
      channel: pair.host,
      connectionToken: pair.hostToken,
    });
    const expiredAcknowledge = vi.fn();
    expect(() => owner.port().adoptPeerRangeControl(expiredRead, expiredAcknowledge)).not.toThrow();
    expect(expiredAcknowledge).toHaveBeenCalledOnce();
    expect(resolveWarm).toHaveBeenCalledOnce();

    const second = await owner.publishSourceLease(authority);
    if (second.offer.transport !== 'peer-range') throw new Error('peer offer unavailable');
    expect(second.offer.prepareRevision).toBeGreaterThan(first.offer.prepareRevision);
    expect(second.offer.prepareId).not.toBe(first.offer.prepareId);
    expect(second.offer.handleId).not.toBe(first.offer.handleId);
    expect(resolveWarm).toHaveBeenCalledTimes(2);
    expect(timers.callbacks).toHaveLength(1);
    expect(closeConnection).not.toHaveBeenCalled();

    owner.port().revoke(pair.context);
    expect(timers.callbacks).toHaveLength(0);
    expect(timers.cancel).toHaveBeenCalledTimes(2);
  });

  it('fences an abort-ignoring warm resolver and closes its late source without replacing the newer offer', async () => {
    const pair = connectionPair(() => 1_000);
    const first = warmAuthority(pair, warmSourceLease());
    const next = warmAuthority(pair, warmSourceLease(), 'next');
    const aba = warmAuthority(pair, warmSourceLease(), 'aba');
    const timers = offerTimers();
    const required: unknown[] = [];
    let resolveFirst!: (source: HostPeerRangeSource) => void;
    const ignoredAbort = new Promise<HostPeerRangeSource>((resolve) => {
      resolveFirst = resolve;
    });
    let resolveAba!: (source: HostPeerRangeSource) => void;
    const ignoredAbaAbort = new Promise<HostPeerRangeSource>((resolve) => {
      resolveAba = resolve;
    });
    const lateClose = vi.fn(async () => undefined);
    const lateAbaClose = vi.fn(async () => undefined);
    const resolveWarm = vi.fn((options: ResolveWarmHostPeerRangeSourceOptions) => {
      if (options.sourceLease === first.sourceLease) return ignoredAbort;
      if (options.sourceLease === aba.sourceLease) return ignoredAbaAbort;
      return Promise.resolve(encodedWarmSource(next));
    });
    const closeConnection = vi.fn();
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolveWarmPeerRangeSource: resolveWarm,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-warm-aba-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const stale = owner.publishSourceLease(first);
    await drain();
    const published = await owner.publishSourceLease(next);
    await expect(stale).rejects.toThrow(/superseded|aborted/u);
    expect(required).toHaveLength(1);
    expect(required[0]).toBe(published.offer);

    resolveFirst(encodedWarmSource(first, lateClose));
    await drain(64);
    expect(lateClose).toHaveBeenCalledOnce();
    expect(required).toHaveLength(1);
    expect(closeConnection).not.toHaveBeenCalled();

    const staleAba = owner.publishSourceLease(aba);
    await drain();
    expect(await owner.publishSourceLease(next)).toBe(published);
    await expect(staleAba).rejects.toThrow(/superseded|aborted/u);
    resolveAba(encodedWarmSource(aba, lateAbaClose));
    await drain(64);
    expect(lateAbaClose).toHaveBeenCalledOnce();
    expect(required).toHaveLength(1);
    expect(timers.callbacks).toHaveLength(1);

    await expect(
      owner.retireSourceLease(next.sourceLease, new Error('new warm offer complete')),
    ).resolves.toBeUndefined();
    expect(timers.callbacks).toHaveLength(0);
    expect(required.map((frame) => (frame as { type?: string }).type)).toEqual([
      'FILE_MEDIA_SOURCE_OFFER_V2',
      'FILE_MEDIA_SOURCE_OFFER_REVOKE_V2',
    ]);
    expect(closeConnection).not.toHaveBeenCalled();
    owner.port().revoke(pair.context);
  });

  it('retries a failed warm preflight without consuming prepare revision one', async () => {
    const pair = connectionPair(() => 1_000);
    const authority = warmAuthority(pair, warmSourceLease());
    const timers = offerTimers();
    const required: unknown[] = [];
    const closeConnection = vi.fn();
    let failPreflight = true;
    const resolveWarm = vi.fn(async () => {
      if (failPreflight) {
        failPreflight = false;
        throw new Error('fixture warm preflight failed');
      }
      return encodedWarmSource(authority);
    });
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolveWarmPeerRangeSource: resolveWarm,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-warm-preflight-retry-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    await expect(owner.publishSourceLease(authority)).rejects.toThrow(
      'fixture warm preflight failed',
    );
    expect(required).toHaveLength(0);
    expect(closeConnection).not.toHaveBeenCalled();

    const published = await owner.publishSourceLease(authority);
    expect(published.offer.prepareRevision).toBe(1);
    expect(required).toEqual([published.offer]);
    expect(resolveWarm).toHaveBeenCalledTimes(2);
    expect(closeConnection).not.toHaveBeenCalled();

    owner.port().revoke(pair.context);
  });

  it('retries a failed current R2 publication without consuming prepare revision one', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([Uint8Array.of(1, 2, 3)], { type: 'audio/mpeg' });
    const current = publication('audio-buffer', blob);
    const retrying = publisherWithOneFailedUpload('fixture current R2 upload failed');
    const required: unknown[] = [];
    const closeConnection = vi.fn();
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => current,
        () => blob,
        [],
      ),
      publisher: retrying.instance,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        nowEpochMsForTests: () => 1_000,
        scheduleIntervalForTests: () => 'host-owner-current-r2-retry-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    await expect(owner.publishCurrent()).rejects.toThrow('fixture current R2 upload failed');
    expect(required).toHaveLength(0);
    expect(closeConnection).not.toHaveBeenCalled();

    const published = await owner.publishCurrent();
    expect(published.offer.transport).toBe('r2-whole-blob');
    expect(published.offer.prepareRevision).toBe(1);
    expect(required[0]).toBe(published.offer);
    expect(retrying.upload).toHaveBeenCalledTimes(2);
    expect(closeConnection).not.toHaveBeenCalled();

    owner.port().revoke(pair.context);
    await retrying.instance.close();
  });

  it('retries a failed prepared R2 publication without consuming prepare revision one', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([Uint8Array.of(4, 5, 6)], { type: 'audio/mpeg' });
    const prepared = preparedTrack('audio-buffer', blob.size);
    const retrying = publisherWithOneFailedUpload('fixture prepared R2 upload failed');
    const required: unknown[] = [];
    const closeConnection = vi.fn();
    const resolvePrepared = vi.fn(async () => blob);
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => blob,
        [],
      ),
      publisher: retrying.instance,
      resolvePreparedPeerRangeSource: resolvePrepared,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        nowEpochMsForTests: () => 1_000,
        scheduleIntervalForTests: () => 'host-owner-prepared-r2-retry-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    await expect(owner.publishPrepared(prepared)).rejects.toThrow(
      'fixture prepared R2 upload failed',
    );
    expect(required).toHaveLength(0);
    expect(closeConnection).not.toHaveBeenCalled();

    const published = await owner.publishPrepared(prepared);
    expect(published.offer.transport).toBe('r2-whole-blob');
    expect(published.offer.prepareRevision).toBe(1);
    expect(required).toEqual([published.offer]);
    expect(resolvePrepared).toHaveBeenCalledTimes(2);
    expect(retrying.upload).toHaveBeenCalledTimes(2);
    expect(closeConnection).not.toHaveBeenCalled();

    owner.port().revoke(pair.context);
    await retrying.instance.close();
  });

  it('sends an immediate current offer before a delayed warm offer in revision order', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([Uint8Array.of(7)], { type: 'audio/flac' });
    const current = publication('bounded-stream', blob);
    const authority = warmAuthority(pair, warmSourceLease());
    const timers = offerTimers();
    const required: unknown[] = [];
    let releaseWarm!: (source: HostPeerRangeSource) => void;
    const warmSource = new Promise<HostPeerRangeSource>((resolve) => {
      releaseWarm = resolve;
    });
    const resolveWarm = vi.fn(() => warmSource);
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => current,
        () => blob,
        [],
      ),
      publisher: publisher(),
      resolveWarmPeerRangeSource: resolveWarm,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-cross-lane-revision-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const delayedWarm = owner.publishSourceLease(authority);
    await vi.waitFor(() => expect(resolveWarm).toHaveBeenCalledOnce());
    const currentCommit = await owner.publishCurrent();
    releaseWarm(encodedWarmSource(authority));
    const warmCommit = await delayedWarm;

    const offers = required.filter(
      (frame): frame is { readonly prepareRevision: number; readonly type: string } =>
        (frame as { type?: string }).type === 'FILE_MEDIA_SOURCE_OFFER_V2',
    );
    expect(offers.map((offer) => offer.prepareRevision)).toEqual([1, 2]);
    expect(offers).toEqual([currentCommit.offer, warmCommit.offer]);

    owner.port().revoke(pair.context);
  });

  it('terminalizes the exact connection when post-revision binding creation fails', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([Uint8Array.of(8)], { type: 'audio/flac' });
    const valid = publication('bounded-stream', blob);
    const invalid = freezeCanonical({
      ...valid,
      state: freezeCanonical({ ...valid.state, runId: 'not-a-valid-run-id' }),
    }) as unknown as Readonly<HostPeerPlaybackPublication>;
    const required = vi.fn(() => true);
    const closeConnection = vi.fn();
    const r2 = publisher();
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => invalid,
        () => blob,
        [],
      ),
      publisher: r2,
      sendRequired: required,
      sendWire: (_connection, wireLease, payload) => pair.host.createWire(wireLease, payload),
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-post-revision-failure-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    await expect(owner.publishCurrent()).rejects.toThrow(/connection failed/u);
    expect(required).not.toHaveBeenCalled();
    expect(closeConnection).toHaveBeenCalledOnce();
    await expect(owner.publishCurrent()).rejects.toThrow(/closed/u);

    await r2.close();
  });

  it.each([
    { label: 'omitted policy', boundedRoutePolicy: undefined },
    {
      label: 'explicit current policy',
      boundedRoutePolicy: FILE_PLAYBACK_CURRENT_BOUNDED_ROUTE_POLICY,
    },
  ])(
    'keeps non-null manifest diagnostics on a direct offer under $label',
    async ({ boundedRoutePolicy }) => {
      const pair = connectionPair(() => 1_000);
      const selector = manifestDiagnostics();
      const prepared = preparedTrack('bounded-stream', 4, undefined, null, selector);
      const required: unknown[] = [];
      const resolvePrepared = vi.fn(
        async (_options: ResolvePreparedHostPeerRangeSourceOptions): Promise<HostPeerRangeSource> =>
          encodedPreparedSource(prepared),
      );
      const owner = new FilePlaybackProductHostMediaOwner({
        ...(boundedRoutePolicy ? { boundedRoutePolicy } : {}),
        context: pair.context,
        hostRoom: roomPort(
          () => null,
          () => new Blob(),
          [],
        ),
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
          scheduleIntervalForTests: () => 'host-owner-direct-policy-health',
          cancelIntervalForTests: vi.fn(),
        },
      });

      const published = await owner.publishPrepared(prepared);
      expect(published.offer.transport).toBe('peer-range');
      if (published.offer.transport !== 'peer-range') throw new Error('direct offer unavailable');
      requestPeerRange(pair, owner, {
        sourceIdentity: published.offer.sourceIdentity,
        handleId: published.offer.handleId,
        totalLength: published.offer.encodedSize,
        requestId: '98000000-0000-4000-8000-000000000091',
      });
      await drain(64);

      expect(resolvePrepared).toHaveBeenCalledTimes(2);
      expect(resolvePrepared.mock.calls.map(([options]) => options.peerRangeManifest)).toEqual([
        null,
        null,
      ]);
      expect(
        required.filter(
          (frame) => (frame as { type?: string }).type === 'FILE_MEDIA_SOURCE_OFFER_V2',
        ),
      ).toEqual([published.offer]);
      owner.port().revoke(pair.context);
    },
  );

  it('serves one opt-in warm manifest bundle with the exact selector and media-sized offer', async () => {
    const pair = connectionPair(() => 1_000);
    const selector = manifestDiagnostics();
    const sourceLease = warmSourceLease();
    const authority = warmAuthority(
      pair,
      sourceLease,
      'warm-manifest',
      'host-owner-warm-manifest-source',
      selector,
    );
    const bundle = manifestBundle(selector);
    const expectedBundleSize = derivePeerRangeManifestBundleSize(
      authority.asset.encodedSize,
      selector.manifestByteLength,
    );
    if (expectedBundleSize === null) throw new Error('fixture bundle size unavailable');
    const timers = offerTimers();
    const required: unknown[] = [];
    const closes: ReturnType<typeof vi.fn>[] = [];
    const resolveWarm = vi.fn(async (_options: ResolveWarmHostPeerRangeSourceOptions) => {
      const close = vi.fn(async () => undefined);
      closes.push(close);
      return encodedBundleSource(authority.asset, bundle.bytes, close);
    });
    const owner = new FilePlaybackProductHostMediaOwner({
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolveWarmPeerRangeSource: resolveWarm,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-warm-manifest-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const published = await owner.publishSourceLease(authority);
    expect(published.offer).toMatchObject({
      transport: 'peer-range-manifest',
      encodedSize: authority.asset.encodedSize,
      manifestByteLength: selector.manifestByteLength,
      manifestSha256B64: selector.manifestSha256B64,
    });
    if (published.offer.transport !== 'peer-range-manifest') {
      throw new Error('warm manifest offer unavailable');
    }
    expect(expectedBundleSize).toBe(bundle.bytes.byteLength);
    expect(resolveWarm).toHaveBeenCalledOnce();
    expect(resolveWarm.mock.calls[0]?.[0].peerRangeManifest).toBe(selector);
    expect(closes[0]).toHaveBeenCalledOnce();

    const requestId = '98000000-0000-4000-8000-000000000092';
    requestPeerRange(pair, owner, {
      sourceIdentity: published.offer.sourceIdentity,
      handleId: published.offer.handleId,
      offset: selector.manifestByteLength - 2,
      totalLength: 4,
      requestId,
    });
    await drain(64);
    expect(resolveWarm).toHaveBeenCalledTimes(2);
    expect(resolveWarm.mock.calls.map(([options]) => options.peerRangeManifest)).toEqual([
      selector,
      selector,
    ]);
    expect(peerRangeChunkBytes(required, requestId)).toEqual(
      Uint8Array.of(
        bundle.manifestBytes.at(-2)!,
        bundle.manifestBytes.at(-1)!,
        bundle.mediaBytes[0]!,
        bundle.mediaBytes[1]!,
      ),
    );
    owner.port().revoke(pair.context);
    await drain(64);
    expect(closes[1]).toHaveBeenCalledOnce();
  });

  it('offers and serves an opt-in prepared manifest bundle through its exact selector', async () => {
    const pair = connectionPair(() => 1_000);
    const selector = manifestDiagnostics();
    const prepared = preparedTrack('bounded-stream', 4, undefined, null, selector);
    const bundle = manifestBundle(selector);
    const required: unknown[] = [];
    const resolvePrepared = vi.fn(async (_options: ResolvePreparedHostPeerRangeSourceOptions) =>
      encodedBundleSource(prepared.asset, bundle.bytes),
    );
    const owner = new FilePlaybackProductHostMediaOwner({
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
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
        scheduleIntervalForTests: () => 'host-owner-prepared-manifest-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    const published = await owner.publishPrepared(prepared);
    expect(published.offer).toMatchObject({
      transport: 'peer-range-manifest',
      encodedSize: prepared.asset.encodedSize,
      manifestByteLength: selector.manifestByteLength,
      manifestSha256B64: selector.manifestSha256B64,
    });
    if (published.offer.transport !== 'peer-range-manifest') {
      throw new Error('prepared manifest offer unavailable');
    }
    expect(resolvePrepared.mock.calls[0]?.[0].peerRangeManifest).toBe(selector);
    const requestId = '98000000-0000-4000-8000-000000000093';
    requestPeerRange(pair, owner, {
      sourceIdentity: published.offer.sourceIdentity,
      handleId: published.offer.handleId,
      offset: selector.manifestByteLength,
      totalLength: prepared.asset.encodedSize,
      requestId,
    });
    await drain(64);
    expect(resolvePrepared).toHaveBeenCalledTimes(2);
    expect(resolvePrepared.mock.calls.map(([options]) => options.peerRangeManifest)).toEqual([
      selector,
      selector,
    ]);
    expect(peerRangeChunkBytes(required, requestId)).toEqual(bundle.mediaBytes);
    owner.port().revoke(pair.context);
  });

  it.each([
    ['media-sized source', 4],
    ['incorrect bundle-sized source', 133],
  ])('rejects a manifest plan with a %s before publishing', async (_label, resolvedSourceSize) => {
    const pair = connectionPair(() => 1_000);
    const selector = manifestDiagnostics();
    const prepared = preparedTrack('bounded-stream', 4, undefined, null, selector);
    const closeSource = vi.fn(async () => undefined);
    const resolvePrepared = vi.fn(async (_options: ResolvePreparedHostPeerRangeSourceOptions) =>
      encodedBundleSource(prepared.asset, new Uint8Array(resolvedSourceSize), closeSource),
    );
    const required: unknown[] = [];
    const owner = new FilePlaybackProductHostMediaOwner({
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
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
        scheduleIntervalForTests: () => 'host-owner-invalid-manifest-bundle-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    await expect(owner.publishPrepared(prepared)).rejects.toThrow(/exact candidate binding/u);
    expect(resolvePrepared).toHaveBeenCalledOnce();
    expect(resolvePrepared.mock.calls[0]?.[0].peerRangeManifest).toBe(selector);
    expect(resolvePrepared.mock.calls.some(([options]) => options.peerRangeManifest === null)).toBe(
      false,
    );
    expect(closeSource).toHaveBeenCalledOnce();
    expect(
      required.filter(
        (frame) => (frame as { type?: string }).type === 'FILE_MEDIA_SOURCE_OFFER_V2',
      ),
    ).toEqual([]);
    owner.port().revoke(pair.context);
  });

  it('does not retry a failed prepared manifest request with the direct selector', async () => {
    const pair = connectionPair(() => 1_000);
    const selector = manifestDiagnostics();
    const prepared = preparedTrack('bounded-stream', 4, undefined, null, selector);
    const bundle = manifestBundle(selector);
    const required: unknown[] = [];
    let resolution = 0;
    const resolvePrepared = vi.fn(async (options: ResolvePreparedHostPeerRangeSourceOptions) => {
      if (options.peerRangeManifest === null) {
        throw new Error('fixture observed forbidden direct fallback');
      }
      resolution += 1;
      if (resolution === 1) return encodedBundleSource(prepared.asset, bundle.bytes);
      throw new Error('fixture manifest request failed');
    });
    const owner = new FilePlaybackProductHostMediaOwner({
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
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
        scheduleIntervalForTests: () => 'host-owner-prepared-manifest-failure-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    const published = await owner.publishPrepared(prepared);
    if (published.offer.transport !== 'peer-range-manifest') {
      throw new Error('prepared manifest offer unavailable');
    }
    requestPeerRange(pair, owner, {
      sourceIdentity: published.offer.sourceIdentity,
      handleId: published.offer.handleId,
      totalLength: 1,
      requestId: '98000000-0000-4000-8000-000000000094',
    });
    await drain(64);

    expect(resolvePrepared).toHaveBeenCalledTimes(2);
    expect(resolvePrepared.mock.calls.map(([options]) => options.peerRangeManifest)).toEqual([
      selector,
      selector,
    ]);
    expect(
      required.filter(
        (frame) => (frame as { type?: string }).type === 'FILE_MEDIA_SOURCE_OFFER_V2',
      ),
    ).toEqual([published.offer]);
    expect(required.some((frame) => (frame as { type?: string }).type === 'error')).toBe(true);
    owner.port().revoke(pair.context);
  });

  it('serves a current manifest offer only through the exact current selector', async () => {
    const pair = connectionPair(() => 1_000);
    const selector = manifestDiagnostics();
    const media = new Blob([Uint8Array.of(201, 202, 203, 204)], { type: 'audio/aac' });
    const current = publication('bounded-stream', media, 'playing', selector);
    const bundle = manifestBundle(selector);
    const required: unknown[] = [];
    const resolveCurrent = vi.fn(async (_options: ResolveHostPeerRangeSourceOptions) =>
      encodedBundleSource(current.asset, bundle.bytes),
    );
    const room: FilePlaybackProductHostMediaRoomPort = {
      currentPeerPublication: () => current,
      resolveCurrentPeerRangeSource: resolveCurrent,
      recoverRemoteParticipant: vi.fn(),
    };
    const owner = new FilePlaybackProductHostMediaOwner({
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
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
        scheduleIntervalForTests: () => 'host-owner-current-manifest-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    const published = await owner.publishCurrent();
    expect(published.offer.transport).toBe('peer-range-manifest');
    if (published.offer.transport !== 'peer-range-manifest') {
      throw new Error('current manifest offer unavailable');
    }
    const requestId = '98000000-0000-4000-8000-000000000095';
    requestPeerRange(pair, owner, {
      sourceIdentity: published.offer.sourceIdentity,
      handleId: published.offer.handleId,
      totalLength: 4,
      requestId,
    });
    await drain(64);
    expect(resolveCurrent).toHaveBeenCalledOnce();
    expect(resolveCurrent.mock.calls[0]?.[0]).toMatchObject({
      publication: current,
      sourceIdentity: current.asset.binding.sourceIdentity,
    });
    expect(resolveCurrent.mock.calls[0]?.[0].peerRangeManifest).toBe(selector);
    expect(peerRangeChunkBytes(required, requestId)).toEqual(bundle.manifestBytes.slice(0, 4));
    owner.port().revoke(pair.context);
  });

  it('transfers equal manifest values across distinct warm, prepared, and current selectors', async () => {
    const pair = connectionPair(() => 1_000);
    const sourceLease = warmSourceLease();
    const warmSelector = manifestDiagnostics();
    const preparedSelector = manifestDiagnostics();
    const currentSelector = manifestDiagnostics();
    expect(preparedSelector).not.toBe(warmSelector);
    expect(currentSelector).not.toBe(preparedSelector);
    const prepared = preparedTrack('bounded-stream', 4, undefined, sourceLease, preparedSelector);
    const authority = matchingWarmAuthorityWithManifest(pair, sourceLease, prepared, warmSelector);
    const bundle = manifestBundle(warmSelector);
    const timers = offerTimers();
    const required: unknown[] = [];
    let current: Readonly<HostPeerPlaybackPublication> | null = null;
    const resolveWarm = vi.fn(async (_options: ResolveWarmHostPeerRangeSourceOptions) =>
      encodedBundleSource(authority.asset, bundle.bytes),
    );
    const resolvePrepared = vi.fn(async (_options: ResolvePreparedHostPeerRangeSourceOptions) =>
      encodedBundleSource(prepared.asset, bundle.bytes),
    );
    const resolveCurrent = vi.fn(async (_options: ResolveHostPeerRangeSourceOptions) => {
      if (!current) throw new Error('fixture current publication unavailable');
      return encodedBundleSource(current.asset, bundle.bytes);
    });
    const room: FilePlaybackProductHostMediaRoomPort = {
      currentPeerPublication: () => current,
      resolveCurrentPeerRangeSource: resolveCurrent,
      recoverRemoteParticipant: vi.fn(),
    };
    const owner = new FilePlaybackProductHostMediaOwner({
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
      context: pair.context,
      hostRoom: room,
      publisher: publisher(),
      resolvePreparedPeerRangeSource: resolvePrepared,
      resolveWarmPeerRangeSource: resolveWarm,
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-manifest-transfer-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const warm = await owner.publishSourceLease(authority);
    const candidate = await owner.publishPrepared(prepared);
    expect(candidate.offer).toBe(warm.offer);
    expect(candidate.offer.transport).toBe('peer-range-manifest');
    expect(resolveWarm.mock.calls[0]?.[0].peerRangeManifest).toBe(warmSelector);
    expect(resolvePrepared.mock.calls[0]?.[0].peerRangeManifest).toBe(preparedSelector);
    expect(
      required.filter(
        (frame) => (frame as { type?: string }).type === 'FILE_MEDIA_SOURCE_OFFER_V2',
      ),
    ).toEqual([warm.offer]);

    await owner.bindPrepared(prepared);
    const timeline = committedTimeline();
    const committed = committedPreparedPublication(prepared, timeline);
    current = freezeCanonical({
      ...committed,
      asset: freezeCanonical({
        ...committed.asset,
        binding: freezeCanonical({ ...committed.asset.binding }),
        metadata: freezeCanonical({ ...committed.asset.metadata }),
        peerRangeManifest: currentSelector,
      }),
    });
    const activated = owner.activatePrepared({
      prepared,
      timeline,
      initialCohortAdmitted: false,
    });
    expect(activated.offer).toBe(warm.offer);
    if (activated.offer.transport !== 'peer-range-manifest') {
      throw new Error('activated manifest offer unavailable');
    }
    requestPeerRange(pair, owner, {
      sourceIdentity: activated.offer.sourceIdentity,
      handleId: activated.offer.handleId,
      offset: currentSelector.manifestByteLength - 1,
      totalLength: 2,
      requestId: '98000000-0000-4000-8000-000000000096',
    });
    await drain(64);
    expect(resolveCurrent).toHaveBeenCalledOnce();
    expect(resolveCurrent.mock.calls[0]?.[0].peerRangeManifest).toBe(currentSelector);
    expect(
      required.filter(
        (frame) => (frame as { type?: string }).type === 'FILE_MEDIA_SOURCE_OFFER_V2',
      ),
    ).toEqual([warm.offer]);
    owner.port().revoke(pair.context);
  });

  it.each([
    ['codec', { codec: 'mp3-no-frame-count' as const }],
    ['manifest length', { manifestByteLength: 129 }],
    ['manifest hash', { manifestSha256B64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }],
  ])('rejects a same-lease prepared %s mismatch before transfer', async (_label, overrides) => {
    const pair = connectionPair(() => 1_000);
    const sourceLease = warmSourceLease();
    const warmSelector = manifestDiagnostics();
    const preparedSelector = manifestDiagnostics(overrides);
    const prepared = preparedTrack('bounded-stream', 4, undefined, sourceLease, preparedSelector);
    const authority = matchingWarmAuthorityWithManifest(pair, sourceLease, prepared, warmSelector);
    const bundle = manifestBundle(warmSelector);
    const timers = offerTimers();
    const required: unknown[] = [];
    const resolvePrepared = vi.fn(async () => encodedBundleSource(prepared.asset, bundle.bytes));
    const owner = new FilePlaybackProductHostMediaOwner({
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: resolvePrepared,
      resolveWarmPeerRangeSource: vi.fn(async () =>
        encodedBundleSource(authority.asset, bundle.bytes),
      ),
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-manifest-mismatch-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const warm = await owner.publishSourceLease(authority);
    await expect(owner.publishPrepared(prepared)).rejects.toThrow(/contradicts|manifest/u);
    expect(resolvePrepared).not.toHaveBeenCalled();
    expect(
      required.filter(
        (frame) => (frame as { type?: string }).type === 'FILE_MEDIA_SOURCE_OFFER_V2',
      ),
    ).toEqual([warm.offer]);
    owner.port().revoke(pair.context);
  });

  it('rejects a warm-manifest to prepared-direct presence mismatch before resolution', async () => {
    const pair = connectionPair(() => 1_000);
    const sourceLease = warmSourceLease();
    const warmSelector = manifestDiagnostics();
    const prepared = preparedTrack('bounded-stream', 4, undefined, sourceLease, null);
    const authority = matchingWarmAuthorityWithManifest(pair, sourceLease, prepared, warmSelector);
    const bundle = manifestBundle(warmSelector);
    const timers = offerTimers();
    const required: unknown[] = [];
    const resolvePrepared = vi.fn(async () => encodedPreparedSource(prepared));
    const owner = new FilePlaybackProductHostMediaOwner({
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
      context: pair.context,
      hostRoom: roomPort(
        () => null,
        () => new Blob(),
        [],
      ),
      publisher: publisher(),
      resolvePreparedPeerRangeSource: resolvePrepared,
      resolveWarmPeerRangeSource: vi.fn(async () =>
        encodedBundleSource(authority.asset, bundle.bytes),
      ),
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-manifest-presence-mismatch-health',
        cancelIntervalForTests: vi.fn(),
        scheduleTimeoutForTests: timers.schedule,
        cancelTimeoutForTests: timers.cancel,
      },
    });

    const warm = await owner.publishSourceLease(authority);
    await expect(owner.publishPrepared(prepared)).rejects.toThrow(/contradicts|manifest/u);
    expect(resolvePrepared).not.toHaveBeenCalled();
    expect(
      required.filter(
        (frame) => (frame as { type?: string }).type === 'FILE_MEDIA_SOURCE_OFFER_V2',
      ),
    ).toEqual([warm.offer]);
    owner.port().revoke(pair.context);
  });

  it('rejects a prepared-to-current manifest mismatch before activation', async () => {
    const pair = connectionPair(() => 1_000);
    const preparedSelector = manifestDiagnostics();
    const currentSelector = manifestDiagnostics({
      manifestSha256B64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    });
    const prepared = preparedTrack('bounded-stream', 4, undefined, null, preparedSelector);
    const bundle = manifestBundle(preparedSelector);
    const required: unknown[] = [];
    let current: Readonly<HostPeerPlaybackPublication> | null = null;
    const room: FilePlaybackProductHostMediaRoomPort = {
      currentPeerPublication: () => current,
      resolveCurrentPeerRangeSource: vi.fn(),
      recoverRemoteParticipant: vi.fn(),
    };
    const owner = new FilePlaybackProductHostMediaOwner({
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
      context: pair.context,
      hostRoom: room,
      publisher: publisher(),
      resolvePreparedPeerRangeSource: vi.fn(async () =>
        encodedBundleSource(prepared.asset, bundle.bytes),
      ),
      sendRequired: (_connection, frame) => {
        required.push(frame);
        return true;
      },
      sendWire: (_connection, lease, payload) => pair.host.createWire(lease, payload),
      closeConnection: vi.fn(),
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-current-manifest-mismatch-health',
        cancelIntervalForTests: vi.fn(),
      },
    });

    const candidate = await owner.publishPrepared(prepared);
    expect(candidate.offer.transport).toBe('peer-range-manifest');
    await owner.bindPrepared(prepared);
    const timeline = committedTimeline();
    const committed = committedPreparedPublication(prepared, timeline);
    current = freezeCanonical({
      ...committed,
      asset: freezeCanonical({
        ...committed.asset,
        peerRangeManifest: currentSelector,
      }),
    });
    const beforeActivation = [...required];
    expect(() =>
      owner.activatePrepared({ prepared, timeline, initialCohortAdmitted: false }),
    ).toThrow(/prepared|manifest/u);
    expect(required).toEqual(beforeActivation);
    owner.port().revoke(pair.context);
  });

  it('publishes pause, paused-seek, and stop successors before their exact timeline updates', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([Uint8Array.of(1, 2, 3)], { type: 'audio/flac' });
    let current: Readonly<HostPeerPlaybackPublication> | null = publication('bounded-stream', blob);
    const required: unknown[] = [];
    const wire: FilePlaybackWireMessage[] = [];
    const closeConnection = vi.fn();
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => current,
        () => blob,
        [],
      ),
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
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-current-transition-health',
        cancelIntervalForTests: vi.fn(),
      },
    });
    await owner.publishCurrent();
    const initial = current;
    if (!initial) throw new Error('fixture initial publication unavailable');

    const paused = sameSourceSuccessorPublication(initial, 2, 'paused', 3, 1_200);
    owner.stageCurrentTransition(
      freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: 1,
        kind: 'pause' as const,
        from: initial.state,
        to: paused.state,
        atRoomTimeMs: 1_200,
        positionSeconds: null,
      }),
    );
    expect(wire.at(-1)).toMatchObject({
      kind: 'file-playback-pause',
      expectedRevision: 1,
      revision: 2,
      atRoomTimeMs: 1_200,
    });
    current = paused;
    owner.commitCurrentTimeline(
      freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: 1,
        kind: 'pause' as const,
        previous: initial.timeline,
        timeline: paused.timeline,
      }),
    );

    const sought = sameSourceSuccessorPublication(paused, 3, 'paused', 24, 1_300);
    owner.stageCurrentTransition(
      freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: 1,
        kind: 'seek' as const,
        from: paused.state,
        to: sought.state,
        atRoomTimeMs: 1_300,
        positionSeconds: 24,
      }),
    );
    expect(wire.at(-1)).toMatchObject({
      kind: 'file-playback-seek',
      expectedRevision: 2,
      revision: 3,
      positionSeconds: 24,
      atRoomTimeMs: 1_300,
    });
    current = sought;
    owner.commitCurrentTimeline(
      freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: 1,
        kind: 'seek' as const,
        previous: paused.timeline,
        timeline: sought.timeline,
      }),
    );

    const stoppedTimeline = freezeCanonical({
      schemaVersion: 1 as const,
      revision: 4,
      phase: 'stopped' as const,
      run: null,
      positionSeconds: 0,
      anchorMonotonicMs: 1_400,
      rate: 1,
    });
    const stoppedState = freezeCanonical({ ...sought.state, revision: 4 });
    owner.stageCurrentTransition(
      freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: 1,
        kind: 'stop' as const,
        from: sought.state,
        to: stoppedState,
        atRoomTimeMs: 1_400,
        positionSeconds: null,
      }),
    );
    expect(wire.at(-1)).toMatchObject({
      kind: 'file-playback-stop',
      expectedRevision: 3,
      revision: 4,
      atRoomTimeMs: 1_400,
    });
    current = null;
    owner.commitCurrentTimeline(
      freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: 1,
        kind: 'stop' as const,
        previous: sought.timeline,
        timeline: stoppedTimeline,
      }),
    );

    expect(
      required.filter(
        (frame) => (frame as { type?: string }).type === 'FILE_PLAYBACK_TIMELINE_UPDATE_V2',
      ),
    ).toMatchObject([
      { revision: 2, phase: 'paused', positionSeconds: 3 },
      { revision: 3, phase: 'paused', positionSeconds: 24 },
      { revision: 4, phase: 'stopped', queueItemId: null, runId: null },
    ]);
    expect(closeConnection).not.toHaveBeenCalled();
    owner.port().revoke(pair.context);
  });

  it('publishes a dedicated natural-end successor before terminal timeline truth', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([Uint8Array.of(7, 8, 9)], { type: 'audio/flac' });
    let current: Readonly<HostPeerPlaybackPublication> | null = publication('bounded-stream', blob);
    const required: unknown[] = [];
    const wire: FilePlaybackWireMessage[] = [];
    const closeConnection = vi.fn();
    const owner = new FilePlaybackProductHostMediaOwner({
      context: pair.context,
      hostRoom: roomPort(
        () => current,
        () => blob,
        [],
      ),
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
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-natural-end-health',
        cancelIntervalForTests: vi.fn(),
      },
    });
    await owner.publishCurrent();
    const initial = current;
    if (!initial) throw new Error('fixture initial publication unavailable');
    const requiredBeforeRemoteEnd = required.length;
    const endedState = freezeCanonical({ ...initial.state, revision: initial.state.revision + 1 });
    const stopped = freezeCanonical({
      schemaVersion: 1 as const,
      revision: endedState.revision,
      phase: 'stopped' as const,
      run: null,
      positionSeconds: 0,
      anchorMonotonicMs: 1_500,
      rate: 1,
    });

    owner.stageRemoteEnd(
      freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: initial.roomGeneration,
        from: initial.state,
        to: endedState,
        hostObservedAtRoomTimeMs: 1_500,
      }),
    );
    expect(wire.at(-1)).toMatchObject({
      kind: 'file-playback-ended',
      expectedRevision: initial.state.revision,
      revision: endedState.revision,
      hostObservedAtRoomTimeMs: 1_500,
    });
    expect(required).toHaveLength(requiredBeforeRemoteEnd);

    current = null;
    owner.commitCurrentTimeline(
      freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: initial.roomGeneration,
        kind: 'ended' as const,
        previous: initial.timeline,
        timeline: stopped,
      }),
    );

    expect(required.at(-1)).toMatchObject({
      type: 'FILE_PLAYBACK_TIMELINE_UPDATE_V2',
      revision: endedState.revision,
      phase: 'stopped',
      queueItemId: null,
      runId: null,
    });
    expect(closeConnection).not.toHaveBeenCalled();
    owner.port().revoke(pair.context);
  });

  it('fails only its connection when a staged current transition commits stale timeline truth', async () => {
    const pair = connectionPair(() => 1_000);
    const blob = new Blob([Uint8Array.of(4, 5, 6)], { type: 'audio/flac' });
    const current = publication('bounded-stream', blob);
    const closeConnection = vi.fn();
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
      closeConnection,
      onHealthSystemMessage: vi.fn(),
      runtimeForTests: {
        createMediaIdForTests: ids(),
        scheduleIntervalForTests: () => 'host-owner-stale-transition-health',
        cancelIntervalForTests: vi.fn(),
      },
    });
    await owner.publishCurrent();
    const paused = sameSourceSuccessorPublication(current, 2, 'paused', 3, 1_200);
    owner.stageCurrentTransition(
      freezeCanonical({
        schemaVersion: 1 as const,
        roomGeneration: 1,
        kind: 'pause' as const,
        from: current.state,
        to: paused.state,
        atRoomTimeMs: 1_200,
        positionSeconds: null,
      }),
    );

    expect(() =>
      owner.commitCurrentTimeline(
        freezeCanonical({
          schemaVersion: 1 as const,
          roomGeneration: 1,
          kind: 'pause' as const,
          previous: current.timeline,
          timeline: freezeCanonical({ ...paused.timeline, revision: 3 }),
        }),
      ),
    ).toThrow(/timeline|connection/u);
    expect(closeConnection).toHaveBeenCalledOnce();
  });
});
