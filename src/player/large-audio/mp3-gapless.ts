/** MP3 gapless metadata is outside the encoded audio packets delivered by a demuxer. */
interface Mp3GaplessTrim {
  readonly startSamples: number;
  readonly endSamples: number;
}

const EMPTY_TRIM: Mp3GaplessTrim = { startSamples: 0, endSamples: 0 };
const MPEG_SYNTHESIS_DELAY = 529;
const HEADER_WINDOW_BYTES = 64 * 1024;

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
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
    if (initial.subarray(6, 10).some((value) => value > 127)) return EMPTY_TRIM;
    const tagSize = initial[6] * 2 ** 21 + initial[7] * 2 ** 14 + initial[8] * 128 + initial[9];
    // ID3v2.4 stores the footer separately from the synchsafe tag length.
    const footerSize = initial[3] === 4 && (initial[5] & 0x10) !== 0 ? 10 : 0;
    audioStart = 10 + tagSize + footerSize;
  }
  const bytes = new Uint8Array(
    await blob.slice(audioStart, audioStart + HEADER_WINDOW_BYTES).arrayBuffer(),
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 40 < bytes.length; offset++) {
    if (bytes[offset] !== 255 || (bytes[offset + 1] & 0xe0) !== 0xe0) continue;
    const version = (bytes[offset + 1] >> 3) & 3;
    const layer = (bytes[offset + 1] >> 1) & 3;
    if (version === 1 || layer !== 1) continue;
    const mono = bytes[offset + 3] >> 6 === 3;
    const sideInfoBytes = version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
    // Xing/LAME keeps this offset even on CRC-protected MPEG frames. LAME's
    // writer subtracts the CRC bytes rather than moving the Xing header.
    const xing = offset + 4 + sideInfoBytes;
    if (xing + 8 > bytes.length) continue;
    const marker = ascii(bytes, xing, 4);
    if (marker !== 'Xing' && marker !== 'Info') continue;
    const flags = view.getUint32(xing + 4);
    let encoder = xing + 8;
    if (flags & 1) encoder += 4;
    if (flags & 2) encoder += 4;
    if (flags & 4) encoder += 100;
    if (flags & 8) encoder += 4;
    if (encoder + 24 > bytes.length) return EMPTY_TRIM;
    const encoderName = ascii(bytes, encoder, 4);
    if (!['LAME', 'Lavc', 'Lavf'].includes(encoderName)) return EMPTY_TRIM;
    const delay = bytes[encoder + 21] * 16 + (bytes[encoder + 22] >> 4);
    const padding = (bytes[encoder + 22] & 15) * 256 + bytes[encoder + 23];
    // Reject absent/invalid gapless values instead of shifting every plain MP3.
    if (delay === 0 && padding === 0) return EMPTY_TRIM;
    if (padding < MPEG_SYNTHESIS_DELAY) return EMPTY_TRIM;
    return {
      startSamples: delay + MPEG_SYNTHESIS_DELAY,
      endSamples: padding - MPEG_SYNTHESIS_DELAY,
    };
  }
  return EMPTY_TRIM;
}
