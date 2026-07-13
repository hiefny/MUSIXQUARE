import { describe, expect, it } from 'vitest';

import {
  EncodedSourceClosedError,
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
  type EncodedAudioSourceMetadata,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import {
  MP3_MAX_LEADING_ID3V2_TAGS,
  MP3_MAX_TRAILING_ID3V2_TAGS,
  UnsupportedId3v2VersionError,
  readMp3Id3Boundaries,
} from '../id3.ts';

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
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

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function syncsafe(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0x0fff_ffff) {
    throw new RangeError('fixture syncsafe value is outside 28 bits');
  }
  return Uint8Array.of(
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f,
  );
}

function id3Header(majorVersion: number, bodyBytes: number, flags = 0, revision = 0): Uint8Array {
  return concatenate(
    ascii('ID3'),
    Uint8Array.of(majorVersion, revision, flags),
    syncsafe(bodyBytes),
  );
}

function id3Footer(header: Uint8Array): Uint8Array {
  return concatenate(ascii('3DI'), header.slice(3));
}

function id3Tag(majorVersion: 2 | 3 | 4, bodyBytes: number, flags = 0, revision = 0): Uint8Array {
  const header = id3Header(majorVersion, bodyBytes, flags, revision);
  const body = new Uint8Array(bodyBytes);
  return majorVersion === 4 && (flags & 0x10) !== 0
    ? concatenate(header, body, id3Footer(header))
    : concatenate(header, body);
}

function id3v1(): Uint8Array {
  const bytes = new Uint8Array(128);
  bytes.set(ascii('TAG'));
  return bytes;
}

class MemoryEncodedAudioSource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly identity = 'memory-mp3-id3-fixture';
  readonly metadata: EncodedAudioSourceMetadata = Object.freeze({
    name: 'fixture.mp3',
    mime: 'audio/mpeg',
  });
  readonly reads: ReadRecord[] = [];
  #closed = false;

  constructor(private readonly bytes: Uint8Array) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    if (this.#closed) throw new EncodedSourceClosedError();
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push(Object.freeze({ offset, length }));
    return this.bytes.slice(offset, end);
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

function sourceFrom(bytes: Uint8Array): MemoryEncodedAudioSource {
  return new MemoryEncodedAudioSource(bytes);
}

async function parse(bytes: Uint8Array, signal = new AbortController().signal) {
  return readMp3Id3Boundaries(sourceFrom(bytes), signal);
}

describe('readMp3Id3Boundaries', () => {
  it('returns immutable full-source boundaries when no ID3 tags are present', async () => {
    const bytes = new Uint8Array(256);
    bytes.set(Uint8Array.of(0xff, 0xfb, 0x90, 0x64));

    const boundaries = await parse(bytes);

    expect(boundaries).toEqual({
      sourceBytes: 256,
      dataStart: 0,
      audioEnd: 256,
      leadingTagCount: 0,
      leadingTags: [],
      trailingTagCount: 0,
      trailingTags: [],
      hasTrailingId3v1: false,
      trailingId3v1Offset: null,
    });
    expect(Object.isFrozen(boundaries)).toBe(true);
    expect(Object.isFrozen(boundaries.leadingTags)).toBe(true);
    expect(Object.isFrozen(boundaries.trailingTags)).toBe(true);
  });

  it('skips consecutive v2.2, v2.3, and v2.4 tags and excludes trailing ID3v1', async () => {
    const first = id3Tag(2, 3, 0x80, 7);
    const second = id3Tag(3, 5, 0xe0, 2);
    const third = id3Tag(4, 4, 0xf0, 1);
    const audio = Uint8Array.of(0xff, 0xfb, 0x90, 0x64, 0, 1, 2, 3);
    const bytes = concatenate(first, second, third, audio, id3v1());

    const boundaries = await parse(bytes);

    expect(boundaries).toMatchObject({
      sourceBytes: bytes.byteLength,
      dataStart: first.byteLength + second.byteLength + third.byteLength,
      audioEnd: bytes.byteLength - 128,
      leadingTagCount: 3,
      hasTrailingId3v1: true,
      trailingId3v1Offset: bytes.byteLength - 128,
    });
    expect(boundaries.leadingTags).toEqual([
      {
        headerOffset: 0,
        bodyOffset: 10,
        bodyBytes: 3,
        footerOffset: null,
        endOffset: first.byteLength,
        majorVersion: 2,
        revision: 7,
        flags: 0x80,
      },
      {
        headerOffset: first.byteLength,
        bodyOffset: first.byteLength + 10,
        bodyBytes: 5,
        footerOffset: null,
        endOffset: first.byteLength + second.byteLength,
        majorVersion: 3,
        revision: 2,
        flags: 0xe0,
      },
      {
        headerOffset: first.byteLength + second.byteLength,
        bodyOffset: first.byteLength + second.byteLength + 10,
        bodyBytes: 4,
        footerOffset: first.byteLength + second.byteLength + 14,
        endOffset: first.byteLength + second.byteLength + third.byteLength,
        majorVersion: 4,
        revision: 1,
        flags: 0xf0,
      },
    ]);
    expect(boundaries.leadingTags.every(Object.isFrozen)).toBe(true);
  });

  it('treats a v2.4 footer as ten bytes outside the syncsafe body size', async () => {
    const header = id3Header(4, 1, 0x10);
    const bytes = concatenate(
      header,
      Uint8Array.of(0),
      id3Footer(header),
      Uint8Array.of(0xff, 0xfb),
    );

    const boundaries = await parse(bytes);

    expect(boundaries.leadingTags[0]).toMatchObject({
      bodyOffset: 10,
      bodyBytes: 1,
      footerOffset: 11,
      endOffset: 21,
    });
    expect(boundaries.dataStart).toBe(21);
  });

  it('requires a v2.4 footer to start with 3DI and mirror the header', async () => {
    const header = id3Header(4, 0, 0x10);
    const badMarker = id3Footer(header);
    badMarker.set(ascii('ID3'));
    await expect(parse(concatenate(header, badMarker))).rejects.toThrow(/begin.*3DI/i);

    const badFlags = id3Footer(header);
    badFlags[5] = 0;
    await expect(parse(concatenate(header, badFlags))).rejects.toThrow(
      /footer-present flag|must mirror/i,
    );

    const badSize = id3Footer(header);
    badSize[9] = 1;
    await expect(parse(concatenate(header, badSize, Uint8Array.of(0)))).rejects.toThrow(
      /exact preceding ID3 header|must mirror/i,
    );
  });

  it('excludes an appended v2.4 tag before canonical ID3v1', async () => {
    const audio = Uint8Array.of(0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4, 5, 6, 7, 8);
    const appended = id3Tag(4, 3, 0x10, 7);
    const bytes = concatenate(audio, appended, id3v1());

    const boundaries = await parse(bytes);

    expect(boundaries).toMatchObject({
      dataStart: 0,
      audioEnd: audio.byteLength,
      trailingTagCount: 1,
      hasTrailingId3v1: true,
      trailingId3v1Offset: audio.byteLength + appended.byteLength,
    });
    expect(boundaries.trailingTags).toEqual([
      {
        headerOffset: audio.byteLength,
        bodyOffset: audio.byteLength + 10,
        bodyBytes: 3,
        footerOffset: audio.byteLength + 13,
        endOffset: audio.byteLength + appended.byteLength,
        majorVersion: 4,
        revision: 7,
        flags: 0x10,
      },
    ]);
    expect(Object.isFrozen(boundaries.trailingTags)).toBe(true);
    expect(boundaries.trailingTags.every(Object.isFrozen)).toBe(true);
  });

  it('walks multiple appended v2.4 tags backward but returns them in file order', async () => {
    const audio = new Uint8Array(24);
    audio.set(Uint8Array.of(0xff, 0xfb, 0x90, 0x64));
    const first = id3Tag(4, 2, 0x10, 1);
    const second = id3Tag(4, 4, 0x10, 2);
    const boundaries = await parse(concatenate(audio, first, second));

    expect(boundaries).toMatchObject({
      audioEnd: audio.byteLength,
      trailingTagCount: 2,
      leadingTagCount: 0,
    });
    expect(
      boundaries.trailingTags.map(({ headerOffset, endOffset, revision }) => ({
        headerOffset,
        endOffset,
        revision,
      })),
    ).toEqual([
      {
        headerOffset: audio.byteLength,
        endOffset: audio.byteLength + first.byteLength,
        revision: 1,
      },
      {
        headerOffset: audio.byteLength + first.byteLength,
        endOffset: audio.byteLength + first.byteLength + second.byteLength,
        revision: 2,
      },
    ]);
  });

  it('fails closed for malformed appended footer claims and tag overlap', async () => {
    const audio = new Uint8Array(20);

    const wrongVersion = id3Footer(id3Header(3, 0, 0x10));
    await expect(parse(concatenate(audio, wrongVersion))).rejects.toThrow(/only ID3v2\.4/i);

    const missingFooterFlag = id3Footer(id3Header(4, 0));
    await expect(parse(concatenate(audio, missingFooterFlag))).rejects.toThrow(
      /footer-present flag/i,
    );

    const reservedFlags = id3Footer(id3Header(4, 0, 0x11));
    await expect(parse(concatenate(audio, reservedFlags))).rejects.toThrow(/reserved flag/i);

    const badRevision = id3Footer(id3Header(4, 0, 0x10, 0xff));
    await expect(parse(concatenate(audio, badRevision))).rejects.toThrow(/revision.*255/i);

    const badSyncsafe = id3Footer(id3Header(4, 0, 0x10));
    badSyncsafe[8] = 0x80;
    await expect(parse(concatenate(audio, badSyncsafe))).rejects.toThrow(/syncsafe/i);

    const header = id3Header(4, 0, 0x10);
    const footerWithoutHeader = id3Footer(header);
    await expect(parse(concatenate(audio, footerWithoutHeader))).rejects.toThrow(
      /exact preceding ID3 header/i,
    );

    const mismatchedFooter = id3Footer(header);
    mismatchedFooter[4] = 1;
    await expect(parse(concatenate(audio, header, mismatchedFooter))).rejects.toThrow(
      /must mirror/i,
    );

    const overlappingLeadingHeader = id3Header(3, 15);
    const appended = id3Tag(4, 0, 0x10);
    await expect(
      parse(concatenate(overlappingLeadingHeader, new Uint8Array(10), appended)),
    ).rejects.toThrow(/boundary exceeds/i);
  });

  it('accepts at most eight appended tags and rejects the ninth', async () => {
    const audio = new Uint8Array(16);
    audio.set(Uint8Array.of(0xff, 0xfb, 0x90, 0x64));
    const eight = Array.from({ length: MP3_MAX_TRAILING_ID3V2_TAGS }, () => id3Tag(4, 0, 0x10));

    await expect(parse(concatenate(audio, ...eight))).resolves.toMatchObject({
      audioEnd: audio.byteLength,
      trailingTagCount: MP3_MAX_TRAILING_ID3V2_TAGS,
    });
    await expect(parse(concatenate(audio, id3Tag(4, 0, 0x10), ...eight))).rejects.toThrow(
      /more than 8.*appended/i,
    );
  });

  it('accepts v2.2 compression for outer-boundary skipping and validates other headers', async () => {
    await expect(parse(id3Header(1, 0))).rejects.toBeInstanceOf(UnsupportedId3v2VersionError);
    await expect(parse(id3Header(5, 0))).rejects.toBeInstanceOf(UnsupportedId3v2VersionError);
    await expect(parse(id3Header(2, 0, 0, 0xff))).rejects.toThrow(/revision.*255/i);

    await expect(parse(id3Header(2, 0, 0x40))).resolves.toMatchObject({
      dataStart: 10,
      leadingTags: [{ majorVersion: 2, flags: 0x40 }],
    });
    await expect(parse(id3Header(2, 0, 0x01))).rejects.toThrow(/reserved flag/i);
    await expect(parse(id3Header(3, 0, 0x10))).rejects.toThrow(/reserved flag/i);
    await expect(parse(id3Header(4, 0, 0x08))).rejects.toThrow(/reserved flag/i);
  });

  it.each([6, 7, 8, 9])('rejects a non-syncsafe size byte at header index %i', async (index) => {
    const header = id3Header(3, 0);
    header[index] = 0x80;
    await expect(parse(header)).rejects.toThrow(/syncsafe/i);
  });

  it('fails closed for truncated or out-of-bounds claimed leading tags', async () => {
    await expect(parse(ascii('ID3'))).rejects.toThrow(/shorter than.*header/i);

    const declaredPastEnd = id3Header(3, 4);
    await expect(parse(declaredPastEnd)).rejects.toThrow(/boundary exceeds/i);

    const headerWithFooter = id3Header(4, 0, 0x10);
    await expect(parse(headerWithFooter)).rejects.toThrow(/boundary exceeds/i);

    const overlapsId3v1 = concatenate(id3Header(3, 128), new Uint8Array(127), id3v1());
    await expect(parse(overlapsId3v1)).rejects.toThrow(/overlaps trailing metadata/i);
  });

  it('accepts at most eight consecutive leading tags and rejects the ninth', async () => {
    const eight = Array.from({ length: MP3_MAX_LEADING_ID3V2_TAGS }, () => id3Tag(3, 0));
    await expect(parse(concatenate(...eight, Uint8Array.of(0xff, 0xfb)))).resolves.toMatchObject({
      leadingTagCount: MP3_MAX_LEADING_ID3V2_TAGS,
      dataStart: MP3_MAX_LEADING_ID3V2_TAGS * 10,
    });

    await expect(
      parse(concatenate(...eight, id3Tag(3, 0), Uint8Array.of(0xff, 0xfb))),
    ).rejects.toThrow(/more than 8/i);
  });

  it('recognizes ID3v1 only at the canonical 128-byte trailing boundary', async () => {
    const canonical = new Uint8Array(140);
    canonical.set(ascii('TAG'), 12);
    await expect(parse(canonical)).resolves.toMatchObject({
      audioEnd: 12,
      hasTrailingId3v1: true,
      trailingId3v1Offset: 12,
    });

    const elsewhere = new Uint8Array(140);
    elsewhere.set(ascii('TAG'), 11);
    await expect(parse(elsewhere)).resolves.toMatchObject({
      audioEnd: 140,
      hasTrailingId3v1: false,
    });
  });

  it('rejects malformed exact transport reads', async () => {
    const bytes = new Uint8Array(256);
    const shortSource: EncodedAudioSource = {
      kind: 'blob',
      size: bytes.byteLength,
      identity: 'short-id3-source',
      metadata: { name: 'short.mp3', mime: 'audio/mpeg' },
      async readAt(offset, length, signal) {
        throwIfAborted(signal);
        return bytes.slice(offset, offset + Math.max(0, length - 1));
      },
      async close() {},
    };

    await expect(
      readMp3Id3Boundaries(shortSource, new AbortController().signal),
    ).rejects.toBeInstanceOf(EncodedSourceIntegrityError);
  });

  it('honors aborts before and immediately after a transport read', async () => {
    const bytes = new Uint8Array(256);
    const before = new AbortController();
    const beforeReason = new Error('id3-before-read-abort');
    before.abort(beforeReason);
    await expect(readMp3Id3Boundaries(sourceFrom(bytes), before.signal)).rejects.toBe(beforeReason);

    const after = new AbortController();
    const afterReason = new Error('id3-after-read-abort');
    const base = sourceFrom(bytes);
    const abortingSource: EncodedAudioSource = {
      kind: base.kind,
      size: base.size,
      identity: base.identity,
      metadata: base.metadata,
      async readAt(offset, length, signal) {
        const result = await base.readAt(offset, length, signal);
        after.abort(afterReason);
        return result;
      },
      async close() {},
    };
    await expect(readMp3Id3Boundaries(abortingSource, after.signal)).rejects.toBe(afterReason);
  });

  it('honors an abort immediately after the appended-footer probe', async () => {
    const audio = new Uint8Array(32);
    const appended = id3Tag(4, 0, 0x10);
    const bytes = concatenate(audio, appended, id3v1());
    const footerOffset = audio.byteLength + 10;
    const controller = new AbortController();
    const reason = new Error('appended-id3-footer-abort');
    const base = sourceFrom(bytes);
    const abortingSource: EncodedAudioSource = {
      kind: base.kind,
      size: base.size,
      identity: base.identity,
      metadata: base.metadata,
      async readAt(offset, length, signal) {
        const result = await base.readAt(offset, length, signal);
        if (offset === footerOffset) controller.abort(reason);
        return result;
      },
      async close() {},
    };

    await expect(readMp3Id3Boundaries(abortingSource, controller.signal)).rejects.toBe(reason);
  });

  it('rejects unsafe source sizes before issuing a read', async () => {
    let readCount = 0;
    const source: EncodedAudioSource = {
      kind: 'peer-range',
      size: Number.MAX_SAFE_INTEGER + 1,
      identity: 'unsafe-size-id3-source',
      metadata: { name: 'unsafe.mp3', mime: 'audio/mpeg' },
      async readAt() {
        readCount += 1;
        return new Uint8Array();
      },
      async close() {},
    };

    await expect(readMp3Id3Boundaries(source, new AbortController().signal)).rejects.toThrow(
      /source size/i,
    );
    expect(readCount).toBe(0);
  });
});

interface SparseRegion {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

class SparseEncodedAudioSource implements EncodedAudioSource {
  readonly kind = 'peer-range' as const;
  readonly identity = 'sparse-mp3-id3-fixture';
  readonly metadata = Object.freeze({ name: 'sparse.mp3', mime: 'audio/mpeg' });
  readonly reads: ReadRecord[] = [];

  constructor(
    readonly size: number,
    private readonly regions: readonly SparseRegion[],
  ) {}

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push(Object.freeze({ offset, length }));
    const region = this.regions.find(
      (candidate) =>
        offset >= candidate.offset && end <= candidate.offset + candidate.bytes.byteLength,
    );
    if (!region) throw new Error(`Sparse fixture has no bytes for [${offset}, ${end})`);
    const relative = offset - region.offset;
    return region.bytes.slice(relative, relative + length);
  }

  async close(): Promise<void> {}
}

describe('readMp3Id3Boundaries sparse input', () => {
  it('skips a maximum-size sparse v2.4 body and validates only its exact footer', async () => {
    const bodyBytes = 0x0fff_ffff;
    const header = id3Header(4, bodyBytes, 0x10);
    const footerOffset = 10 + bodyBytes;
    const dataStart = footerOffset + 10;
    const sourceBytes = dataStart + 512;
    const id3v1ProbeOffset = sourceBytes - 128;
    const trailingV24ProbeOffset = sourceBytes - 10;
    const source = new SparseEncodedAudioSource(sourceBytes, [
      { offset: 0, bytes: header },
      { offset: footerOffset, bytes: id3Footer(header) },
      { offset: dataStart, bytes: new Uint8Array(10) },
      { offset: id3v1ProbeOffset, bytes: new Uint8Array(3) },
      { offset: trailingV24ProbeOffset, bytes: new Uint8Array(10) },
    ]);

    const boundaries = await readMp3Id3Boundaries(source, new AbortController().signal);

    expect(boundaries).toMatchObject({
      sourceBytes,
      dataStart,
      audioEnd: sourceBytes,
      leadingTagCount: 1,
    });
    expect(source.reads).toEqual([
      { offset: id3v1ProbeOffset, length: 3 },
      { offset: trailingV24ProbeOffset, length: 10 },
      { offset: 0, length: 10 },
      { offset: footerOffset, length: 10 },
      { offset: dataStart, length: 10 },
    ]);
    expect(source.reads.every(({ length }) => length <= 10)).toBe(true);
  });

  it('skips a maximum-size sparse appended v2.4 body using only boundary reads', async () => {
    const bodyBytes = 0x0fff_ffff;
    const audioEnd = 512;
    const header = id3Header(4, bodyBytes, 0x10, 3);
    const footerOffset = audioEnd + 10 + bodyBytes;
    const trailingId3v1Offset = footerOffset + 10;
    const sourceBytes = trailingId3v1Offset + 128;
    const priorFooterProbeOffset = audioEnd - 10;
    const source = new SparseEncodedAudioSource(sourceBytes, [
      { offset: 0, bytes: new Uint8Array(10) },
      { offset: priorFooterProbeOffset, bytes: new Uint8Array(10) },
      { offset: audioEnd, bytes: header },
      { offset: footerOffset, bytes: id3Footer(header) },
      { offset: trailingId3v1Offset, bytes: id3v1() },
    ]);

    const boundaries = await readMp3Id3Boundaries(source, new AbortController().signal);

    expect(boundaries).toMatchObject({
      sourceBytes,
      dataStart: 0,
      audioEnd,
      trailingTagCount: 1,
      hasTrailingId3v1: true,
      trailingId3v1Offset,
    });
    expect(boundaries.trailingTags).toEqual([
      {
        headerOffset: audioEnd,
        bodyOffset: audioEnd + 10,
        bodyBytes,
        footerOffset,
        endOffset: trailingId3v1Offset,
        majorVersion: 4,
        revision: 3,
        flags: 0x10,
      },
    ]);
    expect(source.reads).toEqual([
      { offset: trailingId3v1Offset, length: 3 },
      { offset: footerOffset, length: 10 },
      { offset: audioEnd, length: 10 },
      { offset: priorFooterProbeOffset, length: 10 },
      { offset: 0, length: 10 },
    ]);
    expect(source.reads.every(({ length }) => length <= 10)).toBe(true);
  });
});
