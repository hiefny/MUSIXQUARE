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
import { FilePlaybackAssetRegistry } from '../file-playback-asset-registry.ts';
import type { StagedFilePlaybackAssetSource } from '../file-playback-asset-source-stager.ts';
import {
  FilePlaybackManager,
  type FilePlaybackCutoverCandidatePort,
} from '../file-playback-manager.ts';
import {
  createPeerRangeFileMediaSourceOfferV2,
  createR2WholeBlobFileMediaSourceOfferV2,
  type FileMediaSourceOfferV2,
} from '../file-media-source-offer.ts';
import {
  createFilePlaybackProductGuestMediaOwner,
  FilePlaybackProductGuestMediaOwnerFatalError,
  type FilePlaybackProductGuestMediaOwnerOptions,
  type FilePlaybackProductGuestMediaOwnerRuntimeForTests,
} from '../file-playback-product-guest-media-owner.ts';
import type { FilePlaybackProductSessionRouterConnectionContext } from '../file-playback-product-session-router.ts';
import { createFilePlaybackRunBindingV2 } from '../file-playback-run-binding.ts';
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
const ROOM_TOKEN = Object.freeze({ room: 'guest-owner' });
const CUTOVER_PORT = Object.freeze(Object.create(null)) as FilePlaybackCutoverCandidatePort;

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

function runBinding(offer: Readonly<FileMediaSourceOfferV2>) {
  return createFilePlaybackRunBindingV2({
    sessionId: offer.sessionId,
    connectionId: offer.connectionId,
    prepareId: offer.prepareId,
    prepareRevision: offer.prepareRevision,
    queueItemId: offer.queueItemId,
    sourceIdentity: offer.sourceIdentity,
    transferSessionId: offer.transferSessionId,
    runId: RUN_ID,
    playbackRevision: 1,
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

function runtimeHarness(
  registry: FilePlaybackAssetRegistry,
  state: Readonly<PlaybackStateIdentity>,
) {
  const sent: unknown[] = [];
  const peerAcceptBulk = vi.fn(() => 'accepted' as never);
  const peerClose = vi.fn();
  const peerTransport = {
    read: vi.fn(async () => new Uint8Array()),
    acceptBulk: peerAcceptBulk,
    close: peerClose,
    closeHandle: vi.fn(),
  };
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
    const asset = registry.snapshotForLease(ROOM_TOKEN, options.assetLease);
    if (!asset) throw new Error('missing staged asset');
    return freezeCanonical({
      cutoverPort: CUTOVER_PORT,
      backend: asset.kind === 'blob' ? ('audio-buffer' as const) : ('streaming-flac' as const),
      sourceIdentity: asset.sourceIdentity,
      asset,
      metadata: freezeCanonical({ name: asset.name, mime: asset.mime }),
      readiness: freezeCanonical({
        durationSeconds: 120,
        bufferedAheadSeconds: asset.kind === 'blob' ? 120 : 8,
        outputSampleRateHz: 48_000,
        channelCount: 2,
      }),
    }) satisfies Readonly<StagedFilePlaybackAssetSource>;
  });
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
  const retireCandidate = vi.fn(async () => true);
  const retireCurrent = vi.fn(async () => true);
  const currentSnapshot = vi.fn(() => ({
    schemaVersion: 1 as const,
    queueItemId: state.queueItemId,
    backend: 'streaming-flac' as const,
    phase: 'playing' as const,
    revision: state.revision,
    run: state,
    durationSeconds: 120,
    positionSeconds: 0,
    bufferedAheadSeconds: 8,
    outputSampleRateHz: 48_000,
    channelCount: 2,
    underrunCount: 0,
    errorCode: null,
  }));
  const runtime: FilePlaybackProductGuestMediaOwnerRuntimeForTests = {
    createPeerTransport: () => peerTransport,
    createR2Acquirer: () => ({
      acquire: r2Acquire,
      removeQueueItem: vi.fn(async () => true),
      close: r2Close,
    }),
    stageAssetSource,
    createParticipant: (options) => ({
      participantId: options.participantId,
      arm,
      finalize,
      started,
      commitAttempt,
    }),
    currentPort: () => CUTOVER_PORT,
    currentSnapshot: (_manager, _port) => currentSnapshot(),
    retireCandidate,
    retireCurrent,
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
    r2Acquire,
    r2Close,
    stageAssetSource,
    arm,
    finalize,
    started,
    commitAttempt,
    retireCandidate,
    retireCurrent,
  };
}

function setup(
  overrides: Pick<Partial<FilePlaybackProductGuestMediaOwnerOptions>, 'getAudioGraph'> = {},
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
    sendRequired: runtime.sendRequired,
    canSendPeerControl: vi.fn(() => true),
    onFatalConnection: fatal,
    runtimeForTests: runtime.runtime,
  };
  const owner = createFilePlaybackProductGuestMediaOwner(options);
  return { ...pair, registry, manager, state, runtime, fatal, options, owner };
}

async function prepare(
  h: ReturnType<typeof setup>,
  offer: Readonly<FileMediaSourceOfferV2> = peerOffer(h.context),
): Promise<void> {
  h.owner.onTimelineAdopted(timelineEvent(h.context));
  const offerAck = vi.fn();
  h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, offer), offerAck);
  expect(offerAck).toHaveBeenCalledOnce();
  const binding = runBinding(offer);
  const bindingAck = vi.fn();
  h.owner.adoptAuxiliaryMessage(auxiliaryEvent(h.context, binding), bindingAck);
  expect(bindingAck).toHaveBeenCalledOnce();
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

describe('FilePlaybackProductGuestMediaOwner', () => {
  it('completes peer-range native FLAC late join through physical health evidence', async () => {
    const h = setup();
    expect(Object.keys(h.owner)).toEqual([
      'onTimelineAdopted',
      'adoptAuxiliaryMessage',
      'adoptWireMessage',
      'adoptPeerRangeBulk',
      'revoke',
    ]);
    expect(Object.getPrototypeOf(h.owner)).toBeNull();
    expect(Object.isFrozen(h.owner)).toBe(true);

    await prepare(h);
    expect(h.runtime.stageAssetSource).toHaveBeenCalledOnce();
    const stageOptions = h.runtime.stageAssetSource.mock.calls[0]![0];
    expect(h.registry.snapshotForLease(ROOM_TOKEN, stageOptions.assetLease)).toMatchObject({
      kind: 'peer-range',
      sourceIdentity: SOURCE_ID,
    });
    expect(
      h.runtime.sent.find((frame) => (frame as { kind?: string }).kind === 'source-ready'),
    ).toMatchObject({
      backend: 'streaming-flac',
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
    expect(h.fatal).not.toHaveBeenCalled();

    h.owner.revoke(h.context);
    await vi.waitFor(() => expect(h.runtime.r2Close).toHaveBeenCalledOnce());
    expect(h.runtime.peerClose).toHaveBeenCalledOnce();
    expect(h.runtime.retireCurrent).toHaveBeenCalledOnce();
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
});
