/** MP3 gapless metadata is outside the encoded audio packets delivered by a demuxer. */
interface Mp3GaplessTrim {
  readonly startSamples: number;
  readonly endSamples: number;
}

const EMPTY_TRIM: Mp3GaplessTrim = { startSamples: 0, endSamples: 0 };
const MPEG_SYNTHESIS_DELAY = 529;
const HEADER_WINDOW_BYTES = 64 * 1024;
const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

interface FrameGeometry {
  readonly length: number;
  readonly sideInfoBytes: number;
  readonly samples: number;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function readFrameGeometry(bytes: Uint8Array, offset: number): FrameGeometry | null {
  if (bytes[offset] !== 255 || (bytes[offset + 1] & 0xe0) !== 0xe0) return null;
  const version = (bytes[offset + 1] >> 3) & 3;
  const layer = (bytes[offset + 1] >> 1) & 3;
  const bitrateIndex = bytes[offset + 2] >> 4;
  const sampleRateIndex = (bytes[offset + 2] >> 2) & 3;
  if (
    version === 1 ||
    layer !== 1 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    sampleRateIndex === 3
  )
    return null;
  const mpeg1 = version === 3;
  const bitrate = (mpeg1 ? MPEG1_BITRATES : MPEG2_BITRATES)[bitrateIndex];
  const sampleRate =
    [44_100, 48_000, 32_000][sampleRateIndex] / (mpeg1 ? 1 : version === 2 ? 2 : 4);
  const length =
    Math.floor(((mpeg1 ? 144_000 : 72_000) * bitrate) / sampleRate) +
    ((bytes[offset + 2] >> 1) & 1);
  const mono = bytes[offset + 3] >> 6 === 3;
  const sideInfoBytes = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  return { length, sideInfoBytes, samples: mpeg1 ? 1152 : 576 };
}

function readFirstFrameTrim(frame: Uint8Array, geometry: FrameGeometry): Mp3GaplessTrim {
  // CRC protection does not move the Xing slot in LAME/FFmpeg files.
  const xing = 4 + geometry.sideInfoBytes;
  if (xing + 8 > frame.length) return EMPTY_TRIM;
  const marker = ascii(frame, xing, 4);
  if (marker !== 'Xing' && marker !== 'Info') return EMPTY_TRIM;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const flags = view.getUint32(xing + 4);
  if (flags & ~0x0f) return EMPTY_TRIM;
  let encoder = xing + 8;
  const frameCount = flags & 1 && encoder + 4 <= frame.length ? view.getUint32(encoder) : null;
  if (flags & 1) encoder += 4;
  if (flags & 2) encoder += 4;
  if (flags & 4) encoder += 100;
  if (flags & 8) encoder += 4;
  // Never interpret bytes from a following audio frame as an encoder extension.
  if (encoder + 36 > frame.length) return EMPTY_TRIM;
  const [encoderTag, ...tagPadding] = ascii(frame, encoder, 9).split('\0');
  if (
    !/^(?:LAME|Lavc|Lavf)\d[\x20-\x7e]*$/.test(encoderTag) ||
    tagPadding.some((value) => value !== '')
  )
    return EMPTY_TRIM;
  if (frame[encoder + 9] >> 4 !== 0) return EMPTY_TRIM;
  const delay = frame[encoder + 21] * 16 + (frame[encoder + 22] >> 4);
  const padding = (frame[encoder + 22] & 15) * 256 + frame[encoder + 23];
  if (delay === 0x0fff || padding === 0x0fff || padding < MPEG_SYNTHESIS_DELAY) return EMPTY_TRIM;
  if (frameCount !== null && delay + padding >= frameCount * geometry.samples) return EMPTY_TRIM;
  // Native decoders accept useful gapless data even when its optional tag CRC
  // is absent/stale. Requiring that CRC here would shift hybrid-only playback.
  return { startSamples: delay + MPEG_SYNTHESIS_DELAY, endSamples: padding - MPEG_SYNTHESIS_DELAY };
}

/**
 * Read only ID3 framing and one bounded header window. LAME-compatible Xing
 * tags describe encoder delay/padding; raw MPEG decoder output also has a
 * 529-sample synthesis delay. Applying this once to the global sample timeline
 * keeps seeks and complete decodeAudioData playback on the same audible origin.
 */
export async function readMp3GaplessTrim(blob: Blob): Promise<Mp3GaplessTrim> {
  const initial = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
  let audioStart = 0;
  if (initial.length === 10 && ascii(initial, 0, 3) === 'ID3') {
    if (initial[3] < 2 || initial[3] > 4) return EMPTY_TRIM;
    if (initial.subarray(6, 10).some((value) => value > 127)) return EMPTY_TRIM;
    const tagSize = initial[6] * 2 ** 21 + initial[7] * 2 ** 14 + initial[8] * 128 + initial[9];
    // ID3v2.4 stores the footer separately from the synchsafe tag length.
    const footerSize = initial[3] === 4 && (initial[5] & 0x10) !== 0 ? 10 : 0;
    audioStart = 10 + tagSize + footerSize;
  }
  const bytes = new Uint8Array(
    await blob.slice(audioStart, audioStart + HEADER_WINDOW_BYTES).arrayBuffer(),
  );
  for (let offset = 0; offset + 4 <= bytes.length; offset++) {
    const geometry = readFrameGeometry(bytes, offset);
    if (!geometry) continue;
    const end = offset + geometry.length;
    if (end > bytes.length) return EMPTY_TRIM;
    // Gapless timing belongs to the first frame, never a later track's Xing
    // tag or an accidental matching byte sequence inside compressed audio.
    return readFirstFrameTrim(bytes.subarray(offset, end), geometry);
  }
  return EMPTY_TRIM;
}
