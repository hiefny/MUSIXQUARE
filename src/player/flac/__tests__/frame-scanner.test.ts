import { describe, expect, it, vi } from 'vitest';

import {
  NativeFlacFrameError,
  NativeFlacFrameReader,
  flacCrc16,
  flacCrc8,
  parseNativeFlacFrameHeader,
  probeNativeFlacFramePoints,
  type NativeFlacChunkReader,
  type NativeFlacReaderStreamInfo,
} from '../frame-scanner.ts';

const BASE_INFO: NativeFlacReaderStreamInfo = Object.freeze({
  sampleRate: 44_100,
  channels: 2,
  bitDepth: 16,
  maxBlockSize: 4_096,
  minFrameSize: 0,
  maxFrameSize: 1_048_576,
});

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function encodeCodedNumber(value: number): Uint8Array {
  const number = BigInt(value);
  const length =
    number <= 0x7fn
      ? 1
      : number <= 0x7ffn
        ? 2
        : number <= 0xffffn
          ? 3
          : number <= 0x1f_ffffn
            ? 4
            : number <= 0x3ff_ffffn
              ? 5
              : number <= 0x7fff_ffffn
                ? 6
                : 7;
  const bytes = new Uint8Array(length);
  if (length === 1) {
    bytes[0] = Number(number);
    return bytes;
  }
  let remainder = number;
  for (let index = length - 1; index >= 1; index -= 1) {
    bytes[index] = 0x80 | Number(remainder & 0x3fn);
    remainder >>= 6n;
  }
  const prefixes = [0, 0, 0xc0, 0xe0, 0xf0, 0xf8, 0xfc, 0xfe];
  bytes[0] = (prefixes[length] ?? 0) | Number(remainder);
  return bytes;
}

interface HeaderOptions {
  readonly blocking?: 0 | 1;
  readonly codedNumber?: number;
  readonly codedBytes?: Uint8Array;
  readonly blockSizeCode?: number;
  readonly blockSizeExtra?: number;
  readonly sampleRateCode?: number;
  readonly sampleRateExtra?: number;
  readonly channelAssignment?: number;
  readonly bitDepthCode?: number;
  readonly reservedBit?: 0 | 1;
}

function makeHeader(options: HeaderOptions = {}): Uint8Array {
  const blocking = options.blocking ?? 0;
  const blockSizeCode = options.blockSizeCode ?? 12;
  const sampleRateCode = options.sampleRateCode ?? 9;
  const channelAssignment = options.channelAssignment ?? 1;
  const bitDepthCode = options.bitDepthCode ?? 4;
  const parts: number[] = [
    0xff,
    0xf8 | blocking,
    (blockSizeCode << 4) | sampleRateCode,
    (channelAssignment << 4) | (bitDepthCode << 1) | (options.reservedBit ?? 0),
    ...(options.codedBytes ?? encodeCodedNumber(options.codedNumber ?? 0)),
  ];

  if (blockSizeCode === 6) {
    parts.push(options.blockSizeExtra ?? 0);
  } else if (blockSizeCode === 7) {
    const extra = options.blockSizeExtra ?? 4_095;
    parts.push(extra >>> 8, extra & 0xff);
  }
  if (sampleRateCode === 12) {
    parts.push(options.sampleRateExtra ?? 44);
  } else if (sampleRateCode === 13 || sampleRateCode === 14) {
    const extra = options.sampleRateExtra ?? (sampleRateCode === 14 ? 4_410 : 44_100);
    parts.push(extra >>> 8, extra & 0xff);
  }

  const withoutCrc = Uint8Array.from(parts);
  return concatenate(withoutCrc, Uint8Array.of(flacCrc8(withoutCrc)));
}

function makeFrame(
  options: HeaderOptions = {},
  payload = Uint8Array.of(0x02, 0x04, 0x06),
): Uint8Array {
  const withoutFooter = concatenate(makeHeader(options), payload);
  const crc = flacCrc16(withoutFooter);
  return concatenate(withoutFooter, Uint8Array.of(crc >>> 8, crc & 0xff));
}

function memoryReader(
  bytes: Uint8Array,
  maximumPerRead = Number.MAX_SAFE_INTEGER,
): NativeFlacChunkReader {
  return vi.fn(async (offset: number, maximumBytes: number, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const length = Math.min(maximumBytes, maximumPerRead, Math.max(0, bytes.byteLength - offset));
    return bytes.slice(offset, offset + length);
  });
}

describe('native FLAC frame header parser', () => {
  it('parses a CRC-verified fixed-block header and derives its absolute sample', () => {
    const headerBytes = makeHeader({ codedNumber: 3 });
    const header = parseNativeFlacFrameHeader(headerBytes, 0, BASE_INFO);

    expect(header).toMatchObject({
      blockingStrategy: 'fixed',
      codedNumber: 3,
      absoluteSourceSample: 12_288,
      blockSize: 4_096,
      sampleRate: 44_100,
      channels: 2,
      channelAssignment: 1,
      bitDepth: 16,
      headerSize: headerBytes.byteLength,
    });
    expect(flacCrc8(headerBytes)).toBe(0);
  });

  it('parses a seven-byte variable sample number and uncommon block/rate fields', () => {
    const codedNumber = 0x1_2345_6789;
    const headerBytes = makeHeader({
      blocking: 1,
      codedNumber,
      blockSizeCode: 7,
      blockSizeExtra: 4_095,
      sampleRateCode: 14,
      sampleRateExtra: 4_410,
      channelAssignment: 10,
      bitDepthCode: 0,
    });
    const header = parseNativeFlacFrameHeader(headerBytes, 0, BASE_INFO);

    expect(header).toMatchObject({
      blockingStrategy: 'variable',
      codedNumber,
      absoluteSourceSample: codedNumber,
      blockSize: 4_096,
      sampleRate: 44_100,
      channels: 2,
      channelAssignment: 10,
      bitDepth: 16,
    });
  });

  it('rejects non-canonical coded numbers and fixed frame numbers over 31 bits', () => {
    const overlong = makeHeader({ codedBytes: Uint8Array.of(0xc0, 0x80) });
    expect(() => parseNativeFlacFrameHeader(overlong, 0, BASE_INFO)).toThrow(/canonically/);

    const sevenByteFixed = makeHeader({ codedNumber: 0x8000_0000 });
    expect(() => parseNativeFlacFrameHeader(sevenByteFixed, 0, BASE_INFO)).toThrow(
      /fixed-block frame number/,
    );
  });

  it('rejects corrupt header CRCs, reserved fields, and STREAMINFO mismatches', () => {
    const corruptCrc = makeHeader();
    corruptCrc[corruptCrc.byteLength - 1] ^= 1;
    expect(() => parseNativeFlacFrameHeader(corruptCrc, 0, BASE_INFO)).toThrow(/CRC-8/);

    expect(() => parseNativeFlacFrameHeader(makeHeader({ reservedBit: 1 }), 0, BASE_INFO)).toThrow(
      /reserved bit/,
    );
    expect(() =>
      parseNativeFlacFrameHeader(makeHeader({ sampleRateCode: 10 }), 0, BASE_INFO),
    ).toThrow(/sample rate differs/);
    expect(() =>
      parseNativeFlacFrameHeader(makeHeader({ channelAssignment: 0 }), 0, BASE_INFO),
    ).toThrow(/channel count differs/);
    expect(() => parseNativeFlacFrameHeader(makeHeader({ bitDepthCode: 6 }), 0, BASE_INFO)).toThrow(
      /bit depth differs/,
    );
  });
});

describe('NativeFlacFrameReader', () => {
  it('reads across arbitrary chunk boundaries and validates the EOF frame', async () => {
    const prefix = Uint8Array.of(9, 8, 7, 6, 5);
    const first = makeFrame({ codedNumber: 0 }, new Uint8Array(101).fill(0x31));
    const second = makeFrame({ codedNumber: 1 }, new Uint8Array(79).fill(0x42));
    const source = concatenate(prefix, first, second);
    const reader = new NativeFlacFrameReader({
      readChunk: memoryReader(source, 3),
      startByteOffset: prefix.byteLength,
      streamInfo: BASE_INFO,
      readSize: 7,
    });

    const decodedFirst = await reader.next();
    const decodedSecond = await reader.next();
    expect(decodedFirst?.byteOffset).toBe(prefix.byteLength);
    expect(decodedFirst?.absoluteSourceSample).toBe(0);
    expect(decodedFirst?.data).toEqual(first);
    expect(decodedSecond?.byteOffset).toBe(prefix.byteLength + first.byteLength);
    expect(decodedSecond?.absoluteSourceSample).toBe(4_096);
    expect(decodedSecond?.data).toEqual(second);
    expect(await reader.next()).toBeNull();
  });

  it('ignores a CRC-8-valid false sync embedded in payload', async () => {
    const falseHeader = makeHeader({ codedNumber: 1 });
    let payload = concatenate(Uint8Array.of(0x11), falseHeader, Uint8Array.of(0x22, 0x33, 0x44));
    let first = makeFrame({ codedNumber: 0 }, payload);
    const falseBoundary = makeHeader({ codedNumber: 0 }).byteLength + 1;
    if (flacCrc16(first, 0, falseBoundary) === 0) {
      payload = concatenate(Uint8Array.of(0x12), falseHeader, Uint8Array.of(0x22, 0x33, 0x44));
      first = makeFrame({ codedNumber: 0 }, payload);
    }
    const second = makeFrame({ codedNumber: 1 });
    const reader = new NativeFlacFrameReader({
      readChunk: memoryReader(concatenate(first, second), 11),
      startByteOffset: 0,
      streamInfo: BASE_INFO,
    });

    expect((await reader.next())?.data).toEqual(first);
    expect((await reader.next())?.data).toEqual(second);
  });

  it('accepts a valid frame larger than 512 KiB without whole-file buffering', async () => {
    const payload = new Uint8Array(600 * 1024);
    for (let index = 0; index < payload.byteLength; index += 1) payload[index] = index & 0xff;
    const frame = makeFrame({ codedNumber: 0 }, payload);
    const streamInfo = { ...BASE_INFO, maxFrameSize: frame.byteLength };
    const readChunk = memoryReader(frame, 8_191);
    const reader = new NativeFlacFrameReader({
      readChunk,
      startByteOffset: 0,
      streamInfo,
      readSize: 32 * 1024,
    });

    const result = await reader.next();
    expect(result?.data.byteLength).toBe(frame.byteLength);
    expect(result?.data.subarray(0, 32)).toEqual(frame.subarray(0, 32));
    expect(result?.data.subarray(-32)).toEqual(frame.subarray(-32));
    expect(flacCrc16(result?.data ?? new Uint8Array())).toBe(0);
    expect(readChunk).toHaveBeenCalledTimes(Math.ceil(frame.byteLength / 8_191) + 1);
  });

  it('accepts a frame exactly equal to the declared maximum before another frame', async () => {
    const headerSize = makeHeader({ codedNumber: 0 }).byteLength;
    const declaredMaximum = 128;
    const first = makeFrame(
      { codedNumber: 0 },
      new Uint8Array(declaredMaximum - headerSize - 2).fill(0x29),
    );
    const second = makeFrame({ codedNumber: 1 });
    expect(first.byteLength).toBe(declaredMaximum);
    const reader = new NativeFlacFrameReader({
      readChunk: memoryReader(concatenate(first, second)),
      startByteOffset: 0,
      streamInfo: { ...BASE_INFO, maxFrameSize: declaredMaximum },
      readSize: declaredMaximum + 16,
    });

    expect((await reader.next())?.data).toEqual(first);
    expect((await reader.next())?.data).toEqual(second);
  });

  it('enforces the explicit product cap when STREAMINFO has no maximum', async () => {
    const frame = makeFrame({ codedNumber: 0 }, new Uint8Array(256).fill(0x5a));
    const unknownBounds = { ...BASE_INFO, minFrameSize: 0, maxFrameSize: 0 };

    expect(
      () =>
        new NativeFlacFrameReader({
          readChunk: memoryReader(frame),
          startByteOffset: 0,
          streamInfo: unknownBounds,
        }),
    ).toThrow(/product max frame size/);
    expect(
      () =>
        new NativeFlacFrameReader({
          readChunk: memoryReader(frame),
          startByteOffset: 0,
          streamInfo: unknownBounds,
          productMaxFrameSize: 0x1_000000,
        }),
    ).toThrow(/product max frame size/);

    const reader = new NativeFlacFrameReader({
      readChunk: memoryReader(frame),
      startByteOffset: 0,
      streamInfo: unknownBounds,
      productMaxFrameSize: 128,
    });
    await expect(reader.next()).rejects.toThrow(/exceeds the effective maximum/);
  });

  it('rejects corrupt frame CRCs and declared frame-size bounds', async () => {
    const first = makeFrame({ codedNumber: 0 }, new Uint8Array(33).fill(0x17));
    const second = makeFrame({ codedNumber: 1 });
    first[first.byteLength - 1] ^= 1;
    const corruptReader = new NativeFlacFrameReader({
      readChunk: memoryReader(concatenate(first, second), 17),
      startByteOffset: 0,
      streamInfo: BASE_INFO,
    });
    await expect(corruptReader.next()).rejects.toThrow(/CRC-16/);

    const finalFrame = makeFrame();
    const sizeReader = new NativeFlacFrameReader({
      readChunk: memoryReader(finalFrame),
      startByteOffset: 0,
      streamInfo: { ...BASE_INFO, minFrameSize: finalFrame.byteLength + 1 },
    });
    await expect(sizeReader.next()).rejects.toThrow(/size or CRC-16/);
  });

  it('permits sub-16-sample blocks only for the final frame', async () => {
    const shortFinal = makeFrame({ blockSizeCode: 6, blockSizeExtra: 0 });
    const finalReader = new NativeFlacFrameReader({
      readChunk: memoryReader(shortFinal, 2),
      startByteOffset: 0,
      streamInfo: BASE_INFO,
    });
    expect((await finalReader.next())?.blockSize).toBe(1);

    const followed = concatenate(shortFinal, makeFrame({ codedNumber: 1 }));
    const nonFinalReader = new NativeFlacFrameReader({
      readChunk: memoryReader(followed),
      startByteOffset: 0,
      streamInfo: BASE_INFO,
    });
    await expect(nonFinalReader.next()).rejects.toThrow(NativeFlacFrameError);
  });

  it('passes the AbortSignal through without replacing its cancellation reason', async () => {
    const controller = new AbortController();
    const reason = new DOMException('cancel test', 'AbortError');
    const readChunk: NativeFlacChunkReader = vi.fn(async (_offset, _length, signal) => {
      controller.abort(reason);
      signal?.throwIfAborted();
      return new Uint8Array();
    });
    const reader = new NativeFlacFrameReader({
      readChunk,
      startByteOffset: 0,
      streamInfo: BASE_INFO,
    });

    await expect(reader.next(controller.signal)).rejects.toBe(reason);
    expect(readChunk).toHaveBeenCalledWith(0, expect.any(Number), controller.signal);
  });
});

describe('probeNativeFlacFramePoints', () => {
  it('returns only CRC-verified consecutive frame points and can verify an EOF frame', () => {
    const prefix = Uint8Array.of(0x00, 0xff, 0xf8, 0x00, 0x19);
    const first = makeFrame({ codedNumber: 0 }, new Uint8Array(27).fill(1));
    const second = makeFrame({ codedNumber: 1 }, new Uint8Array(35).fill(2));
    const third = makeFrame({ codedNumber: 2 }, new Uint8Array(41).fill(3));
    const window = concatenate(prefix, first, second, third);

    const points = probeNativeFlacFramePoints(window, 10_000, BASE_INFO);
    expect(points.map((point) => point.byteOffset)).toEqual([
      10_000 + prefix.byteLength,
      10_000 + prefix.byteLength + first.byteLength,
    ]);
    expect(points.map((point) => point.absoluteSourceSample)).toEqual([0, 4_096]);

    const withEof = probeNativeFlacFramePoints(window, 10_000, BASE_INFO, {
      windowEndsAtEof: true,
    });
    expect(withEof.map((point) => point.absoluteSourceSample)).toEqual([0, 4_096, 8_192]);
  });

  it('does not promote a frame whose footer CRC is corrupt', () => {
    const first = makeFrame({ codedNumber: 0 });
    const second = makeFrame({ codedNumber: 1 });
    const third = makeFrame({ codedNumber: 2 });
    first[first.byteLength - 2] ^= 1;

    const points = probeNativeFlacFramePoints(concatenate(first, second, third), 0, BASE_INFO);
    expect(points.map((point) => point.absoluteSourceSample)).toEqual([4_096]);
  });
});
