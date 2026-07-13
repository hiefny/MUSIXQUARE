import { describe, expect, it } from 'vitest';

import { IsoBmffBoxReader } from '../../mp4/box-reader.ts';
import {
  type EncodedRandomAccessSource,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import {
  M4A_STTS_MAX_PAGE_BYTES,
  readM4aAacSttsEvidence,
  readM4aSampleTableLayout,
} from '../sample-table-layout.ts';
import { M4A_AAC_MAX_STTS_ENTRIES } from '../timeline.ts';

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(length);
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
  return box('stbl', concatenate(...children));
}

function requiredChildren(chunkType: 'stco' | 'co64' = 'stco'): readonly Uint8Array[] {
  return [box('stsd'), box('stts'), box('stsc'), box('stsz'), box(chunkType)];
}

function setFourCc(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < 4; index += 1) bytes[offset + index] = value.charCodeAt(index);
}

function sampleGroupBox(
  type: 'sgpd' | 'sbgp',
  groupingType = 'roll',
  version = type === 'sgpd' ? 1 : 0,
): Uint8Array {
  const bodyBytes =
    type === 'sgpd' ? (version === 0 ? 12 : version === 1 ? 16 : 20) : version === 1 ? 16 : 12;
  const body = new Uint8Array(bodyBytes);
  body[0] = version;
  setFourCc(body, 4, groupingType);
  return box(type, body);
}

function sttsBody(
  entries: readonly (readonly [sampleCount: number, sampleDelta: number])[],
  declaredCount = entries.length,
  suffix = new Uint8Array(0),
): Uint8Array {
  const body = new Uint8Array(8 + entries.length * 8 + suffix.byteLength);
  const view = new DataView(body.buffer);
  view.setUint32(4, declaredCount, false);
  entries.forEach(([count, delta], index) => {
    view.setUint32(8 + index * 8, count, false);
    view.setUint32(12 + index * 8, delta, false);
  });
  body.set(suffix, 8 + entries.length * 8);
  return body;
}

class MemorySource implements EncodedRandomAccessSource {
  identity = 'm4a-sample-table-fixture';
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
    if (this.mutateIdentityAfterRead) this.identity = 'mutated-stts-source';
    return result;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function rootRef(reader: IsoBmffBoxReader) {
  const ref = await reader.createCursor().next(signal());
  if (ref === null) throw new Error('fixture root is missing');
  return ref;
}

describe('M4A sample-table layout', () => {
  it.each(['stco', 'co64'] as const)(
    'retains one provenance-bound %s layout independent of child ordering',
    async (chunkType) => {
      const bytes = stbl(box('stsz'), box(chunkType), box('stsd'), box('stsc'), box('stts'));
      const source = new MemorySource(bytes);
      const reader = new IsoBmffBoxReader(source);
      const layout = await readM4aSampleTableLayout(reader, await rootRef(reader), signal());

      expect(layout).toMatchObject({
        stsd: { type: 'stsd' },
        stts: { type: 'stts' },
        stsc: { type: 'stsc' },
        stsz: { type: 'stsz' },
        chunkOffsets: { type: chunkType },
        chunkOffsetWidthBytes: chunkType === 'stco' ? 4 : 8,
        rollRecoverySampleGroup: null,
      });
      expect(Object.isFrozen(layout)).toBe(true);
      expect(source.closeCalls).toBe(0);
      expect(() => new IsoBmffBoxReader(source).createChildCursor(layout.stts)).toThrow(
        /not issued by this reader/,
      );
    },
  );

  it.each(['stsd', 'stts', 'stsc', 'stsz'])(
    'rejects duplicate and missing %s boxes',
    async (type) => {
      const required = requiredChildren();
      const duplicate = stbl(...required, box(type));
      const missing = stbl(
        ...required.filter((child) => String.fromCharCode(...child.slice(4, 8)) !== type),
      );

      for (const [bytes, message] of [
        [duplicate, /duplicate/],
        [missing, /missing/],
      ] as const) {
        const reader = new IsoBmffBoxReader(new MemorySource(bytes));
        await expect(
          readM4aSampleTableLayout(reader, await rootRef(reader), signal()),
        ).rejects.toThrow(message);
      }
    },
  );

  it('requires exactly one chunk-offset table', async () => {
    for (const [bytes, message] of [
      [stbl(...requiredChildren().filter((_child, index) => index !== 4)), /missing stco or co64/],
      [stbl(...requiredChildren(), box('co64')), /exactly one of stco or co64/],
      [stbl(...requiredChildren(), box('stco')), /exactly one of stco or co64/],
    ] as const) {
      const reader = new IsoBmffBoxReader(new MemorySource(bytes));
      await expect(
        readM4aSampleTableLayout(reader, await rootRef(reader), signal()),
      ).rejects.toThrow(message);
    }
  });

  it('retains exactly one paired sgpd and sbgp layout', async () => {
    const source = new MemorySource(
      stbl(...requiredChildren(), sampleGroupBox('sbgp'), sampleGroupBox('sgpd')),
    );
    const reader = new IsoBmffBoxReader(source);
    const layout = await readM4aSampleTableLayout(reader, await rootRef(reader), signal());

    expect(layout.rollRecoverySampleGroup).toMatchObject({
      sgpd: { type: 'sgpd' },
      sbgp: { type: 'sbgp' },
    });
    expect(Object.isFrozen(layout.rollRecoverySampleGroup)).toBe(true);
  });

  it.each(['sgpd', 'sbgp'] as const)('rejects orphan and duplicate %s boxes', async (type) => {
    const other = type === 'sgpd' ? 'sbgp' : 'sgpd';
    for (const [bytes, message] of [
      [stbl(...requiredChildren(), sampleGroupBox(type)), /must appear as a pair/],
      [
        stbl(
          ...requiredChildren(),
          sampleGroupBox(type),
          sampleGroupBox(other),
          sampleGroupBox(type),
        ),
        /duplicate/,
      ],
    ] as const) {
      const reader = new IsoBmffBoxReader(new MemorySource(bytes));
      await expect(
        readM4aSampleTableLayout(reader, await rootRef(reader), signal()),
      ).rejects.toThrow(message);
    }
  });

  it('retains only roll while skipping coexisting and orphan non-roll sample groups', async () => {
    const source = new MemorySource(
      stbl(
        ...requiredChildren(),
        sampleGroupBox('sgpd', 'tele', 2),
        sampleGroupBox('sbgp', 'sync'),
        sampleGroupBox('sgpd', 'seig'),
        sampleGroupBox('sbgp', 'roll'),
        sampleGroupBox('sbgp', 'seig'),
        sampleGroupBox('sgpd', 'roll'),
      ),
    );
    const reader = new IsoBmffBoxReader(source);

    const layout = await readM4aSampleTableLayout(reader, await rootRef(reader), signal());

    expect(layout.rollRecoverySampleGroup).toMatchObject({
      sgpd: { type: 'sgpd' },
      sbgp: { type: 'sbgp' },
    });
    expect(source.reads.every((read) => read.length <= M4A_STTS_MAX_PAGE_BYTES)).toBe(true);
  });

  it('ignores a structurally bounded version-2 non-roll orphan sgpd', async () => {
    const source = new MemorySource(stbl(...requiredChildren(), sampleGroupBox('sgpd', 'tele', 2)));
    const reader = new IsoBmffBoxReader(source);

    await expect(
      readM4aSampleTableLayout(reader, await rootRef(reader), signal()),
    ).resolves.toMatchObject({ rollRecoverySampleGroup: null });
  });

  it.each([
    ['common prefix', box('sgpd', new Uint8Array(7)), /prefix is truncated/],
    [
      'version-dependent prefix',
      box(
        'sgpd',
        (() => {
          const body = new Uint8Array(19);
          body[0] = 2;
          setFourCc(body, 4, 'tele');
          return body;
        })(),
      ),
      /shorter than 20 bytes/,
    ],
  ])('rejects a truncated sample-group %s', async (_label, group, message) => {
    const reader = new IsoBmffBoxReader(new MemorySource(stbl(...requiredChildren(), group)));
    await expect(readM4aSampleTableLayout(reader, await rootRef(reader), signal())).rejects.toThrow(
      message,
    );
  });

  it.each(['ctts', 'stz2', 'saiz', 'saio', 'subs', 'sdtp', 'stss'])(
    'fails closed on unsupported %s metadata',
    async (type) => {
      const bytes = stbl(...requiredChildren(), box(type));
      const reader = new IsoBmffBoxReader(new MemorySource(bytes));
      await expect(
        readM4aSampleTableLayout(reader, await rootRef(reader), signal()),
      ).rejects.toThrow(/Unsupported M4A sample-table box/);
    },
  );

  it('fails closed on unknown children and foreign or wrong parent references', async () => {
    const unknownBytes = stbl(...requiredChildren(), box('junk'));
    const unknownReader = new IsoBmffBoxReader(new MemorySource(unknownBytes));
    await expect(
      readM4aSampleTableLayout(unknownReader, await rootRef(unknownReader), signal()),
    ).rejects.toThrow(/Unknown M4A sample-table box/);

    const wrongSource = new MemorySource(box('moov'));
    const wrongReader = new IsoBmffBoxReader(wrongSource);
    await expect(
      readM4aSampleTableLayout(wrongReader, await rootRef(wrongReader), signal()),
    ).rejects.toThrow(/must be an stbl/);

    const validSource = new MemorySource(stbl(...requiredChildren()));
    const first = new IsoBmffBoxReader(validSource);
    const foreign = await rootRef(first);
    await expect(
      readM4aSampleTableLayout(new IsoBmffBoxReader(validSource), foreign, signal()),
    ).rejects.toThrow(/not issued by this reader/);
  });
});

describe('bounded M4A AAC stts reads', () => {
  it('streams ordinary and shortened-final runs into branded evidence', async () => {
    const source = new MemorySource(
      box(
        'stts',
        sttsBody([
          [44, 1_024],
          [1, 68],
        ]),
      ),
    );
    const reader = new IsoBmffBoxReader(source);
    const evidence = await readM4aAacSttsEvidence(reader, await rootRef(reader), signal());

    expect(evidence).toEqual({
      accessUnitCount: 45,
      presentationEndCoreFrames: 45_124,
      finalAccessUnitDelta: 68,
      entryCount: 2,
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(source.closeCalls).toBe(0);
  });

  it('pages a greater-than-64-KiB table without retaining or over-reading it', async () => {
    const entries = Array.from(
      { length: M4A_STTS_MAX_PAGE_BYTES / 8 + 1 },
      () => [1, 1_024] as const,
    );
    const source = new MemorySource(box('stts', sttsBody(entries)));
    const reader = new IsoBmffBoxReader(source);
    const evidence = await readM4aAacSttsEvidence(reader, await rootRef(reader), signal());

    expect(evidence.entryCount).toBe(entries.length);
    expect(evidence.accessUnitCount).toBe(entries.length);
    expect(source.reads).toContainEqual({ offset: 16, length: M4A_STTS_MAX_PAGE_BYTES });
    expect(source.reads).toContainEqual({
      offset: 16 + M4A_STTS_MAX_PAGE_BYTES,
      length: 8,
    });
    expect(source.reads.every((read) => read.length <= M4A_STTS_MAX_PAGE_BYTES)).toBe(true);
  });

  it.each([
    ['zero count', sttsBody([], 0), /entry count must be from 1/],
    ['count too large', sttsBody([], M4A_AAC_MAX_STTS_ENTRIES + 1), /entry count must be from 1/],
    ['declared count too small', sttsBody([[1, 1_024]], 0), /entry count must be from 1/],
    ['declared count too large', sttsBody([[1, 1_024]], 2), /expected 24/],
    ['trailing bytes', sttsBody([[1, 1_024]], 1, Uint8Array.of(0)), /expected 16/],
  ])('rejects %s', async (_label, body, message) => {
    const source = new MemorySource(box('stts', body));
    const reader = new IsoBmffBoxReader(source);
    await expect(readM4aAacSttsEvidence(reader, await rootRef(reader), signal())).rejects.toThrow(
      message,
    );
  });

  it('rejects nonzero FullBox flags and a shortened nonterminal AU', async () => {
    const flagsBody = sttsBody([[1, 1_024]]);
    flagsBody[3] = 1;
    const invalidBodies = [
      flagsBody,
      sttsBody([
        [1, 68],
        [1, 1_024],
      ]),
    ];
    for (const body of invalidBodies) {
      const reader = new IsoBmffBoxReader(new MemorySource(box('stts', body)));
      await expect(
        readM4aAacSttsEvidence(reader, await rootRef(reader), signal()),
      ).rejects.toThrow();
    }
  });

  it('preserves abort and source-identity failure without closing the source', async () => {
    const bytes = box('stts', sttsBody([[1, 1_024]]));
    const aborted = new AbortController();
    const reason = Object.freeze({ phase: 'stts-before' });
    aborted.abort(reason);
    const untouched = new MemorySource(bytes);
    const untouchedReader = new IsoBmffBoxReader(untouched);
    const ref = await rootRef(untouchedReader);
    const readsBefore = untouched.reads.length;
    await expect(readM4aAacSttsEvidence(untouchedReader, ref, aborted.signal)).rejects.toBe(reason);
    expect(untouched.reads).toHaveLength(readsBefore);

    const mutable = new MemorySource(bytes);
    const mutableReader = new IsoBmffBoxReader(mutable);
    const mutableRef = await rootRef(mutableReader);
    mutable.mutateIdentityAfterRead = true;
    await expect(readM4aAacSttsEvidence(mutableReader, mutableRef, signal())).rejects.toThrow(
      /source changed/,
    );
    expect(untouched.closeCalls).toBe(0);
    expect(mutable.closeCalls).toBe(0);
  });
});
