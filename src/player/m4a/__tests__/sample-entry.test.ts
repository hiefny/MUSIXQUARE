import { describe, expect, it } from 'vitest';

import {
  type EncodedRandomAccessSource,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import { IsoBmffBoxReader } from '../../mp4/box-reader.ts';
import { readM4aAacLcSampleDescription } from '../sample-entry.ts';

function concat(...parts: ReadonlyArray<Uint8Array | readonly number[]>): Uint8Array {
  const byteLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function uint32(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, false);
  return result;
}

function box(type: string, payload: Uint8Array, large = false): Uint8Array {
  const headerBytes = large ? 16 : 8;
  const result = new Uint8Array(headerBytes + payload.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, large ? 1 : result.byteLength, false);
  for (let index = 0; index < 4; index += 1) result[4 + index] = type.charCodeAt(index);
  if (large) view.setBigUint64(8, BigInt(result.byteLength), false);
  result.set(payload, headerBytes);
  return result;
}

function descriptor(tag: number, payload: Uint8Array | readonly number[]): Uint8Array {
  if (payload.length > 0x7f) throw new Error('test descriptor payload is unexpectedly large');
  return concat([tag, payload.length], payload);
}

function esdsPayload(
  asc: Uint8Array | readonly number[] = [0x12, 0x10],
  tail: Uint8Array | readonly number[] = [],
): Uint8Array {
  const decoder = descriptor(
    0x04,
    concat(
      [0x40, 0x15, 0x01, 0x02, 0x03, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88],
      descriptor(0x05, asc),
    ),
  );
  return concat([0, 0, 0, 0], descriptor(0x03, concat([0x12, 0x34, 0], decoder)), tail);
}

interface AudioFieldsOptions {
  readonly sampleRateHz?: number;
  readonly channelCount?: number;
  readonly sampleSizeBits?: number;
  readonly dataReferenceIndex?: number;
}

function audioSampleEntryFields(options: AudioFieldsOptions = {}): Uint8Array {
  const result = new Uint8Array(28);
  const view = new DataView(result.buffer);
  view.setUint16(6, options.dataReferenceIndex ?? 1, false);
  view.setUint16(16, options.channelCount ?? 2, false);
  view.setUint16(18, options.sampleSizeBits ?? 16, false);
  view.setUint32(24, (options.sampleRateHz ?? 44_100) * 0x1_0000, false);
  return result;
}

interface Mp4aOptions extends AudioFieldsOptions {
  readonly type?: string;
  readonly asc?: Uint8Array | readonly number[];
  readonly largeEntry?: boolean;
  readonly largeEsds?: boolean;
  readonly beforeEsds?: readonly Uint8Array[];
  readonly afterEsds?: readonly Uint8Array[];
  readonly fields?: Uint8Array;
  readonly omitEsds?: boolean;
}

function mp4a(options: Mp4aOptions = {}): Uint8Array {
  const esds = options.omitEsds
    ? []
    : [box('esds', esdsPayload(options.asc), options.largeEsds ?? false)];
  return box(
    options.type ?? 'mp4a',
    concat(
      options.fields ?? audioSampleEntryFields(options),
      ...(options.beforeEsds ?? []),
      ...esds,
      ...(options.afterEsds ?? []),
    ),
    options.largeEntry ?? false,
  );
}

function stsd(
  entries: readonly Uint8Array[],
  options: {
    readonly versionFlags?: readonly number[];
    readonly declaredEntries?: number;
    readonly tail?: readonly number[];
    readonly large?: boolean;
  } = {},
): Uint8Array {
  return box(
    'stsd',
    concat(
      options.versionFlags ?? [0, 0, 0, 0],
      uint32(options.declaredEntries ?? entries.length),
      ...entries,
      options.tail ?? [],
    ),
    options.large ?? false,
  );
}

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

class MemorySource implements EncodedRandomAccessSource {
  readonly identity = 'm4a-sample-entry-test-source';
  readonly size: number;
  readonly reads: ReadRecord[] = [];
  closeCalls = 0;
  block: Promise<void> | null = null;

  constructor(readonly bytes: Uint8Array) {
    this.size = bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push(Object.freeze({ offset, length }));
    if (this.block) await this.block;
    return this.bytes.slice(offset, end);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

async function setup(bytes: Uint8Array): Promise<{
  readonly source: MemorySource;
  readonly reader: IsoBmffBoxReader;
  readonly stsdBox: NonNullable<
    Awaited<ReturnType<ReturnType<IsoBmffBoxReader['createCursor']>['next']>>
  >;
}> {
  const source = new MemorySource(bytes);
  const reader = new IsoBmffBoxReader(source);
  const stsdBox = await reader.createCursor().next(liveSignal());
  if (stsdBox === null) throw new Error('test stsd box is missing');
  return { source, reader, stsdBox };
}

describe('bounded M4A AAC-LC sample-description reader', () => {
  it('reads a frozen canonical 44.1 kHz stereo description without closing its source', async () => {
    const { source, reader, stsdBox } = await setup(stsd([mp4a()]));

    const result = await readM4aAacLcSampleDescription(reader, stsdBox, liveSignal());

    expect(result).toEqual({
      codec: 'mp4a.40.2',
      sampleRateHz: 44_100,
      channelCount: 2,
      sampleSizeBits: 16,
      dataReferenceIndex: 1,
      audioSpecificConfig: {
        audioObjectType: 2,
        sampleRateIndex: 4,
        sampleRateHz: 44_100,
        channelConfiguration: 2,
        channelCount: 2,
        coreFramesPerAccessUnit: 1_024,
        frameLengthFlag: 0,
        dependsOnCoreCoder: 0,
        extensionFlag: 0,
        description: [0x12, 0x10],
      },
      esId: 0x1234,
      bufferSizeDb: 0x010203,
      maxBitrate: 0x11223344,
      averageBitrate: 0x55667788,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.audioSpecificConfig)).toBe(true);
    expect(Object.isFrozen(result.audioSpecificConfig.description)).toBe(true);
    expect(source.closeCalls).toBe(0);
    expect(Math.max(...source.reads.map((read) => read.length))).toBeLessThanOrEqual(65_536);
  });

  it('admits a canonical mono entry and exact standard btrt metadata', async () => {
    const bitRate = box('btrt', concat(uint32(0x01020304), uint32(320_000), uint32(256_000)));
    const { reader, stsdBox } = await setup(
      stsd([
        mp4a({
          channelCount: 1,
          asc: [0x12, 0x08],
          beforeEsds: [bitRate],
        }),
      ]),
    );

    await expect(
      readM4aAacLcSampleDescription(reader, stsdBox, liveSignal()),
    ).resolves.toMatchObject({ channelCount: 1, sampleRateHz: 44_100 });
  });

  it('walks large-size stsd, mp4a, and esds headers without cloning their refs', async () => {
    const { reader, stsdBox } = await setup(
      stsd([mp4a({ largeEntry: true, largeEsds: true })], { large: true }),
    );

    await expect(
      readM4aAacLcSampleDescription(reader, stsdBox, liveSignal()),
    ).resolves.toMatchObject({ codec: 'mp4a.40.2' });
  });

  it.each([
    ['truncated FullBox', box('stsd', new Uint8Array(7)), /FullBox fields are truncated/],
    ['nonzero version', stsd([mp4a()], { versionFlags: [1, 0, 0, 0] }), /version and flags/],
    ['nonzero flags', stsd([mp4a()], { versionFlags: [0, 0, 0, 1] }), /version and flags/],
    ['zero declared entries', stsd([], { declaredEntries: 0 }), /exactly one/],
    ['two declared entries', stsd([mp4a()], { declaredEntries: 2 }), /exactly one/],
    ['missing declared entry', stsd([], { declaredEntries: 1 }), /missing its declared/],
    ['two physical entries', stsd([mp4a(), mp4a()], { declaredEntries: 1 }), /more than one/],
    ['trailing entry bytes', stsd([mp4a()], { tail: [1] }), /inside a box header/],
  ])('rejects stsd contract violation: %s', async (_name, bytes, message) => {
    const { reader, stsdBox } = await setup(bytes);
    await expect(readM4aAacLcSampleDescription(reader, stsdBox, liveSignal())).rejects.toThrow(
      message,
    );
  });

  it.each([
    ['enca', 'enca', /Encrypted/],
    ['ALAC', 'alac', /must be mp4a/],
    ['generic audio', 'sowt', /must be mp4a/],
  ])('fails closed for a %s sample entry', async (_name, type, message) => {
    const { reader, stsdBox } = await setup(stsd([mp4a({ type })]));
    await expect(readM4aAacLcSampleDescription(reader, stsdBox, liveSignal())).rejects.toThrow(
      message,
    );
  });

  it.each([
    ['reserved prefix', 0, 1, /reserved prefix/],
    ['data reference', 7, 0, /data_reference_index/],
    ['version', 9, 1, /version, revision, and vendor/],
    ['revision', 11, 1, /version, revision, and vendor/],
    ['vendor', 15, 1, /version, revision, and vendor/],
    ['predefined', 20, 1, /predefined and reserved/],
    ['reserved word', 23, 1, /predefined and reserved/],
    ['fractional sample rate', 27, 1, /integer 16.16/],
  ])('rejects noncanonical AudioSampleEntry field: %s', async (_name, offset, value, message) => {
    const fields = audioSampleEntryFields();
    fields[offset] = value;
    const { reader, stsdBox } = await setup(stsd([mp4a({ fields })]));
    await expect(readM4aAacLcSampleDescription(reader, stsdBox, liveSignal())).rejects.toThrow(
      message,
    );
  });

  it.each([
    ['zero channels', { channelCount: 0 }, /mono or stereo/],
    ['surround channels', { channelCount: 6 }, /mono or stereo/],
    ['24-bit samples', { sampleSizeBits: 24 }, /16 bits/],
    ['zero sample rate', { sampleRateHz: 0 }, /from 1 through/],
  ])('rejects unsupported sample geometry: %s', async (_name, options, message) => {
    const { reader, stsdBox } = await setup(stsd([mp4a(options)]));
    await expect(readM4aAacLcSampleDescription(reader, stsdBox, liveSignal())).rejects.toThrow(
      message,
    );
  });

  it('rejects a truncated AudioSampleEntry base', async () => {
    const { reader, stsdBox } = await setup(stsd([box('mp4a', new Uint8Array(27))]));
    await expect(readM4aAacLcSampleDescription(reader, stsdBox, liveSignal())).rejects.toThrow(
      /version-zero fields are truncated/,
    );
  });

  it.each([
    ['missing esds', mp4a({ omitEsds: true }), /missing its esds/],
    ['duplicate esds', mp4a({ afterEsds: [box('esds', esdsPayload())] }), /duplicate esds/],
    [
      'duplicate btrt',
      mp4a({
        beforeEsds: [box('btrt', new Uint8Array(12)), box('btrt', new Uint8Array(12))],
      }),
      /duplicate btrt/,
    ],
    ['short btrt', mp4a({ beforeEsds: [box('btrt', new Uint8Array(11))] }), /exactly 12/],
    ['truncated child header', mp4a({ afterEsds: [new Uint8Array(7)] }), /inside a box header/],
    ['wave wrapper', mp4a({ beforeEsds: [box('wave', new Uint8Array(0))] }), /Unsupported.*wave/],
    ['unknown child', mp4a({ afterEsds: [box('free', new Uint8Array(0))] }), /Unsupported.*free/],
  ])('rejects unsupported or ambiguous mp4a children: %s', async (_name, entry, message) => {
    const { reader, stsdBox } = await setup(stsd([entry]));
    await expect(readM4aAacLcSampleDescription(reader, stsdBox, liveSignal())).rejects.toThrow(
      message,
    );
  });

  it('bounds esds bodies and rejects truncated descriptor contents', async () => {
    const oversized = box('esds', new Uint8Array(65_537));
    const first = await setup(stsd([mp4a({ omitEsds: true, beforeEsds: [oversized] })]));
    await expect(
      readM4aAacLcSampleDescription(first.reader, first.stsdBox, liveSignal()),
    ).rejects.toThrow(/64 KiB bounded limit/);

    const truncated = box('esds', concat([0, 0, 0, 0], [0x03, 10, 0]));
    const second = await setup(stsd([mp4a({ omitEsds: true, beforeEsds: [truncated] })]));
    await expect(
      readM4aAacLcSampleDescription(second.reader, second.stsdBox, liveSignal()),
    ).rejects.toThrow(/escapes its parent boundary/);
  });

  it.each([
    ['HE-AAC', [0x2a, 0x10], /SBR or Parametric Stereo/],
    ['PCE channels', [0x12, 0x00], /Program Config Element/],
  ])('rejects unsupported %s AudioSpecificConfig', async (_name, asc, message) => {
    const { reader, stsdBox } = await setup(stsd([mp4a({ asc })]));
    await expect(readM4aAacLcSampleDescription(reader, stsdBox, liveSignal())).rejects.toThrow(
      message,
    );
  });

  it.each([
    [
      'sample rate',
      mp4a({ sampleRateHz: 48_000, asc: [0x12, 0x10] }),
      /sample rate does not match/,
    ],
    ['channel count', mp4a({ channelCount: 1, asc: [0x12, 0x10] }), /channel count does not match/],
  ])('rejects AudioSpecificConfig %s disagreement', async (_name, entry, message) => {
    const { reader, stsdBox } = await setup(stsd([entry]));
    await expect(readM4aAacLcSampleDescription(reader, stsdBox, liveSignal())).rejects.toThrow(
      message,
    );
  });

  it('requires an exact box ref issued by the same reader', async () => {
    const { source, reader, stsdBox } = await setup(stsd([mp4a()]));
    await expect(
      readM4aAacLcSampleDescription(reader, { ...stsdBox }, liveSignal()),
    ).rejects.toThrow(/not issued by this reader/);

    const otherReader = new IsoBmffBoxReader(source);
    await expect(readM4aAacLcSampleDescription(otherReader, stsdBox, liveSignal())).rejects.toThrow(
      /not issued by this reader/,
    );
  });

  it('preserves the exact abort reason before and during a physical read', async () => {
    const before = await setup(stsd([mp4a()]));
    const beforeController = new AbortController();
    const beforeReason = Object.freeze({ phase: 'before-sample-description' });
    beforeController.abort(beforeReason);
    await expect(
      readM4aAacLcSampleDescription(before.reader, before.stsdBox, beforeController.signal),
    ).rejects.toBe(beforeReason);

    const during = await setup(stsd([mp4a()]));
    let release!: () => void;
    during.source.block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const duringController = new AbortController();
    const duringReason = Object.freeze({ phase: 'during-sample-description' });
    const pending = readM4aAacLcSampleDescription(
      during.reader,
      during.stsdBox,
      duringController.signal,
    );
    duringController.abort(duringReason);
    release();
    await expect(pending).rejects.toBe(duringReason);
  });
});
