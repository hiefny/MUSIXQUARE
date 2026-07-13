import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import type { StreamingAacPlaybackSourceOptions } from '../backends/streaming-aac-playback-source.ts';
import type { StreamingM4aAacPlaybackSourceOptions } from '../backends/streaming-m4a-aac-playback-source.ts';
import type { StreamingMp3PlaybackSourceOptions } from '../backends/streaming-mp3-playback-source.ts';
import {
  FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
  type FilePlaybackBoundedRoutePolicy,
} from '../file-playback-bounded-route-policy.ts';
import {
  createBlobFilePlaybackSource,
  createEncodedFilePlaybackSource,
  type BlobFilePlaybackBackendFactories,
  type CreateBlobFilePlaybackSourceOptions,
  type CreateEncodedFilePlaybackSourceOptions,
  type OrdinaryAudioDecodeResult,
} from '../file-playback-source-factory.ts';
import { buildM4aAacFixture } from '../m4a/__tests__/m4a-aac-fixture.ts';
import { parseMpegLayer3FrameHeader } from '../mp3/frame-header.ts';
import {
  EncodedSourceClosedError,
  type EncodedAudioSource,
  validateExactRead,
} from '../sources/encoded-audio-source.ts';
import type { BoundedStreamingCodecRuntime } from '../streaming/bounded-codec-runtime.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-0000000000a1' as QueueItemId;

function fakeAudioBuffer(): AudioBuffer {
  return {
    duration: 12,
    sampleRate: 48_000,
    numberOfChannels: 2,
    length: 576_000,
  } as AudioBuffer;
}

function decodedOrdinaryAudio(): OrdinaryAudioDecodeResult {
  return { audioBuffer: fakeAudioBuffer(), release: vi.fn() };
}

function makeMp3Frame(): Uint8Array {
  const headerBytes = Uint8Array.of(0xff, 0xfb, 0x90, 0x00);
  const header = parseMpegLayer3FrameHeader(headerBytes);
  const frame = new Uint8Array(header.frameLengthBytes);
  frame.set(headerBytes);
  return frame;
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function mp3Bytes(): Uint8Array {
  return concatenate(...Array.from({ length: 5 }, () => makeMp3Frame()));
}

function mp3File(name = 'fixture.mp3', mime = 'audio/mpeg'): File {
  return new File([mp3Bytes()], name, { type: mime });
}

function m4aFile(name = 'fixture.m4a', mime = 'audio/mp4'): File {
  return new File([buildM4aAacFixture().bytes], name, { type: mime });
}

function makeAdtsFrame(frameLengthBytes: number, payloadByte: number): Uint8Array {
  const bytes = new Uint8Array(frameLengthBytes).fill(payloadByte);
  const profile = 1;
  const sampleRateIndex = 4;
  const channelConfiguration = 2;

  bytes[0] = 0xff;
  bytes[1] = 0xf1;
  bytes[2] = (profile << 6) | (sampleRateIndex << 2) | ((channelConfiguration >>> 2) & 1);
  bytes[3] = ((channelConfiguration & 0b11) << 6) | ((frameLengthBytes >>> 11) & 0b11);
  bytes[4] = (frameLengthBytes >>> 3) & 0xff;
  bytes[5] = ((frameLengthBytes & 0b111) << 5) | 0b1_1111;
  bytes[6] = 0b1111_1100;
  return bytes;
}

function aacBytes(): Uint8Array {
  return concatenate(makeAdtsFrame(19, 0x11), makeAdtsFrame(41, 0x22), makeAdtsFrame(83, 0x33));
}

function aacFile(name = 'fixture.aac', mime = 'audio/aac'): File {
  return new File([aacBytes()], name, { type: mime });
}

function expectedAdtsScan(sourceIdentity: string) {
  return {
    sourceIdentity,
    sourceSize: 143,
    coreConfiguration: {
      mpegId: 0,
      profile: 1,
      coreAudioObjectType: 2,
      sampleRateIndex: 4,
      channelConfiguration: 2,
      protectionAbsent: true,
      rawDataBlocks: 1,
    },
    coreSampleRateHz: 44_100,
    coreChannelCount: 2,
    samplesPerFrame: 1_024,
    frameCount: 3,
    totalCoreSamples: 3_072,
    audioEndByteOffset: 143,
    seekPoints: [
      { frameOrdinal: 0, byteOffset: 0 },
      { frameOrdinal: 1, byteOffset: 19 },
      { frameOrdinal: 2, byteOffset: 60 },
    ],
    fullyVerifiedFrameSpan: true,
  };
}

function id3PrefixedAacFile(): File {
  const emptyId3v24 = Uint8Array.of(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0);
  const adtsAac = Uint8Array.of(0xff, 0xf1, 0x50, 0x80, 0, 0x1f, 0xfc, 0, 0, 0, 0, 0);
  return new File([emptyId3v24, adtsAac], 'fixture.aac', { type: 'audio/aac' });
}

function id3PrefixedMp3File(name = 'fixture.aac', mime = 'audio/aac'): File {
  const emptyId3v24 = Uint8Array.of(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0);
  return new File([emptyId3v24, mp3Bytes()], name, { type: mime });
}

function blobOptions(
  blob: Blob,
  overrides: Partial<CreateBlobFilePlaybackSourceOptions> = {},
): CreateBlobFilePlaybackSourceOptions {
  return {
    blob,
    queueItemId: QUEUE_ITEM_ID,
    audioContext: { sampleRate: 48_000, currentTime: 0 } as AudioContext,
    nowRoomTimeMs: () => 1_000,
    roomTimeMsToContextTime: (roomTimeMs) => roomTimeMs / 1_000,
    localPerformanceMsToContextTime: (localTimeMs) => localTimeMs / 1_000,
    signal: new AbortController().signal,
    decodeOrdinaryAudio: vi.fn(async () => decodedOrdinaryAudio()),
    ...overrides,
  };
}

function encodedOptions(
  encodedSource: EncodedAudioSource,
  overrides: Partial<CreateEncodedFilePlaybackSourceOptions> = {},
): CreateEncodedFilePlaybackSourceOptions {
  return {
    encodedSource,
    queueItemId: QUEUE_ITEM_ID,
    audioContext: { sampleRate: 48_000, currentTime: 0 } as AudioContext,
    nowRoomTimeMs: () => 1_000,
    roomTimeMsToContextTime: (roomTimeMs) => roomTimeMs / 1_000,
    localPerformanceMsToContextTime: (localTimeMs) => localTimeMs / 1_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function boundedSource(queueItemId: QueueItemId, destroy = vi.fn(async () => undefined)) {
  return {
    backend: 'bounded-stream' as const,
    queueItemId,
    prepare: vi.fn(),
    connect: vi.fn(),
    arm: vi.fn(),
    finalize: vi.fn(),
    cancel: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    positionAt: vi.fn(),
    getSnapshot: vi.fn(),
    destroy,
  };
}

function memorySource(
  bytes: Uint8Array,
  options: { readonly name: string; readonly mime: string; readonly identity: string },
) {
  let closed = false;
  const reads = vi.fn(async (offset: number, length: number, signal: AbortSignal) => {
    if (closed) throw new EncodedSourceClosedError();
    signal.throwIfAborted();
    const end = validateExactRead(bytes.byteLength, offset, length);
    return bytes.slice(offset, end);
  });
  const close = vi.fn(async () => {
    closed = true;
  });
  const source: EncodedAudioSource = {
    kind: 'peer-range',
    size: bytes.byteLength,
    identity: options.identity,
    metadata: { name: options.name, mime: options.mime },
    readAt: reads,
    close,
  };
  return { source, reads, close };
}

describe('default-off universal bounded audio routes', () => {
  it.each([
    ['MP3', () => mp3File()],
    ['raw ADTS AAC', () => aacFile()],
    ['M4A', () => m4aFile()],
  ])('keeps valid %s on the ordinary Blob route when policy is omitted', async (_label, file) => {
    const decodeOrdinaryAudio = vi.fn(async () => decodedOrdinaryAudio());
    const result = await createBlobFilePlaybackSource(blobOptions(file(), { decodeOrdinaryAudio }));

    expect(result.backend).toBe('audio-buffer');
    expect(decodeOrdinaryAudio).toHaveBeenCalledOnce();
  });

  it('routes a verified MP3 Blob only under universal-v1 and forwards its exact runtime', async () => {
    const decodeOrdinaryAudio = vi.fn(async () => decodedOrdinaryAudio());
    const mp3Runtime: Partial<BoundedStreamingCodecRuntime> = {};
    let received: StreamingMp3PlaybackSourceOptions | null = null;
    const createStreamingMp3Source = vi.fn((options: StreamingMp3PlaybackSourceOptions) => {
      received = options;
      return boundedSource(options.queueItemId);
    });
    const result = await createBlobFilePlaybackSource(
      blobOptions(mp3File('misnamed.m4a', 'audio/mp4'), {
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
        decodeOrdinaryAudio,
        mp3Runtime,
        backendFactories: { createStreamingMp3Source },
      }),
    );

    expect(result.backend).toBe('bounded-stream');
    expect(decodeOrdinaryAudio).not.toHaveBeenCalled();
    expect(createStreamingMp3Source).toHaveBeenCalledOnce();
    expect(received).toMatchObject({
      queueItemId: QUEUE_ITEM_ID,
      metadata: { format: 'mp3', sampleRateHz: 44_100, channels: 2 },
      runtime: mp3Runtime,
    });
  });

  it('routes a verified M4A Blob before a contradictory MP3 claim and pins WebCodecs', async () => {
    const decodeOrdinaryAudio = vi.fn(async () => decodedOrdinaryAudio());
    const m4aRuntime: Partial<BoundedStreamingCodecRuntime> = {};
    let received: StreamingM4aAacPlaybackSourceOptions | null = null;
    const createStreamingM4aAacSource = vi.fn((options: StreamingM4aAacPlaybackSourceOptions) => {
      received = options;
      return boundedSource(options.queueItemId);
    });
    const result = await createBlobFilePlaybackSource(
      blobOptions(m4aFile('misnamed.mp3', 'audio/mpeg'), {
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
        decodeOrdinaryAudio,
        m4aRuntime,
        backendFactories: { createStreamingM4aAacSource },
      }),
    );

    expect(result.backend).toBe('bounded-stream');
    expect(decodeOrdinaryAudio).not.toHaveBeenCalled();
    expect(createStreamingM4aAacSource).toHaveBeenCalledOnce();
    expect(received).toMatchObject({
      queueItemId: QUEUE_ITEM_ID,
      backendId: 'webcodecs',
      manifest: { format: 'm4a-aac-lc' },
      runtime: m4aRuntime,
    });
  });

  it('routes verified raw ADTS AAC before contradictory MP3/M4A claims', async () => {
    const decodeOrdinaryAudio = vi.fn(async () => decodedOrdinaryAudio());
    const aacRuntime: Partial<BoundedStreamingCodecRuntime> = {};
    const createStreamingAacSource = vi.fn((options: StreamingAacPlaybackSourceOptions) =>
      boundedSource(options.queueItemId),
    );
    const createStreamingMp3Source = vi.fn();
    const createStreamingM4aAacSource = vi.fn();
    const result = await createBlobFilePlaybackSource(
      blobOptions(aacFile('misnamed.mp3', 'audio/mp4'), {
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
        decodeOrdinaryAudio,
        aacRuntime,
        backendFactories: {
          createStreamingAacSource,
          createStreamingMp3Source:
            createStreamingMp3Source as BlobFilePlaybackBackendFactories['createStreamingMp3Source'],
          createStreamingM4aAacSource:
            createStreamingM4aAacSource as BlobFilePlaybackBackendFactories['createStreamingM4aAacSource'],
        },
      }),
    );

    expect(result.backend).toBe('bounded-stream');
    expect(decodeOrdinaryAudio).not.toHaveBeenCalled();
    expect(createStreamingAacSource).toHaveBeenCalledOnce();
    expect(createStreamingMp3Source).not.toHaveBeenCalled();
    expect(createStreamingM4aAacSource).not.toHaveBeenCalled();
    const received = createStreamingAacSource.mock.calls[0]![0];
    expect(received.queueItemId).toBe(QUEUE_ITEM_ID);
    expect(received.backendId).toBe('webcodecs');
    expect(received.runtime).toBe(aacRuntime);
    expect(received.scan).toEqual(expectedAdtsScan(received.encodedSource.identity));
  });

  it('routes verified raw MP3 content despite a contradictory raw AAC claim', async () => {
    const decodeOrdinaryAudio = vi.fn(async () => decodedOrdinaryAudio());
    const createStreamingAacSource = vi.fn();
    const createStreamingMp3Source = vi.fn((options: StreamingMp3PlaybackSourceOptions) =>
      boundedSource(options.queueItemId),
    );
    const result = await createBlobFilePlaybackSource(
      blobOptions(mp3File('misnamed.aac', 'audio/aac'), {
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
        decodeOrdinaryAudio,
        backendFactories: {
          createStreamingAacSource:
            createStreamingAacSource as BlobFilePlaybackBackendFactories['createStreamingAacSource'],
          createStreamingMp3Source,
        },
      }),
    );

    expect(result.backend).toBe('bounded-stream');
    expect(decodeOrdinaryAudio).not.toHaveBeenCalled();
    expect(createStreamingAacSource).not.toHaveBeenCalled();
    expect(createStreamingMp3Source).toHaveBeenCalledOnce();
    expect(createStreamingMp3Source.mock.calls[0]![0].metadata).toMatchObject({ format: 'mp3' });
  });

  it('routes a verified ID3-prefixed MP3 despite a contradictory raw AAC claim', async () => {
    const decodeOrdinaryAudio = vi.fn(async () => decodedOrdinaryAudio());
    const createStreamingAacSource = vi.fn();
    const createStreamingMp3Source = vi.fn((options: StreamingMp3PlaybackSourceOptions) =>
      boundedSource(options.queueItemId),
    );
    const result = await createBlobFilePlaybackSource(
      blobOptions(id3PrefixedMp3File(), {
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
        decodeOrdinaryAudio,
        backendFactories: {
          createStreamingAacSource:
            createStreamingAacSource as BlobFilePlaybackBackendFactories['createStreamingAacSource'],
          createStreamingMp3Source,
        },
      }),
    );

    expect(result.backend).toBe('bounded-stream');
    expect(decodeOrdinaryAudio).not.toHaveBeenCalled();
    expect(createStreamingAacSource).not.toHaveBeenCalled();
    expect(createStreamingMp3Source).toHaveBeenCalledOnce();
    expect(createStreamingMp3Source.mock.calls[0]![0].metadata).toMatchObject({ format: 'mp3' });
  });

  it.each([
    [
      'a truncated second frame',
      () => concatenate(makeAdtsFrame(19, 0x11), makeAdtsFrame(41, 0x22).slice(0, 6)),
    ],
    [
      'a corrupt second frame',
      () => {
        const corrupt = makeAdtsFrame(41, 0x22);
        corrupt[0] = 0;
        return concatenate(makeAdtsFrame(19, 0x11), corrupt);
      },
    ],
    ['trailing junk', () => concatenate(makeAdtsFrame(19, 0x11), Uint8Array.of(1, 2, 3))],
  ])('fails closed when a verified first ADTS frame is followed by %s', async (_label, bytes) => {
    const decodeOrdinaryAudio = vi.fn(async () => decodedOrdinaryAudio());
    const createStreamingAacSource = vi.fn();
    await expect(
      createBlobFilePlaybackSource(
        blobOptions(new File([bytes()], 'partial.aac', { type: 'audio/aac' }), {
          boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
          decodeOrdinaryAudio,
          backendFactories: {
            createStreamingAacSource:
              createStreamingAacSource as BlobFilePlaybackBackendFactories['createStreamingAacSource'],
          },
        }),
      ),
    ).rejects.toThrow();

    expect(createStreamingAacSource).not.toHaveBeenCalled();
    expect(decodeOrdinaryAudio).not.toHaveBeenCalled();
  });

  it('does not treat an unclaimed ID3-prefixed AAC file as MP3 authority', async () => {
    const decodeOrdinaryAudio = vi.fn(async () => decodedOrdinaryAudio());
    const createStreamingAacSource = vi.fn();
    const createStreamingMp3Source = vi.fn();
    const result = await createBlobFilePlaybackSource(
      blobOptions(id3PrefixedAacFile(), {
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
        decodeOrdinaryAudio,
        backendFactories: {
          createStreamingAacSource:
            createStreamingAacSource as BlobFilePlaybackBackendFactories['createStreamingAacSource'],
          createStreamingMp3Source:
            createStreamingMp3Source as BlobFilePlaybackBackendFactories['createStreamingMp3Source'],
        },
      }),
    );

    expect(result.backend).toBe('audio-buffer');
    expect(decodeOrdinaryAudio).toHaveBeenCalledOnce();
    expect(createStreamingAacSource).not.toHaveBeenCalled();
    expect(createStreamingMp3Source).not.toHaveBeenCalled();
  });

  it.each([
    ['MP3', 'broken.mp3', 'audio/mpeg'],
    ['raw ADTS AAC', 'broken.aac', 'audio/aac'],
    ['M4A', 'broken.m4a', 'audio/mp4'],
  ])('fails closed for a malformed claimed %s Blob', async (_label, name, mime) => {
    const decodeOrdinaryAudio = vi.fn(async () => decodedOrdinaryAudio());
    await expect(
      createBlobFilePlaybackSource(
        blobOptions(new File([new Uint8Array(32)], name, { type: mime }), {
          boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
          decodeOrdinaryAudio,
        }),
      ),
    ).rejects.toThrow();
    expect(decodeOrdinaryAudio).not.toHaveBeenCalled();
  });

  it('routes a generic M4A source and transfers its exact close lease once', async () => {
    const fixture = buildM4aAacFixture();
    const memory = memorySource(fixture.bytes, {
      name: 'remote.m4a',
      mime: 'audio/mp4',
      identity: 'peer-range:universal-m4a',
    });
    const createStreamingM4aAacSource = vi.fn((options: StreamingM4aAacPlaybackSourceOptions) => {
      let closePromise: Promise<void> | null = null;
      return boundedSource(
        options.queueItemId,
        vi.fn(() => (closePromise ??= options.encodedSource.close())),
      );
    });
    const result = await createEncodedFilePlaybackSource(
      encodedOptions(memory.source, {
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
        backendFactories: { createStreamingM4aAacSource },
      }),
    );

    expect(result.backend).toBe('bounded-stream');
    expect(memory.close).not.toHaveBeenCalled();
    await result.source.destroy();
    await result.source.destroy();
    expect(memory.close).toHaveBeenCalledOnce();
  });

  it('routes a generic raw ADTS AAC source with its exact scan, backend, runtime, and lease', async () => {
    const bytes = aacBytes();
    const memory = memorySource(bytes, {
      name: 'remote.aac',
      mime: 'audio/aac',
      identity: 'peer-range:universal-aac',
    });
    const aacRuntime: Partial<BoundedStreamingCodecRuntime> = {};
    const createStreamingAacSource = vi.fn((options: StreamingAacPlaybackSourceOptions) => {
      let closePromise: Promise<void> | null = null;
      return boundedSource(
        options.queueItemId,
        vi.fn(() => (closePromise ??= options.encodedSource.close())),
      );
    });
    const result = await createEncodedFilePlaybackSource(
      encodedOptions(memory.source, {
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
        aacRuntime,
        backendFactories: { createStreamingAacSource },
      }),
    );

    expect(result.backend).toBe('bounded-stream');
    expect(createStreamingAacSource).toHaveBeenCalledOnce();
    const received = createStreamingAacSource.mock.calls[0]![0];
    expect(received.queueItemId).toBe(QUEUE_ITEM_ID);
    expect(received.backendId).toBe('webcodecs');
    expect(received.runtime).toBe(aacRuntime);
    expect(received.scan).toEqual(expectedAdtsScan(memory.source.identity));
    expect(memory.close).not.toHaveBeenCalled();
    await result.source.destroy();
    await result.source.destroy();
    expect(memory.close).toHaveBeenCalledOnce();
  });

  it('rejects an invalid policy before reading a generic source and closes it once', async () => {
    const memory = memorySource(mp3Bytes(), {
      name: 'remote.mp3',
      mime: 'audio/mpeg',
      identity: 'peer-range:invalid-policy',
    });
    await expect(
      createEncodedFilePlaybackSource(
        encodedOptions(memory.source, {
          boundedRoutePolicy: {
            mode: 'universal-v1',
            aacBackendId: 'webcodecs',
            m4aBackendId: 'symphonia-wasm',
          } as unknown as FilePlaybackBoundedRoutePolicy,
        }),
      ),
    ).rejects.toThrow(/webcodecs/i);

    expect(memory.reads).not.toHaveBeenCalled();
    expect(memory.close).toHaveBeenCalledOnce();
  });

  it('closes a generic MP3 lease when the opted-in backend constructor throws', async () => {
    const memory = memorySource(mp3Bytes(), {
      name: 'remote.mp3',
      mime: 'audio/mpeg',
      identity: 'peer-range:constructor-failure',
    });
    const createStreamingMp3Source = vi.fn(() => {
      throw new Error('constructor failed');
    });
    await expect(
      createEncodedFilePlaybackSource(
        encodedOptions(memory.source, {
          boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
          backendFactories: {
            createStreamingMp3Source:
              createStreamingMp3Source as BlobFilePlaybackBackendFactories['createStreamingMp3Source'],
          },
        }),
      ),
    ).rejects.toThrow('constructor failed');

    expect(memory.close).toHaveBeenCalledOnce();
  });

  it('closes a generic raw ADTS AAC lease once when its backend constructor throws', async () => {
    const memory = memorySource(aacBytes(), {
      name: 'remote.aac',
      mime: 'audio/aac',
      identity: 'peer-range:aac-constructor-failure',
    });
    const createStreamingAacSource = vi.fn(() => {
      throw new Error('AAC constructor failed');
    });
    await expect(
      createEncodedFilePlaybackSource(
        encodedOptions(memory.source, {
          boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
          backendFactories: {
            createStreamingAacSource:
              createStreamingAacSource as BlobFilePlaybackBackendFactories['createStreamingAacSource'],
          },
        }),
      ),
    ).rejects.toThrow('AAC constructor failed');

    expect(memory.close).toHaveBeenCalledOnce();
  });

  it('closes a generic raw ADTS AAC source once when its full scan is aborted', async () => {
    const bytes = aacBytes();
    const controller = new AbortController();
    const reason = new Error('abort during ADTS scan');
    let readCount = 0;
    const readAt = vi.fn(async (offset: number, length: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      const end = validateExactRead(bytes.byteLength, offset, length);
      readCount += 1;
      if (readCount === 2) controller.abort(reason);
      return bytes.slice(offset, end);
    });
    const close = vi.fn(async () => undefined);
    const encodedSource: EncodedAudioSource = {
      kind: 'peer-range',
      size: bytes.byteLength,
      identity: 'peer-range:aac-scan-abort',
      metadata: { name: 'remote.aac', mime: 'audio/aac' },
      readAt,
      close,
    };
    const createStreamingAacSource = vi.fn();

    await expect(
      createEncodedFilePlaybackSource(
        encodedOptions(encodedSource, {
          signal: controller.signal,
          boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
          backendFactories: {
            createStreamingAacSource:
              createStreamingAacSource as BlobFilePlaybackBackendFactories['createStreamingAacSource'],
          },
        }),
      ),
    ).rejects.toBe(reason);

    expect(readAt).toHaveBeenCalledTimes(2);
    expect(createStreamingAacSource).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
