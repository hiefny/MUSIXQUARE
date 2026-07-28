import { describe, expect, it, vi } from 'vitest';

import { IsoBmffBoxReader } from '../../mp4/box-reader.ts';
import {
  type EncodedRandomAccessSource,
  EncodedSourceClosedError,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import {
  M4A_ITUN_SMPB_MAX_CUSTOM_ITEMS,
  M4A_ITUN_SMPB_MAX_FIELD_BODY_BYTES,
  M4aITunSmpbError,
  parseM4aITunSmpbText,
  readM4aITunSmpb,
} from '../itunes-gapless.ts';

const encoder = new TextEncoder();
const SMPB_TEXT = ' 00000000 00000800 00000040 000000000077AC00 00000000 00000000 ';

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function box(type: string, ...bodyParts: readonly Uint8Array[]): Uint8Array {
  if (type.length !== 4) throw new TypeError('test box type must contain four characters');
  const body = concat(...bodyParts);
  const result = new Uint8Array(8 + body.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, result.byteLength, false);
  for (let index = 0; index < 4; index += 1) result[4 + index] = type.charCodeAt(index);
  result.set(body, 8);
  return result;
}

function fullBoxString(text: string): Uint8Array {
  return concat(new Uint8Array(4), encoder.encode(text));
}

function dataBody(
  text: string | Uint8Array,
  options: Readonly<{ flags?: number; locale?: number }> = {},
): Uint8Array {
  const value = typeof text === 'string' ? encoder.encode(text) : text;
  const result = new Uint8Array(8 + value.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, options.flags ?? 1, false);
  view.setUint32(4, options.locale ?? 0, false);
  result.set(value, 8);
  return result;
}

function customItem(
  options: Readonly<{
    mean?: string;
    name?: string;
    data?: Uint8Array;
    order?: readonly ('mean' | 'name' | 'data')[];
    extra?: Uint8Array;
  }> = {},
): Uint8Array {
  const children = {
    mean: box('mean', fullBoxString(options.mean ?? 'com.apple.iTunes')),
    name: box('name', fullBoxString(options.name ?? 'iTunSMPB')),
    data: box('data', options.data ?? dataBody(SMPB_TEXT)),
  };
  const order = options.order ?? (['mean', 'name', 'data'] as const);
  return box(
    '----',
    ...order.map((key) => children[key]),
    ...(options.extra ? [options.extra] : []),
  );
}

function metadataUdta(
  items: readonly Uint8Array[],
  options: Readonly<{
    handlerType?: string;
    handlerManufacturer?: string;
    handlerNameBytes?: Uint8Array;
    extraUdta?: readonly Uint8Array[];
    extraMeta?: readonly Uint8Array[];
  }> = {},
): Uint8Array {
  const handler = new Uint8Array(24);
  const handlerType = options.handlerType ?? 'mdir';
  for (let index = 0; index < 4; index += 1) handler[8 + index] = handlerType.charCodeAt(index);
  if (options.handlerManufacturer !== undefined) {
    if (options.handlerManufacturer.length !== 4) {
      throw new TypeError('test handler manufacturer must contain four characters');
    }
    for (let index = 0; index < 4; index += 1) {
      handler[12 + index] = options.handlerManufacturer.charCodeAt(index);
    }
  }
  const hdlr = box('hdlr', handler, options.handlerNameBytes ?? new Uint8Array(0));
  const ilst = box('ilst', ...items);
  const meta = box('meta', new Uint8Array(4), hdlr, ilst, ...(options.extraMeta ?? []));
  return box('udta', ...(options.extraUdta ?? []), meta);
}

interface ReadLogEntry {
  readonly offset: number;
  readonly length: number;
}

class MemorySource implements EncodedRandomAccessSource {
  identity = 'm4a-itunes-gapless-test-source';
  readonly reads: ReadLogEntry[] = [];
  readonly close = vi.fn(async (): Promise<void> => undefined);
  closed = false;
  mutateIdentityOnNextRead = false;

  constructor(readonly bytes: Uint8Array) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    if (this.closed) throw new EncodedSourceClosedError();
    if (signal.aborted) throw signal.reason;
    validateExactRead(this.size, offset, length);
    this.reads.push(Object.freeze({ offset, length }));
    const result = this.bytes.slice(offset, offset + length);
    if (this.mutateIdentityOnNextRead) {
      this.mutateIdentityOnNextRead = false;
      this.identity = 'mutated-m4a-source';
    }
    return result;
  }
}

async function openRoot(bytes: Uint8Array): Promise<
  Readonly<{
    source: MemorySource;
    reader: IsoBmffBoxReader;
    root: Awaited<ReturnType<ReturnType<IsoBmffBoxReader['createCursor']>['next']>>;
  }>
> {
  const source = new MemorySource(bytes);
  const reader = new IsoBmffBoxReader(source);
  const root = await reader.createCursor().next(new AbortController().signal);
  if (root === null) throw new Error('test fixture root is missing');
  return Object.freeze({ source, reader, root });
}

describe('parseM4aITunSmpbText', () => {
  it('parses, snapshots, and freezes the canonical Apple fields with bounded trailing fields', () => {
    const parsed = parseM4aITunSmpbText(
      '\t00000000 00000800 00000040 000000000077ac00 00000000 0000000000000000\r\n',
    );
    expect(parsed).toEqual({
      primingCoreFrames: 2_048,
      remainderCoreFrames: 64,
      audibleCoreFrames: 0x77_ac00,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    ['missing field', '00000000 00000800 00000040', /at least four/i],
    ['reserved value', '00000001 00000800 00000040 000000000077AC00', /reserved.*zero/i],
    ['bad hex', '00000000 00000Z00 00000040 000000000077AC00', /hexadecimal/i],
    ['short field', '00000000 0000080 00000040 000000000077AC00', /exactly 8/i],
    ['zero audible', '00000000 00000800 00000040 0000000000000000', /positive/i],
    ['unsafe audible', '00000000 00000800 00000040 0020000000000000', /safe-integer/i],
    ['bad trailing field', '00000000 00000800 00000040 000000000077AC00 0000', /trailing/i],
    ['non-ASCII', '00000000 00000800 00000040 000000000077AC00\u00a0', /ASCII only/i],
    [
      'too long',
      `00000000 00000800 00000040 000000000077AC00 ${'0'.repeat(220)}`,
      /1 through 256/i,
    ],
  ])('rejects %s text', (_name, text, expected) => {
    expect(() => parseM4aITunSmpbText(text)).toThrow(expected);
  });
});

describe('readM4aITunSmpb', () => {
  it('reads a real iTunes-style appl handler and skips unknown meta bodies and the name tail', async () => {
    const giantMetaPadding = box('free', new Uint8Array(1024 * 1024));
    const { source, reader, root } = await openRoot(
      metadataUdta([customItem({ order: ['data', 'name', 'mean'] })], {
        handlerManufacturer: 'appl',
        handlerNameBytes: encoder.encode('Apple Sound Media Handler\0'),
        extraUdta: [box('free', new Uint8Array(37))],
        extraMeta: [giantMetaPadding],
      }),
    );

    await expect(readM4aITunSmpb(reader, root, new AbortController().signal)).resolves.toEqual({
      primingCoreFrames: 2_048,
      remainderCoreFrames: 64,
      audibleCoreFrames: 0x77_ac00,
    });
    expect(source.close).not.toHaveBeenCalled();
    expect(Math.max(...source.reads.map((read) => read.length))).toBeLessThan(256);
  });

  it('returns null for an absent udta or an udta without meta', async () => {
    const emptySource = new MemorySource(new Uint8Array(0));
    const emptyReader = new IsoBmffBoxReader(emptySource);
    await expect(
      readM4aITunSmpb(emptyReader, null, new AbortController().signal),
    ).resolves.toBeNull();

    const { source, reader, root } = await openRoot(box('udta', box('free', new Uint8Array(9))));
    await expect(readM4aITunSmpb(reader, root, new AbortController().signal)).resolves.toBeNull();
    expect(source.close).not.toHaveBeenCalled();
  });

  it('never reads a giant cover-art body while finding a later gapless item', async () => {
    const giantCover = box('covr', new Uint8Array(1024 * 1024));
    const { source, reader, root } = await openRoot(
      metadataUdta([giantCover, customItem()], {
        handlerNameBytes: new Uint8Array(8 * 1024),
      }),
    );

    await expect(
      readM4aITunSmpb(reader, root, new AbortController().signal),
    ).resolves.toMatchObject({
      primingCoreFrames: 2_048,
    });
    expect(Math.max(...source.reads.map((read) => read.length))).toBeLessThan(256);
  });

  it('resolves mean and name before reading an unrelated custom data body', async () => {
    const unrelated = customItem({
      mean: 'org.example.player',
      data: new Uint8Array(2_048),
      order: ['data', 'name', 'mean'],
    });
    const { source, reader, root } = await openRoot(metadataUdta([unrelated, customItem()]));

    await expect(
      readM4aITunSmpb(reader, root, new AbortController().signal),
    ).resolves.toMatchObject({
      audibleCoreFrames: 0x77_ac00,
    });
    expect(source.reads.some((read) => read.length === 2_048)).toBe(false);
  });

  it('ignores a Mutagen-style unrelated multi-data freeform item without reading its values', async () => {
    const unrelated = customItem({
      name: 'PERFORMER',
      data: dataBody('first artist'),
      extra: box('data', dataBody(new Uint8Array(3_000))),
    });
    const { source, reader, root } = await openRoot(metadataUdta([unrelated, customItem()]));

    await expect(
      readM4aITunSmpb(reader, root, new AbortController().signal),
    ).resolves.toMatchObject({
      primingCoreFrames: 2_048,
    });
    expect(source.reads.some((read) => read.length >= 3_000)).toBe(false);
  });

  it('discards duplicate or conflicting matching records without rejecting the audio file', async () => {
    const conflicting = customItem({
      data: dataBody('00000000 00000400 00000000 0000000000001000'),
    });
    const { reader, root } = await openRoot(metadataUdta([customItem(), conflicting]));
    await expect(readM4aITunSmpb(reader, root, new AbortController().signal)).resolves.toBeNull();
  });

  it('discards a matching item unless it has exactly one usable data value', async () => {
    const missing = await openRoot(metadataUdta([customItem({ order: ['mean', 'name'] })]));
    await expect(
      readM4aITunSmpb(missing.reader, missing.root, new AbortController().signal),
    ).resolves.toBeNull();

    const duplicated = await openRoot(
      metadataUdta([customItem({ extra: box('data', dataBody(SMPB_TEXT)) })]),
    );
    await expect(
      readM4aITunSmpb(duplicated.reader, duplicated.root, new AbortController().signal),
    ).resolves.toBeNull();
  });

  it.each([
    ['malformed UTF-8', dataBody(new Uint8Array([0xc3, 0x28])), /well-formed UTF-8/i],
    ['malformed hex', dataBody('00000000 0000080Z 00000040 000000000077AC00'), /hexadecimal/i],
    ['overflow', dataBody('00000000 00000800 00000040 FFFFFFFFFFFFFFFF'), /safe-integer/i],
    ['wrong data type', dataBody(SMPB_TEXT, { flags: 2 }), /data type/i],
    ['nonzero locale', dataBody(SMPB_TEXT, { locale: 1 }), /locale must be zero/i],
    ['short data body', new Uint8Array(8), /must contain 9 through/i],
    [
      'oversized data body',
      new Uint8Array(M4A_ITUN_SMPB_MAX_FIELD_BODY_BYTES + 1),
      /must contain 9 through/i,
    ],
  ])('discards matching iTunSMPB %s without rejecting audio', async (_name, body, _expected) => {
    const { reader, root } = await openRoot(metadataUdta([customItem({ data: body })]));
    await expect(readM4aITunSmpb(reader, root, new AbortController().signal)).resolves.toBeNull();
  });

  it('discards metadata beyond the bounded custom-item count', async () => {
    const items = Array.from({ length: M4A_ITUN_SMPB_MAX_CUSTOM_ITEMS + 1 }, () => box('----'));
    const { reader, root } = await openRoot(metadataUdta(items));
    await expect(readM4aITunSmpb(reader, root, new AbortController().signal)).resolves.toBeNull();
  });

  it('treats mdta keys and unsupported metadata handlers as no gapless evidence', async () => {
    const mdta = await openRoot(
      metadataUdta([box('\u00a9nam', box('data', dataBody('title')))], {
        handlerType: 'mdta',
        extraMeta: [box('keys', new Uint8Array(32)), box('free', new Uint8Array(256))],
      }),
    );
    await expect(
      readM4aITunSmpb(mdta.reader, mdta.root, new AbortController().signal),
    ).resolves.toBeNull();

    const unsupportedManufacturer = await openRoot(
      metadataUdta([customItem()], { handlerManufacturer: 'zzzz' }),
    );
    await expect(
      readM4aITunSmpb(
        unsupportedManufacturer.reader,
        unsupportedManufacturer.root,
        new AbortController().signal,
      ),
    ).resolves.toBeNull();
  });

  it('rejects a nested box whose declared end escapes its exact parent span', async () => {
    const bytes = metadataUdta([customItem()]);
    new DataView(bytes.buffer).setUint32(8, bytes.byteLength + 32, false);
    const { reader, root } = await openRoot(bytes);
    await expect(readM4aITunSmpb(reader, root, new AbortController().signal)).rejects.toThrow(
      /escapes its parent span/i,
    );
  });

  it('rejects a foreign box reference and a provenance-valid non-udta parent', async () => {
    const fixture = metadataUdta([customItem()]);
    const first = await openRoot(fixture);
    const second = await openRoot(fixture);
    await expect(
      readM4aITunSmpb(second.reader, first.root, new AbortController().signal),
    ).rejects.toThrow(/not issued by this reader/i);

    const metaBytes = fixture.subarray(8);
    const meta = await openRoot(metaBytes);
    await expect(
      readM4aITunSmpb(meta.reader, meta.root, new AbortController().signal),
    ).rejects.toThrow(/parent must be a udta/i);
  });

  it('preserves the exact abort reason and rejects source mutation without closing it', async () => {
    const aborted = await openRoot(metadataUdta([customItem()]));
    const controller = new AbortController();
    const reason = Object.freeze({ code: 'test-abort' });
    controller.abort(reason);
    await expect(readM4aITunSmpb(aborted.reader, aborted.root, controller.signal)).rejects.toBe(
      reason,
    );

    const mutated = await openRoot(metadataUdta([customItem()]));
    mutated.source.mutateIdentityOnNextRead = true;
    await expect(
      readM4aITunSmpb(mutated.reader, mutated.root, new AbortController().signal),
    ).rejects.toThrow(/source changed/i);
    expect(mutated.source.close).not.toHaveBeenCalled();
  });

  it('downgrades non-mdir handlers and optional structural duplicates to absent evidence', async () => {
    const wrongHandler = await openRoot(metadataUdta([customItem()], { handlerType: 'soun' }));
    await expect(
      readM4aITunSmpb(wrongHandler.reader, wrongHandler.root, new AbortController().signal),
    ).resolves.toBeNull();

    const duplicateMeta = metadataUdta([], { extraUdta: [metadataUdta([]).subarray(8)] });
    const duplicated = await openRoot(duplicateMeta);
    await expect(
      readM4aITunSmpb(duplicated.reader, duplicated.root, new AbortController().signal),
    ).resolves.toBeNull();
  });

  it('uses its domain integrity error for parser failures', () => {
    expect(() => parseM4aITunSmpbText('not metadata')).toThrow(M4aITunSmpbError);
  });
});
