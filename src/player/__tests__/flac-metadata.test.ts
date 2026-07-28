import { describe, expect, it } from 'vitest';

import { readFlacMetadata } from '../flac/metadata.ts';
import { FlacSeekIndex } from '../flac/seek-index.ts';
import { BlobEncodedAudioSource } from '../sources/blob-encoded-audio-source.ts';
import {
  throwIfAborted,
  validateExactRead,
  type EncodedAudioSource,
  type EncodedAudioSourceMetadata,
} from '../sources/encoded-audio-source.ts';

interface SparseRegion {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

class SparseEncodedAudioSource implements EncodedAudioSource {
  readonly kind = 'peer-range' as const;
  readonly identity = 'sparse-large-flac';
  readonly metadata: EncodedAudioSourceMetadata = Object.freeze({
    name: 'seven-days.flac',
    mime: 'audio/flac',
  });
  readonly reads: { readonly offset: number; readonly length: number }[] = [];

  constructor(
    readonly size: number,
    private readonly regions: readonly SparseRegion[],
  ) {
    validateExactRead(size, 0, 0);
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push({ offset, length });
    const region = this.regions.find(
      (candidate) =>
        offset >= candidate.offset && end <= candidate.offset + candidate.bytes.byteLength,
    );
    if (!region) throw new Error(`Sparse FLAC fixture has no bytes for [${offset}, ${end})`);
    const start = offset - region.offset;
    return region.bytes.slice(start, start + length);
  }

  async close(): Promise<void> {}
}

const MAX_SOURCE_READ_BYTES = 64 * 1024;
const SEEKPOINT_BYTES = 18;
const SEEKTABLE_PAGE_POINTS = Math.floor(MAX_SOURCE_READ_BYTES / SEEKPOINT_BYTES);

function uint64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function streamInfo(options?: {
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
  totalSamples?: number;
}): Uint8Array {
  const sampleRate = options?.sampleRate ?? 352_800;
  const channels = options?.channels ?? 2;
  const bitDepth = options?.bitDepth ?? 24;
  const totalSamples = options?.totalSamples ?? 195_000_000;
  const bytes = new Uint8Array(34);
  bytes[0] = 0x10;
  bytes[1] = 0x00;
  bytes[2] = 0x10;
  bytes[3] = 0x00;
  bytes[4] = 0x00;
  bytes[5] = 0x00;
  bytes[6] = 0x12;
  bytes[7] = 0x00;
  bytes[8] = 0x80;
  bytes[9] = 0x00;

  const packed =
    (BigInt(sampleRate) << 44n) |
    (BigInt(channels - 1) << 41n) |
    (BigInt(bitDepth - 1) << 36n) |
    BigInt(totalSamples);
  bytes.set(uint64(packed), 10);
  for (let index = 18; index < 34; index += 1) bytes[index] = index;
  return bytes;
}

function block(type: number, body: Uint8Array, last = false): Uint8Array {
  const header = new Uint8Array(4);
  header[0] = type | (last ? 0x80 : 0);
  header[1] = (body.byteLength >>> 16) & 0xff;
  header[2] = (body.byteLength >>> 8) & 0xff;
  header[3] = body.byteLength & 0xff;
  return new Uint8Array([...header, ...body]);
}

function seekPoint(sample: bigint, offset: bigint, frameSamples = 4096): Uint8Array {
  return new Uint8Array([
    ...uint64(sample),
    ...uint64(offset),
    (frameSamples >>> 8) & 0xff,
    frameSamples & 0xff,
  ]);
}

function seekTable(
  count: number,
  createPoint: (index: number) => Uint8Array = (index) =>
    seekPoint(BigInt(index) * 4096n, BigInt(index)),
): Uint8Array {
  const bytes = new Uint8Array(count * SEEKPOINT_BYTES);
  for (let index = 0; index < count; index += 1) {
    bytes.set(createPoint(index), index * SEEKPOINT_BYTES);
  }
  return bytes;
}

function blobBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

function flacWithAudio(audioBytes: number, ...blocks: Uint8Array[]): BlobEncodedAudioSource {
  return new BlobEncodedAudioSource(
    new Blob([
      new Uint8Array([0x66, 0x4c, 0x61, 0x43]),
      ...blocks.map(blobBytes),
      new Uint8Array(audioBytes).fill(0xff),
    ]),
  );
}

function flac(...blocks: Uint8Array[]): BlobEncodedAudioSource {
  return flacWithAudio(128, ...blocks);
}

class ReadCappedEncodedAudioSource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly size: number;
  readonly identity: string;
  readonly metadata: EncodedAudioSourceMetadata;
  readonly readLengths: number[] = [];

  constructor(private readonly source: BlobEncodedAudioSource) {
    this.size = source.size;
    this.identity = source.identity;
    this.metadata = source.metadata;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    this.readLengths.push(length);
    if (length > MAX_SOURCE_READ_BYTES) {
      throw new Error(`fixture rejected ${length}-byte read`);
    }
    return this.source.readAt(offset, length, signal);
  }

  close(): Promise<void> {
    return this.source.close();
  }
}

describe('readFlacMetadata', () => {
  it('parses high-rate multichannel STREAMINFO exactly', async () => {
    const source = flac(block(0, streamInfo({ channels: 8, bitDepth: 24 }), true));
    const metadata = await readFlacMetadata(source, new AbortController().signal);

    expect(metadata.streamInfo).toMatchObject({
      sampleRate: 352_800,
      channels: 8,
      bitDepth: 24,
      totalSamples: 195_000_000,
      minBlockSize: 4096,
      maxBlockSize: 4096,
      minFrameSize: 18,
      maxFrameSize: 32_768,
    });
    expect(metadata.streamInfo.duration).toBeCloseTo(552.721, 3);
    expect(metadata.firstAudioFrameOffset).toBe(42);
    expect(metadata.streamInfo.md5).toBe('12131415161718191a1b1c1d1e1f2021');
  });

  it('parses ordered seek points and ignores placeholders', async () => {
    const table = new Uint8Array([
      ...seekPoint(0n, 0n),
      ...seekPoint(1_000_000n, 64n),
      // Placeholder offset and frame size are undefined and must be ignored.
      ...seekPoint(0xffff_ffff_ffff_ffffn, 0xffff_ffff_ffff_ffffn, 0),
    ]);
    const metadata = await readFlacMetadata(
      flac(block(0, streamInfo()), block(3, table, true)),
      new AbortController().signal,
    );

    expect(metadata.seekPoints).toEqual([
      { sample: 0, streamOffset: 0, frameSamples: 4096 },
      { sample: 1_000_000, streamOffset: 64, frameSamples: 4096 },
    ]);
  });

  it('pages a large SEEKTABLE below the source ceiling and retains bounded endpoint anchors', async () => {
    const pointCount = 9_000;
    const table = seekTable(pointCount + 1, (index) =>
      index === pointCount
        ? seekPoint(0xffff_ffff_ffff_ffffn, 0xffff_ffff_ffff_ffffn, 0)
        : seekPoint(BigInt(index) * 4096n, BigInt(index)),
    );
    const source = new ReadCappedEncodedAudioSource(
      flacWithAudio(pointCount + 32, block(0, streamInfo()), block(3, table, true)),
    );
    const metadata = await readFlacMetadata(source, new AbortController().signal);
    const repeated = await readFlacMetadata(source, new AbortController().signal);

    expect(Math.max(...source.readLengths)).toBe(SEEKTABLE_PAGE_POINTS * SEEKPOINT_BYTES);
    expect(metadata.seekPoints.length).toBeLessThanOrEqual(8_192);
    expect(metadata.seekPoints[0]).toEqual({ sample: 0, streamOffset: 0, frameSamples: 4096 });
    expect(metadata.seekPoints.at(-1)).toEqual({
      sample: (pointCount - 1) * 4096,
      streamOffset: pointCount - 1,
      frameSamples: 4096,
    });
    expect(
      metadata.seekPoints.every(
        (point, index) => index === 0 || point.sample > metadata.seekPoints[index - 1]!.sample,
      ),
    ).toBe(true);
    expect(repeated.seekPoints).toEqual(metadata.seekPoints);
  });

  it('indexes a seven-day sparse 5 GiB source without reading audio or retaining its span', async () => {
    const gib = 1_024 * 1_024 * 1_024;
    const sourceSize = 5 * gib;
    const sampleRate = 48_000;
    const totalSamples = sampleRate * 60 * 60 * 24 * 7;
    const finalFrameSample = totalSamples - 4_096;
    const marker = Uint8Array.of(0x66, 0x4c, 0x61, 0x43);
    const streamInfoBlock = block(0, streamInfo({ sampleRate, totalSamples }));
    const expectedFirstAudioFrameOffset = 64;
    const finalFrameStreamOffset = sourceSize - expectedFirstAudioFrameOffset - 32_768;
    const seekTableBlock = block(
      3,
      seekPoint(BigInt(finalFrameSample), BigInt(finalFrameStreamOffset)),
      true,
    );
    const prefix = new Uint8Array([...marker, ...streamInfoBlock, ...seekTableBlock]);
    expect(prefix.byteLength).toBe(expectedFirstAudioFrameOffset);
    const source = new SparseEncodedAudioSource(sourceSize, [{ offset: 0, bytes: prefix }]);

    const metadata = await readFlacMetadata(source, new AbortController().signal);

    expect(metadata.streamInfo).toMatchObject({
      sampleRate,
      totalSamples,
      duration: 7 * 24 * 60 * 60,
    });
    expect(metadata.seekPoints).toEqual([
      {
        sample: finalFrameSample,
        streamOffset: finalFrameStreamOffset,
        frameSamples: 4_096,
      },
    ]);
    expect(source.reads.every((read) => read.offset + read.length <= prefix.byteLength)).toBe(true);
    expect(Math.max(...source.reads.map((read) => read.length))).toBeLessThanOrEqual(
      MAX_SOURCE_READ_BYTES,
    );

    const index = new FlacSeekIndex(metadata, sourceSize);
    expect(index.snapshot()).toHaveLength(2);
    expect(index.nearestBefore(totalSamples - 1)).toEqual({
      sourceSample: finalFrameSample,
      byteOffset: expectedFirstAudioFrameOffset + finalFrameStreamOffset,
    });
    const window = index.probeWindow(totalSamples - 1, MAX_SOURCE_READ_BYTES);
    expect(window.length).toBe(MAX_SOURCE_READ_BYTES);
    expect(window.offset).toBeGreaterThan(4 * gib);
    expect(window.offset + window.length).toBeLessThanOrEqual(sourceSize);
  });

  it('keeps order, placeholder, and offset validation across SEEKTABLE page boundaries', async () => {
    const signal = new AbortController().signal;
    const pointCount = SEEKTABLE_PAGE_POINTS + 1;
    const parse = (table: Uint8Array) =>
      readFlacMetadata(
        flacWithAudio(pointCount + 32, block(0, streamInfo()), block(3, table, true)),
        signal,
      );

    const unorderedSample = seekTable(pointCount, (index) =>
      seekPoint(BigInt(index === SEEKTABLE_PAGE_POINTS ? index - 1 : index) * 4096n, BigInt(index)),
    );
    await expect(parse(unorderedSample)).rejects.toThrow('not strictly ordered');

    const unorderedOffset = seekTable(pointCount, (index) =>
      seekPoint(BigInt(index) * 4096n, BigInt(index === SEEKTABLE_PAGE_POINTS ? index - 1 : index)),
    );
    await expect(parse(unorderedOffset)).rejects.toThrow('not strictly ordered');

    const pointAfterPlaceholder = seekTable(pointCount, (index) =>
      index === SEEKTABLE_PAGE_POINTS - 1
        ? seekPoint(0xffff_ffff_ffff_ffffn, 123n, 0)
        : seekPoint(BigInt(index) * 4096n, BigInt(index)),
    );
    await expect(parse(pointAfterPlaceholder)).rejects.toThrow('placeholders must occur last');
  });

  it('validates compacted-away entries and the aggregate maximum stream offset', async () => {
    const signal = new AbortController().signal;
    const pointCount = 9_000;
    const invalidDiscardedFrame = seekTable(pointCount, (index) =>
      seekPoint(BigInt(index) * 4096n, BigInt(index), index === 4097 ? 4097 : 4096),
    );
    await expect(
      readFlacMetadata(
        flacWithAudio(
          pointCount + 32,
          block(0, streamInfo()),
          block(3, invalidDiscardedFrame, true),
        ),
        signal,
      ),
    ).rejects.toThrow('contradicts STREAMINFO bounds');

    await expect(
      readFlacMetadata(
        flacWithAudio(128, block(0, streamInfo()), block(3, seekTable(pointCount), true)),
        signal,
      ),
    ).rejects.toThrow('offset is outside the audio stream');
  });

  it('accepts one empty or placeholder-only SEEKTABLE but rejects every duplicate', async () => {
    const signal = new AbortController().signal;
    const empty = await readFlacMetadata(
      flac(block(0, streamInfo()), block(3, new Uint8Array(0), true)),
      signal,
    );
    expect(empty.seekPoints).toEqual([]);

    const placeholders = new Uint8Array([
      ...seekPoint(0xffff_ffff_ffff_ffffn, 123n, 0),
      ...seekPoint(0xffff_ffff_ffff_ffffn, 456n, 65_535),
    ]);
    const reserved = await readFlacMetadata(
      flac(block(0, streamInfo()), block(3, placeholders, true)),
      signal,
    );
    expect(reserved.seekPoints).toEqual([]);

    await expect(
      readFlacMetadata(
        flac(
          block(0, streamInfo()),
          block(3, new Uint8Array(0)),
          block(3, new Uint8Array(0), true),
        ),
        signal,
      ),
    ).rejects.toThrow('duplicate SEEKTABLE');
  });

  it('rejects non-placeholder points after placeholders and contradictory offsets', async () => {
    const signal = new AbortController().signal;
    const pointAfterPlaceholder = new Uint8Array([
      ...seekPoint(0xffff_ffff_ffff_ffffn, 0n, 0),
      ...seekPoint(4096n, 64n),
    ]);
    await expect(
      readFlacMetadata(flac(block(0, streamInfo()), block(3, pointAfterPlaceholder, true)), signal),
    ).rejects.toThrow('placeholders must occur last');

    const repeatedOffset = new Uint8Array([...seekPoint(0n, 0n), ...seekPoint(4096n, 0n)]);
    await expect(
      readFlacMetadata(flac(block(0, streamInfo()), block(3, repeatedOffset, true)), signal),
    ).rejects.toThrow('not strictly ordered');
  });

  it('rejects seek samples, offsets, and target-frame sizes outside this source', async () => {
    const signal = new AbortController().signal;
    const parse = (point: Uint8Array) =>
      readFlacMetadata(flac(block(0, streamInfo()), block(3, point, true)), signal);

    await expect(parse(seekPoint(195_000_000n, 64n))).rejects.toThrow(
      'sample is outside the stream',
    );
    await expect(parse(seekPoint(4096n, 120n))).rejects.toThrow(
      'offset is outside the audio stream',
    );
    await expect(parse(seekPoint(4096n, 64n, 4097))).rejects.toThrow(
      'contradicts STREAMINFO bounds',
    );
    await expect(parse(seekPoint(194_999_000n, 64n, 4096))).rejects.toThrow(
      'contradicts STREAMINFO bounds',
    );
    await expect(parse(seekPoint(4096n, 0n))).rejects.toThrow('offset is outside the audio stream');
  });

  it('allows the final target frame to be smaller than STREAMINFO minimum block size', async () => {
    const metadata = await readFlacMetadata(
      flac(
        block(0, streamInfo({ totalSamples: 10_000 })),
        block(3, seekPoint(9992n, 64n, 8), true),
      ),
      new AbortController().signal,
    );

    expect(metadata.seekPoints).toEqual([{ sample: 9992, streamOffset: 64, frameSamples: 8 }]);
  });

  it('skips a large picture block without treating it as audio metadata', async () => {
    const picture = new Uint8Array(512 * 1024);
    const metadata = await readFlacMetadata(
      flac(block(0, streamInfo()), block(6, picture, true)),
      new AbortController().signal,
    );
    expect(metadata.firstAudioFrameOffset).toBe(4 + 4 + 34 + 4 + picture.byteLength);
    expect(metadata.metadataBlockCount).toBe(2);
  });

  it('rejects non-FLAC, missing-first STREAMINFO, malformed seek tables, and no audio', async () => {
    const signal = new AbortController().signal;
    await expect(
      readFlacMetadata(new BlobEncodedAudioSource(new Blob(['not flac at all'])), signal),
    ).rejects.toThrow('native FLAC');
    await expect(readFlacMetadata(flac(block(1, new Uint8Array(0), true)), signal)).rejects.toThrow(
      'STREAMINFO must be the first',
    );
    await expect(
      readFlacMetadata(flac(block(0, streamInfo()), block(3, new Uint8Array(1), true)), signal),
    ).rejects.toThrow('multiple of 18');

    const noAudioBlob = new Blob([
      new Uint8Array([0x66, 0x4c, 0x61, 0x43]),
      blobBytes(block(0, streamInfo(), true)),
    ]);
    await expect(readFlacMetadata(new BlobEncodedAudioSource(noAudioBlob), signal)).rejects.toThrow(
      'no audio frames',
    );
  });

  it('rejects unordered seek points and responds to cancellation', async () => {
    const table = new Uint8Array([...seekPoint(10n, 20n), ...seekPoint(9n, 21n)]);
    await expect(
      readFlacMetadata(
        flac(block(0, streamInfo()), block(3, table, true)),
        new AbortController().signal,
      ),
    ).rejects.toThrow('not strictly ordered');

    const controller = new AbortController();
    controller.abort(new Error('superseded'));
    await expect(
      readFlacMetadata(flac(block(0, streamInfo(), true)), controller.signal),
    ).rejects.toThrow('superseded');
  });
});
