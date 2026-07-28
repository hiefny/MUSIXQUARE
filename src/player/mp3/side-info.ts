import { parseMpegLayer3FrameHeader, type MpegLayer3FrameHeader } from './frame-header.ts';

export class Mp3SideInfoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mp3SideInfoError';
  }
}

function sameParsedHeader(expected: MpegLayer3FrameHeader, actual: MpegLayer3FrameHeader): boolean {
  return (
    expected.version === actual.version &&
    expected.layer === actual.layer &&
    expected.bitrateIndex === actual.bitrateIndex &&
    expected.bitrateKbps === actual.bitrateKbps &&
    expected.sampleRateIndex === actual.sampleRateIndex &&
    expected.sampleRateHz === actual.sampleRateHz &&
    expected.channelMode === actual.channelMode &&
    expected.channelCount === actual.channelCount &&
    expected.samplesPerFrame === actual.samplesPerFrame &&
    expected.hasCrc === actual.hasCrc &&
    expected.padding === actual.padding &&
    expected.frameLengthBytes === actual.frameLengthBytes &&
    expected.sideInfoBytes === actual.sideInfoBytes &&
    expected.mainDataCapacityBytes === actual.mainDataCapacityBytes
  );
}

/**
 * Read Layer III's bit-reservoir back-pointer from a bounded frame prefix.
 *
 * The prefix must begin at the frame header, contain the bytes needed for
 * `main_data_begin`, and end no later than the declared frame boundary. The
 * remainder of side-info is intentionally neither required nor parsed.
 */
export function parseMpegLayer3MainDataBegin(
  framePrefix: Uint8Array,
  header: MpegLayer3FrameHeader,
): number {
  if (!(framePrefix instanceof Uint8Array)) {
    throw new TypeError('MP3 frame prefix must be a Uint8Array');
  }
  if (framePrefix.byteLength < 4) {
    throw new Mp3SideInfoError('MP3 frame prefix is shorter than its four-byte header');
  }

  const parsedHeader = parseMpegLayer3FrameHeader(framePrefix.subarray(0, 4));
  if (!sameParsedHeader(header, parsedHeader)) {
    throw new Mp3SideInfoError('Parsed MPEG header does not match the supplied frame');
  }
  if (framePrefix.byteLength > parsedHeader.frameLengthBytes) {
    throw new Mp3SideInfoError('MP3 frame prefix extends beyond its declared frame boundary');
  }

  const sideInfoOffset = 4 + (parsedHeader.hasCrc ? 2 : 0);
  const requiredBytes = parsedHeader.version === '1' ? 2 : 1;
  if (framePrefix.byteLength < sideInfoOffset + requiredBytes) {
    throw new Mp3SideInfoError('MP3 frame prefix truncates Layer III main_data_begin');
  }

  const first = framePrefix[sideInfoOffset] ?? 0;
  if (parsedHeader.version !== '1') return first;
  return first * 2 + ((framePrefix[sideInfoOffset + 1] ?? 0) >>> 7);
}
