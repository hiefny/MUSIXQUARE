import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import { AudioBufferPlaybackSource } from '../backends/audio-buffer-playback-source.ts';
import {
  createBlobFilePlaybackSource,
  UnsupportedFlacContainerError,
  type CreateBlobFilePlaybackSourceOptions,
  type OrdinaryAudioDecodeRequest,
  type OrdinaryAudioDecodeResult,
} from '../file-playback-source-factory.ts';
import { EncodedSourceIntegrityError } from '../sources/encoded-audio-source.ts';

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
});
