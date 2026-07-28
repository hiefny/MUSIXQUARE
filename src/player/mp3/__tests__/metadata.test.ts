import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  EncodedAudioSource,
  EncodedAudioSourceMetadata,
} from '../../sources/encoded-audio-source.ts';
import { throwIfAborted, validateExactRead } from '../../sources/encoded-audio-source.ts';
import { parseMpegLayer3FrameHeader } from '../frame-header.ts';
import {
  MP3_METADATA_PREFIX_PHYSICAL_FRAMES,
  Mp3MetadataError,
  readMp3Metadata,
} from '../metadata.ts';
import { MP3_SEEK_INDEX_MAX_POINTS, MP3_SEEK_MAX_PROTECTED_PRELUDE_FRAMES } from '../seek-index.ts';
import { MPG123_DECODER_DELAY_SAMPLES } from '../timeline.ts';

interface HeaderOptions {
  readonly versionBits?: 0 | 2 | 3;
  readonly protectionBit?: 0 | 1;
  readonly bitrateIndex?: number;
  readonly sampleRateIndex?: 0 | 1 | 2;
  readonly paddingBit?: 0 | 1;
  readonly channelModeBits?: 0 | 1 | 2 | 3;
}

interface XingOptions {
  readonly identifier?: 'Xing' | 'Info';
  readonly frameCount?: number | null;
  readonly streamBytes?: number | null;
  readonly toc?: boolean;
  readonly gapless?: {
    readonly delay: number;
    readonly padding: number;
  } | null;
  readonly flagsOverride?: number;
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

function makeFrame(options: HeaderOptions = {}, mainDataBeginBytes = 0, fill = 0): Uint8Array {
  const headerBytes = makeHeader(options);
  const header = parseMpegLayer3FrameHeader(headerBytes);
  const frame = new Uint8Array(header.frameLengthBytes);
  frame.fill(fill);
  frame.set(headerBytes);
  const sideInfoOffset = 4 + (header.hasCrc ? 2 : 0);
  if (header.version === '1') {
    frame[sideInfoOffset] = mainDataBeginBytes >>> 1;
    frame[sideInfoOffset + 1] = (mainDataBeginBytes & 1) << 7;
  } else {
    frame[sideInfoOffset] = mainDataBeginBytes;
  }
  return frame;
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function setAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function setUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 8;
  bytes[offset + 1] = value;
}

function setUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value / 0x1_00_00_00;
  bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8;
  bytes[offset + 3] = value;
}

function lameInfoTagCrc16(bytes: Uint8Array, endOffset: number): number {
  let crc = 0;
  for (let offset = 0; offset < endOffset; offset += 1) {
    crc ^= bytes[offset] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xa001);
    }
  }
  return crc & 0xffff;
}

function writeXing(frame: Uint8Array, options: XingOptions): void {
  const header = parseMpegLayer3FrameHeader(frame.subarray(0, 4));
  const offset = 4 + header.sideInfoBytes;
  setAscii(frame, offset, options.identifier ?? 'Xing');

  let flags = 0;
  if (options.frameCount !== null && options.frameCount !== undefined) flags |= 0x01;
  if (options.streamBytes !== null && options.streamBytes !== undefined) flags |= 0x02;
  if (options.toc) flags |= 0x04;
  if (options.flagsOverride !== undefined) flags = options.flagsOverride;
  setUint32(frame, offset + 4, flags);

  let cursor = offset + 8;
  if ((flags & 0x01) !== 0) {
    setUint32(frame, cursor, options.frameCount ?? 0);
    cursor += 4;
  }
  if ((flags & 0x02) !== 0) {
    setUint32(frame, cursor, options.streamBytes ?? 0);
    cursor += 4;
  }
  if ((flags & 0x04) !== 0) {
    for (let index = 0; index < 100; index += 1) frame[cursor + index] = index;
    cursor += 100;
  }

  if (options.gapless) {
    setAscii(frame, cursor, 'LAME3.100');
    const packed = options.gapless.delay * 0x1000 + options.gapless.padding;
    frame[cursor + 21] = packed >>> 16;
    frame[cursor + 22] = packed >>> 8;
    frame[cursor + 23] = packed;
    const crcOffset = cursor + 34;
    setUint16(frame, crcOffset, lameInfoTagCrc16(frame, crcOffset));
  }
}

function writeVbri(frame: Uint8Array, audioFrameCount: number, streamBytes: number): void {
  const offset = 36;
  setAscii(frame, offset, 'VBRI');
  setUint16(frame, offset + 4, 1);
  setUint16(frame, offset + 6, 0);
  setUint16(frame, offset + 8, 0);
  setUint32(frame, offset + 10, streamBytes);
  setUint32(frame, offset + 14, audioFrameCount);
  setUint16(frame, offset + 18, 1);
  setUint16(frame, offset + 20, 1);
  setUint16(frame, offset + 22, 2);
  setUint16(frame, offset + 24, audioFrameCount);
  setUint16(frame, offset + 26, streamBytes);
}

function makeTaggedStream(options: {
  readonly audioFrameCount: number;
  readonly declaredFrameCount?: number | null;
  readonly declaredStreamBytesDelta?: number;
  readonly firstAudioMainDataBeginBytes?: number;
  readonly identifier?: 'Xing' | 'Info';
  readonly toc?: boolean;
  readonly gapless?: XingOptions['gapless'];
  readonly declareStreamBytes?: boolean;
}): Uint8Array {
  const tag = makeFrame();
  const audioFrames = Array.from({ length: options.audioFrameCount }, (_, index) =>
    makeFrame({}, index === 0 ? (options.firstAudioMainDataBeginBytes ?? 0) : 16),
  );
  const physicalBytes =
    tag.byteLength + audioFrames.reduce((total, frame) => total + frame.byteLength, 0);
  writeXing(tag, {
    identifier: options.identifier,
    frameCount: options.declaredFrameCount,
    streamBytes:
      options.declareStreamBytes === false
        ? null
        : physicalBytes + (options.declaredStreamBytesDelta ?? 0),
    toc: options.toc,
    gapless: options.gapless,
  });
  return concatenate(tag, ...audioFrames);
}

function makeVbriTaggedStream(audioFrameCount: number): Uint8Array {
  const tag = makeFrame();
  const audioFrames = Array.from({ length: audioFrameCount }, (_, index) =>
    makeFrame({}, index === 0 ? 0 : 16),
  );
  const streamBytes =
    tag.byteLength + audioFrames.reduce((total, frame) => total + frame.byteLength, 0);
  writeVbri(tag, audioFrameCount, streamBytes);
  return concatenate(tag, ...audioFrames);
}

class MemorySource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly identity: string;
  readonly metadata: EncodedAudioSourceMetadata = Object.freeze({
    name: 'fixture.mp3',
    mime: 'audio/mpeg',
  });
  readonly reads: ReadRecord[] = [];
  closeCount = 0;
  onRead: ((offset: number, length: number, readCount: number) => void) | null = null;

  constructor(
    readonly bytes: Uint8Array,
    identity = 'mp3-metadata-memory',
  ) {
    this.identity = identity;
  }

  get size(): number {
    return this.bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push(Object.freeze({ offset, length }));
    this.onRead?.(offset, length, this.reads.length);
    return this.bytes.slice(offset, end);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

const signal = () => new AbortController().signal;

describe('readMp3Metadata tag-frame normalization', () => {
  it('removes a declared Xing tag frame from PCM and exact seek coordinates', async () => {
    const audioFrameCount = 6;
    const bytes = makeTaggedStream({
      audioFrameCount,
      declaredFrameCount: audioFrameCount,
      identifier: 'Info',
      toc: true,
      gapless: { delay: 576, padding: 500 },
    });
    const source = new MemorySource(bytes);
    const metadata = await readMp3Metadata(source, signal());
    const frameBytes = parseMpegLayer3FrameHeader(bytes.subarray(0, 4)).frameLengthBytes;

    expect(metadata).toMatchObject({
      format: 'mp3',
      hasTagFrame: true,
      tagFrameOffset: 0,
      tagFrameBytes: frameBytes,
      firstAudioFrameOffset: frameBytes,
      audioEndByteOffset: bytes.byteLength,
      id3FreeMpegBytes: bytes.byteLength,
      audioBytes: bytes.byteLength - frameBytes,
      physicalFrameCount: audioFrameCount + 1,
      audioFrameCount,
      totalRawSamples: audioFrameCount * 1_152,
      totalMediaFrames: audioFrameCount * 1_152 - 576 - MPG123_DECODER_DELAY_SAMPLES,
      frameCountEvidence: 'info',
      fullyVerifiedFrameSpan: false,
      verifiedAudioFrameCount: MP3_METADATA_PREFIX_PHYSICAL_FRAMES - 1,
    });
    expect(metadata.seekPoints).toHaveLength(MP3_METADATA_PREFIX_PHYSICAL_FRAMES - 1);
    expect(metadata.seekPoints[0]).toEqual({
      rawSample: 0,
      byteOffset: frameBytes,
      frameOrdinal: 0,
      mainDataCapacityBytes: expect.any(Number),
      mainDataBeginBytes: 0,
    });
    expect(metadata.seekPoints.every((point) => point.byteOffset >= frameBytes)).toBe(true);
    expect(metadata.seekPoints.map((point) => point.frameOrdinal)).toEqual([0, 1, 2]);
    expect(metadata.vbr?.kind).toBe('xing');
    expect(metadata.vbr?.kind === 'xing' && metadata.vbr.toc).toHaveLength(100);
    expect(metadata.seekPoints).toHaveLength(3);
    expect(source.closeCount).toBe(0);

    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.id3)).toBe(true);
    expect(Object.isFrozen(metadata.vbr)).toBe(true);
    expect(Object.isFrozen(metadata.gapless)).toBe(true);
    expect(Object.isFrozen(metadata.firstAudioFrameHeader)).toBe(true);
    expect(Object.isFrozen(metadata.seekPoints)).toBe(true);
    expect(metadata.seekPoints.every(Object.isFrozen)).toBe(true);
  });

  it('fully scans a tag stream without a declared frame count and still rebases frame zero', async () => {
    const bytes = makeTaggedStream({ audioFrameCount: 8, declaredFrameCount: null });
    const frameBytes = parseMpegLayer3FrameHeader(bytes.subarray(0, 4)).frameLengthBytes;
    const metadata = await readMp3Metadata(new MemorySource(bytes), signal());

    expect(metadata).toMatchObject({
      hasTagFrame: true,
      physicalFrameCount: 9,
      audioFrameCount: 8,
      totalRawSamples: 8 * 1_152,
      frameCountEvidence: 'verified-scan',
      fullyVerifiedFrameSpan: true,
      verifiedAudioFrameCount: 8,
      verifiedAudioBytes: 8 * frameBytes,
    });
    expect(metadata.seekPoints[0]).toMatchObject({
      rawSample: 0,
      byteOffset: frameBytes,
      frameOrdinal: 0,
      mainDataBeginBytes: 0,
    });
    expect(metadata.seekPoints.at(-1)).toMatchObject({
      rawSample: 7 * 1_152,
      frameOrdinal: 7,
    });
  });

  it('treats a declared VBRI first frame as a non-PCM tag frame', async () => {
    const audioFrameCount = 6;
    const bytes = makeVbriTaggedStream(audioFrameCount);
    const tagFrameBytes = parseMpegLayer3FrameHeader(bytes.subarray(0, 4)).frameLengthBytes;
    const metadata = await readMp3Metadata(new MemorySource(bytes), signal());

    expect(metadata).toMatchObject({
      hasTagFrame: true,
      tagFrameBytes,
      firstAudioFrameOffset: tagFrameBytes,
      physicalFrameCount: audioFrameCount + 1,
      audioFrameCount,
      totalRawSamples: audioFrameCount * 1_152,
      frameCountEvidence: 'vbri',
      fullyVerifiedFrameSpan: false,
    });
    expect(metadata.seekPoints[0]).toMatchObject({
      frameOrdinal: 0,
      rawSample: 0,
      byteOffset: tagFrameBytes,
      mainDataBeginBytes: 0,
    });
    expect(metadata.gapless).toBeNull();
  });

  it('trusts a Xing audio-frame declaration without an optional stream-byte field', async () => {
    const bytes = makeTaggedStream({
      audioFrameCount: 6,
      declaredFrameCount: 6,
      declareStreamBytes: false,
    });
    const metadata = await readMp3Metadata(new MemorySource(bytes), signal());

    expect(metadata).toMatchObject({
      physicalFrameCount: 7,
      audioFrameCount: 6,
      frameCountEvidence: 'xing',
      fullyVerifiedFrameSpan: false,
    });
    expect(metadata.vbr?.streamBytes).toBeNull();
  });

  it('keeps VBR timing but omits gapless trim when the Info Tag CRC is damaged', async () => {
    const audioFrameCount = 6;
    const bytes = makeTaggedStream({
      audioFrameCount,
      declaredFrameCount: audioFrameCount,
      gapless: { delay: 576, padding: 500 },
    });
    // Default Xing layout: marker/flags at 36, then frame and byte counts.
    // The encoder field starts at 52 and its delay field starts 21 bytes later.
    bytes[73] ^= 1;
    const metadata = await readMp3Metadata(new MemorySource(bytes), signal());

    expect(metadata.vbr).toMatchObject({ kind: 'xing', frameCount: audioFrameCount });
    expect(metadata.gapless).toBeNull();
    expect(metadata.totalMediaFrames).toBe(metadata.totalRawSamples);
  });
});

describe('readMp3Metadata exact scans and bounded seeds', () => {
  it('fully verifies an ordinary MP3 with no tag metadata', async () => {
    const frames = Array.from({ length: 10 }, (_, index) => makeFrame({}, index === 0 ? 0 : 32));
    const bytes = concatenate(...frames);
    const source = new MemorySource(bytes);
    const metadata = await readMp3Metadata(source, signal());

    expect(metadata).toMatchObject({
      hasTagFrame: false,
      tagFrameOffset: null,
      tagFrameBytes: 0,
      firstAudioFrameOffset: 0,
      physicalFrameCount: 10,
      audioFrameCount: 10,
      totalRawSamples: 10 * 1_152,
      totalMediaFrames: 10 * 1_152,
      frameCountEvidence: 'verified-scan',
      fullyVerifiedFrameSpan: true,
      verifiedAudioFrameCount: 10,
      verifiedAudioBytes: bytes.byteLength,
    });
    expect(metadata.vbr).toBeNull();
    expect(metadata.gapless).toBeNull();
    expect(metadata.seekPoints).toHaveLength(10);
    expect(source.closeCount).toBe(0);
  });

  it('fails closed if the first-audio header changes between prefix and full scans', async () => {
    const frame = makeFrame();
    const bytes = new Uint8Array(frame.byteLength * 10);
    for (let ordinal = 0; ordinal < 10; ordinal += 1) {
      bytes.set(frame, ordinal * frame.byteLength);
    }
    const source = new MemorySource(bytes, 'mp3-mutating-source');
    let largeReadCount = 0;
    source.onRead = (_offset, length) => {
      if (length <= 10) return;
      largeReadCount += 1;
      if (largeReadCount === 2) bytes[frame.byteLength + 1] &= 0xfe;
    };

    await expect(readMp3Metadata(source, signal())).rejects.toThrow(
      /changed between bounded metadata scans/i,
    );
  });

  it('bounds a long full scan while preserving origin and the complete maximum prelude tail', async () => {
    const audioFrameCount = MP3_SEEK_INDEX_MAX_POINTS + 808;
    const compactFrame = makeFrame({ versionBits: 2, bitrateIndex: 1, sampleRateIndex: 1 });
    expect(compactFrame.byteLength).toBe(24);
    const bytes = new Uint8Array(compactFrame.byteLength * audioFrameCount);
    for (let ordinal = 0; ordinal < audioFrameCount; ordinal += 1) {
      bytes.set(compactFrame, ordinal * compactFrame.byteLength);
    }

    const metadata = await readMp3Metadata(new MemorySource(bytes), signal());
    const protectedTailPoints = MP3_SEEK_MAX_PROTECTED_PRELUDE_FRAMES + 1;
    const tail = metadata.seekPoints.slice(-protectedTailPoints);

    expect(metadata.audioFrameCount).toBe(audioFrameCount);
    expect(metadata.seekPoints.length).toBeLessThanOrEqual(MP3_SEEK_INDEX_MAX_POINTS);
    expect(metadata.seekPoints[0]).toMatchObject({ frameOrdinal: 0, rawSample: 0, byteOffset: 0 });
    expect(metadata.seekPoints.at(-1)).toMatchObject({
      frameOrdinal: audioFrameCount - 1,
      rawSample: (audioFrameCount - 1) * 576,
    });
    expect(tail).toHaveLength(protectedTailPoints);
    for (let index = 1; index < tail.length; index += 1) {
      expect(tail[index]?.frameOrdinal).toBe((tail[index - 1]?.frameOrdinal ?? -1) + 1);
    }
  });
});

describe('readMp3Metadata fail-closed declarations', () => {
  it('rejects a tag frame with no following audio frame', async () => {
    const tag = makeFrame();
    writeXing(tag, { frameCount: 1, streamBytes: tag.byteLength });
    await expect(readMp3Metadata(new MemorySource(tag), signal())).rejects.toThrow(
      /not followed by an audio frame/i,
    );
  });

  it('rejects a first audio frame that references reservoir bytes before audio origin', async () => {
    const bytes = makeTaggedStream({
      audioFrameCount: 5,
      declaredFrameCount: 5,
      firstAudioMainDataBeginBytes: 1,
    });
    await expect(readMp3Metadata(new MemorySource(bytes), signal())).rejects.toThrow(
      /first audio frame.*reservoir/i,
    );
  });

  it('rejects a VBR stream-byte declaration that includes the wrong physical span', async () => {
    const bytes = makeTaggedStream({
      audioFrameCount: 5,
      declaredFrameCount: 5,
      declaredStreamBytesDelta: 1,
    });
    await expect(readMp3Metadata(new MemorySource(bytes), signal())).rejects.toThrow(
      /stream byte count.*does not match/i,
    );
  });

  it('rejects incomplete-prefix frame counts that cannot fit the remaining audio span', async () => {
    const bytes = makeTaggedStream({ audioFrameCount: 5, declaredFrameCount: 100 });
    await expect(readMp3Metadata(new MemorySource(bytes), signal())).rejects.toThrow(
      /frame-count geometry|audio span is inconsistent/i,
    );
  });

  it('rejects declared counts behind an incomplete prefix and mismatching a complete prefix', async () => {
    const behind = makeTaggedStream({ audioFrameCount: 5, declaredFrameCount: 2 });
    await expect(readMp3Metadata(new MemorySource(behind), signal())).rejects.toThrow(
      /does not extend beyond/i,
    );

    const completeMismatch = makeTaggedStream({ audioFrameCount: 2, declaredFrameCount: 3 });
    await expect(readMp3Metadata(new MemorySource(completeMismatch), signal())).rejects.toThrow(
      /does not match the fully verified/i,
    );
  });

  it('wraps malformed first-frame VBR structures as MP3 metadata integrity errors', async () => {
    const tag = makeFrame();
    writeXing(tag, { flagsOverride: 0x10 });
    const bytes = concatenate(tag, makeFrame());
    await expect(readMp3Metadata(new MemorySource(bytes), signal())).rejects.toBeInstanceOf(
      Mp3MetadataError,
    );
  });
});

describe('readMp3Metadata lifecycle and repository fixtures', () => {
  it('propagates the exact abort reason before and during a full scan without closing the source', async () => {
    const before = new AbortController();
    const beforeReason = new Error('metadata-before-abort');
    before.abort(beforeReason);
    const beforeSource = new MemorySource(makeFrame());
    await expect(readMp3Metadata(beforeSource, before.signal)).rejects.toBe(beforeReason);
    expect(beforeSource.closeCount).toBe(0);

    const frame = makeFrame();
    const bytes = new Uint8Array(frame.byteLength * 200);
    for (let ordinal = 0; ordinal < 200; ordinal += 1) {
      bytes.set(frame, ordinal * frame.byteLength);
    }
    const during = new AbortController();
    const duringReason = new Error('metadata-full-scan-abort');
    const duringSource = new MemorySource(bytes, 'mp3-metadata-abort');
    let largeReadCount = 0;
    duringSource.onRead = (_offset, length) => {
      if (length <= 10) return;
      largeReadCount += 1;
      if (largeReadCount === 3) during.abort(duringReason);
    };
    await expect(readMp3Metadata(duringSource, during.signal)).rejects.toBe(duringReason);
    expect(duringSource.closeCount).toBe(0);
  });

  it.each([
    ['demo_track.mp3', 4_102, 4_101, 641, true],
    ['dummy_audio.mp3', 22, 21, 227, false],
  ] as const)(
    'normalizes the real %s tag frame without a 1,152-sample duration error',
    async (name, physicalFrameCount, audioFrameCount, firstAudioFrameOffset, hasProvenGapless) => {
      const bytes = new Uint8Array(readFileSync(resolve('public', name)));
      const metadata = await readMp3Metadata(
        new MemorySource(bytes, `mp3-repository-${name}`),
        signal(),
      );

      expect(metadata).toMatchObject({
        hasTagFrame: true,
        physicalFrameCount,
        audioFrameCount,
        firstAudioFrameOffset,
        totalRawSamples: audioFrameCount * 1_152,
        frameCountEvidence: name === 'demo_track.mp3' ? 'xing' : 'info',
      });
      expect(metadata.seekPoints[0]).toMatchObject({
        frameOrdinal: 0,
        rawSample: 0,
        byteOffset: firstAudioFrameOffset,
        mainDataBeginBytes: 0,
      });
      expect(metadata.gapless === null).toBe(!hasProvenGapless);
      expect(metadata.totalMediaFrames).toBe(
        metadata.gapless === null
          ? metadata.totalRawSamples
          : metadata.totalRawSamples -
              metadata.gapless.encoderDelaySamples -
              MPG123_DECODER_DELAY_SAMPLES -
              Math.max(metadata.gapless.endPaddingSamples - MPG123_DECODER_DELAY_SAMPLES, 0),
      );
      expect(metadata.totalMediaFrames).not.toBe(
        (audioFrameCount + 1) * 1_152 -
          (metadata.gapless === null
            ? 0
            : metadata.gapless.encoderDelaySamples +
              MPG123_DECODER_DELAY_SAMPLES +
              Math.max(metadata.gapless.endPaddingSamples - MPG123_DECODER_DELAY_SAMPLES, 0)),
      );
    },
  );
});
