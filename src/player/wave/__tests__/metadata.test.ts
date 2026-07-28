import { describe, expect, it } from 'vitest';

import {
  EncodedSourceClosedError,
  type EncodedAudioSource,
  type EncodedAudioSourceMetadata,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import { BlobEncodedAudioSource } from '../../sources/blob-encoded-audio-source.ts';
import {
  UnsupportedWaveCodecError,
  UnsupportedWaveContainerError,
  WAVE_MAX_CHUNKS,
  readWavePcmMetadata,
  type WavePcmEncoding,
} from '../metadata.ts';

const GIB = 1_024 * 1_024 * 1_024;
const UINT32_PLACEHOLDER = 0xffff_ffff;
const PCM_GUID_SUFFIX = Uint8Array.of(
  0x00,
  0x00,
  0x00,
  0x00,
  0x10,
  0x00,
  0x80,
  0x00,
  0x00,
  0xaa,
  0x00,
  0x38,
  0x9b,
  0x71,
);

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let cursor = 0;
  for (const part of parts) {
    output.set(part, cursor);
    cursor += part.byteLength;
  }
  return output;
}

function chunkHeader(chunkId: string, size: number): Uint8Array {
  const bytes = new Uint8Array(8);
  writeAscii(bytes, 0, chunkId);
  new DataView(bytes.buffer).setUint32(4, size, true);
  return bytes;
}

function chunk(chunkId: string, body: Uint8Array, declaredSize = body.byteLength): Uint8Array {
  const padding = body.byteLength % 2 === 0 ? new Uint8Array(0) : Uint8Array.of(0);
  return concatenate(chunkHeader(chunkId, declaredSize), body, padding);
}

function riffPayload(payload: Uint8Array, marker = 'RIFF', type = 'WAVE'): Uint8Array {
  const bytes = new Uint8Array(12 + payload.byteLength);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, marker);
  view.setUint32(4, payload.byteLength + 4, true);
  writeAscii(bytes, 8, type);
  bytes.set(payload, 12);
  return bytes;
}

interface FormatOptions {
  readonly formatTag?: number;
  readonly subformatTag?: number;
  readonly channels?: number;
  readonly sampleRate?: number;
  readonly bitsPerSample?: number;
  readonly validBitsPerSample?: number;
  readonly channelMask?: number;
  readonly blockAlign?: number;
  readonly byteRate?: number;
  readonly extensionBytes?: number;
  readonly declaredBytes?: number;
}

function formatBody(options: FormatOptions = {}): Uint8Array {
  const formatTag = options.formatTag ?? 0x0001;
  const channels = options.channels ?? 2;
  const sampleRate = options.sampleRate ?? 48_000;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const blockAlign = options.blockAlign ?? channels * (bitsPerSample / 8);
  const byteRate = options.byteRate ?? sampleRate * blockAlign;
  const extensible = formatTag === 0xfffe;
  const declaredBytes = options.declaredBytes ?? (extensible ? 40 : 16);
  const bytes = new Uint8Array(declaredBytes);
  const view = new DataView(bytes.buffer);
  if (declaredBytes >= 2) view.setUint16(0, formatTag, true);
  if (declaredBytes >= 4) view.setUint16(2, channels, true);
  if (declaredBytes >= 8) view.setUint32(4, sampleRate, true);
  if (declaredBytes >= 12) view.setUint32(8, byteRate, true);
  if (declaredBytes >= 14) view.setUint16(12, blockAlign, true);
  if (declaredBytes >= 16) view.setUint16(14, bitsPerSample, true);
  if (declaredBytes >= 18) {
    view.setUint16(16, options.extensionBytes ?? (extensible ? 22 : 0), true);
  }
  if (extensible && declaredBytes >= 40) {
    view.setUint16(18, options.validBitsPerSample ?? bitsPerSample, true);
    view.setUint32(20, options.channelMask ?? 0, true);
    const subformatTag = options.subformatTag ?? 0x0001;
    view.setUint16(24, subformatTag, true);
    bytes.set(PCM_GUID_SUFFIX, 26);
  }
  return bytes;
}

function riffWave(
  format: Uint8Array,
  dataBytes: number,
  options: {
    readonly beforeFormat?: readonly Uint8Array[];
    readonly between?: readonly Uint8Array[];
    readonly afterData?: readonly Uint8Array[];
  } = {},
): Uint8Array {
  return riffPayload(
    concatenate(
      ...(options.beforeFormat ?? []),
      chunk('fmt ', format),
      ...(options.between ?? []),
      chunk('data', new Uint8Array(dataBytes)),
      ...(options.afterData ?? []),
    ),
  );
}

function sourceFrom(bytes: Uint8Array): BlobEncodedAudioSource {
  return new BlobEncodedAudioSource(new Blob([Uint8Array.from(bytes)]), {
    metadata: { name: 'fixture.wav', mime: 'audio/wav' },
  });
}

async function parse(bytes: Uint8Array, signal = new AbortController().signal) {
  return readWavePcmMetadata(sourceFrom(bytes), signal);
}

interface SparseRegion {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

interface SparseRead {
  readonly offset: number;
  readonly length: number;
}

class SparseEncodedAudioSource implements EncodedAudioSource {
  readonly kind = 'peer-range' as const;
  readonly identity: string;
  readonly metadata: EncodedAudioSourceMetadata;
  readonly reads: SparseRead[] = [];
  #closed = false;

  constructor(
    readonly size: number,
    private readonly regions: readonly SparseRegion[],
    identity = 'sparse-wave-fixture',
  ) {
    validateExactRead(size, 0, 0);
    this.identity = identity;
    this.metadata = Object.freeze({ name: 'large.wav', mime: 'audio/wav' });
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    if (this.#closed) throw new EncodedSourceClosedError();
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push({ offset, length });
    if (length === 0) return new Uint8Array(0);
    const region = this.regions.find(
      (candidate) =>
        offset >= candidate.offset && end <= candidate.offset + candidate.bytes.byteLength,
    );
    if (!region) throw new Error(`Sparse fixture has no bytes for [${offset}, ${end})`);
    const start = offset - region.offset;
    return region.bytes.slice(start, start + length);
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

interface Sparse64Fixture {
  readonly source: SparseEncodedAudioSource;
  readonly dataOffset: number;
  readonly dataBytes: number;
  readonly totalFrames: number;
  readonly ds64Body: Uint8Array;
}

function sparse64Fixture(
  container: 'RF64' | 'BW64',
  options: {
    readonly thirdValue?: bigint;
    readonly riffSize?: bigint;
    readonly dataSize?: bigint;
    readonly tableLength?: number;
  } = {},
): Sparse64Fixture {
  const format = formatBody();
  const ds64Body = new Uint8Array(28);
  const dsView = new DataView(ds64Body.buffer);
  const dataOffset = 80;
  const dataBytes = 5 * GIB - dataOffset;
  const sourceSize = dataOffset + dataBytes;
  const totalFrames = dataBytes / 4;
  dsView.setBigUint64(0, options.riffSize ?? BigInt(sourceSize - 8), true);
  dsView.setBigUint64(8, options.dataSize ?? BigInt(dataBytes), true);
  dsView.setBigUint64(
    16,
    options.thirdValue ?? (container === 'RF64' ? BigInt(totalFrames) : 0xffff_ffff_ffff_ffffn),
    true,
  );
  dsView.setUint32(24, options.tableLength ?? 0, true);

  const top = new Uint8Array(12);
  writeAscii(top, 0, container);
  new DataView(top.buffer).setUint32(4, UINT32_PLACEHOLDER, true);
  writeAscii(top, 8, 'WAVE');

  const ds64 = concatenate(chunkHeader('ds64', ds64Body.byteLength), ds64Body);
  const formatChunk = concatenate(chunkHeader('fmt ', format.byteLength), format);
  const dataHeader = chunkHeader('data', UINT32_PLACEHOLDER);
  const source = new SparseEncodedAudioSource(
    sourceSize,
    [
      { offset: 0, bytes: top },
      { offset: 12, bytes: ds64 },
      { offset: 48, bytes: formatChunk },
      { offset: 72, bytes: dataHeader },
    ],
    `sparse-${container.toLowerCase()}`,
  );
  return { source, dataOffset, dataBytes, totalFrames, ds64Body };
}

describe('readWavePcmMetadata', () => {
  it.each<{
    readonly label: string;
    readonly format: FormatOptions;
    readonly frames: number;
    readonly encoding: WavePcmEncoding;
    readonly validBits?: number;
    readonly mask?: number;
  }>([
    {
      label: 'unsigned 8-bit mono',
      format: { channels: 1, sampleRate: 8_000, bitsPerSample: 8 },
      frames: 3,
      encoding: 'pcm-u8',
    },
    {
      label: 'signed 16-bit stereo',
      format: { channels: 2, sampleRate: 44_100, bitsPerSample: 16 },
      frames: 4,
      encoding: 'pcm-s16le',
    },
    {
      label: 'signed 24-bit six-channel',
      format: { channels: 6, sampleRate: 96_000, bitsPerSample: 24 },
      frames: 2,
      encoding: 'pcm-s24le',
    },
    {
      label: 'signed 32-bit eight-channel high-rate',
      format: { channels: 8, sampleRate: 352_800, bitsPerSample: 32 },
      frames: 2,
      encoding: 'pcm-s32le',
    },
    {
      label: 'IEEE float32',
      format: { formatTag: 0x0003, channels: 2, sampleRate: 384_000, bitsPerSample: 32 },
      frames: 2,
      encoding: 'float32le',
    },
    {
      label: 'IEEE float64',
      format: { formatTag: 0x0003, channels: 1, sampleRate: 768_000, bitsPerSample: 64 },
      frames: 2,
      encoding: 'float64le',
    },
    {
      label: 'extensible PCM 20-in-24 5.1',
      format: {
        formatTag: 0xfffe,
        subformatTag: 0x0001,
        channels: 6,
        sampleRate: 96_000,
        bitsPerSample: 24,
        validBitsPerSample: 20,
        channelMask: 0x3f,
      },
      frames: 2,
      encoding: 'pcm-s24le',
      validBits: 20,
      mask: 0x3f,
    },
    {
      label: 'extensible IEEE float32 7.1',
      format: {
        formatTag: 0xfffe,
        subformatTag: 0x0003,
        channels: 8,
        sampleRate: 192_000,
        bitsPerSample: 32,
        channelMask: 0x63f,
      },
      frames: 2,
      encoding: 'float32le',
      mask: 0x63f,
    },
  ])('parses $label without decoding payload bytes', async ({ format, frames, ...expected }) => {
    const body = formatBody(format);
    const blockAlign =
      format.blockAlign ?? (format.channels ?? 2) * ((format.bitsPerSample ?? 16) / 8);
    const metadata = await parse(riffWave(body, frames * blockAlign));

    expect(metadata).toMatchObject({
      format: 'wave',
      container: 'riff',
      encoding: expected.encoding,
      channels: format.channels ?? 2,
      sourceSampleRate: format.sampleRate ?? 48_000,
      blockAlign,
      validBitsPerSample: expected.validBits ?? format.bitsPerSample ?? 16,
      channelMask: expected.mask ?? 0,
      totalSourceFrames: frames,
      dataBytes: frames * blockAlign,
      rf64SampleCount: null,
    });
    expect(metadata.durationSeconds).toBe(frames / (format.sampleRate ?? 48_000));
  });

  it('skips unknown chunks and their odd padding while retaining exact offsets', async () => {
    const before = chunk('JUNK', Uint8Array.of(1, 2, 3));
    const between = chunk('bext', new Uint8Array(18));
    const after = chunk('LIST', Uint8Array.of(4));
    const bytes = riffWave(formatBody(), 8, {
      beforeFormat: [before],
      between: [between],
      afterData: [after],
    });

    const metadata = await parse(bytes);

    expect(metadata.dataOffset).toBe(12 + before.byteLength + 24 + between.byteLength + 8);
    expect(metadata.logicalFileBytes).toBe(bytes.byteLength);
  });

  it.each(['RF64', 'BW64'] as const)(
    'parses a sparse 5 GiB %s source without reading its PCM body',
    async (container) => {
      const fixture = sparse64Fixture(container);

      const metadata = await readWavePcmMetadata(fixture.source, new AbortController().signal);

      expect(metadata).toMatchObject({
        container: container.toLowerCase(),
        dataOffset: fixture.dataOffset,
        dataBytes: fixture.dataBytes,
        totalSourceFrames: fixture.totalFrames,
        logicalFileBytes: 5 * GIB,
      });
      expect(metadata.rf64SampleCount).toBe(container === 'RF64' ? fixture.totalFrames : null);
      expect(Math.max(...fixture.source.reads.map((read) => read.length))).toBeLessThanOrEqual(28);
      expect(
        fixture.source.reads.every((read) => read.offset + read.length <= fixture.dataOffset),
      ).toBe(true);
    },
  );

  it('treats the third BW64 ds64 uint64 as a dummy even above Number.MAX_SAFE_INTEGER', async () => {
    const fixture = sparse64Fixture('BW64', { thirdValue: 0xffff_ffff_ffff_ffffn });

    const metadata = await readWavePcmMetadata(fixture.source, new AbortController().signal);

    expect(metadata.container).toBe('bw64');
    expect(metadata.rf64SampleCount).toBeNull();
    expect(metadata.totalSourceFrames).toBe(fixture.totalFrames);
  });

  it('validates RF64 sampleCount against the PCM frame count', async () => {
    const fixture = sparse64Fixture('RF64', { thirdValue: 1n });

    await expect(readWavePcmMetadata(fixture.source, new AbortController().signal)).rejects.toThrow(
      'sampleCount contradicts',
    );
  });

  it.each([
    ['big-endian RIFX', 'RIFX', 'Big-endian RIFX'],
    ['Sony Wave64', 'riff', 'Sony Wave64'],
  ])('rejects %s with an explicit container error', async (_label, marker, message) => {
    const bytes = riffPayload(new Uint8Array(0), marker);

    const task = parse(bytes);

    await expect(task).rejects.toBeInstanceOf(UnsupportedWaveContainerError);
    await expect(task).rejects.toThrow(message);
  });

  it('rejects compressed WAVE tags and unknown extensible GUIDs explicitly', async () => {
    await expect(parse(riffWave(formatBody({ formatTag: 0x0002 }), 8))).rejects.toBeInstanceOf(
      UnsupportedWaveCodecError,
    );

    const unknown = formatBody({ formatTag: 0xfffe, subformatTag: 0x1234 });
    await expect(parse(riffWave(unknown, 8))).rejects.toBeInstanceOf(UnsupportedWaveCodecError);
  });

  it.each<readonly [string, Uint8Array, string]>([
    [
      'wrong RIFF form type',
      riffPayload(
        concatenate(chunk('fmt ', formatBody()), chunk('data', new Uint8Array(8))),
        'RIFF',
        'AVI ',
      ),
      'does not declare WAVE',
    ],
    ['missing fmt', riffPayload(chunk('data', new Uint8Array(8))), 'fmt chunk is missing'],
    ['missing data', riffPayload(chunk('fmt ', formatBody())), 'data chunk is missing'],
    [
      'duplicate fmt',
      riffPayload(
        concatenate(
          chunk('fmt ', formatBody()),
          chunk('fmt ', formatBody()),
          chunk('data', new Uint8Array(8)),
        ),
      ),
      'duplicate fmt',
    ],
    [
      'duplicate data',
      riffPayload(
        concatenate(
          chunk('fmt ', formatBody()),
          chunk('data', new Uint8Array(8)),
          chunk('data', new Uint8Array(8)),
        ),
      ),
      'multiple data',
    ],
    ['empty data', riffWave(formatBody(), 0), 'data chunk is empty'],
    [
      'partial final chunk header',
      riffPayload(concatenate(chunk('fmt ', formatBody()), new Uint8Array(4))),
      'inside a chunk header',
    ],
    [
      'overflowing chunk',
      riffPayload(concatenate(chunk('fmt ', formatBody()), chunkHeader('data', 100))),
      'exceeds the declared container',
    ],
    [
      'missing odd-byte padding',
      riffPayload(
        concatenate(
          chunk('fmt ', formatBody({ channels: 1, bitsPerSample: 8 })),
          chunkHeader('data', 1),
          Uint8Array.of(128),
        ),
      ),
      'exceeds the declared container',
    ],
    ['partial sample frame', riffWave(formatBody(), 3), 'whole number of sample frames'],
    [
      'bad blockAlign',
      riffWave(formatBody({ blockAlign: 5, byteRate: 240_000 }), 10),
      'blockAlign contradicts',
    ],
    ['bad byteRate', riffWave(formatBody({ byteRate: 1 }), 8), 'byteRate contradicts'],
    [
      'zero channels',
      riffWave(formatBody({ channels: 0, blockAlign: 0, byteRate: 0 }), 8),
      'channel count',
    ],
    ['nine channels', riffWave(formatBody({ channels: 9 }), 36), 'channel count'],
    ['zero sample rate', riffWave(formatBody({ sampleRate: 0, byteRate: 0 }), 8), 'sample rate'],
    ['oversized sample rate', riffWave(formatBody({ sampleRate: 1_000_001 }), 8), 'sample rate'],
    [
      'invalid extensible valid bits',
      riffWave(formatBody({ formatTag: 0xfffe, bitsPerSample: 24, validBitsPerSample: 25 }), 12),
      'valid bits',
    ],
    [
      'invalid float valid bits',
      riffWave(
        formatBody({
          formatTag: 0xfffe,
          subformatTag: 0x0003,
          bitsPerSample: 32,
          validBitsPerSample: 24,
        }),
        16,
      ),
      'float valid bits',
    ],
    [
      'channel-mask mismatch',
      riffWave(formatBody({ formatTag: 0xfffe, channels: 6, channelMask: 0x03 }), 24),
      'channel mask population',
    ],
    [
      'truncated extensible fmt',
      riffWave(formatBody({ formatTag: 0xfffe, declaredBytes: 18 }), 8),
      'shorter than 40',
    ],
    [
      'invalid extensible cbSize',
      riffWave(formatBody({ formatTag: 0xfffe, extensionBytes: 21 }), 8),
      'invalid cbSize',
    ],
  ])('rejects malformed $0', async (_label, bytes, message) => {
    await expect(parse(bytes)).rejects.toThrow(message);
  });

  it('rejects RIFF logical-size mismatch and an unsafe RF64 uint64', async () => {
    const regular = riffWave(formatBody(), 8);
    new DataView(regular.buffer).setUint32(4, regular.byteLength - 9, true);
    await expect(parse(regular)).rejects.toThrow('logical size does not exactly match');

    const unsafe = sparse64Fixture('RF64', { riffSize: 0xffff_ffff_ffff_ffffn });
    await expect(readWavePcmMetadata(unsafe.source, new AbortController().signal)).rejects.toThrow(
      'safe-integer range',
    );
  });

  it('requires ds64 to be first and validates its table length', async () => {
    const missing = new Uint8Array(12 + 8);
    writeAscii(missing, 0, 'RF64');
    new DataView(missing.buffer).setUint32(4, UINT32_PLACEHOLDER, true);
    writeAscii(missing, 8, 'WAVE');
    missing.set(chunkHeader('fmt ', 16), 12);
    const missingSource = new SparseEncodedAudioSource(missing.byteLength, [
      { offset: 0, bytes: missing },
    ]);
    await expect(readWavePcmMetadata(missingSource, new AbortController().signal)).rejects.toThrow(
      'ds64 must be the first',
    );

    const contradictory = sparse64Fixture('RF64', { tableLength: 1 });
    await expect(
      readWavePcmMetadata(contradictory.source, new AbortController().signal),
    ).rejects.toThrow('table length');
  });

  it('caps hostile chunk-count amplification', async () => {
    const chunks = Array.from({ length: WAVE_MAX_CHUNKS }, () => chunk('JUNK', new Uint8Array(0)));
    const bytes = riffPayload(
      concatenate(...chunks, chunk('fmt ', formatBody()), chunk('data', new Uint8Array(8))),
    );

    await expect(parse(bytes)).rejects.toThrow('too many chunks');
  });

  it('checks cancellation before and after every exact read', async () => {
    const bytes = riffWave(formatBody(), 8);
    const base = sourceFrom(bytes);
    const controller = new AbortController();
    const reason = new Error('fixture superseded');
    let reads = 0;
    const source: EncodedAudioSource = {
      kind: base.kind,
      size: base.size,
      identity: base.identity,
      metadata: base.metadata,
      async readAt(offset, length, signal) {
        const result = await base.readAt(offset, length, signal);
        reads += 1;
        if (reads === 1) controller.abort(reason);
        return result;
      },
      close: () => base.close(),
    };

    await expect(readWavePcmMetadata(source, controller.signal)).rejects.toBe(reason);
    expect(reads).toBe(1);
  });

  it('rejects a short response even when a custom source violates the exact-read contract', async () => {
    const bytes = riffWave(formatBody(), 8);
    const source: EncodedAudioSource = {
      kind: 'peer-range',
      size: bytes.byteLength,
      identity: 'short-read-fixture',
      metadata: { name: 'short.wav', mime: 'audio/wav' },
      async readAt(offset, length, signal) {
        validateExactRead(bytes.byteLength, offset, length);
        throwIfAborted(signal);
        return bytes.slice(offset, offset + Math.max(0, length - 1));
      },
      async close() {},
    };

    await expect(readWavePcmMetadata(source, new AbortController().signal)).rejects.toThrow(
      'expected 12',
    );
  });
});
