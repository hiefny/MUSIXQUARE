import { describe, expect, it, vi } from 'vitest';

// Product-owner pairing stays real through manifest admission, decoder construction, and staging.

import { FilePlaybackConnectionChannel } from '../../network/file-playback-connection-channel.ts';
import {
  FilePlaybackGuestSessionHandshake,
  FilePlaybackHandshakeIdIssuer,
  FilePlaybackHostSessionHandshake,
} from '../../network/file-playback-session-handshake.ts';
import type { DataConnection, QueueItemId } from '../../types/index.ts';
import type {
  HostPreparedLocalTrack,
  HostPeerRangeManifestPublication,
  HostPeerRangeSource,
} from '../file-playback-host-first-file-engine.ts';
import type { StreamingAacPlaybackSource } from '../backends/streaming-aac-playback-source.ts';
import type { StreamingMp3PlaybackSource } from '../backends/streaming-mp3-playback-source.ts';
import { FilePlaybackAssetRegistry } from '../file-playback-asset-registry.ts';
import {
  stageFilePlaybackPeerRangeManifestAssetSource,
  type FilePlaybackPeerRangeManifestAssetSourceStagerRuntimeForTests,
  type StageFilePlaybackPeerRangeManifestAssetSourceOptions,
} from '../file-playback-asset-source-stager.ts';
import { FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY } from '../file-playback-bounded-route-policy.ts';
import {
  FilePlaybackManager,
  type FilePlaybackCutoverCandidatePort,
} from '../file-playback-manager.ts';
import {
  prepareFilePlaybackPeerRangeManifestDecoderConstruction,
  retireFilePlaybackPeerRangeManifestDecoderConstruction,
  type FilePlaybackPeerRangeManifestDecoderConstruction,
} from '../file-playback-peer-range-manifest-decoder-bridge.ts';
import {
  createFilePlaybackProductGuestMediaOwner,
  type FilePlaybackProductGuestMediaOwnerPort,
  type FilePlaybackProductGuestMediaOwnerRuntimeForTests,
} from '../file-playback-product-guest-media-owner.ts';
import {
  FilePlaybackProductHostMediaOwner,
  type FilePlaybackProductHostMediaRoomPort,
} from '../file-playback-product-host-media-owner.ts';
import { FilePlaybackR2WholeBlobPublisher } from '../file-playback-r2-whole-blob-publisher.ts';
import type { FilePlaybackProductSessionRouterConnectionContext } from '../file-playback-product-session-router.ts';
import type {
  FilePlaybackCutoverSource,
  FilePlaybackSourcePhase,
  FilePlaybackSourceSnapshot,
} from '../file-playback-source.ts';
import {
  encodeCodecTimelineManifest,
  type CodecTimelineManifest,
} from '../manifests/codec-timeline-manifest.ts';
import { computeCodecTimelineSourceBindingSha256 } from '../manifests/codec-timeline-source-binding.ts';
import { parseMpegLayer3FrameHeader } from '../mp3/frame-header.ts';
import { createMp3SampleTimeline } from '../mp3/timeline.ts';
import type {
  EncodedAudioSource,
  EncodedAudioSourceMetadata,
} from '../sources/encoded-audio-source.ts';
import {
  parsePeerRangeControlFrame,
  type PeerRangeBulkFrame,
  type PeerRangeReadFrame,
} from '../sources/peer-range-protocol.ts';
import { FramedPeerRangeClientTransport } from '../sources/peer-range-transport.ts';

type ManifestCodec = 'adts-aac-lc' | 'mp3-no-frame-count';

const QUEUE_ID = 'b2000000-0000-4000-8000-000000000001' as QueueItemId;
const RUN_ID = 'b2000000-0000-4000-8000-000000000002';
const SOURCE_ID = 'paired-manifest-source';
const TRANSFER_ID = 'paired-manifest-transfer';

let pairSequence = 0;

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
}

function makeAdtsFrame(length: number, fill: number): Uint8Array {
  const bytes = new Uint8Array(length).fill(fill);
  const sampleRateIndex = 4;
  const channels = 2;
  bytes[0] = 0xff;
  bytes[1] = 0xf1;
  bytes[2] = (1 << 6) | (sampleRateIndex << 2) | ((channels >>> 2) & 1);
  bytes[3] = ((channels & 0b11) << 6) | ((length >>> 11) & 0b11);
  bytes[4] = (length >>> 3) & 0xff;
  bytes[5] = ((length & 0b111) << 5) | 0b1_1111;
  bytes[6] = 0b1111_1100;
  return bytes;
}

const ADTS_FRAMES = Object.freeze([
  makeAdtsFrame(19, 0x11),
  makeAdtsFrame(41, 0x22),
  makeAdtsFrame(83, 0x33),
]);

function adtsMedia(): Uint8Array {
  return concatenate(...ADTS_FRAMES);
}

function adtsManifest(
  media: Uint8Array,
  sourceBinding: Uint8Array,
): Extract<CodecTimelineManifest, { codec: 'adts-aac-lc' }> {
  let byteOffset = 0;
  const points = ADTS_FRAMES.map((frame, frameOrdinal) => {
    const point = { frameOrdinal, byteOffset };
    byteOffset += frame.byteLength;
    return point;
  });
  return {
    manifestVersion: 1,
    codec: 'adts-aac-lc',
    sourceBindingSha256: Array.from(sourceBinding),
    sourceSize: media.byteLength,
    audioStartByte: 0,
    audioEndByte: media.byteLength,
    frameCount: ADTS_FRAMES.length,
    sampleRateHz: 44_100,
    samplesPerFrame: 1_024,
    channels: 2,
    mpegId: 0,
    profile: 1,
    audioObjectType: 2,
    sampleRateIndex: 4,
    channelConfiguration: 2,
    protectionAbsent: true,
    rawDataBlocks: 1,
    points,
  };
}

function makeMp3Frame(fill: number, mainDataBeginBytes: number): Uint8Array {
  const headerBytes = Uint8Array.of(0xff, 0xfb, 0x90, 0x00);
  const header = parseMpegLayer3FrameHeader(headerBytes);
  const bytes = new Uint8Array(header.frameLengthBytes).fill(fill);
  bytes.set(headerBytes);
  bytes[4] = mainDataBeginBytes >>> 1;
  bytes[5] = (mainDataBeginBytes & 1) << 7;
  return bytes;
}

const MP3_FRAMES = Object.freeze(
  Array.from({ length: 8 }, (_value, index) =>
    makeMp3Frame(index + 1, index === 0 ? 0 : 16 + index),
  ),
);

function mp3Media(): Uint8Array {
  return concatenate(...MP3_FRAMES);
}

function mp3Manifest(
  media: Uint8Array,
  sourceBinding: Uint8Array,
): Extract<CodecTimelineManifest, { codec: 'mp3-no-frame-count' }> {
  const header = parseMpegLayer3FrameHeader(MP3_FRAMES[0]!.subarray(0, 4));
  let byteOffset = 0;
  const points = MP3_FRAMES.map((frame, frameOrdinal) => {
    const point = {
      frameOrdinal,
      byteOffset,
      mainDataCapacityBytes: header.mainDataCapacityBytes,
      mainDataBeginBytes: frameOrdinal === 0 ? 0 : 16 + frameOrdinal,
    };
    byteOffset += frame.byteLength;
    return point;
  });
  const totalRawSamples = MP3_FRAMES.length * 1_152;
  return {
    manifestVersion: 1,
    codec: 'mp3-no-frame-count',
    sourceBindingSha256: Array.from(sourceBinding),
    sourceSize: media.byteLength,
    audioStartByte: 0,
    audioEndByte: media.byteLength,
    frameCount: MP3_FRAMES.length,
    sampleRateHz: 44_100,
    samplesPerFrame: 1_152,
    channels: 2,
    mpegVersion: '1',
    layer: 3,
    hasFrameCountDeclaration: false,
    hasTagFrame: false,
    tagFrameBytes: 0,
    gapless: null,
    totalMediaFrames: createMp3SampleTimeline({
      totalRawSamples,
      samplesPerFrame: 1_152,
      gapless: null,
    }).totalMediaFrames,
    points,
  };
}

class MemorySource implements EncodedAudioSource {
  readonly kind = 'peer-range' as const;
  readonly size: number;
  readonly metadata: Readonly<EncodedAudioSourceMetadata>;

  constructor(
    readonly bytes: Uint8Array,
    readonly identity: string,
    name: string,
    mime: string,
  ) {
    this.size = bytes.byteLength;
    this.metadata = Object.freeze({ name, mime });
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    return this.bytes.slice(offset, offset + length);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

interface ManifestFixture {
  readonly codec: ManifestCodec;
  readonly media: Uint8Array;
  readonly manifest: Uint8Array;
  readonly bundle: Uint8Array;
  readonly name: string;
  readonly mime: string;
  readonly publication: Readonly<HostPeerRangeManifestPublication>;
}

async function manifestFixture(codec: ManifestCodec): Promise<ManifestFixture> {
  const media = codec === 'adts-aac-lc' ? adtsMedia() : mp3Media();
  const name = codec === 'adts-aac-lc' ? 'paired-bounded.aac' : 'paired-bounded.mp3';
  const mime = codec === 'adts-aac-lc' ? 'audio/aac' : 'audio/mpeg';
  const sourceBinding = await computeCodecTimelineSourceBindingSha256(
    {
      schemaVersion: 1,
      queueItemId: QUEUE_ID,
      sourceIdentity: SOURCE_ID,
      transferSessionId: TRANSFER_ID,
      encodedSize: media.byteLength,
      name,
      mime,
    },
    new MemorySource(media, SOURCE_ID, name, mime),
    new AbortController().signal,
  );
  const manifest = encodeCodecTimelineManifest(
    codec === 'adts-aac-lc'
      ? adtsManifest(media, sourceBinding)
      : mp3Manifest(media, sourceBinding),
  );
  const publication = freezeCanonical({
    codec,
    manifestByteLength: manifest.byteLength,
    manifestSha256B64: base64(await sha256(manifest)),
  });
  return freezeCanonical({
    codec,
    media,
    manifest,
    bundle: concatenate(manifest, media),
    name,
    mime,
    publication,
  });
}

function dataConnection(label: string): DataConnection {
  return {
    peer: label,
    open: true,
    dataChannel: { readyState: 'open', bufferedAmount: 0 },
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as DataConnection;
}

interface EstablishedPair {
  readonly hostConnection: DataConnection;
  readonly guestConnection: DataConnection;
  readonly hostChannel: FilePlaybackConnectionChannel;
  readonly guestChannel: FilePlaybackConnectionChannel;
  readonly hostContext: Readonly<FilePlaybackProductSessionRouterConnectionContext>;
  readonly guestContext: Readonly<FilePlaybackProductSessionRouterConnectionContext>;
}

function establishedPair(): EstablishedPair {
  pairSequence += 1;
  const suffix = pairSequence;
  const hostIds = new FilePlaybackHandshakeIdIssuer({
    createSessionId: () => `paired-manifest:session:${suffix}`,
    createConnectionId: () => `paired-manifest:connection:${suffix}`,
    createHelloId: () => `paired-manifest:host-hello:${suffix}`,
  });
  const guestIds = new FilePlaybackHandshakeIdIssuer({
    createSessionId: () => `paired-manifest:guest-session:${suffix}`,
    createConnectionId: () => `paired-manifest:guest-connection:${suffix}`,
    createHelloId: () => `paired-manifest:guest-hello:${suffix}`,
  });
  const hostHandshake = new FilePlaybackHostSessionHandshake({
    idIssuer: hostIds,
    sessionId: hostIds.issueSessionId(),
    connectionId: hostIds.issueConnectionId(),
    hostParticipantId: 'paired-manifest-host',
    guestParticipantId: 'paired-manifest-guest',
  });
  const guestHandshake = new FilePlaybackGuestSessionHandshake({
    idIssuer: guestIds,
    guestParticipantId: 'paired-manifest-guest',
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

  const hostConnection = dataConnection(`paired-manifest-host:${suffix}`);
  const guestConnection = dataConnection(`paired-manifest-guest:${suffix}`);
  let now = 1_000;
  const hostChannel = new FilePlaybackConnectionChannel(hostHandshake, hostConnection, {
    now: () => now,
  });
  const guestChannel = new FilePlaybackConnectionChannel(guestHandshake, guestConnection, {
    now: () => now,
    guestAppliedSendConfirmed: true,
  });
  for (let sample = 0; sample < 5; sample += 1) {
    now += 10;
    const ping = guestChannel.createClockPing();
    const receivedPing = hostChannel.receive(ping, hostConnection);
    if (!receivedPing.accepted || receivedPing.frame !== 'clock-ping') {
      throw new Error('clock ping failed');
    }
    now += 1;
    const receivedPong = guestChannel.receive(receivedPing.pong, guestConnection);
    if (!receivedPong.accepted || receivedPong.frame !== 'clock-pong') {
      throw new Error('clock pong failed');
    }
  }
  if (!guestChannel.clockReady()) throw new Error('guest clock was not calibrated');
  const binding = hostChannel.establishedBinding();
  if (!binding) throw new Error('established binding unavailable');

  const contextBase = {
    schemaVersion: 1 as const,
    routerToken: freezeCanonical({ router: `paired-manifest:${suffix}` }),
    sessionId: binding.sessionId,
    connectionId: binding.connectionId,
    hostParticipantId: binding.hostParticipantId,
    guestParticipantId: binding.guestParticipantId,
  };
  return freezeCanonical({
    hostConnection,
    guestConnection,
    hostChannel,
    guestChannel,
    hostContext: freezeCanonical({
      ...contextBase,
      role: 'host' as const,
      connection: hostConnection,
      channel: hostChannel,
      connectionToken: hostConnection,
    }),
    guestContext: freezeCanonical({
      ...contextBase,
      role: 'guest' as const,
      connection: guestConnection,
      channel: guestChannel,
      connectionToken: guestConnection,
    }),
  });
}

function preparedTrack(fixture: ManifestFixture): Readonly<HostPreparedLocalTrack> {
  return freezeCanonical({
    schemaVersion: 1 as const,
    roomGeneration: 1,
    backend: 'bounded-stream' as const,
    state: freezeCanonical({ queueItemId: QUEUE_ID, runId: RUN_ID, revision: 1 }),
    positionSeconds: 0,
    playbackRate: 1,
    sourceLease: null,
    asset: freezeCanonical({
      kind: 'blob' as const,
      binding: freezeCanonical({
        queueItemId: QUEUE_ID,
        sourceIdentity: SOURCE_ID,
        transferSessionId: TRANSFER_ID,
      }),
      metadata: freezeCanonical({ name: fixture.name, mime: fixture.mime }),
      encodedSize: fixture.media.byteLength,
      peerRangeManifest: fixture.publication,
    }),
  });
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
      phase: 'paused' as const,
      run: freezeCanonical({ queueItemId: QUEUE_ID, runId: RUN_ID }),
      positionSeconds: 0,
      anchorMonotonicMs: 1_000,
      rate: 1,
    }),
  });
}

function audioGraph() {
  const audioContext = {
    state: 'running',
    sampleRate: 48_000,
    currentTime: 0,
  } as AudioContext;
  return freezeCanonical({
    audioContext,
    destination: { context: audioContext } as unknown as AudioNode,
  });
}

interface FakeStreamingSourceHarness {
  readonly source: FilePlaybackCutoverSource;
  readonly prepare: ReturnType<typeof vi.fn>;
  readonly connect: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly closeEncodedSource: ReturnType<typeof vi.fn>;
}

function fakeStreamingSource(
  encodedSource: EncodedAudioSource,
  stagedMedia: Uint8Array[],
): FakeStreamingSourceHarness {
  let phase: FilePlaybackSourcePhase = 'new';
  let destroyed = false;
  const snapshot = (): FilePlaybackSourceSnapshot => ({
    schemaVersion: 1,
    queueItemId: QUEUE_ID,
    backend: 'bounded-stream',
    phase,
    revision: 0,
    run: null,
    durationSeconds: phase === 'new' || phase === 'destroyed' ? null : 1,
    positionSeconds: 0,
    bufferedAheadSeconds: phase === 'new' || phase === 'destroyed' ? 0 : 1,
    outputSampleRateHz: phase === 'new' || phase === 'destroyed' ? null : 48_000,
    channelCount: phase === 'new' || phase === 'destroyed' ? null : 2,
    underrunCount: 0,
    errorCode: null,
  });
  const closeEncodedSource = vi.fn(() => encodedSource.close());
  const prepare = vi.fn(async (signal?: AbortSignal) => {
    const activeSignal = signal ?? new AbortController().signal;
    activeSignal.throwIfAborted();
    stagedMedia.push(await encodedSource.readAt(0, encodedSource.size, activeSignal));
    activeSignal.throwIfAborted();
    phase = 'ready';
    return snapshot();
  });
  const connect = vi.fn(async (_destination: AudioNode) => {
    if (phase !== 'ready') throw new Error('fake streaming source was not prepared');
    phase = 'connected';
    return snapshot();
  });
  const destroy = vi.fn(async () => {
    if (destroyed) return;
    destroyed = true;
    await closeEncodedSource();
    phase = 'destroyed';
  });
  const source = {
    queueItemId: QUEUE_ID,
    backend: 'bounded-stream' as const,
    prepare,
    connect,
    primeForCutover: vi.fn(async (_positionSeconds, signal) => {
      signal.throwIfAborted();
      return snapshot();
    }),
    arm: vi.fn(async () => ({}) as never),
    armForCutover: vi.fn(async () => ({}) as never),
    finalize: vi.fn(async () => ({}) as never),
    cancel: vi.fn(async () => snapshot()),
    pause: vi.fn(async () => snapshot()),
    pauseRevisioned: vi.fn(async () => ({}) as never),
    seek: vi.fn(async () => snapshot()),
    seekRevisioned: vi.fn(async () => ({}) as never),
    positionAt: vi.fn(() => ({
      queueItemId: QUEUE_ID,
      run: null,
      phase,
      positionSeconds: 0,
      bufferedAheadSeconds: phase === 'new' || phase === 'destroyed' ? 0 : 1,
      underrunCount: 0,
    })),
    getSnapshot: vi.fn(snapshot),
    destroy,
  } satisfies FilePlaybackCutoverSource;
  return freezeCanonical({ source, prepare, connect, destroy, closeEncodedSource });
}

function publisher(): FilePlaybackR2WholeBlobPublisher {
  return new FilePlaybackR2WholeBlobPublisher({
    roomToken: freezeCanonical({ room: 'paired-manifest-host' }),
    runtime: { createStorageRoomId: () => 'paired_manifest_host' },
  });
}

function mediaIds() {
  const ids = [
    'b2000000-0000-4000-8000-000000000011',
    'b2000000-0000-4000-8000-000000000012',
    'b2000000-0000-4000-8000-000000000013',
    'b2000000-0000-4000-8000-000000000014',
  ];
  let index = 0;
  return () => ids[index++] ?? ids.at(-1)!;
}

function frameType(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'type');
  return descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
    ? (descriptor.value as string)
    : null;
}

describe('paired product manifest media owners', () => {
  it.each<ManifestCodec>(['mp3-no-frame-count', 'adts-aac-lc'])(
    'carries one exact %s bundle from host owner to guest readiness',
    async (codec) => {
      const fixture = await manifestFixture(codec);
      const pair = establishedPair();
      const prepared = preparedTrack(fixture);
      const roomToken = freezeCanonical({ room: `paired-manifest-guest:${codec}` });
      const registry = new FilePlaybackAssetRegistry({
        liveRoomToken: roomToken,
        onFatalRoom: vi.fn(),
      });
      const manager = new FilePlaybackManager();
      const cutoverPort = freezeCanonical({ codec }) as unknown as FilePlaybackCutoverCandidatePort;
      const hostOutbound: unknown[] = [];
      const guestOutbound: unknown[] = [];
      const readFrames: PeerRangeReadFrame[] = [];
      const bundleReads: Array<Readonly<{ offset: number; length: number }>> = [];
      const stagedMedia: Uint8Array[] = [];
      const constructions: Readonly<FilePlaybackPeerRangeManifestDecoderConstruction>[] = [];
      const decoderSources: FakeStreamingSourceHarness[] = [];
      const sourceCloses: ReturnType<typeof vi.fn>[] = [];
      const fatalGuest = vi.fn();
      let rejectForGuestFatal!: (error: unknown) => void;
      const guestFatal = new Promise<never>((_resolve, reject) => {
        rejectForGuestFatal = reject;
      });
      let routingOpen = true;
      let hostOwner!: FilePlaybackProductHostMediaOwner;
      let guestOwner!: Readonly<FilePlaybackProductGuestMediaOwnerPort>;
      let guestRevoked = false;
      let hostRevoked = false;

      const stageCandidate: NonNullable<
        FilePlaybackPeerRangeManifestAssetSourceStagerRuntimeForTests['stageCandidate']
      > = vi.fn(async (actualManager, options) => {
        expect(actualManager).toBe(manager);
        expect(options.authority?.()).toBe(true);
        await options.source.connect(options.destination);
        expect(options.authority?.()).toBe(true);
        return cutoverPort;
      });
      let candidateRetired = false;
      const retireCandidate: NonNullable<
        FilePlaybackPeerRangeManifestAssetSourceStagerRuntimeForTests['retireCandidate']
      > = vi.fn(async (actualManager, port) => {
        if (actualManager !== manager || port !== cutoverPort || candidateRetired) return false;
        candidateRetired = true;
        const decoderSource = decoderSources.at(-1);
        if (!decoderSource) throw new Error('paired decoder source was not constructed');
        await decoderSource.source.destroy();
        return true;
      });
      const stagerRuntime: FilePlaybackPeerRangeManifestAssetSourceStagerRuntimeForTests = {
        stageCandidate,
        retireCandidate,
      };

      const transportRead = vi.spyOn(FramedPeerRangeClientTransport.prototype, 'read');
      const resolvePrepared = vi.fn(async (options): Promise<HostPeerRangeSource> => {
        expect(options.prepared).toBe(prepared);
        expect(options.sourceIdentity).toBe(SOURCE_ID);
        expect(options.peerRangeManifest).toBe(fixture.publication);
        const close = vi.fn(async () => undefined);
        sourceCloses.push(close);
        return {
          kind: 'peer-range' as const,
          size: fixture.bundle.byteLength,
          identity: SOURCE_ID,
          metadata: { name: fixture.name, mime: fixture.mime },
          readAt: vi.fn(async (offset: number, length: number, signal: AbortSignal) => {
            signal.throwIfAborted();
            const end = offset + length;
            if (offset < 0 || length < 0 || end > fixture.bundle.byteLength) {
              throw new RangeError('fixture bundle read escaped its exact bounds');
            }
            bundleReads.push(freezeCanonical({ offset, length }));
            return fixture.bundle.slice(offset, end);
          }),
          close,
        };
      });

      const runtimeForTests: FilePlaybackProductGuestMediaOwnerRuntimeForTests = {
        prepareManifestDecoderConstruction: async (options) => {
          const construction = await prepareFilePlaybackPeerRangeManifestDecoderConstruction({
            ...options,
            runtimeForTests: {
              aacCapabilityProbe: vi.fn(async () => undefined),
              createStreamingAacSource: (sourceOptions) => {
                const harness = fakeStreamingSource(sourceOptions.encodedSource, stagedMedia);
                decoderSources.push(harness);
                return harness.source as unknown as StreamingAacPlaybackSource;
              },
              createStreamingMp3Source: (sourceOptions) => {
                const harness = fakeStreamingSource(sourceOptions.encodedSource, stagedMedia);
                decoderSources.push(harness);
                return harness.source as unknown as StreamingMp3PlaybackSource;
              },
            },
          });
          constructions.push(construction);
          return construction;
        },
        stageManifestAssetSource: (options: StageFilePlaybackPeerRangeManifestAssetSourceOptions) =>
          stageFilePlaybackPeerRangeManifestAssetSource({ ...options, runtime: stagerRuntime }),
        createR2Acquirer: () => ({
          acquire: vi.fn(async () => {
            throw new Error('paired manifest test unexpectedly selected R2');
          }),
          removeQueueItem: vi.fn(async () => false),
          close: vi.fn(async () => undefined),
        }),
        createParticipant: ({ participantId }) => ({
          participantId,
          arm: vi.fn(async () => {
            throw new Error('paused paired manifest test unexpectedly armed');
          }),
          finalize: vi.fn(async () => {
            throw new Error('paused paired manifest test unexpectedly finalized');
          }),
          started: vi.fn(async () => {
            throw new Error('paused paired manifest test unexpectedly started');
          }),
          commitAttempt: vi.fn(() => false),
          cancel: vi.fn(async () => undefined),
        }),
        currentPort: () => null,
        currentSnapshot: () => null,
        retireCandidate,
        retireCurrent: vi.fn(async () => true),
      };

      const hostRoom: FilePlaybackProductHostMediaRoomPort = {
        currentPeerPublication: () => null,
        resolveCurrentPeerRangeSource: vi.fn(async () => {
          throw new Error('paired prepared test unexpectedly resolved current source');
        }),
        recoverRemoteParticipant: vi.fn(async () => {
          throw new Error('paused paired prepared test unexpectedly recovered');
        }),
      };

      try {
        guestOwner = createFilePlaybackProductGuestMediaOwner({
          context: pair.guestContext,
          roomToken,
          registry,
          manager,
          getAudioGraph: vi.fn(async () => audioGraph()),
          maxEncodedSize: 10_000_000,
          decodeOrdinaryAudio: vi.fn(async () => {
            throw new Error('manifest path unexpectedly selected ordinary decoding');
          }),
          boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
          sendRequired: (_context, frame) => {
            guestOutbound.push(frame);
            const type = frameType(frame);
            if (type === 'read' || type === 'cancel' || type === 'close-handle') {
              const control = parsePeerRangeControlFrame(frame);
              if (control.type === 'read') readFrames.push(control);
              const acknowledge = vi.fn();
              hostOwner.port().adoptPeerRangeControl(
                freezeCanonical({
                  frame,
                  lane: 'control' as const,
                  role: 'host' as const,
                  connection: pair.hostConnection,
                  channel: pair.hostChannel,
                  connectionToken: pair.hostConnection,
                }),
                acknowledge,
              );
              expect(acknowledge).toHaveBeenCalledOnce();
              return true;
            }
            const received = pair.hostChannel.receive(frame, pair.hostConnection);
            if (!received.accepted || received.frame !== 'wire') {
              throw new Error(`host rejected guest wire: ${JSON.stringify(received)}`);
            }
            const acknowledge = vi.fn();
            hostOwner.port().adoptWireMessage(
              freezeCanonical({
                message: received.message,
                connection: pair.hostConnection,
                channel: pair.hostChannel,
                stateLease: received.stateLease,
                attemptLease: received.attemptLease,
              }),
              acknowledge,
            );
            expect(acknowledge).toHaveBeenCalledOnce();
            return true;
          },
          canSendPeerControl: () => true,
          onTimelineRendered: vi.fn(),
          onFatalConnection: (_context, error) => {
            fatalGuest(error);
            rejectForGuestFatal(error);
          },
          runtimeForTests,
        });

        hostOwner = new FilePlaybackProductHostMediaOwner({
          boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
          context: pair.hostContext,
          hostRoom,
          publisher: publisher(),
          resolvePreparedPeerRangeSource: resolvePrepared,
          sendRequired: (_connection, frame) => {
            hostOutbound.push(frame);
            if (!routingOpen) return true;
            const type = frameType(frame);
            const acknowledge = vi.fn();
            if (type === 'chunk' || type === 'error') {
              guestOwner.adoptPeerRangeBulk(
                freezeCanonical({
                  frame: frame as PeerRangeBulkFrame,
                  lane: 'bulk' as const,
                  role: 'guest' as const,
                  connection: pair.guestConnection,
                  channel: pair.guestChannel,
                  connectionToken: pair.guestConnection,
                }),
                acknowledge,
              );
            } else {
              guestOwner.adoptAuxiliaryMessage(
                freezeCanonical({
                  frame,
                  connection: pair.guestConnection,
                  channel: pair.guestChannel,
                  connectionToken: pair.guestConnection,
                }),
                acknowledge,
              );
            }
            expect(acknowledge).toHaveBeenCalledOnce();
            return true;
          },
          sendWire: (_connection, lease, payload) => pair.hostChannel.createWire(lease, payload),
          closeConnection: vi.fn(),
          onHealthSystemMessage: vi.fn(),
          runtimeForTests: {
            createMediaIdForTests: mediaIds(),
            scheduleIntervalForTests: () => 'paired-manifest-health',
            cancelIntervalForTests: vi.fn(),
          },
        });

        guestOwner.onTimelineAdopted(timelineEvent(pair.guestContext));
        const commit = await hostOwner.publishPrepared(prepared);
        expect(commit.offer).toMatchObject({
          transport: 'peer-range-manifest',
          encodedSize: fixture.media.byteLength,
          manifestByteLength: fixture.manifest.byteLength,
          manifestSha256B64: fixture.publication.manifestSha256B64,
        });
        await hostOwner.bindPrepared(prepared);
        const ready = await Promise.race([hostOwner.whenPreparedRemoteReady(prepared), guestFatal]);

        expect(ready).toMatchObject({
          participant: { participantId: pair.hostContext.guestParticipantId },
        });
        expect(fatalGuest).not.toHaveBeenCalled();
        expect(
          guestOutbound.filter((frame) => (frame as { kind?: string }).kind === 'source-ready'),
        ).toHaveLength(1);
        expect(constructions).toEqual([
          {
            codec,
            queueItemId: QUEUE_ID,
            sourceIdentity: SOURCE_ID,
            sourceSize: fixture.media.byteLength,
          },
        ]);
        expect(decoderSources).toHaveLength(1);
        expect(decoderSources[0]!.prepare).toHaveBeenCalledOnce();
        expect(decoderSources[0]!.connect).toHaveBeenCalledOnce();
        expect(decoderSources[0]!.destroy).not.toHaveBeenCalled();
        expect(decoderSources[0]!.closeEncodedSource).not.toHaveBeenCalled();
        expect(stageCandidate).toHaveBeenCalledOnce();
        await expect(
          retireFilePlaybackPeerRangeManifestDecoderConstruction(constructions[0]!),
        ).resolves.toBe(false);
        expect(stagedMedia).toEqual([fixture.media]);

        const logicalReads = transportRead.mock.calls.map(([request]) => request);
        expect(readFrames).toHaveLength(logicalReads.length);
        expect(bundleReads).toHaveLength(logicalReads.length);
        expect(readFrames.map((frame) => frame.requestId)).toEqual(
          logicalReads.map((request) => request.requestId),
        );
        expect(new Set(readFrames.map((frame) => frame.requestId)).size).toBe(readFrames.length);
        expect(bundleReads).toEqual(
          readFrames.map((frame) => ({ offset: frame.offset, length: frame.totalLength })),
        );
        expect(bundleReads[0]).toEqual({ offset: 0, length: fixture.manifest.byteLength });
        expect(bundleReads).toContainEqual({
          offset: fixture.manifest.byteLength,
          length: fixture.media.byteLength,
        });
        expect(
          bundleReads.every(
            ({ offset, length }) => offset >= 0 && offset + length <= fixture.bundle.byteLength,
          ),
        ).toBe(true);
        expect(resolvePrepared).toHaveBeenCalledTimes(2);
        expect(
          resolvePrepared.mock.calls.every(
            ([options]) => options.peerRangeManifest === fixture.publication,
          ),
        ).toBe(true);
        expect(sourceCloses[0]).toHaveBeenCalledOnce();
        expect(sourceCloses[1]).not.toHaveBeenCalled();

        guestOwner.revoke(pair.guestContext);
        guestRevoked = true;
        await vi.waitFor(() => expect(retireCandidate).toHaveBeenCalledOnce());
        expect(retireCandidate).toHaveBeenNthCalledWith(1, manager, cutoverPort);
        await vi.waitFor(() => expect(decoderSources[0]!.destroy).toHaveBeenCalledOnce());
        await vi.waitFor(() =>
          expect(decoderSources[0]!.closeEncodedSource).toHaveBeenCalledOnce(),
        );
        await registry.close(roomToken);
        expect(registry.isClosed()).toBe(true);
        hostOwner.port().revoke(pair.hostContext);
        hostRevoked = true;
        await vi.waitFor(() => expect(sourceCloses[1]).toHaveBeenCalledOnce());
      } finally {
        routingOpen = false;
        if (guestOwner && !guestRevoked) guestOwner.revoke(pair.guestContext);
        if (hostOwner && !hostRevoked) hostOwner.port().revoke(pair.hostContext);
        if (!registry.isClosed()) await registry.close(roomToken).catch(() => undefined);
        transportRead.mockRestore();
      }
    },
  );
});
