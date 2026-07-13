import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
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

function id3PrefixedAacFile(): File {
  const emptyId3v24 = Uint8Array.of(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0);
  const adtsAac = Uint8Array.of(0xff, 0xf1, 0x50, 0x80, 0, 0x1f, 0xfc, 0, 0, 0, 0, 0);
  return new File([emptyId3v24, adtsAac], 'fixture.aac', { type: 'audio/aac' });
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

  it('does not treat an unclaimed ID3-prefixed AAC file as MP3 authority', async () => {
    const decodeOrdinaryAudio = vi.fn(async () => decodedOrdinaryAudio());
    const createStreamingMp3Source = vi.fn();
    const result = await createBlobFilePlaybackSource(
      blobOptions(id3PrefixedAacFile(), {
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
        decodeOrdinaryAudio,
        backendFactories: {
          createStreamingMp3Source:
            createStreamingMp3Source as BlobFilePlaybackBackendFactories['createStreamingMp3Source'],
        },
      }),
    );

    expect(result.backend).toBe('audio-buffer');
    expect(decodeOrdinaryAudio).toHaveBeenCalledOnce();
    expect(createStreamingMp3Source).not.toHaveBeenCalled();
  });

  it.each([
    ['MP3', 'broken.mp3', 'audio/mpeg'],
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
});
