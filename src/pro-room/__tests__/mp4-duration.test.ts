import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { readProRoomMp4Duration } from '../../../cloudflare/pro-room-mp4-duration.ts';

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payload = concatenate(...parts);
  const bytes = new Uint8Array(8 + payload.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(payload, 8);
  return bytes;
}

const ftyp = box('ftyp', new TextEncoder().encode('M4A \0\0\0\0isom'));

function timed(type: 'mvhd' | 'mdhd', seconds = 5, version = 0, scale = 48_000): Uint8Array {
  const bytes = new Uint8Array(version === 1 ? 32 : 20);
  const view = new DataView(bytes.buffer);
  bytes[0] = version;
  view.setUint32(version === 1 ? 20 : 12, scale);
  if (version === 1) view.setBigUint64(24, BigInt(Math.round(seconds * scale)));
  else view.setUint32(16, Math.round(seconds * scale));
  return box(type, bytes);
}

function handler(type = 'soun'): Uint8Array {
  const bytes = new Uint8Array(12);
  bytes.set(new TextEncoder().encode(type), 8);
  return box('hdlr', bytes);
}

function track(
  seconds = 5,
  version = 0,
  extras: Uint8Array = new Uint8Array(),
  kind = 'soun',
): Uint8Array {
  return box('trak', box('mdia', timed('mdhd', seconds, version), handler(kind), extras));
}

function edits(durations: number[], version = 0, mediaRate = 1): Uint8Array {
  const width = version === 1 ? 20 : 12;
  const bytes = new Uint8Array(8 + durations.length * width);
  const view = new DataView(bytes.buffer);
  bytes[0] = version;
  view.setUint32(4, durations.length);
  durations.forEach((duration, index) => {
    const offset = 8 + index * width;
    if (version === 1) {
      view.setBigUint64(offset, BigInt(duration));
      view.setBigInt64(offset + 8, index === 0 && durations.length > 1 ? -1n : 0n);
    } else {
      view.setUint32(offset, duration);
      view.setInt32(offset + 4, index === 0 && durations.length > 1 ? -1 : 0);
    }
    view.setInt16(offset + (version === 1 ? 16 : 8), mediaRate);
  });
  return box('edts', box('elst', bytes));
}

function reader(bytes: Uint8Array) {
  return vi.fn(async (start: number, end: number) => bytes.slice(start, end));
}

describe('bounded header-only MP4 duration', () => {
  it.each([0, 1])(
    'reads version %i timing and selects audio instead of an earlier video track',
    async (version) => {
      const bytes = concatenate(
        ftyp,
        box('moov', timed('mvhd'), track(90, version, undefined, 'vide'), track(5, version)),
      );
      expect(await readProRoomMp4Duration(reader(bytes), bytes.length)).toBe(5);
    },
  );

  it.each([0, 1])(
    'accounts for version %i leading empty edits and encoder priming trims',
    async (version) => {
      const bytes = concatenate(
        ftyp,
        box(
          'moov',
          timed('mvhd', 6, version, 1_000),
          box(
            'trak',
            edits([1_000, 5_000], version),
            box('mdia', timed('mdhd', 5.03, version), handler()),
          ),
        ),
      );
      expect(await readProRoomMp4Duration(reader(bytes), bytes.length)).toBe(6);
    },
  );

  it.each([
    [5, 90],
    [90, 5],
    [5, 5],
  ])(
    'leaves ambiguous audio tracks (%i and %i seconds) to the controller',
    async (first, second) => {
      const bytes = concatenate(ftyp, box('moov', timed('mvhd'), track(first), track(second)));
      expect(await readProRoomMp4Duration(reader(bytes), bytes.length)).toBeNull();
    },
  );

  it('never reads or expands malicious stts/ctts sample tables', async () => {
    const table = new Uint8Array(16);
    const view = new DataView(table.buffer);
    view.setUint32(4, 1);
    view.setUint32(8, 0xffffffff);
    view.setUint32(12, 1);
    const samples = box('minf', box('stbl', box('stts', table), box('ctts', table)));
    const bytes = concatenate(ftyp, box('moov', timed('mvhd'), track(5, 0, samples)));
    const read = reader(bytes);
    expect(await readProRoomMp4Duration(read, bytes.length)).toBe(5);
    const minfStart =
      bytes.findIndex(
        (_value, index) =>
          bytes[index] === 0x6d &&
          bytes[index + 1] === 0x69 &&
          bytes[index + 2] === 0x6e &&
          bytes[index + 3] === 0x66,
      ) - 4;
    expect(
      read.mock.calls.some(
        ([start, end]) => start < minfStart + samples.length && end > minfStart + 8,
      ),
    ).toBe(false);
    expect(read.mock.calls.reduce((sum, [start, end]) => sum + end - start, 0)).toBeLessThan(256);
  });

  it('skips a multi-gigabyte extended-size mdat without fetching its body', async () => {
    const mediaSize = 5 * 1024 * 1024 * 1024;
    const mdatHeader = new Uint8Array(16);
    const view = new DataView(mdatHeader.buffer);
    view.setUint32(0, 1);
    mdatHeader.set(new TextEncoder().encode('mdat'), 4);
    view.setBigUint64(8, BigInt(mediaSize));
    const tail = box('moov', timed('mvhd'), track());
    const moovOffset = ftyp.length + mediaSize;
    const prefix = concatenate(ftyp, mdatHeader);
    const read = vi.fn(async (start: number, end: number) => {
      if (start < prefix.length && end <= prefix.length) return prefix.slice(start, end);
      if (start >= moovOffset) return tail.slice(start - moovOffset, end - moovOffset);
      throw new Error('The media body must never be requested');
    });
    expect(await readProRoomMp4Duration(read, moovOffset + tail.length)).toBe(5);
    expect(read.mock.calls.reduce((sum, [start, end]) => sum + end - start, 0)).toBeLessThan(256);
  });

  it('returns unknown for fragmented zero duration without traversing fragment sample runs', async () => {
    const bytes = concatenate(
      ftyp,
      box('moov', timed('mvhd', 0), track(0)),
      box('moof', box('traf', box('trun', new Uint8Array(12).fill(0xff)))),
    );
    expect(await readProRoomMp4Duration(reader(bytes), bytes.length)).toBeNull();
  });

  it.each([
    ['an mvex declaration', [box('moov', timed('mvhd'), track(), box('mvex', box('trex')))]],
    [
      'a top-level fragment',
      [
        box('moov', timed('mvhd'), track()),
        box('moof', box('traf', box('trun', new Uint8Array(12)))),
        box('mdat', new Uint8Array(16)),
      ],
    ],
    ['a fragment before moov', [box('moof'), box('moov', timed('mvhd'), track())]],
  ])(
    'leaves a fragmented file with %s unknown instead of its partial moov timeline',
    async (_label, boxes) => {
      const bytes = concatenate(ftyp, ...boxes);
      const read = reader(bytes);
      expect(await readProRoomMp4Duration(read, bytes.length)).toBeNull();
      expect(read.mock.calls.reduce((sum, [start, end]) => sum + end - start, 0)).toBeLessThan(256);
    },
  );

  it('bounds box counts and malformed parent extents', async () => {
    const many = concatenate(ftyp, ...Array.from({ length: 2049 }, () => box('free')));
    const read = reader(many);
    expect(await readProRoomMp4Duration(read, many.length)).toBeNull();
    expect(read.mock.calls.length).toBeLessThanOrEqual(2050);
    const malformed = concatenate(ftyp, box('moov', new Uint8Array([0, 0, 0, 4, 0, 0, 0, 0])));
    expect(await readProRoomMp4Duration(reader(malformed), malformed.length)).toBeNull();
  });

  it('never interprets arbitrary recursion as timing headers', async () => {
    let nested = box('moov', timed('mvhd'), track());
    for (let index = 0; index < 50; index += 1) nested = box('moov', nested);
    const bytes = concatenate(ftyp, nested);
    const read = reader(bytes);
    expect(await readProRoomMp4Duration(read, bytes.length)).toBeNull();
    expect(read.mock.calls.length).toBeLessThan(10);
  });

  it('rejects unbounded edit counts and unsupported playback rates', async () => {
    const huge = new Uint8Array(8);
    new DataView(huge.buffer).setUint32(4, 0xffffffff);
    for (const edit of [box('edts', box('elst', huge)), edits([5_000], 0, 2)]) {
      const bytes = concatenate(
        ftyp,
        box('moov', timed('mvhd'), box('trak', edit, box('mdia', timed('mdhd'), handler()))),
      );
      expect(await readProRoomMp4Duration(reader(bytes), bytes.length)).toBeNull();
    }
  });

  it('returns undefined only for a different file format', async () => {
    const bytes = new TextEncoder().encode('fLaCnot an MP4 header');
    expect(await readProRoomMp4Duration(reader(bytes), bytes.length)).toBeUndefined();
    expect(await readProRoomMp4Duration(reader(ftyp), ftyp.length)).toBeNull();
  });

  it.each([
    ['large-audio-chirp-lc-stereo.m4a', 5],
    // tkhd rounds the authored 5.999229-second presentation up to 6 seconds.
    ['large-audio-chirp-lc-leading-edit.m4a', 6],
    ['large-audio-chirp-lc-mono.m4a', 5],
    ['large-audio-chirp-lc-surround.m4a', 5],
  ])('reads the real %s fixture from timing headers only', async (filename, duration) => {
    const bytes = await readFile(new URL(`../../../e2e/fixtures/${filename}`, import.meta.url));
    const read = reader(bytes);
    expect(await readProRoomMp4Duration(read, bytes.length)).toBeCloseTo(duration, 3);
    expect(read.mock.calls.reduce((sum, [start, end]) => sum + end - start, 0)).toBeLessThan(2048);
  });
});
