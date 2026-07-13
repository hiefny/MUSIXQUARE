import { describe, expect, it } from 'vitest';

import {
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
  type EncodedAudioSourceMetadata,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import { parseMpegLayer3FrameHeader } from '../frame-header.ts';
import {
  MP3_FRAME_SCAN_MAX_PAGE_BYTES,
  MpegLayer3FrameScanError,
  scanMpegLayer3Frames,
  type MpegLayer3VerifiedFrame,
} from '../frame-scanner.ts';
import type { Mp3Id3Boundaries } from '../id3.ts';

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

function makeFrame(options: HeaderOptions = {}, fill = 0x5a): Uint8Array {
  const headerBytes = makeHeader(options);
  const header = parseMpegLayer3FrameHeader(headerBytes);
  const frame = new Uint8Array(header.frameLengthBytes);
  frame.fill(fill);
  frame.set(headerBytes);
  return frame;
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function boundariesFor(
  sourceBytes: number,
  dataStart = 0,
  audioEnd = sourceBytes,
): Mp3Id3Boundaries {
  return Object.freeze({
    sourceBytes,
    dataStart,
    audioEnd,
    leadingTagCount: 0,
    leadingTags: Object.freeze([]),
    hasTrailingId3v1: false,
    trailingId3v1Offset: null,
  });
}

class MemorySource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly identity = 'mp3-frame-scanner-memory';
  readonly metadata: EncodedAudioSourceMetadata = Object.freeze({
    name: 'fixture.mp3',
    mime: 'audio/mpeg',
  });
  readonly reads: ReadRecord[] = [];
  maxConcurrentReads = 0;
  activeReads = 0;
  shortRead = false;
  abortDuringRead: AbortController | null = null;
  abortReason: unknown = undefined;

  constructor(readonly bytes: Uint8Array) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push(Object.freeze({ offset, length }));
    this.activeReads += 1;
    this.maxConcurrentReads = Math.max(this.maxConcurrentReads, this.activeReads);
    try {
      await Promise.resolve();
      if (this.abortDuringRead) this.abortDuringRead.abort(this.abortReason);
      const returnedEnd = this.shortRead && length > 0 ? end - 1 : end;
      return this.bytes.subarray(offset, returnedEnd);
    } finally {
      this.activeReads -= 1;
    }
  }

  async close(): Promise<void> {}
}

class SparseSource implements EncodedAudioSource {
  readonly kind = 'peer-range' as const;
  readonly identity = 'mp3-frame-scanner-sparse';
  readonly metadata: EncodedAudioSourceMetadata = Object.freeze({
    name: 'sparse.mp3',
    mime: 'audio/mpeg',
  });
  readonly reads: ReadRecord[] = [];

  constructor(
    readonly size: number,
    private readonly segments: ReadonlyArray<{
      readonly offset: number;
      readonly bytes: Uint8Array;
    }>,
  ) {}

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push(Object.freeze({ offset, length }));
    const result = new Uint8Array(length);
    for (const segment of this.segments) {
      const segmentEnd = segment.offset + segment.bytes.byteLength;
      const overlapStart = Math.max(offset, segment.offset);
      const overlapEnd = Math.min(end, segmentEnd);
      if (overlapStart >= overlapEnd) continue;
      result.set(
        segment.bytes.subarray(overlapStart - segment.offset, overlapEnd - segment.offset),
        overlapStart - offset,
      );
    }
    return result;
  }

  async close(): Promise<void> {}
}

const signal = () => new AbortController().signal;

describe('scanMpegLayer3Frames', () => {
  it('fully verifies valid one- and two-frame streams and returns only an exact first-frame copy', async () => {
    const first = makeFrame({}, 0x11);
    const second = makeFrame({ paddingBit: 1 }, 0x22);

    for (const frames of [[first], [first, second]]) {
      const bytes = concatenate(...frames);
      const source = new MemorySource(bytes);
      const result = await scanMpegLayer3Frames(source, boundariesFor(bytes.byteLength), signal());

      expect(result).toMatchObject({
        complete: true,
        frameCount: frames.length,
        totalRawSamples: frames.length * 1_152,
        verifiedAudioBytes: bytes.byteLength,
        version: '1',
        sampleRateHz: 44_100,
        channelCount: 2,
        samplesPerFrame: 1_152,
        constantBitrate: true,
        constantBitrateKbps: 128,
      });
      expect(result.next).toEqual({
        frameOrdinal: frames.length,
        rawSample: frames.length * 1_152,
        byteOffset: bytes.byteLength,
      });
      expect(result.firstFrame).toEqual(first);
      expect(result.firstFrame).not.toBe(first);
      result.firstFrame[4] = 0xee;
      expect(source.bytes[4]).toBe(0x11);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.next)).toBe(true);
    }
  });

  it('stops at a bounded prefix and reports exact continuation coordinates and callbacks', async () => {
    const frames = [makeFrame(), makeFrame({ paddingBit: 1 }), makeFrame(), makeFrame()];
    const bytes = concatenate(...frames);
    const verified: MpegLayer3VerifiedFrame[] = [];
    const result = await scanMpegLayer3Frames(
      new MemorySource(bytes),
      boundariesFor(bytes.byteLength),
      signal(),
      { maxFrames: 3, onVerifiedFrame: (frame) => verified.push(frame) },
    );
    const expectedOffset = frames.slice(0, 3).reduce((total, frame) => total + frame.length, 0);

    expect(result).toMatchObject({
      complete: false,
      frameCount: 3,
      totalRawSamples: 3_456,
      verifiedAudioBytes: expectedOffset,
    });
    expect(result.next).toEqual({
      frameOrdinal: 3,
      rawSample: 3_456,
      byteOffset: expectedOffset,
    });
    expect(
      verified.map(({ frameOrdinal, rawSample, byteOffset }) => ({
        frameOrdinal,
        rawSample,
        byteOffset,
      })),
    ).toEqual([
      { frameOrdinal: 0, rawSample: 0, byteOffset: 0 },
      { frameOrdinal: 1, rawSample: 1_152, byteOffset: frames[0]?.length },
      {
        frameOrdinal: 2,
        rawSample: 2_304,
        byteOffset: (frames[0]?.length ?? 0) + (frames[1]?.length ?? 0),
      },
    ]);
    expect(verified.every((frame) => Object.isFrozen(frame) && Object.isFrozen(frame.header))).toBe(
      true,
    );
  });

  it('allows bitrate, padding, CRC, and two-channel mode changes while detecting VBR', async () => {
    const bytes = concatenate(
      makeFrame({ channelModeBits: 0, bitrateIndex: 9 }),
      makeFrame({ channelModeBits: 1, bitrateIndex: 10, paddingBit: 1, protectionBit: 0 }),
      makeFrame({ channelModeBits: 2, bitrateIndex: 9 }),
    );
    const result = await scanMpegLayer3Frames(
      new MemorySource(bytes),
      boundariesFor(bytes.length),
      signal(),
    );

    expect(result.complete).toBe(true);
    expect(result.constantBitrate).toBe(false);
    expect(result.constantBitrateKbps).toBeNull();
  });

  it.each([
    ['version', makeFrame({ versionBits: 2, bitrateIndex: 8 })],
    ['sample rate', makeFrame({ sampleRateIndex: 1 })],
    ['channel count', makeFrame({ channelModeBits: 3 })],
  ])('rejects a mid-stream %s change', async (message, changed) => {
    const bytes = concatenate(makeFrame(), changed);
    await expect(
      scanMpegLayer3Frames(new MemorySource(bytes), boundariesFor(bytes.length), signal()),
    ).rejects.toThrow(message);
  });

  it('rejects truncated frames, trailing bytes, and junk at a declared boundary', async () => {
    const frame = makeFrame();
    const malformed = [
      frame.subarray(0, frame.length - 1),
      concatenate(frame, Uint8Array.of(1, 2, 3)),
      concatenate(frame, Uint8Array.of(1, 2, 3, 4)),
    ];
    for (const bytes of malformed) {
      await expect(
        scanMpegLayer3Frames(new MemorySource(bytes), boundariesFor(bytes.length), signal()),
      ).rejects.toBeInstanceOf(MpegLayer3FrameScanError);
    }
  });

  it('fails closed on a short transport response', async () => {
    const frame = makeFrame();
    const source = new MemorySource(frame);
    source.shortRead = true;
    await expect(
      scanMpegLayer3Frames(source, boundariesFor(frame.length), signal()),
    ).rejects.toThrow('expected');
  });

  it('honors abort before, during, and after a verified-frame callback', async () => {
    const frame = makeFrame();
    const before = new AbortController();
    const beforeReason = new Error('before');
    before.abort(beforeReason);
    await expect(
      scanMpegLayer3Frames(new MemorySource(frame), boundariesFor(frame.length), before.signal),
    ).rejects.toBe(beforeReason);

    const during = new AbortController();
    const duringReason = new Error('during');
    const duringSource = new MemorySource(frame);
    duringSource.abortDuringRead = during;
    duringSource.abortReason = duringReason;
    await expect(
      scanMpegLayer3Frames(duringSource, boundariesFor(frame.length), during.signal),
    ).rejects.toBe(duringReason);

    const after = new AbortController();
    const afterReason = new Error('after callback');
    await expect(
      scanMpegLayer3Frames(new MemorySource(frame), boundariesFor(frame.length), after.signal, {
        onVerifiedFrame: () => after.abort(afterReason),
      }),
    ).rejects.toBe(afterReason);
  });

  it('uses sequential non-concurrent pages no larger than 64 KiB', async () => {
    const frame = makeFrame();
    const bytes = concatenate(...Array.from({ length: 200 }, () => frame));
    const source = new MemorySource(bytes);
    const result = await scanMpegLayer3Frames(source, boundariesFor(bytes.length), signal());

    expect(result.frameCount).toBe(200);
    expect(source.reads.length).toBeGreaterThan(1);
    expect(Math.max(...source.reads.map((read) => read.length))).toBe(
      MP3_FRAME_SCAN_MAX_PAGE_BYTES,
    );
    expect(source.reads.every((read) => read.length <= MP3_FRAME_SCAN_MAX_PAGE_BYTES)).toBe(true);
    expect(source.maxConcurrentReads).toBe(1);
  });

  it('scans a prefix beyond 4 GiB without allocating the sparse source span', async () => {
    const dataStart = 4 * 1_024 ** 3 + 123;
    const frames = concatenate(makeFrame(), makeFrame({ paddingBit: 1 }), makeFrame());
    const sourceBytes = 5 * 1_024 ** 3;
    const audioEnd = dataStart + frames.length;
    const source = new SparseSource(sourceBytes, [{ offset: dataStart, bytes: frames }]);
    const result = await scanMpegLayer3Frames(
      source,
      boundariesFor(sourceBytes, dataStart, audioEnd),
      signal(),
      { maxFrames: 3 },
    );

    expect(result.complete).toBe(true);
    expect(result.next.byteOffset).toBe(audioEnd);
    expect(source.reads).toEqual([{ offset: dataStart, length: frames.length }]);
  });

  it('keeps offset arithmetic exact at the safe-integer source boundary', async () => {
    const frame = makeFrame();
    const sourceBytes = Number.MAX_SAFE_INTEGER;
    const dataStart = sourceBytes - frame.length;
    const source = new SparseSource(sourceBytes, [{ offset: dataStart, bytes: frame }]);
    const result = await scanMpegLayer3Frames(
      source,
      boundariesFor(sourceBytes, dataStart, sourceBytes),
      signal(),
    );

    expect(result.next.byteOffset).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.complete).toBe(true);
  });

  it('rejects stale/invalid boundaries and unbounded scan options before transport reads', async () => {
    const frame = makeFrame();
    const source = new MemorySource(frame);
    await expect(
      scanMpegLayer3Frames(source, boundariesFor(frame.length + 1), signal()),
    ).rejects.toBeInstanceOf(EncodedSourceIntegrityError);
    await expect(
      scanMpegLayer3Frames(source, boundariesFor(frame.length), signal(), { maxFrames: 0 }),
    ).rejects.toThrow('maxFrames');
    await expect(
      scanMpegLayer3Frames(source, boundariesFor(frame.length), signal(), {
        pageBytes: MP3_FRAME_SCAN_MAX_PAGE_BYTES + 1,
      }),
    ).rejects.toThrow('pageBytes');
    expect(source.reads).toHaveLength(0);
  });

  it('rejects an asynchronous verified-frame callback', async () => {
    const frame = makeFrame();
    await expect(
      scanMpegLayer3Frames(new MemorySource(frame), boundariesFor(frame.length), signal(), {
        onVerifiedFrame: (() => Promise.resolve()) as unknown as (
          frame: MpegLayer3VerifiedFrame,
        ) => void,
      }),
    ).rejects.toThrow('synchronous');
  });
});
