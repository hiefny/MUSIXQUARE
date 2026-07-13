import { describe, expect, it } from 'vitest';

import type { LinearPcmEncoding } from '../../linear-pcm/sample-format.ts';
import { BlobEncodedAudioSource } from '../../sources/blob-encoded-audio-source.ts';
import {
  EncodedSourceClosedError,
  type EncodedAudioSource,
  type EncodedAudioSourceMetadata,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import {
  CAF_MAX_CHUNKS,
  CAF_MAX_METADATA_READ_BYTES,
  UnsupportedCafCodecError,
  UnsupportedCafPacketTableError,
  UnsupportedCafSampleRateError,
  readCafLinearPcmMetadata,
  type CafLinearPcmEncoding,
} from '../metadata.ts';

const GIB = 1_024 * 1_024 * 1_024;
const CAF_FIXED_PREFIX_BYTES = 52;

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

function fileHeader(version = 1, flags = 0, marker = 'caff'): Uint8Array {
  const bytes = new Uint8Array(8);
  writeAscii(bytes, 0, marker);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, version, false);
  view.setUint16(6, flags, false);
  return bytes;
}

function chunkHeader(chunkId: string, size: bigint | number): Uint8Array {
  const bytes = new Uint8Array(12);
  writeAscii(bytes, 0, chunkId);
  new DataView(bytes.buffer).setBigInt64(4, BigInt(size), false);
  return bytes;
}

function chunk(
  chunkId: string,
  body: Uint8Array,
  declaredSize: bigint | number = body.byteLength,
): Uint8Array {
  return concatenate(chunkHeader(chunkId, declaredSize), body);
}

interface DescriptionOptions {
  readonly sampleRate?: number;
  readonly formatId?: string;
  readonly formatFlags?: number;
  readonly bytesPerPacket?: number;
  readonly framesPerPacket?: number;
  readonly channels?: number;
  readonly validBitsPerSample?: number;
  readonly containerBytesPerSample?: number;
}

function descriptionBody(options: DescriptionOptions = {}): Uint8Array {
  const channels = options.channels ?? 2;
  const validBitsPerSample = options.validBitsPerSample ?? 16;
  const containerBytesPerSample =
    options.containerBytesPerSample ?? Math.ceil(validBitsPerSample / 8);
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setFloat64(0, options.sampleRate ?? 48_000, false);
  writeAscii(bytes, 8, options.formatId ?? 'lpcm');
  view.setUint32(12, options.formatFlags ?? 0, false);
  view.setUint32(16, options.bytesPerPacket ?? channels * containerBytesPerSample, false);
  view.setUint32(20, options.framesPerPacket ?? 1, false);
  view.setUint32(24, channels, false);
  view.setUint32(28, validBitsPerSample, false);
  return bytes;
}

function dataChunk(audioBytes: number, bytes?: Uint8Array, editCount = 0): Uint8Array {
  const body = new Uint8Array(4 + audioBytes);
  new DataView(body.buffer).setUint32(0, editCount, false);
  if (bytes) body.set(bytes.subarray(0, audioBytes), 4);
  return chunk('data', body);
}

function cafFile(
  description: Uint8Array,
  chunks: readonly Uint8Array[],
  options: { readonly version?: number; readonly flags?: number; readonly marker?: string } = {},
): Uint8Array {
  return concatenate(
    fileHeader(options.version, options.flags, options.marker),
    chunk('desc', description),
    ...chunks,
  );
}

function sourceFrom(bytes: Uint8Array): BlobEncodedAudioSource {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new BlobEncodedAudioSource(new Blob([buffer]), {
    metadata: { name: 'fixture.caf', mime: 'audio/x-caf' },
  });
}

async function parse(bytes: Uint8Array, signal = new AbortController().signal) {
  return readCafLinearPcmMetadata(sourceFrom(bytes), signal);
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
    identity = 'sparse-caf-fixture',
  ) {
    validateExactRead(size, 0, 0);
    this.identity = identity;
    this.metadata = Object.freeze({ name: 'large.caf', mime: 'audio/x-caf' });
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    if (this.#closed) throw new EncodedSourceClosedError();
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push({ offset, length });
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

interface SparseCafFixture {
  readonly source: SparseEncodedAudioSource;
  readonly dataOffset: number;
  readonly dataBytes: number;
  readonly trailingChunkOffset: number | null;
}

function sparseFiveGibFixture(sizeUnknown: boolean): SparseCafFixture {
  const sourceSize = 5 * GIB;
  const description = descriptionBody();
  const fixedPrefix = concatenate(fileHeader(), chunk('desc', description));
  expect(fixedPrefix.byteLength).toBe(CAF_FIXED_PREFIX_BYTES);

  const dataHeaderOffset = fixedPrefix.byteLength;
  const dataBodyOffset = dataHeaderOffset + 12;
  const dataOffset = dataBodyOffset + 4;
  const trailingChunkOffset = sizeUnknown ? null : sourceSize - 12;
  const dataBytes = (trailingChunkOffset ?? sourceSize) - dataOffset;
  const declaredBodyBytes = sizeUnknown ? -1n : BigInt(dataBytes + 4);
  const dataHeader = chunkHeader('data', declaredBodyBytes);
  const editCount = new Uint8Array(4);

  const regions: SparseRegion[] = [
    { offset: 0, bytes: fixedPrefix },
    { offset: dataHeaderOffset, bytes: dataHeader },
    { offset: dataBodyOffset, bytes: editCount },
  ];
  if (trailingChunkOffset !== null) {
    regions.push({ offset: trailingChunkOffset, bytes: chunkHeader('free', 0) });
  }
  return {
    source: new SparseEncodedAudioSource(
      sourceSize,
      regions,
      `sparse-caf-${sizeUnknown ? 'unknown' : 'known'}`,
    ),
    dataOffset,
    dataBytes,
    trailingChunkOffset,
  };
}

describe('readCafLinearPcmMetadata', () => {
  it.each<{
    readonly label: string;
    readonly description: DescriptionOptions;
    readonly encoding: CafLinearPcmEncoding;
    readonly containerBits: 8 | 16 | 24 | 32 | 64;
    readonly validBits: number;
  }>([
    {
      label: 'signed 8-bit mono',
      description: { channels: 1, validBitsPerSample: 8, containerBytesPerSample: 1 },
      encoding: 'pcm-s8',
      containerBits: 8,
      validBits: 8,
    },
    {
      label: 'high-aligned 12-in-16 big-endian',
      description: { validBitsPerSample: 12, containerBytesPerSample: 2 },
      encoding: 'pcm-s16be',
      containerBits: 16,
      validBits: 12,
    },
    {
      label: 'high-aligned 12-in-16 little-endian',
      description: { formatFlags: 2, validBitsPerSample: 12, containerBytesPerSample: 2 },
      encoding: 'pcm-s16le',
      containerBits: 16,
      validBits: 12,
    },
    {
      label: 'packed 24-bit big-endian',
      description: { validBitsPerSample: 24, containerBytesPerSample: 3 },
      encoding: 'pcm-s24be',
      containerBits: 24,
      validBits: 24,
    },
    {
      label: 'packed 24-bit little-endian',
      description: { formatFlags: 2, validBitsPerSample: 24, containerBytesPerSample: 3 },
      encoding: 'pcm-s24le',
      containerBits: 24,
      validBits: 24,
    },
    {
      label: 'high-aligned 24-in-32 big-endian',
      description: { validBitsPerSample: 24, containerBytesPerSample: 4 },
      encoding: 'pcm-s32be',
      containerBits: 32,
      validBits: 24,
    },
    {
      label: 'high-aligned 24-in-32 little-endian',
      description: { formatFlags: 2, validBitsPerSample: 24, containerBytesPerSample: 4 },
      encoding: 'pcm-s32le',
      containerBits: 32,
      validBits: 24,
    },
    {
      label: 'float32 big-endian',
      description: { formatFlags: 1, validBitsPerSample: 32, containerBytesPerSample: 4 },
      encoding: 'float32be',
      containerBits: 32,
      validBits: 32,
    },
    {
      label: 'float32 little-endian',
      description: { formatFlags: 3, validBitsPerSample: 32, containerBytesPerSample: 4 },
      encoding: 'float32le',
      containerBits: 32,
      validBits: 32,
    },
    {
      label: 'float64 big-endian',
      description: { formatFlags: 1, validBitsPerSample: 64, containerBytesPerSample: 8 },
      encoding: 'float64be',
      containerBits: 64,
      validBits: 64,
    },
    {
      label: 'float64 little-endian eight-channel',
      description: {
        formatFlags: 3,
        channels: 8,
        validBitsPerSample: 64,
        containerBytesPerSample: 8,
      },
      encoding: 'float64le',
      containerBits: 64,
      validBits: 64,
    },
  ])(
    'normalizes $label from the desc packet layout',
    async ({ description, encoding, containerBits, validBits }) => {
      const channels = description.channels ?? 2;
      const bytesPerPacket =
        description.bytesPerPacket ?? channels * (description.containerBytesPerSample ?? 2);
      const frames = 3;
      const metadata = await parse(
        cafFile(descriptionBody(description), [dataChunk(frames * bytesPerPacket, undefined, 7)]),
      );

      expect(metadata).toMatchObject({
        format: 'caf',
        encoding,
        sourceSampleRate: description.sampleRate ?? 48_000,
        channels,
        containerBitsPerSample: containerBits,
        validBitsPerSample: validBits,
        blockAlign: bytesPerPacket,
        bytesPerPacket,
        framesPerPacket: 1,
        formatFlags: description.formatFlags ?? 0,
        editCount: 7,
        dataBytes: frames * bytesPerPacket,
        totalSourceFrames: frames,
        dataChunkSizeUnknown: false,
      });
      expect(metadata.durationSeconds).toBe(frames / (description.sampleRate ?? 48_000));
      expect(metadata.logicalFileBytes).toBe(
        CAF_FIXED_PREFIX_BYTES + 12 + 4 + frames * bytesPerPacket,
      );
      expect(metadata.dataOffset).toBe(CAF_FIXED_PREFIX_BYTES + 12 + 4);
    },
  );

  it('allows known-size data before unknown chunks and never treats chunk padding as implicit', async () => {
    const bytes = cafFile(descriptionBody(), [
      chunk('free', Uint8Array.of(1, 2, 3)),
      dataChunk(8),
      chunk('info', Uint8Array.of(4, 5, 6, 7, 8)),
      chunk('tail', new Uint8Array(0)),
    ]);

    const metadata = await parse(bytes);

    expect(metadata.dataOffset).toBe(CAF_FIXED_PREFIX_BYTES + 15 + 12 + 4);
    expect(metadata.dataBytes).toBe(8);
    expect(metadata.logicalFileBytes).toBe(bytes.byteLength);
  });

  it.each([false, true])(
    'parses a sparse exact 5 GiB source with a %s data size without reading audio bytes',
    async (sizeUnknown) => {
      const fixture = sparseFiveGibFixture(sizeUnknown);

      const metadata = await readCafLinearPcmMetadata(fixture.source, new AbortController().signal);

      expect(metadata).toMatchObject({
        dataOffset: fixture.dataOffset,
        dataBytes: fixture.dataBytes,
        totalSourceFrames: fixture.dataBytes / 4,
        logicalFileBytes: 5 * GIB,
        dataChunkSizeUnknown: sizeUnknown,
      });
      expect(Math.max(...fixture.source.reads.map((read) => read.length))).toBeLessThanOrEqual(
        CAF_MAX_METADATA_READ_BYTES,
      );
      expect(
        fixture.source.reads.every((read) => {
          const end = read.offset + read.length;
          return (
            end <= fixture.dataOffset ||
            (fixture.trailingChunkOffset !== null && read.offset >= fixture.trailingChunkOffset)
          );
        }),
      ).toBe(true);
    },
  );

  it('rejects a packet table with a dedicated unsupported-capability error', async () => {
    const task = parse(
      cafFile(descriptionBody(), [chunk('pakt', new Uint8Array(24)), dataChunk(8)]),
    );

    await expect(task).rejects.toBeInstanceOf(UnsupportedCafPacketTableError);
    await expect(task).rejects.toThrow('packet tables');
  });

  it('rejects compressed CAF with a dedicated unsupported-codec error', async () => {
    const task = parse(cafFile(descriptionBody({ formatId: 'aac ' }), [dataChunk(8)]));

    await expect(task).rejects.toBeInstanceOf(UnsupportedCafCodecError);
    await expect(task).rejects.toThrow('requires LPCM');
  });

  it('ignores unknown CAF v1 file flags for forward-compatible reading', async () => {
    const bytes = cafFile(descriptionBody(), [dataChunk(8)], { flags: 0xffff });

    await expect(parse(bytes)).resolves.toMatchObject({ dataBytes: 8 });
  });

  it.each<readonly [string, Uint8Array, string]>([
    [
      'wrong file marker',
      cafFile(descriptionBody(), [dataChunk(8)], { marker: 'nope' }),
      'caff marker',
    ],
    [
      'unsupported file version',
      cafFile(descriptionBody(), [dataChunk(8)], { version: 2 }),
      'version 1',
    ],
    [
      'first chunk is not desc',
      concatenate(fileHeader(), chunk('free', new Uint8Array(32)), dataChunk(8)),
      'desc must be the first',
    ],
    [
      'short desc declaration',
      concatenate(fileHeader(), chunk('desc', descriptionBody(), 31), dataChunk(8)),
      'exactly 32',
    ],
    [
      'long desc declaration',
      concatenate(fileHeader(), chunk('desc', descriptionBody(), 33), dataChunk(8)),
      'exactly 32',
    ],
    [
      'duplicate desc',
      cafFile(descriptionBody(), [chunk('desc', descriptionBody()), dataChunk(8)]),
      'duplicate desc',
    ],
    ['missing data', cafFile(descriptionBody(), []), 'data chunk is missing'],
    ['duplicate data', cafFile(descriptionBody(), [dataChunk(8), dataChunk(8)]), 'multiple data'],
    [
      'data without edit count',
      cafFile(descriptionBody(), [chunk('data', new Uint8Array(3))]),
      'edit count',
    ],
    [
      'empty data',
      cafFile(descriptionBody(), [chunk('data', new Uint8Array(4))]),
      'data chunk is empty',
    ],
    ['partial packet', cafFile(descriptionBody(), [dataChunk(3)]), 'whole number'],
    [
      'trailing partial chunk header',
      cafFile(descriptionBody(), [dataChunk(8), new Uint8Array(11)]),
      'inside a chunk header',
    ],
    [
      'chunk beyond exact source',
      cafFile(descriptionBody(), [concatenate(chunkHeader('free', 100), new Uint8Array(4))]),
      'exceeds the encoded source',
    ],
    [
      'negative ordinary chunk',
      cafFile(descriptionBody(), [chunkHeader('free', -1n)]),
      'Only a CAF data chunk',
    ],
    [
      'negative data size other than -1',
      cafFile(descriptionBody(), [chunkHeader('data', -2n)]),
      'invalid negative size',
    ],
    [
      'unsafe signed chunk size',
      cafFile(descriptionBody(), [chunkHeader('free', BigInt(Number.MAX_SAFE_INTEGER) + 1n)]),
      'safe-integer range',
    ],
  ])('rejects malformed $0', async (_label, bytes, message) => {
    await expect(parse(bytes)).rejects.toThrow(message);
  });

  it.each<readonly [string, DescriptionOptions, string]>([
    ['NaN sample rate', { sampleRate: Number.NaN }, 'sample rate'],
    ['infinite sample rate', { sampleRate: Number.POSITIVE_INFINITY }, 'sample rate'],
    ['zero sample rate', { sampleRate: 0 }, 'sample rate'],
    ['reserved LPCM flag', { formatFlags: 4 }, 'reserved format flags'],
    ['zero frames per packet', { framesPerPacket: 0 }, 'one frame per packet'],
    ['two frames per packet', { framesPerPacket: 2 }, 'one frame per packet'],
    ['zero channels', { channels: 0, bytesPerPacket: 4 }, 'channel count'],
    ['nine channels', { channels: 9 }, 'channel count'],
    ['zero bytes per packet', { bytesPerPacket: 0 }, 'bytesPerPacket'],
    ['fractional channel container', { channels: 3, bytesPerPacket: 8 }, 'bytesPerPacket'],
    ['zero integer bits', { validBitsPerSample: 0, containerBytesPerSample: 1 }, '1 through 32'],
    ['33 integer bits', { validBitsPerSample: 33, containerBytesPerSample: 4 }, '1 through 32'],
    [
      'integer bits exceed container',
      { validBitsPerSample: 17, containerBytesPerSample: 2 },
      'exceed',
    ],
    [
      'five-byte integer container',
      { validBitsPerSample: 32, containerBytesPerSample: 5 },
      '1 through 4',
    ],
    [
      'float16',
      { formatFlags: 1, validBitsPerSample: 16, containerBytesPerSample: 2 },
      'exact 32-bit or 64-bit',
    ],
    [
      'float32 in 64-bit container',
      { formatFlags: 1, validBitsPerSample: 32, containerBytesPerSample: 8 },
      'exact 32-bit or 64-bit',
    ],
    [
      'float64 in 32-bit container',
      { formatFlags: 1, validBitsPerSample: 64, containerBytesPerSample: 4 },
      'exact 32-bit or 64-bit',
    ],
  ])('rejects malformed LPCM description: %s', async (_label, options, message) => {
    await expect(parse(cafFile(descriptionBody(options), [dataChunk(8)]))).rejects.toThrow(message);
  });

  it.each([
    ['fractional sample rate', 44_100.5],
    ['sample rate above the bounded PCM maximum', 1_000_001],
  ] as const)('classifies %s as an unsupported bounded-engine capability', async (_label, rate) => {
    const task = parse(cafFile(descriptionBody({ sampleRate: rate }), [dataChunk(8)]));

    await expect(task).rejects.toBeInstanceOf(UnsupportedCafSampleRateError);
    await expect(task).rejects.toThrow('bounded PCM capability');
  });

  it('caps hostile chunk-count amplification at 1,024 total chunks including desc', async () => {
    const maximumChunks = Array.from({ length: CAF_MAX_CHUNKS - 2 }, () =>
      chunk('free', new Uint8Array(0)),
    );
    const accepted = cafFile(descriptionBody(), [...maximumChunks, dataChunk(8)]);
    await expect(parse(accepted)).resolves.toMatchObject({ dataBytes: 8 });

    const tooMany = cafFile(descriptionBody(), [
      ...maximumChunks,
      chunk('free', new Uint8Array(0)),
      dataChunk(8),
    ]);
    await expect(parse(tooMany)).rejects.toThrow('too many chunks');
  });

  it('checks cancellation before the first read and after every exact read', async () => {
    const bytes = cafFile(descriptionBody(), [dataChunk(8)]);
    const base = sourceFrom(bytes);
    const before = new AbortController();
    const beforeReason = new Error('cancelled before CAF parse');
    before.abort(beforeReason);
    let beforeReads = 0;
    const unreadSource: EncodedAudioSource = {
      kind: base.kind,
      size: base.size,
      identity: `${base.identity}:unread`,
      metadata: base.metadata,
      async readAt(offset, length, signal) {
        beforeReads += 1;
        return base.readAt(offset, length, signal);
      },
      close: () => base.close(),
    };
    await expect(readCafLinearPcmMetadata(unreadSource, before.signal)).rejects.toBe(beforeReason);
    expect(beforeReads).toBe(0);

    const afterBase = sourceFrom(bytes);
    const after = new AbortController();
    const afterReason = new Error('cancelled after CAF read');
    let afterReads = 0;
    const abortingSource: EncodedAudioSource = {
      kind: afterBase.kind,
      size: afterBase.size,
      identity: `${afterBase.identity}:aborting`,
      metadata: afterBase.metadata,
      async readAt(offset, length, signal) {
        const result = await afterBase.readAt(offset, length, signal);
        afterReads += 1;
        if (afterReads === 1) after.abort(afterReason);
        return result;
      },
      close: () => afterBase.close(),
    };
    await expect(readCafLinearPcmMetadata(abortingSource, after.signal)).rejects.toBe(afterReason);
    expect(afterReads).toBe(1);
  });

  it('rejects a short custom-source response even when it violates the exact-read contract', async () => {
    const bytes = cafFile(descriptionBody(), [dataChunk(8)]);
    const source: EncodedAudioSource = {
      kind: 'peer-range',
      size: bytes.byteLength,
      identity: 'short-caf-fixture',
      metadata: { name: 'short.caf', mime: 'audio/x-caf' },
      async readAt(offset, length, signal) {
        validateExactRead(bytes.byteLength, offset, length);
        throwIfAborted(signal);
        return bytes.slice(offset, offset + Math.max(0, length - 1));
      },
      async close() {},
    };

    await expect(readCafLinearPcmMetadata(source, new AbortController().signal)).rejects.toThrow(
      'expected 8',
    );
  });

  it('keeps every normalized CAF encoding inside the shared linear-PCM vocabulary', () => {
    const encodings = [
      'pcm-s8',
      'pcm-s16le',
      'pcm-s16be',
      'pcm-s24le',
      'pcm-s24be',
      'pcm-s32le',
      'pcm-s32be',
      'float32le',
      'float32be',
      'float64le',
      'float64be',
    ] as const satisfies readonly LinearPcmEncoding[];

    expect(encodings).toHaveLength(11);
  });
});
