import { describe, expect, it } from 'vitest';

import { IsoBmffBoxReader } from '../../mp4/box-reader.ts';
import {
  type EncodedRandomAccessSource,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import { readM4aAacRollRecoveryEvidence } from '../roll-recovery.ts';
import {
  type M4aRollRecoverySampleGroupLayout,
  readM4aSampleTableLayout,
} from '../sample-table-layout.ts';
import { M4A_AAC_MAX_ACCESS_UNITS } from '../timeline.ts';

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function box(type: string, body = new Uint8Array(0)): Uint8Array {
  const result = new Uint8Array(8 + body.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, result.byteLength, false);
  for (let index = 0; index < 4; index += 1) result[4 + index] = type.charCodeAt(index);
  result.set(body, 8);
  return result;
}

function stbl(...children: readonly Uint8Array[]): Uint8Array {
  return box(
    'stbl',
    concatenate(box('stsd'), box('stts'), box('stsc'), box('stsz'), box('stco'), ...children),
  );
}

function fromHex(hex: string): Uint8Array {
  const compact = hex.replaceAll(/\s/g, '');
  if (compact.length % 2 !== 0) throw new Error('fixture hex must contain complete bytes');
  return Uint8Array.from(
    Array.from({ length: compact.length / 2 }, (_unused, index) =>
      Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16),
    ),
  );
}

function setFourCc(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < 4; index += 1) bytes[offset + index] = value.charCodeAt(index);
}

function sgpdBody(
  options: {
    readonly version?: number;
    readonly flags?: number;
    readonly groupingType?: string;
    readonly defaultLength?: number;
    readonly entryCount?: number;
    readonly rollDistance?: number;
    readonly suffix?: Uint8Array;
  } = {},
): Uint8Array {
  const suffix = options.suffix ?? new Uint8Array(0);
  const body = new Uint8Array(18 + suffix.byteLength);
  const view = new DataView(body.buffer);
  body[0] = options.version ?? 1;
  const flags = options.flags ?? 0;
  body[1] = flags >>> 16;
  body[2] = flags >>> 8;
  body[3] = flags;
  setFourCc(body, 4, options.groupingType ?? 'roll');
  view.setUint32(8, options.defaultLength ?? 2, false);
  view.setUint32(12, options.entryCount ?? 1, false);
  view.setInt16(16, options.rollDistance ?? -1, false);
  body.set(suffix, 18);
  return body;
}

function sbgpBody(
  options: {
    readonly version?: number;
    readonly flags?: number;
    readonly groupingType?: string;
    readonly entryCount?: number;
    readonly sampleCount?: number;
    readonly descriptionIndex?: number;
    readonly suffix?: Uint8Array;
  } = {},
): Uint8Array {
  const suffix = options.suffix ?? new Uint8Array(0);
  const body = new Uint8Array(20 + suffix.byteLength);
  const view = new DataView(body.buffer);
  body[0] = options.version ?? 0;
  const flags = options.flags ?? 0;
  body[1] = flags >>> 16;
  body[2] = flags >>> 8;
  body[3] = flags;
  setFourCc(body, 4, options.groupingType ?? 'roll');
  view.setUint32(8, options.entryCount ?? 1, false);
  view.setUint32(12, options.sampleCount ?? 6, false);
  view.setUint32(16, options.descriptionIndex ?? 1, false);
  body.set(suffix, 20);
  return body;
}

class MemorySource implements EncodedRandomAccessSource {
  identity = 'm4a-roll-recovery-fixture';
  readonly reads: ReadRecord[] = [];
  closeCalls = 0;
  mutateIdentityAfterRead = false;

  constructor(readonly bytes: Uint8Array) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push(Object.freeze({ offset, length }));
    const result = this.bytes.slice(offset, end);
    if (this.mutateIdentityAfterRead) this.identity = 'mutated-roll-recovery-source';
    return result;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function rootRef(
  reader: IsoBmffBoxReader,
): Promise<NonNullable<Awaited<ReturnType<ReturnType<IsoBmffBoxReader['createCursor']>['next']>>>> {
  const ref = await reader.createCursor().next(signal());
  if (ref === null) throw new Error('fixture root is missing');
  return ref;
}

async function readFixtureLayout(source: MemorySource): Promise<{
  readonly reader: IsoBmffBoxReader;
  readonly group: Readonly<M4aRollRecoverySampleGroupLayout>;
}> {
  const reader = new IsoBmffBoxReader(source);
  const layout = await readM4aSampleTableLayout(reader, await rootRef(reader), signal());
  if (layout.rollRecoverySampleGroup === null) throw new Error('fixture sample group is missing');
  return Object.freeze({ reader, group: layout.rollRecoverySampleGroup });
}

// Exact boxes emitted by FFmpeg 8.0.1 for a 0.1-s, 48-kHz AAC-LC M4A
// (`ffmpeg -f lavfi -i sine=...:duration=0.1 -c:a aac -b:a 128k`).
const FFMPEG_AAC_ROLL_SGPD = fromHex(
  '00 00 00 1a 73 67 70 64 01 00 00 00 72 6f 6c 6c 00 00 00 02 00 00 00 01 ff ff',
);
const FFMPEG_AAC_ROLL_SBGP = fromHex(
  '00 00 00 1c 73 62 67 70 00 00 00 00 72 6f 6c 6c 00 00 00 01 00 00 00 06 00 00 00 01',
);

describe('M4A AAC roll-recovery sample groups', () => {
  it('admits the exact real FFmpeg pair as one frozen preroll AU', async () => {
    const source = new MemorySource(stbl(FFMPEG_AAC_ROLL_SGPD, FFMPEG_AAC_ROLL_SBGP));
    const { reader, group } = await readFixtureLayout(source);

    const evidence = await readM4aAacRollRecoveryEvidence(reader, group, 6, signal());

    expect(evidence).toEqual({ requiredPrerollAccessUnits: 1 });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(source.reads.every((read) => read.length <= 64 * 1_024)).toBe(true);
    expect(source.closeCalls).toBe(0);
  });

  it('returns null without another physical read when the pair is absent', async () => {
    const source = new MemorySource(stbl());
    const reader = new IsoBmffBoxReader(source);
    const layout = await readM4aSampleTableLayout(reader, await rootRef(reader), signal());
    const readsBefore = source.reads.length;

    await expect(readM4aAacRollRecoveryEvidence(reader, null, 6, signal())).resolves.toBeNull();
    expect(layout.rollRecoverySampleGroup).toBeNull();
    expect(source.reads).toHaveLength(readsBefore);
  });

  it.each([
    ['sgpd version', sgpdBody({ version: 0 }), sbgpBody(), /version 1 and flags 0/],
    ['sgpd flags', sgpdBody({ flags: 1 }), sbgpBody(), /version 1 and flags 0/],
    ['sgpd default length', sgpdBody({ defaultLength: 4 }), sbgpBody(), /must be 2/],
    ['sgpd descriptions', sgpdBody({ entryCount: 2 }), sbgpBody(), /exactly one description/],
    ['sgpd distance', sgpdBody({ rollDistance: -2 }), sbgpBody(), /exactly -1/],
    ['sbgp version', sgpdBody(), sbgpBody({ version: 1 }), /version 0 and flags 0/],
    ['sbgp flags', sgpdBody(), sbgpBody({ flags: 1 }), /version 0 and flags 0/],
    ['sbgp multiple runs', sgpdBody(), sbgpBody({ entryCount: 2 }), /exactly one run/],
    ['sbgp wrong count', sgpdBody(), sbgpBody({ sampleCount: 5 }), /exact AAC access-unit count/],
    ['sbgp zero index', sgpdBody(), sbgpBody({ descriptionIndex: 0 }), /index must be exactly 1/],
    ['sbgp other index', sgpdBody(), sbgpBody({ descriptionIndex: 2 }), /index must be exactly 1/],
  ] as const)('rejects %s', async (_label, sgpd, sbgp, message) => {
    const source = new MemorySource(stbl(box('sgpd', sgpd), box('sbgp', sbgp)));
    const { reader, group } = await readFixtureLayout(source);
    await expect(readM4aAacRollRecoveryEvidence(reader, group, 6, signal())).rejects.toThrow(
      message,
    );
  });

  it.each(['sgpd', 'sbgp'] as const)(
    'rejects same-identity %s grouping-type mutation after discovery',
    async (type) => {
      const source = new MemorySource(stbl(FFMPEG_AAC_ROLL_SGPD, FFMPEG_AAC_ROLL_SBGP));
      const { reader, group } = await readFixtureLayout(source);
      setFourCc(source.bytes, group[type].dataStart + 4, 'prol');

      await expect(readM4aAacRollRecoveryEvidence(reader, group, 6, signal())).rejects.toThrow(
        /must be "roll"/,
      );
    },
  );

  it.each([
    ['truncated sgpd', sgpdBody().slice(0, -1), sbgpBody(), /sgpd body has 17 bytes/],
    ['trailing sgpd', sgpdBody({ suffix: Uint8Array.of(0) }), sbgpBody(), /sgpd body has 19 bytes/],
    ['truncated sbgp', sgpdBody(), sbgpBody().slice(0, -1), /sbgp body has 19 bytes/],
    ['trailing sbgp', sgpdBody(), sbgpBody({ suffix: Uint8Array.of(0) }), /sbgp body has 21 bytes/],
  ] as const)('rejects %s', async (_label, sgpd, sbgp, message) => {
    const source = new MemorySource(stbl(box('sgpd', sgpd), box('sbgp', sbgp)));
    const { reader, group } = await readFixtureLayout(source);
    await expect(readM4aAacRollRecoveryEvidence(reader, group, 6, signal())).rejects.toThrow(
      message,
    );
  });

  it('rejects invalid expected AU counts before reading either group body', async () => {
    for (const count of [0, M4A_AAC_MAX_ACCESS_UNITS + 1]) {
      const source = new MemorySource(stbl(FFMPEG_AAC_ROLL_SGPD, FFMPEG_AAC_ROLL_SBGP));
      const { reader, group } = await readFixtureLayout(source);
      const readsBefore = source.reads.length;
      await expect(readM4aAacRollRecoveryEvidence(reader, group, count, signal())).rejects.toThrow(
        /expected AAC access-unit count/,
      );
      expect(source.reads).toHaveLength(readsBefore);
    }
  });

  it('rejects foreign, cloned, and swapped layouts through module provenance', async () => {
    const first = await readFixtureLayout(
      new MemorySource(stbl(FFMPEG_AAC_ROLL_SGPD, FFMPEG_AAC_ROLL_SBGP)),
    );
    const second = await readFixtureLayout(
      new MemorySource(stbl(FFMPEG_AAC_ROLL_SGPD, FFMPEG_AAC_ROLL_SBGP)),
    );

    await expect(
      readM4aAacRollRecoveryEvidence(first.reader, second.group, 6, signal()),
    ).rejects.toThrow(/different source reader/);
    const cloned = Object.freeze({ sgpd: first.group.sgpd, sbgp: first.group.sbgp });
    await expect(readM4aAacRollRecoveryEvidence(first.reader, cloned, 6, signal())).rejects.toThrow(
      /lacks module provenance/,
    );
    const swapped = Object.freeze({ sgpd: first.group.sbgp, sbgp: first.group.sgpd });
    await expect(
      readM4aAacRollRecoveryEvidence(first.reader, swapped, 6, signal()),
    ).rejects.toThrow(/lacks module provenance/);
  });

  it('rejects a same-reader pair spliced across two stbl boxes', async () => {
    const source = new MemorySource(
      concatenate(
        stbl(FFMPEG_AAC_ROLL_SGPD, FFMPEG_AAC_ROLL_SBGP),
        stbl(box('sgpd', sgpdBody()), box('sbgp', sbgpBody({ sampleCount: 7 }))),
      ),
    );
    const reader = new IsoBmffBoxReader(source);
    const roots = reader.createCursor();
    const firstRoot = await roots.next(signal());
    const secondRoot = await roots.next(signal());
    if (firstRoot === null || secondRoot === null) throw new Error('fixture stbl is missing');
    const firstLayout = await readM4aSampleTableLayout(reader, firstRoot, signal());
    const secondLayout = await readM4aSampleTableLayout(reader, secondRoot, signal());
    if (
      firstLayout.rollRecoverySampleGroup === null ||
      secondLayout.rollRecoverySampleGroup === null
    ) {
      throw new Error('fixture sample group is missing');
    }
    const spliced = Object.freeze({
      sgpd: firstLayout.rollRecoverySampleGroup.sgpd,
      sbgp: secondLayout.rollRecoverySampleGroup.sbgp,
    });

    await expect(readM4aAacRollRecoveryEvidence(reader, spliced, 7, signal())).rejects.toThrow(
      /lacks module provenance/,
    );
  });

  it('preserves abort and source-identity failures without closing the source', async () => {
    const abortedSource = new MemorySource(stbl(FFMPEG_AAC_ROLL_SGPD, FFMPEG_AAC_ROLL_SBGP));
    const abortedFixture = await readFixtureLayout(abortedSource);
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'roll-before' });
    controller.abort(reason);
    const readsBefore = abortedSource.reads.length;
    await expect(
      readM4aAacRollRecoveryEvidence(
        abortedFixture.reader,
        abortedFixture.group,
        6,
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(abortedSource.reads).toHaveLength(readsBefore);

    const mutableSource = new MemorySource(stbl(FFMPEG_AAC_ROLL_SGPD, FFMPEG_AAC_ROLL_SBGP));
    const mutableFixture = await readFixtureLayout(mutableSource);
    mutableSource.mutateIdentityAfterRead = true;
    await expect(
      readM4aAacRollRecoveryEvidence(mutableFixture.reader, mutableFixture.group, 6, signal()),
    ).rejects.toThrow(/source changed/);
    expect(abortedSource.closeCalls).toBe(0);
    expect(mutableSource.closeCalls).toBe(0);
  });
});
