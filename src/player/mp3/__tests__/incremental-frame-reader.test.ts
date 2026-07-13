import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type EncodedAudioSource,
  type EncodedAudioSourceMetadata,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import { parseMpegLayer3FrameHeader } from '../frame-header.ts';
import {
  MP3_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES,
  MpegLayer3IncrementalFrameReader,
  MpegLayer3IncrementalFrameReaderError,
  type MpegLayer3IncrementalFrameReaderOptions,
} from '../incremental-frame-reader.ts';
import { readMp3Metadata } from '../metadata.ts';

interface HeaderOptions {
  readonly versionBits?: 0 | 2 | 3;
  readonly protectionBit?: 0 | 1;
  readonly bitrateIndex?: number;
  readonly sampleRateIndex?: 0 | 1 | 2;
  readonly paddingBit?: 0 | 1;
  readonly channelModeBits?: 0 | 1 | 2 | 3;
}

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

function makeHeader(options: HeaderOptions = {}): Uint8Array {
  return Uint8Array.of(
    0xff,
    0xe0 | ((options.versionBits ?? 3) << 3) | (1 << 1) | (options.protectionBit ?? 1),
    ((options.bitrateIndex ?? 9) << 4) |
      ((options.sampleRateIndex ?? 0) << 2) |
      ((options.paddingBit ?? 0) << 1),
    (options.channelModeBits ?? 0) << 6,
  );
}

function makeFrame(options: HeaderOptions = {}, fill = 0x5a, mainDataBeginBytes = 0): Uint8Array {
  const headerBytes = makeHeader(options);
  const header = parseMpegLayer3FrameHeader(headerBytes);
  const frame = new Uint8Array(header.frameLengthBytes);
  frame.fill(fill);
  frame.set(headerBytes);
  const sideInfoOffset = 4 + (header.hasCrc ? 2 : 0);
  if (header.version === '1') {
    frame[sideInfoOffset] = mainDataBeginBytes >>> 1;
    frame[sideInfoOffset + 1] =
      ((mainDataBeginBytes & 1) << 7) | ((frame[sideInfoOffset + 1] ?? 0) & 0x7f);
  } else {
    frame[sideInfoOffset] = mainDataBeginBytes;
  }
  return frame;
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(byteLength);
  let byteOffset = 0;
  for (const part of parts) {
    bytes.set(part, byteOffset);
    byteOffset += part.byteLength;
  }
  return bytes;
}

class MemorySource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly metadata: EncodedAudioSourceMetadata = Object.freeze({
    name: 'incremental.mp3',
    mime: 'audio/mpeg',
  });
  readonly reads: ReadRecord[] = [];
  identityValue = 'mp3-incremental-memory';
  reportedSize: number;
  closeCount = 0;
  shortRead = false;
  onRead: ((source: MemorySource, signal: AbortSignal) => void | Promise<void>) | null = null;

  constructor(readonly bytes: Uint8Array) {
    this.reportedSize = bytes.byteLength;
  }

  get identity(): string {
    return this.identityValue;
  }

  get size(): number {
    return this.reportedSize;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push(Object.freeze({ offset, length }));
    await this.onRead?.(this, signal);
    throwIfAborted(signal);
    return this.bytes.slice(offset, this.shortRead && length > 0 ? end - 1 : end);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function readerOptions(
  source: EncodedAudioSource,
  options: Partial<MpegLayer3IncrementalFrameReaderOptions> = {},
): MpegLayer3IncrementalFrameReaderOptions {
  return {
    source,
    firstAudioFrameOffset: 0,
    audioEndByteOffset: source.size,
    audioFrameCount: 1,
    version: '1',
    sampleRateHz: 44_100,
    channels: 2,
    samplesPerFrame: 1_152,
    start: Object.freeze({ byteOffset: 0, frameOrdinal: 0 }),
    ...options,
  };
}

const signal = () => new AbortController().signal;

describe('MpegLayer3IncrementalFrameReader valid bounded reads', () => {
  it('returns exact owned frames and frozen descriptors across tiny transport-page boundaries', async () => {
    const prefix = Uint8Array.of(1, 2, 3, 4, 5, 6, 7);
    const frames = [
      makeFrame({}, 0x11, 0),
      makeFrame(
        { protectionBit: 0, bitrateIndex: 10, paddingBit: 1, channelModeBits: 1 },
        0x22,
        511,
      ),
      makeFrame({ bitrateIndex: 8, channelModeBits: 2 }, 0x33, 257),
    ];
    const suffix = Uint8Array.of(8, 9, 10);
    const bytes = concatenate(prefix, ...frames, suffix);
    const source = new MemorySource(bytes);
    const audioBytes = frames.reduce((total, frame) => total + frame.byteLength, 0);
    const audioEndByteOffset = prefix.byteLength + audioBytes;
    const reader = new MpegLayer3IncrementalFrameReader(
      readerOptions(source, {
        firstAudioFrameOffset: prefix.byteLength,
        audioEndByteOffset,
        audioFrameCount: frames.length,
        start: { byteOffset: prefix.byteLength, frameOrdinal: 0 },
        pageBytes: 5,
      }),
    );

    let byteOffset = prefix.byteLength;
    let firstReturnedBytes: Uint8Array | null = null;
    for (let ordinal = 0; ordinal < frames.length; ordinal += 1) {
      const expected = frames[ordinal];
      const result = await reader.readNext(signal());
      expect(result).not.toBeNull();
      if (!result || !expected) throw new Error('expected an incremental MP3 frame');
      expect(result.bytes).toEqual(expected);
      expect(result.bytes).not.toBe(expected);
      expect(result.descriptor).toMatchObject({
        frameOrdinal: ordinal,
        rawSample: ordinal * 1_152,
        byteOffset,
        byteEndOffset: byteOffset + expected.byteLength,
        mainDataBeginBytes: ordinal === 0 ? 0 : ordinal === 1 ? 511 : 257,
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.descriptor)).toBe(true);
      expect(Object.isFrozen(result.descriptor.header)).toBe(true);
      if (ordinal === 0) firstReturnedBytes = result.bytes;
      byteOffset += expected.byteLength;
    }

    const originalSourceByte = source.bytes[prefix.byteLength + 10];
    if (!firstReturnedBytes) throw new Error('missing first returned fixture frame');
    firstReturnedBytes[10] = 0xaa;
    expect(source.bytes[prefix.byteLength + 10]).toBe(originalSourceByte);
    expect(await reader.readNext(signal())).toBeNull();
    expect(await reader.readNext(signal())).toBeNull();
    expect(source.reads.every((read) => read.length <= 5)).toBe(true);
    expect(source.reads.some((read) => read.offset % 5 !== 0)).toBe(true);
    expect(source.closeCount).toBe(0);
  });

  it('starts at an arbitrary verified frame or at the exact EOF coordinate', async () => {
    const frames = [makeFrame(), makeFrame({ paddingBit: 1 }, 0x22, 511), makeFrame()];
    const bytes = concatenate(...frames);
    const source = new MemorySource(bytes);
    const secondOffset = frames[0]?.byteLength ?? 0;
    const reader = new MpegLayer3IncrementalFrameReader(
      readerOptions(source, {
        audioFrameCount: 3,
        start: { byteOffset: secondOffset, frameOrdinal: 1 },
        pageBytes: 7,
      }),
    );

    const second = await reader.readNext(signal());
    const third = await reader.readNext(signal());
    expect(second?.descriptor).toMatchObject({
      frameOrdinal: 1,
      rawSample: 1_152,
      byteOffset: secondOffset,
      mainDataBeginBytes: 511,
    });
    expect(third?.descriptor.frameOrdinal).toBe(2);
    expect(await reader.readNext(signal())).toBeNull();
    expect(Math.min(...source.reads.map((read) => read.offset))).toBe(secondOffset);

    const eofSource = new MemorySource(bytes);
    const eofReader = new MpegLayer3IncrementalFrameReader(
      readerOptions(eofSource, {
        audioFrameCount: 3,
        start: { byteOffset: bytes.byteLength, frameOrdinal: 3 },
      }),
    );
    expect(await eofReader.readNext(signal())).toBeNull();
    expect(eofSource.reads).toHaveLength(0);
  });

  it('never requests more than one 64 KiB transport page or the complete long source', async () => {
    const frame = makeFrame();
    const bytes = concatenate(...Array.from({ length: 400 }, () => frame));
    const source = new MemorySource(bytes);
    const reader = new MpegLayer3IncrementalFrameReader(
      readerOptions(source, { audioFrameCount: 400 }),
    );

    expect(await reader.readNext(signal())).not.toBeNull();
    expect(source.reads).toEqual([
      { offset: 0, length: MP3_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES },
    ]);
    expect(source.reads[0]?.length).toBeLessThan(source.size);
  });

  it('copies a small source view so the cache cannot retain its oversized backing buffer', async () => {
    const firstFrame = makeFrame({}, 0x11);
    const secondFrame = makeFrame({ paddingBit: 1 }, 0x22, 511);
    const frames = concatenate(firstFrame, secondFrame);
    const source = new MemorySource(frames);
    const oversized = new Uint8Array(4 * 1_024 * 1_024);
    oversized.set(frames);
    source.onRead = null;
    source.readAt = async (offset, length, readSignal) => {
      validateExactRead(source.size, offset, length);
      throwIfAborted(readSignal);
      source.reads.push(Object.freeze({ offset, length }));
      return oversized.subarray(offset, offset + length);
    };
    const reader = new MpegLayer3IncrementalFrameReader(
      readerOptions(source, { audioFrameCount: 2, pageBytes: frames.byteLength }),
    );

    expect((await reader.readNext(signal()))?.bytes).toEqual(firstFrame);
    oversized[firstFrame.byteLength] = 0;
    expect((await reader.readNext(signal()))?.bytes).toEqual(secondFrame);
  });

  it.each([
    ['1', 3, 44_100, 1_152, 511],
    ['2', 2, 22_050, 576, 255],
    ['2.5', 0, 11_025, 576, 255],
  ] as const)(
    'reads MPEG-%s stereo and mono side-info geometry',
    async (version, versionBits, sampleRateHz, samplesPerFrame, maximumMainDataBegin) => {
      for (const channelModeBits of [0, 3] as const) {
        const frames = [
          makeFrame({ versionBits, channelModeBits }, 0x11, 0),
          makeFrame({ versionBits, channelModeBits, protectionBit: 0 }, 0x22, maximumMainDataBegin),
        ];
        const source = new MemorySource(concatenate(...frames));
        const reader = new MpegLayer3IncrementalFrameReader(
          readerOptions(source, {
            audioFrameCount: 2,
            version,
            sampleRateHz,
            channels: channelModeBits === 3 ? 1 : 2,
            samplesPerFrame,
            pageBytes: 4,
          }),
        );

        expect((await reader.readNext(signal()))?.descriptor.mainDataBeginBytes).toBe(0);
        expect((await reader.readNext(signal()))?.descriptor).toMatchObject({
          frameOrdinal: 1,
          rawSample: samplesPerFrame,
          mainDataBeginBytes: maximumMainDataBegin,
        });
        expect(await reader.readNext(signal())).toBeNull();
      }
    },
  );
});

describe('MpegLayer3IncrementalFrameReader validation', () => {
  it.each([
    ['version', makeFrame({ versionBits: 2, bitrateIndex: 8 })],
    ['sample rate', makeFrame({ sampleRateIndex: 1 })],
    ['channel count', makeFrame({ channelModeBits: 3 })],
  ])('rejects a fixed-stream %s mismatch', async (message, frame) => {
    const source = new MemorySource(frame);
    const reader = new MpegLayer3IncrementalFrameReader(readerOptions(source));
    await expect(reader.readNext(signal())).rejects.toThrow(message);
  });

  it('rejects incompatible samples-per-frame geometry before transport reads', () => {
    const source = new MemorySource(makeFrame());
    expect(
      () =>
        new MpegLayer3IncrementalFrameReader(
          readerOptions(source, { samplesPerFrame: 576 as 576 | 1_152 }),
        ),
    ).toThrow(/samples per frame/i);
    expect(source.reads).toHaveLength(0);
  });

  it('rejects malformed headers, truncated frames, and a nonzero frame-zero reservoir pointer', async () => {
    const malformed = makeFrame();
    malformed[0] = 0;
    const malformedReader = new MpegLayer3IncrementalFrameReader(
      readerOptions(new MemorySource(malformed)),
    );
    await expect(malformedReader.readNext(signal())).rejects.toBeInstanceOf(
      MpegLayer3IncrementalFrameReaderError,
    );

    const complete = makeFrame();
    const truncated = complete.slice(0, -1);
    const truncatedReader = new MpegLayer3IncrementalFrameReader(
      readerOptions(new MemorySource(truncated)),
    );
    await expect(truncatedReader.readNext(signal())).rejects.toThrow(/truncated/i);

    const reservoir = makeFrame({}, 0x5a, 1);
    const reservoirReader = new MpegLayer3IncrementalFrameReader(
      readerOptions(new MemorySource(reservoir)),
    );
    await expect(reservoirReader.readNext(signal())).rejects.toThrow(/earlier bit reservoir/i);
  });

  it.each([
    ['early end', concatenate(makeFrame()), 2, /before its declared final frame/i],
    ['extra frame', concatenate(makeFrame(), makeFrame()), 1, /extra audio bytes/i],
    ['trailing bytes', concatenate(makeFrame(), Uint8Array.of(1, 2, 3)), 1, /extra audio bytes/i],
  ])(
    'rejects an %s instead of exposing a false final frame',
    async (_name, bytes, count, error) => {
      const reader = new MpegLayer3IncrementalFrameReader(
        readerOptions(new MemorySource(bytes), { audioFrameCount: count }),
      );
      await expect(reader.readNext(signal())).rejects.toThrow(error);
    },
  );

  it('fails closed on short transport reads and source identity or byte changes', async () => {
    const shortSource = new MemorySource(makeFrame());
    shortSource.shortRead = true;
    const shortReader = new MpegLayer3IncrementalFrameReader(readerOptions(shortSource));
    const firstFailure = await shortReader.readNext(signal()).catch((error: unknown) => error);
    expect(firstFailure).toBeInstanceOf(MpegLayer3IncrementalFrameReaderError);
    expect(String(firstFailure)).toMatch(/expected/i);
    await expect(shortReader.readNext(signal())).rejects.toBe(firstFailure);
    const abortAfterPoison = new AbortController();
    abortAfterPoison.abort(new Error('later abort must not hide integrity poison'));
    await expect(shortReader.readNext(abortAfterPoison.signal)).rejects.toBe(firstFailure);
    expect(shortSource.closeCount).toBe(0);

    const identitySource = new MemorySource(makeFrame());
    identitySource.onRead = (source) => {
      source.identityValue = 'mp3-incremental-changed';
    };
    const identityReader = new MpegLayer3IncrementalFrameReader(
      readerOptions(identitySource, { pageBytes: 4 }),
    );
    await expect(identityReader.readNext(signal())).rejects.toThrow(/source changed/i);

    const sizeSource = new MemorySource(makeFrame());
    sizeSource.onRead = (source) => {
      source.reportedSize += 1;
    };
    const sizeReader = new MpegLayer3IncrementalFrameReader(
      readerOptions(sizeSource, { pageBytes: 4 }),
    );
    await expect(sizeReader.readNext(signal())).rejects.toThrow(/source changed/i);

    const first = makeFrame();
    const second = makeFrame();
    const byteSource = new MemorySource(concatenate(first, second));
    const byteReader = new MpegLayer3IncrementalFrameReader(
      readerOptions(byteSource, {
        audioFrameCount: 2,
        pageBytes: first.byteLength,
      }),
    );
    expect(await byteReader.readNext(signal())).not.toBeNull();
    byteSource.bytes[first.byteLength] = 0;
    await expect(byteReader.readNext(signal())).rejects.toThrow(/invalid MPEG/i);
  });

  it('rejects contradictory starts, unsafe totals, spans, and page sizes without reading', async () => {
    const source = new MemorySource(makeFrame());
    const invalidOptions: Array<Partial<MpegLayer3IncrementalFrameReaderOptions>> = [
      { firstAudioFrameOffset: -1 },
      { audioEndByteOffset: source.size + 1 },
      { audioFrameCount: 0 },
      { start: { byteOffset: 1, frameOrdinal: 0 } },
      { start: { byteOffset: source.size - 1, frameOrdinal: 1 } },
      { audioFrameCount: 5 },
      { pageBytes: 3 },
      { pageBytes: MP3_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES + 1 },
      {
        audioFrameCount: Math.floor(Number.MAX_SAFE_INTEGER / 1_152) + 1,
      },
    ];
    for (const override of invalidOptions) {
      expect(() => new MpegLayer3IncrementalFrameReader(readerOptions(source, override))).toThrow();
    }
    expect(source.reads).toHaveLength(0);

    const missingReadAt = new MemorySource(makeFrame());
    Object.defineProperty(missingReadAt, 'readAt', { value: null });
    expect(
      () =>
        new MpegLayer3IncrementalFrameReader(
          readerOptions(missingReadAt as unknown as EncodedAudioSource),
        ),
    ).toThrow(/readAt/i);
    const missingClose = new MemorySource(makeFrame());
    Object.defineProperty(missingClose, 'close', { value: null });
    expect(
      () =>
        new MpegLayer3IncrementalFrameReader(
          readerOptions(missingClose as unknown as EncodedAudioSource),
        ),
    ).toThrow(/close/i);

    const frames = concatenate(makeFrame(), makeFrame());
    const unverifiedSource = new MemorySource(frames);
    const unverifiedReader = new MpegLayer3IncrementalFrameReader(
      readerOptions(unverifiedSource, {
        audioFrameCount: 2,
        start: { byteOffset: 100, frameOrdinal: 1 },
      }),
    );
    await expect(unverifiedReader.readNext(signal())).rejects.toThrow(/invalid MPEG/i);
  });
});

describe('MpegLayer3IncrementalFrameReader concurrency and aborts', () => {
  it('rejects concurrent and transport-reentrant reads without disturbing the active read', async () => {
    const source = new MemorySource(makeFrame());
    let releaseRead: (() => void) | null = null;
    const enteredRead = new Promise<void>((resolveEntered) => {
      source.onRead = () =>
        new Promise<void>((resolveRead) => {
          releaseRead = resolveRead;
          resolveEntered();
        });
    });
    const reader = new MpegLayer3IncrementalFrameReader(readerOptions(source));
    const active = reader.readNext(signal());
    await enteredRead;
    await expect(reader.readNext(signal())).rejects.toThrow(/concurrent or reentrant/i);
    if (releaseRead === null) throw new Error('deferred read was not installed');
    releaseRead();
    expect(await active).not.toBeNull();

    const reentrantSource = new MemorySource(makeFrame());
    const sharedSignal = signal();
    let reentrant: Promise<unknown> | null = null;
    let reentrantReader: MpegLayer3IncrementalFrameReader;
    reentrantSource.onRead = () => {
      reentrant = reentrantReader.readNext(sharedSignal);
    };
    reentrantReader = new MpegLayer3IncrementalFrameReader(readerOptions(reentrantSource));
    expect(await reentrantReader.readNext(sharedSignal)).not.toBeNull();
    if (reentrant === null) throw new Error('transport did not attempt its reentrant read');
    await expect(reentrant).rejects.toThrow(/concurrent or reentrant/i);
  });

  it('propagates the exact abort reason before and during transport without closing the source', async () => {
    const before = new AbortController();
    const beforeReason = new Error('incremental-before-abort');
    before.abort(beforeReason);
    const beforeSource = new MemorySource(makeFrame());
    const beforeReader = new MpegLayer3IncrementalFrameReader(readerOptions(beforeSource));
    await expect(beforeReader.readNext(before.signal)).rejects.toBe(beforeReason);
    expect(beforeSource.reads).toHaveLength(0);

    const during = new AbortController();
    const duringReason = new Error('incremental-during-abort');
    const duringSource = new MemorySource(makeFrame());
    duringSource.onRead = () => during.abort(duringReason);
    const duringReader = new MpegLayer3IncrementalFrameReader(readerOptions(duringSource));
    await expect(duringReader.readNext(during.signal)).rejects.toBe(duringReason);
    expect(duringSource.closeCount).toBe(0);
  });
});

describe('MpegLayer3IncrementalFrameReader repository fixture', () => {
  it('reads the scanner-normalized first audio frame from demo_track.mp3', async () => {
    const file = readFileSync(resolve(process.cwd(), 'public', 'demo_track.mp3'));
    const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    const source = new MemorySource(bytes);
    source.identityValue = 'mp3-incremental-demo-track';
    const controller = new AbortController();
    const metadata = await readMp3Metadata(source, controller.signal);
    const reader = new MpegLayer3IncrementalFrameReader({
      source,
      firstAudioFrameOffset: metadata.firstAudioFrameOffset,
      audioEndByteOffset: metadata.audioEndByteOffset,
      audioFrameCount: metadata.audioFrameCount,
      version: metadata.version,
      sampleRateHz: metadata.sampleRateHz,
      channels: metadata.channels,
      samplesPerFrame: metadata.samplesPerFrame,
      start: { byteOffset: metadata.firstAudioFrameOffset, frameOrdinal: 0 },
      pageBytes: 4,
    });

    const first = await reader.readNext(controller.signal);
    expect(first?.descriptor).toMatchObject({
      frameOrdinal: 0,
      rawSample: 0,
      byteOffset: metadata.firstAudioFrameOffset,
      mainDataBeginBytes: 0,
      header: metadata.firstAudioFrameHeader,
    });
    expect(first?.bytes).toEqual(
      bytes.slice(
        metadata.firstAudioFrameOffset,
        metadata.firstAudioFrameOffset + metadata.firstAudioFrameHeader.frameLengthBytes,
      ),
    );
    expect(source.closeCount).toBe(0);
  });
});
