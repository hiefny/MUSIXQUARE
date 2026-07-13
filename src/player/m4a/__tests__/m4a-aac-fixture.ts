import {
  type EncodedRandomAccessSource,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';

const AAC_ACCESS_UNIT_SIZES = Object.freeze([11, 13, 17, 19, 23, 29] as const);
const AAC_AUDIO_SPECIFIC_CONFIG = Object.freeze([0x11, 0x90, 0x56, 0xe5, 0x00] as const);
const IDENTITY_MATRIX = Object.freeze([
  0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000,
] as const);

export const M4A_AAC_FIXTURE_ACCESS_UNIT_SIZES = AAC_ACCESS_UNIT_SIZES;
export const M4A_AAC_FIXTURE_AUDIO_SPECIFIC_CONFIG = AAC_AUDIO_SPECIFIC_CONFIG;
export const M4A_AAC_FIXTURE_SAMPLE_RATE_HZ = 48_000;
export const M4A_AAC_FIXTURE_CHANNEL_COUNT = 2;
export const M4A_AAC_FIXTURE_ACCESS_UNIT_COUNT = 6;
export const M4A_AAC_FIXTURE_RAW_CORE_FRAMES = 6_144;
export const M4A_AAC_FIXTURE_PRESENTATION_CORE_FRAMES = 5_632;
export const M4A_AAC_FIXTURE_PRIMING_CORE_FRAMES = 1_024;
export const M4A_AAC_FIXTURE_REMAINDER_CORE_FRAMES = 512;
export const M4A_AAC_FIXTURE_AUDIBLE_CORE_FRAMES = 4_608;
export const M4A_AAC_FIXTURE_MOVIE_TIMESCALE = 1_000;
export const M4A_AAC_FIXTURE_MOVIE_DURATION_TICKS = 96;
export const M4A_AAC_FIXTURE_ITUN_SMPB =
  ' 00000000 00000400 00000200 0000000000001200 00000000 00000000 ';

export interface M4aAacFixtureReadRecord {
  readonly offset: number;
  readonly length: number;
}

export type ReadRecord = M4aAacFixtureReadRecord;

/** Small mutable-in-bytes, observable source for manifest and cursor tests. */
export class M4aAacFixtureMemorySource implements EncodedRandomAccessSource {
  readonly reads: M4aAacFixtureReadRecord[] = [];
  closeCalls = 0;

  constructor(
    readonly bytes: Uint8Array,
    readonly identity = 'm4a-aac-canonical-fixture',
  ) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push(Object.freeze({ offset, length }));
    return this.bytes.slice(offset, end);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

export { M4aAacFixtureMemorySource as MemorySource };

export interface M4aAacFixtureOptions {
  /** Defaults to the 32-bit table used by ordinary FFmpeg M4A files. */
  readonly chunkOffsetBoxType?: 'stco' | 'co64';
  /** Defaults to true. */
  readonly includeITunSmpb?: boolean;
  /** Defaults to true and emits FFmpeg's exact one-AU `roll` pair. */
  readonly includeRollRecovery?: boolean;
  readonly sourceIdentity?: string;
}

export interface M4aAacFixtureAccessUnit {
  readonly ordinal: number;
  readonly offset: number;
  readonly length: number;
  /** Independent expected bytes; mutating the built file does not change them. */
  readonly payload: Uint8Array;
}

export interface M4aAacFixtureExpected {
  readonly chunkOffsetBoxType: 'stco' | 'co64';
  readonly audioSpecificConfig: typeof AAC_AUDIO_SPECIFIC_CONFIG;
  readonly sampleRateHz: typeof M4A_AAC_FIXTURE_SAMPLE_RATE_HZ;
  readonly channelCount: typeof M4A_AAC_FIXTURE_CHANNEL_COUNT;
  readonly accessUnitSizes: typeof AAC_ACCESS_UNIT_SIZES;
  readonly accessUnitOffsets: readonly number[];
  readonly accessUnitPayloads: readonly Uint8Array[];
  readonly accessUnits: readonly Readonly<M4aAacFixtureAccessUnit>[];
  readonly chunkOffsets: readonly number[];
  readonly chunkByteLengths: readonly number[];
  readonly mdatPayloadRange: Readonly<{ start: number; end: number }>;
  readonly moovRange: Readonly<{ start: number; end: number }>;
  readonly rawCoreFrames: typeof M4A_AAC_FIXTURE_RAW_CORE_FRAMES;
  readonly presentationEndCoreFrames: typeof M4A_AAC_FIXTURE_PRESENTATION_CORE_FRAMES;
  readonly primingCoreFrames: typeof M4A_AAC_FIXTURE_PRIMING_CORE_FRAMES;
  readonly remainderCoreFrames: typeof M4A_AAC_FIXTURE_REMAINDER_CORE_FRAMES;
  readonly audibleCoreFrames: typeof M4A_AAC_FIXTURE_AUDIBLE_CORE_FRAMES;
  readonly movieTimescale: typeof M4A_AAC_FIXTURE_MOVIE_TIMESCALE;
  readonly trackDurationMovieTicks: typeof M4A_AAC_FIXTURE_MOVIE_DURATION_TICKS;
  readonly editDurationMovieTicks: typeof M4A_AAC_FIXTURE_MOVIE_DURATION_TICKS;
  readonly iTunSmpbText: typeof M4A_AAC_FIXTURE_ITUN_SMPB | null;
  readonly requiredPrerollAccessUnits: 1 | null;
}

export interface M4aAacFixture {
  readonly bytes: Uint8Array;
  readonly source: M4aAacFixtureMemorySource;
  readonly expected: Readonly<M4aAacFixtureExpected>;
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const byteLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function writeFourCc(bytes: Uint8Array, offset: number, value: string): void {
  if (value.length !== 4) throw new Error('fixture four-character code must contain four bytes');
  for (let index = 0; index < 4; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function box(type: string, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  const result = new Uint8Array(8 + body.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, result.byteLength, false);
  writeFourCc(result, 4, type);
  result.set(body, 8);
  return result;
}

function uint32(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, false);
  return result;
}

function descriptor(tag: number, payload: Uint8Array): Uint8Array {
  if (payload.byteLength > 0x7f)
    throw new Error('fixture descriptor unexpectedly exceeds 127 bytes');
  return concatenate(Uint8Array.of(tag, payload.byteLength), payload);
}

function fileTypeBox(): Uint8Array {
  const body = new Uint8Array(20);
  const view = new DataView(body.buffer);
  writeFourCc(body, 0, 'M4A ');
  view.setUint32(4, 0x0000_0200, false);
  ['M4A ', 'isom', 'iso2'].forEach((brand, index) => writeFourCc(body, 8 + index * 4, brand));
  return box('ftyp', body);
}

function movieHeader(): Uint8Array {
  const body = new Uint8Array(100);
  const view = new DataView(body.buffer);
  view.setUint32(12, M4A_AAC_FIXTURE_MOVIE_TIMESCALE, false);
  view.setUint32(16, M4A_AAC_FIXTURE_MOVIE_DURATION_TICKS, false);
  view.setUint32(20, 0x0001_0000, false);
  view.setUint16(24, 0x0100, false);
  IDENTITY_MATRIX.forEach((value, index) => view.setUint32(36 + index * 4, value, false));
  view.setUint32(96, 2, false);
  return box('mvhd', body);
}

function trackHeader(): Uint8Array {
  const body = new Uint8Array(84);
  const view = new DataView(body.buffer);
  body[3] = 3;
  view.setUint32(12, 1, false);
  view.setUint32(20, M4A_AAC_FIXTURE_MOVIE_DURATION_TICKS, false);
  view.setInt16(34, 1, false);
  view.setInt16(36, 0x0100, false);
  IDENTITY_MATRIX.forEach((value, index) => view.setUint32(40 + index * 4, value, false));
  return box('tkhd', body);
}

function editBox(): Uint8Array {
  const body = new Uint8Array(20);
  const view = new DataView(body.buffer);
  view.setUint32(4, 1, false);
  view.setUint32(8, M4A_AAC_FIXTURE_MOVIE_DURATION_TICKS, false);
  view.setInt32(12, M4A_AAC_FIXTURE_PRIMING_CORE_FRAMES, false);
  view.setInt16(16, 1, false);
  return box('edts', box('elst', body));
}

function mediaHeader(): Uint8Array {
  const body = new Uint8Array(24);
  const view = new DataView(body.buffer);
  view.setUint32(12, M4A_AAC_FIXTURE_SAMPLE_RATE_HZ, false);
  view.setUint32(16, M4A_AAC_FIXTURE_PRESENTATION_CORE_FRAMES, false);
  view.setUint16(20, 0x55c4, false);
  return box('mdhd', body);
}

function handlerBox(handlerType: string, manufacturer = '\0\0\0\0'): Uint8Array {
  const body = new Uint8Array(24);
  writeFourCc(body, 8, handlerType);
  writeFourCc(body, 12, manufacturer);
  return box('hdlr', body);
}

function dataInformationBox(): Uint8Array {
  const drefHeader = new Uint8Array(8);
  new DataView(drefHeader.buffer).setUint32(4, 1, false);
  return box('dinf', box('dref', concatenate(drefHeader, box('url ', Uint8Array.of(0, 0, 0, 1)))));
}

function esdsBox(): Uint8Array {
  const decoderConfig = descriptor(
    0x04,
    concatenate(
      Uint8Array.of(0x40, 0x15, 0x00, 0x06, 0x00),
      uint32(128_000),
      uint32(128_000),
      descriptor(0x05, Uint8Array.from(AAC_AUDIO_SPECIFIC_CONFIG)),
    ),
  );
  const esDescriptor = descriptor(
    0x03,
    concatenate(Uint8Array.of(0, 1, 0), decoderConfig, descriptor(0x06, Uint8Array.of(2))),
  );
  return box('esds', concatenate(new Uint8Array(4), esDescriptor));
}

function sampleDescriptionBox(): Uint8Array {
  const fields = new Uint8Array(28);
  const view = new DataView(fields.buffer);
  view.setUint16(6, 1, false);
  view.setUint16(16, M4A_AAC_FIXTURE_CHANNEL_COUNT, false);
  view.setUint16(18, 16, false);
  view.setUint32(24, M4A_AAC_FIXTURE_SAMPLE_RATE_HZ * 0x1_0000, false);
  const entry = box('mp4a', concatenate(fields, esdsBox()));
  return box('stsd', concatenate(new Uint8Array(4), uint32(1), entry));
}

function timeToSampleBox(): Uint8Array {
  const body = new Uint8Array(24);
  const view = new DataView(body.buffer);
  view.setUint32(4, 2, false);
  view.setUint32(8, 5, false);
  view.setUint32(12, 1_024, false);
  view.setUint32(16, 1, false);
  view.setUint32(20, 512, false);
  return box('stts', body);
}

function sampleToChunkBox(): Uint8Array {
  const body = new Uint8Array(20);
  const view = new DataView(body.buffer);
  view.setUint32(4, 1, false);
  view.setUint32(8, 1, false);
  view.setUint32(12, 2, false);
  view.setUint32(16, 1, false);
  return box('stsc', body);
}

function sampleSizeBox(): Uint8Array {
  const body = new Uint8Array(12 + AAC_ACCESS_UNIT_SIZES.length * 4);
  const view = new DataView(body.buffer);
  view.setUint32(8, AAC_ACCESS_UNIT_SIZES.length, false);
  AAC_ACCESS_UNIT_SIZES.forEach((size, index) => view.setUint32(12 + index * 4, size, false));
  return box('stsz', body);
}

function chunkOffsetBox(type: 'stco' | 'co64', offsets: readonly number[]): Uint8Array {
  const width = type === 'stco' ? 4 : 8;
  const body = new Uint8Array(8 + offsets.length * width);
  const view = new DataView(body.buffer);
  view.setUint32(4, offsets.length, false);
  offsets.forEach((offset, index) => {
    if (width === 4) view.setUint32(8 + index * width, offset, false);
    else view.setBigUint64(8 + index * width, BigInt(offset), false);
  });
  return box(type, body);
}

function rollRecoveryBoxes(): readonly [Uint8Array, Uint8Array] {
  const sgpd = new Uint8Array(18);
  const sgpdView = new DataView(sgpd.buffer);
  sgpd[0] = 1;
  writeFourCc(sgpd, 4, 'roll');
  sgpdView.setUint32(8, 2, false);
  sgpdView.setUint32(12, 1, false);
  sgpdView.setInt16(16, -1, false);

  const sbgp = new Uint8Array(20);
  const sbgpView = new DataView(sbgp.buffer);
  writeFourCc(sbgp, 4, 'roll');
  sbgpView.setUint32(8, 1, false);
  sbgpView.setUint32(12, M4A_AAC_FIXTURE_ACCESS_UNIT_COUNT, false);
  sbgpView.setUint32(16, 1, false);
  return [box('sgpd', sgpd), box('sbgp', sbgp)];
}

function metadataBox(): Uint8Array {
  const encoder = new TextEncoder();
  const fullBoxString = (value: string): Uint8Array =>
    concatenate(new Uint8Array(4), encoder.encode(value));
  const dataBody = concatenate(
    Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 0),
    encoder.encode(M4A_AAC_FIXTURE_ITUN_SMPB),
  );
  const item = box(
    '----',
    concatenate(
      box('mean', fullBoxString('com.apple.iTunes')),
      box('name', fullBoxString('iTunSMPB')),
      box('data', dataBody),
    ),
  );
  const meta = box(
    'meta',
    concatenate(new Uint8Array(4), handlerBox('mdir', 'appl'), box('ilst', item)),
  );
  return box('udta', meta);
}

function createAccessUnitPayloads(): readonly Uint8Array[] {
  return Object.freeze(
    AAC_ACCESS_UNIT_SIZES.map((size, ordinal) =>
      Uint8Array.from(
        { length: size },
        (_unused, byteOrdinal) => (0x31 + ordinal * 0x29 + byteOrdinal * 0x11) & 0xff,
      ),
    ),
  );
}

/** Build one complete tail-moov M4A whose tables and payload geometry agree exactly. */
export function buildM4aAacFixture(options: M4aAacFixtureOptions = {}): M4aAacFixture {
  const chunkOffsetBoxType = options.chunkOffsetBoxType ?? 'stco';
  const includeITunSmpb = options.includeITunSmpb ?? true;
  const includeRollRecovery = options.includeRollRecovery ?? true;
  const payloads = createAccessUnitPayloads();
  const ftyp = fileTypeBox();
  const mdatPayload = concatenate(...payloads);
  const mdatPayloadStart = ftyp.byteLength + 8;

  const accessUnitOffsets: number[] = [];
  let nextAccessUnitOffset = mdatPayloadStart;
  for (const payload of payloads) {
    accessUnitOffsets.push(nextAccessUnitOffset);
    nextAccessUnitOffset += payload.byteLength;
  }
  const chunkOffsets = Object.freeze([
    accessUnitOffsets[0]!,
    accessUnitOffsets[2]!,
    accessUnitOffsets[4]!,
  ]);
  const chunkByteLengths = Object.freeze([
    AAC_ACCESS_UNIT_SIZES[0] + AAC_ACCESS_UNIT_SIZES[1],
    AAC_ACCESS_UNIT_SIZES[2] + AAC_ACCESS_UNIT_SIZES[3],
    AAC_ACCESS_UNIT_SIZES[4] + AAC_ACCESS_UNIT_SIZES[5],
  ]);

  const sampleTable = box(
    'stbl',
    concatenate(
      sampleDescriptionBox(),
      timeToSampleBox(),
      sampleToChunkBox(),
      sampleSizeBox(),
      chunkOffsetBox(chunkOffsetBoxType, chunkOffsets),
      ...(includeRollRecovery ? rollRecoveryBoxes() : []),
    ),
  );
  const mediaInformation = box(
    'minf',
    concatenate(box('smhd', new Uint8Array(8)), dataInformationBox(), sampleTable),
  );
  const media = box('mdia', concatenate(mediaHeader(), handlerBox('soun'), mediaInformation));
  const track = box('trak', concatenate(trackHeader(), editBox(), media));
  const moov = box(
    'moov',
    concatenate(movieHeader(), track, ...(includeITunSmpb ? [metadataBox()] : [])),
  );
  const mdat = box('mdat', mdatPayload);
  const bytes = concatenate(ftyp, mdat, moov);
  const moovStart = ftyp.byteLength + mdat.byteLength;

  const accessUnits = Object.freeze(
    payloads.map((payload, ordinal) =>
      Object.freeze({
        ordinal,
        offset: accessUnitOffsets[ordinal]!,
        length: payload.byteLength,
        payload,
      }),
    ),
  );
  const expected: Readonly<M4aAacFixtureExpected> = Object.freeze({
    chunkOffsetBoxType,
    audioSpecificConfig: AAC_AUDIO_SPECIFIC_CONFIG,
    sampleRateHz: M4A_AAC_FIXTURE_SAMPLE_RATE_HZ,
    channelCount: M4A_AAC_FIXTURE_CHANNEL_COUNT,
    accessUnitSizes: AAC_ACCESS_UNIT_SIZES,
    accessUnitOffsets: Object.freeze(accessUnitOffsets),
    accessUnitPayloads: payloads,
    accessUnits,
    chunkOffsets,
    chunkByteLengths,
    mdatPayloadRange: Object.freeze({
      start: mdatPayloadStart,
      end: mdatPayloadStart + mdatPayload.byteLength,
    }),
    moovRange: Object.freeze({ start: moovStart, end: bytes.byteLength }),
    rawCoreFrames: M4A_AAC_FIXTURE_RAW_CORE_FRAMES,
    presentationEndCoreFrames: M4A_AAC_FIXTURE_PRESENTATION_CORE_FRAMES,
    primingCoreFrames: M4A_AAC_FIXTURE_PRIMING_CORE_FRAMES,
    remainderCoreFrames: M4A_AAC_FIXTURE_REMAINDER_CORE_FRAMES,
    audibleCoreFrames: M4A_AAC_FIXTURE_AUDIBLE_CORE_FRAMES,
    movieTimescale: M4A_AAC_FIXTURE_MOVIE_TIMESCALE,
    trackDurationMovieTicks: M4A_AAC_FIXTURE_MOVIE_DURATION_TICKS,
    editDurationMovieTicks: M4A_AAC_FIXTURE_MOVIE_DURATION_TICKS,
    iTunSmpbText: includeITunSmpb ? M4A_AAC_FIXTURE_ITUN_SMPB : null,
    requiredPrerollAccessUnits: includeRollRecovery ? 1 : null,
  });
  const source = new M4aAacFixtureMemorySource(
    bytes,
    options.sourceIdentity ??
      `m4a-aac-canonical-${chunkOffsetBoxType}-${includeITunSmpb ? 'itun' : 'plain'}-${includeRollRecovery ? 'roll' : 'no-roll'}`,
  );
  return Object.freeze({ bytes, source, expected });
}
