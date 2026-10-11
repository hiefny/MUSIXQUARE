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
    // Cancelled work is no answer about the file.
    await expect(readProRoomFileDuration(bucket, 'object', 100, controller.signal)).rejects.toThrow(
      'PRO_MEDIA_DURATION_PROBE_ABORTED',
    );
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
    await expect(pending).rejects.toThrow('PRO_MEDIA_DURATION_PROBE_ABORTED');
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

  describe('MP3 frame-count headers that no longer describe the whole file', () => {
    const CHIRP_AUDIO_START = 44;
    const CHIRP_SCANNED_FRAMES = 194;
    const scanned = (frames: number) => (frames * 1152) / 44100;
    const concatenate = (...parts: Uint8Array[]) => {
      const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      return bytes;
    };
    const chirp = async () =>
      new Uint8Array(
        await readFile(new URL('../../../e2e/fixtures/large-audio-chirp.mp3', import.meta.url)),
      );

    it('scans a joined file instead of trusting the first part Xing frame and byte count', async () => {
      const first = await chirp();
      const bytes = concatenate(first, first.subarray(CHIRP_AUDIO_START));
      expect(
        await readProRoomFileDuration(memoryBucket(bytes), 'joined', bytes.length),
      ).toBeCloseTo(scanned(CHIRP_SCANNED_FRAMES * 2), 6);
    });

    it.each([
      // Within 1/16 of the audio span both conventions describe the same file.
      ['trusts', 2_000, 5.041633],
      // Beyond it, a VBR count cannot tell its own tag from an appended part
      // of about the same size, so the bounded scan measures the stream.
      ['scans', 20_000, scanned(CHIRP_SCANNED_FRAMES)],
    ])(
      '%s a VBR stream size that also counts a %i-byte leading ID3 tag',
      async (_label, tagBytes, seconds) => {
        const original = await chirp();
        const tag = new Uint8Array(10 + tagBytes);
        tag.set(new TextEncoder().encode('ID3'));
        tag.set([3, 0, 0], 3);
        tag.set(
          [(tagBytes >> 21) & 127, (tagBytes >> 14) & 127, (tagBytes >> 7) & 127, tagBytes & 127],
          6,
        );
        const audio = original.slice(CHIRP_AUDIO_START);
        const bytes = concatenate(tag, audio);
        new DataView(bytes.buffer).setUint32(tag.length + 36 + 12, bytes.length);
        expect(
          await readProRoomFileDuration(memoryBucket(bytes), 'tagged', bytes.length),
        ).toBeCloseTo(seconds, 6);
      },
    );

    it('does not let a large leading ID3 tag widen the stream size tolerance of a joined file', async () => {
      const frameBytes = 417; // MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding.
      const frame = () => {
        const bytes = new Uint8Array(frameBytes);
        bytes.set([0xff, 0xfb, 0x90, 0x64]);
        return bytes;
      };
      const tagBytes = 2 * 1024 * 1024;
      const tag = new Uint8Array(10 + tagBytes);
      tag.set(new TextEncoder().encode('ID3'));
      tag.set([3, 0, 0], 3);
      tag.set(
        [(tagBytes >> 21) & 127, (tagBytes >> 14) & 127, (tagBytes >> 7) & 127, tagBytes & 127],
        6,
      );
      const xing = frame();
      xing.set(new TextEncoder().encode('Xing'), 36);
      const view = new DataView(xing.buffer);
      view.setUint32(40, 0x3);
      view.setUint32(44, 7180);
      // The first part's whole-file size, as some encoders count it.
      view.setUint32(48, tag.length + 7181 * frameBytes);
      const bytes = concatenate(
        tag,
        xing,
        ...Array.from({ length: 7180 + 700 }, frame), // 700 appended tagless frames.
      );
      expect(
        await readProRoomFileDuration(memoryBucket(bytes), 'tagged-joined', bytes.length),
      ).toBeCloseTo(scanned(7881), 6);
    });

    describe('frame counts behind a leading ID3 tag larger than the tolerance', () => {
      // MPEG-1 Layer III at 44.1 kHz. Unpadded frames are enough for a scan;
      // the CBR stream below pads like an encoder to the exact average length.
      const encoder = new TextEncoder();
      const KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192];
      const frame = (bitrateIndex = 9, padded = false) => {
        const bytes = new Uint8Array(
          Math.floor((144000 * KBPS[bitrateIndex]!) / 44100) + (padded ? 1 : 0),
        );
        bytes.set([0xff, 0xfb, (bitrateIndex << 4) | (padded ? 2 : 0), 0x64]);
        return bytes;
      };
      const header = (magic: 'Xing' | 'Info', frames: number, streamBytes: number) => {
        const bytes = frame();
        bytes.set(encoder.encode(magic), 36);
        const view = new DataView(bytes.buffer);
        view.setUint32(40, 0x3);
        view.setUint32(44, frames);
        view.setUint32(48, streamBytes);
        return bytes;
      };
      const coverArt = () => {
        const tagBytes = 2 * 1024 * 1024;
        const tag = new Uint8Array(10 + tagBytes);
        tag.set(encoder.encode('ID3'));
        tag.set([3, 0, 0], 3);
        tag.set(
          [(tagBytes >> 21) & 127, (tagBytes >> 14) & 127, (tagBytes >> 7) & 127, tagBytes & 127],
          6,
        );
        return tag;
      };
      const read = (bytes: Uint8Array) =>
        readProRoomFileDuration(memoryBucket(bytes), 'cover-art', bytes.length);

      // The first part's header counts its 7180 frames and, as some encoders
      // do, the whole first file including the tag. An appended part about the
      // tag's size makes that byte count match the joined audio span as well.
      it.each([
        ['Xing', 4429],
        ['Xing', 5029],
        ['Xing', 5629],
        ['Info', 4429],
        ['Info', 5029],
        ['Info', 5629],
      ] as const)(
        'scans instead of trusting a stale %s count followed by %i appended frames',
        async (magic, appended) => {
          const tag = coverArt();
          const bytes = concatenate(
            tag,
            header(magic, 7180, tag.length + 7181 * 417),
            ...Array.from({ length: 7180 + appended }, () => frame()),
          );
          expect(await read(bytes)).toBeCloseTo(scanned(7181 + appended), 6);
        },
      );

      it.each([
        ['also counts', true],
        ['excludes', false],
      ])(
        'still indexes a CBR Info count whose stream size %s the cover art',
        async (_label, countsTag) => {
          const frames = 3_000;
          // An encoder pads frames so the stream keeps the exact 128 kbps average.
          const exact = (count: number) => Math.floor((count * 144000 * 128) / 44100);
          const audio = Array.from({ length: frames }, (_, index) =>
            frame(9, exact(index + 2) - exact(index + 1) === 418),
          );
          const streamBytes = 417 + audio.reduce((sum, part) => sum + part.length, 0);
          const tag = coverArt();
          const bytes = concatenate(
            tag,
            header('Info', frames, streamBytes + (countsTag ? tag.length : 0)),
            ...audio,
          );
          // A scan would also count the header frame; only the index is exact.
          expect(await read(bytes)).toBe((frames * 1152) / 44100);
        },
      );

      it('measures a VBR Xing stream behind cover art by scanning within the read budget', async () => {
        const audio = Array.from({ length: 4_000 }, (_, index) => frame(index % 3 ? 9 : 11));
        const streamBytes = 417 + audio.reduce((sum, part) => sum + part.length, 0);
        const tag = coverArt();
        const bytes = concatenate(tag, header('Xing', 4_000, tag.length + streamBytes), ...audio);
        const bucket = memoryBucket(bytes);
        expect(await readProRoomFileDuration(bucket, 'vbr-cover-art', bytes.length)).toBeCloseTo(
          scanned(4_001),
          6,
        );
        expect(
          bucket.get.mock.calls.reduce((sum, [, options]) => sum + options.range.length, 0),
        ).toBeLessThanOrEqual(16 * 1024 * 1024);
      });
    });

    it('leaves a joined file unknown when its continuation cannot be scanned', async () => {
      const first = await chirp();
      // `cat a.mp3 b.mp3` keeps the second ID3 tag inside the MPEG stream.
      const bytes = concatenate(first, first);
      expect(await readProRoomFileDuration(memoryBucket(bytes), 'cat', bytes.length)).toBeNull();
    });

    it('rejects a frame count too small for the file even without a declared byte count', async () => {
      const first = await chirp();
      const xingFlags = CHIRP_AUDIO_START + 36 + 4;
      const header = first.slice();
      new DataView(header.buffer).setUint32(xingFlags, 0x1);
      const continuation = first.subarray(CHIRP_AUDIO_START);
      const bytes = concatenate(header, ...Array.from({ length: 6 }, () => continuation));
      expect(
        await readProRoomFileDuration(memoryBucket(bytes), 'frames-only', bytes.length),
      ).toBeCloseTo(scanned(CHIRP_SCANNED_FRAMES * 7), 6);
      // The same header remains authoritative for the file it actually describes.
      expect(
        await readProRoomFileDuration(memoryBucket(header), 'frames-only-exact', header.length),
      ).toBeCloseTo(5.041633, 6);
    });

    it('applies the same consistency rule to Fraunhofer VBRI headers', async () => {
      const frameBytes = 417; // MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding.
      const frame = () => {
        const bytes = new Uint8Array(frameBytes);
        bytes.set([0xff, 0xfb, 0x90, 0x64]);
        return bytes;
      };
      const vbri = (frames: number, streamBytes: number) => {
        const bytes = frame();
        bytes.set(new TextEncoder().encode('VBRI'), 36);
        const view = new DataView(bytes.buffer);
        view.setUint32(46, streamBytes);
        view.setUint32(50, frames);
        return bytes;
      };
      const audio = Array.from({ length: 29 }, frame);
      const exact = concatenate(vbri(29, 30 * frameBytes), ...audio);
      expect(await readProRoomFileDuration(memoryBucket(exact), 'vbri', exact.length)).toBe(
        scanned(29),
      );
      const joined = concatenate(vbri(9, 10 * frameBytes), ...audio);
      expect(
        await readProRoomFileDuration(memoryBucket(joined), 'vbri-joined', joined.length),
      ).toBeCloseTo(scanned(30), 6);
    });

    describe('VBRI stream byte counts', () => {
      // At 128 kbps the largest-frame bound alone admits counts far below the
      // 29 audio frames here, so only the declared byte count can refuse them.
      const frameBytes = 417;
      const frame = () => {
        const bytes = new Uint8Array(frameBytes);
        bytes.set([0xff, 0xfb, 0x90, 0x64]);
        return bytes;
      };
      const vbri = (frames: number, streamBytes: number) => {
        const bytes = frame();
        bytes.set(new TextEncoder().encode('VBRI'), 36);
        const view = new DataView(bytes.buffer);
        view.setUint32(46, streamBytes);
        view.setUint32(50, frames);
        return bytes;
      };
      const read = (...parts: Uint8Array[]) => {
        const bytes = concatenate(...parts);
        return readProRoomFileDuration(memoryBucket(bytes), 'vbri-bytes', bytes.length);
      };
      const audio = () => Array.from({ length: 29 }, frame);
      const id3 = (tagBytes: number) => {
        const tag = new Uint8Array(10 + tagBytes);
        tag.set(new TextEncoder().encode('ID3'));
        tag.set([3, 0, 0, 0, 0, tagBytes >> 7, tagBytes & 127], 3);
        return tag;
      };

      it.each([
        ['matches the audio span within 1/16', 0, 30 * frameBytes + 700],
        ['also counts a leading ID3 tag within 1/16', 700, 710 + 30 * frameBytes],
      ])('trusts a frame count whose byte count %s', async (_label, tagBytes, streamBytes) => {
        const tag = tagBytes ? [id3(tagBytes)] : [];
        expect(await read(...tag, vbri(29, streamBytes), ...audio())).toBe(scanned(29));
      });

      it('scans when a leading ID3 tag beyond 1/16 makes the byte count ambiguous', async () => {
        expect(await read(id3(1_000), vbri(29, 1_010 + 30 * frameBytes), ...audio())).toBeCloseTo(
          scanned(30),
          6,
        );
      });

      it.each([
        ['describes a shorter first part', 25, 26 * frameBytes],
        ['exceeds the audio span by more than 1/16', 29, 30 * frameBytes + 800],
        ['falls short of the audio span by more than 1/16', 29, 28 * frameBytes],
      ])('scans instead of trusting a byte count that %s', async (_label, frames, streamBytes) => {
        expect(await read(vbri(frames, streamBytes), ...audio())).toBeCloseTo(scanned(30), 6);
      });

      it('stays unknown when a refused count leaves an unscannable continuation', async () => {
        expect(await read(vbri(25, 26 * frameBytes), ...audio(), new Uint8Array(500))).toBeNull();
      });
    });
  });

  describe('320 kbps CBR MP3 with trailing tags', () => {
    const FRAMES = 2_000;
    const encoder = new TextEncoder();
    const concatenate = (...parts: Uint8Array[]) => {
      const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      return bytes;
    };
    // MPEG-1 Layer III at 320 kbps / 44.1 kHz pads frames to average 1044.898
    // bytes, so the largest frame (1045) leaves almost no slack for trailers.
    const frame = (index: number) => {
      const exact = (count: number) => Math.floor((count * 144000 * 320) / 44100);
      const bytes = new Uint8Array(exact(index + 1) - exact(index));
      bytes.set([0xff, 0xfb, bytes.length === 1045 ? 0xe2 : 0xe0, 0x64]);
      return bytes;
    };
    const stream = (info: boolean) => {
      const audio = Array.from({ length: FRAMES }, (_, index) => frame(index + 1));
      if (!info) return concatenate(...audio);
      const header = frame(0);
      header.set(encoder.encode('Info'), 36);
      const view = new DataView(header.buffer);
      view.setUint32(40, 0x3);
      view.setUint32(44, FRAMES);
      view.setUint32(48, header.length + audio.reduce((sum, part) => sum + part.length, 0));
      return concatenate(header, ...audio);
    };
    const id3v1 = () => {
      const bytes = new Uint8Array(128);
      bytes.set(encoder.encode('TAGtitle'));
      return bytes;
    };
    const ape = (bytes: number, options: { header?: boolean; version?: number } = {}) => {
      const header = options.header ?? true;
      const tag = new Uint8Array(bytes);
      const item = header ? 32 : 0;
      const key = encoder.encode('Comment\0');
      // One text item fills the space between the header and the footer.
      new DataView(tag.buffer).setUint32(item, bytes - item - 32 - 8 - key.length, true);
      tag.set(key, item + 8);
      const block = (offset: number, flags: number) => {
        tag.set(encoder.encode('APETAGEX'), offset);
        const view = new DataView(tag.buffer, offset, 32);
        view.setUint32(8, options.version ?? 2000, true);
        view.setUint32(12, bytes - (header ? 32 : 0), true); // Excludes the header.
        view.setUint32(16, 1, true);
        view.setUint32(20, flags >>> 0, true);
      };
      if (header) block(0, 0xa0000000);
      block(bytes - 32, header ? 0x80000000 : 0);
      return tag;
    };
    const lyrics3 = (lyrics: number, digits?: string) => {
      const body = encoder.encode(
        `LYRICSBEGINLYR${String(lyrics).padStart(5, '0')}${'x'.repeat(lyrics)}`,
      );
      return concatenate(
        body,
        encoder.encode(`${digits ?? String(body.length).padStart(6, '0')}LYRICS200`),
      );
    };
    const appendedId3v2 = (bytes: number) => {
      const tag = new Uint8Array(bytes);
      const size = bytes - 20;
      const block = (offset: number, magic: string) => {
        tag.set(encoder.encode(magic), offset);
        tag.set(
          [4, 0, 0x10, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127],
          offset + 3,
        );
        tag[offset + 9] = size & 127;
      };
      block(0, 'ID3');
      block(bytes - 10, '3DI');
      return tag;
    };
    const read = (bytes: Uint8Array) =>
      readProRoomFileDuration(memoryBucket(bytes), 'cbr', bytes.length);

    it.each([
      ['ID3v1', () => [id3v1()]],
      ['APEv2 and ID3v1', () => [ape(1000), id3v1()]],
      ['APEv2 without a header', () => [ape(1000, { header: false })]],
      ['Lyrics3v2 and ID3v1', () => [lyrics3(900), id3v1()]],
      ['APEv2, Lyrics3v2 and ID3v1', () => [lyrics3(900), ape(1000), id3v1()]],
      ['an appended 4 KB ID3v2.4 tag', () => [appendedId3v2(4096)]],
    ])('reads the header and scans the frames before %s', async (_label, trailers) => {
      const indexed = concatenate(stream(true), ...trailers());
      expect(await read(indexed)).toBeCloseTo((FRAMES * 1152) / 44100, 6);
      const scanned = concatenate(stream(false), ...trailers());
      expect(await read(scanned)).toBeCloseTo((FRAMES * 1152) / 44100, 6);
    });

    it.each([
      ['an unknown APE version', () => [ape(1000, { version: 3000 }), id3v1()]],
      ['an APE header flag without a header', () => [ape(1000).subarray(32), id3v1()]],
      [
        'an APE size reaching into the audio',
        () => {
          const tag = ape(1000, { header: false });
          new DataView(tag.buffer).setUint32(1000 - 32 + 12, 1000 + 50 * 1045, true);
          return [tag, id3v1()];
        },
      ],
      ['a non-numeric Lyrics3v2 size', () => [lyrics3(900, '00091x'), id3v1()]],
      ['a Lyrics3v2 size that misses its start', () => [lyrics3(900, '000918'), id3v1()]],
      [
        'an appended ID3v2 footer without its header',
        () => [new Uint8Array(4086), appendedId3v2(4096).subarray(4086)],
      ],
    ])('leaves %s inside the audio span', async (_label, trailers) => {
      expect(await read(concatenate(stream(true), ...trailers()))).toBeNull();
      expect(await read(concatenate(stream(false), ...trailers()))).toBeNull();
    });
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
    await expect(readProRoomFileDuration(bucket, 'object', 1000)).rejects.toThrow(
      'PRO_MEDIA_DURATION_SOURCE_CHANGED',
    );
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
    await expect(readProRoomFileDuration(bucket, 'object', 1000)).rejects.toThrow(
      length ? 'PRO_MEDIA_DURATION_RANGE_OVERRUN' : 'PRO_MEDIA_DURATION_RANGE_TRUNCATED',
    );
  });

  it.each([
    ['an R2 error', () => Promise.reject(new Error('R2 unavailable'))],
    ['a missing object', () => Promise.resolve(null)],
    ['an object without a body', () => Promise.resolve({ size: 1000 })],
  ])('fails instead of answering unknown on %s', async (_label, get) => {
    await expect(readProRoomFileDuration({ get: vi.fn(get) }, 'object', 1000)).rejects.toThrow();
  });

  it('fails when a parser turned a failed range read into an unknown result', async () => {
    const bytes = await readFile(
      new URL('../../../e2e/fixtures/large-audio-chirp-lc-stereo.m4a', import.meta.url),
    );
    const healthy = memoryBucket(bytes);
    let calls = 0;
    const get = vi.fn(
      async (key: string, options: { range: { offset: number; length: number } }) =>
        ++calls > 2 ? Promise.reject(new Error('R2 unavailable')) : healthy.get(key, options),
    );
    // The MP4 reader catches its own errors; the failed read still counts.
    await expect(readProRoomFileDuration({ get }, 'object', bytes.length)).rejects.toThrow(
      'PRO_MEDIA_DURATION_READ_FAILED',
    );
    expect(await readProRoomFileDuration(healthy, 'object', bytes.length)).toBe(5);
  });

  it('answers unknown, not failed, for a stream beyond the read budget', async () => {
    // 17 MiB of unindexed 128 kbps frames: the bounded scan stops at 16 MiB.
    const frames = Math.ceil((17 * 1024 * 1024) / 417);
    const bytes = new Uint8Array(frames * 417);
    for (let offset = 0; offset < bytes.length; offset += 417)
      bytes.set([0xff, 0xfb, 0x90, 0x64], offset);
    expect(await readProRoomFileDuration(memoryBucket(bytes), 'long', bytes.length)).toBeNull();
  });

  it('bounds a stalled R2 body and releases its reader', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const bucket = {
        get: vi.fn(async () => ({ size: 1000, body: new ReadableStream<Uint8Array>({ cancel }) })),
      };
      const result = expect(readProRoomFileDuration(bucket, 'object', 1000)).rejects.toThrow(
        'PRO_MEDIA_DURATION_PROBE_TIMEOUT',
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
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
      const result = expect(readProRoomFileDuration(bucket, 'object', 1000)).rejects.toThrow(
        'PRO_MEDIA_DURATION_PROBE_TIMEOUT',
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
      deliver({ size: 1000, body: new ReadableStream<Uint8Array>({ cancel }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledOnce();
      expect(bucket.get).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
