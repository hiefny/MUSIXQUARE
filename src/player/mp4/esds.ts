export const MP4_ESDS_MAX_PAYLOAD_BYTES = 65_536;
export const MP4_ESDS_MAX_DESCRIPTOR_COUNT = 256;
export const MP4_ESDS_MAX_DECODER_SPECIFIC_INFO_BYTES = 64;

const ES_DESCRIPTOR_TAG = 0x03;
const DECODER_CONFIG_DESCRIPTOR_TAG = 0x04;
const DECODER_SPECIFIC_INFO_TAG = 0x05;
const SL_CONFIG_DESCRIPTOR_TAG = 0x06;
const MPEG4_AUDIO_OBJECT_TYPE_INDICATION = 0x40;
const AUDIO_STREAM_TYPE = 0x05;
const MAX_DESCRIPTOR_PAYLOAD_BYTES = 0x0fff_ffff;
const FULL_BOX_HEADER_BYTES = 4;
const DECODER_CONFIG_FIXED_BYTES = 13;

const Uint8ArrayIntrinsic = Uint8Array;
const arrayBufferIsView = ArrayBuffer.isView;
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8ArrayIntrinsic.prototype) as object | null;
const typedArrayByteLengthGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
  : undefined;
const typedArrayBufferGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
  : undefined;
const typedArrayTagGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get
  : undefined;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;
const uint8ArraySet = Uint8ArrayIntrinsic.prototype.set;

export interface Mp4EsdsAudioConfiguration {
  readonly esId: number;
  readonly streamPriority: number;
  readonly dependsOnEsId: number | null;
  readonly urlLengthBytes: number | null;
  readonly ocrEsId: number | null;
  readonly objectTypeIndication: 0x40;
  readonly streamType: 0x05;
  readonly upstream: false;
  readonly bufferSizeDb: number;
  readonly maxBitrate: number;
  readonly averageBitrate: number;
  /** Intrinsically owned, immutable numeric snapshot of DecoderSpecificInfo. */
  readonly decoderSpecificInfo: readonly number[];
  readonly hasSlConfig: boolean;
}

interface DescriptorRef {
  readonly tag: number;
  readonly payloadStart: number;
  readonly payloadEnd: number;
  readonly end: number;
}

interface DescriptorBudget {
  remaining: number;
}

interface ParsedDecoderConfig {
  readonly objectTypeIndication: 0x40;
  readonly streamType: 0x05;
  readonly upstream: false;
  readonly bufferSizeDb: number;
  readonly maxBitrate: number;
  readonly averageBitrate: number;
  readonly decoderSpecificInfoBytes: Uint8Array;
}

const decoderSpecificInfoByResult = new WeakMap<Readonly<Mp4EsdsAudioConfiguration>, Uint8Array>();

export class Mp4EsdsError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'Mp4EsdsError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

function snapshotPayloadBytes(value: unknown): Uint8Array {
  if (
    !typedArrayByteLengthGetter ||
    !typedArrayBufferGetter ||
    !typedArrayTagGetter ||
    !arrayBufferByteLengthGetter ||
    !arrayBufferIsView(value)
  ) {
    throw new TypeError('MP4 esds payload must be a readable Uint8Array');
  }

  let byteLength: number;
  try {
    if (typedArrayTagGetter.call(value) !== 'Uint8Array') {
      throw new TypeError('not a Uint8Array');
    }
    byteLength = typedArrayByteLengthGetter.call(value);
    const buffer = typedArrayBufferGetter.call(value);
    // This intrinsic rejects SharedArrayBuffer. A detached view either reports
    // zero bytes or fails the exact copy below; neither can enter the parser.
    arrayBufferByteLengthGetter.call(buffer);
  } catch (error) {
    throw new TypeError('MP4 esds payload must be a readable, local, non-shared Uint8Array', {
      cause: error,
    });
  }

  if (byteLength < FULL_BOX_HEADER_BYTES + 2) {
    throw new Mp4EsdsError('MP4 esds payload is truncated');
  }
  if (byteLength > MP4_ESDS_MAX_PAYLOAD_BYTES) {
    throw new Mp4EsdsError('MP4 esds payload exceeds the bounded parser limit');
  }

  const owned = new Uint8ArrayIntrinsic(byteLength);
  try {
    uint8ArraySet.call(owned, value as Uint8Array, 0);
  } catch (error) {
    throw new TypeError('MP4 esds payload could not be copied exactly', { cause: error });
  }
  return owned;
}

function requireAvailable(cursor: number, byteCount: number, end: number, label: string): void {
  if (cursor < 0 || byteCount < 0 || cursor > end || byteCount > end - cursor) {
    throw new Mp4EsdsError(`${label} is truncated`);
  }
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x100 + bytes[offset + 1]!;
}

function readUint24(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x1_0000 + bytes[offset + 1]! * 0x100 + bytes[offset + 2]!;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x100_0000 +
    bytes[offset + 1]! * 0x1_0000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function readDescriptor(
  bytes: Uint8Array,
  start: number,
  parentEnd: number,
  budget: DescriptorBudget,
): Readonly<DescriptorRef> {
  if (budget.remaining <= 0) {
    throw new Mp4EsdsError('MP4 esds descriptor count exceeds the bounded parser limit');
  }
  budget.remaining -= 1;
  requireAvailable(start, 2, parentEnd, 'MP4 esds descriptor header');

  const tag = bytes[start]!;
  let cursor = start + 1;
  let payloadLength = 0;
  let terminated = false;
  for (let index = 0; index < 4; index += 1) {
    requireAvailable(cursor, 1, parentEnd, 'MP4 esds descriptor length');
    const value = bytes[cursor]!;
    cursor += 1;
    payloadLength = payloadLength * 0x80 + (value & 0x7f);
    if (payloadLength > MAX_DESCRIPTOR_PAYLOAD_BYTES) {
      throw new Mp4EsdsError('MP4 esds descriptor length overflows 28 bits');
    }
    if ((value & 0x80) === 0) {
      terminated = true;
      break;
    }
  }
  if (!terminated) {
    throw new Mp4EsdsError('MP4 esds descriptor length continues beyond four bytes');
  }
  if (payloadLength > parentEnd - cursor) {
    throw new Mp4EsdsError('MP4 esds descriptor payload escapes its parent boundary');
  }

  const payloadEnd = cursor + payloadLength;
  return Object.freeze({
    tag,
    payloadStart: cursor,
    payloadEnd,
    end: payloadEnd,
  });
}

function copyBoundedDecoderSpecificInfo(
  bytes: Uint8Array,
  descriptor: Readonly<DescriptorRef>,
): Uint8Array {
  const byteLength = descriptor.payloadEnd - descriptor.payloadStart;
  if (byteLength > MP4_ESDS_MAX_DECODER_SPECIFIC_INFO_BYTES) {
    throw new Mp4EsdsError('MP4 DecoderSpecificInfo exceeds 64 bytes');
  }
  const owned = new Uint8ArrayIntrinsic(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    owned[index] = bytes[descriptor.payloadStart + index]!;
  }
  return owned;
}

function parseDecoderConfig(
  bytes: Uint8Array,
  descriptor: Readonly<DescriptorRef>,
  budget: DescriptorBudget,
): Readonly<ParsedDecoderConfig> {
  requireAvailable(
    descriptor.payloadStart,
    DECODER_CONFIG_FIXED_BYTES,
    descriptor.payloadEnd,
    'MP4 DecoderConfigDescriptor fixed fields',
  );

  const objectTypeIndication = bytes[descriptor.payloadStart]!;
  if (objectTypeIndication !== MPEG4_AUDIO_OBJECT_TYPE_INDICATION) {
    throw new Mp4EsdsError('MP4 DecoderConfigDescriptor is not MPEG-4 Audio');
  }

  const streamTypeByte = bytes[descriptor.payloadStart + 1]!;
  const streamType = streamTypeByte >>> 2;
  const upstream = ((streamTypeByte >>> 1) & 1) === 1;
  const reserved = (streamTypeByte & 1) === 1;
  if (streamType !== AUDIO_STREAM_TYPE) {
    throw new Mp4EsdsError('MP4 DecoderConfigDescriptor is not an audio stream');
  }
  if (upstream) {
    throw new Mp4EsdsError('MP4 DecoderConfigDescriptor upstream flag must be zero');
  }
  if (!reserved) {
    throw new Mp4EsdsError('MP4 DecoderConfigDescriptor reserved bit must be one');
  }

  const bufferSizeDb = readUint24(bytes, descriptor.payloadStart + 2);
  const maxBitrate = readUint32(bytes, descriptor.payloadStart + 5);
  const averageBitrate = readUint32(bytes, descriptor.payloadStart + 9);
  let cursor = descriptor.payloadStart + DECODER_CONFIG_FIXED_BYTES;
  let decoderSpecificInfoBytes: Uint8Array | null = null;

  while (cursor < descriptor.payloadEnd) {
    const child = readDescriptor(bytes, cursor, descriptor.payloadEnd, budget);
    cursor = child.end;
    if (child.tag === DECODER_SPECIFIC_INFO_TAG) {
      if (decoderSpecificInfoBytes !== null) {
        throw new Mp4EsdsError('MP4 DecoderConfigDescriptor has duplicate DecoderSpecificInfo');
      }
      decoderSpecificInfoBytes = copyBoundedDecoderSpecificInfo(bytes, child);
      continue;
    }
    if (
      child.tag === ES_DESCRIPTOR_TAG ||
      child.tag === DECODER_CONFIG_DESCRIPTOR_TAG ||
      child.tag === SL_CONFIG_DESCRIPTOR_TAG
    ) {
      throw new Mp4EsdsError('MP4 esds core descriptor appears under the wrong parent');
    }
    // Other MPEG-4 Systems descriptors are bounded by the already-owned esds
    // payload and intentionally skipped without recursively allocating them.
  }

  if (cursor !== descriptor.payloadEnd) {
    throw new Mp4EsdsError('MP4 DecoderConfigDescriptor has trailing bytes');
  }
  if (decoderSpecificInfoBytes === null) {
    throw new Mp4EsdsError('MP4 DecoderConfigDescriptor is missing DecoderSpecificInfo');
  }

  return Object.freeze({
    objectTypeIndication: MPEG4_AUDIO_OBJECT_TYPE_INDICATION,
    streamType: AUDIO_STREAM_TYPE,
    upstream: false,
    bufferSizeDb,
    maxBitrate,
    averageBitrate,
    decoderSpecificInfoBytes,
  });
}

function numericTuple(bytes: Uint8Array): readonly number[] {
  const values: number[] = [];
  for (let index = 0; index < bytes.byteLength; index += 1) {
    values.push(bytes[index]!);
  }
  return Object.freeze(values);
}

/**
 * Parse the exact body of one ISO BMFF `esds` FullBox.
 *
 * The complete input is copied once into bounded local storage. Descriptor
 * payloads are then traversed only inside their declared parent spans; unknown
 * descriptors are skipped in place, and only DecoderSpecificInfo is retained.
 */
export function parseMp4EsdsPayload(input: Uint8Array): Readonly<Mp4EsdsAudioConfiguration> {
  const bytes = snapshotPayloadBytes(input);
  if (bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 0 || bytes[3] !== 0) {
    throw new Mp4EsdsError('MP4 esds FullBox version and flags must be zero');
  }

  const budget: DescriptorBudget = { remaining: MP4_ESDS_MAX_DESCRIPTOR_COUNT };
  const esDescriptor = readDescriptor(bytes, FULL_BOX_HEADER_BYTES, bytes.byteLength, budget);
  if (esDescriptor.tag !== ES_DESCRIPTOR_TAG) {
    throw new Mp4EsdsError('MP4 esds root must be an ES_Descriptor');
  }
  if (esDescriptor.end !== bytes.byteLength) {
    throw new Mp4EsdsError('MP4 esds payload has trailing bytes outside ES_Descriptor');
  }

  requireAvailable(
    esDescriptor.payloadStart,
    3,
    esDescriptor.payloadEnd,
    'MP4 ES_Descriptor fixed fields',
  );
  let cursor = esDescriptor.payloadStart;
  const esId = readUint16(bytes, cursor);
  cursor += 2;
  const flags = bytes[cursor]!;
  cursor += 1;
  const streamPriority = flags & 0x1f;

  let dependsOnEsId: number | null = null;
  if ((flags & 0x80) !== 0) {
    requireAvailable(cursor, 2, esDescriptor.payloadEnd, 'MP4 ES_Descriptor dependsOn_ES_ID');
    dependsOnEsId = readUint16(bytes, cursor);
    cursor += 2;
  }

  let urlLengthBytes: number | null = null;
  if ((flags & 0x40) !== 0) {
    requireAvailable(cursor, 1, esDescriptor.payloadEnd, 'MP4 ES_Descriptor URL length');
    urlLengthBytes = bytes[cursor]!;
    cursor += 1;
    requireAvailable(cursor, urlLengthBytes, esDescriptor.payloadEnd, 'MP4 ES_Descriptor URL');
    cursor += urlLengthBytes;
  }

  let ocrEsId: number | null = null;
  if ((flags & 0x20) !== 0) {
    requireAvailable(cursor, 2, esDescriptor.payloadEnd, 'MP4 ES_Descriptor OCR_ES_Id');
    ocrEsId = readUint16(bytes, cursor);
    cursor += 2;
  }

  let decoderConfig: Readonly<ParsedDecoderConfig> | null = null;
  let hasSlConfig = false;
  while (cursor < esDescriptor.payloadEnd) {
    const child = readDescriptor(bytes, cursor, esDescriptor.payloadEnd, budget);
    cursor = child.end;
    if (child.tag === DECODER_CONFIG_DESCRIPTOR_TAG) {
      if (decoderConfig !== null) {
        throw new Mp4EsdsError('MP4 ES_Descriptor has duplicate DecoderConfigDescriptor');
      }
      if (hasSlConfig) {
        throw new Mp4EsdsError('MP4 DecoderConfigDescriptor appears after SLConfigDescriptor');
      }
      decoderConfig = parseDecoderConfig(bytes, child, budget);
      continue;
    }
    if (child.tag === SL_CONFIG_DESCRIPTOR_TAG) {
      if (decoderConfig === null) {
        throw new Mp4EsdsError('MP4 SLConfigDescriptor appears before DecoderConfigDescriptor');
      }
      if (hasSlConfig) {
        throw new Mp4EsdsError('MP4 ES_Descriptor has duplicate SLConfigDescriptor');
      }
      hasSlConfig = true;
      continue;
    }
    if (child.tag === ES_DESCRIPTOR_TAG || child.tag === DECODER_SPECIFIC_INFO_TAG) {
      throw new Mp4EsdsError('MP4 esds core descriptor appears under the wrong parent');
    }
    // Unknown ES children are skipped within the exact ES_Descriptor boundary.
  }

  if (cursor !== esDescriptor.payloadEnd) {
    throw new Mp4EsdsError('MP4 ES_Descriptor has trailing bytes');
  }
  if (decoderConfig === null) {
    throw new Mp4EsdsError('MP4 ES_Descriptor is missing DecoderConfigDescriptor');
  }

  const decoderSpecificInfo = numericTuple(decoderConfig.decoderSpecificInfoBytes);
  const result: Readonly<Mp4EsdsAudioConfiguration> = Object.freeze({
    esId,
    streamPriority,
    dependsOnEsId,
    urlLengthBytes,
    ocrEsId,
    objectTypeIndication: decoderConfig.objectTypeIndication,
    streamType: decoderConfig.streamType,
    upstream: decoderConfig.upstream,
    bufferSizeDb: decoderConfig.bufferSizeDb,
    maxBitrate: decoderConfig.maxBitrate,
    averageBitrate: decoderConfig.averageBitrate,
    decoderSpecificInfo,
    hasSlConfig,
  });
  decoderSpecificInfoByResult.set(result, decoderConfig.decoderSpecificInfoBytes);
  return result;
}

/** Return a fresh owned byte copy for WebCodecs `AudioDecoderConfig.description`. */
export function copyMp4EsdsDecoderSpecificInfo(
  configuration: Readonly<Mp4EsdsAudioConfiguration>,
): Uint8Array {
  const retained = decoderSpecificInfoByResult.get(configuration);
  if (!retained) {
    throw new TypeError('MP4 esds configuration must be returned by parseMp4EsdsPayload');
  }
  const copy = new Uint8ArrayIntrinsic(retained.byteLength);
  uint8ArraySet.call(copy, retained, 0);
  return copy;
}
