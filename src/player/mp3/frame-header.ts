export type MpegLayer3Version = '1' | '2' | '2.5';

export type MpegLayer3ChannelMode = 'stereo' | 'joint-stereo' | 'dual-channel' | 'mono';

export type MpegLayer3BitrateIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export type MpegLayer3SampleRateIndex = 0 | 1 | 2;

export interface MpegLayer3FrameHeader {
  readonly version: MpegLayer3Version;
  readonly layer: 3;
  readonly bitrateIndex: MpegLayer3BitrateIndex;
  readonly bitrateKbps: number;
  readonly sampleRateIndex: MpegLayer3SampleRateIndex;
  readonly sampleRateHz: number;
  readonly channelMode: MpegLayer3ChannelMode;
  readonly channelCount: 1 | 2;
  readonly samplesPerFrame: 576 | 1_152;
  readonly hasCrc: boolean;
  /** Layer III padding contributes exactly one byte to this frame. */
  readonly padding: boolean;
  readonly frameLengthBytes: number;
  readonly sideInfoBytes: 9 | 17 | 32;
  /**
   * Maximum bytes after side-info that can carry main-data.
   *
   * Ancillary data, when present, shares this region, so this is deliberately
   * a capacity rather than a claim about the actual main-data length.
   */
  readonly mainDataCapacityBytes: number;
}

export class MpegLayer3FrameHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MpegLayer3FrameHeaderError';
  }
}

const MPEG_1_LAYER_3_BITRATES_KBPS = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
] as const;

const MPEG_2_LAYER_3_BITRATES_KBPS = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
] as const;

const MPEG_1_SAMPLE_RATES_HZ = [44_100, 48_000, 32_000] as const;
const MPEG_2_SAMPLE_RATES_HZ = [22_050, 24_000, 16_000] as const;
const MPEG_2_5_SAMPLE_RATES_HZ = [11_025, 12_000, 8_000] as const;

const CHANNEL_MODES = ['stereo', 'joint-stereo', 'dual-channel', 'mono'] as const;
const MAX_LAYER_3_FRAME_LENGTH_BYTES = 1_441;

interface VersionGeometry {
  readonly version: MpegLayer3Version;
  readonly samplesPerFrame: 576 | 1_152;
  readonly frameLengthCoefficient: 72_000 | 144_000;
  readonly bitratesKbps: readonly number[];
  readonly sampleRatesHz: readonly number[];
}

const MPEG_1_GEOMETRY: VersionGeometry = Object.freeze({
  version: '1',
  samplesPerFrame: 1_152,
  frameLengthCoefficient: 144_000,
  bitratesKbps: MPEG_1_LAYER_3_BITRATES_KBPS,
  sampleRatesHz: MPEG_1_SAMPLE_RATES_HZ,
});

const MPEG_2_GEOMETRY: VersionGeometry = Object.freeze({
  version: '2',
  samplesPerFrame: 576,
  frameLengthCoefficient: 72_000,
  bitratesKbps: MPEG_2_LAYER_3_BITRATES_KBPS,
  sampleRatesHz: MPEG_2_SAMPLE_RATES_HZ,
});

const MPEG_2_5_GEOMETRY: VersionGeometry = Object.freeze({
  version: '2.5',
  samplesPerFrame: 576,
  frameLengthCoefficient: 72_000,
  bitratesKbps: MPEG_2_LAYER_3_BITRATES_KBPS,
  sampleRatesHz: MPEG_2_5_SAMPLE_RATES_HZ,
});

function versionGeometry(versionBits: number): VersionGeometry {
  if (versionBits === 0b11) return MPEG_1_GEOMETRY;
  if (versionBits === 0b10) return MPEG_2_GEOMETRY;
  if (versionBits === 0b00) return MPEG_2_5_GEOMETRY;
  throw new MpegLayer3FrameHeaderError('MPEG audio header uses the reserved version ID');
}

function validateLayer(layerBits: number): void {
  if (layerBits === 0b01) return;
  if (layerBits === 0b11) {
    throw new MpegLayer3FrameHeaderError('MPEG Layer I is outside the Layer III engine');
  }
  if (layerBits === 0b10) {
    throw new MpegLayer3FrameHeaderError('MPEG Layer II is outside the Layer III engine');
  }
  throw new MpegLayer3FrameHeaderError('MPEG audio header uses the reserved layer value');
}

function readBitrateIndex(value: number): MpegLayer3BitrateIndex {
  if (value === 0) {
    throw new MpegLayer3FrameHeaderError('Free-format MPEG Layer III bitrate is not supported');
  }
  if (value === 0b1111) {
    throw new MpegLayer3FrameHeaderError('MPEG Layer III header uses the reserved bitrate index');
  }
  return value as MpegLayer3BitrateIndex;
}

function readSampleRateIndex(value: number): MpegLayer3SampleRateIndex {
  if (value === 0b11) {
    throw new MpegLayer3FrameHeaderError(
      'MPEG Layer III header uses the reserved sample-rate index',
    );
  }
  return value as MpegLayer3SampleRateIndex;
}

function sideInfoLength(version: MpegLayer3Version, channelCount: 1 | 2): 9 | 17 | 32 {
  if (version === '1') return channelCount === 1 ? 17 : 32;
  return channelCount === 1 ? 9 : 17;
}

/** Parse one complete, byte-aligned MPEG-1/2/2.5 Layer III frame header. */
export function parseMpegLayer3FrameHeader(bytes: Uint8Array): MpegLayer3FrameHeader {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('MPEG Layer III frame header must be a Uint8Array');
  }
  if (bytes.byteLength !== 4) {
    throw new RangeError('MPEG Layer III frame header must contain exactly 4 bytes');
  }

  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const third = bytes[2] ?? 0;
  const fourth = bytes[3] ?? 0;

  if (first !== 0xff || (second & 0xe0) !== 0xe0) {
    throw new MpegLayer3FrameHeaderError('MPEG Layer III frame sync is invalid');
  }
  if ((fourth & 0b11) === 0b10) {
    throw new MpegLayer3FrameHeaderError('MPEG Layer III header uses the reserved emphasis value');
  }

  const version = versionGeometry((second >>> 3) & 0b11);
  validateLayer((second >>> 1) & 0b11);

  const bitrateIndex = readBitrateIndex((third >>> 4) & 0b1111);
  const sampleRateIndex = readSampleRateIndex((third >>> 2) & 0b11);
  const bitrateKbps = version.bitratesKbps[bitrateIndex];
  const sampleRateHz = version.sampleRatesHz[sampleRateIndex];
  if (!Number.isSafeInteger(bitrateKbps) || !Number.isSafeInteger(sampleRateHz)) {
    throw new MpegLayer3FrameHeaderError('MPEG Layer III header has incomplete rate geometry');
  }

  const padding = ((third >>> 1) & 1) === 1;
  const hasCrc = (second & 1) === 0;
  const channelMode = CHANNEL_MODES[(fourth >>> 6) & 0b11];
  if (channelMode === undefined) {
    throw new MpegLayer3FrameHeaderError('MPEG Layer III channel mode is invalid');
  }
  const channelCount: 1 | 2 = channelMode === 'mono' ? 1 : 2;
  const sideInfoBytes = sideInfoLength(version.version, channelCount);

  const frameNumerator = version.frameLengthCoefficient * bitrateKbps;
  if (!Number.isSafeInteger(frameNumerator) || frameNumerator <= 0) {
    throw new MpegLayer3FrameHeaderError('MPEG Layer III frame-size calculation overflowed');
  }
  const frameLengthBytes = Math.floor(frameNumerator / sampleRateHz) + (padding ? 1 : 0);
  const structuralBytes = 4 + (hasCrc ? 2 : 0) + sideInfoBytes;
  const mainDataCapacityBytes = frameLengthBytes - structuralBytes;
  if (
    !Number.isSafeInteger(frameLengthBytes) ||
    frameLengthBytes < 1 ||
    frameLengthBytes > MAX_LAYER_3_FRAME_LENGTH_BYTES ||
    !Number.isSafeInteger(mainDataCapacityBytes) ||
    mainDataCapacityBytes < 1
  ) {
    throw new MpegLayer3FrameHeaderError(
      'MPEG Layer III frame geometry cannot contain its header and side-info',
    );
  }

  return Object.freeze({
    version: version.version,
    layer: 3,
    bitrateIndex,
    bitrateKbps,
    sampleRateIndex,
    sampleRateHz,
    channelMode,
    channelCount,
    samplesPerFrame: version.samplesPerFrame,
    hasCrc,
    padding,
    frameLengthBytes,
    sideInfoBytes,
    mainDataCapacityBytes,
  });
}
