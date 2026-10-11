import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { readProRoomFileDuration } from '../../../cloudflare/pro-room-media-duration.ts';

function memoryBucket(bytes: Uint8Array, logicalSize = bytes.length) {
  const get = vi.fn(
    async (_key: string, options: { range: { offset: number; length: number } }) => {
      const { offset, length } = options.range;
      const slice = new Uint8Array(length);
      slice.set(bytes.subarray(offset, Math.min(bytes.length, offset + length)));
      return {
        size: logicalSize,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(slice);
            controller.close();
          },
        }),
      };
    },
  );
  return { get };
}

describe('trusted PRO file duration from bounded R2 ranges', () => {
  it('does not open a range when its caller already cancelled metadata work', async () => {
    const controller = new AbortController();
    controller.abort();
    const bucket = memoryBucket(new Uint8Array(100));
    expect(await readProRoomFileDuration(bucket, 'object', 100, controller.signal)).toBeNull();
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it('settles immediately on caller cancellation and cancels a late object body', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    let finish!: (value: { size: number; body: ReadableStream<Uint8Array> }) => void;
    const get = vi.fn(
      () =>
        new Promise<{ size: number; body: ReadableStream<Uint8Array> }>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = readProRoomFileDuration({ get }, 'object', 100, controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
    finish({ size: 100, body: new ReadableStream<Uint8Array>({ cancel }) });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it.each([
    ['test-01.mp3', 87.48],
    ['large-audio-chirp.mp3', 5.041633],
    ['large-audio-chirp.flac', 5],
    ['large-audio-chirp-lc-stereo.m4a', 5],
    // The file's authored leading edit extends its container end timestamp.
    ['large-audio-chirp-lc-leading-edit.m4a', 6],
    ['large-audio-chirp-lc-stereo.aac', 5.03873],
  ])('reads %s without decoding audio', async (filename, seconds) => {
    const bytes = await readFile(new URL(`../../../e2e/fixtures/${filename}`, import.meta.url));
    const bucket = memoryBucket(bytes);
    expect(await readProRoomFileDuration(bucket, 'canonical-object', bytes.length)).toBeCloseTo(
      seconds,
      3,
    );
    expect(bucket.get.mock.calls.every(([key]) => key === 'canonical-object')).toBe(true);
    expect(
      bucket.get.mock.calls.reduce((sum, [, options]) => sum + options.range.length, 0),
    ).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(bucket.get.mock.calls.every(([, options]) => options.range.length <= 512 * 1024)).toBe(
      true,
    );
  });

  it('reads explicit FLAC sample counts without fetching a huge object body', async () => {
    const bytes = await readFile(
      new URL('../../../e2e/fixtures/large-audio-chirp.flac', import.meta.url),
    );
    const size = 600 * 1024 * 1024;
    const bucket = memoryBucket(bytes, size);
    expect(await readProRoomFileDuration(bucket, 'large-object', size)).toBe(5);
    expect(
      bucket.get.mock.calls.reduce((sum, [, options]) => sum + options.range.length, 0),
    ).toBeLessThan(256 * 1024);
  });

  it('does not treat garbage or zero length as a usable track duration', async () => {
    const bucket = memoryBucket(new Uint8Array(4096));
    expect(await readProRoomFileDuration(bucket, 'object', 0)).toBeNull();
    expect(bucket.get).not.toHaveBeenCalled();
    expect(await readProRoomFileDuration(bucket, 'object', 4096)).toBeNull();
  });

  it('reads PCM RIFF timing without fetching audio samples and rejects forged byte rates', async () => {
    const bytes = new Uint8Array(44);
    const view = new DataView(bytes.buffer);
    const label = (offset: number, text: string) =>
      bytes.set(new TextEncoder().encode(text), offset);
    label(0, 'RIFF');
    view.setUint32(4, 16036, true);
    label(8, 'WAVE');
    label(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 16000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    label(36, 'data');
    view.setUint32(40, 16000, true);
    const bucket = memoryBucket(bytes, 16044);
    expect(await readProRoomFileDuration(bucket, 'pcm', 16044)).toBe(1);
    expect(
      bucket.get.mock.calls.every(([, range]) => range.range.offset + range.range.length <= 44),
    ).toBe(true);
    view.setUint32(28, 1, true);
    expect(await readProRoomFileDuration(memoryBucket(bytes, 16044), 'forged', 16044)).toBeNull();
    view.setUint32(28, 16000, true);
    view.setUint16(20, 2, true);
    expect(await readProRoomFileDuration(memoryBucket(bytes, 16044), 'adpcm', 16044)).toBeNull();
  });

  it('uses RF64 ds64 sample bounds for multi-gigabyte PCM without reading its body', async () => {
    const dataBytes = 6_000_000_000;
    const size = dataBytes + 80;
    const bytes = new Uint8Array(80);
    const view = new DataView(bytes.buffer);
    const label = (offset: number, text: string) =>
      bytes.set(new TextEncoder().encode(text), offset);
    label(0, 'RF64');
    view.setUint32(4, 0xffffffff, true);
    label(8, 'WAVE');
    label(12, 'ds64');
    view.setUint32(16, 28, true);
    view.setBigUint64(20, BigInt(size - 8), true);
    view.setBigUint64(28, BigInt(dataBytes), true);
    view.setBigUint64(36, BigInt(dataBytes / 4), true);
    view.setUint32(44, 0, true);
    label(48, 'fmt ');
    view.setUint32(52, 16, true);
    view.setUint16(56, 1, true);
    view.setUint16(58, 2, true);
    view.setUint32(60, 8000, true);
    view.setUint32(64, 32000, true);
    view.setUint16(68, 4, true);
    view.setUint16(70, 16, true);
    label(72, 'data');
    view.setUint32(76, 0xffffffff, true);
    const bucket = memoryBucket(bytes, size);
    expect(await readProRoomFileDuration(bucket, 'rf64', size)).toBe(187500);
    expect(
      bucket.get.mock.calls.every(([, range]) => range.range.offset + range.range.length <= 80),
    ).toBe(true);
    view.setBigUint64(36, 1n, true);
    expect(
      await readProRoomFileDuration(memoryBucket(bytes, size), 'bad-samples', size),
    ).toBeNull();
  });

  it.each([3, 0xfffe])('supports verified IEEE float WAV encoding %s', async (encoding) => {
    const fmtLength = encoding === 0xfffe ? 40 : 16;
    const dataHeader = 20 + fmtLength;
    const bytes = new Uint8Array(dataHeader + 8);
    const size = bytes.length + 32000;
    const view = new DataView(bytes.buffer);
    const label = (offset: number, text: string) =>
      bytes.set(new TextEncoder().encode(text), offset);
    label(0, 'RIFF');
    view.setUint32(4, size - 8, true);
    label(8, 'WAVE');
    label(12, 'fmt ');
    view.setUint32(16, fmtLength, true);
    view.setUint16(20, encoding, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 32, true);
    if (encoding === 0xfffe) {
      view.setUint16(36, 22, true);
      view.setUint16(38, 32, true);
      bytes.set([3, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113], 44);
    }
    label(dataHeader, 'data');
    view.setUint32(dataHeader + 4, 32000, true);
    expect(await readProRoomFileDuration(memoryBucket(bytes, size), 'float', size)).toBe(1);
    if (encoding === 0xfffe) {
      bytes[58] = 255;
      expect(
        await readProRoomFileDuration(memoryBucket(bytes, size), 'unknown-subformat', size),
      ).toBeNull();
    }
  });

  it('rejects unknown Ogg/Matroska input without expanding malicious tag or sample counts', async () => {
    for (const magic of [
      new TextEncoder().encode('OggS'),
      new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
    ]) {
      const bytes = new Uint8Array(64).fill(255);
      bytes.set(magic);
      const bucket = memoryBucket(bytes, 600 * 1024 * 1024);
      expect(await readProRoomFileDuration(bucket, 'unknown', 600 * 1024 * 1024)).toBeNull();
      expect(bucket.get.mock.calls.length).toBeLessThanOrEqual(2);
      expect(bucket.get.mock.calls.every(([, range]) => range.range.length <= 10)).toBe(true);
    }
  });

  it('bounds hostile ADTS frame counts without allocating a declared stream duration', async () => {
    const frame = new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x00, 0xff, 0xfc]);
    const bytes = new Uint8Array(100_001 * frame.length);
    for (let offset = 0; offset < bytes.length; offset += frame.length) bytes.set(frame, offset);
    const bucket = memoryBucket(bytes);
    expect(await readProRoomFileDuration(bucket, 'many-frames', bytes.length)).toBeNull();
    expect(bucket.get.mock.calls.length).toBeLessThanOrEqual(5);
    expect(bucket.get.mock.calls.every(([, range]) => range.range.length <= 512 * 1024)).toBe(true);
  });

  it('rejects changed source size and cancels the unused body', async () => {
    const cancel = vi.fn();
    const bucket = {
      get: vi.fn(async () => ({ size: 2000, body: new ReadableStream<Uint8Array>({ cancel }) })),
    };
    expect(await readProRoomFileDuration(bucket, 'object', 1000)).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([0, 11])('rejects an incorrect first range length of %s bytes', async (length) => {
    const cancel = vi.fn();
    const bucket = {
      get: vi.fn(async () => ({
        size: 1000,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(length));
            controller.close();
          },
          cancel,
        }),
      })),
    };
    expect(await readProRoomFileDuration(bucket, 'object', 1000)).toBeNull();
  });

  it('bounds a stalled R2 body and releases its reader', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const bucket = {
        get: vi.fn(async () => ({ size: 1000, body: new ReadableStream<Uint8Array>({ cancel }) })),
      };
      const result = readProRoomFileDuration(bucket, 'object', 1000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toBeNull();
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a late body after the lookup deadline instead of continuing the probe', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      let deliver!: (value: { size: number; body: ReadableStream<Uint8Array> }) => void;
      const bucket = {
        get: vi.fn(
          () =>
            new Promise<{ size: number; body: ReadableStream<Uint8Array> }>((resolve) => {
              deliver = resolve;
            }),
        ),
      };
      const result = readProRoomFileDuration(bucket, 'object', 1000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toBeNull();
      deliver({ size: 1000, body: new ReadableStream<Uint8Array>({ cancel }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledOnce();
      expect(bucket.get).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
