import { describe, expect, it, vi } from 'vitest';
import { readAacContainerTiming } from '../aac-container-timing.ts';

const CONFIG: AudioDecoderConfig = {
  codec: 'mp4a.40.2',
  sampleRate: 44100,
  numberOfChannels: 2,
  description: new Uint8Array([18, 16, 86, 229, 0]),
};

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const payload = concat(...parts);
  const result = new Uint8Array(8 + payload.length);
  new DataView(result.buffer).setUint32(0, result.length);
  result.set(new TextEncoder().encode(type), 4);
  result.set(payload, 8);
  return result;
}

function movieHeader(timescale = 1000): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(20);
  new DataView(bytes.buffer).setUint32(12, timescale);
  return box('mvhd', bytes);
}

function track(
  id: number,
  edits?: [duration: number, mediaTime: number, rate?: number][],
  version = 0,
): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(20);
  new DataView(header.buffer).setUint32(12, id);
  if (!edits) return box('trak', box('tkhd', header));
  const size = version === 1 ? 20 : 12;
  const data = new Uint8Array(8 + size * edits.length);
  const view = new DataView(data.buffer);
  view.setUint8(0, version);
  view.setUint32(4, edits.length);
  edits.forEach(([duration, mediaTime, rate = 65536], i) => {
    const offset = 8 + i * size;
    if (version === 1) {
      view.setBigUint64(offset, BigInt(duration));
      view.setBigInt64(offset + 8, BigInt(mediaTime));
    } else {
      view.setUint32(offset, duration);
      view.setInt32(offset + 4, mediaTime);
    }
    view.setInt32(offset + size - 4, rate);
  });
  return box('trak', box('tkhd', header), box('edts', box('elst', data)));
}

function itunes(delay = '00000800', samples = '0000000000035D54'): Uint8Array<ArrayBuffer> {
  const encode = (value: string) => new TextEncoder().encode(value);
  return box(
    'udta',
    box(
      'meta',
      new Uint8Array(4),
      box(
        'ilst',
        box(
          '----',
          box('mean', new Uint8Array(4), encode('com.apple.iTunes')),
          box('name', new Uint8Array(4), encode('iTunSMPB')),
          box('data', new Uint8Array(8), encode(` 00000000 ${delay} 000002AC ${samples} 00000000`)),
        ),
      ),
    ),
  );
}

describe('bounded AAC container timing', () => {
  it.each([0, 1])(
    'reads the selected track edit end from version %s without reading mdat',
    async (version) => {
      const blob = new Blob([
        box('mdat', new Uint8Array(1024 * 1024)),
        box(
          'moov',
          movieHeader(),
          track(1, [[12000, 0]], version),
          track(2, [[5000, 2048]], version),
        ),
      ]);
      const slice = vi.spyOn(blob, 'slice');
      expect(await readAacContainerTiming(blob, 2, CONFIG)).toEqual({ origin: null, end: 5 });
      expect(slice.mock.calls.every(([start = 0, end = blob.size]) => end - start <= 40)).toBe(
        true,
      );
    },
  );

  it('refuses unverified leading empty edits and multiple audio edits', async () => {
    const empty = new Blob([
      box(
        'moov',
        movieHeader(),
        track(1, [
          [1000, -1],
          [5000, 2048],
        ]),
      ),
    ]);
    await expect(readAacContainerTiming(empty, 1, CONFIG)).rejects.toThrow('edit list');
    const multiple = new Blob([
      box(
        'moov',
        movieHeader(),
        track(1, [
          [2000, 0],
          [3000, 4096],
        ]),
      ),
    ]);
    await expect(readAacContainerTiming(multiple, 1, CONFIG)).rejects.toThrow('edit list');
  });

  it('ignores unsupported edits on another track and accepts an empty selected edit list', async () => {
    const other = new Blob([
      box('moov', movieHeader(), track(1, [[5000, 0, 32768]]), track(2, [[5000, 2048]])),
    ]);
    expect(await readAacContainerTiming(other, 2, CONFIG)).toEqual({ origin: null, end: 5 });
    const empty = new Blob([box('moov', movieHeader(), track(1, []), itunes())]);
    const timing = await readAacContainerTiming(empty, 1, CONFIG);
    expect(timing.origin).toBeCloseTo(2048 / 44100, 12);
  });

  it('reads iTunes delay and original samples in AAC core-rate units for HE-AAC', async () => {
    const blob = new Blob([
      box('moov', movieHeader(), track(1), itunes('00000800', '000000000001AEAA')),
    ]);
    const result = await readAacContainerTiming(blob, 1, {
      ...CONFIG,
      description: new Uint8Array([19, 144, 86, 229, 160]),
    });
    expect(result.origin).toBeCloseTo(2048 / 22050, 12);
    expect(result.end! - result.origin!).toBe(5);
  });

  it('prefers explicit edits over iTunes tags and ignores invalid excessive priming', async () => {
    const edits = new Blob([box('moov', movieHeader(), track(1, [[5000, 1024]]), itunes())]);
    expect(await readAacContainerTiming(edits, 1, CONFIG)).toEqual({ origin: null, end: 5 });
    const invalid = new Blob([box('moov', movieHeader(), track(1), itunes('00004000'))]);
    expect(await readAacContainerTiming(invalid, 1, CONFIG)).toEqual({ origin: null, end: null });
  });

  it('refuses ambiguous multi-track gapless tags and non-unit edit rates', async () => {
    const multi = new Blob([box('moov', movieHeader(), track(1), track(2), itunes())]);
    await expect(readAacContainerTiming(multi, 1, CONFIG)).rejects.toThrow('Ambiguous');
    const rate = new Blob([box('moov', movieHeader(), track(1, [[5000, 0, 32768]]))]);
    await expect(readAacContainerTiming(rate, 1, CONFIG)).rejects.toThrow('edit rate');
  });

  it('does not apply MP4 timing to raw ADTS and stops scanning after cancellation', async () => {
    expect(
      await readAacContainerTiming(
        new Blob([new Uint8Array([255, 241, 80, 128, 2, 0, 0, 0])]),
        1,
        CONFIG,
      ),
    ).toEqual({ origin: null, end: null });
    const blob = new Blob([box('moov', movieHeader(), track(1), itunes())]);
    let checks = 0;
    await expect(readAacContainerTiming(blob, 1, CONFIG, () => ++checks < 4)).rejects.toMatchObject(
      { name: 'AbortError' },
    );
  });
});
