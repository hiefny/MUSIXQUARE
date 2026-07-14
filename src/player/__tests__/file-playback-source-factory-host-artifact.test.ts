import { beforeEach, describe, expect, it, vi } from 'vitest';

const scannerMocks = vi.hoisted(() => ({
  scanAdtsFrames: vi.fn(),
  readMp3Metadata: vi.fn(),
  lastAdtsScan: null as unknown,
  lastMp3Metadata: null as unknown,
}));

vi.mock('../aac/frame-scanner.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../aac/frame-scanner.ts')>();
  scannerMocks.scanAdtsFrames.mockImplementation(
    async (...args: Parameters<typeof actual.scanAdtsFrames>) => {
      const result = await actual.scanAdtsFrames(...args);
      scannerMocks.lastAdtsScan = result;
      return result;
    },
  );
  return { ...actual, scanAdtsFrames: scannerMocks.scanAdtsFrames };
});

vi.mock('../mp3/metadata.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mp3/metadata.ts')>();
  scannerMocks.readMp3Metadata.mockImplementation(
    async (...args: Parameters<typeof actual.readMp3Metadata>) => {
      const result = await actual.readMp3Metadata(...args);
      scannerMocks.lastMp3Metadata = result;
      return result;
    },
  );
  return { ...actual, readMp3Metadata: scannerMocks.readMp3Metadata };
});

import type { QueueItemId } from '../../types/index.ts';
import type { StreamingAacPlaybackSourceOptions } from '../backends/streaming-aac-playback-source.ts';
import type { StreamingM4aAacPlaybackSourceOptions } from '../backends/streaming-m4a-aac-playback-source.ts';
import type { StreamingMp3PlaybackSourceOptions } from '../backends/streaming-mp3-playback-source.ts';
import {
  FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
  type FilePlaybackBoundedRoutePolicy,
} from '../file-playback-bounded-route-policy.ts';
import {
  codecTimelineHostArtifactForFilePlaybackSourceResult,
  createBlobFilePlaybackSource,
  createEncodedFilePlaybackSource,
  type BlobFilePlaybackBackendFactories,
  type CreateEncodedFilePlaybackSourceOptions,
  type OrdinaryAudioDecodeResult,
} from '../file-playback-source-factory.ts';
import { buildM4aAacFixture } from '../m4a/__tests__/m4a-aac-fixture.ts';
import type { CodecTimelineHostArtifactBinding } from '../manifests/codec-timeline-host-artifact.ts';
import { parseMpegLayer3FrameHeader } from '../mp3/frame-header.ts';
import {
  EncodedSourceClosedError,
  type EncodedAudioSource,
  validateExactRead,
} from '../sources/encoded-audio-source.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-0000000000e1' as QueueItemId;

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
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

function adtsBytes(): Uint8Array {
  return concatenate(makeAdtsFrame(19, 0x11), makeAdtsFrame(41, 0x22), makeAdtsFrame(83, 0x33));
}

function makeMp3Frame(): Uint8Array {
  const headerBytes = Uint8Array.of(0xff, 0xfb, 0x90, 0x00);
  const header = parseMpegLayer3FrameHeader(headerBytes);
  const frame = new Uint8Array(header.frameLengthBytes);
  frame.set(headerBytes);
  return frame;
}

function mp3Bytes(): Uint8Array {
  return concatenate(...Array.from({ length: 5 }, () => makeMp3Frame()));
}

function countedMp3Bytes(): Uint8Array {
  const tag = makeMp3Frame();
  const header = parseMpegLayer3FrameHeader(tag.subarray(0, 4));
  const offset = 4 + header.sideInfoBytes;
  writeAscii(tag, offset, 'Xing');
  const view = new DataView(tag.buffer, tag.byteOffset, tag.byteLength);
  view.setUint32(offset + 4, 0x01, false);
  view.setUint32(offset + 8, 5, false);
  return concatenate(tag, ...Array.from({ length: 5 }, () => makeMp3Frame()));
}

function nativeFlacBytes(): Uint8Array {
  const sampleRate = 48_000;
  const channels = 2;
  const bitDepth = 24;
  const totalSamples = sampleRate * 2;
  const info = new Uint8Array(34);
  info[0] = 0x10;
  info[1] = 0x00;
  info[2] = 0x10;
  info[3] = 0x00;
  let packed =
    (BigInt(sampleRate) << 44n) |
    (BigInt(channels - 1) << 41n) |
    (BigInt(bitDepth - 1) << 36n) |
    BigInt(totalSamples);
  for (let index = 17; index >= 10; index -= 1) {
    info[index] = Number(packed & 0xffn);
    packed >>= 8n;
  }
  return concatenate(
    Uint8Array.of(0x66, 0x4c, 0x61, 0x43),
    Uint8Array.of(0x80, 0x00, 0x00, 0x22),
    info,
    Uint8Array.of(0xff, 0xf8),
  );
}

function waveBytes(): Uint8Array {
  const bytes = new Uint8Array(60);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 192_000, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, 16, true);
  return bytes;
}

function uint16Be(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, false);
  return bytes;
}

function uint32Be(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function extendedInteger(value: number): Uint8Array {
  const highestBit = Math.floor(Math.log2(value));
  const bytes = new Uint8Array(10);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 16_383 + highestBit, false);
  view.setBigUint64(2, BigInt(value) << BigInt(63 - highestBit), false);
  return bytes;
}

function iffChunk(id: string, body: Uint8Array): Uint8Array {
  return concatenate(
    ascii(id),
    uint32Be(body.byteLength),
    body,
    body.byteLength % 2 === 0 ? new Uint8Array() : Uint8Array.of(0),
  );
}

function aiffBytes(): Uint8Array {
  const common = concatenate(uint16Be(2), uint32Be(4), uint16Be(16), extendedInteger(48_000));
  const sound = concatenate(new Uint8Array(8), new Uint8Array(16));
  const body = concatenate(ascii('AIFF'), iffChunk('COMM', common), iffChunk('SSND', sound));
  return concatenate(ascii('FORM'), uint32Be(body.byteLength), body);
}

function cafBytes(): Uint8Array {
  const header = new Uint8Array(8);
  writeAscii(header, 0, 'caff');
  new DataView(header.buffer).setUint16(4, 1, false);
  const description = new Uint8Array(32);
  const view = new DataView(description.buffer);
  view.setFloat64(0, 48_000, false);
  writeAscii(description, 8, 'lpcm');
  view.setUint32(16, 4, false);
  view.setUint32(20, 1, false);
  view.setUint32(24, 2, false);
  view.setUint32(28, 16, false);
  const chunk = (id: string, body: Uint8Array): Uint8Array => {
    const chunkHeader = new Uint8Array(12);
    writeAscii(chunkHeader, 0, id);
    new DataView(chunkHeader.buffer).setBigInt64(4, BigInt(body.byteLength), false);
    return concatenate(chunkHeader, body);
  };
  return concatenate(
    header,
    chunk('desc', description),
    chunk('data', concatenate(new Uint8Array(4), new Uint8Array(16))),
  );
}

interface MemorySourceOptions {
  readonly name: string;
  readonly mime: string;
  readonly identity: string;
  readonly afterRead?: (offset: number, length: number) => void;
}

function memorySource(bytes: Uint8Array, options: MemorySourceOptions) {
  let closed = false;
  const readAt = vi.fn(async (offset: number, length: number, signal: AbortSignal) => {
    if (closed) throw new EncodedSourceClosedError();
    signal.throwIfAborted();
    const end = validateExactRead(bytes.byteLength, offset, length);
    const result = bytes.slice(offset, end);
    options.afterRead?.(offset, length);
    return result;
  });
  const close = vi.fn(async () => {
    closed = true;
  });
  const source: EncodedAudioSource = {
    kind: 'peer-range',
    size: bytes.byteLength,
    identity: options.identity,
    metadata: { name: options.name, mime: options.mime },
    readAt,
    close,
  };
  return { source, readAt, close };
}

function bindingFor(source: EncodedAudioSource): CodecTimelineHostArtifactBinding {
  return {
    queueItemId: QUEUE_ITEM_ID,
    sourceIdentity: source.identity,
    transferSessionId: 'host-transfer-session:artifact-test',
    encodedSize: source.size,
    name: source.metadata.name,
    mime: source.metadata.mime,
  };
}

function boundedSource(queueItemId: QueueItemId, backend = 'bounded-stream' as const) {
  return {
    backend,
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
    destroy: vi.fn(async () => undefined),
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
    aacCapabilityProbe: async () => undefined,
    boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
    ...overrides,
  };
}

function fakeAudioBuffer(): AudioBuffer {
  return {
    duration: 12,
    sampleRate: 48_000,
    numberOfChannels: 2,
    length: 576_000,
  } as AudioBuffer;
}

describe('file playback source factory host timeline artifact', () => {
  beforeEach(() => {
    scannerMocks.scanAdtsFrames.mockClear();
    scannerMocks.readMp3Metadata.mockClear();
    scannerMocks.lastAdtsScan = null;
    scannerMocks.lastMp3Metadata = null;
  });

  it('reuses the exact single ADTS scan for playback and an opaque artifact', async () => {
    const memory = memorySource(adtsBytes(), {
      name: 'remote.aac',
      mime: 'audio/aac',
      identity: 'peer-range:host-artifact-adts',
    });
    const createStreamingAacSource = vi.fn((options: StreamingAacPlaybackSourceOptions) =>
      boundedSource(options.queueItemId),
    );

    const result = await createEncodedFilePlaybackSource(
      encodedOptions(memory.source, {
        codecTimelineHostArtifactBinding: bindingFor(memory.source),
        backendFactories: { createStreamingAacSource },
      }),
    );

    const artifact = codecTimelineHostArtifactForFilePlaybackSourceResult(result);
    expect(scannerMocks.scanAdtsFrames).toHaveBeenCalledOnce();
    expect(createStreamingAacSource.mock.calls[0]![0].scan).toBe(scannerMocks.lastAdtsScan);
    expect(artifact).toMatchObject({
      codec: 'adts-aac-lc',
      binding: bindingFor(memory.source),
    });
    expect(Object.keys(result)).toEqual([
      'backend',
      'source',
      'sourceIdentity',
      'releaseConstructionLease',
    ]);
    expect(codecTimelineHostArtifactForFilePlaybackSourceResult({ ...result })).toBeNull();
    expect(codecTimelineHostArtifactForFilePlaybackSourceResult(artifact)).toBeNull();
  });

  it('reuses one eligible no-count MP3 metadata result without a second scan', async () => {
    const memory = memorySource(mp3Bytes(), {
      name: 'remote.mp3',
      mime: 'audio/mpeg',
      identity: 'peer-range:host-artifact-mp3',
    });
    const createStreamingMp3Source = vi.fn((options: StreamingMp3PlaybackSourceOptions) =>
      boundedSource(options.queueItemId),
    );

    const result = await createEncodedFilePlaybackSource(
      encodedOptions(memory.source, {
        codecTimelineHostArtifactBinding: bindingFor(memory.source),
        backendFactories: { createStreamingMp3Source },
      }),
    );

    expect(scannerMocks.readMp3Metadata).toHaveBeenCalledOnce();
    expect(createStreamingMp3Source.mock.calls[0]![0].metadata).toBe(scannerMocks.lastMp3Metadata);
    expect(codecTimelineHostArtifactForFilePlaybackSourceResult(result)).toMatchObject({
      codec: 'mp3-no-frame-count',
      binding: bindingFor(memory.source),
    });
  });

  it('keeps a counted MP3 on direct peer-range with no host artifact', async () => {
    const memory = memorySource(countedMp3Bytes(), {
      name: 'counted.mp3',
      mime: 'audio/mpeg',
      identity: 'peer-range:host-artifact-counted-mp3',
    });
    const createStreamingMp3Source = vi.fn((options: StreamingMp3PlaybackSourceOptions) =>
      boundedSource(options.queueItemId),
    );

    const result = await createEncodedFilePlaybackSource(
      encodedOptions(memory.source, {
        codecTimelineHostArtifactBinding: bindingFor(memory.source),
        backendFactories: { createStreamingMp3Source },
      }),
    );

    expect(scannerMocks.readMp3Metadata).toHaveBeenCalledOnce();
    expect(createStreamingMp3Source.mock.calls[0]![0].metadata).toMatchObject({
      frameCountEvidence: 'xing',
      gapless: null,
    });
    expect(codecTimelineHostArtifactForFilePlaybackSourceResult(result)).toBeNull();
  });

  it('fails before backend ownership and closes once on a mismatched binding', async () => {
    const memory = memorySource(adtsBytes(), {
      name: 'mismatch.aac',
      mime: 'audio/aac',
      identity: 'peer-range:host-artifact-mismatch',
    });
    const createStreamingAacSource = vi.fn((options: StreamingAacPlaybackSourceOptions) =>
      boundedSource(options.queueItemId),
    );
    const mismatch = {
      ...bindingFor(memory.source),
      sourceIdentity: 'peer-range:unrelated-source',
    };

    await expect(
      createEncodedFilePlaybackSource(
        encodedOptions(memory.source, {
          codecTimelineHostArtifactBinding: mismatch,
          backendFactories: { createStreamingAacSource },
        }),
      ),
    ).rejects.toThrow(/timeline.*binding|source binding/i);

    expect(scannerMocks.scanAdtsFrames).toHaveBeenCalledOnce();
    expect(createStreamingAacSource).not.toHaveBeenCalled();
    expect(memory.close).toHaveBeenCalledOnce();
  });

  it('closes once when abort wins during post-scan artifact binding', async () => {
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'host-artifact-binding' });
    const bytes = adtsBytes();
    let wholeSourceReads = 0;
    const memory = memorySource(bytes, {
      name: 'abort.aac',
      mime: 'audio/aac',
      identity: 'peer-range:host-artifact-abort',
      afterRead: (_offset, length) => {
        if (length !== bytes.byteLength) return;
        wholeSourceReads += 1;
        if (wholeSourceReads === 3) controller.abort(reason);
      },
    });
    const createStreamingAacSource = vi.fn((options: StreamingAacPlaybackSourceOptions) =>
      boundedSource(options.queueItemId),
    );

    await expect(
      createEncodedFilePlaybackSource(
        encodedOptions(memory.source, {
          signal: controller.signal,
          codecTimelineHostArtifactBinding: bindingFor(memory.source),
          backendFactories: { createStreamingAacSource },
        }),
      ),
    ).rejects.toBe(reason);

    expect(scannerMocks.scanAdtsFrames).toHaveBeenCalledOnce();
    expect(scannerMocks.lastAdtsScan).not.toBeNull();
    expect(createStreamingAacSource).not.toHaveBeenCalled();
    expect(memory.close).toHaveBeenCalledOnce();
  });

  it('rejects a non-exact public binding before reads and closes the source once', async () => {
    const memory = memorySource(adtsBytes(), {
      name: 'extra-binding.aac',
      mime: 'audio/aac',
      identity: 'peer-range:host-artifact-extra-binding',
    });
    const invalid = { ...bindingFor(memory.source), extra: true };

    await expect(
      createEncodedFilePlaybackSource(
        encodedOptions(memory.source, {
          codecTimelineHostArtifactBinding: invalid as CodecTimelineHostArtifactBinding,
        }),
      ),
    ).rejects.toThrow(/binding fields are not exact/i);

    expect(memory.readAt).not.toHaveBeenCalled();
    expect(memory.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['FLAC', nativeFlacBytes(), 'remote.flac', 'audio/flac', 'createStreamingFlacSource'],
    ['WAVE', waveBytes(), 'remote.wav', 'audio/wav', 'createStreamingLinearPcmSource'],
    ['AIFF', aiffBytes(), 'remote.aiff', 'audio/aiff', 'createStreamingLinearPcmSource'],
    ['CAF', cafBytes(), 'remote.caf', 'audio/caf', 'createStreamingLinearPcmSource'],
    ['M4A', buildM4aAacFixture().bytes, 'remote.m4a', 'audio/mp4', 'createStreamingM4aAacSource'],
  ] as const)(
    'returns null artifact for %s even when an exact binding is supplied',
    async (_label, bytes, name, mime, factoryName) => {
      const memory = memorySource(bytes, {
        name,
        mime,
        identity: `peer-range:null-artifact:${name}`,
      });
      const factory = vi.fn(
        (
          options: Parameters<NonNullable<BlobFilePlaybackBackendFactories[typeof factoryName]>>[0],
        ) => boundedSource(options.queueItemId),
      );
      const backendFactories = {
        [factoryName]: factory,
      } as Partial<BlobFilePlaybackBackendFactories>;

      const result = await createEncodedFilePlaybackSource(
        encodedOptions(memory.source, {
          codecTimelineHostArtifactBinding: bindingFor(memory.source),
          backendFactories,
        }),
      );

      expect(factory).toHaveBeenCalledOnce();
      expect(codecTimelineHostArtifactForFilePlaybackSourceResult(result)).toBeNull();
    },
  );

  it('returns null for absent binding and for the ordinary AudioBuffer route', async () => {
    const unboundMemory = memorySource(adtsBytes(), {
      name: 'unbound.aac',
      mime: 'audio/aac',
      identity: 'peer-range:unbound-host-artifact',
    });
    const unbound = await createEncodedFilePlaybackSource(
      encodedOptions(unboundMemory.source, {
        backendFactories: {
          createStreamingAacSource: (options) => boundedSource(options.queueItemId),
        },
      }),
    );
    expect(codecTimelineHostArtifactForFilePlaybackSourceResult(unbound)).toBeNull();

    const identity = 'blob:ordinary-host-artifact';
    const blob = new File([mp3Bytes()], 'ordinary.mp3', { type: 'audio/mpeg' });
    const audioBuffer = fakeAudioBuffer();
    const decoded: OrdinaryAudioDecodeResult = { audioBuffer, release: vi.fn() };
    const result = await createBlobFilePlaybackSource({
      blob,
      sourceIdentity: identity,
      queueItemId: QUEUE_ITEM_ID,
      audioContext: { sampleRate: 48_000, currentTime: 0 } as AudioContext,
      nowRoomTimeMs: () => 1_000,
      roomTimeMsToContextTime: (roomTimeMs) => roomTimeMs / 1_000,
      localPerformanceMsToContextTime: (localTimeMs) => localTimeMs / 1_000,
      signal: new AbortController().signal,
      boundedRoutePolicy: { mode: 'current' } satisfies FilePlaybackBoundedRoutePolicy,
      codecTimelineHostArtifactBinding: {
        queueItemId: QUEUE_ITEM_ID,
        sourceIdentity: identity,
        transferSessionId: 'host-transfer-session:ordinary-artifact-test',
        encodedSize: blob.size,
        name: blob.name,
        mime: blob.type,
      },
      decodeOrdinaryAudio: vi.fn(async () => decoded),
      backendFactories: {
        createAudioBufferSource: (options) => boundedSource(options.queueItemId, 'audio-buffer'),
      },
    });

    expect(result.backend).toBe('audio-buffer');
    expect(codecTimelineHostArtifactForFilePlaybackSourceResult(result)).toBeNull();
  });
});
