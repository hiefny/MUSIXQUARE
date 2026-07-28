import { describe, expect, it } from 'vitest';

import {
  copyMp4EsdsDecoderSpecificInfo,
  MP4_ESDS_MAX_DECODER_SPECIFIC_INFO_BYTES,
  MP4_ESDS_MAX_DESCRIPTOR_COUNT,
  MP4_ESDS_MAX_PAYLOAD_BYTES,
  parseMp4EsdsPayload,
} from '../esds.ts';

function concat(...parts: ReadonlyArray<Uint8Array | readonly number[]>): Uint8Array {
  let byteLength = 0;
  for (const part of parts) byteLength += part.length;
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function encodedLength(value: number, fourBytes = false): readonly number[] {
  if (fourBytes) {
    return [
      0x80 | ((value >>> 21) & 0x7f),
      0x80 | ((value >>> 14) & 0x7f),
      0x80 | ((value >>> 7) & 0x7f),
      value & 0x7f,
    ];
  }
  const values = [value & 0x7f];
  let remaining = Math.floor(value / 0x80);
  while (remaining > 0) {
    values.unshift(0x80 | (remaining & 0x7f));
    remaining = Math.floor(remaining / 0x80);
  }
  return values;
}

function descriptor(
  tag: number,
  payload: Uint8Array | readonly number[],
  fourByteLength = false,
): Uint8Array {
  return concat([tag], encodedLength(payload.length, fourByteLength), payload);
}

interface DecoderOptions {
  readonly objectType?: number;
  readonly streamTypeByte?: number;
  readonly dsi?: Uint8Array | readonly number[];
  readonly dsiFourByteLength?: boolean;
  readonly beforeDsi?: readonly Uint8Array[];
  readonly afterDsi?: readonly Uint8Array[];
  readonly includeDsi?: boolean;
  readonly fourByteLength?: boolean;
}

function decoderConfig(options: DecoderOptions = {}): Uint8Array {
  const fixed = [
    options.objectType ?? 0x40,
    options.streamTypeByte ?? 0x15,
    0x01,
    0x02,
    0x03,
    0x11,
    0x22,
    0x33,
    0x44,
    0x55,
    0x66,
    0x77,
    0x88,
  ];
  const dsi =
    options.includeDsi === false
      ? []
      : [descriptor(0x05, options.dsi ?? [0x12, 0x10], options.dsiFourByteLength)];
  return descriptor(
    0x04,
    concat(fixed, ...(options.beforeDsi ?? []), ...dsi, ...(options.afterDsi ?? [])),
    options.fourByteLength,
  );
}

interface EsOptions {
  readonly flags?: number;
  readonly optionalFields?: Uint8Array | readonly number[];
  readonly children?: readonly Uint8Array[];
  readonly fourByteLength?: boolean;
  readonly rootTag?: number;
  readonly versionFlags?: Uint8Array | readonly number[];
}

function esds(options: EsOptions = {}): Uint8Array {
  const es = descriptor(
    options.rootTag ?? 0x03,
    concat(
      [0x12, 0x34, options.flags ?? 0],
      options.optionalFields ?? [],
      ...(options.children ?? [decoderConfig()]),
    ),
    options.fourByteLength,
  );
  return concat(options.versionFlags ?? [0, 0, 0, 0], es);
}

describe('parseMp4EsdsPayload', () => {
  it('returns a frozen canonical MPEG-4 Audio record and fresh DSI copies', () => {
    const source = esds({ children: [decoderConfig(), descriptor(0x06, [0x02])] });
    const parsed = parseMp4EsdsPayload(source);

    expect(parsed).toEqual({
      esId: 0x1234,
      streamPriority: 0,
      dependsOnEsId: null,
      urlLengthBytes: null,
      ocrEsId: null,
      objectTypeIndication: 0x40,
      streamType: 0x05,
      upstream: false,
      bufferSizeDb: 0x010203,
      maxBitrate: 0x11223344,
      averageBitrate: 0x55667788,
      decoderSpecificInfo: [0x12, 0x10],
      hasSlConfig: true,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.decoderSpecificInfo)).toBe(true);
    expect(Object.keys(parsed)).toEqual([
      'esId',
      'streamPriority',
      'dependsOnEsId',
      'urlLengthBytes',
      'ocrEsId',
      'objectTypeIndication',
      'streamType',
      'upstream',
      'bufferSizeDb',
      'maxBitrate',
      'averageBitrate',
      'decoderSpecificInfo',
      'hasSlConfig',
    ]);

    source.fill(0xff);
    const firstCopy = copyMp4EsdsDecoderSpecificInfo(parsed);
    const secondCopy = copyMp4EsdsDecoderSpecificInfo(parsed);
    expect([...firstCopy]).toEqual([0x12, 0x10]);
    expect(secondCopy).not.toBe(firstCopy);
    firstCopy[0] = 0;
    expect([...secondCopy]).toEqual([0x12, 0x10]);
    expect(() => copyMp4EsdsDecoderSpecificInfo({ ...parsed })).toThrowError(
      /must be returned by parseMp4EsdsPayload/,
    );
  });

  it('accepts non-minimal four-byte descriptor lengths at every core level', () => {
    const input = esds({
      fourByteLength: true,
      children: [
        decoderConfig({
          fourByteLength: true,
          dsiFourByteLength: true,
        }),
      ],
    });
    expect(parseMp4EsdsPayload(input).decoderSpecificInfo).toEqual([0x12, 0x10]);
  });

  it('validates and skips every optional ES_Descriptor field', () => {
    const parsed = parseMp4EsdsPayload(
      esds({
        flags: 0xe9,
        optionalFields: [0xab, 0xcd, 3, 0x61, 0x62, 0x63, 0x45, 0x67],
      }),
    );
    expect(parsed).toMatchObject({
      streamPriority: 9,
      dependsOnEsId: 0xabcd,
      urlLengthBytes: 3,
      ocrEsId: 0x4567,
    });
  });

  it('bounded-skips unknown ES and DecoderConfig children without inspecting payload bytes', () => {
    const fakeCoreDescriptors = descriptor(0x7f, [0x03, 0xff, 0xff, 0xff, 0xff, 0x05, 0x80]);
    const parsed = parseMp4EsdsPayload(
      esds({
        children: [
          descriptor(0x20, [0xaa]),
          decoderConfig({
            beforeDsi: [fakeCoreDescriptors],
            afterDsi: [descriptor(0x14, [0xbb, 0xcc])],
          }),
          descriptor(0x21, [0xdd]),
        ],
      }),
    );
    expect(parsed.decoderSpecificInfo).toEqual([0x12, 0x10]);
  });

  it('leaves an empty DecoderSpecificInfo for the separate ASC validator', () => {
    expect(parseMp4EsdsPayload(esds({ children: [decoderConfig({ dsi: [] })] }))).toMatchObject({
      decoderSpecificInfo: [],
    });
  });

  it.each([
    ['version', [1, 0, 0, 0]],
    ['flags', [0, 0, 0, 1]],
  ])('rejects a nonzero FullBox %s', (_label, versionFlags) => {
    expect(() => parseMp4EsdsPayload(esds({ versionFlags }))).toThrowError(
      /version and flags must be zero/,
    );
  });

  it('rejects truncated and overlong descriptor lengths', () => {
    expect(() => parseMp4EsdsPayload(new Uint8Array([0, 0, 0, 0, 0x03, 0x80]))).toThrowError(
      /length.*truncated/,
    );
    expect(() =>
      parseMp4EsdsPayload(new Uint8Array([0, 0, 0, 0, 0x03, 0x80, 0x80, 0x80, 0x80])),
    ).toThrowError(/continues beyond four bytes/);
    expect(() =>
      parseMp4EsdsPayload(new Uint8Array([0, 0, 0, 0, 0x03, 0x7f, 0, 0, 0])),
    ).toThrowError(/escapes its parent boundary/);
  });

  it.each([
    ['dependsOn_ES_ID', 0x80, []],
    ['URL length', 0x40, []],
    ['URL bytes', 0x40, [2, 0x61]],
    ['OCR_ES_Id', 0x20, [0x12]],
  ])('rejects a truncated optional %s field', (_label, flags, optionalFields) => {
    const root = descriptor(0x03, [0, 1, flags, ...optionalFields]);
    expect(() => parseMp4EsdsPayload(concat([0, 0, 0, 0], root))).toThrowError(/truncated/);
  });

  it('rejects truncated DecoderConfig fixed fields', () => {
    expect(() =>
      parseMp4EsdsPayload(esds({ children: [descriptor(0x04, [0x40, 0x15])] })),
    ).toThrowError(/fixed fields is truncated/);
  });

  it.each([
    ['wrong root', esds({ rootTag: 0x04 }), /root must be an ES_Descriptor/],
    [
      'DSI at ES level',
      esds({ children: [descriptor(0x05, [0x12, 0x10]), decoderConfig()] }),
      /wrong parent/,
    ],
    [
      'ES at DecoderConfig level',
      esds({
        children: [decoderConfig({ beforeDsi: [descriptor(0x03, [])] })],
      }),
      /wrong parent/,
    ],
    [
      'SLConfig before DecoderConfig',
      esds({ children: [descriptor(0x06, [2]), decoderConfig()] }),
      /appears before DecoderConfigDescriptor/,
    ],
  ])('rejects %s descriptor ordering', (_label, input, error) => {
    expect(() => parseMp4EsdsPayload(input)).toThrowError(error);
  });

  it.each([
    ['object type', { objectType: 0x6b }, /not MPEG-4 Audio/],
    ['stream type', { streamTypeByte: 0x11 }, /not an audio stream/],
    ['upstream flag', { streamTypeByte: 0x17 }, /upstream flag must be zero/],
    ['reserved bit', { streamTypeByte: 0x14 }, /reserved bit must be one/],
  ])('rejects the wrong DecoderConfig %s', (_label, decoderOptions, error) => {
    expect(() =>
      parseMp4EsdsPayload(esds({ children: [decoderConfig(decoderOptions)] })),
    ).toThrowError(error);
  });

  it('requires DecoderConfigDescriptor and DecoderSpecificInfo', () => {
    expect(() => parseMp4EsdsPayload(esds({ children: [descriptor(0x20, [])] }))).toThrowError(
      /missing DecoderConfigDescriptor/,
    );
    expect(() =>
      parseMp4EsdsPayload(esds({ children: [decoderConfig({ includeDsi: false })] })),
    ).toThrowError(/missing DecoderSpecificInfo/);
  });

  it('rejects duplicate core descriptors', () => {
    expect(() =>
      parseMp4EsdsPayload(esds({ children: [decoderConfig(), decoderConfig()] })),
    ).toThrowError(/duplicate DecoderConfigDescriptor/);
    expect(() =>
      parseMp4EsdsPayload(
        esds({
          children: [decoderConfig({ afterDsi: [descriptor(0x05, [0x12, 0x10])] })],
        }),
      ),
    ).toThrowError(/duplicate DecoderSpecificInfo/);
    expect(() =>
      parseMp4EsdsPayload(
        esds({
          children: [decoderConfig(), descriptor(0x06, [2]), descriptor(0x06, [2])],
        }),
      ),
    ).toThrowError(/duplicate SLConfigDescriptor/);
  });

  it('rejects bytes trailing outside the root or not forming a child descriptor', () => {
    expect(() => parseMp4EsdsPayload(concat(esds(), [0]))).toThrowError(
      /trailing bytes outside ES_Descriptor/,
    );
    const childWithRawTrailingByte = descriptor(0x03, concat([0, 1, 0], decoderConfig(), [0x7f]));
    expect(() => parseMp4EsdsPayload(concat([0, 0, 0, 0], childWithRawTrailingByte))).toThrowError(
      /descriptor header is truncated/,
    );
  });

  it('rejects DecoderSpecificInfo larger than the independent 64-byte bound', () => {
    const tooLarge = new Uint8Array(MP4_ESDS_MAX_DECODER_SPECIFIC_INFO_BYTES + 1);
    expect(() =>
      parseMp4EsdsPayload(esds({ children: [decoderConfig({ dsi: tooLarge })] })),
    ).toThrowError(/exceeds 64 bytes/);
  });

  it('enforces total payload and descriptor-count bounds', () => {
    const tooLarge = new Uint8Array(MP4_ESDS_MAX_PAYLOAD_BYTES + 1);
    expect(() => parseMp4EsdsPayload(tooLarge)).toThrowError(/bounded parser limit/);

    const unknownChildren = Array.from({ length: MP4_ESDS_MAX_DESCRIPTOR_COUNT }, () =>
      descriptor(0x20, []),
    );
    expect(() =>
      parseMp4EsdsPayload(esds({ children: [...unknownChildren, decoderConfig()] })),
    ).toThrowError(/descriptor count exceeds/);
  });

  it('rejects SharedArrayBuffer, detached storage, and non-Uint8Array views', () => {
    if (typeof SharedArrayBuffer === 'function') {
      expect(() => parseMp4EsdsPayload(new Uint8Array(new SharedArrayBuffer(32)))).toThrowError(
        /local.*non-shared/,
      );
    }

    const detached = esds();
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expect(() => parseMp4EsdsPayload(detached)).toThrowError(/truncated|could not be copied/);
    expect(() =>
      parseMp4EsdsPayload(new DataView(new ArrayBuffer(32)) as unknown as Uint8Array),
    ).toThrowError(/Uint8Array/);
  });

  it('exports stable positive parser limits', () => {
    expect(MP4_ESDS_MAX_PAYLOAD_BYTES).toBe(65_536);
    expect(MP4_ESDS_MAX_DESCRIPTOR_COUNT).toBe(256);
  });
});
