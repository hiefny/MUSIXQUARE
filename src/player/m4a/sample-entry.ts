import {
  parseCanonicalAacLcAudioSpecificConfig,
  type CanonicalAacLcAudioSpecificConfig,
} from '../aac/audio-specific-config.ts';
import { type IsoBmffBoxRef } from '../mp4/box.ts';
import { IsoBmffBoxReader } from '../mp4/box-reader.ts';
import {
  copyMp4EsdsDecoderSpecificInfo,
  MP4_ESDS_MAX_PAYLOAD_BYTES,
  parseMp4EsdsPayload,
  type Mp4EsdsAudioConfiguration,
} from '../mp4/esds.ts';

const STSD_FULL_BOX_FIELDS_BYTES = 8;
const AUDIO_SAMPLE_ENTRY_V0_FIELDS_BYTES = 28;
const BIT_RATE_BOX_PAYLOAD_BYTES = 12;
const MAX_AUDIO_SAMPLE_RATE_HZ = 96_000;

export interface M4aAacLcSampleDescription {
  readonly codec: 'mp4a.40.2';
  readonly sampleRateHz: number;
  readonly channelCount: 1 | 2;
  readonly sampleSizeBits: 16;
  readonly dataReferenceIndex: 1;
  readonly audioSpecificConfig: Readonly<CanonicalAacLcAudioSpecificConfig>;
  readonly esId: number;
  readonly bufferSizeDb: number;
  readonly maxBitrate: number;
  readonly averageBitrate: number;
}

export class M4aSampleDescriptionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'M4aSampleDescriptionError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x100 + bytes[offset + 1]!;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x100_0000 +
    bytes[offset + 1]! * 0x1_0000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function requireAllZero(bytes: Uint8Array, start: number, end: number, label: string): void {
  for (let offset = start; offset < end; offset += 1) {
    if (bytes[offset] !== 0) {
      throw new M4aSampleDescriptionError(`${label} must be zero`);
    }
  }
}

function parseAudioSampleEntryV0(bytes: Uint8Array): Readonly<{
  dataReferenceIndex: 1;
  channelCount: 1 | 2;
  sampleSizeBits: 16;
  sampleRateHz: number;
}> {
  requireAllZero(bytes, 0, 6, 'M4A AudioSampleEntry reserved prefix');

  const dataReferenceIndex = readUint16(bytes, 6);
  if (dataReferenceIndex !== 1) {
    throw new M4aSampleDescriptionError(
      'M4A AudioSampleEntry data_reference_index must select the self-contained entry 1',
    );
  }
  requireAllZero(bytes, 8, 16, 'M4A AudioSampleEntry version, revision, and vendor fields');

  const channelCount = readUint16(bytes, 16);
  if (channelCount !== 1 && channelCount !== 2) {
    throw new M4aSampleDescriptionError(
      'M4A AudioSampleEntry channel count must be exact mono or stereo',
    );
  }

  const sampleSizeBits = readUint16(bytes, 18);
  if (sampleSizeBits !== 16) {
    throw new M4aSampleDescriptionError('M4A AudioSampleEntry sample size must be 16 bits');
  }
  requireAllZero(bytes, 20, 24, 'M4A AudioSampleEntry predefined and reserved fields');

  const fixedSampleRate = readUint32(bytes, 24);
  if ((fixedSampleRate & 0xffff) !== 0) {
    throw new M4aSampleDescriptionError(
      'M4A AudioSampleEntry sample rate must be an integer 16.16 value',
    );
  }
  const sampleRateHz = Math.floor(fixedSampleRate / 0x1_0000);
  if (sampleRateHz < 1 || sampleRateHz > MAX_AUDIO_SAMPLE_RATE_HZ) {
    throw new M4aSampleDescriptionError(
      `M4A AudioSampleEntry sample rate must be from 1 through ${MAX_AUDIO_SAMPLE_RATE_HZ} Hz`,
    );
  }

  return Object.freeze({
    dataReferenceIndex: 1,
    channelCount,
    sampleSizeBits: 16,
    sampleRateHz,
  });
}

function parseEsdsAudioSpecificConfig(payload: Uint8Array): Readonly<{
  esds: Readonly<Mp4EsdsAudioConfiguration>;
  audioSpecificConfig: Readonly<CanonicalAacLcAudioSpecificConfig>;
}> {
  let esds: Readonly<Mp4EsdsAudioConfiguration>;
  try {
    esds = parseMp4EsdsPayload(payload);
  } finally {
    payload.fill(0);
  }

  const description = copyMp4EsdsDecoderSpecificInfo(esds);
  try {
    return Object.freeze({
      esds,
      audioSpecificConfig: parseCanonicalAacLcAudioSpecificConfig(description),
    });
  } finally {
    description.fill(0);
  }
}

/**
 * Read the one self-contained, version-zero `mp4a` description admitted by
 * the initial bounded M4A engine. The encoded source remains caller-owned.
 */
export async function readM4aAacLcSampleDescription(
  reader: IsoBmffBoxReader,
  stsdBox: Readonly<IsoBmffBoxRef>,
  signal: AbortSignal,
): Promise<Readonly<M4aAacLcSampleDescription>> {
  if (!(reader instanceof IsoBmffBoxReader)) {
    throw new TypeError('M4A sample description requires an IsoBmffBoxReader');
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('M4A sample description requires an AbortSignal');
  }
  reader.assertReadable(signal);

  // Creating this cursor validates provenance before any caller-supplied box
  // fields are observed here.
  const stsdPayload = reader.createChildCursor(stsdBox);
  if (stsdBox.type !== 'stsd') {
    throw new M4aSampleDescriptionError('M4A sample description parent must be an stsd box');
  }
  if (stsdPayload.remainingBytes < STSD_FULL_BOX_FIELDS_BYTES) {
    throw new M4aSampleDescriptionError('M4A stsd FullBox fields are truncated');
  }

  const stsdFields = await reader.readBytes(stsdPayload.start, STSD_FULL_BOX_FIELDS_BYTES, signal);
  if (stsdFields[0] !== 0 || stsdFields[1] !== 0 || stsdFields[2] !== 0 || stsdFields[3] !== 0) {
    throw new M4aSampleDescriptionError('M4A stsd FullBox version and flags must be zero');
  }
  if (readUint32(stsdFields, 4) !== 1) {
    throw new M4aSampleDescriptionError('M4A stsd must declare exactly one sample entry');
  }

  const entries = reader.createChildCursor(stsdBox, {
    start: stsdPayload.start + STSD_FULL_BOX_FIELDS_BYTES,
    end: stsdPayload.end,
  });
  const entry = await entries.next(signal);
  if (entry === null) {
    throw new M4aSampleDescriptionError('M4A stsd is missing its declared sample entry');
  }
  if ((await entries.next(signal)) !== null) {
    throw new M4aSampleDescriptionError('M4A stsd contains more than one sample entry');
  }
  if (entry.type !== 'mp4a') {
    if (entry.type === 'enca') {
      throw new M4aSampleDescriptionError('Encrypted M4A sample entries are not supported');
    }
    throw new M4aSampleDescriptionError(
      `M4A sample entry must be mp4a, not ${JSON.stringify(entry.type)}`,
    );
  }
  if (entry.end - entry.dataStart < AUDIO_SAMPLE_ENTRY_V0_FIELDS_BYTES) {
    throw new M4aSampleDescriptionError('M4A AudioSampleEntry version-zero fields are truncated');
  }

  const entryFields = await reader.readBytes(
    entry.dataStart,
    AUDIO_SAMPLE_ENTRY_V0_FIELDS_BYTES,
    signal,
  );
  const geometry = parseAudioSampleEntryV0(entryFields);
  const children = reader.createChildCursor(entry, {
    start: entry.dataStart + AUDIO_SAMPLE_ENTRY_V0_FIELDS_BYTES,
    end: entry.end,
  });

  let parsedEsds: Readonly<{
    esds: Readonly<Mp4EsdsAudioConfiguration>;
    audioSpecificConfig: Readonly<CanonicalAacLcAudioSpecificConfig>;
  }> | null = null;
  let hasBitRateBox = false;

  for (;;) {
    const child = await children.next(signal);
    if (child === null) break;

    if (child.type === 'esds') {
      if (parsedEsds !== null) {
        throw new M4aSampleDescriptionError('M4A mp4a entry contains duplicate esds boxes');
      }
      const payloadBytes = child.end - child.dataStart;
      if (payloadBytes > MP4_ESDS_MAX_PAYLOAD_BYTES) {
        throw new M4aSampleDescriptionError('M4A esds payload exceeds the 64 KiB bounded limit');
      }
      parsedEsds = parseEsdsAudioSpecificConfig(
        await reader.readBytes(child.dataStart, payloadBytes, signal),
      );
      continue;
    }

    if (child.type === 'btrt') {
      if (hasBitRateBox) {
        throw new M4aSampleDescriptionError('M4A mp4a entry contains duplicate btrt boxes');
      }
      hasBitRateBox = true;
      const payloadBytes = child.end - child.dataStart;
      if (payloadBytes !== BIT_RATE_BOX_PAYLOAD_BYTES) {
        throw new M4aSampleDescriptionError(
          `M4A btrt payload must contain exactly ${BIT_RATE_BOX_PAYLOAD_BYTES} bytes`,
        );
      }
      // All btrt fields are unsigned scalars. An exact bounded read completes
      // their structural validation without retaining nonsemantic metadata.
      await reader.readBytes(child.dataStart, payloadBytes, signal);
      continue;
    }

    throw new M4aSampleDescriptionError(
      `Unsupported ${JSON.stringify(child.type)} child in M4A mp4a sample entry`,
    );
  }

  if (parsedEsds === null) {
    throw new M4aSampleDescriptionError('M4A mp4a entry is missing its esds box');
  }
  if (parsedEsds.audioSpecificConfig.sampleRateHz !== geometry.sampleRateHz) {
    throw new M4aSampleDescriptionError(
      'M4A AudioSpecificConfig sample rate does not match its AudioSampleEntry',
    );
  }
  if (parsedEsds.audioSpecificConfig.channelCount !== geometry.channelCount) {
    throw new M4aSampleDescriptionError(
      'M4A AudioSpecificConfig channel count does not match its AudioSampleEntry',
    );
  }

  reader.assertReadable(signal);
  return Object.freeze({
    codec: 'mp4a.40.2',
    sampleRateHz: geometry.sampleRateHz,
    channelCount: geometry.channelCount,
    sampleSizeBits: geometry.sampleSizeBits,
    dataReferenceIndex: geometry.dataReferenceIndex,
    audioSpecificConfig: parsedEsds.audioSpecificConfig,
    esId: parsedEsds.esds.esId,
    bufferSizeDb: parsedEsds.esds.bufferSizeDb,
    maxBitrate: parsedEsds.esds.maxBitrate,
    averageBitrate: parsedEsds.esds.averageBitrate,
  });
}
