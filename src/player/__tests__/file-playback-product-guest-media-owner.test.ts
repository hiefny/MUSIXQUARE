// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { FilePlaybackConnectionChannel } from '../../network/file-playback-connection-channel.ts';
import {
  FilePlaybackGuestSessionHandshake,
  FilePlaybackHandshakeIdIssuer,
  FilePlaybackHostSessionHandshake,
} from '../../network/file-playback-session-handshake.ts';
import type {
  FilePlaybackAuxiliaryAdoptionEvent,
  FilePlaybackPeerRangeAdoptionEvent,
  FilePlaybackWireAdoptionEvent,
} from '../../network/file-playback-application-session.ts';
import type { DataConnection, QueueItemId } from '../../types/index.ts';
import { getFilePlaybackUniversalLifecycleSnapshotForTests } from '../diagnostics/file-playback-universal-lifecycle-diagnostics.ts';
import { FilePlaybackAssetRegistry } from '../file-playback-asset-registry.ts';
import {
  FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
  type FilePlaybackBoundedRoutePolicy,
} from '../file-playback-bounded-route-policy.ts';
import type {
  FilePlaybackWarmSourceAuthority,
  StageFilePlaybackAssetSourceOptions,
  StagedFilePlaybackAssetSource,
} from '../file-playback-asset-source-stager.ts';
import {
  FilePlaybackManager,
  type FilePlaybackCutoverCandidatePort,
} from '../file-playback-manager.ts';
import { createFilePlaybackRemoteEndedTransitionEvidence } from '../file-playback-remote-ended-transition.ts';
import {
  createPeerRangeFileMediaSourceOfferV2,
  createPeerRangeManifestFileMediaSourceOfferV2,
  createR2WholeBlobFileMediaSourceOfferV2,
  type FileMediaSourceOfferV2,
} from '../file-media-source-offer.ts';
import { createFileMediaSourceRevokeV2 } from '../file-media-source-revoke.ts';
import {
  createFilePlaybackProductGuestMediaOwner,
  FilePlaybackProductGuestMediaOwnerFatalError,
  type FilePlaybackProductGuestMediaOwnerOptions,
  type FilePlaybackProductGuestMediaOwnerRuntimeForTests,
} from '../file-playback-product-guest-media-owner.ts';
import type { FilePlaybackPeerRangeManifestAdmission } from '../file-playback-peer-range-manifest-acquisition.ts';
import type { FilePlaybackPeerRangeManifestDecoderConstruction } from '../file-playback-peer-range-manifest-decoder-bridge.ts';
import type { FilePlaybackProductSessionRouterConnectionContext } from '../file-playback-product-session-router.ts';
import { createFilePlaybackRunBindingV2 } from '../file-playback-run-binding.ts';
import { UnsupportedOrdinaryEncodedSourceError } from '../file-playback-source-factory.ts';
import { PeerRangeEncodedAudioAsset } from '../sources/peer-range-encoded-audio-asset.ts';
import {
  parseFilePlaybackWireMessage,
  type FilePlaybackWireMessage,
} from '../file-playback-wire.ts';
import type { PlaybackStateIdentity } from '../playback-identity.ts';
import type { RendezvousArmIntent, RendezvousFinalizeIntent } from '../rendezvous-contract.ts';

const HOST_ID = 'guest-owner-host';
const GUEST_ID = 'guest-owner-guest';
const QUEUE_ID = '97000000-0000-4000-8000-000000000001' as QueueItemId;
const PREPARE_ID = '97000000-0000-4000-8000-000000000002';
const SOURCE_ID = 'guest-owner-source';
const TRANSFER_ID = 'guest-owner-transfer';
const HANDLE_ID = 'guest-owner-handle';
const RUN_ID = '97000000-0000-4000-8000-000000000004';
const RENDEZVOUS_ID = 'guest-owner-rendezvous';
const QUEUE_ID_2 = '97000000-0000-4000-8000-000000000011' as QueueItemId;
const PREPARE_ID_2 = '97000000-0000-4000-8000-000000000012';
const SOURCE_ID_2 = 'guest-owner-source-2';
const TRANSFER_ID_2 = 'guest-owner-transfer-2';
const HANDLE_ID_2 = 'guest-owner-handle-2';
const RUN_ID_2 = '97000000-0000-4000-8000-000000000014';
const RENDEZVOUS_ID_2 = 'guest-owner-rendezvous-2';
const PREPARE_ID_3 = '97000000-0000-4000-8000-000000000022';
const SOURCE_ID_3 = 'guest-owner-source-3';
const TRANSFER_ID_3 = 'guest-owner-transfer-3';
const HANDLE_ID_3 = 'guest-owner-handle-3';
const ROOM_TOKEN = Object.freeze({ room: 'guest-owner' });
const CUTOVER_PORT = Object.freeze(Object.create(null)) as FilePlaybackCutoverCandidatePort;
const MP3_ONLY_MANIFEST_POLICY = Object.freeze({
  mode: 'format-gated-v1' as const,
  mp3: 'bounded-stream' as const,
  m4aAacLc: 'current' as const,
  rawAdtsAac: 'current' as const,
});
const ADTS_ONLY_MANIFEST_POLICY = Object.freeze({
  mode: 'format-gated-v1' as const,
  mp3: 'current' as const,
  m4aAacLc: 'current' as const,
  rawAdtsAac: 'webcodecs' as const,
});

type ManifestConstructionDiagnostics = Pick<
  FilePlaybackPeerRangeManifestDecoderConstruction,
  'codec' | 'queueItemId' | 'sourceIdentity' | 'sourceSize'
>;

let handshakeSequence = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function establishedHandshakes() {
  handshakeSequence += 1;
  const issuer = (prefix: string) =>
    new FilePlaybackHandshakeIdIssuer({
      createSessionId: () => `${prefix}:session:${handshakeSequence}`,
      createConnectionId: () => `${prefix}:connection:${handshakeSequence}`,
      createHelloId: () => `${prefix}:hello:${handshakeSequence}`,
    });
  const hostIssuer = issuer('host');
  const host = new FilePlaybackHostSessionHandshake({
    idIssuer: hostIssuer,
    sessionId: hostIssuer.issueSessionId(),
    connectionId: hostIssuer.issueConnectionId(),
    hostParticipantId: HOST_ID,
    guestParticipantId: GUEST_ID,
  });
  const guest = new FilePlaybackGuestSessionHandshake({
    idIssuer: issuer('guest'),
    guestParticipantId: GUEST_ID,
  });
  const hello = guest.createHello();
  if (!hello.accepted) throw new Error(hello.reason);
  const welcome = host.handleHello(hello.hello);
  if (!welcome.accepted) throw new Error(welcome.reason);
  const acceptedWelcome = guest.handleWelcome(welcome.welcome);
  if (!acceptedWelcome.accepted) throw new Error(acceptedWelcome.reason);
  const snapshot = host.createSnapshot();
  if (!snapshot.accepted) throw new Error(snapshot.reason);
  const acceptedSnapshot = guest.acceptSnapshot(snapshot.snapshot);
  if (!acceptedSnapshot.accepted) throw new Error(acceptedSnapshot.reason);
  const applied = guest.createApplied();
  if (!applied.accepted) throw new Error(applied.reason);
  const acceptedApplied = host.handleApplied(applied.applied);
  if (!acceptedApplied.accepted) throw new Error(acceptedApplied.reason);
  return { host, guest };
}

function connection(label: string): DataConnection {
  return {
    peer: label,
    open: true,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as DataConnection;
}

function channelPair() {
  const handshakes = establishedHandshakes();
  const hostConnection = connection('host-connection');
  const guestConnection = connection('guest-connection');
  let now = 100;
  const host = new FilePlaybackConnectionChannel(handshakes.host, hostConnection, {
    now: () => now,
  });
  const guest = new FilePlaybackConnectionChannel(handshakes.guest, guestConnection, {
    now: () => now,
    guestAppliedSendConfirmed: true,
  });
  for (let index = 0; index < 5; index += 1) {
    now += 10;
    const ping = guest.createClockPing();
    const hostResult = host.receive(ping, hostConnection);
    if (!hostResult.accepted || hostResult.frame !== 'clock-ping') {
      throw new Error('Host clock calibration failed');
    }
    now += 1;
    const guestResult = guest.receive(hostResult.pong, guestConnection);
    if (!guestResult.accepted || guestResult.frame !== 'clock-pong') {
      throw new Error('Guest clock calibration failed');
    }
  }
  expect(guest.clockReady()).toBe(true);
  const binding = guest.establishedBinding();
  if (!binding) throw new Error('Missing guest binding');
  const context = freezeCanonical({
    schemaVersion: 1 as const,
    role: 'guest' as const,
    connection: guestConnection,
    channel: guest,
    connectionToken: guestConnection,
    routerToken: Object.freeze(Object.create(null) as object),
    sessionId: binding.sessionId,
    connectionId: binding.connectionId,
    hostParticipantId: binding.hostParticipantId,
    guestParticipantId: binding.guestParticipantId,
  });
  return {
    host,
    guest,
    hostConnection,
    guestConnection,
    context,
    now: () => now,
  };
}

function timelineEvent(context: Readonly<FilePlaybackProductSessionRouterConnectionContext>) {
  return freezeCanonical({
    schemaVersion: 1 as const,
    roomGeneration: 1,
    sessionId: context.sessionId,
    connectionId: context.connectionId,
    status: 'adopted' as const,
    timeline: freezeCanonical({
      schemaVersion: 1 as const,
      revision: 1,
      phase: 'playing' as const,
      run: freezeCanonical({ queueItemId: QUEUE_ID, runId: RUN_ID }),
      positionSeconds: 0,
      anchorMonotonicMs: 100,
      rate: 1,
    }),
  });
}

function pausedTimelineEvent(context: Readonly<FilePlaybackProductSessionRouterConnectionContext>) {
  return freezeCanonical({
    schemaVersion: 1 as const,
    roomGeneration: 1,
    sessionId: context.sessionId,
    connectionId: context.connectionId,
    status: 'adopted' as const,
    timeline: freezeCanonical({
      schemaVersion: 1 as const,
      revision: 1,
      phase: 'paused' as const,
      run: freezeCanonical({ queueItemId: QUEUE_ID, runId: RUN_ID }),
      positionSeconds: 12,
      anchorMonotonicMs: 100,
      rate: 1,
    }),
  });
}

function stoppedTimelineEvent(
  context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
) {
  return freezeCanonical({
    schemaVersion: 1 as const,
    roomGeneration: 1,
    sessionId: context.sessionId,
    connectionId: context.connectionId,
    status: 'adopted' as const,
    timeline: freezeCanonical({
      schemaVersion: 1 as const,
      revision: 0,
      phase: 'stopped' as const,
      run: null,
      positionSeconds: 0,
      anchorMonotonicMs: 100,
      rate: 1,
    }),
  });
}

function timelineUpdated(
  context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
  timeline: Readonly<{
    schemaVersion: 1;
    revision: number;
    phase: 'stopped' | 'playing' | 'paused';
    run: Readonly<{ queueItemId: QueueItemId; runId: string }> | null;
    positionSeconds: number;
    anchorMonotonicMs: number;
    rate: number;
  }>,
) {
  return freezeCanonical({
    schemaVersion: 1 as const,
    roomGeneration: 1,
    sessionId: context.sessionId,
    connectionId: context.connectionId,
    timeline,
  });
}

function activeTimeline(
  state: Readonly<PlaybackStateIdentity>,
  phase: 'playing' | 'paused',
  positionSeconds: number,
  anchorMonotonicMs: number,
) {
  return freezeCanonical({
    schemaVersion: 1 as const,
    revision: state.revision,
    phase,
    run: freezeCanonical({ queueItemId: state.queueItemId, runId: state.runId }),
    positionSeconds,
    anchorMonotonicMs,
    rate: 1,
  });
}

function stoppedTimeline(revision: number, anchorMonotonicMs: number) {
  return freezeCanonical({
    schemaVersion: 1 as const,
    revision,
    phase: 'stopped' as const,
    run: null,
    positionSeconds: 0,
    anchorMonotonicMs,
    rate: 1,
  });
}

function peerOffer(context: Readonly<FilePlaybackProductSessionRouterConnectionContext>) {
  return createPeerRangeFileMediaSourceOfferV2({
    sessionId: context.sessionId,
    connectionId: context.connectionId,
    prepareId: PREPARE_ID,
    prepareRevision: 1,
    queueItemId: QUEUE_ID,
    sourceIdentity: SOURCE_ID,
    transferSessionId: TRANSFER_ID,
    handleId: HANDLE_ID,
    encodedSize: 4_096,
    name: 'orchestra.flac',
    mime: 'audio/flac',
    expiresAtRoomTimeMs: 10_000,
  });
}

function gatedManifestOffer(context: Readonly<FilePlaybackProductSessionRouterConnectionContext>) {
  return createPeerRangeManifestFileMediaSourceOfferV2({
    sessionId: context.sessionId,
    connectionId: context.connectionId,
    prepareId: PREPARE_ID,
    prepareRevision: 1,
    queueItemId: QUEUE_ID,
    sourceIdentity: SOURCE_ID,
    transferSessionId: TRANSFER_ID,
    handleId: HANDLE_ID,
    encodedSize: 4_096,
    manifestByteLength: 128,
    manifestSha256B64: btoa('\0'.repeat(32)),
    name: 'orchestra.flac',
    mime: 'audio/flac',
    expiresAtRoomTimeMs: 10_000,
  });
}

function peerOffer2(context: Readonly<FilePlaybackProductSessionRouterConnectionContext>) {
  return createPeerRangeFileMediaSourceOfferV2({
    sessionId: context.sessionId,
    connectionId: context.connectionId,
    prepareId: PREPARE_ID_2,
    prepareRevision: 2,
    queueItemId: QUEUE_ID_2,
    sourceIdentity: SOURCE_ID_2,
    transferSessionId: TRANSFER_ID_2,
    handleId: HANDLE_ID_2,
    encodedSize: 4_096,
    name: 'successor.flac',
    mime: 'audio/flac',
    expiresAtRoomTimeMs: 10_000,
  });
}

function peerOffer3(context: Readonly<FilePlaybackProductSessionRouterConnectionContext>) {
  return createPeerRangeFileMediaSourceOfferV2({
    sessionId: context.sessionId,
    connectionId: context.connectionId,
    prepareId: PREPARE_ID_3,
    prepareRevision: 3,
    queueItemId: QUEUE_ID_2,
    sourceIdentity: SOURCE_ID_3,
    transferSessionId: TRANSFER_ID_3,
    handleId: HANDLE_ID_3,
    encodedSize: 4_096,
    name: 'replacement-successor.flac',
    mime: 'audio/flac',
    expiresAtRoomTimeMs: 10_000,
  });
}

function supersedingPeerOffer(
  context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
) {
  return createPeerRangeFileMediaSourceOfferV2({
    sessionId: context.sessionId,
    connectionId: context.connectionId,
    prepareId: PREPARE_ID_2,
    prepareRevision: 2,
    queueItemId: QUEUE_ID,
    sourceIdentity: SOURCE_ID_2,
    transferSessionId: TRANSFER_ID_2,
    handleId: HANDLE_ID_2,
    encodedSize: 8_192,
    name: 'replacement.flac',
    mime: 'audio/flac',
    expiresAtRoomTimeMs: 10_000,
  });
}

function r2ReplayOffer(context: Readonly<FilePlaybackProductSessionRouterConnectionContext>) {
  const original = r2Offer(context);
  return createR2WholeBlobFileMediaSourceOfferV2({
    sessionId: original.sessionId,
    connectionId: original.connectionId,
    prepareId: PREPARE_ID_2,
    prepareRevision: 2,
    queueItemId: original.queueItemId,
    sourceIdentity: original.sourceIdentity,
    transferSessionId: original.transferSessionId,
    storageRoomId: original.storageRoomId,
    objectId: original.objectId,
    encodedSize: original.encodedSize,
    encryptedSize: original.encryptedSize,
    keyB64: original.keyB64,
    ivB64: original.ivB64,
    name: original.name,
    mime: original.mime,
    expiresAtRoomTimeMs: original.expiresAtRoomTimeMs,
  });
}

function r2Offer(context: Readonly<FilePlaybackProductSessionRouterConnectionContext>) {
  return createR2WholeBlobFileMediaSourceOfferV2({
    sessionId: context.sessionId,
    connectionId: context.connectionId,
    prepareId: PREPARE_ID,
    prepareRevision: 1,
    queueItemId: QUEUE_ID,
    sourceIdentity: SOURCE_ID,
    transferSessionId: TRANSFER_ID,
    storageRoomId: 'room_1',
    objectId: '97000000-0000-4000-8000-000000000003',
    encodedSize: 4,
    encryptedSize: 20,
    keyB64: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    ivB64: btoa(String.fromCharCode(...new Uint8Array(12).fill(9))),
    name: 'ordinary.wav',
    mime: 'audio/wav',
    expiresAtRoomTimeMs: 10_000,
  });
}

function runBinding(offer: Readonly<FileMediaSourceOfferV2>, runId = RUN_ID, playbackRevision = 1) {
  return createFilePlaybackRunBindingV2({
    sessionId: offer.sessionId,
    connectionId: offer.connectionId,
    prepareId: offer.prepareId,
    prepareRevision: offer.prepareRevision,
    queueItemId: offer.queueItemId,
    sourceIdentity: offer.sourceIdentity,
    transferSessionId: offer.transferSessionId,
    runId,
    playbackRevision,
  });
}

function revokeFor(offer: Readonly<FileMediaSourceOfferV2>) {
  return createFileMediaSourceRevokeV2({
    sessionId: offer.sessionId,
    connectionId: offer.connectionId,
    prepareId: offer.prepareId,
    prepareRevision: offer.prepareRevision,
    queueItemId: offer.queueItemId,
    sourceIdentity: offer.sourceIdentity,
    transferSessionId: offer.transferSessionId,
  });
}

function auxiliaryEvent(
  context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
  frame: Readonly<Record<string, string | number>>,
): Readonly<FilePlaybackAuxiliaryAdoptionEvent> {
  return freezeCanonical({
    frame,
    connection: context.connection,
    channel: context.channel,
    connectionToken: context.connectionToken,
  });
}

function peerEvent(
  context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
  frame: unknown,
): Readonly<FilePlaybackPeerRangeAdoptionEvent> {
  return freezeCanonical({
    frame,
    lane: 'bulk' as const,
    role: 'guest' as const,
    connection: context.connection,
    channel: context.channel,
    connectionToken: context.connectionToken,
  });
}

function wireEvent(
  context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
  result: Extract<
    ReturnType<FilePlaybackConnectionChannel['receive']>,
    { accepted: true; frame: 'wire' }
  >,
): Readonly<FilePlaybackWireAdoptionEvent> {
  return freezeCanonical({
    message: result.message,
    connection: context.connection,
    channel: context.channel,
    stateLease: result.stateLease,
    attemptLease: result.attemptLease,
  });
}

function fakeAudioContext(): AudioContext {
  return {
    state: 'running',
    sampleRate: 48_000,
    currentTime: 0,
  } as AudioContext;
}

function audioGraph() {
  const audioContext = fakeAudioContext();
  return freezeCanonical({
    audioContext,
    destination: { context: audioContext } as unknown as AudioNode,
  });
}

function stagedAssetSource(
  registry: FilePlaybackAssetRegistry,
  options: Pick<StageFilePlaybackAssetSourceOptions, 'assetLease'>,
  cutoverPort: FilePlaybackCutoverCandidatePort = CUTOVER_PORT,
): Readonly<StagedFilePlaybackAssetSource> {
  const asset = registry.snapshotForLease(ROOM_TOKEN, options.assetLease);
  if (!asset) throw new Error('missing staged asset');
  const backend = asset.kind === 'blob' ? ('audio-buffer' as const) : ('bounded-stream' as const);
  return freezeCanonical({
    cutoverPort,
    backend,
    sourceIdentity: asset.sourceIdentity,
    asset,
    metadata: freezeCanonical({ name: asset.name, mime: asset.mime }),
    readiness: freezeCanonical({
      durationSeconds: 120,
      bufferedAheadSeconds: asset.kind === 'blob' ? 120 : 8,
      outputSampleRateHz: 48_000,
      channelCount: 2,
    }),
  });
}

function runtimeHarness(
  registry: FilePlaybackAssetRegistry,
  state: Readonly<PlaybackStateIdentity>,
) {
  let currentState = state;
  let currentPhase: 'playing' | 'paused' | 'ended' = 'playing';
  let hasCurrentPort = true;
  let physicalRecoveryRequired = false;
  let candidateBackend: 'audio-buffer' | 'bounded-stream' = 'bounded-stream';
  let currentBackend: 'audio-buffer' | 'bounded-stream' = 'bounded-stream';
  let timeoutSequence = 0;
  const scheduledTimeouts = new Map<string, Readonly<{ callback: () => void; delayMs: number }>>();
  const cancelledTimeouts = new Map<string, Readonly<{ callback: () => void; delayMs: number }>>();
  const scheduleTimeoutForTests = vi.fn((callback: () => void, delayMs: number) => {
    const handle = `guest-renderer-health-${++timeoutSequence}`;
    scheduledTimeouts.set(handle, freezeCanonical({ callback, delayMs }));
    return handle;
  });
  const cancelTimeoutForTests = vi.fn((handle: string) => {
    const timer = scheduledTimeouts.get(handle);
    if (timer) cancelledTimeouts.set(handle, timer);
    scheduledTimeouts.delete(handle);
  });
  const sent: unknown[] = [];
  const peerAcceptBulk = vi.fn(() => 'accepted' as never);
  const peerClose = vi.fn();
  const peerCloseHandle = vi.fn();
  const peerTransport = {
    read: vi.fn(async () => new Uint8Array()),
    acceptBulk: peerAcceptBulk,
    close: peerClose,
    closeHandle: peerCloseHandle,
  };
  const manifestEvents: string[] = [];
  const manifestAdmissions: FilePlaybackPeerRangeManifestAdmission[] = [];
  const manifestConstructions: FilePlaybackPeerRangeManifestDecoderConstruction[] = [];
  let manifestCodec: ManifestConstructionDiagnostics['codec'] = 'mp3-no-frame-count';
  let manifestConstructionOverrides: Partial<ManifestConstructionDiagnostics> = {};
  const acquireManifestAsset: NonNullable<
    FilePlaybackProductGuestMediaOwnerRuntimeForTests['acquireManifestAsset']
  > = vi.fn(async ({ operation }) => {
    if (operation.offer.transport !== 'peer-range-manifest') {
      throw new Error('fixture expected a manifest operation');
    }
    manifestEvents.push('acquire');
    const binding = freezeCanonical({
      queueItemId: operation.binding.queueItemId,
      sourceIdentity: operation.binding.sourceIdentity,
      transferSessionId: operation.binding.transferSessionId,
    });
    const asset = new PeerRangeEncodedAudioAsset({
      size: operation.offer.encodedSize,
      identity: operation.offer.sourceIdentity,
      metadata: { name: operation.offer.name, mime: operation.offer.mime },
      transport: peerTransport,
      handleId: operation.offer.handleId,
    });
    const assetLease = registry.admitEncodedAsset(ROOM_TOKEN, binding, asset);
    const manifestAdmission = freezeCanonical({
      sequence: manifestAdmissions.length + 1,
    }) as unknown as FilePlaybackPeerRangeManifestAdmission;
    manifestAdmissions.push(manifestAdmission);
    return freezeCanonical({
      assetLease,
      asset: registry.snapshotForLease(ROOM_TOKEN, assetLease)!,
      manifestAdmission,
    });
  });
  const prepareManifestDecoderConstruction: NonNullable<
    FilePlaybackProductGuestMediaOwnerRuntimeForTests['prepareManifestDecoderConstruction']
  > = vi.fn(async ({ assetLease }) => {
    manifestEvents.push('prepare-construction');
    const asset = registry.snapshotForLease(ROOM_TOKEN, assetLease);
    if (!asset) throw new Error('missing admitted manifest asset');
    const construction = freezeCanonical({
      codec: manifestConstructionOverrides.codec ?? manifestCodec,
      queueItemId: manifestConstructionOverrides.queueItemId ?? asset.queueItemId,
      sourceIdentity: manifestConstructionOverrides.sourceIdentity ?? asset.sourceIdentity,
      sourceSize: manifestConstructionOverrides.sourceSize ?? asset.size,
    }) as unknown as FilePlaybackPeerRangeManifestDecoderConstruction;
    manifestConstructions.push(construction);
    return construction;
  });
  const retireManifestDecoderConstruction: NonNullable<
    FilePlaybackProductGuestMediaOwnerRuntimeForTests['retireManifestDecoderConstruction']
  > = vi.fn(async () => {
    manifestEvents.push('retire-construction');
    return true;
  });
  const stageManifestAssetSource: NonNullable<
    FilePlaybackProductGuestMediaOwnerRuntimeForTests['stageManifestAssetSource']
  > = vi.fn(async (options) => {
    manifestEvents.push('stage-manifest');
    const staged = stagedAssetSource(registry, options);
    candidateBackend = staged.backend;
    return staged;
  });
  const r2Acquire = vi.fn(async (operation) => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], operation.offer.name, {
      type: operation.offer.mime,
      lastModified: 0,
    });
    const binding = freezeCanonical({
      queueItemId: operation.binding.queueItemId,
      sourceIdentity: operation.binding.sourceIdentity,
      transferSessionId: operation.binding.transferSessionId,
    });
    const lease = registry.admitBlob(ROOM_TOKEN, binding, file, {
      name: operation.offer.name,
      mime: operation.offer.mime,
    });
    return freezeCanonical({
      assetLease: lease,
      asset: registry.snapshotForLease(ROOM_TOKEN, lease)!,
    });
  });
  const r2Close = vi.fn(() => registry.close(ROOM_TOKEN));
  const stageAssetSource = vi.fn(async (options: StageFilePlaybackAssetSourceOptions) => {
    const staged = stagedAssetSource(registry, options);
    candidateBackend = staged.backend;
    return staged;
  });
  const warmRecords = new Map<
    FilePlaybackWarmSourceAuthority,
    Readonly<{
      assetLease: StageFilePlaybackAssetSourceOptions['assetLease'];
      expectedBinding: StageFilePlaybackAssetSourceOptions['expectedBinding'];
    }>
  >();
  const prepareWarmSource: NonNullable<
    FilePlaybackProductGuestMediaOwnerRuntimeForTests['prepareWarmSource']
  > = vi.fn(async (options) => {
    const asset = registry.snapshotForLease(ROOM_TOKEN, options.assetLease);
    if (!asset) throw new Error('missing provisional warm asset');
    const authority = freezeCanonical({
      backend: 'bounded-stream' as const,
      sourceIdentity: asset.sourceIdentity,
      asset,
      metadata: freezeCanonical({ name: asset.name, mime: asset.mime }),
      readiness: freezeCanonical({
        durationSeconds: 120,
        bufferedAheadSeconds: 8,
        outputSampleRateHz: 48_000,
        channelCount: 2,
      }),
    }) as unknown as FilePlaybackWarmSourceAuthority;
    warmRecords.set(
      authority,
      freezeCanonical({
        assetLease: options.assetLease,
        expectedBinding: options.expectedBinding,
      }),
    );
    return authority;
  });
  let liveLeaseObservedAtHandoff: object | null = null;
  const handoffWarmSource: NonNullable<
    FilePlaybackProductGuestMediaOwnerRuntimeForTests['handoffWarmSource']
  > = vi.fn(async (options) => {
    const record = warmRecords.get(options.authority);
    if (!record) throw new Error('missing exact warm authority');
    liveLeaseObservedAtHandoff = registry.leaseForBinding(ROOM_TOKEN, record.expectedBinding);
    const asset = registry.snapshotForLease(ROOM_TOKEN, record.assetLease);
    if (!asset) throw new Error('missing promoted warm asset');
    candidateBackend = 'bounded-stream';
    warmRecords.delete(options.authority);
    return freezeCanonical({
      cutoverPort: CUTOVER_PORT,
      backend: 'bounded-stream' as const,
      sourceIdentity: asset.sourceIdentity,
      asset,
      metadata: freezeCanonical({ name: asset.name, mime: asset.mime }),
      readiness: freezeCanonical({
        durationSeconds: 120,
        bufferedAheadSeconds: 8,
        outputSampleRateHz: 48_000,
        channelCount: 2,
      }),
    }) satisfies Readonly<StagedFilePlaybackAssetSource>;
  });
  const retireWarmSource: NonNullable<
    FilePlaybackProductGuestMediaOwnerRuntimeForTests['retireWarmSource']
  > = vi.fn(async (authority) => warmRecords.delete(authority));
  const arm = vi.fn(async (intent: RendezvousArmIntent) =>
    freezeCanonical({
      protocolVersion: 2 as const,
      kind: 'rendezvous-armed' as const,
      queueItemId: intent.queueItemId,
      runId: intent.runId,
      revision: intent.revision,
      rendezvousId: intent.rendezvousId,
      participantId: intent.recipientId,
      status: 'armed' as const,
      observedAtRoomTimeMs: 150,
      bufferedAheadSeconds: 8,
      reasonCode: null,
    }),
  );
  const finalize = vi.fn(async (intent: RendezvousFinalizeIntent) =>
    freezeCanonical({
      protocolVersion: 2 as const,
      kind: 'rendezvous-finalized' as const,
      queueItemId: intent.queueItemId,
      runId: intent.runId,
      revision: intent.revision,
      rendezvousId: intent.rendezvousId,
      participantId: intent.recipientId,
      status: 'accepted' as const,
      observedAtRoomTimeMs: 170,
      reasonCode: null,
    }),
  );
  const started = vi.fn(async () =>
    freezeCanonical({
      kind: 'worklet-observed' as const,
      targetFrame: 48_000,
      actualStartFrame: 48_000,
    }),
  );
  const commitAttempt = vi.fn(() => true);
  const cancel = vi.fn(async () => undefined);
  const recoveryRequired = vi.fn(() => physicalRecoveryRequired);
  const primeCandidate: NonNullable<
    FilePlaybackProductGuestMediaOwnerRuntimeForTests['primeCandidate']
  > = vi.fn(async (_manager, _port, _positionSeconds, signal) => {
    signal.throwIfAborted();
    return currentSnapshot();
  });
  const retireCandidate = vi.fn(async () => true);
  const retireCurrent = vi.fn(async () => true);
  const currentSnapshot = vi.fn(() => ({
    schemaVersion: 1 as const,
    queueItemId: currentState.queueItemId,
    backend: currentBackend,
    phase: currentPhase,
    revision: currentState.revision,
    run: currentState,
    durationSeconds: 120,
    positionSeconds: 0,
    bufferedAheadSeconds: 8,
    outputSampleRateHz: 48_000,
    channelCount: 2,
    underrunCount: 0,
    errorCode: null,
  }));
  const pauseCurrent: NonNullable<
    FilePlaybackProductGuestMediaOwnerRuntimeForTests['pauseCurrent']
  > = vi.fn(async (_manager, _port, intent) => ({
    status: 'scheduled' as const,
    reason: null,
    from: intent.from,
    to: intent.to,
    target: freezeCanonical({
      audioContext: fakeAudioContext(),
      contextTimeSeconds: intent.atRoomTimeMs / 1_000,
      targetFrame: Math.round(intent.atRoomTimeMs * 48),
    }),
    snapshot: currentSnapshot(),
    applied: Promise.resolve().then(() => {
      currentState = intent.to;
      currentPhase = 'paused';
      return freezeCanonical({
        kind: 'pause-applied' as const,
        observation: 'worklet-observed' as const,
        from: intent.from,
        to: intent.to,
        targetFrame: Math.round(intent.atRoomTimeMs * 48),
        appliedFrame: Math.round(intent.atRoomTimeMs * 48),
      });
    }),
  }));
  const seekCurrent: NonNullable<FilePlaybackProductGuestMediaOwnerRuntimeForTests['seekCurrent']> =
    vi.fn(async (_manager, _port, intent) => ({
      status: 'scheduled' as const,
      reason: null,
      from: intent.from,
      to: intent.to,
      target: freezeCanonical({
        audioContext: fakeAudioContext(),
        contextTimeSeconds: intent.atRoomTimeMs / 1_000,
        targetFrame: Math.round(intent.atRoomTimeMs * 48),
      }),
      snapshot: currentSnapshot(),
      applied: Promise.resolve().then(() => {
        currentState = intent.to;
        currentPhase = 'paused';
        return freezeCanonical({
          kind: 'seek-applied' as const,
          observation: 'worklet-observed' as const,
          from: intent.from,
          to: intent.to,
          targetFrame: Math.round(intent.atRoomTimeMs * 48),
          appliedFrame: Math.round(intent.atRoomTimeMs * 48),
          positionSeconds: intent.positionSeconds,
        });
      }),
    }));
  const stopCurrent: NonNullable<FilePlaybackProductGuestMediaOwnerRuntimeForTests['stopCurrent']> =
    vi.fn(async (_manager, _port, intent) => ({
      status: 'scheduled' as const,
      from: intent.from,
      to: intent.to,
      target: intent.target,
      applied: Promise.resolve().then(() => {
        hasCurrentPort = false;
        return freezeCanonical({
          kind: 'stop-applied' as const,
          observation: 'webaudio-schedule-passed' as const,
          from: intent.from,
          to: intent.to,
          targetFrame: intent.target.targetFrame,
          appliedFrame: intent.target.targetFrame,
        });
      }),
    }));
  const remoteEndCurrent: NonNullable<
    FilePlaybackProductGuestMediaOwnerRuntimeForTests['remoteEndCurrent']
  > = vi.fn(async (_manager, _port, intent) => {
    const observedPhase = currentPhase;
    hasCurrentPort = false;
    return createFilePlaybackRemoteEndedTransitionEvidence(intent, observedPhase);
  });
  const runtime: FilePlaybackProductGuestMediaOwnerRuntimeForTests = {
    createPeerTransport: () => peerTransport,
    createR2Acquirer: () => ({
      acquire: r2Acquire,
      removeQueueItem: vi.fn(async () => true),
      close: r2Close,
    }),
    stageAssetSource,
    stageManifestAssetSource,
    prepareWarmSource,
    handoffWarmSource,
    retireWarmSource,
    acquireManifestAsset,
    prepareManifestDecoderConstruction,
    retireManifestDecoderConstruction,
    createParticipant: (options) => ({
      participantId: options.participantId,
      arm,
      finalize,
      started,
      commitAttempt,
      cancel,
    }),
    currentPort: () => (hasCurrentPort ? CUTOVER_PORT : null),
    currentSnapshot: (_manager, _port) => currentSnapshot(),
    recoveryRequired,
    primeCandidate,
    retireCandidate,
    retireCurrent,
    pauseCurrent,
    seekCurrent,
    stopCurrent,
    remoteEndCurrent,
    scheduleTimeoutForTests,
    cancelTimeoutForTests,
  };
  return {
    runtime,
    sent,
    sendRequired: vi.fn(async (_context, frame) => {
      sent.push(frame);
      return true;
    }),
    peerAcceptBulk,
    peerClose,
    peerCloseHandle,
    r2Acquire,
    r2Close,
    stageAssetSource,
    stageManifestAssetSource,
    prepareWarmSource,
    handoffWarmSource,
    retireWarmSource,
    acquireManifestAsset,
    prepareManifestDecoderConstruction,
    retireManifestDecoderConstruction,
    manifestEvents,
    manifestAdmissions,
    manifestConstructions,
    warmRecords,
    liveLeaseObservedAtHandoff: () => liveLeaseObservedAtHandoff,
    arm,
    finalize,
    started,
    commitAttempt,
    cancel,
    recoveryRequired,
    primeCandidate,
    retireCandidate,
    retireCurrent,
    pauseCurrent,
    seekCurrent,
    stopCurrent,
    remoteEndCurrent,
    scheduleTimeoutForTests,
    cancelTimeoutForTests,
    pendingTimeouts: () => [...scheduledTimeouts.entries()],
    fireNextTimeout() {
      const next = scheduledTimeouts.entries().next().value as
        | [string, Readonly<{ callback: () => void; delayMs: number }>]
        | undefined;
      if (!next) throw new Error('No guest renderer-health timeout is scheduled');
      scheduledTimeouts.delete(next[0]);
      next[1].callback();
      return next;
    },
    fireCancelledTimeout(handle: string) {
      const timer = cancelledTimeouts.get(handle);
      if (!timer) throw new Error('No cancelled guest renderer-health timeout is recorded');
      timer.callback();
    },
    setManifestCodec(codec: ManifestConstructionDiagnostics['codec']) {
      manifestCodec = codec;
    },
    setManifestConstructionOverrides(overrides: Partial<ManifestConstructionDiagnostics>) {
      manifestConstructionOverrides = { ...overrides };
    },
    setCurrentState(next: Readonly<PlaybackStateIdentity>) {
      currentState = next;
      currentPhase = 'playing';
      currentBackend = candidateBackend;
      hasCurrentPort = true;
      physicalRecoveryRequired = false;
    },
    setCurrentPhase(next: 'playing' | 'paused' | 'ended') {
      currentPhase = next;
    },
    setPhysicalRecoveryRequired(next: boolean) {
      physicalRecoveryRequired = next;
    },
    setHasCurrentPort(next: boolean) {
      hasCurrentPort = next;
    },
  };
}

function setup(
  overrides: Pick<
    Partial<FilePlaybackProductGuestMediaOwnerOptions>,
    'getAudioGraph' | 'boundedRoutePolicy'
  > = {},
) {
  const pair = channelPair();
  const registry = new FilePlaybackAssetRegistry({
    liveRoomToken: ROOM_TOKEN,
    onFatalRoom: vi.fn(),
  });
  const manager = new FilePlaybackManager();
  const state = freezeCanonical({ queueItemId: QUEUE_ID, runId: RUN_ID, revision: 1 });
  const runtime = runtimeHarness(registry, state);
  const fatal = vi.fn();
  const rendered = vi.fn();
  const graph = audioGraph();
  const options: FilePlaybackProductGuestMediaOwnerOptions = {
    context: pair.context,
    roomToken: ROOM_TOKEN,
    registry,
    manager,
    getAudioGraph: overrides.getAudioGraph ?? vi.fn(async () => graph),
    maxEncodedSize: 10_000_000,
    decodeOrdinaryAudio: vi.fn(async () => ({
      audioBuffer: {} as AudioBuffer,
      release: vi.fn(),
    })),
    ...(overrides.boundedRoutePolicy ? { boundedRoutePolicy: overrides.boundedRoutePolicy } : {}),
    sendRequired: runtime.sendRequired,
    canSendPeerControl: vi.fn(() => true),
    onTimelineRendered: rendered,
    onFatalConnection: fatal,
    runtimeForTests: runtime.runtime,
  };
  const owner = createFilePlaybackProductGuestMediaOwner(options);
  return { ...pair, registry, manager, state, runtime, fatal, rendered, graph, options, owner };
}

function startPreparation(
  h: ReturnType<typeof setup>,
  offer: Readonly<FileMediaSourceOfferV2> = peerOffer(h.context),
): void {
  h.owner.onTimelineAdopted(timelineEvent(h.context));
  const offerAck = vi.fn();
  h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), offerAck);
  expect(offerAck).toHaveBeenCalledOnce();
  const binding = runBinding(offer);
  const bindingAck = vi.fn();
  h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, binding), bindingAck);
  expect(bindingAck).toHaveBeenCalledOnce();
}

async function prepare(
  h: ReturnType<typeof setup>,
  offer: Readonly<FileMediaSourceOfferV2> = peerOffer(h.context),
): Promise<void> {
  startPreparation(h, offer);
  await vi.waitFor(() =>
    expect(
      h.runtime.sent.some((frame) => (frame as { kind?: string }).kind === 'source-ready'),
    ).toBe(true),
  );
}

function hostWire(h: ReturnType<typeof setup>, kind: 'arm' | 'finalize') {
  const stateLease =
    kind === 'arm'
      ? h.host.bootstrapCurrentMedia({
          run: h.state,
          sourceIdentity: SOURCE_ID,
          transferSessionId: TRANSFER_ID,
        })
      : null;
  const attemptLease =
    kind === 'arm'
      ? h.host.stageAttempt(stateLease!, RENDEZVOUS_ID)
      : (() => {
          throw new Error('Finalize requires the arm attempt lease');
        })();
  return { stateLease: stateLease!, attemptLease };
}

function receiveHostWire(h: ReturnType<typeof setup>, message: Readonly<FilePlaybackWireMessage>) {
  const result = h.guest.receive(message, h.guestConnection);
  if (!result.accepted || result.frame !== 'wire') {
    throw new Error(`Guest wire receive failed: ${JSON.stringify(result)}`);
  }
  const acknowledge = vi.fn();
  h.owner.adoptWireMessage(wireEvent(h.context, result), acknowledge);
  expect(acknowledge).toHaveBeenCalledOnce();
  return result;
}

function stageHostAttempt(
  h: ReturnType<typeof setup>,
  state: Readonly<PlaybackStateIdentity>,
  sourceIdentity: string,
  transferSessionId: string,
  rendezvousId: string,
  kind: 'bootstrap-current' | 'bootstrap-stopped' | 'successor',
) {
  if (kind === 'bootstrap-stopped') h.host.bootstrapStopped(state.revision - 1);
  const stateLease =
    kind === 'bootstrap-current'
      ? h.host.bootstrapCurrentMedia({ run: state, sourceIdentity, transferSessionId })
      : h.host.stageMedia({ run: state, sourceIdentity, transferSessionId });
  const attemptLease = h.host.stageAttempt(stateLease, rendezvousId);
  return { stateLease, attemptLease };
}

async function runHostAttempt(
  h: ReturnType<typeof setup>,
  state: Readonly<PlaybackStateIdentity>,
  sourceIdentity: string,
  transferSessionId: string,
  rendezvousId: string,
  kind: 'bootstrap-current' | 'bootstrap-stopped' | 'successor',
  positionSeconds = 0,
) {
  const attempt = stageHostAttempt(h, state, sourceIdentity, transferSessionId, rendezvousId, kind);
  const arm = h.host.createWire(attempt.attemptLease, {
    kind: 'rendezvous-arm',
    rendezvousId,
    positionSeconds,
    playbackRate: 1,
    startAtRoomTimeMs: 1_000,
    finalizeByRoomTimeMs: 900,
  });
  receiveHostWire(h, arm);
  await vi.waitFor(() =>
    expect(
      h.runtime.sent.filter((frame) => (frame as { kind?: string }).kind === 'rendezvous-armed'),
    ).toHaveLength(kind === 'successor' ? 2 : 1),
  );
  h.runtime.setCurrentState(state);
  const finalize = h.host.createWire(attempt.attemptLease, {
    kind: 'rendezvous-finalize',
    rendezvousId,
    startAtRoomTimeMs: 1_000,
    finalizedAtRoomTimeMs: 155,
  });
  receiveHostWire(h, finalize);
  await vi.waitFor(() => {
    if (h.fatal.mock.calls.length > 0) throw h.fatal.mock.calls[0]![1];
    expect(
      h.runtime.sent.filter((frame) => (frame as { kind?: string }).kind === 'renderer-health'),
    ).toHaveLength(kind === 'successor' ? 2 : 1);
  });
  h.host.commitAttempt(attempt.attemptLease);
  if (kind !== 'bootstrap-current') h.host.commitMedia(attempt.stateLease);
  return attempt;
}

async function stageSameRunArmedAttempt(h: ReturnType<typeof setup>) {
  await prepare(h);
  await runHostAttempt(h, h.state, SOURCE_ID, TRANSFER_ID, RENDEZVOUS_ID, 'bootstrap-current');
  const successor = freezeCanonical({ ...h.state, revision: 2 });
  const stateLease = h.host.stageMedia({
    run: successor,
    sourceIdentity: SOURCE_ID,
    transferSessionId: TRANSFER_ID,
  });
  receiveHostWire(
    h,
    h.host.createWire(stateLease, {
      kind: 'file-playback-prepare',
      expectedQueueItemId: QUEUE_ID,
      expectedRunId: RUN_ID,
      expectedRevision: h.state.revision,
      positionSeconds: 12,
      playbackRate: 1,
    }),
  );
  await vi.waitFor(() =>
    expect(
      h.runtime.sent.filter(
        (frame) =>
          (frame as { kind?: string; revision?: number }).kind === 'source-ready' &&
          (frame as { revision?: number }).revision === successor.revision,
      ),
    ).toHaveLength(1),
  );
  const attemptLease = h.host.stageAttempt(stateLease, RENDEZVOUS_ID_2);
  receiveHostWire(
    h,
    h.host.createWire(attemptLease, {
      kind: 'rendezvous-arm',
      rendezvousId: RENDEZVOUS_ID_2,
      positionSeconds: 12,
      playbackRate: 1,
      startAtRoomTimeMs: 1_000,
      finalizeByRoomTimeMs: 900,
    }),
  );
  await vi.waitFor(() =>
    expect(
      h.runtime.sent.filter(
        (frame) =>
          (frame as { kind?: string; revision?: number }).kind === 'rendezvous-armed' &&
          (frame as { revision?: number }).revision === successor.revision,
      ),
    ).toHaveLength(1),
  );
  return { successor, stateLease, attemptLease };
}

type CancelRestagePreparedKind = 'baseline' | 'successor' | 'recovery';

async function stageCancelablePreparedKind(
  h: ReturnType<typeof setup>,
  kind: CancelRestagePreparedKind,
  stagedPort?: FilePlaybackCutoverCandidatePort,
) {
  await prepare(h);
  if (kind === 'baseline') {
    const staged = stageHostAttempt(
      h,
      h.state,
      SOURCE_ID,
      TRANSFER_ID,
      RENDEZVOUS_ID,
      'bootstrap-current',
    );
    receiveHostWire(
      h,
      h.host.createWire(staged.attemptLease, {
        kind: 'rendezvous-arm',
        rendezvousId: RENDEZVOUS_ID,
        positionSeconds: 0,
        playbackRate: 1,
        startAtRoomTimeMs: 1_000,
        finalizeByRoomTimeMs: 900,
      }),
    );
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.filter(
          (frame) =>
            (frame as { kind?: string; rendezvousId?: string }).kind === 'rendezvous-armed' &&
            (frame as { rendezvousId?: string }).rendezvousId === RENDEZVOUS_ID,
        ),
      ).toHaveLength(1),
    );
    return { state: h.state, ...staged, rendezvousId: RENDEZVOUS_ID, positionSeconds: 0 };
  }

  const initial = await runHostAttempt(
    h,
    h.state,
    SOURCE_ID,
    TRANSFER_ID,
    RENDEZVOUS_ID,
    'bootstrap-current',
  );
  if (kind === 'recovery') {
    if (stagedPort) {
      h.runtime.stageAssetSource.mockImplementationOnce(async (options) =>
        stagedAssetSource(h.registry, options, stagedPort),
      );
    }
    const attemptLease = h.host.stageAttempt(initial.stateLease, RENDEZVOUS_ID_2);
    receiveHostWire(
      h,
      h.host.createWire(attemptLease, {
        kind: 'rendezvous-arm',
        rendezvousId: RENDEZVOUS_ID_2,
        positionSeconds: 2,
        playbackRate: 1,
        startAtRoomTimeMs: 1_000,
        finalizeByRoomTimeMs: 900,
      }),
    );
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.filter(
          (frame) =>
            (frame as { kind?: string; rendezvousId?: string }).kind === 'rendezvous-armed' &&
            (frame as { rendezvousId?: string }).rendezvousId === RENDEZVOUS_ID_2,
        ),
      ).toHaveLength(1),
    );
    return {
      state: h.state,
      stateLease: initial.stateLease,
      attemptLease,
      rendezvousId: RENDEZVOUS_ID_2,
      positionSeconds: 2,
    };
  }

  const offer = peerOffer2(h.context);
  const state = freezeCanonical({
    queueItemId: QUEUE_ID_2,
    runId: RUN_ID_2,
    revision: 2,
  });
  h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), vi.fn());
  h.owner.adoptAuxiliaryMessage(
    auxiliaryEvent(h.context, runBinding(offer, RUN_ID_2, state.revision)),
    vi.fn(),
  );
  await vi.waitFor(() =>
    expect(
      h.runtime.sent.filter(
        (frame) =>
          (frame as { kind?: string; queueItemId?: QueueItemId; runId?: string; revision?: number })
            .kind === 'source-ready' &&
          (frame as { queueItemId?: QueueItemId }).queueItemId === state.queueItemId &&
          (frame as { runId?: string }).runId === state.runId &&
          (frame as { revision?: number }).revision === state.revision,
      ),
    ).toHaveLength(1),
  );
  const staged = stageHostAttempt(
    h,
    state,
    SOURCE_ID_2,
    TRANSFER_ID_2,
    RENDEZVOUS_ID_2,
    'successor',
  );
  receiveHostWire(
    h,
    h.host.createWire(staged.attemptLease, {
      kind: 'rendezvous-arm',
      rendezvousId: RENDEZVOUS_ID_2,
      positionSeconds: 12,
      playbackRate: 1,
      startAtRoomTimeMs: 1_000,
      finalizeByRoomTimeMs: 900,
    }),
  );
  await vi.waitFor(() =>
    expect(
      h.runtime.sent.filter(
        (frame) =>
          (frame as { kind?: string; queueItemId?: QueueItemId; rendezvousId?: string }).kind ===
            'rendezvous-armed' &&
          (frame as { queueItemId?: QueueItemId }).queueItemId === state.queueItemId &&
          (frame as { rendezvousId?: string }).rendezvousId === RENDEZVOUS_ID_2,
      ),
    ).toHaveLength(1),
  );
  return { state, ...staged, rendezvousId: RENDEZVOUS_ID_2, positionSeconds: 12 };
}

describe('FilePlaybackProductGuestMediaOwner', () => {
  it('acknowledges a peer offer before starting detached warm preparation', async () => {
    const h = setup();
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    const acknowledge = vi.fn();

    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, peerOffer(h.context)), acknowledge);

    expect(acknowledge).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce());
    expect(acknowledge.mock.invocationCallOrder[0]).toBeLessThan(
      h.runtime.prepareWarmSource.mock.invocationCallOrder[0]!,
    );
    expect(h.runtime.handoffWarmSource).not.toHaveBeenCalled();
    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('keeps an OFFER-only r2-whole-blob descriptor completely cold', async () => {
    const h = setup();
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    const acknowledge = vi.fn();

    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, r2Offer(h.context)), acknowledge);
    await Promise.resolve();
    await Promise.resolve();

    expect(acknowledge).toHaveBeenCalledOnce();
    expect(h.runtime.prepareWarmSource).not.toHaveBeenCalled();
    expect(h.runtime.handoffWarmSource).not.toHaveBeenCalled();
    expect(h.runtime.r2Acquire).not.toHaveBeenCalled();
    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('rejects a gated manifest offer before ACK, audio graph, or existing-asset lookup', async () => {
    const h = setup();
    const offer = gatedManifestOffer(h.context);
    const existingAsset = new PeerRangeEncodedAudioAsset({
      size: offer.encodedSize,
      identity: offer.sourceIdentity,
      metadata: { name: offer.name, mime: offer.mime },
      transport: {
        read: vi.fn(async (request) => new Uint8Array(request.length)),
        closeHandle: vi.fn(),
      },
      handleId: offer.handleId,
    });
    h.registry.admitEncodedAsset(
      ROOM_TOKEN,
      {
        queueItemId: offer.queueItemId,
        sourceIdentity: offer.sourceIdentity,
        transferSessionId: offer.transferSessionId,
      },
      existingAsset,
    );
    const leaseLookup = vi.spyOn(h.registry, 'leaseForBinding');
    const assetAdmission = vi.spyOn(h.registry, 'admitEncodedAsset');

    h.owner.onTimelineAdopted(timelineEvent(h.context));
    const offerAck = vi.fn();
    expect(() => h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), offerAck)).toThrow(
      /Guest auxiliary media adoption failed/u,
    );

    expect(offerAck).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.fatal).toHaveBeenCalledOnce());
    expect(h.fatal.mock.calls[0]?.[1].cause).toMatchObject({
      message: 'FILE_PLAYBACK_PEER_RANGE_MANIFEST_GATED_OFF',
    });
    expect(h.options.getAudioGraph).not.toHaveBeenCalled();
    expect(leaseLookup).not.toHaveBeenCalled();
    expect(assetAdmission).not.toHaveBeenCalled();
    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    expect(h.runtime.acquireManifestAsset).not.toHaveBeenCalled();
    expect(h.runtime.prepareManifestDecoderConstruction).not.toHaveBeenCalled();
    expect(h.runtime.stageManifestAssetSource).not.toHaveBeenCalled();
    expect(h.runtime.retireManifestDecoderConstruction).not.toHaveBeenCalled();
    expect(h.runtime.prepareWarmSource).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.runtime.r2Close).toHaveBeenCalledOnce());
  });

  it('acknowledges an opt-in manifest OFFER while keeping it completely cold', async () => {
    const h = setup({
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
    });
    const leaseLookup = vi.spyOn(h.registry, 'leaseForBinding');
    const assetAdmission = vi.spyOn(h.registry, 'admitEncodedAsset');
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    const acknowledge = vi.fn();

    h.owner.adoptAuxiliaryMessage(
      auxiliaryEvent(h.context, gatedManifestOffer(h.context)),
      acknowledge,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(acknowledge).toHaveBeenCalledOnce();
    expect(h.options.getAudioGraph).not.toHaveBeenCalled();
    expect(leaseLookup).not.toHaveBeenCalled();
    expect(assetAdmission).not.toHaveBeenCalled();
    expect(h.runtime.acquireManifestAsset).not.toHaveBeenCalled();
    expect(h.runtime.prepareManifestDecoderConstruction).not.toHaveBeenCalled();
    expect(h.runtime.stageManifestAssetSource).not.toHaveBeenCalled();
    expect(h.runtime.prepareWarmSource).not.toHaveBeenCalled();
    expect(h.runtime.handoffWarmSource).not.toHaveBeenCalled();
    expect(h.runtime.r2Acquire).not.toHaveBeenCalled();
    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('pins universal policy and runs a manifest only through cold acquisition and its opaque decoder stager', async () => {
    const requestedPolicy = {
      mode: 'universal-v1' as const,
      aacBackendId: 'webcodecs' as const,
      m4aBackendId: 'webcodecs' as const,
    };
    const h = setup({ boundedRoutePolicy: requestedPolicy });
    Reflect.set(requestedPolicy, 'mode', 'current');
    const offer = gatedManifestOffer(h.context);

    await prepare(h, offer);

    expect(h.runtime.manifestEvents).toEqual(['acquire', 'prepare-construction', 'stage-manifest']);
    expect(h.runtime.acquireManifestAsset).toHaveBeenCalledOnce();
    expect(h.runtime.prepareManifestDecoderConstruction).toHaveBeenCalledOnce();
    expect(h.runtime.stageManifestAssetSource).toHaveBeenCalledOnce();
    const acquisitionOptions = h.runtime.acquireManifestAsset.mock.calls[0]![0];
    const constructionOptions = h.runtime.prepareManifestDecoderConstruction.mock.calls[0]![0];
    const stageOptions = h.runtime.stageManifestAssetSource.mock.calls[0]![0];
    expect(acquisitionOptions.operation.offer).toEqual(offer);
    expect(constructionOptions.assetLease).toBe(stageOptions.assetLease);
    expect(constructionOptions.manifestAdmission).toBe(h.runtime.manifestAdmissions[0]);
    expect(stageOptions.construction).toBe(h.runtime.manifestConstructions[0]);
    expect(stageOptions.expectedBinding).toEqual({
      queueItemId: offer.queueItemId,
      sourceIdentity: offer.sourceIdentity,
      transferSessionId: offer.transferSessionId,
    });
    expect(constructionOptions).not.toHaveProperty('manifest');
    expect(constructionOptions).not.toHaveProperty('evidence');
    expect(constructionOptions).not.toHaveProperty('source');
    expect(stageOptions).not.toHaveProperty('manifest');
    expect(stageOptions).not.toHaveProperty('evidence');
    expect(stageOptions).not.toHaveProperty('source');
    expect(stageOptions).not.toHaveProperty('decodeOrdinaryAudio');
    expect(stageOptions).not.toHaveProperty('boundedRoutePolicy');
    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    expect(h.runtime.r2Acquire).not.toHaveBeenCalled();
    expect(h.runtime.prepareWarmSource).not.toHaveBeenCalled();
    expect(h.runtime.handoffWarmSource).not.toHaveBeenCalled();
    expect(
      h.runtime.sent.filter((frame) => (frame as { kind?: string }).kind === 'source-ready'),
    ).toHaveLength(1);
    expect(h.fatal).not.toHaveBeenCalled();

    h.owner.revoke(h.context);
  });

  it('rejects the opposite manifest codec under MP3-only and ADTS-only policies after joining retirement', async () => {
    const cases = [
      {
        policy: MP3_ONLY_MANIFEST_POLICY,
        rejectedCodec: 'adts-aac-lc' as const,
      },
      {
        policy: ADTS_ONLY_MANIFEST_POLICY,
        rejectedCodec: 'mp3-no-frame-count' as const,
      },
    ];
    for (const { policy, rejectedCodec } of cases) {
      const h = setup({ boundedRoutePolicy: policy });
      h.runtime.setManifestCodec(rejectedCodec);
      const retirement = deferred<boolean>();
      h.runtime.retireManifestDecoderConstruction.mockImplementationOnce(() => retirement.promise);

      startPreparation(h, gatedManifestOffer(h.context));
      await vi.waitFor(() =>
        expect(h.runtime.retireManifestDecoderConstruction).toHaveBeenCalledOnce(),
      );

      expect(h.fatal).not.toHaveBeenCalled();
      expect(h.runtime.retireManifestDecoderConstruction).toHaveBeenCalledWith(
        h.runtime.manifestConstructions[0],
      );
      expect(h.runtime.stageManifestAssetSource).not.toHaveBeenCalled();
      expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
      expect(h.runtime.r2Acquire).not.toHaveBeenCalled();
      retirement.resolve(true);
      await vi.waitFor(() => expect(h.fatal).toHaveBeenCalledOnce());
      expect(
        h.runtime.sent.some((frame) => (frame as { kind?: string }).kind === 'source-ready'),
      ).toBe(false);
      await vi.waitFor(() => expect(h.runtime.r2Close).toHaveBeenCalledOnce());
    }
  });

  it('rejects every mismatched manifest construction diagnostic without a generic fallback', async () => {
    const mismatches: readonly Partial<ManifestConstructionDiagnostics>[] = [
      { queueItemId: QUEUE_ID_2 },
      { sourceIdentity: SOURCE_ID_2 },
      { sourceSize: 4_097 },
    ];
    for (const mismatch of mismatches) {
      const h = setup({
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
      });
      h.runtime.setManifestConstructionOverrides(mismatch);

      startPreparation(h, gatedManifestOffer(h.context));
      await vi.waitFor(() => expect(h.fatal).toHaveBeenCalledOnce());

      expect(h.runtime.acquireManifestAsset).toHaveBeenCalledOnce();
      expect(h.runtime.prepareManifestDecoderConstruction).toHaveBeenCalledOnce();
      expect(h.runtime.retireManifestDecoderConstruction).toHaveBeenCalledOnce();
      expect(h.runtime.stageManifestAssetSource).not.toHaveBeenCalled();
      expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
      expect(h.runtime.r2Acquire).not.toHaveBeenCalled();
      expect(
        h.runtime.sent.some((frame) => (frame as { kind?: string }).kind === 'source-ready'),
      ).toBe(false);
    }
  });

  it('joins repeat-safe construction retirement before fail-closing a manifest stage failure', async () => {
    const h = setup({
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
    });
    const stageFailure = new Error('fixture manifest stage failure');
    const retirement = deferred<boolean>();
    h.runtime.stageManifestAssetSource.mockRejectedValueOnce(stageFailure);
    h.runtime.retireManifestDecoderConstruction.mockImplementationOnce(() => retirement.promise);

    startPreparation(h, gatedManifestOffer(h.context));
    await vi.waitFor(() => expect(h.runtime.stageManifestAssetSource).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(h.runtime.retireManifestDecoderConstruction).toHaveBeenCalledOnce(),
    );

    expect(h.fatal).not.toHaveBeenCalled();
    expect(h.runtime.retireManifestDecoderConstruction).toHaveBeenCalledWith(
      h.runtime.manifestConstructions[0],
    );
    retirement.resolve(true);
    await vi.waitFor(() => expect(h.fatal).toHaveBeenCalledOnce());
    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    expect(
      h.runtime.sent.some((frame) => (frame as { kind?: string }).kind === 'source-ready'),
    ).toBe(false);
  });

  it('retires a decoder construction that resolves after the manifest RUN is aborted', async () => {
    const h = setup({
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
    });
    const offer = gatedManifestOffer(h.context);
    const pendingConstruction =
      deferred<Readonly<FilePlaybackPeerRangeManifestDecoderConstruction>>();
    h.runtime.prepareManifestDecoderConstruction.mockImplementationOnce(
      () => pendingConstruction.promise,
    );
    startPreparation(h, offer);
    await vi.waitFor(() =>
      expect(h.runtime.prepareManifestDecoderConstruction).toHaveBeenCalledOnce(),
    );
    const lateConstruction = freezeCanonical({
      codec: 'mp3-no-frame-count' as const,
      queueItemId: offer.queueItemId,
      sourceIdentity: offer.sourceIdentity,
      sourceSize: offer.encodedSize,
    }) as unknown as FilePlaybackPeerRangeManifestDecoderConstruction;

    h.owner.revoke(h.context);
    pendingConstruction.resolve(lateConstruction);

    await vi.waitFor(() =>
      expect(h.runtime.retireManifestDecoderConstruction).toHaveBeenCalledWith(lateConstruction),
    );
    expect(h.runtime.retireManifestDecoderConstruction).toHaveBeenCalledOnce();
    expect(h.runtime.stageManifestAssetSource).not.toHaveBeenCalled();
    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    expect(
      h.runtime.sent.some((frame) => (frame as { kind?: string }).kind === 'source-ready'),
    ).toBe(false);
    expect(h.fatal).not.toHaveBeenCalled();
  });

  it('rescans and retires an initial manifest candidate staged in the same turn as owner revoke', async () => {
    const pendingStage = deferred<Readonly<StagedFilePlaybackAssetSource>>();
    const h = setup({
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
    });
    h.runtime.stageManifestAssetSource.mockImplementationOnce(() => pendingStage.promise);
    startPreparation(h, gatedManifestOffer(h.context));
    await vi.waitFor(() => expect(h.runtime.stageManifestAssetSource).toHaveBeenCalledOnce());

    const stageOptions = h.runtime.stageManifestAssetSource.mock.calls[0]![0];
    const lateCandidatePort = Object.freeze(
      Object.create(null),
    ) as FilePlaybackCutoverCandidatePort;
    expect(stageOptions.isCurrent()).toBe(true);

    pendingStage.resolve(stagedAssetSource(h.registry, stageOptions, lateCandidatePort));
    h.owner.revoke(h.context);

    await vi.waitFor(() =>
      expect(h.runtime.retireCandidate).toHaveBeenCalledWith(h.manager, lateCandidatePort),
    );
    expect(h.runtime.retireCandidate).toHaveBeenCalledOnce();
    expect(h.runtime.retireCurrent).not.toHaveBeenCalled();
    expect(
      h.runtime.sent.some((frame) => (frame as { kind?: string }).kind === 'source-ready'),
    ).toBe(false);
    expect(h.fatal).not.toHaveBeenCalled();
  });

  it('reuses one manifest admission for same-state recovery but creates a fresh decoder construction', async () => {
    const h = setup({
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
    });
    const offer = gatedManifestOffer(h.context);
    await prepare(h, offer);
    const initial = await runHostAttempt(
      h,
      h.state,
      SOURCE_ID,
      TRANSFER_ID,
      RENDEZVOUS_ID,
      'bootstrap-current',
    );
    const recoveryAttempt = h.host.stageAttempt(initial.stateLease, RENDEZVOUS_ID_2);
    receiveHostWire(
      h,
      h.host.createWire(recoveryAttempt, {
        kind: 'rendezvous-arm',
        rendezvousId: RENDEZVOUS_ID_2,
        positionSeconds: 2,
        playbackRate: 1,
        startAtRoomTimeMs: 1_000,
        finalizeByRoomTimeMs: 900,
      }),
    );
    await vi.waitFor(() => expect(h.runtime.arm).toHaveBeenCalledTimes(2));
    receiveHostWire(
      h,
      h.host.createWire(recoveryAttempt, {
        kind: 'rendezvous-finalize',
        rendezvousId: RENDEZVOUS_ID_2,
        startAtRoomTimeMs: 1_000,
        finalizedAtRoomTimeMs: 155,
      }),
    );
    await vi.waitFor(() => expect(h.runtime.commitAttempt).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.filter(
          (frame) =>
            (frame as { kind?: string; rendezvousId?: string }).kind === 'renderer-health' &&
            (frame as { rendezvousId?: string }).rendezvousId === RENDEZVOUS_ID_2,
        ),
      ).toHaveLength(1),
    );
    await vi.waitFor(() => expect(h.runtime.pendingTimeouts()).toHaveLength(1));
    h.runtime.fireNextTimeout();
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.filter(
          (frame) =>
            (frame as { kind?: string; rendezvousId?: string }).kind === 'renderer-health' &&
            (frame as { rendezvousId?: string }).rendezvousId === RENDEZVOUS_ID_2,
        ),
      ).toHaveLength(2),
    );

    expect(h.runtime.acquireManifestAsset).toHaveBeenCalledOnce();
    expect(h.runtime.prepareManifestDecoderConstruction).toHaveBeenCalledTimes(2);
    expect(h.runtime.stageManifestAssetSource).toHaveBeenCalledTimes(2);
    const firstPrepare = h.runtime.prepareManifestDecoderConstruction.mock.calls[0]![0];
    const recoveryPrepare = h.runtime.prepareManifestDecoderConstruction.mock.calls[1]![0];
    expect(recoveryPrepare.assetLease).toBe(firstPrepare.assetLease);
    expect(recoveryPrepare.manifestAdmission).toBe(firstPrepare.manifestAdmission);
    expect(firstPrepare.manifestAdmission).toBe(h.runtime.manifestAdmissions[0]);
    expect(h.runtime.manifestAdmissions).toHaveLength(1);
    expect(h.runtime.manifestConstructions).toHaveLength(2);
    expect(h.runtime.manifestConstructions[1]).not.toBe(h.runtime.manifestConstructions[0]);
    expect(h.runtime.stageManifestAssetSource.mock.calls[0]![0].construction).toBe(
      h.runtime.manifestConstructions[0],
    );
    expect(h.runtime.stageManifestAssetSource.mock.calls[1]![0].construction).toBe(
      h.runtime.manifestConstructions[1],
    );
    expect(h.runtime.r2Acquire).not.toHaveBeenCalled();
    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    expect(h.runtime.prepareWarmSource).not.toHaveBeenCalled();
    expect(
      h.runtime.sent.filter((frame) => (frame as { kind?: string }).kind === 'source-ready'),
    ).toHaveLength(1);
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('rescans and retires a manifest recovery candidate staged in the same turn as owner revoke', async () => {
    const h = setup({
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
    });
    const offer = gatedManifestOffer(h.context);
    await prepare(h, offer);
    const initial = await runHostAttempt(
      h,
      h.state,
      SOURCE_ID,
      TRANSFER_ID,
      RENDEZVOUS_ID,
      'bootstrap-current',
    );
    const sourceReadyCount = h.runtime.sent.filter(
      (frame) => (frame as { kind?: string }).kind === 'source-ready',
    ).length;
    expect(sourceReadyCount).toBe(1);
    const pendingRecoveryStage = deferred<Readonly<StagedFilePlaybackAssetSource>>();
    h.runtime.stageManifestAssetSource.mockImplementationOnce(() => pendingRecoveryStage.promise);
    const recoveryAttempt = h.host.stageAttempt(initial.stateLease, RENDEZVOUS_ID_2);
    receiveHostWire(
      h,
      h.host.createWire(recoveryAttempt, {
        kind: 'rendezvous-arm',
        rendezvousId: RENDEZVOUS_ID_2,
        positionSeconds: 2,
        playbackRate: 1,
        startAtRoomTimeMs: 1_000,
        finalizeByRoomTimeMs: 900,
      }),
    );
    await vi.waitFor(() => expect(h.runtime.stageManifestAssetSource).toHaveBeenCalledTimes(2));

    const recoveryStageOptions = h.runtime.stageManifestAssetSource.mock.calls[1]![0];
    const lateRecoveryPort = Object.freeze(Object.create(null)) as FilePlaybackCutoverCandidatePort;
    expect(recoveryStageOptions.isCurrent()).toBe(true);

    pendingRecoveryStage.resolve(
      stagedAssetSource(h.registry, recoveryStageOptions, lateRecoveryPort),
    );
    h.owner.revoke(h.context);

    await vi.waitFor(() =>
      expect(h.runtime.retireCandidate).toHaveBeenCalledWith(h.manager, lateRecoveryPort),
    );
    expect(h.runtime.retireCandidate).toHaveBeenCalledOnce();
    expect(h.runtime.retireCurrent).toHaveBeenCalledOnce();
    expect(h.runtime.retireCurrent).toHaveBeenCalledWith(h.manager, CUTOVER_PORT);
    expect(h.runtime.arm).toHaveBeenCalledOnce();
    expect(
      h.runtime.sent.filter((frame) => (frame as { kind?: string }).kind === 'source-ready'),
    ).toHaveLength(sourceReadyCount);
    expect(h.fatal).not.toHaveBeenCalled();
  });

  it('reuses one detached warm operation for an exact peer OFFER replay', async () => {
    const h = setup();
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    const offer = peerOffer(h.context);
    const firstAck = vi.fn();
    const replayAck = vi.fn();

    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), firstAck);
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), replayAck);

    expect(firstAck).toHaveBeenCalledOnce();
    expect(replayAck).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce();
    expect(h.runtime.warmRecords.size).toBe(1);
    expect(h.runtime.handoffWarmSource).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('acknowledges exact OFFER revoke synchronously, then cleans warm authority asynchronously and permits a replacement', async () => {
    const h = setup();
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    const offer = peerOffer(h.context);
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), vi.fn());
    await vi.waitFor(() => expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce());
    const authority = [...h.runtime.warmRecords.keys()][0];
    const warmOptions = h.runtime.prepareWarmSource.mock.calls[0]![0];
    expect(authority).toBeDefined();
    expect(h.registry.snapshotForLease(ROOM_TOKEN, warmOptions.assetLease)).not.toBeNull();

    const revoke = revokeFor(offer);
    const acknowledge = vi.fn(() => {
      expect(h.runtime.retireWarmSource).not.toHaveBeenCalled();
      expect(h.runtime.peerCloseHandle).not.toHaveBeenCalled();
      expect(h.registry.snapshotForLease(ROOM_TOKEN, warmOptions.assetLease)).not.toBeNull();
    });
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, revoke), acknowledge);

    expect(acknowledge).toHaveBeenCalledOnce();
    expect(h.runtime.retireWarmSource).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.runtime.retireWarmSource).toHaveBeenCalledWith(authority));
    await vi.waitFor(() => expect(h.runtime.peerCloseHandle).toHaveBeenCalledOnce());
    expect(h.registry.snapshotForLease(ROOM_TOKEN, warmOptions.assetLease)).toBeNull();

    const replayAck = vi.fn();
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, revoke), replayAck);
    expect(replayAck).toHaveBeenCalledOnce();
    expect(h.runtime.retireWarmSource).toHaveBeenCalledOnce();
    expect(h.runtime.peerCloseHandle).toHaveBeenCalledOnce();

    const replacementAck = vi.fn();
    h.owner.adoptAuxiliaryMessage(
      auxiliaryEvent(h.context, supersedingPeerOffer(h.context)),
      replacementAck,
    );
    expect(replacementAck).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.runtime.prepareWarmSource).toHaveBeenCalledTimes(2));
    expect(h.runtime.prepareWarmSource.mock.calls[1]?.[0].expectedBinding).toMatchObject({
      queueItemId: QUEUE_ID,
      sourceIdentity: SOURCE_ID_2,
      transferSessionId: TRANSFER_ID_2,
    });
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('removes an exact pending warm on revoke and drains only its next offered revision', async () => {
    const h = setup();
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    const activeOffer = peerOffer(h.context);
    const pendingOffer = peerOffer2(h.context);
    const replacementOffer = peerOffer3(h.context);
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, activeOffer), vi.fn());
    await vi.waitFor(() => expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce());

    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, pendingOffer), vi.fn());
    await Promise.resolve();
    expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce();

    const revokeAck = vi.fn();
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, revokeFor(pendingOffer)), revokeAck);
    expect(revokeAck).toHaveBeenCalledOnce();
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, replacementOffer), vi.fn());
    await Promise.resolve();
    expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce();

    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, runBinding(activeOffer)), vi.fn());
    await vi.waitFor(() => expect(h.runtime.handoffWarmSource).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.runtime.prepareWarmSource).toHaveBeenCalledTimes(2));
    expect(h.runtime.prepareWarmSource.mock.calls[1]?.[0].expectedBinding).toMatchObject({
      queueItemId: QUEUE_ID_2,
      sourceIdentity: SOURCE_ID_3,
      transferSessionId: TRANSFER_ID_3,
    });
    expect(h.runtime.prepareWarmSource.mock.calls[1]?.[0].expectedBinding).not.toMatchObject({
      sourceIdentity: SOURCE_ID_2,
    });
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('fail-closes without acknowledging an exact revoke after RUN claimed its OFFER', async () => {
    const h = setup();
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    const offer = peerOffer(h.context);
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), vi.fn());
    const bindingAck = vi.fn();
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, runBinding(offer)), bindingAck);
    expect(bindingAck).toHaveBeenCalledOnce();

    const revokeAck = vi.fn();
    expect(() =>
      h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, revokeFor(offer)), revokeAck),
    ).toThrow(FilePlaybackProductGuestMediaOwnerFatalError);
    expect(revokeAck).not.toHaveBeenCalled();
    expect(h.fatal).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.runtime.r2Close).toHaveBeenCalledOnce());
  });

  it('promotes and hands off the exact OFFER-warmed peer asset on RUN_BINDING', async () => {
    const h = setup();
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    const offer = peerOffer(h.context);
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), vi.fn());
    await vi.waitFor(() => expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce());
    const warmOptions = h.runtime.prepareWarmSource.mock.calls[0]![0];
    const expectedBinding = freezeCanonical({
      queueItemId: offer.queueItemId,
      sourceIdentity: offer.sourceIdentity,
      transferSessionId: offer.transferSessionId,
    });

    expect(h.registry.snapshotForLease(ROOM_TOKEN, warmOptions.assetLease)).toMatchObject({
      kind: 'peer-range',
      sourceIdentity: offer.sourceIdentity,
    });
    expect(h.registry.leaseForBinding(ROOM_TOKEN, expectedBinding)).toBeNull();

    const bindingAck = vi.fn();
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, runBinding(offer)), bindingAck);
    expect(bindingAck).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.runtime.handoffWarmSource).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.some((frame) => (frame as { kind?: string }).kind === 'source-ready'),
      ).toBe(true),
    );

    expect(h.runtime.liveLeaseObservedAtHandoff()).toBe(warmOptions.assetLease);
    expect(h.registry.leaseForBinding(ROOM_TOKEN, expectedBinding)).toBe(warmOptions.assetLease);
    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    expect(h.runtime.retireWarmSource).not.toHaveBeenCalled();
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('retires a detached warm source before revoke closes its provisional peer handle', async () => {
    const h = setup();
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, peerOffer(h.context)), vi.fn());
    await vi.waitFor(() => expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce());
    const authority = [...h.runtime.warmRecords.keys()][0];
    expect(authority).toBeDefined();

    h.owner.revoke(h.context);

    await vi.waitFor(() => expect(h.runtime.retireWarmSource).toHaveBeenCalledWith(authority));
    await vi.waitFor(() => expect(h.runtime.peerCloseHandle).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.runtime.r2Close).toHaveBeenCalledOnce());
    expect(h.runtime.retireWarmSource.mock.invocationCallOrder[0]).toBeLessThan(
      h.runtime.peerCloseHandle.mock.invocationCallOrder[0]!,
    );
    expect(h.runtime.handoffWarmSource).not.toHaveBeenCalled();
    expect(h.fatal).not.toHaveBeenCalled();
  });

  it('immediately discards a detached provisional asset when warm preparation never settles', async () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      h.runtime.r2Close.mockResolvedValueOnce(undefined);
      const neverSettles = new Promise<Readonly<FilePlaybackWarmSourceAuthority>>(() => undefined);
      h.runtime.prepareWarmSource.mockImplementationOnce(() => neverSettles);
      h.owner.onTimelineAdopted(timelineEvent(h.context));
      const offer = peerOffer(h.context);
      h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce();
      const warmOptions = h.runtime.prepareWarmSource.mock.calls[0]![0];

      h.owner.revoke(h.context);
      expect(h.runtime.r2Close).toHaveBeenCalledOnce();
      const r2CloseResult = h.runtime.r2Close.mock.results[0]!.value;
      await vi.advanceTimersByTimeAsync(0);
      if (h.runtime.peerClose.mock.calls.length === 0) {
        await vi.advanceTimersByTimeAsync(2_000);
      }

      await expect(r2CloseResult).resolves.toBeUndefined();
      expect(h.runtime.peerCloseHandle).toHaveBeenCalledOnce();
      expect(h.runtime.peerClose).toHaveBeenCalledOnce();
      expect(h.runtime.peerCloseHandle.mock.invocationCallOrder[0]).toBeLessThan(
        h.runtime.peerClose.mock.invocationCallOrder[0]!,
      );
      expect(h.registry.snapshotForLease(ROOM_TOKEN, warmOptions.assetLease)).toBeNull();

      const binding = freezeCanonical({
        queueItemId: offer.queueItemId,
        sourceIdentity: offer.sourceIdentity,
        transferSessionId: offer.transferSessionId,
      });
      const replacementAsset = new PeerRangeEncodedAudioAsset({
        size: offer.encodedSize,
        identity: offer.sourceIdentity,
        metadata: { name: offer.name, mime: offer.mime },
        handleId: HANDLE_ID_2,
        transport: {
          read: async ({ length }) => new Uint8Array(length),
          closeHandle: vi.fn(),
        },
      });
      const replacementLease = h.registry.admitProvisionalEncodedAsset(
        ROOM_TOKEN,
        binding,
        replacementAsset,
      );
      expect(h.registry.snapshotForLease(ROOM_TOKEN, replacementLease)).toMatchObject({
        kind: 'peer-range',
        sourceIdentity: offer.sourceIdentity,
      });
      await expect(h.registry.discardProvisionalAsset(ROOM_TOKEN, replacementLease)).resolves.toBe(
        true,
      );
      await h.registry.close(ROOM_TOKEN);
      expect(h.fatal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires a warm authority that arrives after revoke discarded its provisional asset', async () => {
    const h = setup();
    const pendingWarm = deferred<Readonly<FilePlaybackWarmSourceAuthority>>();
    h.runtime.prepareWarmSource.mockImplementationOnce(() => pendingWarm.promise);
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    const offer = peerOffer(h.context);
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), vi.fn());
    await vi.waitFor(() => expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce());
    const warmOptions = h.runtime.prepareWarmSource.mock.calls[0]![0];
    const asset = h.registry.snapshotForLease(ROOM_TOKEN, warmOptions.assetLease);
    expect(asset).not.toBeNull();
    const lateAuthority = freezeCanonical({
      backend: 'bounded-stream' as const,
      sourceIdentity: offer.sourceIdentity,
      asset: asset!,
      metadata: freezeCanonical({ name: offer.name, mime: offer.mime }),
      readiness: freezeCanonical({
        durationSeconds: 120,
        bufferedAheadSeconds: 8,
        outputSampleRateHz: 48_000,
        channelCount: 2,
      }),
    }) as unknown as FilePlaybackWarmSourceAuthority;

    h.owner.revoke(h.context);
    await vi.waitFor(() => expect(h.runtime.peerCloseHandle).toHaveBeenCalledOnce());
    expect(h.registry.snapshotForLease(ROOM_TOKEN, warmOptions.assetLease)).toBeNull();

    pendingWarm.resolve(lateAuthority);

    await vi.waitFor(() => expect(h.runtime.retireWarmSource).toHaveBeenCalledWith(lateAuthority));
    expect(h.runtime.retireWarmSource).toHaveBeenCalledOnce();
    expect(h.fatal).not.toHaveBeenCalled();
  });

  it('bounds revoke while RUN_BINDING is waiting on warm preparation that never settles', async () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      const neverSettles = new Promise<Readonly<FilePlaybackWarmSourceAuthority>>(() => undefined);
      h.runtime.prepareWarmSource.mockImplementationOnce(() => neverSettles);
      h.owner.onTimelineAdopted(timelineEvent(h.context));
      const offer = peerOffer(h.context);
      h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce();

      const bindingAck = vi.fn();
      h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, runBinding(offer)), bindingAck);
      await vi.advanceTimersByTimeAsync(0);
      expect(bindingAck).toHaveBeenCalledOnce();

      h.owner.revoke(h.context);
      expect(h.runtime.r2Close).toHaveBeenCalledOnce();
      const r2CloseResult = h.runtime.r2Close.mock.results[0]!.value;
      await vi.advanceTimersByTimeAsync(2_001);

      await expect(r2CloseResult).resolves.toBeUndefined();
      expect(h.runtime.peerCloseHandle).toHaveBeenCalledOnce();
      expect(h.runtime.peerClose).toHaveBeenCalledOnce();
      expect(h.runtime.peerCloseHandle.mock.invocationCallOrder[0]).toBeLessThan(
        h.runtime.peerClose.mock.invocationCallOrder[0]!,
      );
      expect(h.fatal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the exact two-second peer-close grace when warm authority retirement never settles', async () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      h.owner.onTimelineAdopted(timelineEvent(h.context));
      h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, peerOffer(h.context)), vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce();
      expect(h.runtime.warmRecords.size).toBe(1);
      h.runtime.retireWarmSource.mockImplementationOnce(
        () => new Promise<boolean>(() => undefined),
      );

      h.owner.revoke(h.context);
      expect(h.runtime.r2Close).toHaveBeenCalledOnce();
      const r2CloseResult = h.runtime.r2Close.mock.results[0]!.value;

      await vi.advanceTimersByTimeAsync(1_999);
      expect(h.runtime.peerClose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);

      expect(h.runtime.peerClose).toHaveBeenCalledOnce();
      await expect(r2CloseResult).resolves.toBeUndefined();
      expect(h.fatal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fully retires and discards a same-queue warm before preparing its replacement', async () => {
    const h = setup();
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, peerOffer(h.context)), vi.fn());
    await vi.waitFor(() => expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce());
    const firstAuthority = [...h.runtime.warmRecords.keys()][0];
    expect(firstAuthority).toBeDefined();

    const replacementAck = vi.fn();
    h.owner.adoptAuxiliaryMessage(
      auxiliaryEvent(h.context, supersedingPeerOffer(h.context)),
      replacementAck,
    );

    expect(replacementAck).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.runtime.retireWarmSource).toHaveBeenCalledWith(firstAuthority));
    await vi.waitFor(() => expect(h.runtime.peerCloseHandle).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.runtime.prepareWarmSource).toHaveBeenCalledTimes(2));
    expect(h.runtime.retireWarmSource.mock.invocationCallOrder[0]).toBeLessThan(
      h.runtime.peerCloseHandle.mock.invocationCallOrder[0]!,
    );
    expect(h.runtime.peerCloseHandle.mock.invocationCallOrder[0]).toBeLessThan(
      h.runtime.prepareWarmSource.mock.invocationCallOrder[1]!,
    );
    expect(h.runtime.handoffWarmSource).not.toHaveBeenCalled();
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('keeps a different-queue OFFER pending without evicting the active warm', async () => {
    const h = setup();
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, peerOffer(h.context)), vi.fn());
    await vi.waitFor(() => expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce());
    const firstAuthority = [...h.runtime.warmRecords.keys()][0];

    const pendingAck = vi.fn();
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, peerOffer2(h.context)), pendingAck);
    await Promise.resolve();
    await Promise.resolve();

    expect(pendingAck).toHaveBeenCalledOnce();
    expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce();
    expect(h.runtime.retireWarmSource).not.toHaveBeenCalled();
    expect(h.runtime.peerCloseHandle).not.toHaveBeenCalled();
    expect([...h.runtime.warmRecords.keys()]).toEqual([firstAuthority]);
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('starts a pending different-queue warm only after the first warm RUN handoff', async () => {
    const h = setup();
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    const firstOffer = peerOffer(h.context);
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, firstOffer), vi.fn());
    await vi.waitFor(() => expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce());
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, peerOffer2(h.context)), vi.fn());
    await Promise.resolve();
    expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce();

    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, runBinding(firstOffer)), vi.fn());

    await vi.waitFor(() => expect(h.runtime.handoffWarmSource).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.runtime.prepareWarmSource).toHaveBeenCalledTimes(2));
    expect(h.runtime.handoffWarmSource.mock.invocationCallOrder[0]).toBeLessThan(
      h.runtime.prepareWarmSource.mock.invocationCallOrder[1]!,
    );
    expect(h.runtime.retireWarmSource).not.toHaveBeenCalled();
    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    expect(h.runtime.warmRecords.size).toBe(1);
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('retains and promotes the provisional lease when warm routing is unsupported', async () => {
    const h = setup();
    h.runtime.prepareWarmSource.mockRejectedValueOnce(new UnsupportedOrdinaryEncodedSourceError());
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    const offer = peerOffer(h.context);
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), vi.fn());
    await vi.waitFor(() => expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce());
    const warmOptions = h.runtime.prepareWarmSource.mock.calls[0]![0];
    const expectedBinding = freezeCanonical({
      queueItemId: offer.queueItemId,
      sourceIdentity: offer.sourceIdentity,
      transferSessionId: offer.transferSessionId,
    });
    await Promise.resolve();

    expect(h.registry.snapshotForLease(ROOM_TOKEN, warmOptions.assetLease)).toMatchObject({
      kind: 'peer-range',
      sourceIdentity: offer.sourceIdentity,
    });
    expect(h.registry.leaseForBinding(ROOM_TOKEN, expectedBinding)).toBeNull();
    expect(h.runtime.peerCloseHandle).not.toHaveBeenCalled();

    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, runBinding(offer)), vi.fn());
    await vi.waitFor(() => expect(h.runtime.stageAssetSource).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.some((frame) => (frame as { kind?: string }).kind === 'source-ready'),
      ).toBe(true),
    );

    const coldOptions = h.runtime.stageAssetSource.mock.calls[0]![0];
    expect(coldOptions.assetLease).toBe(warmOptions.assetLease);
    expect(h.registry.leaseForBinding(ROOM_TOKEN, expectedBinding)).toBe(warmOptions.assetLease);
    expect(h.runtime.handoffWarmSource).not.toHaveBeenCalled();
    expect(h.runtime.retireWarmSource).not.toHaveBeenCalled();
    expect(h.runtime.peerCloseHandle).not.toHaveBeenCalled();
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('cold-retries the same provisional lease after a transient warm failure', async () => {
    const h = setup();
    h.runtime.prepareWarmSource.mockRejectedValueOnce(new Error('transient warm failure'));
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    const offer = peerOffer(h.context);
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), vi.fn());
    await vi.waitFor(() => expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce());
    const warmOptions = h.runtime.prepareWarmSource.mock.calls[0]![0];
    const expectedBinding = freezeCanonical({
      queueItemId: offer.queueItemId,
      sourceIdentity: offer.sourceIdentity,
      transferSessionId: offer.transferSessionId,
    });
    await Promise.resolve();

    expect(h.registry.snapshotForLease(ROOM_TOKEN, warmOptions.assetLease)).toMatchObject({
      kind: 'peer-range',
      sourceIdentity: offer.sourceIdentity,
    });
    expect(h.registry.leaseForBinding(ROOM_TOKEN, expectedBinding)).toBeNull();
    expect(h.runtime.peerCloseHandle).not.toHaveBeenCalled();
    expect(h.fatal).not.toHaveBeenCalled();

    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, runBinding(offer)), vi.fn());
    await vi.waitFor(() => expect(h.runtime.stageAssetSource).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.some((frame) => (frame as { kind?: string }).kind === 'source-ready'),
      ).toBe(true),
    );

    const coldOptions = h.runtime.stageAssetSource.mock.calls[0]![0];
    expect(coldOptions.assetLease).toBe(warmOptions.assetLease);
    expect(h.registry.leaseForBinding(ROOM_TOKEN, expectedBinding)).toBe(warmOptions.assetLease);
    expect(h.runtime.handoffWarmSource).not.toHaveBeenCalled();
    expect(h.runtime.retireWarmSource).not.toHaveBeenCalled();
    expect(h.runtime.peerCloseHandle).not.toHaveBeenCalled();
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('retries a rejected OFFER-time audio graph provider on the cold RUN path', async () => {
    const graph = audioGraph();
    const getAudioGraph = vi
      .fn<() => Promise<Readonly<ReturnType<typeof audioGraph>>>>()
      .mockRejectedValueOnce(new Error('transient audio graph failure'))
      .mockResolvedValueOnce(graph);
    const h = setup({ getAudioGraph });
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    const offer = peerOffer(h.context);

    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), vi.fn());
    await vi.waitFor(() => expect(getAudioGraph).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();

    expect(h.runtime.prepareWarmSource).not.toHaveBeenCalled();
    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    expect(h.fatal).not.toHaveBeenCalled();

    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, runBinding(offer)), vi.fn());
    await vi.waitFor(() => expect(getAudioGraph).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.runtime.stageAssetSource).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.some((frame) => (frame as { kind?: string }).kind === 'source-ready'),
      ).toBe(true),
    );

    const coldOptions = h.runtime.stageAssetSource.mock.calls[0]![0];
    expect(h.registry.snapshotForLease(ROOM_TOKEN, coldOptions.assetLease)).toMatchObject({
      kind: 'peer-range',
      sourceIdentity: offer.sourceIdentity,
    });
    expect(h.runtime.handoffWarmSource).not.toHaveBeenCalled();
    expect(h.runtime.retireWarmSource).not.toHaveBeenCalled();
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('fails closed without starting a replacement when old warm cleanup rejects', async () => {
    const h = setup();
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, peerOffer(h.context)), vi.fn());
    await vi.waitFor(() => expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce());
    h.runtime.retireWarmSource.mockRejectedValueOnce(new Error('warm cleanup rejected'));

    const replacementAck = vi.fn();
    h.owner.adoptAuxiliaryMessage(
      auxiliaryEvent(h.context, supersedingPeerOffer(h.context)),
      replacementAck,
    );

    expect(replacementAck).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.fatal).toHaveBeenCalledOnce());
    expect(h.runtime.retireWarmSource).toHaveBeenCalledOnce();
    expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce();
    expect(h.runtime.handoffWarmSource).not.toHaveBeenCalled();
    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.runtime.r2Close).toHaveBeenCalledOnce());
  });

  it('projects a prepared paused active baseline exactly once without starting a renderer', async () => {
    const h = setup();
    const baseline = pausedTimelineEvent(h.context);
    h.owner.onTimelineAdopted(baseline);
    const offer = peerOffer(h.context);
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), vi.fn());
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, runBinding(offer)), vi.fn());

    await vi.waitFor(() => expect(h.rendered).toHaveBeenCalledOnce());

    expect(h.rendered).toHaveBeenCalledWith(baseline.timeline);
    expect(h.runtime.arm).not.toHaveBeenCalled();
    expect(h.runtime.finalize).not.toHaveBeenCalled();
    expect(h.runtime.started).not.toHaveBeenCalled();
    expect(h.runtime.commitAttempt).not.toHaveBeenCalled();
    const sourceReadyCallIndex = h.runtime.sendRequired.mock.calls.findIndex(
      ([, frame]) => (frame as { kind?: string }).kind === 'source-ready',
    );
    expect(sourceReadyCallIndex).toBeGreaterThanOrEqual(0);
    expect(h.runtime.sendRequired.mock.invocationCallOrder[sourceReadyCallIndex]).toBeLessThan(
      h.rendered.mock.invocationCallOrder[0]!,
    );

    h.owner.onTimelineAdopted(baseline);
    await Promise.resolve();
    expect(h.rendered).toHaveBeenCalledOnce();
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('completes peer-range native FLAC late join through physical health evidence', async () => {
    const h = setup();
    expect(Object.keys(h.owner)).toEqual([
      'onTimelineAdopted',
      'onTimelineUpdated',
      'adoptAuxiliaryMessage',
      'adoptWireMessage',
      'adoptPeerRangeBulk',
      'revoke',
    ]);
    expect(Object.getPrototypeOf(h.owner)).toBeNull();
    expect(Object.isFrozen(h.owner)).toBe(true);

    await prepare(h);
    expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce();
    expect(h.runtime.handoffWarmSource).toHaveBeenCalledOnce();
    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    const warmOptions = h.runtime.prepareWarmSource.mock.calls[0]![0];
    expect(warmOptions).not.toHaveProperty('boundedRoutePolicy');
    expect(h.registry.snapshotForLease(ROOM_TOKEN, warmOptions.assetLease)).toMatchObject({
      kind: 'peer-range',
      sourceIdentity: SOURCE_ID,
    });
    expect(
      h.runtime.sent.find((frame) => (frame as { kind?: string }).kind === 'source-ready'),
    ).toMatchObject({
      backend: 'bounded-stream',
      durationSeconds: 120,
      outputSampleRateHz: 48_000,
      channelCount: 2,
    });

    const bulkAck = vi.fn();
    const bulkFrame = freezeCanonical({ type: 'peer-range-bulk-test' });
    h.owner.adoptPeerRangeBulk(peerEvent(h.context, bulkFrame), bulkAck);
    expect(bulkAck).toHaveBeenCalledOnce();
    expect(h.runtime.peerAcceptBulk).toHaveBeenCalledWith(h.context.connectionToken, bulkFrame);

    const host = hostWire(h, 'arm');
    const arm = h.host.createWire(host.attemptLease, {
      kind: 'rendezvous-arm',
      rendezvousId: RENDEZVOUS_ID,
      positionSeconds: 0,
      playbackRate: 1,
      startAtRoomTimeMs: 1_000,
      finalizeByRoomTimeMs: 900,
    });
    const ready = h.runtime.sent.find(
      (frame) => (frame as { kind?: string }).kind === 'source-ready',
    ) as FilePlaybackWireMessage;
    expect(arm).toMatchObject({
      queueItemId: ready.queueItemId,
      runId: ready.runId,
      revision: ready.revision,
      sourceIdentity: ready.sourceIdentity,
      transferSessionId: ready.transferSessionId,
    });
    expect(
      parseFilePlaybackWireMessage(arm, {
        sessionId: h.context.sessionId,
        connectionId: h.context.connectionId,
        senderParticipantId: h.context.hostParticipantId,
        recipientParticipantId: h.context.guestParticipantId,
        lastControlSequence: 0,
        receivedAtRoomTimeMs: h.guest.nowRoomTimeMs(),
        rendezvousId: RENDEZVOUS_ID,
      }),
    ).not.toBeNull();
    receiveHostWire(h, arm);
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.some((frame) => (frame as { kind?: string }).kind === 'rendezvous-armed'),
      ).toBe(true),
    );

    const finalize = h.host.createWire(host.attemptLease, {
      kind: 'rendezvous-finalize',
      rendezvousId: RENDEZVOUS_ID,
      startAtRoomTimeMs: 1_000,
      finalizedAtRoomTimeMs: 155,
    });
    receiveHostWire(h, finalize);
    await vi.waitFor(() =>
      expect(h.runtime.sent.map((frame) => (frame as { kind?: string }).kind)).toEqual(
        expect.arrayContaining([
          'source-ready',
          'rendezvous-armed',
          'rendezvous-finalized',
          'renderer-health',
        ]),
      ),
    );
    expect(h.runtime.arm).toHaveBeenCalledOnce();
    expect(h.runtime.finalize).toHaveBeenCalledOnce();
    expect(h.runtime.started).toHaveBeenCalledOnce();
    expect(h.runtime.commitAttempt).toHaveBeenCalledOnce();
    expect(
      h.runtime.sent.find((frame) => (frame as { kind?: string }).kind === 'renderer-health'),
    ).toMatchObject({
      value: 'healthy',
      renderedFrame: 48_000,
      underrunCount: 0,
      reasonCode: null,
    });
    expect(h.rendered).toHaveBeenCalledOnce();
    expect(h.rendered).toHaveBeenCalledWith(timelineEvent(h.context).timeline);
    const healthCallIndex = h.runtime.sendRequired.mock.calls.findIndex(
      ([, frame]) => (frame as { kind?: string }).kind === 'renderer-health',
    );
    expect(healthCallIndex).toBeGreaterThanOrEqual(0);
    expect(h.runtime.started.mock.invocationCallOrder[0]).toBeLessThan(
      h.rendered.mock.invocationCallOrder[0]!,
    );
    expect(h.runtime.commitAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      h.rendered.mock.invocationCallOrder[0]!,
    );
    expect(h.runtime.sendRequired.mock.invocationCallOrder[healthCallIndex]).toBeLessThan(
      h.rendered.mock.invocationCallOrder[0]!,
    );
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    await Promise.resolve();
    expect(h.rendered).toHaveBeenCalledOnce();
    expect(h.fatal).not.toHaveBeenCalled();

    h.owner.revoke(h.context);
    await vi.waitFor(() => expect(h.runtime.r2Close).toHaveBeenCalledOnce());
    expect(h.runtime.peerClose).toHaveBeenCalledOnce();
    expect(h.runtime.retireCurrent).toHaveBeenCalledOnce();
  });

  it('renews renderer health from one exact current playing attempt with a self-rescheduling timeout', async () => {
    const h = setup();
    const lifecycleBefore = getFilePlaybackUniversalLifecycleSnapshotForTests();
    await prepare(h);
    await runHostAttempt(h, h.state, SOURCE_ID, TRANSFER_ID, RENDEZVOUS_ID, 'bootstrap-current');

    expect(h.runtime.scheduleTimeoutForTests).toHaveBeenCalledOnce();
    expect(h.runtime.scheduleTimeoutForTests).toHaveBeenLastCalledWith(
      expect.any(Function),
      Math.floor(10_000 / 3),
    );
    expect(h.runtime.pendingTimeouts()).toHaveLength(1);
    const firstHeartbeatLifecycle = getFilePlaybackUniversalLifecycleSnapshotForTests();
    expect(firstHeartbeatLifecycle.kinds.timers.live).toBeGreaterThanOrEqual(1);
    expect(firstHeartbeatLifecycle.kinds.timers.acquiredTotal).toBeGreaterThan(
      lifecycleBefore.kinds.timers.acquiredTotal,
    );
    expect(firstHeartbeatLifecycle.invariantFaults).toBe(lifecycleBefore.invariantFaults);

    h.runtime.fireNextTimeout();
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.filter((frame) => (frame as { kind?: string }).kind === 'renderer-health'),
      ).toHaveLength(2),
    );

    const healthFrames = h.runtime.sent.filter(
      (frame) => (frame as { kind?: string }).kind === 'renderer-health',
    ) as FilePlaybackWireMessage[];
    expect(healthFrames[1]).toMatchObject({
      queueItemId: QUEUE_ID,
      runId: RUN_ID,
      revision: h.state.revision,
      rendezvousId: RENDEZVOUS_ID,
      value: 'healthy',
      renderedFrame: 48_000,
      underrunCount: 0,
      reasonCode: null,
    });
    await vi.waitFor(() => {
      expect(h.runtime.scheduleTimeoutForTests).toHaveBeenCalledTimes(2);
      expect(h.runtime.pendingTimeouts()).toHaveLength(1);
    });
    const renewedHeartbeatLifecycle = getFilePlaybackUniversalLifecycleSnapshotForTests();
    expect(renewedHeartbeatLifecycle.kinds.timers.live).toBeGreaterThanOrEqual(1);
    expect(renewedHeartbeatLifecycle.kinds.timers.acquiredTotal).toBeGreaterThan(
      firstHeartbeatLifecycle.kinds.timers.acquiredTotal,
    );
    expect(renewedHeartbeatLifecycle.invariantFaults).toBe(lifecycleBefore.invariantFaults);

    h.owner.revoke(h.context);
    expect(h.runtime.cancelTimeoutForTests).toHaveBeenCalledOnce();
    expect(h.runtime.pendingTimeouts()).toHaveLength(0);
  });

  it('renews current renderer health while next-run candidate preparation blocks the media lane', async () => {
    const h = setup();
    await prepare(h);
    await runHostAttempt(h, h.state, SOURCE_ID, TRANSFER_ID, RENDEZVOUS_ID, 'bootstrap-current');
    const offer = peerOffer2(h.context);
    const candidateAsset = new PeerRangeEncodedAudioAsset({
      size: offer.encodedSize,
      identity: offer.sourceIdentity,
      metadata: { name: offer.name, mime: offer.mime },
      transport: {
        read: vi.fn(async (request) => new Uint8Array(request.length)),
        closeHandle: vi.fn(),
      },
      handleId: offer.handleId,
    });
    h.registry.admitEncodedAsset(
      ROOM_TOKEN,
      {
        queueItemId: offer.queueItemId,
        sourceIdentity: offer.sourceIdentity,
        transferSessionId: offer.transferSessionId,
      },
      candidateAsset,
    );
    const pendingStage = deferred<Readonly<StagedFilePlaybackAssetSource>>();
    h.runtime.stageAssetSource.mockImplementationOnce(() => pendingStage.promise);

    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), vi.fn());
    h.owner.adoptAuxiliaryMessage(
      auxiliaryEvent(h.context, runBinding(offer, RUN_ID_2, 2)),
      vi.fn(),
    );
    await vi.waitFor(() => expect(h.runtime.stageAssetSource).toHaveBeenCalledOnce());
    const healthCountBefore = h.runtime.sent.filter(
      (frame) => (frame as { kind?: string }).kind === 'renderer-health',
    ).length;

    h.runtime.fireNextTimeout();

    await vi.waitFor(() =>
      expect(
        h.runtime.sent.filter((frame) => (frame as { kind?: string }).kind === 'renderer-health'),
      ).toHaveLength(healthCountBefore + 1),
    );
    await vi.waitFor(() => expect(h.runtime.pendingTimeouts()).toHaveLength(1));
    expect(h.runtime.stageAssetSource).toHaveBeenCalledOnce();
    expect(h.fatal).not.toHaveBeenCalled();

    const stageOptions = h.runtime.stageAssetSource.mock.calls[0]![0];
    const candidatePort = Object.freeze(Object.create(null)) as FilePlaybackCutoverCandidatePort;
    pendingStage.resolve(stagedAssetSource(h.registry, stageOptions, candidatePort));
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.filter(
          (frame) =>
            (frame as { kind?: string; revision?: number }).kind === 'source-ready' &&
            (frame as { revision?: number }).revision === 2,
        ),
      ).toHaveLength(1),
    );
    h.owner.revoke(h.context);
  });

  it('cancels and generation-fences renderer health before acknowledging a current transition', async () => {
    const h = setup();
    await prepare(h);
    await runHostAttempt(h, h.state, SOURCE_ID, TRANSFER_ID, RENDEZVOUS_ID, 'bootstrap-current');
    const [[timerHandle]] = h.runtime.pendingTimeouts();
    const initialHealthCount = h.runtime.sent.filter(
      (frame) => (frame as { kind?: string }).kind === 'renderer-health',
    ).length;
    const successor = freezeCanonical({ ...h.state, revision: 2 });
    const stateLease = h.host.stageMedia({
      run: successor,
      sourceIdentity: SOURCE_ID,
      transferSessionId: TRANSFER_ID,
    });
    const result = h.guest.receive(
      h.host.createWire(stateLease, {
        kind: 'file-playback-pause',
        expectedQueueItemId: QUEUE_ID,
        expectedRunId: RUN_ID,
        expectedRevision: h.state.revision,
        atRoomTimeMs: 300,
      }),
      h.guestConnection,
    );
    if (!result.accepted || result.frame !== 'wire') throw new Error('Expected pause wire');
    const acknowledge = vi.fn();

    h.owner.adoptWireMessage(wireEvent(h.context, result), acknowledge);

    expect(h.runtime.cancelTimeoutForTests).toHaveBeenCalledWith(timerHandle);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(h.runtime.cancelTimeoutForTests.mock.invocationCallOrder[0]).toBeLessThan(
      acknowledge.mock.invocationCallOrder[0]!,
    );
    expect(h.runtime.pendingTimeouts()).toHaveLength(0);

    // A platform timer which races after cancellation cannot publish or re-arm.
    h.runtime.fireCancelledTimeout(timerHandle);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      h.runtime.sent.filter((frame) => (frame as { kind?: string }).kind === 'renderer-health'),
    ).toHaveLength(initialHealthCount);
    expect(h.runtime.pendingTimeouts()).toHaveLength(0);
    await vi.waitFor(() => expect(h.runtime.pauseCurrent).toHaveBeenCalledOnce());
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('does not renew or re-arm renderer health after the exact current renderer stops playing', async () => {
    const h = setup();
    await prepare(h);
    await runHostAttempt(h, h.state, SOURCE_ID, TRANSFER_ID, RENDEZVOUS_ID, 'bootstrap-current');
    const initialHealthCount = h.runtime.sent.filter(
      (frame) => (frame as { kind?: string }).kind === 'renderer-health',
    ).length;
    h.runtime.setCurrentPhase('paused');

    h.runtime.fireNextTimeout();
    await Promise.resolve();
    await Promise.resolve();

    expect(
      h.runtime.sent.filter((frame) => (frame as { kind?: string }).kind === 'renderer-health'),
    ).toHaveLength(initialHealthCount);
    expect(h.runtime.pendingTimeouts()).toHaveLength(0);
    expect(h.runtime.scheduleTimeoutForTests).toHaveBeenCalledOnce();
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('rejects invalid and hostile route policies before constructing media transports', () => {
    const h = setup();
    const createPeerTransport = vi.fn(h.runtime.runtime.createPeerTransport!);
    const createR2Acquirer = vi.fn(h.runtime.runtime.createR2Acquirer!);
    const stageAssetSource = vi.fn(h.runtime.runtime.stageAssetSource!);
    const runtimeForTests: FilePlaybackProductGuestMediaOwnerRuntimeForTests = {
      ...h.runtime.runtime,
      createPeerTransport,
      createR2Acquirer,
      stageAssetSource,
    };
    let getterReads = 0;
    const accessorPolicy = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorPolicy, 'mode', {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return 'current';
      },
    });
    const throwingPolicy = new Proxy(Object.create(null) as Record<string, unknown>, {
      ownKeys: () => {
        throw new Error('hostile policy inspection');
      },
    });
    const invalidPolicies: readonly unknown[] = [
      {
        mode: 'universal-v1',
        aacBackendId: 'webcodecs',
        m4aBackendId: 'symphonia-wasm',
      },
      accessorPolicy,
      throwingPolicy,
    ];

    for (const boundedRoutePolicy of invalidPolicies) {
      expect(() =>
        createFilePlaybackProductGuestMediaOwner({
          ...h.options,
          boundedRoutePolicy: boundedRoutePolicy as FilePlaybackBoundedRoutePolicy,
          runtimeForTests,
        }),
      ).toThrow(TypeError);
    }

    expect(getterReads).toBe(0);
    expect(createPeerTransport).not.toHaveBeenCalled();
    expect(createR2Acquirer).not.toHaveBeenCalled();
    expect(stageAssetSource).not.toHaveBeenCalled();
    expect(h.runtime.r2Acquire).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('routes r2-whole-blob through the acquirer and stages it as an ordinary Blob source', async () => {
    const h = setup();
    await prepare(h, r2Offer(h.context));

    expect(h.runtime.r2Acquire).toHaveBeenCalledOnce();
    expect(h.runtime.stageAssetSource).toHaveBeenCalledOnce();
    const stageOptions = h.runtime.stageAssetSource.mock.calls[0]![0];
    expect(h.registry.snapshotForLease(ROOM_TOKEN, stageOptions.assetLease)).toMatchObject({
      kind: 'blob',
      name: 'ordinary.wav',
      mime: 'audio/wav',
    });
    expect(
      h.runtime.sent.find((frame) => (frame as { kind?: string }).kind === 'source-ready'),
    ).toMatchObject({ backend: 'audio-buffer', bufferedAheadSeconds: 120 });
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('waits for the document audio graph and rejects its late result after revoke', async () => {
    const graph = deferred<ReturnType<typeof audioGraph>>();
    const getAudioGraph = vi.fn(() => graph.promise);
    const h = setup({ getAudioGraph });
    const offer = peerOffer(h.context);
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), vi.fn());
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, runBinding(offer)), vi.fn());
    await vi.waitFor(() => expect(getAudioGraph).toHaveBeenCalledOnce());

    h.owner.revoke(h.context);
    graph.resolve(audioGraph());
    await vi.waitFor(() => expect(h.runtime.r2Close).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    expect(
      h.runtime.sent.some((frame) => (frame as { kind?: string }).kind === 'source-ready'),
    ).toBe(false);
    expect(h.fatal).not.toHaveBeenCalled();
  });

  it('fails closed before staging when destination belongs to a different AudioContext', async () => {
    const expectedContext = fakeAudioContext();
    const foreignContext = fakeAudioContext();
    const mismatched = freezeCanonical({
      audioContext: expectedContext,
      destination: { context: foreignContext } as unknown as AudioNode,
    });
    const h = setup({ getAudioGraph: vi.fn(async () => mismatched) });
    const offer = peerOffer(h.context);
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), vi.fn());
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, runBinding(offer)), vi.fn());

    await vi.waitFor(() => expect(h.fatal).toHaveBeenCalledOnce());
    expect(h.runtime.r2Acquire).not.toHaveBeenCalled();
    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    expect(
      h.runtime.sent.some((frame) => (frame as { kind?: string }).kind === 'source-ready'),
    ).toBe(false);
    expect(h.runtime.peerClose).toHaveBeenCalledOnce();
  });

  it('does not acquire or publish media when the primed AudioContext is interrupted', async () => {
    const interruptedContext = fakeAudioContext();
    Object.defineProperty(interruptedContext, 'state', {
      value: 'suspended',
      configurable: true,
    });
    const interrupted = freezeCanonical({
      audioContext: interruptedContext,
      destination: { context: interruptedContext } as unknown as AudioNode,
    });
    const h = setup({ getAudioGraph: vi.fn(async () => interrupted) });
    const offer = r2Offer(h.context);
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), vi.fn());
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, runBinding(offer)), vi.fn());

    await vi.waitFor(() => expect(h.fatal).toHaveBeenCalledOnce());
    expect(h.runtime.r2Acquire).not.toHaveBeenCalled();
    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    expect(
      h.runtime.sent.some((frame) => (frame as { kind?: string }).kind === 'source-ready'),
    ).toBe(false);
  });

  it('retires an initial candidate when channel authority closes immediately after staging resolves', async () => {
    const pendingStage = deferred<Readonly<StagedFilePlaybackAssetSource>>();
    const h = setup();
    h.runtime.stageAssetSource.mockImplementationOnce(() => pendingStage.promise);
    const offer = r2Offer(h.context);
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), vi.fn());
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, runBinding(offer)), vi.fn());
    await vi.waitFor(() => expect(h.runtime.stageAssetSource).toHaveBeenCalledOnce());

    const stageOptions = h.runtime.stageAssetSource.mock.calls[0]![0];
    const lateCandidatePort = Object.freeze(
      Object.create(null),
    ) as FilePlaybackCutoverCandidatePort;
    expect(stageOptions.isCurrent()).toBe(true);

    pendingStage.resolve(stagedAssetSource(h.registry, stageOptions, lateCandidatePort));
    h.guest.close();

    await vi.waitFor(() => expect(h.fatal).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(h.runtime.retireCandidate).toHaveBeenCalledWith(h.manager, lateCandidatePort),
    );
    await vi.waitFor(() => expect(h.runtime.r2Close).toHaveBeenCalledOnce());
    expect(h.runtime.retireCandidate).toHaveBeenCalledOnce();
    expect(h.runtime.retireCurrent).not.toHaveBeenCalled();
    expect(
      h.runtime.sent.some((frame) => (frame as { kind?: string }).kind === 'source-ready'),
    ).toBe(false);
  });

  it('retires a same-state recovery candidate when channel authority closes immediately after staging resolves', async () => {
    const h = setup();
    const offer = r2Offer(h.context);
    await prepare(h, offer);
    const initial = await runHostAttempt(
      h,
      h.state,
      SOURCE_ID,
      TRANSFER_ID,
      RENDEZVOUS_ID,
      'bootstrap-current',
    );
    const sourceReadyCount = h.runtime.sent.filter(
      (frame) => (frame as { kind?: string }).kind === 'source-ready',
    ).length;
    expect(sourceReadyCount).toBe(1);
    const pendingRecoveryStage = deferred<Readonly<StagedFilePlaybackAssetSource>>();
    h.runtime.stageAssetSource.mockImplementationOnce(() => pendingRecoveryStage.promise);
    const recoveryAttempt = h.host.stageAttempt(initial.stateLease, RENDEZVOUS_ID_2);
    receiveHostWire(
      h,
      h.host.createWire(recoveryAttempt, {
        kind: 'rendezvous-arm',
        rendezvousId: RENDEZVOUS_ID_2,
        positionSeconds: 2,
        playbackRate: 1,
        startAtRoomTimeMs: 1_000,
        finalizeByRoomTimeMs: 900,
      }),
    );
    await vi.waitFor(() => expect(h.runtime.stageAssetSource).toHaveBeenCalledTimes(2));

    const recoveryStageOptions = h.runtime.stageAssetSource.mock.calls[1]![0];
    const lateRecoveryPort = Object.freeze(Object.create(null)) as FilePlaybackCutoverCandidatePort;
    expect(recoveryStageOptions.isCurrent()).toBe(true);

    pendingRecoveryStage.resolve(
      stagedAssetSource(h.registry, recoveryStageOptions, lateRecoveryPort),
    );
    h.guest.close();

    await vi.waitFor(() => expect(h.fatal).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(h.runtime.retireCandidate).toHaveBeenCalledWith(h.manager, lateRecoveryPort),
    );
    await vi.waitFor(() => expect(h.runtime.r2Close).toHaveBeenCalledOnce());
    expect(h.runtime.retireCandidate).toHaveBeenCalledOnce();
    expect(h.runtime.retireCurrent).toHaveBeenCalledOnce();
    expect(h.runtime.arm).toHaveBeenCalledOnce();
    expect(
      h.runtime.sent.filter((frame) => (frame as { kind?: string }).kind === 'source-ready'),
    ).toHaveLength(sourceReadyCount);
  });

  it('retains a stopped PRODUCT baseline and commits its first future run', async () => {
    const h = setup();
    h.owner.onTimelineAdopted(stoppedTimelineEvent(h.context));
    const offer = peerOffer(h.context);
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), vi.fn());
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, runBinding(offer)), vi.fn());
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.filter((frame) => (frame as { kind?: string }).kind === 'source-ready'),
      ).toHaveLength(1),
    );

    await runHostAttempt(h, h.state, SOURCE_ID, TRANSFER_ID, RENDEZVOUS_ID, 'bootstrap-stopped');
    const rendered = activeTimeline(h.state, 'playing', 0, 1_000);
    h.owner.onTimelineUpdated(timelineUpdated(h.context, rendered));
    await vi.waitFor(() => expect(h.rendered).toHaveBeenCalledWith(rendered));
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('prepares and commits an authenticated new-run successor before rendering metadata', async () => {
    const h = setup();
    await prepare(h);
    await runHostAttempt(h, h.state, SOURCE_ID, TRANSFER_ID, RENDEZVOUS_ID, 'bootstrap-current');
    const offer = peerOffer2(h.context);
    const successor = freezeCanonical({
      queueItemId: QUEUE_ID_2,
      runId: RUN_ID_2,
      revision: 2,
    });
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), vi.fn());
    h.owner.adoptAuxiliaryMessage(
      auxiliaryEvent(h.context, runBinding(offer, RUN_ID_2, 2)),
      vi.fn(),
    );
    await vi.waitFor(() => expect(h.runtime.handoffWarmSource).toHaveBeenCalledTimes(2));
    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    expect(h.runtime.primeCandidate).not.toHaveBeenCalled();
    expect(h.rendered).toHaveBeenCalledOnce();

    await runHostAttempt(
      h,
      successor,
      SOURCE_ID_2,
      TRANSFER_ID_2,
      RENDEZVOUS_ID_2,
      'successor',
      12,
    );
    const rendered = activeTimeline(successor, 'playing', 12, 1_000);
    h.owner.onTimelineUpdated(timelineUpdated(h.context, rendered));
    await vi.waitFor(() => expect(h.rendered).toHaveBeenCalledWith(rendered));
    expect(h.rendered).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(h.runtime.pendingTimeouts()).toHaveLength(1));
    h.runtime.fireNextTimeout();
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.filter(
          (frame) =>
            (frame as { kind?: string; revision?: number; rendezvousId?: string }).kind ===
              'renderer-health' &&
            (frame as { revision?: number }).revision === successor.revision &&
            (frame as { rendezvousId?: string }).rendezvousId === RENDEZVOUS_ID_2,
        ),
      ).toHaveLength(2),
    );
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('withholds same-run SOURCE_READY until the exact PREPARE target prime settles', async () => {
    const h = setup();
    await prepare(h);
    await runHostAttempt(h, h.state, SOURCE_ID, TRANSFER_ID, RENDEZVOUS_ID, 'bootstrap-current');
    expect(h.runtime.primeCandidate).not.toHaveBeenCalled();

    const successor = freezeCanonical({ ...h.state, revision: 2 });
    const stateLease = h.host.stageMedia({
      run: successor,
      sourceIdentity: SOURCE_ID,
      transferSessionId: TRANSFER_ID,
    });
    const primeGate = deferred<void>();
    const defaultPrime = h.runtime.primeCandidate.getMockImplementation();
    if (!defaultPrime) throw new Error('Fixture prime implementation is unavailable');
    h.runtime.primeCandidate.mockImplementationOnce(async (...args) => {
      await primeGate.promise;
      return defaultPrime(...args);
    });

    receiveHostWire(
      h,
      h.host.createWire(stateLease, {
        kind: 'file-playback-prepare',
        expectedQueueItemId: QUEUE_ID,
        expectedRunId: RUN_ID,
        expectedRevision: h.state.revision,
        positionSeconds: 12,
        playbackRate: 1,
      }),
    );
    await vi.waitFor(() => expect(h.runtime.primeCandidate).toHaveBeenCalledOnce());
    expect(h.runtime.primeCandidate).toHaveBeenCalledWith(
      h.manager,
      CUTOVER_PORT,
      12,
      expect.any(AbortSignal),
    );
    expect(
      h.runtime.sent.filter(
        (frame) =>
          (frame as { kind?: string; revision?: number }).kind === 'source-ready' &&
          (frame as { revision?: number }).revision === successor.revision,
      ),
    ).toHaveLength(0);

    primeGate.resolve();
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.filter(
          (frame) =>
            (frame as { kind?: string; revision?: number }).kind === 'source-ready' &&
            (frame as { revision?: number }).revision === successor.revision,
        ),
      ).toHaveLength(1),
    );
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('fail-closes a same-run ARM that changes its already primed PREPARE target', async () => {
    const h = setup();
    await prepare(h);
    await runHostAttempt(h, h.state, SOURCE_ID, TRANSFER_ID, RENDEZVOUS_ID, 'bootstrap-current');
    const successor = freezeCanonical({ ...h.state, revision: 2 });
    const stateLease = h.host.stageMedia({
      run: successor,
      sourceIdentity: SOURCE_ID,
      transferSessionId: TRANSFER_ID,
    });

    receiveHostWire(
      h,
      h.host.createWire(stateLease, {
        kind: 'file-playback-prepare',
        expectedQueueItemId: QUEUE_ID,
        expectedRunId: RUN_ID,
        expectedRevision: h.state.revision,
        positionSeconds: 12,
        playbackRate: 1,
      }),
    );
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.filter(
          (frame) =>
            (frame as { kind?: string; revision?: number }).kind === 'source-ready' &&
            (frame as { revision?: number }).revision === successor.revision,
        ),
      ).toHaveLength(1),
    );
    expect(h.runtime.primeCandidate).toHaveBeenCalledWith(
      h.manager,
      CUTOVER_PORT,
      12,
      expect.any(AbortSignal),
    );

    const attemptLease = h.host.stageAttempt(stateLease, RENDEZVOUS_ID_2);
    const armResult = h.guest.receive(
      h.host.createWire(attemptLease, {
        kind: 'rendezvous-arm',
        rendezvousId: RENDEZVOUS_ID_2,
        positionSeconds: 13,
        playbackRate: 1,
        startAtRoomTimeMs: 1_000,
        finalizeByRoomTimeMs: 900,
      }),
      h.guestConnection,
    );
    if (!armResult.accepted || armResult.frame !== 'wire') {
      throw new Error('Expected mismatched ARM wire to reach the guest owner');
    }
    const acknowledge = vi.fn();
    expect(() => h.owner.adoptWireMessage(wireEvent(h.context, armResult), acknowledge)).toThrow(
      /Guest playback wire adoption failed/u,
    );

    expect(acknowledge).not.toHaveBeenCalled();
    expect(h.fatal).toHaveBeenCalledOnce();
    expect(h.runtime.arm).toHaveBeenCalledOnce();
    expect(
      h.runtime.sent.filter(
        (frame) =>
          (frame as { kind?: string; revision?: number }).kind === 'rendezvous-armed' &&
          (frame as { revision?: number }).revision === successor.revision,
      ),
    ).toHaveLength(0);
  });

  it('does not publish same-run SOURCE_READY when target prime authority aborts', async () => {
    const h = setup();
    await prepare(h);
    await runHostAttempt(h, h.state, SOURCE_ID, TRANSFER_ID, RENDEZVOUS_ID, 'bootstrap-current');
    const primingCandidatePort = Object.freeze(
      Object.create(null),
    ) as FilePlaybackCutoverCandidatePort;
    h.runtime.stageAssetSource.mockImplementationOnce(async (options) =>
      stagedAssetSource(h.registry, options, primingCandidatePort),
    );
    const successor = freezeCanonical({ ...h.state, revision: 2 });
    const stateLease = h.host.stageMedia({
      run: successor,
      sourceIdentity: SOURCE_ID,
      transferSessionId: TRANSFER_ID,
    });
    const primeGate = deferred<void>();
    let observedSignal: AbortSignal | null = null;
    h.runtime.primeCandidate.mockImplementationOnce(async (_manager, _port, _position, signal) => {
      observedSignal = signal;
      await primeGate.promise;
      signal.throwIfAborted();
      return {} as never;
    });

    receiveHostWire(
      h,
      h.host.createWire(stateLease, {
        kind: 'file-playback-prepare',
        expectedQueueItemId: QUEUE_ID,
        expectedRunId: RUN_ID,
        expectedRevision: h.state.revision,
        positionSeconds: 12,
        playbackRate: 1,
      }),
    );
    await vi.waitFor(() => expect(h.runtime.primeCandidate).toHaveBeenCalledOnce());
    h.owner.revoke(h.context);
    expect(observedSignal?.aborted).toBe(true);
    primeGate.resolve();
    await vi.waitFor(() =>
      expect(h.runtime.retireCandidate).toHaveBeenCalledWith(h.manager, primingCandidatePort),
    );
    expect(
      h.runtime.sent.filter(
        (frame) =>
          (frame as { kind?: string; revision?: number }).kind === 'source-ready' &&
          (frame as { revision?: number }).revision === successor.revision,
      ),
    ).toHaveLength(0);
  });

  it('restages the current RAM asset for an exact-next same-run rendezvous seek', async () => {
    const h = setup();
    await prepare(h);
    await runHostAttempt(h, h.state, SOURCE_ID, TRANSFER_ID, RENDEZVOUS_ID, 'bootstrap-current');
    const successor = freezeCanonical({ ...h.state, revision: 2 });
    const stateLease = h.host.stageMedia({
      run: successor,
      sourceIdentity: SOURCE_ID,
      transferSessionId: TRANSFER_ID,
    });

    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    receiveHostWire(
      h,
      h.host.createWire(stateLease, {
        kind: 'file-playback-prepare',
        expectedQueueItemId: QUEUE_ID,
        expectedRunId: RUN_ID,
        expectedRevision: h.state.revision,
        positionSeconds: 12,
        playbackRate: 1,
      }),
    );
    await vi.waitFor(() => expect(h.runtime.stageAssetSource).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.filter(
          (frame) =>
            (frame as { kind?: string; revision?: number }).kind === 'source-ready' &&
            (frame as { revision?: number }).revision === successor.revision,
        ),
      ).toHaveLength(1),
    );
    expect(h.runtime.arm).toHaveBeenCalledOnce();

    const attemptLease = h.host.stageAttempt(stateLease, RENDEZVOUS_ID_2);
    receiveHostWire(
      h,
      h.host.createWire(attemptLease, {
        kind: 'rendezvous-arm',
        rendezvousId: RENDEZVOUS_ID_2,
        positionSeconds: 12,
        playbackRate: 1,
        startAtRoomTimeMs: 1_000,
        finalizeByRoomTimeMs: 900,
      }),
    );
    await vi.waitFor(() => expect(h.runtime.stageAssetSource).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.filter(
          (frame) =>
            (frame as { kind?: string; revision?: number }).kind === 'rendezvous-armed' &&
            (frame as { revision?: number }).revision === successor.revision,
        ),
      ).toHaveLength(1),
    );

    h.runtime.setCurrentState(successor);
    receiveHostWire(
      h,
      h.host.createWire(attemptLease, {
        kind: 'rendezvous-finalize',
        rendezvousId: RENDEZVOUS_ID_2,
        startAtRoomTimeMs: 1_000,
        finalizedAtRoomTimeMs: 155,
      }),
    );
    await vi.waitFor(() => {
      if (h.fatal.mock.calls.length > 0) throw h.fatal.mock.calls[0]![1];
      expect(
        h.runtime.sent.filter(
          (frame) =>
            (frame as { kind?: string; revision?: number }).kind === 'renderer-health' &&
            (frame as { revision?: number }).revision === successor.revision,
        ),
      ).toHaveLength(1);
    });
    h.host.commitAttempt(attemptLease);
    h.host.commitMedia(stateLease);

    const rendered = activeTimeline(successor, 'playing', 12, 1_000);
    h.owner.onTimelineUpdated(timelineUpdated(h.context, rendered));
    await vi.waitFor(() => expect(h.rendered).toHaveBeenCalledWith(rendered));
    await vi.waitFor(() => expect(h.runtime.pendingTimeouts()).toHaveLength(1));
    h.runtime.fireNextTimeout();
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.filter(
          (frame) =>
            (frame as { kind?: string; revision?: number; rendezvousId?: string }).kind ===
              'renderer-health' &&
            (frame as { revision?: number }).revision === successor.revision &&
            (frame as { rendezvousId?: string }).rendezvousId === RENDEZVOUS_ID_2,
        ),
      ).toHaveLength(2),
    );

    expect(h.runtime.prepareWarmSource).toHaveBeenCalledOnce();
    expect(h.runtime.handoffWarmSource).toHaveBeenCalledOnce();
    expect(h.runtime.stageAssetSource).toHaveBeenCalledOnce();
    expect(h.runtime.r2Acquire).not.toHaveBeenCalled();
    expect(h.runtime.seekCurrent).not.toHaveBeenCalled();
    expect(
      h.runtime.sent.filter((frame) => (frame as { kind?: string }).kind === 'source-ready'),
    ).toHaveLength(2);
    expect(h.fatal).not.toHaveBeenCalled();

    const paused = freezeCanonical({ ...successor, revision: 3 });
    const pauseLease = h.host.stageMedia({
      run: paused,
      sourceIdentity: SOURCE_ID,
      transferSessionId: TRANSFER_ID,
    });
    receiveHostWire(
      h,
      h.host.createWire(pauseLease, {
        kind: 'file-playback-pause',
        expectedQueueItemId: QUEUE_ID,
        expectedRunId: RUN_ID,
        expectedRevision: successor.revision,
        atRoomTimeMs: 300,
      }),
    );
    await vi.waitFor(() => expect(h.runtime.pauseCurrent).toHaveBeenCalledOnce());
    h.host.commitMedia(pauseLease);
    const pausedTimeline = activeTimeline(paused, 'paused', 12, 300);
    h.owner.onTimelineUpdated(timelineUpdated(h.context, pausedTimeline));
    await vi.waitFor(() => expect(h.rendered).toHaveBeenCalledWith(pausedTimeline));

    const sought = freezeCanonical({ ...successor, revision: 4 });
    const seekLease = h.host.stageMedia({
      run: sought,
      sourceIdentity: SOURCE_ID,
      transferSessionId: TRANSFER_ID,
    });
    receiveHostWire(
      h,
      h.host.createWire(seekLease, {
        kind: 'file-playback-seek',
        expectedQueueItemId: QUEUE_ID,
        expectedRunId: RUN_ID,
        expectedRevision: paused.revision,
        positionSeconds: 24,
        atRoomTimeMs: 400,
      }),
    );
    await vi.waitFor(() => expect(h.runtime.seekCurrent).toHaveBeenCalledOnce());
    h.host.commitMedia(seekLease);
    const soughtTimeline = activeTimeline(sought, 'paused', 24, 400);
    h.owner.onTimelineUpdated(timelineUpdated(h.context, soughtTimeline));
    await vi.waitFor(() => expect(h.rendered).toHaveBeenCalledWith(soughtTimeline));

    const stopped = freezeCanonical({ ...successor, revision: 5 });
    const stopLease = h.host.stageMedia({
      run: stopped,
      sourceIdentity: SOURCE_ID,
      transferSessionId: TRANSFER_ID,
    });
    receiveHostWire(
      h,
      h.host.createWire(stopLease, {
        kind: 'file-playback-stop',
        expectedQueueItemId: QUEUE_ID,
        expectedRunId: RUN_ID,
        expectedRevision: sought.revision,
        atRoomTimeMs: 500,
      }),
    );
    await vi.waitFor(() => expect(h.runtime.stopCurrent).toHaveBeenCalledOnce());
    h.host.commitStop(stopLease, sought);
    const stoppedProjection = stoppedTimeline(stopped.revision, 500);
    h.owner.onTimelineUpdated(timelineUpdated(h.context, stoppedProjection));
    await vi.waitFor(() => expect(h.rendered).toHaveBeenCalledWith(stoppedProjection));
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it.each([
    ['playing', 'running'],
    ['paused', 'running'],
    ['ended', 'running'],
    ['playing', 'suspended'],
    ['playing', 'interrupted'],
  ] as const)(
    'atomically retires an exact %s renderer with a %s context before accepting host natural-end metadata',
    async (observedPhase, audioContextState) => {
      const h = setup();
      await prepare(h);
      await runHostAttempt(h, h.state, SOURCE_ID, TRANSFER_ID, RENDEZVOUS_ID, 'bootstrap-current');
      h.runtime.setCurrentPhase(observedPhase);
      (h.graph.audioContext as unknown as { state: string }).state = audioContextState;
      const hostObservedAtRoomTimeMs = h.host.nowRoomTimeMs();

      const successor = freezeCanonical({ ...h.state, revision: 2 });
      const stateLease = h.host.stageMedia({
        run: successor,
        sourceIdentity: SOURCE_ID,
        transferSessionId: TRANSFER_ID,
      });
      const result = h.guest.receive(
        h.host.createWire(stateLease, {
          kind: 'file-playback-ended',
          expectedQueueItemId: QUEUE_ID,
          expectedRunId: RUN_ID,
          expectedRevision: h.state.revision,
          hostObservedAtRoomTimeMs,
        }),
        h.guestConnection,
      );
      if (!result.accepted || result.frame !== 'wire') {
        throw new Error(`Guest remote-end receive failed: ${JSON.stringify(result)}`);
      }
      const acknowledge = vi.fn();
      h.owner.adoptWireMessage(wireEvent(h.context, result), acknowledge);

      expect(acknowledge).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(h.runtime.remoteEndCurrent).toHaveBeenCalledOnce());
      expect(acknowledge.mock.invocationCallOrder[0]).toBeLessThan(
        h.runtime.remoteEndCurrent.mock.invocationCallOrder[0]!,
      );
      expect(h.runtime.remoteEndCurrent).toHaveBeenCalledWith(
        h.manager,
        CUTOVER_PORT,
        expect.objectContaining({
          kind: 'file-playback-remote-ended-transition',
          from: h.state,
          to: successor,
          hostObservedAtRoomTimeMs,
        }),
      );
      expect(h.runtime.stopCurrent).not.toHaveBeenCalled();
      expect(h.runtime.retireCurrent).not.toHaveBeenCalled();

      h.host.commitStop(stateLease, h.state);
      const stoppedProjection = stoppedTimeline(successor.revision, hostObservedAtRoomTimeMs);
      h.owner.onTimelineUpdated(timelineUpdated(h.context, stoppedProjection));
      await vi.waitFor(() => expect(h.rendered).toHaveBeenCalledWith(stoppedProjection));
      expect(h.fatal).not.toHaveBeenCalled();
      h.owner.revoke(h.context);
    },
  );

  it('re-stages an exact cancelled same-run attempt before admitting a fresh rendezvous', async () => {
    const h = setup();
    const armed = await stageSameRunArmedAttempt(h);
    const cancellation = deferred<void>();
    h.runtime.cancel.mockImplementationOnce(() => cancellation.promise);
    const stageCountBeforeCancel = h.runtime.stageAssetSource.mock.calls.length;
    const primeCountBeforeCancel = h.runtime.primeCandidate.mock.calls.length;
    const readyCount = () =>
      h.runtime.sent.filter(
        (frame) =>
          (frame as { kind?: string; revision?: number }).kind === 'source-ready' &&
          (frame as { revision?: number }).revision === armed.successor.revision,
      ).length;
    expect(readyCount()).toBe(1);
    const cancel = h.host.createWire(armed.attemptLease, {
      kind: 'file-playback-cancel',
      rendezvousId: RENDEZVOUS_ID_2,
      reasonCode: 'replacement-rendezvous',
    });
    const result = h.guest.receive(cancel, h.guestConnection);
    expect(result).toMatchObject({ accepted: true, frame: 'wire' });
    if (!result.accepted || result.frame !== 'wire') throw new Error('Expected cancel wire');
    const acknowledge = vi.fn();

    h.owner.adoptWireMessage(wireEvent(h.context, result), acknowledge);

    expect(acknowledge).toHaveBeenCalledOnce();
    expect(h.runtime.cancel).toHaveBeenCalledOnce();
    expect(h.runtime.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      acknowledge.mock.invocationCallOrder[0]!,
    );
    expect(h.runtime.cancel).toHaveBeenCalledWith({
      kind: 'file-playback-cancel',
      queueItemId: QUEUE_ID,
      runId: RUN_ID,
      revision: armed.successor.revision,
      rendezvousId: RENDEZVOUS_ID_2,
      reasonCode: 'replacement-rendezvous',
    });
    expect(h.runtime.stageAssetSource).toHaveBeenCalledTimes(stageCountBeforeCancel);
    expect(readyCount()).toBe(1);
    h.host.retireAttempt(armed.attemptLease);
    cancellation.resolve();
    await vi.waitFor(() => {
      expect(h.runtime.stageAssetSource).toHaveBeenCalledTimes(stageCountBeforeCancel + 1);
      expect(readyCount()).toBe(2);
    });
    expect(h.runtime.primeCandidate).toHaveBeenCalledTimes(primeCountBeforeCancel);

    const retryRendezvousId = 'guest-owner-rendezvous-retry';
    const retryAttemptLease = h.host.stageAttempt(armed.stateLease, retryRendezvousId);
    receiveHostWire(
      h,
      h.host.createWire(retryAttemptLease, {
        kind: 'rendezvous-arm',
        rendezvousId: retryRendezvousId,
        positionSeconds: 12.25,
        playbackRate: 1,
        startAtRoomTimeMs: 1_000,
        finalizeByRoomTimeMs: 900,
      }),
    );
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.filter(
          (frame) =>
            (frame as { kind?: string; revision?: number; rendezvousId?: string }).kind ===
              'rendezvous-armed' &&
            (frame as { revision?: number }).revision === armed.successor.revision &&
            (frame as { rendezvousId?: string }).rendezvousId === retryRendezvousId,
        ),
      ).toHaveLength(1),
    );
    expect(h.runtime.arm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rendezvousId: retryRendezvousId,
        positionSeconds: 12.25,
      }),
    );
    h.runtime.setCurrentState(armed.successor);
    receiveHostWire(
      h,
      h.host.createWire(retryAttemptLease, {
        kind: 'rendezvous-finalize',
        rendezvousId: retryRendezvousId,
        startAtRoomTimeMs: 1_000,
        finalizedAtRoomTimeMs: 155,
      }),
    );
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.filter(
          (frame) =>
            (frame as { kind?: string; revision?: number; rendezvousId?: string }).kind ===
              'renderer-health' &&
            (frame as { revision?: number }).revision === armed.successor.revision &&
            (frame as { rendezvousId?: string }).rendezvousId === retryRendezvousId,
        ),
      ).toHaveLength(1),
    );
    h.host.commitAttempt(retryAttemptLease);
    h.host.commitMedia(armed.stateLease);

    // The retry cuts over at the host's live projected position, but the
    // canonical timeline publication still owns the original PREPARE base.
    const rendered = activeTimeline(armed.successor, 'playing', 12, 1_000);
    h.owner.onTimelineUpdated(timelineUpdated(h.context, rendered));
    await vi.waitFor(() => expect(h.rendered).toHaveBeenCalledWith(rendered));

    expect(h.fatal).not.toHaveBeenCalled();
    expect(h.runtime.retireCurrent).not.toHaveBeenCalled();
    expect(h.runtime.peerClose).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it.each(['baseline', 'successor', 'recovery'] as const)(
    're-stages a cancelled %s attempt before admitting its fresh rendezvous',
    async (kind) => {
      const h = setup();
      const armed = await stageCancelablePreparedKind(h, kind);
      const sourceReadyCount = () =>
        h.runtime.sent.filter(
          (frame) =>
            (
              frame as {
                kind?: string;
                queueItemId?: QueueItemId;
                runId?: string;
                revision?: number;
              }
            ).kind === 'source-ready' &&
            (frame as { queueItemId?: QueueItemId }).queueItemId === armed.state.queueItemId &&
            (frame as { runId?: string }).runId === armed.state.runId &&
            (frame as { revision?: number }).revision === armed.state.revision,
        ).length;
      const stageCountBeforeCancel = h.runtime.stageAssetSource.mock.calls.length;
      const primeCountBeforeCancel = h.runtime.primeCandidate.mock.calls.length;
      const readyCountBeforeCancel = sourceReadyCount();
      const cancel = h.host.createWire(armed.attemptLease, {
        kind: 'file-playback-cancel',
        rendezvousId: armed.rendezvousId,
        reasonCode: 'replacement-rendezvous',
      });
      const result = h.guest.receive(cancel, h.guestConnection);
      if (!result.accepted || result.frame !== 'wire') throw new Error('Expected cancel wire');
      const acknowledge = vi.fn();

      h.owner.adoptWireMessage(wireEvent(h.context, result), acknowledge);
      h.host.retireAttempt(armed.attemptLease);

      expect(acknowledge).toHaveBeenCalledOnce();
      expect(h.runtime.cancel).toHaveBeenCalledOnce();
      await vi.waitFor(() => {
        if (h.fatal.mock.calls.length > 0) throw h.fatal.mock.calls[0]![1];
        expect(h.runtime.stageAssetSource).toHaveBeenCalledTimes(stageCountBeforeCancel + 1);
        expect(sourceReadyCount()).toBe(readyCountBeforeCancel + 1);
      });
      expect(h.runtime.primeCandidate).toHaveBeenCalledTimes(primeCountBeforeCancel);

      const retryRendezvousId = `guest-owner-${kind}-retry`;
      const retryPositionSeconds = armed.positionSeconds + 0.25;
      const retryAttemptLease = h.host.stageAttempt(armed.stateLease, retryRendezvousId);
      receiveHostWire(
        h,
        h.host.createWire(retryAttemptLease, {
          kind: 'rendezvous-arm',
          rendezvousId: retryRendezvousId,
          positionSeconds: retryPositionSeconds,
          playbackRate: 1,
          startAtRoomTimeMs: 1_000,
          finalizeByRoomTimeMs: 900,
        }),
      );
      await vi.waitFor(() => {
        if (h.fatal.mock.calls.length > 0) throw h.fatal.mock.calls[0]![1];
        expect(
          h.runtime.sent.filter(
            (frame) =>
              (frame as { kind?: string; rendezvousId?: string }).kind === 'rendezvous-armed' &&
              (frame as { rendezvousId?: string }).rendezvousId === retryRendezvousId,
          ),
        ).toHaveLength(1);
      });
      expect(h.runtime.arm).toHaveBeenLastCalledWith(
        expect.objectContaining({
          rendezvousId: retryRendezvousId,
          positionSeconds: retryPositionSeconds,
        }),
      );
      expect(h.fatal).not.toHaveBeenCalled();

      h.host.retireAttempt(retryAttemptLease);
      h.owner.revoke(h.context);
    },
  );

  it.each([
    ['pause', 'remote-recovery-pause-transition'],
    ['seek', 'remote-recovery-seek-transition'],
    ['stop', 'remote-recovery-stop-transition'],
    ['ended', 'remote-recovery-ended-transition'],
  ] as const)(
    'terminally retires an exact recovery before applying the following %s successor',
    async (kind, reasonCode) => {
      const h = setup();
      const recovery = await stageCancelablePreparedKind(h, 'recovery');
      const cancellation = deferred<void>();
      h.runtime.cancel.mockImplementationOnce(() => cancellation.promise);
      if (kind === 'seek') h.runtime.setCurrentPhase('paused');
      if (kind === 'ended') h.runtime.setCurrentPhase('ended');
      const stageCountBeforeCancel = h.runtime.stageAssetSource.mock.calls.length;
      const readyCountBeforeCancel = h.runtime.sent.filter(
        (frame) => (frame as { kind?: string }).kind === 'source-ready',
      ).length;

      receiveHostWire(
        h,
        h.host.createWire(recovery.attemptLease, {
          kind: 'file-playback-cancel',
          rendezvousId: recovery.rendezvousId,
          reasonCode,
        }),
      );
      h.host.retireAttempt(recovery.attemptLease);

      const successor = freezeCanonical({
        ...recovery.state,
        revision: recovery.state.revision + 1,
      });
      const stateLease = h.host.stageMedia({
        run: successor,
        sourceIdentity: SOURCE_ID,
        transferSessionId: TRANSFER_ID,
      });
      if (kind === 'pause') {
        receiveHostWire(
          h,
          h.host.createWire(stateLease, {
            kind: 'file-playback-pause',
            expectedQueueItemId: recovery.state.queueItemId,
            expectedRunId: recovery.state.runId,
            expectedRevision: recovery.state.revision,
            atRoomTimeMs: 300,
          }),
        );
      } else if (kind === 'seek') {
        receiveHostWire(
          h,
          h.host.createWire(stateLease, {
            kind: 'file-playback-seek',
            expectedQueueItemId: recovery.state.queueItemId,
            expectedRunId: recovery.state.runId,
            expectedRevision: recovery.state.revision,
            positionSeconds: 24,
            atRoomTimeMs: 300,
          }),
        );
      } else if (kind === 'stop') {
        receiveHostWire(
          h,
          h.host.createWire(stateLease, {
            kind: 'file-playback-stop',
            expectedQueueItemId: recovery.state.queueItemId,
            expectedRunId: recovery.state.runId,
            expectedRevision: recovery.state.revision,
            atRoomTimeMs: 300,
          }),
        );
      } else {
        receiveHostWire(
          h,
          h.host.createWire(stateLease, {
            kind: 'file-playback-ended',
            expectedQueueItemId: recovery.state.queueItemId,
            expectedRunId: recovery.state.runId,
            expectedRevision: recovery.state.revision,
            hostObservedAtRoomTimeMs: h.host.nowRoomTimeMs(),
          }),
        );
      }

      expect(h.runtime.cancel).toHaveBeenCalledWith(
        expect.objectContaining({
          queueItemId: recovery.state.queueItemId,
          runId: recovery.state.runId,
          revision: recovery.state.revision,
          rendezvousId: recovery.rendezvousId,
          reasonCode,
        }),
      );
      expect(h.runtime.pauseCurrent).not.toHaveBeenCalled();
      expect(h.runtime.seekCurrent).not.toHaveBeenCalled();
      expect(h.runtime.stopCurrent).not.toHaveBeenCalled();
      expect(h.runtime.remoteEndCurrent).not.toHaveBeenCalled();
      expect(h.runtime.stageAssetSource).toHaveBeenCalledTimes(stageCountBeforeCancel);
      expect(
        h.runtime.sent.filter((frame) => (frame as { kind?: string }).kind === 'source-ready'),
      ).toHaveLength(readyCountBeforeCancel);

      cancellation.resolve();
      const transition =
        kind === 'pause'
          ? h.runtime.pauseCurrent
          : kind === 'seek'
            ? h.runtime.seekCurrent
            : kind === 'stop'
              ? h.runtime.stopCurrent
              : h.runtime.remoteEndCurrent;
      await vi.waitFor(() => expect(transition).toHaveBeenCalledOnce());
      expect(h.runtime.recoveryRequired).toHaveBeenCalledWith(h.manager);
      expect(h.runtime.recoveryRequired).toHaveLastReturnedWith(false);

      const timeline =
        kind === 'stop' || kind === 'ended'
          ? stoppedTimeline(successor.revision, 300)
          : activeTimeline(successor, 'paused', kind === 'seek' ? 24 : 0, 300);
      if (kind === 'stop' || kind === 'ended') h.host.commitStop(stateLease, recovery.state);
      else h.host.commitMedia(stateLease);
      h.owner.onTimelineUpdated(timelineUpdated(h.context, timeline));
      await vi.waitFor(() => expect(h.rendered).toHaveBeenCalledWith(timeline));

      expect(h.runtime.stageAssetSource).toHaveBeenCalledTimes(stageCountBeforeCancel);
      expect(
        h.runtime.sent.filter((frame) => (frame as { kind?: string }).kind === 'source-ready'),
      ).toHaveLength(readyCountBeforeCancel);
      expect(h.fatal).not.toHaveBeenCalled();
      h.owner.revoke(h.context);
    },
  );

  it.each(['arm', 'finalize'] as const)(
    'terminal recovery cancellation fences a blocked %s before the pause successor',
    async (blockedPhase) => {
      const h = setup();
      await prepare(h);
      const initial = await runHostAttempt(
        h,
        h.state,
        SOURCE_ID,
        TRANSFER_ID,
        RENDEZVOUS_ID,
        'bootstrap-current',
      );
      const stageCountBeforeRecovery = h.runtime.stageAssetSource.mock.calls.length;
      const readyCountBeforeRecovery = h.runtime.sent.filter(
        (frame) => (frame as { kind?: string }).kind === 'source-ready',
      ).length;
      const recoveryAttemptLease = h.host.stageAttempt(initial.stateLease, RENDEZVOUS_ID_2);
      const blocked = deferred<never>();

      if (blockedPhase === 'arm') {
        h.runtime.arm.mockImplementationOnce(() => blocked.promise);
      }
      receiveHostWire(
        h,
        h.host.createWire(recoveryAttemptLease, {
          kind: 'rendezvous-arm',
          rendezvousId: RENDEZVOUS_ID_2,
          positionSeconds: 2,
          playbackRate: 1,
          startAtRoomTimeMs: 1_000,
          finalizeByRoomTimeMs: 900,
        }),
      );
      await vi.waitFor(() => expect(h.runtime.arm).toHaveBeenCalledTimes(2));

      if (blockedPhase === 'finalize') {
        await vi.waitFor(() =>
          expect(
            h.runtime.sent.filter(
              (frame) =>
                (frame as { kind?: string; rendezvousId?: string }).kind === 'rendezvous-armed' &&
                (frame as { rendezvousId?: string }).rendezvousId === RENDEZVOUS_ID_2,
            ),
          ).toHaveLength(1),
        );
        h.runtime.finalize.mockImplementationOnce(() => blocked.promise);
        receiveHostWire(
          h,
          h.host.createWire(recoveryAttemptLease, {
            kind: 'rendezvous-finalize',
            rendezvousId: RENDEZVOUS_ID_2,
            startAtRoomTimeMs: 1_000,
            finalizedAtRoomTimeMs: 155,
          }),
        );
        await vi.waitFor(() => expect(h.runtime.finalize).toHaveBeenCalledTimes(2));
      }

      h.runtime.cancel.mockImplementationOnce(async () => blocked.resolve(undefined as never));
      receiveHostWire(
        h,
        h.host.createWire(recoveryAttemptLease, {
          kind: 'file-playback-cancel',
          rendezvousId: RENDEZVOUS_ID_2,
          reasonCode: 'remote-recovery-pause-transition',
        }),
      );
      h.host.retireAttempt(recoveryAttemptLease);

      const successor = freezeCanonical({ ...h.state, revision: h.state.revision + 1 });
      const stateLease = h.host.stageMedia({
        run: successor,
        sourceIdentity: SOURCE_ID,
        transferSessionId: TRANSFER_ID,
      });
      receiveHostWire(
        h,
        h.host.createWire(stateLease, {
          kind: 'file-playback-pause',
          expectedQueueItemId: h.state.queueItemId,
          expectedRunId: h.state.runId,
          expectedRevision: h.state.revision,
          atRoomTimeMs: 300,
        }),
      );

      await vi.waitFor(() => {
        if (h.fatal.mock.calls.length > 0) throw h.fatal.mock.calls[0]![1];
        expect(h.runtime.pauseCurrent).toHaveBeenCalledOnce();
      });
      expect(
        h.runtime.sent.filter(
          (frame) =>
            (frame as { kind?: string; rendezvousId?: string }).kind === 'renderer-health' &&
            (frame as { rendezvousId?: string }).rendezvousId === RENDEZVOUS_ID_2,
        ),
      ).toHaveLength(0);
      expect(
        h.runtime.sent.filter(
          (frame) =>
            (frame as { kind?: string; rendezvousId?: string }).kind === 'rendezvous-armed' &&
            (frame as { rendezvousId?: string }).rendezvousId === RENDEZVOUS_ID_2,
        ),
      ).toHaveLength(blockedPhase === 'arm' ? 0 : 1);
      expect(h.runtime.stageAssetSource).toHaveBeenCalledTimes(stageCountBeforeRecovery + 1);
      expect(
        h.runtime.sent.filter((frame) => (frame as { kind?: string }).kind === 'source-ready'),
      ).toHaveLength(readyCountBeforeRecovery);

      h.host.commitMedia(stateLease);
      const timeline = activeTimeline(successor, 'paused', 0, 300);
      h.owner.onTimelineUpdated(timelineUpdated(h.context, timeline));
      await vi.waitFor(() => expect(h.rendered).toHaveBeenCalledWith(timeline));
      expect(h.fatal).not.toHaveBeenCalled();
      h.owner.revoke(h.context);
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'tracks cancelled-attempt physical cleanup before an ACK re-enters revoke (%s)',
    async (outcome) => {
      const lifecycleBefore = getFilePlaybackUniversalLifecycleSnapshotForTests();
      const h = setup();
      const armed = await stageSameRunArmedAttempt(h);
      const cancellation = deferred<void>();
      h.runtime.cancel.mockImplementationOnce(() => cancellation.promise);
      const lifecycleWithOwner = getFilePlaybackUniversalLifecycleSnapshotForTests();
      const cancel = h.host.createWire(armed.attemptLease, {
        kind: 'file-playback-cancel',
        rendezvousId: RENDEZVOUS_ID_2,
        reasonCode: 'replacement-rendezvous',
      });
      const result = h.guest.receive(cancel, h.guestConnection);
      if (!result.accepted || result.frame !== 'wire') throw new Error('Expected cancel wire');
      const acknowledge = vi.fn(() => h.owner.revoke(h.context));

      h.owner.adoptWireMessage(wireEvent(h.context, result), acknowledge);
      h.host.retireAttempt(armed.attemptLease);

      expect(h.runtime.cancel).toHaveBeenCalledOnce();
      expect(acknowledge).toHaveBeenCalledOnce();
      expect(h.runtime.cancel.mock.invocationCallOrder[0]).toBeLessThan(
        acknowledge.mock.invocationCallOrder[0]!,
      );
      await Promise.resolve();
      await Promise.resolve();
      const pendingCleanup = getFilePlaybackUniversalLifecycleSnapshotForTests();
      expect(pendingCleanup.kinds.connectionOwners.live).toBe(
        lifecycleBefore.kinds.connectionOwners.live,
      );
      expect(pendingCleanup.kinds.connectionOwners.retiring).toBe(
        lifecycleWithOwner.kinds.connectionOwners.retiring + 1,
      );

      if (outcome === 'resolve') cancellation.resolve();
      else cancellation.reject(new Error('fixture cancellation rejected after ACK revoke'));

      await vi.waitFor(() => {
        const settled = getFilePlaybackUniversalLifecycleSnapshotForTests();
        expect(settled.kinds.connectionOwners.live).toBe(
          lifecycleBefore.kinds.connectionOwners.live,
        );
        expect(settled.kinds.connectionOwners.retiring).toBe(
          lifecycleBefore.kinds.connectionOwners.retiring,
        );
      });
      expect(h.runtime.peerClose).toHaveBeenCalledOnce();
      expect(h.runtime.r2Close).toHaveBeenCalledOnce();
      expect(h.fatal).not.toHaveBeenCalled();
    },
  );

  it('retains terminal recovery ports for close fallback when strict cancellation rejects', async () => {
    const h = setup();
    const recoveryPort = Object.freeze(Object.create(null)) as FilePlaybackCutoverCandidatePort;
    const recovery = await stageCancelablePreparedKind(h, 'recovery', recoveryPort);
    const stageCountBeforeCancel = h.runtime.stageAssetSource.mock.calls.length;
    const readyCountBeforeCancel = h.runtime.sent.filter(
      (frame) => (frame as { kind?: string }).kind === 'source-ready',
    ).length;
    h.runtime.cancel.mockRejectedValueOnce(new Error('strict recovery retirement failed'));

    receiveHostWire(
      h,
      h.host.createWire(recovery.attemptLease, {
        kind: 'file-playback-cancel',
        rendezvousId: recovery.rendezvousId,
        reasonCode: 'remote-recovery-pause-transition',
      }),
    );
    h.host.retireAttempt(recovery.attemptLease);

    await vi.waitFor(() => expect(h.fatal).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(h.runtime.retireCandidate).toHaveBeenCalledWith(h.manager, recoveryPort),
    );
    await vi.waitFor(() =>
      expect(h.runtime.retireCurrent).toHaveBeenCalledWith(h.manager, CUTOVER_PORT),
    );
    expect(h.runtime.stageAssetSource).toHaveBeenCalledTimes(stageCountBeforeCancel);
    expect(
      h.runtime.sent.filter((frame) => (frame as { kind?: string }).kind === 'source-ready'),
    ).toHaveLength(readyCountBeforeCancel);
    expect(h.runtime.pauseCurrent).not.toHaveBeenCalled();
    expect(() => h.owner.revoke(h.context)).not.toThrow();
  });

  it.each(['current-lost', 'recovery-required'] as const)(
    'fail-closes only the peer when terminal recovery cancellation reports an unsafe survivor (%s)',
    async (failure) => {
      const h = setup();
      const recoveryPort = Object.freeze(Object.create(null)) as FilePlaybackCutoverCandidatePort;
      const recovery = await stageCancelablePreparedKind(h, 'recovery', recoveryPort);
      const stageCountBeforeCancel = h.runtime.stageAssetSource.mock.calls.length;
      const readyCountBeforeCancel = h.runtime.sent.filter(
        (frame) => (frame as { kind?: string }).kind === 'source-ready',
      ).length;
      h.runtime.cancel.mockImplementationOnce(async () => {
        if (failure === 'current-lost') h.runtime.setHasCurrentPort(false);
        else h.runtime.setPhysicalRecoveryRequired(true);
      });

      receiveHostWire(
        h,
        h.host.createWire(recovery.attemptLease, {
          kind: 'file-playback-cancel',
          rendezvousId: recovery.rendezvousId,
          reasonCode: 'remote-recovery-pause-transition',
        }),
      );
      h.host.retireAttempt(recovery.attemptLease);
      const successor = freezeCanonical({
        ...recovery.state,
        revision: recovery.state.revision + 1,
      });
      const stateLease = h.host.stageMedia({
        run: successor,
        sourceIdentity: SOURCE_ID,
        transferSessionId: TRANSFER_ID,
      });
      receiveHostWire(
        h,
        h.host.createWire(stateLease, {
          kind: 'file-playback-pause',
          expectedQueueItemId: recovery.state.queueItemId,
          expectedRunId: recovery.state.runId,
          expectedRevision: recovery.state.revision,
          atRoomTimeMs: 300,
        }),
      );

      await vi.waitFor(() => expect(h.fatal).toHaveBeenCalledOnce());
      expect(h.runtime.pauseCurrent).not.toHaveBeenCalled();
      expect(h.runtime.recoveryRequired).toHaveBeenCalled();
      if (failure === 'recovery-required') {
        expect(h.runtime.recoveryRequired).toHaveLastReturnedWith(true);
      }
      expect(h.runtime.stageAssetSource).toHaveBeenCalledTimes(stageCountBeforeCancel);
      expect(
        h.runtime.sent.filter((frame) => (frame as { kind?: string }).kind === 'source-ready'),
      ).toHaveLength(readyCountBeforeCancel);
      await vi.waitFor(() =>
        expect(h.runtime.retireCandidate).toHaveBeenCalledWith(h.manager, recoveryPort),
      );
      expect(() => h.owner.revoke(h.context)).not.toThrow();
    },
  );

  it('does not re-stage or refresh readiness when revoke wins cancelled-attempt cleanup', async () => {
    const h = setup();
    const armed = await stageSameRunArmedAttempt(h);
    const cancellation = deferred<void>();
    h.runtime.cancel.mockImplementationOnce(() => cancellation.promise);
    const stageCountBeforeCancel = h.runtime.stageAssetSource.mock.calls.length;
    const readyCountBeforeCancel = h.runtime.sent.filter(
      (frame) =>
        (frame as { kind?: string; revision?: number }).kind === 'source-ready' &&
        (frame as { revision?: number }).revision === armed.successor.revision,
    ).length;
    const cancel = h.host.createWire(armed.attemptLease, {
      kind: 'file-playback-cancel',
      rendezvousId: RENDEZVOUS_ID_2,
      reasonCode: 'replacement-rendezvous',
    });
    const result = h.guest.receive(cancel, h.guestConnection);
    if (!result.accepted || result.frame !== 'wire') throw new Error('Expected cancel wire');

    h.owner.adoptWireMessage(wireEvent(h.context, result), vi.fn());
    h.host.retireAttempt(armed.attemptLease);
    h.owner.revoke(h.context);
    cancellation.resolve();

    await vi.waitFor(() => expect(h.runtime.peerClose).toHaveBeenCalledOnce());
    expect(h.runtime.stageAssetSource).toHaveBeenCalledTimes(stageCountBeforeCancel);
    expect(
      h.runtime.sent.filter(
        (frame) =>
          (frame as { kind?: string; revision?: number }).kind === 'source-ready' &&
          (frame as { revision?: number }).revision === armed.successor.revision,
      ),
    ).toHaveLength(readyCountBeforeCancel);
    expect(h.fatal).not.toHaveBeenCalled();
  });

  it('force-retires the exact staged ports when cancelled-attempt cleanup rejects', async () => {
    const lifecycleBefore = getFilePlaybackUniversalLifecycleSnapshotForTests();
    const h = setup();
    const cancelledCandidatePort = Object.freeze(
      Object.create(null),
    ) as FilePlaybackCutoverCandidatePort;
    h.runtime.stageAssetSource.mockImplementationOnce(async (options) =>
      stagedAssetSource(h.registry, options, cancelledCandidatePort),
    );
    const armed = await stageSameRunArmedAttempt(h);
    const stageCountBeforeCancel = h.runtime.stageAssetSource.mock.calls.length;
    const readyCountBeforeCancel = h.runtime.sent.filter(
      (frame) =>
        (frame as { kind?: string; revision?: number }).kind === 'source-ready' &&
        (frame as { revision?: number }).revision === armed.successor.revision,
    ).length;
    h.runtime.cancel.mockRejectedValueOnce(new Error('cancelled-attempt cleanup failed'));
    const cancel = h.host.createWire(armed.attemptLease, {
      kind: 'file-playback-cancel',
      rendezvousId: RENDEZVOUS_ID_2,
      reasonCode: 'replacement-rendezvous',
    });
    const result = h.guest.receive(cancel, h.guestConnection);
    if (!result.accepted || result.frame !== 'wire') throw new Error('Expected cancel wire');

    h.owner.adoptWireMessage(wireEvent(h.context, result), vi.fn());
    h.host.retireAttempt(armed.attemptLease);

    await vi.waitFor(() => expect(h.fatal).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(h.runtime.retireCandidate).toHaveBeenCalledWith(h.manager, cancelledCandidatePort),
    );
    await vi.waitFor(() =>
      expect(h.runtime.retireCurrent).toHaveBeenCalledWith(h.manager, CUTOVER_PORT),
    );
    expect(h.runtime.stageAssetSource).toHaveBeenCalledTimes(stageCountBeforeCancel);
    expect(
      h.runtime.sent.filter(
        (frame) =>
          (frame as { kind?: string; revision?: number }).kind === 'source-ready' &&
          (frame as { revision?: number }).revision === armed.successor.revision,
      ),
    ).toHaveLength(readyCountBeforeCancel);

    expect(() => h.owner.revoke(h.context)).not.toThrow();
    await vi.waitFor(() => expect(h.runtime.peerClose).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.runtime.r2Close).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(getFilePlaybackUniversalLifecycleSnapshotForTests().kinds.connectionOwners.live).toBe(
        lifecycleBefore.kinds.connectionOwners.live,
      ),
    );
    const lifecycleAfter = getFilePlaybackUniversalLifecycleSnapshotForTests();
    expect(lifecycleAfter.kinds.connectionOwners.retiring).toBe(
      lifecycleBefore.kinds.connectionOwners.retiring,
    );
    expect(lifecycleAfter.kinds.connectionOwners.unconfirmed).toBe(
      lifecycleBefore.kinds.connectionOwners.unconfirmed,
    );
    expect(lifecycleAfter.invariantFaults).toBe(lifecycleBefore.invariantFaults);
    expect(lifecycleAfter.forcedRetirements).toBe(lifecycleBefore.forcedRetirements);
    expect(h.runtime.retireCandidate).toHaveBeenCalledTimes(1);
    expect(h.runtime.retireCurrent).toHaveBeenCalledTimes(1);
  });

  it('fails closed without acknowledging a replayed stale rendezvous cancel', async () => {
    const h = setup();
    const armed = await stageSameRunArmedAttempt(h);
    const cancel = h.host.createWire(armed.attemptLease, {
      kind: 'file-playback-cancel',
      rendezvousId: RENDEZVOUS_ID_2,
      reasonCode: 'replacement-rendezvous',
    });
    const result = h.guest.receive(cancel, h.guestConnection);
    if (!result.accepted || result.frame !== 'wire') throw new Error('Expected cancel wire');
    const event = wireEvent(h.context, result);
    h.owner.adoptWireMessage(event, vi.fn());
    expect(h.runtime.cancel).toHaveBeenCalledOnce();
    expect(h.fatal).not.toHaveBeenCalled();
    const staleAcknowledge = vi.fn();

    expect(() => h.owner.adoptWireMessage(event, staleAcknowledge)).toThrow(
      /Guest playback wire adoption failed/u,
    );

    expect(staleAcknowledge).not.toHaveBeenCalled();
    expect(h.runtime.cancel).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.fatal).toHaveBeenCalledOnce());
  });

  it('fails closed without acknowledging a cancel carrying another attempt lease', async () => {
    const h = setup();
    const armed = await stageSameRunArmedAttempt(h);
    const cancel = h.host.createWire(armed.attemptLease, {
      kind: 'file-playback-cancel',
      rendezvousId: RENDEZVOUS_ID_2,
      reasonCode: 'replacement-rendezvous',
    });
    const result = h.guest.receive(cancel, h.guestConnection);
    if (!result.accepted || result.frame !== 'wire') throw new Error('Expected cancel wire');
    const exactEvent = wireEvent(h.context, result);
    const mismatchedEvent = freezeCanonical({
      ...exactEvent,
      attemptLease: Object.freeze({ foreignAttempt: true }),
    }) as unknown as Readonly<FilePlaybackWireAdoptionEvent>;
    const acknowledge = vi.fn();

    expect(() => h.owner.adoptWireMessage(mismatchedEvent, acknowledge)).toThrow(
      /Guest playback wire adoption failed/u,
    );

    expect(acknowledge).not.toHaveBeenCalled();
    expect(h.runtime.cancel).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.fatal).toHaveBeenCalledOnce());
  });

  it('fails closed without acknowledging a cancel for an already committed attempt', async () => {
    const h = setup();
    const armed = await stageSameRunArmedAttempt(h);
    const cancel = h.host.createWire(armed.attemptLease, {
      kind: 'file-playback-cancel',
      rendezvousId: RENDEZVOUS_ID_2,
      reasonCode: 'replacement-rendezvous',
    });
    const result = h.guest.receive(cancel, h.guestConnection);
    if (!result.accepted || result.frame !== 'wire') throw new Error('Expected cancel wire');
    h.runtime.setCurrentState(armed.successor);
    receiveHostWire(
      h,
      h.host.createWire(armed.attemptLease, {
        kind: 'rendezvous-finalize',
        rendezvousId: RENDEZVOUS_ID_2,
        startAtRoomTimeMs: 1_000,
        finalizedAtRoomTimeMs: 155,
      }),
    );
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.filter(
          (frame) =>
            (frame as { kind?: string; revision?: number }).kind === 'renderer-health' &&
            (frame as { revision?: number }).revision === armed.successor.revision,
        ),
      ).toHaveLength(1),
    );
    h.host.commitAttempt(armed.attemptLease);
    h.host.commitMedia(armed.stateLease);
    const acknowledge = vi.fn();

    expect(() => h.owner.adoptWireMessage(wireEvent(h.context, result), acknowledge)).toThrow(
      /Guest playback wire adoption failed/u,
    );

    expect(acknowledge).not.toHaveBeenCalled();
    expect(h.runtime.cancel).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.fatal).toHaveBeenCalledOnce());
  });

  it('fails closed when an exact-next same-run ARM arrives before PREPARE', async () => {
    const h = setup();
    await prepare(h);
    await runHostAttempt(h, h.state, SOURCE_ID, TRANSFER_ID, RENDEZVOUS_ID, 'bootstrap-current');
    const successor = freezeCanonical({ ...h.state, revision: 2 });
    const stateLease = h.host.stageMedia({
      run: successor,
      sourceIdentity: SOURCE_ID,
      transferSessionId: TRANSFER_ID,
    });
    const attemptLease = h.host.stageAttempt(stateLease, RENDEZVOUS_ID_2);
    const arm = h.host.createWire(attemptLease, {
      kind: 'rendezvous-arm',
      rendezvousId: RENDEZVOUS_ID_2,
      positionSeconds: 12,
      playbackRate: 1,
      startAtRoomTimeMs: 1_000,
      finalizeByRoomTimeMs: 900,
    });
    const result = h.guest.receive(arm, h.guestConnection);
    expect(result).toMatchObject({ accepted: true, frame: 'wire' });
    if (!result.accepted || result.frame !== 'wire') throw new Error('Expected ARM wire');
    const acknowledge = vi.fn();

    expect(() => h.owner.adoptWireMessage(wireEvent(h.context, result), acknowledge)).toThrow(
      /Guest playback wire adoption failed/u,
    );

    expect(acknowledge).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.fatal).toHaveBeenCalledOnce());
    expect(h.runtime.stageAssetSource).not.toHaveBeenCalled();
    expect(h.runtime.arm).toHaveBeenCalledOnce();
  });

  it('fails closed when a same-run ARM target disagrees with its exact PREPARE', async () => {
    const h = setup();
    await prepare(h);
    await runHostAttempt(h, h.state, SOURCE_ID, TRANSFER_ID, RENDEZVOUS_ID, 'bootstrap-current');
    const successor = freezeCanonical({ ...h.state, revision: 2 });
    const stateLease = h.host.stageMedia({
      run: successor,
      sourceIdentity: SOURCE_ID,
      transferSessionId: TRANSFER_ID,
    });
    receiveHostWire(
      h,
      h.host.createWire(stateLease, {
        kind: 'file-playback-prepare',
        expectedQueueItemId: QUEUE_ID,
        expectedRunId: RUN_ID,
        expectedRevision: h.state.revision,
        positionSeconds: 12,
        playbackRate: 1,
      }),
    );
    await vi.waitFor(() =>
      expect(
        h.runtime.sent.filter(
          (frame) =>
            (frame as { kind?: string; revision?: number }).kind === 'source-ready' &&
            (frame as { revision?: number }).revision === successor.revision,
        ),
      ).toHaveLength(1),
    );
    const attemptLease = h.host.stageAttempt(stateLease, RENDEZVOUS_ID_2);
    const mismatchedArm = h.host.createWire(attemptLease, {
      kind: 'rendezvous-arm',
      rendezvousId: RENDEZVOUS_ID_2,
      positionSeconds: 13,
      playbackRate: 1,
      startAtRoomTimeMs: 1_000,
      finalizeByRoomTimeMs: 900,
    });
    const result = h.guest.receive(mismatchedArm, h.guestConnection);
    expect(result).toMatchObject({ accepted: true, frame: 'wire' });
    if (!result.accepted || result.frame !== 'wire') throw new Error('Expected ARM wire');
    const acknowledge = vi.fn();

    expect(() => h.owner.adoptWireMessage(wireEvent(h.context, result), acknowledge)).toThrow(
      /Guest playback wire adoption failed/u,
    );

    expect(acknowledge).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.fatal).toHaveBeenCalledOnce());
    expect(h.runtime.stageAssetSource).toHaveBeenCalledOnce();
    expect(h.runtime.arm).toHaveBeenCalledOnce();
  });

  it('reuses an admitted body for replay as a new run without reacquisition', async () => {
    const h = setup();
    const offer = r2Offer(h.context);
    await prepare(h, offer);
    await runHostAttempt(h, h.state, SOURCE_ID, TRANSFER_ID, RENDEZVOUS_ID, 'bootstrap-current');
    const replayState = freezeCanonical({ queueItemId: QUEUE_ID, runId: RUN_ID_2, revision: 2 });
    const replayOffer = r2ReplayOffer(h.context);
    h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, replayOffer), vi.fn());
    h.owner.adoptAuxiliaryMessage(
      auxiliaryEvent(h.context, runBinding(replayOffer, RUN_ID_2, 2)),
      vi.fn(),
    );
    await vi.waitFor(() => expect(h.runtime.stageAssetSource).toHaveBeenCalledTimes(2));
    expect(h.runtime.r2Acquire).toHaveBeenCalledOnce();

    await runHostAttempt(h, replayState, SOURCE_ID, TRANSFER_ID, RENDEZVOUS_ID_2, 'successor');
    const rendered = activeTimeline(replayState, 'playing', 0, 1_000);
    h.owner.onTimelineUpdated(timelineUpdated(h.context, rendered));
    await vi.waitFor(() => expect(h.rendered).toHaveBeenCalledWith(rendered));
    expect(h.runtime.r2Acquire).toHaveBeenCalledOnce();
    h.owner.revoke(h.context);
  });

  it('pins one opt-in route policy across initial and same-state recovery staging', async () => {
    const requestedPolicy = {
      mode: 'universal-v1' as const,
      aacBackendId: 'webcodecs' as const,
      m4aBackendId: 'webcodecs' as const,
    };
    const h = setup({ boundedRoutePolicy: requestedPolicy });
    Reflect.set(requestedPolicy, 'mode', 'current');
    const offer = r2Offer(h.context);
    await prepare(h, offer);
    const initial = await runHostAttempt(
      h,
      h.state,
      SOURCE_ID,
      TRANSFER_ID,
      RENDEZVOUS_ID,
      'bootstrap-current',
    );
    const recoveryAttempt = h.host.stageAttempt(initial.stateLease, RENDEZVOUS_ID_2);
    receiveHostWire(
      h,
      h.host.createWire(recoveryAttempt, {
        kind: 'rendezvous-arm',
        rendezvousId: RENDEZVOUS_ID_2,
        positionSeconds: 2,
        playbackRate: 1,
        startAtRoomTimeMs: 1_000,
        finalizeByRoomTimeMs: 900,
      }),
    );
    await vi.waitFor(() => expect(h.runtime.arm).toHaveBeenCalledTimes(2));
    receiveHostWire(
      h,
      h.host.createWire(recoveryAttempt, {
        kind: 'rendezvous-finalize',
        rendezvousId: RENDEZVOUS_ID_2,
        startAtRoomTimeMs: 1_000,
        finalizedAtRoomTimeMs: 155,
      }),
    );
    await vi.waitFor(() => expect(h.runtime.commitAttempt).toHaveBeenCalledTimes(2));
    expect(h.runtime.r2Acquire).toHaveBeenCalledOnce();
    expect(h.runtime.stageAssetSource).toHaveBeenCalledTimes(2);
    for (const [stageOptions] of h.runtime.stageAssetSource.mock.calls) {
      expect(stageOptions.boundedRoutePolicy).toBe(FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY);
      expect(Object.isFrozen(stageOptions.boundedRoutePolicy)).toBe(true);
    }
    expect(h.rendered).toHaveBeenCalledOnce();
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('serializes pause, paused seek, and stop evidence before exact metadata commits', async () => {
    const h = setup();
    await prepare(h);
    await runHostAttempt(h, h.state, SOURCE_ID, TRANSFER_ID, RENDEZVOUS_ID, 'bootstrap-current');

    const paused = freezeCanonical({ ...h.state, revision: 2 });
    const pauseLease = h.host.stageMedia({
      run: paused,
      sourceIdentity: SOURCE_ID,
      transferSessionId: TRANSFER_ID,
    });
    receiveHostWire(
      h,
      h.host.createWire(pauseLease, {
        kind: 'file-playback-pause',
        expectedQueueItemId: QUEUE_ID,
        expectedRunId: RUN_ID,
        expectedRevision: 1,
        atRoomTimeMs: 300,
      }),
    );
    await vi.waitFor(() => expect(h.runtime.pauseCurrent).toHaveBeenCalledOnce());
    h.host.commitMedia(pauseLease);
    const pausedTimeline = activeTimeline(paused, 'paused', 0, 300);
    h.owner.onTimelineUpdated(timelineUpdated(h.context, pausedTimeline));
    await vi.waitFor(() => expect(h.rendered).toHaveBeenCalledWith(pausedTimeline));

    const sought = freezeCanonical({ ...h.state, revision: 3 });
    const seekLease = h.host.stageMedia({
      run: sought,
      sourceIdentity: SOURCE_ID,
      transferSessionId: TRANSFER_ID,
    });
    receiveHostWire(
      h,
      h.host.createWire(seekLease, {
        kind: 'file-playback-seek',
        expectedQueueItemId: QUEUE_ID,
        expectedRunId: RUN_ID,
        expectedRevision: 2,
        positionSeconds: 24,
        atRoomTimeMs: 400,
      }),
    );
    await vi.waitFor(() => expect(h.runtime.seekCurrent).toHaveBeenCalledOnce());
    h.host.commitMedia(seekLease);
    const soughtTimeline = activeTimeline(sought, 'paused', 24, 400);
    h.owner.onTimelineUpdated(timelineUpdated(h.context, soughtTimeline));
    await vi.waitFor(() => expect(h.rendered).toHaveBeenCalledWith(soughtTimeline));

    const stopped = freezeCanonical({ ...h.state, revision: 4 });
    const stopLease = h.host.stageMedia({
      run: stopped,
      sourceIdentity: SOURCE_ID,
      transferSessionId: TRANSFER_ID,
    });
    receiveHostWire(
      h,
      h.host.createWire(stopLease, {
        kind: 'file-playback-stop',
        expectedQueueItemId: QUEUE_ID,
        expectedRunId: RUN_ID,
        expectedRevision: 3,
        atRoomTimeMs: 500,
      }),
    );
    await vi.waitFor(() => expect(h.runtime.stopCurrent).toHaveBeenCalledOnce());
    h.host.commitStop(stopLease, sought);
    const stoppedProjection = stoppedTimeline(4, 500);
    h.owner.onTimelineUpdated(timelineUpdated(h.context, stoppedProjection));
    await vi.waitFor(() => expect(h.rendered).toHaveBeenCalledWith(stoppedProjection));

    h.owner.onTimelineUpdated(timelineUpdated(h.context, stoppedProjection));
    await Promise.resolve();
    expect(h.rendered).toHaveBeenCalledTimes(4);
    expect(h.runtime.pauseCurrent.mock.invocationCallOrder[0]).toBeLessThan(
      h.runtime.seekCurrent.mock.invocationCallOrder[0]!,
    );
    expect(h.runtime.seekCurrent.mock.invocationCallOrder[0]).toBeLessThan(
      h.runtime.stopCurrent.mock.invocationCallOrder[0]!,
    );
    expect(h.fatal).not.toHaveBeenCalled();
    h.owner.revoke(h.context);
  });

  it('fails closed when metadata advances without an exact physical commit', async () => {
    const h = setup();
    h.owner.onTimelineAdopted(timelineEvent(h.context));
    const stale = activeTimeline(freezeCanonical({ ...h.state, revision: 2 }), 'paused', 0, 300);
    h.owner.onTimelineUpdated(timelineUpdated(h.context, stale));
    await vi.waitFor(() => expect(h.fatal).toHaveBeenCalledOnce());
    expect(h.rendered).not.toHaveBeenCalled();
  });

  it('fails closed before acknowledgement when media arrives before PRODUCT READY timeline', async () => {
    const h = setup();
    const acknowledge = vi.fn();

    expect(() =>
      h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, peerOffer(h.context)), acknowledge),
    ).toThrow(FilePlaybackProductGuestMediaOwnerFatalError);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(h.fatal).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.runtime.r2Close).toHaveBeenCalledOnce());
    expect(h.runtime.peerClose).toHaveBeenCalledOnce();
  });

  it('requires the exact router context for idempotent revoke cleanup', async () => {
    const h = setup();
    const copied = freezeCanonical({ ...h.context });

    expect(() => h.owner.revoke(copied)).toThrow(FilePlaybackProductGuestMediaOwnerFatalError);
    expect(h.fatal).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.runtime.r2Close).toHaveBeenCalledOnce());
    expect(h.runtime.peerClose).toHaveBeenCalledOnce();
    expect(() => h.owner.revoke(h.context)).not.toThrow();
    expect(h.runtime.r2Close).toHaveBeenCalledOnce();
  });

  it('publishes one stable close identity before synchronous cleanup re-entry', async () => {
    const h = setup();
    const before = getFilePlaybackUniversalLifecycleSnapshotForTests();
    h.runtime.r2Close.mockImplementationOnce(() => {
      h.owner.revoke(h.context);
      return Promise.resolve();
    });

    h.owner.revoke(h.context);

    await vi.waitFor(() => expect(h.runtime.r2Close).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.runtime.peerClose).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        getFilePlaybackUniversalLifecycleSnapshotForTests().kinds.connectionOwners.releasedTotal,
      ).toBe(before.kinds.connectionOwners.releasedTotal + 1),
    );
    const retired = getFilePlaybackUniversalLifecycleSnapshotForTests();
    expect(retired.invariantFaults).toBe(before.invariantFaults);
    expect(retired.forcedRetirements).toBe(before.forcedRetirements);
    expect(retired.kinds.connectionOwners.live).toBe(before.kinds.connectionOwners.live - 1);
    expect(retired.kinds.connectionOwners.retiring).toBe(before.kinds.connectionOwners.retiring);
  });
});
