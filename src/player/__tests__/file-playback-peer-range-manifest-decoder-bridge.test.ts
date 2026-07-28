import { afterEach, describe, expect, it, vi } from 'vitest';

const operationAuthority = vi.hoisted(() => ({ trusted: new WeakSet<object>() }));

vi.mock('../file-playback-connection-media-session.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../file-playback-connection-media-session.ts')>();
  return {
    ...actual,
    assertFilePlaybackConnectionMediaOperationCurrent(value: unknown) {
      if (value === null || typeof value !== 'object' || !operationAuthority.trusted.has(value)) {
        throw new Error('File playback media operation is forged or retired');
      }
      const operation = value as Readonly<FilePlaybackConnectionMediaOperation>;
      operation.fence.signal.throwIfAborted();
      if (operation.fence.isCurrent() !== true) {
        throw new Error('File playback media operation is stale');
      }
      operation.fence.signal.throwIfAborted();
    },
  };
});

import type { QueueItemId } from '../../types/index.ts';
import type { AacWorkerCapabilityProbeRuntime } from '../aac/worker-capability-probe.ts';
import type {
  StreamingAacPlaybackSource,
  StreamingAacPlaybackSourceOptions,
} from '../backends/streaming-aac-playback-source.ts';
import type {
  StreamingMp3PlaybackSource,
  StreamingMp3PlaybackSourceOptions,
} from '../backends/streaming-mp3-playback-source.ts';
import {
  FilePlaybackAssetRegistry,
  type FilePlaybackAssetLease,
} from '../file-playback-asset-registry.ts';
import type { FilePlaybackConnectionMediaOperation } from '../file-playback-connection-media-session.ts';
import {
  constructFilePlaybackPeerRangeManifestDecoder,
  prepareFilePlaybackPeerRangeManifestDecoderConstruction,
  retireFilePlaybackPeerRangeManifestDecoderConstruction,
  type FilePlaybackPeerRangeManifestDecoderConstruction,
} from '../file-playback-peer-range-manifest-decoder-bridge.ts';
import {
  acquireFilePlaybackPeerRangeManifestAsset,
  type FilePlaybackPeerRangeManifestAcquisition,
  type FilePlaybackPeerRangeManifestAdmission,
} from '../file-playback-peer-range-manifest-acquisition.ts';
import {
  createPeerRangeManifestFileMediaSourceOfferV2,
  type PeerRangeManifestFileMediaSourceOfferV2,
} from '../file-media-source-offer.ts';
import { createFilePlaybackRunBindingV2 } from '../file-playback-run-binding.ts';
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
import type {
  PeerRangeReadRequest,
  PeerRangeTransport,
} from '../sources/peer-range-encoded-audio-source.ts';
import type { BoundedStreamingCodecRuntime } from '../streaming/bounded-codec-runtime.ts';

const ROOM_TOKEN = Object.freeze({ room: 'manifest-decoder-bridge' });
const SESSION_ID = 'manifest-decoder-bridge:session';
const CONNECTION_ID = 'manifest-decoder-bridge:connection';
const PREPARE_ID = 'b1000000-0000-4000-8000-000000000001';
const QUEUE_ID = 'b1000000-0000-4000-8000-000000000002' as QueueItemId;
const RUN_ID = 'b1000000-0000-4000-8000-000000000003';
const SOURCE_ID = 'manifest-decoder-bridge:source';
const TRANSFER_ID = 'manifest-decoder-bridge:transfer';
const HANDLE_ID = 'manifest-decoder-bridge:handle';

interface AcquiredFixture {
  readonly registry: FilePlaybackAssetRegistry;
  readonly acquired: Readonly<FilePlaybackPeerRangeManifestAcquisition>;
  readonly controller: AbortController;
  readonly transport: PeerRangeTransport & {
    readonly closeHandle: ReturnType<typeof vi.fn<NonNullable<PeerRangeTransport['closeHandle']>>>;
  };
}

const registries = new Set<FilePlaybackAssetRegistry>();

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let cursor = 0;
  for (const part of parts) {
    result.set(part, cursor);
    cursor += part.byteLength;
  }
  return result;
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
}

class MemorySource implements EncodedAudioSource {
  readonly kind = 'peer-range' as const;
  readonly size: number;
  readonly identity = SOURCE_ID;
  readonly metadata: Readonly<EncodedAudioSourceMetadata>;

  constructor(
    readonly bytes: Uint8Array,
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

function memoryTransport(bytes: Uint8Array): PeerRangeTransport & {
  readonly closeHandle: ReturnType<typeof vi.fn<NonNullable<PeerRangeTransport['closeHandle']>>>;
} {
  return {
    read: vi.fn(async (request: PeerRangeReadRequest) => {
      request.signal.throwIfAborted();
      return bytes.slice(request.offset, request.offset + request.length);
    }),
    closeHandle: vi.fn<NonNullable<PeerRangeTransport['closeHandle']>>(),
  };
}

function operationFor(
  offer: Readonly<PeerRangeManifestFileMediaSourceOfferV2>,
  controller: AbortController,
): Readonly<FilePlaybackConnectionMediaOperation> {
  const binding = createFilePlaybackRunBindingV2({
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
  const operation = freezeCanonical({
    kind: 'baseline' as const,
    offer,
    binding,
    fence: freezeCanonical({
      epoch: Object.freeze(Object.create(null)),
      signal: controller.signal,
      isCurrent: () => true,
    }),
  }) as unknown as Readonly<FilePlaybackConnectionMediaOperation>;
  operationAuthority.trusted.add(operation as object);
  return operation;
}

async function acquireFixture(
  codec: 'adts-aac-lc' | 'mp3-no-frame-count',
): Promise<AcquiredFixture> {
  const media = codec === 'adts-aac-lc' ? adtsMedia() : mp3Media();
  const name = codec === 'adts-aac-lc' ? 'bounded.aac' : 'bounded.mp3';
  const mime = codec === 'adts-aac-lc' ? 'audio/aac' : 'audio/mpeg';
  const controller = new AbortController();
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
    new MemorySource(media, name, mime),
    controller.signal,
  );
  const manifest = encodeCodecTimelineManifest(
    codec === 'adts-aac-lc'
      ? adtsManifest(media, sourceBinding)
      : mp3Manifest(media, sourceBinding),
  );
  const offer = createPeerRangeManifestFileMediaSourceOfferV2({
    sessionId: SESSION_ID,
    connectionId: CONNECTION_ID,
    prepareId: PREPARE_ID,
    prepareRevision: 1,
    queueItemId: QUEUE_ID,
    sourceIdentity: SOURCE_ID,
    transferSessionId: TRANSFER_ID,
    handleId: HANDLE_ID,
    encodedSize: media.byteLength,
    manifestByteLength: manifest.byteLength,
    manifestSha256B64: base64(await sha256(manifest)),
    name,
    mime,
    expiresAtRoomTimeMs: 10_000,
  });
  const bundle = concatenate(manifest, media);
  const transport = memoryTransport(bundle);
  const registry = new FilePlaybackAssetRegistry({
    liveRoomToken: ROOM_TOKEN,
    onFatalRoom: vi.fn(),
  });
  registries.add(registry);
  const acquired = await acquireFilePlaybackPeerRangeManifestAsset({
    operation: operationFor(offer, controller),
    registry,
    roomToken: ROOM_TOKEN,
    transport,
  });
  return { registry, acquired, controller, transport };
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

function prepareOptions(
  fixture: AcquiredFixture,
  patch: Partial<
    Parameters<typeof prepareFilePlaybackPeerRangeManifestDecoderConstruction>[0]
  > = {},
) {
  return {
    registry: fixture.registry,
    roomToken: ROOM_TOKEN,
    assetLease: fixture.acquired.assetLease,
    manifestAdmission: fixture.acquired.manifestAdmission,
    signal: fixture.controller.signal,
    ...patch,
  };
}

const clockBindings = Object.freeze({
  nowRoomTimeMs: () => 1_000,
  roomTimeMsToContextTime: (roomTimeMs: number) => roomTimeMs / 1_000,
  localPerformanceMsToContextTime: (localPerformanceMs: number) => localPerformanceMs / 1_000,
});

const audioContext = Object.freeze({ sampleRate: 48_000 }) as unknown as AudioContext;

function constructOptions(
  fixture: AcquiredFixture,
  authority: Readonly<FilePlaybackPeerRangeManifestDecoderConstruction>,
) {
  return {
    authority,
    registry: fixture.registry,
    roomToken: ROOM_TOKEN,
    assetLease: fixture.acquired.assetLease,
    audioContext,
    clockBindings,
  };
}

afterEach(async () => {
  for (const registry of registries) {
    await registry.close(ROOM_TOKEN).catch(() => undefined);
  }
  registries.clear();
  vi.restoreAllMocks();
});

describe('peer-range manifest decoder construction bridge', () => {
  it('keeps ADTS evidence private, uses one snapshotted Worker seam, and consumes once', async () => {
    const fixture = await acquireFixture('adts-aac-lc');
    const originalWorker = Object.freeze({ worker: 'original' }) as unknown as Worker;
    const replacementWorker = Object.freeze({ worker: 'replacement' }) as unknown as Worker;
    const createWorker = vi.fn(() => originalWorker);
    const aacRuntime: Partial<BoundedStreamingCodecRuntime> = { createWorker };
    const canaryRuntime: { current: AacWorkerCapabilityProbeRuntime | null } = { current: null };
    let canaryBytes: Uint8Array | null = null;
    const wrapperOptions: { current: StreamingAacPlaybackSourceOptions | null } = {
      current: null,
    };
    const constructed = Object.freeze({
      kind: 'aac-wrapper',
      destroy: vi.fn(() => Promise.resolve()),
    }) as unknown as StreamingAacPlaybackSource;

    const authority = await prepareFilePlaybackPeerRangeManifestDecoderConstruction(
      prepareOptions(fixture, {
        aacRuntime,
        runtimeForTests: {
          aacCapabilityProbe: vi.fn(async (frame, _signal, runtime) => {
            canaryBytes = frame.slice();
            canaryRuntime.current = runtime;
          }),
          createStreamingAacSource: vi.fn((options) => {
            wrapperOptions.current = options;
            return constructed;
          }),
        },
      }),
    );

    (aacRuntime as { createWorker?: () => Worker }).createWorker = () => replacementWorker;
    expect(authority).toEqual({
      codec: 'adts-aac-lc',
      queueItemId: QUEUE_ID,
      sourceIdentity: SOURCE_ID,
      sourceSize: adtsMedia().byteLength,
    });
    expect(Object.getPrototypeOf(authority)).toBeNull();
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.keys(authority)).not.toContain('timelineEvidence');
    expect(canaryBytes).toEqual(ADTS_FRAMES[0]);

    const result = await constructFilePlaybackPeerRangeManifestDecoder(
      constructOptions(fixture, authority),
    );
    const capturedWrapperOptions = wrapperOptions.current;
    const capturedCanaryRuntime = canaryRuntime.current;
    if (!capturedWrapperOptions || !capturedCanaryRuntime) {
      throw new Error('Fixture expected captured AAC construction seams');
    }
    expect(result).toBe(constructed);
    expect(capturedWrapperOptions).toMatchObject({
      backendId: 'webcodecs',
      queueItemId: QUEUE_ID,
      encodedSource: { identity: SOURCE_ID },
      timelineEvidence: {
        format: 'adts-decoder-timeline',
        authority: 'none',
        sourceIdentity: SOURCE_ID,
        frameCount: ADTS_FRAMES.length,
      },
    });
    expect('scan' in (capturedWrapperOptions as unknown as Record<string, unknown>)).toBe(false);
    expect(capturedWrapperOptions.runtime?.createWorker).toBe(capturedCanaryRuntime.createWorker);
    expect(capturedWrapperOptions.runtime?.createWorker?.()).toBe(originalWorker);
    expect(createWorker).toHaveBeenCalledOnce();

    await expect(
      constructFilePlaybackPeerRangeManifestDecoder(constructOptions(fixture, authority)),
    ).rejects.toThrow(/stale/u);
    await expect(retireFilePlaybackPeerRangeManifestDecoderConstruction(authority)).resolves.toBe(
      false,
    );
  });

  it('constructs the MP3 wrapper directly from admitted-manifest provenance', async () => {
    const fixture = await acquireFixture('mp3-no-frame-count');
    let wrapperOptions: StreamingMp3PlaybackSourceOptions | null = null;
    const constructed = Object.freeze({
      kind: 'mp3-wrapper',
      destroy: vi.fn(() => Promise.resolve()),
    }) as unknown as StreamingMp3PlaybackSource;
    const authority = await prepareFilePlaybackPeerRangeManifestDecoderConstruction(
      prepareOptions(fixture, {
        runtimeForTests: {
          createStreamingMp3Source: vi.fn((options) => {
            wrapperOptions = options;
            return constructed;
          }),
        },
      }),
    );

    await expect(
      constructFilePlaybackPeerRangeManifestDecoder(constructOptions(fixture, authority)),
    ).resolves.toBe(constructed);
    expect(wrapperOptions).toMatchObject({
      queueItemId: QUEUE_ID,
      encodedSource: { identity: SOURCE_ID },
      timelineEvidence: {
        format: 'mp3-decoder-timeline',
        authority: 'none',
        provenanceKind: 'admitted-manifest',
        frameCountEvidence: 'admitted-manifest',
        fullyVerifiedFrameSpan: false,
        sourceIdentity: SOURCE_ID,
      },
    });
    expect('metadata' in (wrapperOptions as unknown as Record<string, unknown>)).toBe(false);
  });

  it('retires an unconsumed logical source exactly once and releases its lease capacity', async () => {
    const fixture = await acquireFixture('adts-aac-lc');
    const runtimeForTests = { aacCapabilityProbe: vi.fn(async () => undefined) };
    const first = await prepareFilePlaybackPeerRangeManifestDecoderConstruction(
      prepareOptions(fixture, { runtimeForTests }),
    );
    const retirement = retireFilePlaybackPeerRangeManifestDecoderConstruction(first);
    expect(retireFilePlaybackPeerRangeManifestDecoderConstruction(first)).toBe(retirement);
    await expect(retirement).resolves.toBe(true);

    const second = await prepareFilePlaybackPeerRangeManifestDecoderConstruction(
      prepareOptions(fixture, { runtimeForTests }),
    );
    const third = await prepareFilePlaybackPeerRangeManifestDecoderConstruction(
      prepareOptions(fixture, { runtimeForTests }),
    );
    await expect(retireFilePlaybackPeerRangeManifestDecoderConstruction(second)).resolves.toBe(
      true,
    );
    await expect(retireFilePlaybackPeerRangeManifestDecoderConstruction(third)).resolves.toBe(true);
  });

  it('records synchronous construction revocation and destroys the transferred backend', async () => {
    const fixture = await acquireFixture('adts-aac-lc');
    let authority!: Readonly<FilePlaybackPeerRangeManifestDecoderConstruction>;
    let reentrantRetirement: Promise<boolean> | null = null;
    let wrapperOptions: StreamingAacPlaybackSourceOptions | null = null;
    const destroy = vi.fn(async () => {
      await wrapperOptions!.encodedSource.close();
    });
    const constructed = Object.freeze({ destroy }) as unknown as StreamingAacPlaybackSource;

    authority = await prepareFilePlaybackPeerRangeManifestDecoderConstruction(
      prepareOptions(fixture, {
        runtimeForTests: {
          aacCapabilityProbe: vi.fn(async () => undefined),
          createStreamingAacSource: vi.fn((options) => {
            wrapperOptions = options;
            reentrantRetirement = retireFilePlaybackPeerRangeManifestDecoderConstruction(authority);
            return constructed;
          }),
        },
      }),
    );

    await expect(
      constructFilePlaybackPeerRangeManifestDecoder(constructOptions(fixture, authority)),
    ).rejects.toThrow(/revoked/u);
    expect(reentrantRetirement).not.toBeNull();
    expect(retireFilePlaybackPeerRangeManifestDecoderConstruction(authority)).toBe(
      reentrantRetirement,
    );
    await expect(reentrantRetirement!).resolves.toBe(true);
    expect(destroy).toHaveBeenCalledOnce();

    const firstLease = fixture.registry.acquireSource(ROOM_TOKEN, fixture.acquired.assetLease);
    const secondLease = fixture.registry.acquireSource(ROOM_TOKEN, fixture.acquired.assetLease);
    await firstLease.close();
    await secondLease.close();
  });

  it('destroys a returned backend when it synchronously aborts its construction signal', async () => {
    const fixture = await acquireFixture('adts-aac-lc');
    let wrapperOptions: StreamingAacPlaybackSourceOptions | null = null;
    const destroy = vi.fn(async () => {
      await wrapperOptions!.encodedSource.close();
    });
    const constructed = Object.freeze({ destroy }) as unknown as StreamingAacPlaybackSource;
    const reason = new Error('fixture synchronous construction abort');
    const authority = await prepareFilePlaybackPeerRangeManifestDecoderConstruction(
      prepareOptions(fixture, {
        runtimeForTests: {
          aacCapabilityProbe: vi.fn(async () => undefined),
          createStreamingAacSource: vi.fn((options) => {
            wrapperOptions = options;
            fixture.controller.abort(reason);
            return constructed;
          }),
        },
      }),
    );

    await expect(
      constructFilePlaybackPeerRangeManifestDecoder(constructOptions(fixture, authority)),
    ).rejects.toBe(reason);
    await expect(retireFilePlaybackPeerRangeManifestDecoderConstruction(authority)).resolves.toBe(
      true,
    );
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('closes the acquired source on canary or wrapper-construction failure', async () => {
    const fixture = await acquireFixture('adts-aac-lc');
    await expect(
      prepareFilePlaybackPeerRangeManifestDecoderConstruction(
        prepareOptions(fixture, {
          runtimeForTests: {
            aacCapabilityProbe: vi.fn(async () => {
              throw new Error('fixture canary failure');
            }),
          },
        }),
      ),
    ).rejects.toThrow(/canary failure/u);

    const failing = await prepareFilePlaybackPeerRangeManifestDecoderConstruction(
      prepareOptions(fixture, {
        runtimeForTests: {
          aacCapabilityProbe: vi.fn(async () => undefined),
          createStreamingAacSource: vi.fn(() => {
            throw new Error('fixture wrapper failure');
          }),
        },
      }),
    );
    await expect(
      constructFilePlaybackPeerRangeManifestDecoder(constructOptions(fixture, failing)),
    ).rejects.toThrow(/wrapper failure/u);

    const first = await prepareFilePlaybackPeerRangeManifestDecoderConstruction(
      prepareOptions(fixture, {
        runtimeForTests: { aacCapabilityProbe: vi.fn(async () => undefined) },
      }),
    );
    const second = await prepareFilePlaybackPeerRangeManifestDecoderConstruction(
      prepareOptions(fixture, {
        runtimeForTests: { aacCapabilityProbe: vi.fn(async () => undefined) },
      }),
    );
    await retireFilePlaybackPeerRangeManifestDecoderConstruction(first);
    await retireFilePlaybackPeerRangeManifestDecoderConstruction(second);
  });

  it('rejects copied capabilities, mismatched admissions, and stale live leases', async () => {
    const left = await acquireFixture('adts-aac-lc');
    const right = await acquireFixture('adts-aac-lc');
    await expect(
      prepareFilePlaybackPeerRangeManifestDecoderConstruction({
        ...prepareOptions(left),
        manifestAdmission: right.acquired
          .manifestAdmission as FilePlaybackPeerRangeManifestAdmission,
      }),
    ).rejects.toThrow(/another asset lease/u);

    const authority = await prepareFilePlaybackPeerRangeManifestDecoderConstruction(
      prepareOptions(left, {
        runtimeForTests: { aacCapabilityProbe: vi.fn(async () => undefined) },
      }),
    );
    const copied = Object.assign({}, authority) as FilePlaybackPeerRangeManifestDecoderConstruction;
    await expect(
      constructFilePlaybackPeerRangeManifestDecoder(constructOptions(left, copied)),
    ).rejects.toThrow(/stale/u);

    await expect(
      constructFilePlaybackPeerRangeManifestDecoder({
        ...constructOptions(left, authority),
        registry: right.registry,
        assetLease: right.acquired.assetLease,
      }),
    ).rejects.toThrow(/another asset lease/u);
    await expect(
      constructFilePlaybackPeerRangeManifestDecoder({
        ...constructOptions(left, authority),
        roomToken: Object.freeze({ room: 'copied-diagnostics' }),
      }),
    ).rejects.toThrow(/another asset lease/u);
    await expect(
      constructFilePlaybackPeerRangeManifestDecoder({
        ...constructOptions(left, authority),
        assetLease: right.acquired.assetLease,
      }),
    ).rejects.toThrow(/another asset lease/u);

    await left.registry.retire(ROOM_TOKEN, left.acquired.assetLease as FilePlaybackAssetLease);
    await expect(
      constructFilePlaybackPeerRangeManifestDecoder(constructOptions(left, authority)),
    ).rejects.toThrow(/stale|closed/u);
    await expect(retireFilePlaybackPeerRangeManifestDecoderConstruction(authority)).resolves.toBe(
      true,
    );
  });
});
