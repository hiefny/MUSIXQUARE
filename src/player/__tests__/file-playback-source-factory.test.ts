import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import { AudioBufferPlaybackSource } from '../backends/audio-buffer-playback-source.ts';
import { StreamingFlacPlaybackSource } from '../backends/streaming-flac-playback-source.ts';
import {
  createBlobFilePlaybackSource,
  createEncodedFilePlaybackSource,
  UnsupportedFlacContainerError,
  UnsupportedOrdinaryEncodedSourceError,
  type CreateBlobFilePlaybackSourceOptions,
  type CreateEncodedFilePlaybackSourceOptions,
  type OrdinaryAudioDecodeRequest,
  type OrdinaryAudioDecodeResult,
} from '../file-playback-source-factory.ts';
import {
  EncodedSourceClosedError,
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
  validateExactRead,
} from '../sources/encoded-audio-source.ts';
import { BlobEncodedAudioSource } from '../sources/blob-encoded-audio-source.ts';

const QID = '00000000-0000-4000-8000-000000000001' as QueueItemId;

function uint64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function nativeFlac(channels: number, name = 'recording.bin'): File {
  const sampleRate = 48_000;
  const bitDepth = 24;
  const totalSamples = sampleRate * 2;
  const info = new Uint8Array(34);
  info[0] = 0x10;
  info[1] = 0x00;
  info[2] = 0x10;
  info[3] = 0x00;
  const packed =
    (BigInt(sampleRate) << 44n) |
    (BigInt(channels - 1) << 41n) |
    (BigInt(bitDepth - 1) << 36n) |
    BigInt(totalSamples);
  info.set(uint64(packed), 10);
  const lastStreamInfoHeader = new Uint8Array([0x80, 0x00, 0x00, 0x22]);
  return new File(
    [
      new Uint8Array([0x66, 0x4c, 0x61, 0x43]),
      lastStreamInfoHeader,
      info,
      new Uint8Array([0xff, 0xf8]),
    ],
    name,
    { type: 'application/octet-stream' },
  );
}

function fakeAudioBuffer(): AudioBuffer {
  return {
    duration: 12,
    sampleRate: 48_000,
    numberOfChannels: 2,
    length: 576_000,
  } as AudioBuffer;
}

function decodedOrdinaryAudio(
  audioBuffer = fakeAudioBuffer(),
  release: () => void = vi.fn(),
): OrdinaryAudioDecodeResult {
  return { audioBuffer, release };
}

function baseOptions(
  blob: Blob,
  overrides: Partial<CreateBlobFilePlaybackSourceOptions> = {},
): CreateBlobFilePlaybackSourceOptions {
  return {
    blob,
    queueItemId: QID,
    audioContext: { sampleRate: 48_000, currentTime: 0 } as AudioContext,
    nowRoomTimeMs: () => 1_000,
    roomTimeMsToContextTime: (roomTimeMs) => roomTimeMs / 1000,
    localPerformanceMsToContextTime: (localTimeMs) => localTimeMs / 1000,
    decodeOrdinaryAudio: vi.fn(async () => decodedOrdinaryAudio()),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function encodedOptions(
  encodedSource: EncodedAudioSource,
  overrides: Partial<CreateEncodedFilePlaybackSourceOptions> = {},
): CreateEncodedFilePlaybackSourceOptions {
  return {
    encodedSource,
    queueItemId: QID,
    audioContext: { sampleRate: 48_000, currentTime: 0 } as AudioContext,
    nowRoomTimeMs: () => 1_000,
    roomTimeMsToContextTime: (roomTimeMs) => roomTimeMs / 1000,
    localPerformanceMsToContextTime: (localTimeMs) => localTimeMs / 1000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function memoryEncodedSource(
  bytes: Uint8Array,
  options: {
    readonly name?: string;
    readonly mime?: string;
    readonly identity?: string;
    readonly closeError?: Error;
  } = {},
): { readonly source: EncodedAudioSource; readonly close: ReturnType<typeof vi.fn> } {
  let closed = false;
  const close = vi.fn(async () => {
    closed = true;
    if (options.closeError) throw options.closeError;
  });
  const source: EncodedAudioSource = {
    kind: 'peer-range',
    size: bytes.byteLength,
    identity: options.identity ?? 'peer-range:test-source',
    metadata: {
      name: options.name ?? 'fixture.bin',
      mime: options.mime ?? 'application/octet-stream',
    },
    readAt: async (offset, length, signal) => {
      if (closed) throw new EncodedSourceClosedError();
      signal.throwIfAborted();
      const end = validateExactRead(bytes.byteLength, offset, length);
      return bytes.slice(offset, end);
    },
    close,
  };
  return { source, close };
}

describe('createBlobFilePlaybackSource', () => {
  it.each([1, 8])(
    'routes a verified native FLAC with %i channel(s) to bounded streaming',
    async (channels) => {
      const decodeOrdinaryAudio = vi.fn(async () => decodedOrdinaryAudio());
      const result = await createBlobFilePlaybackSource(
        baseOptions(nativeFlac(channels), { decodeOrdinaryAudio }),
      );

      expect(result.backend).toBe('streaming-flac');
      if (result.backend !== 'streaming-flac') throw new Error('unexpected backend');
      expect(result.source.backend).toBe('streaming-flac');
      expect(result.source.getSnapshot().phase).toBe('new');
      expect(result.flacMetadata.streamInfo.channels).toBe(channels);
      expect(result.flacMetadata.streamInfo.sampleRate).toBe(48_000);
      expect(() => result.releaseConstructionLease()).not.toThrow();
      expect(decodeOrdinaryAudio).not.toHaveBeenCalled();
      await result.source.destroy();
    },
  );

  it('routes ordinary codecs through the injected abort-aware AudioBuffer decoder', async () => {
    const blob = new File([new Uint8Array([0x49, 0x44, 0x33, 0x04])], 'song.mp3', {
      type: 'audio/mpeg',
    });
    const audioBuffer = fakeAudioBuffer();
    const release = vi.fn();
    let backendAudioBuffer: AudioBuffer | null = null;
    const decodeOrdinaryAudio = vi.fn(async (_request: OrdinaryAudioDecodeRequest) =>
      decodedOrdinaryAudio(audioBuffer, release),
    );
    const result = await createBlobFilePlaybackSource(
      baseOptions(blob, {
        decodeOrdinaryAudio,
        backendFactories: {
          createAudioBufferSource: (options) => {
            backendAudioBuffer = options.audioBuffer;
            return new AudioBufferPlaybackSource(options);
          },
        },
      }),
    );

    expect(result).toMatchObject({ backend: 'audio-buffer', flacMetadata: null });
    if (result.backend !== 'audio-buffer') throw new Error('unexpected backend');
    expect(result.audioBuffer).toBe(audioBuffer);
    expect(backendAudioBuffer).toBe(audioBuffer);
    expect(release).not.toHaveBeenCalled();
    expect(result.source.getSnapshot()).toMatchObject({
      backend: 'audio-buffer',
      phase: 'new',
    });
    expect(decodeOrdinaryAudio).toHaveBeenCalledOnce();
    expect(decodeOrdinaryAudio.mock.calls[0]?.[0]).toMatchObject({
      blob,
      signal: expect.any(AbortSignal),
      sourceIdentity: result.sourceIdentity,
    });
    result.releaseConstructionLease();
    result.releaseConstructionLease();
    expect(release).toHaveBeenCalledOnce();
  });

  it('never falls back when a filename or MIME type claims invalid FLAC bytes', async () => {
    const decoder = vi.fn(async () => decodedOrdinaryAudio());
    const fakeFlac = new File([new Uint8Array([0x49, 0x44, 0x33, 0x04])], 'fake.flac', {
      type: 'application/octet-stream',
    });
    await expect(
      createBlobFilePlaybackSource(baseOptions(fakeFlac, { decodeOrdinaryAudio: decoder })),
    ).rejects.toThrow(EncodedSourceIntegrityError);

    const mimeClaim = new File([new Uint8Array([0x49, 0x44, 0x33, 0x04])], 'fake.bin', {
      type: 'audio/flac',
    });
    await expect(
      createBlobFilePlaybackSource(baseOptions(mimeClaim, { decodeOrdinaryAudio: decoder })),
    ).rejects.toThrow(/does not contain the native fLaC marker/);
    expect(decoder).not.toHaveBeenCalled();
  });

  it('reports claimed Ogg-FLAC as an explicitly unsupported container', async () => {
    const decoder = vi.fn(async () => decodedOrdinaryAudio());
    const oggFlac = new File([new Uint8Array([0x4f, 0x67, 0x67, 0x53])], 'stream.flac', {
      type: 'audio/ogg; codecs=flac',
    });

    await expect(
      createBlobFilePlaybackSource(baseOptions(oggFlac, { decodeOrdinaryAudio: decoder })),
    ).rejects.toBeInstanceOf(UnsupportedFlacContainerError);
    expect(decoder).not.toHaveBeenCalled();
  });

  it('rejects cancellation before work and after an ordinary decode resolves', async () => {
    const preAborted = new AbortController();
    preAborted.abort(new Error('superseded-before-routing'));
    const neverCalled = vi.fn(async () => decodedOrdinaryAudio());
    await expect(
      createBlobFilePlaybackSource(
        baseOptions(new Blob(['ID3!']), {
          decodeOrdinaryAudio: neverCalled,
          signal: preAborted.signal,
        }),
      ),
    ).rejects.toThrow('superseded-before-routing');
    expect(neverCalled).not.toHaveBeenCalled();

    const duringDecode = new AbortController();
    const release = vi.fn();
    const decodeThenAbort = vi.fn(async () => {
      duringDecode.abort(new Error('superseded-during-decode'));
      return decodedOrdinaryAudio(fakeAudioBuffer(), release);
    });
    await expect(
      createBlobFilePlaybackSource(
        baseOptions(new Blob(['ID3!']), {
          decodeOrdinaryAudio: decodeThenAbort,
          signal: duringDecode.signal,
        }),
      ),
    ).rejects.toThrow('superseded-during-decode');
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases the construction lease and destroys a mismatched constructed source', async () => {
    const release = vi.fn();
    const destroy = vi.fn(async () => undefined);
    const mismatchedSource = {
      backend: 'audio-buffer',
      queueItemId: 'wrong-queue-item',
      destroy,
    };

    await expect(
      createBlobFilePlaybackSource(
        baseOptions(new Blob(['ID3!']), {
          decodeOrdinaryAudio: vi.fn(async () => decodedOrdinaryAudio(fakeAudioBuffer(), release)),
          backendFactories: {
            createAudioBufferSource: (() => mismatchedSource) as never,
          },
        }),
      ),
    ).rejects.toThrow('mismatched source');

    expect(destroy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases the construction lease when the AudioBuffer backend constructor throws', async () => {
    const release = vi.fn();
    const constructorError = new Error('constructor failed');

    await expect(
      createBlobFilePlaybackSource(
        baseOptions(new Blob(['ID3!']), {
          decodeOrdinaryAudio: vi.fn(async () => decodedOrdinaryAudio(fakeAudioBuffer(), release)),
          backendFactories: {
            createAudioBufferSource: vi.fn(() => {
              throw constructorError;
            }),
          },
        }),
      ),
    ).rejects.toBe(constructorError);

    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects malformed decoder results and releases any valid acquired lease', async () => {
    await expect(
      createBlobFilePlaybackSource(
        baseOptions(new Blob(['ID3!']), {
          decodeOrdinaryAudio: vi.fn(async () => fakeAudioBuffer() as never),
        }),
      ),
    ).rejects.toThrow('invalid release function');

    const release = vi.fn();
    await expect(
      createBlobFilePlaybackSource(
        baseOptions(new Blob(['ID3!']), {
          decodeOrdinaryAudio: vi.fn(async () => ({ audioBuffer: null, release }) as never),
        }),
      ),
    ).rejects.toThrow('invalid AudioBuffer');
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps separate object identities for same-name, same-size files', async () => {
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04]);
    const first = new File([bytes], 'same.mp3', { type: 'audio/mpeg' });
    const second = new File([bytes], 'same.mp3', { type: 'audio/mpeg' });

    const firstResult = await createBlobFilePlaybackSource(baseOptions(first));
    const secondResult = await createBlobFilePlaybackSource(baseOptions(second));

    expect(first.name).toBe(second.name);
    expect(first.size).toBe(second.size);
    expect(firstResult.sourceIdentity).not.toBe(secondResult.sourceIdentity);
  });

  it('preserves an exact distributed source identity for streaming and ordinary blobs', async () => {
    const ordinaryIdentity = 'source:room-bound-ordinary';
    const decodeOrdinaryAudio = vi.fn(async () => decodedOrdinaryAudio());
    const ordinary = await createBlobFilePlaybackSource(
      baseOptions(new Blob(['ID3!'], { type: 'audio/mpeg' }), {
        sourceIdentity: ordinaryIdentity,
        decodeOrdinaryAudio,
      }),
    );

    expect(ordinary.sourceIdentity).toBe(ordinaryIdentity);
    expect(decodeOrdinaryAudio.mock.calls[0]?.[0].sourceIdentity).toBe(ordinaryIdentity);
    ordinary.releaseConstructionLease();
    await ordinary.source.destroy();

    const streamingIdentity = 'source:room-bound-flac';
    const streaming = await createBlobFilePlaybackSource(
      baseOptions(nativeFlac(2), { sourceIdentity: streamingIdentity }),
    );

    expect(streaming.sourceIdentity).toBe(streamingIdentity);
    await streaming.source.destroy();
  });

  it('preserves registry metadata for a plain received Blob and uses it for container claims', async () => {
    const sourceMetadata = { name: 'remote-take.flac', mime: 'audio/flac' };
    let routedMetadata: { readonly name: string; readonly mime: string } | null = null;
    const streaming = await createBlobFilePlaybackSource(
      baseOptions(new Blob([await nativeFlac(2).arrayBuffer()]), {
        sourceIdentity: 'source:remote-plain-flac',
        sourceMetadata,
        backendFactories: {
          createStreamingFlacSource: (options) => {
            routedMetadata = options.encodedSource.metadata;
            return new StreamingFlacPlaybackSource(options);
          },
        },
      }),
    );

    expect(routedMetadata).toEqual(sourceMetadata);
    await streaming.source.destroy();

    const decoder = vi.fn(async () => decodedOrdinaryAudio());
    await expect(
      createBlobFilePlaybackSource(
        baseOptions(new Blob(['ID3!']), {
          sourceIdentity: 'source:remote-invalid-flac',
          sourceMetadata,
          decodeOrdinaryAudio: decoder,
        }),
      ),
    ).rejects.toThrow(/claims to be FLAC/u);
    expect(decoder).not.toHaveBeenCalled();
  });

  it('snapshots registry metadata once and rejects nested accessors without invoking them', async () => {
    const options = baseOptions(new Blob(['ID3!']));
    let metadataReads = 0;
    const metadata = { name: 'remote.mp3', mime: 'audio/mpeg' };
    Object.defineProperty(options, 'sourceMetadata', {
      enumerable: true,
      get() {
        metadataReads += 1;
        return metadata;
      },
    });
    const result = await createBlobFilePlaybackSource(options);
    expect(metadataReads).toBe(1);
    result.releaseConstructionLease();
    await result.source.destroy();

    let nestedReads = 0;
    const hostileMetadata = {
      get name() {
        nestedReads += 1;
        return 'hostile.mp3';
      },
      mime: 'audio/mpeg',
    };
    await expect(
      createBlobFilePlaybackSource(
        baseOptions(new Blob(['ID3!']), {
          sourceMetadata: hostileMetadata,
        }),
      ),
    ).rejects.toThrow(/metadata is invalid/u);
    expect(nestedReads).toBe(0);
  });

  it('rejects a malformed explicit identity before reading or decoding the Blob', async () => {
    const blob = new Blob(['ID3!'], { type: 'audio/mpeg' });
    const arrayBuffer = vi.spyOn(Blob.prototype, 'arrayBuffer');
    const decodeOrdinaryAudio = vi.fn(async () => decodedOrdinaryAudio());

    try {
      for (const sourceIdentity of ['', '  source:changes-if-trimmed  ']) {
        await expect(
          createBlobFilePlaybackSource(
            baseOptions(blob, {
              sourceIdentity,
              decodeOrdinaryAudio,
            }),
          ),
        ).rejects.toThrow('identity is invalid');
      }
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(decodeOrdinaryAudio).not.toHaveBeenCalled();
    } finally {
      arrayBuffer.mockRestore();
    }
  });

  it('snapshots a hostile distributed identity getter exactly once', async () => {
    const firstIdentity = 'source:distributed-first';
    const secondIdentity = 'source:distributed-second';
    let getterCalls = 0;
    const decodeOrdinaryAudio = vi.fn(async () => decodedOrdinaryAudio());
    const options = baseOptions(new Blob(['ID3!'], { type: 'audio/mpeg' }), {
      decodeOrdinaryAudio,
    });
    Object.defineProperty(options, 'sourceIdentity', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return getterCalls === 1 ? firstIdentity : secondIdentity;
      },
    });

    const result = await createBlobFilePlaybackSource(options);

    expect(getterCalls).toBe(1);
    expect(result.sourceIdentity).toBe(firstIdentity);
    expect(decodeOrdinaryAudio.mock.calls[0]?.[0].sourceIdentity).toBe(firstIdentity);
    result.releaseConstructionLease();
    await result.source.destroy();
  });

  it('snapshots a hostile Blob getter once for validation, identity, and decoding', async () => {
    const first = new Blob([Uint8Array.of(0x49, 0x44, 0x33, 0x01)], {
      type: 'audio/mpeg',
    });
    const second = new Blob([Uint8Array.of(0x49, 0x44, 0x33, 0x02)], {
      type: 'audio/mpeg',
    });
    let getterCalls = 0;
    let decodedBlob: Blob | null = null;
    const options = baseOptions(first, {
      decodeOrdinaryAudio: vi.fn(async (request) => {
        decodedBlob = request.blob;
        return decodedOrdinaryAudio();
      }),
    });
    Object.defineProperty(options, 'blob', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return getterCalls === 1 ? first : second;
      },
    });
    const expectedIdentity = new BlobEncodedAudioSource(first).identity;

    const result = await createBlobFilePlaybackSource(options);

    expect(result.backend).toBe('audio-buffer');
    expect(getterCalls).toBe(1);
    expect(decodedBlob).toBe(first);
    expect(result.sourceIdentity).toBe(expectedIdentity);
    result.releaseConstructionLease();
    await result.source.destroy();
  });

  it('returns a valid ordinary source when exact Blob source cleanup rejects', async () => {
    const closeError = new Error('blob close rejected');
    const close = vi.spyOn(BlobEncodedAudioSource.prototype, 'close').mockRejectedValue(closeError);
    const release = vi.fn();

    try {
      const result = await createBlobFilePlaybackSource(
        baseOptions(new Blob(['ID3!'], { type: 'audio/mpeg' }), {
          decodeOrdinaryAudio: vi.fn(async () => decodedOrdinaryAudio(fakeAudioBuffer(), release)),
        }),
      );

      expect(result.backend).toBe('audio-buffer');
      expect(close).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
      result.releaseConstructionLease();
      result.releaseConstructionLease();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
    }
  });

  it('preserves a primary construction failure when exact Blob cleanup rejects', async () => {
    const closeError = new Error('blob close rejected');
    const close = vi.spyOn(BlobEncodedAudioSource.prototype, 'close').mockRejectedValue(closeError);
    const release = vi.fn();
    const destroy = vi.fn(async () => undefined);
    const mismatchedSource = {
      backend: 'audio-buffer',
      queueItemId: 'wrong-queue-item',
      destroy,
    };

    try {
      await expect(
        createBlobFilePlaybackSource(
          baseOptions(new Blob(['ID3!'], { type: 'audio/mpeg' }), {
            decodeOrdinaryAudio: vi.fn(async () =>
              decodedOrdinaryAudio(fakeAudioBuffer(), release),
            ),
            backendFactories: {
              createAudioBufferSource: (() => mismatchedSource) as never,
            },
          }),
        ),
      ).rejects.toThrow('mismatched source');

      expect(destroy).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
    }
  });
});

describe('createEncodedFilePlaybackSource', () => {
  it('snapshots a hostile encodedSource getter once before validation and ownership', async () => {
    const file = nativeFlac(2);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const first = memoryEncodedSource(bytes, {
      name: file.name,
      mime: file.type,
      identity: 'peer-range:getter-first',
    });
    const second = memoryEncodedSource(bytes, {
      name: file.name,
      mime: file.type,
      identity: 'peer-range:getter-second',
    });
    let getterCalls = 0;
    let receivedSource: EncodedAudioSource | null = null;
    const options = encodedOptions(first.source, {
      backendFactories: {
        createStreamingFlacSource: (sourceOptions) => {
          receivedSource = sourceOptions.encodedSource;
          return new StreamingFlacPlaybackSource(sourceOptions);
        },
      },
    });
    Object.defineProperty(options, 'encodedSource', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return getterCalls === 1 ? first.source : second.source;
      },
    });

    const result = await createEncodedFilePlaybackSource(options);

    expect(result.backend).toBe('streaming-flac');
    expect(getterCalls).toBe(1);
    expect(receivedSource).toBe(first.source);
    expect(result.sourceIdentity).toBe(first.source.identity);
    expect(first.close).not.toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();
    await result.source.destroy();
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).not.toHaveBeenCalled();
  });

  it('transfers the exact generic FLAC source to streaming ownership until destroy', async () => {
    const file = nativeFlac(2);
    const fixture = memoryEncodedSource(new Uint8Array(await file.arrayBuffer()), {
      name: file.name,
      mime: file.type,
      identity: 'peer-range:exact-stream-source',
    });
    let receivedSource: EncodedAudioSource | null = null;
    const result = await createEncodedFilePlaybackSource(
      encodedOptions(fixture.source, {
        backendFactories: {
          createStreamingFlacSource: (options) => {
            receivedSource = options.encodedSource;
            return new StreamingFlacPlaybackSource(options);
          },
        },
      }),
    );

    expect(result.backend).toBe('streaming-flac');
    expect(receivedSource).toBe(fixture.source);
    expect(result.sourceIdentity).toBe(fixture.source.identity);
    expect(fixture.close).not.toHaveBeenCalled();
    await result.source.destroy();
    await result.source.destroy();
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  it('rejects ordinary generic sources even when callers inject an unrelated Blob seam', async () => {
    const fixture = memoryEncodedSource(Uint8Array.of(0x49, 0x44, 0x33, 0x04), {
      name: 'peer.mp3',
      mime: 'audio/mpeg',
    });
    const decoder = vi.fn(async () => decodedOrdinaryAudio());
    const injectedOptions = Object.assign(encodedOptions(fixture.source), {
      ordinaryBlob: new Blob(['different bytes'], { type: 'audio/mpeg' }),
      decodeOrdinaryAudio: decoder,
      ordinaryBinding: {
        blob: new Blob(['also different'], { type: 'audio/mpeg' }),
        decodeOrdinaryAudio: decoder,
      },
    });

    await expect(createEncodedFilePlaybackSource(injectedOptions)).rejects.toBeInstanceOf(
      UnsupportedOrdinaryEncodedSourceError,
    );
    expect(decoder).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  it('commits returned streaming ownership before validating the backend identity', async () => {
    const file = nativeFlac(2);
    const fixture = memoryEncodedSource(new Uint8Array(await file.arrayBuffer()), {
      name: file.name,
      mime: file.type,
    });
    let destroy: ReturnType<typeof vi.spyOn> | null = null;

    await expect(
      createEncodedFilePlaybackSource(
        encodedOptions(fixture.source, {
          backendFactories: {
            createStreamingFlacSource: (options) => {
              const source = new StreamingFlacPlaybackSource({
                ...options,
                queueItemId: 'wrong-queue-item',
              });
              destroy = vi.spyOn(source, 'destroy');
              return source;
            },
          },
        }),
      ),
    ).rejects.toThrow('mismatched source');

    expect(destroy).not.toBeNull();
    expect(destroy).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('preserves a streaming factory failure when encoded-source cleanup rejects', async () => {
    const file = nativeFlac(2);
    const closeError = new Error('encoded close rejected');
    const fixture = memoryEncodedSource(new Uint8Array(await file.arrayBuffer()), {
      name: file.name,
      mime: file.type,
      closeError,
    });
    const primaryError = new Error('streaming constructor failed');

    await expect(
      createEncodedFilePlaybackSource(
        encodedOptions(fixture.source, {
          backendFactories: {
            createStreamingFlacSource: () => {
              throw primaryError;
            },
          },
        }),
      ),
    ).rejects.toBe(primaryError);

    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('destroys transferred streaming ownership exactly once when superseded during routing', async () => {
    const file = nativeFlac(2);
    const fixture = memoryEncodedSource(new Uint8Array(await file.arrayBuffer()), {
      name: file.name,
      mime: file.type,
    });
    const controller = new AbortController();

    await expect(
      createEncodedFilePlaybackSource(
        encodedOptions(fixture.source, {
          signal: controller.signal,
          backendFactories: {
            createStreamingFlacSource: (options) => {
              const source = new StreamingFlacPlaybackSource(options);
              controller.abort(new Error('streaming-source-superseded'));
              return source;
            },
          },
        }),
      ),
    ).rejects.toThrow('streaming-source-superseded');
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });
});
