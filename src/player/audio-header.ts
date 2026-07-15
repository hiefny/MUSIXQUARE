/**
 * Bounded, RAM-only channel-count probe for formats accepted by the file UI.
 *
 * Only bounded header windows at validated random-access offsets are read. The
 * probe never decodes audio, never persists bytes, and returns null on malformed
 * or unfamiliar input. The production legacy engine skips this probe under its
 * unbounded policy; it remains available to explicit bounded/future engines.
 */

const HEADER_WINDOW_BYTES = 256 * 1024;
const MAX_REASONABLE_CHANNELS = 32;
const MAX_MP4_BOXES = 2048;
const MAX_MP4_PROBE_READ_BYTES = 512 * 1024;
const MAX_OGG_BOS_PAGES = 64;
const AC3_MAX_CHANNELS = 6;
const EAC3_MAX_CHANNELS = 16;

function validChannels(value: number): number | null {
  return Number.isInteger(value) && value > 0 && value <= MAX_REASONABLE_CHANNELS ? value : null;
}

function matches(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset < 0 || offset + value.length > bytes.length) return false;
  for (let i = 0; i < value.length; i++) {
    if (bytes[offset + i] !== value.charCodeAt(i)) return false;
  }
  return true;
}

function parseWave(bytes: Uint8Array): number | null {
  if (!(matches(bytes, 0, 'RIFF') || matches(bytes, 0, 'RF64')) || !matches(bytes, 8, 'WAVE')) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true);
    if (matches(bytes, offset, 'fmt ') && size >= 4 && offset + 12 <= bytes.length) {
      return validChannels(view.getUint16(offset + 10, true));
    }
    const next = offset + 8 + size + (size & 1);
    if (!Number.isSafeInteger(next) || next <= offset || next > bytes.length) return null;
    offset = next;
  }
  return null;
}

function parseAiff(bytes: Uint8Array): number | null {
  if (!matches(bytes, 0, 'FORM') || !(matches(bytes, 8, 'AIFF') || matches(bytes, 8, 'AIFC'))) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, false);
    if (matches(bytes, offset, 'COMM') && size >= 2 && offset + 10 <= bytes.length) {
      return validChannels(view.getUint16(offset + 8, false));
    }
    const next = offset + 8 + size + (size & 1);
    if (!Number.isSafeInteger(next) || next <= offset || next > bytes.length) return null;
    offset = next;
  }
  return null;
}

function parseCaf(bytes: Uint8Array): number | null {
  if (!matches(bytes, 0, 'caff')) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // CAF chunk lengths are uint64. The channel count is the uint32
  // mChannelsPerFrame field 24 bytes into the AudioDescription payload.
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const high = view.getUint32(offset + 4, false);
    const low = view.getUint32(offset + 8, false);
    if (high !== 0) return null;
    if (matches(bytes, offset, 'desc') && low >= 28 && offset + 40 <= bytes.length) {
      return validChannels(view.getUint32(offset + 36, false));
    }
    const next = offset + 12 + low;
    if (!Number.isSafeInteger(next) || next <= offset || next > bytes.length) return null;
    offset = next;
  }
  return null;
}

function parseFlac(bytes: Uint8Array): number | null {
  if (!matches(bytes, 0, 'fLaC')) return null;
  let offset = 4;
  while (offset + 4 <= bytes.length) {
    const type = bytes[offset] & 0x7f;
    const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    const data = offset + 4;
    if (type === 0 && length >= 18 && data + 18 <= bytes.length) {
      return validChannels(((bytes[data + 12] & 0x0e) >> 1) + 1);
    }
    const next = data + length;
    if (next <= offset || next > bytes.length) return null;
    offset = next;
  }
  return null;
}

function parseOgg(bytes: Uint8Array): number | null {
  let offset = 0;
  let pageCount = 0;
  let maxChannels: number | null = null;

  // Ogg identification is packet-scoped. Inspect only the first complete
  // packet of each initial BOS page; codec-like strings in comments or media
  // payload must never influence admission.
  while (offset + 27 <= bytes.length && pageCount < MAX_OGG_BOS_PAGES) {
    if (!matches(bytes, offset, 'OggS') || bytes[offset + 4] !== 0) return null;
    const headerType = bytes[offset + 5];
    const isBos = (headerType & 0x02) !== 0;
    if (!isBos) break;
    if ((headerType & 0x01) !== 0) return null;

    const segmentCount = bytes[offset + 26];
    const segmentTableStart = offset + 27;
    const payloadStart = segmentTableStart + segmentCount;
    if (segmentCount === 0 || payloadStart > bytes.length) return null;

    let payloadBytes = 0;
    let firstPacketBytes = 0;
    let firstPacketComplete = false;
    for (let segment = 0; segment < segmentCount; segment++) {
      const lace = bytes[segmentTableStart + segment];
      payloadBytes += lace;
      if (!firstPacketComplete) {
        firstPacketBytes += lace;
        if (lace < 255) firstPacketComplete = true;
      }
    }
    const pageEnd = payloadStart + payloadBytes;
    if (!Number.isSafeInteger(pageEnd) || pageEnd > bytes.length || !firstPacketComplete) {
      return null;
    }

    const packetEnd = payloadStart + firstPacketBytes;
    let channels: number | null = null;
    if (firstPacketBytes >= 19 && matches(bytes, payloadStart, 'OpusHead')) {
      channels = validChannels(bytes[payloadStart + 9]);
    } else if (
      firstPacketBytes >= 30 &&
      bytes[payloadStart] === 0x01 &&
      matches(bytes, payloadStart + 1, 'vorbis')
    ) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const version = view.getUint32(payloadStart + 7, true);
      if (version === 0 && (bytes[packetEnd - 1] & 0x01) === 1) {
        channels = validChannels(bytes[payloadStart + 11]);
      }
    }
    if (channels !== null) maxChannels = Math.max(maxChannels ?? 0, channels);

    offset = pageEnd;
    pageCount++;
  }

  // If the bounded BOS prefix itself exceeded the page cap, a later logical
  // stream could carry a wider layout. Fall back to UNKNOWN_CHANNELS.
  if (pageCount >= MAX_OGG_BOS_PAGES && offset + 27 <= bytes.length) return null;
  return maxChannels;
}

interface Mp4Box {
  readonly type: string;
  readonly start: number;
  readonly dataStart: number;
  readonly end: number;
  readonly headerBytes: number;
}

interface Mp4ProbeState {
  boxCount: number;
  readBytes: number;
}

const MP4_AUDIO_CONTAINER_TYPES = new Set(['minf', 'stbl', 'wave']);
const MP4_AUDIO_SAMPLE_ENTRY_TYPES = new Set([
  'mp4a',
  'alac',
  'Opus',
  'fLaC',
  'ac-3',
  'ec-3',
  'lpcm',
  'sowt',
  'twos',
  'raw ',
  'in24',
  'in32',
  'fl32',
  'fl64',
  'ulaw',
  'alaw',
]);

function mp4Type(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function parseMp4AudioEntry(
  bytes: Uint8Array,
  type: string,
  declaredSize: number,
  headerBytes: number,
): number | null {
  // Extended-size AudioSampleEntry layouts shift every legacy field. They are
  // uncommon and not needed for playback compatibility; fall back safely.
  if (headerBytes !== 8 || declaredSize < 26 || bytes.length < 26) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === 'ac-3') {
    // AC-3 fixes the legacy SoundDescription channelcount at 2; the bitstream
    // layout may be 5.1. Reserve the format maximum.
    return AC3_MAX_CHANNELS;
  }
  if (type === 'ec-3') {
    // E-AC-3 dependent substreams can extend the layout to 15.1.
    return EAC3_MAX_CHANNELS;
  }
  const soundDescriptionVersion = view.getUint16(16, false);
  if (soundDescriptionVersion === 2) {
    const validV2Layout =
      declaredSize >= 72 &&
      bytes.length >= 72 &&
      view.getUint16(24, false) === 3 &&
      view.getUint16(26, false) === 16 &&
      view.getUint16(28, false) === 0xfffe &&
      view.getUint16(30, false) === 0 &&
      view.getUint32(32, false) === 65_536 &&
      view.getUint32(36, false) === 72;
    return validV2Layout ? validChannels(view.getUint32(48, false)) : null;
  }
  if (soundDescriptionVersion !== 0 && soundDescriptionVersion !== 1) return null;
  return validChannels(view.getUint16(24, false));
}

function hasMp4TopLevelSignature(bytes: Uint8Array): boolean {
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let size = view.getUint32(offset, false);
    const type = mp4Type(bytes, offset + 4);
    if (type === 'ftyp' || type === 'moov') return true;
    if (size === 1) {
      if (offset + 16 > bytes.length) break;
      size = view.getUint32(offset + 8, false) * 0x1_0000_0000 + view.getUint32(offset + 12, false);
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    if (size < 8 || !Number.isSafeInteger(offset + size) || offset + size > bytes.length) break;
    offset += size;
  }
  return false;
}

function parseMp3Header(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null;
  const version = (bytes[offset + 1] >> 3) & 0x03;
  const layer = (bytes[offset + 1] >> 1) & 0x03;
  const bitrate = (bytes[offset + 2] >> 4) & 0x0f;
  const sampleRate = (bytes[offset + 2] >> 2) & 0x03;
  if (version === 1 || layer === 0 || bitrate === 0 || bitrate === 15 || sampleRate === 3) {
    return null;
  }
  // MPEG audio supports at most stereo. Reserve stereo even when the first
  // frame is mono because later frames may change channel mode.
  return 2;
}

function parseMp3(bytes: Uint8Array): number | null {
  for (let offset = 0; offset + 4 <= bytes.length; offset++) {
    const channels = parseMp3Header(bytes, offset);
    if (channels !== null) return channels;
  }
  return null;
}

function parseAdtsHeader(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xf6) !== 0xf0) return null;
  const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x0f;
  const channelConfig = ((bytes[offset + 2] & 0x01) << 2) | ((bytes[offset + 3] & 0xc0) >> 6);
  // ADTS configuration 7 represents 7.1 (eight channels), not seven. Raw AAC
  // frames can change configuration, so reserve the format maximum.
  return sampleRateIndex < 15 && channelConfig > 0 && channelConfig <= 7 ? 8 : null;
}

function parseAdts(bytes: Uint8Array): number | null {
  for (let offset = 0; offset + 4 <= bytes.length; offset++) {
    const channels = parseAdtsHeader(bytes, offset);
    if (channels !== null) return channels;
  }
  return null;
}

async function readWindow(blob: Blob, start: number, end: number): Promise<Uint8Array | null> {
  try {
    const part = blob.slice(start, end);
    if (typeof part.arrayBuffer !== 'function') return null;
    return new Uint8Array(await part.arrayBuffer());
  } catch {
    return null;
  }
}

async function readMp4ProbeWindow(
  blob: Blob,
  start: number,
  end: number,
  state: Mp4ProbeState,
): Promise<Uint8Array | null> {
  const bytes = end - start;
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    state.readBytes + bytes > MAX_MP4_PROBE_READ_BYTES
  ) {
    return null;
  }
  state.readBytes += bytes;
  return readWindow(blob, start, end);
}

async function readMp4BlobBox(
  blob: Blob,
  start: number,
  parentEnd: number,
  state: Mp4ProbeState,
): Promise<Mp4Box | null> {
  if (
    start < 0 ||
    start + 8 > parentEnd ||
    parentEnd > blob.size ||
    state.boxCount >= MAX_MP4_BOXES
  ) {
    return null;
  }
  state.boxCount++;
  const header = await readMp4ProbeWindow(blob, start, Math.min(parentEnd, start + 16), state);
  if (!header || header.length < 8) return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const type = mp4Type(header, 4);
  let size = view.getUint32(0, false);
  let headerBytes = 8;
  if (size === 1) {
    if (header.length < 16) return null;
    size = view.getUint32(8, false) * 0x1_0000_0000 + view.getUint32(12, false);
    headerBytes = 16;
  } else if (size === 0) {
    size = parentEnd - start;
  }
  const end = start + size;
  if (
    !Number.isSafeInteger(size) ||
    size < headerBytes ||
    !Number.isSafeInteger(end) ||
    end > parentEnd
  ) {
    return null;
  }
  return { type, start, dataStart: start + headerBytes, end, headerBytes };
}

async function probeMp4SampleDescription(
  blob: Blob,
  box: Mp4Box,
  state: Mp4ProbeState,
  audioTrack: boolean,
): Promise<number | null> {
  if (box.dataStart + 8 > box.end) return MAX_REASONABLE_CHANNELS;
  const header = await readMp4ProbeWindow(blob, box.dataStart, box.dataStart + 8, state);
  if (!header || header.length !== 8) return MAX_REASONABLE_CHANNELS;
  const entryCount = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
    4,
    false,
  );
  if (entryCount > 1024) return MAX_REASONABLE_CHANNELS;

  let offset = box.dataStart + 8;
  let maxChannels: number | null = null;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
    const entry = await readMp4BlobBox(blob, offset, box.end, state);
    if (!entry) return MAX_REASONABLE_CHANNELS;
    if (MP4_AUDIO_SAMPLE_ENTRY_TYPES.has(entry.type)) {
      const bytes = await readMp4ProbeWindow(
        blob,
        entry.start,
        Math.min(entry.end, entry.start + 72),
        state,
      );
      if (!bytes) return MAX_REASONABLE_CHANNELS;
      const channels = parseMp4AudioEntry(
        bytes,
        entry.type,
        entry.end - entry.start,
        entry.headerBytes,
      );
      if (channels === null) return MAX_REASONABLE_CHANNELS;
      maxChannels = Math.max(maxChannels ?? 0, channels);
    } else if (audioTrack) {
      // `hdlr=soun` makes every stsd entry an audio sample description. A
      // codec we do not understand may be wider than a known stereo sibling.
      return MAX_REASONABLE_CHANNELS;
    }
    offset = entry.end;
  }
  return maxChannels;
}

async function probeMp4AudioChildren(
  blob: Blob,
  start: number,
  end: number,
  depth: number,
  state: Mp4ProbeState,
): Promise<number | null> {
  if (depth > 8) return MAX_REASONABLE_CHANNELS;
  let offset = start;
  let maxChannels: number | null = null;
  while (offset < end) {
    const box = await readMp4BlobBox(blob, offset, end, state);
    if (!box) return MAX_REASONABLE_CHANNELS;
    if (box.type === 'stsd') {
      const channels = await probeMp4SampleDescription(blob, box, state, true);
      if (channels !== null) maxChannels = Math.max(maxChannels ?? 0, channels);
    } else if (MP4_AUDIO_CONTAINER_TYPES.has(box.type)) {
      const channels = await probeMp4AudioChildren(blob, box.dataStart, box.end, depth + 1, state);
      if (channels !== null) maxChannels = Math.max(maxChannels ?? 0, channels);
    }
    offset = box.end;
  }
  return maxChannels;
}

async function probeMp4MediaBox(
  blob: Blob,
  media: Mp4Box,
  state: Mp4ProbeState,
): Promise<number | null> {
  let offset = media.dataStart;
  let handlerType: string | null = null;
  const mediaInfoBoxes: Mp4Box[] = [];

  // First establish the track handler independently of child ordering. Only a
  // `soun` track may interpret unknown stsd entries as unknown audio layouts;
  // video sample entries must not force every MP4 to 32 channels.
  while (offset < media.end) {
    const box = await readMp4BlobBox(blob, offset, media.end, state);
    if (!box) return MAX_REASONABLE_CHANNELS;
    if (box.type === 'hdlr') {
      if (box.dataStart + 12 > box.end) return MAX_REASONABLE_CHANNELS;
      const header = await readMp4ProbeWindow(blob, box.dataStart, box.dataStart + 12, state);
      if (!header || header.length !== 12) return MAX_REASONABLE_CHANNELS;
      const currentHandler = mp4Type(header, 8);
      if (handlerType !== null && handlerType !== currentHandler) return MAX_REASONABLE_CHANNELS;
      handlerType = currentHandler;
    } else if (box.type === 'minf') {
      mediaInfoBoxes.push(box);
    }
    offset = box.end;
  }

  if (handlerType === null) {
    return mediaInfoBoxes.length > 0 ? MAX_REASONABLE_CHANNELS : null;
  }
  if (handlerType !== 'soun') return null;

  let maxChannels: number | null = null;
  for (const minf of mediaInfoBoxes) {
    const channels = await probeMp4AudioChildren(blob, minf.dataStart, minf.end, 0, state);
    if (channels !== null) maxChannels = Math.max(maxChannels ?? 0, channels);
  }
  return maxChannels;
}

async function probeMp4TrackBox(
  blob: Blob,
  track: Mp4Box,
  state: Mp4ProbeState,
): Promise<number | null> {
  let offset = track.dataStart;
  let maxChannels: number | null = null;
  while (offset < track.end) {
    const box = await readMp4BlobBox(blob, offset, track.end, state);
    if (!box) return MAX_REASONABLE_CHANNELS;
    if (box.type === 'mdia') {
      const channels = await probeMp4MediaBox(blob, box, state);
      if (channels !== null) maxChannels = Math.max(maxChannels ?? 0, channels);
    }
    offset = box.end;
  }
  return maxChannels;
}

async function probeMp4MovieBox(
  blob: Blob,
  movie: Mp4Box,
  state: Mp4ProbeState,
): Promise<number | null> {
  let offset = movie.dataStart;
  let maxChannels: number | null = null;
  while (offset < movie.end) {
    const box = await readMp4BlobBox(blob, offset, movie.end, state);
    if (!box) return MAX_REASONABLE_CHANNELS;
    if (box.type === 'trak') {
      const channels = await probeMp4TrackBox(blob, box, state);
      if (channels !== null) maxChannels = Math.max(maxChannels ?? 0, channels);
    }
    offset = box.end;
  }
  return maxChannels;
}

async function probeMp4TopLevelChannels(blob: Blob): Promise<number | null> {
  let offset = 0;
  let maxChannels: number | null = null;
  const state: Mp4ProbeState = { boxCount: 0, readBytes: 0 };

  // Prove ownership by walking exact top-level offsets from file start. Nested
  // parsing also reads only box headers and the fixed AudioSampleEntry prefix,
  // so even a very large moov/sample table remains bounded.
  while (offset < blob.size) {
    const box = await readMp4BlobBox(blob, offset, blob.size, state);
    if (!box) return null;
    if (box.type === 'moov') {
      const channels = await probeMp4MovieBox(blob, box, state);
      if (channels !== null) maxChannels = Math.max(maxChannels ?? 0, channels);
    }
    offset = box.end;
  }
  return maxChannels;
}

function id3AudioOffset(bytes: Uint8Array): number | null {
  if (!matches(bytes, 0, 'ID3') || bytes.length < 10) return null;
  const majorVersion = bytes[3];
  const revision = bytes[4];
  const flags = bytes[5];
  if (majorVersion < 2 || majorVersion > 4 || revision === 0xff) return null;
  const allowedFlagMask = majorVersion === 2 ? 0xc0 : majorVersion === 3 ? 0xe0 : 0xf0;
  if ((flags & ~allowedFlagMask) !== 0) return null;
  if ([bytes[6], bytes[7], bytes[8], bytes[9]].some((value) => (value & 0x80) !== 0)) {
    return null;
  }
  const tagSize = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
  const audioOffset = 10 + tagSize + (majorVersion === 4 && (flags & 0x10) !== 0 ? 10 : 0);
  return Number.isSafeInteger(audioOffset) ? audioOffset : null;
}

export async function probeAudioChannelCount(blob: Blob): Promise<number | null> {
  if (typeof blob.slice !== 'function' || !Number.isFinite(blob.size) || blob.size <= 0)
    return null;

  const first = await readWindow(blob, 0, Math.min(blob.size, HEADER_WINDOW_BYTES));
  if (!first) return null;

  // Container signatures are authoritative enough to choose a parser. Never
  // run loose MPEG sync scans over another format's arbitrary payload.
  if ((matches(first, 0, 'RIFF') || matches(first, 0, 'RF64')) && matches(first, 8, 'WAVE')) {
    return parseWave(first);
  }
  if (matches(first, 0, 'FORM')) return parseAiff(first);
  if (matches(first, 0, 'caff')) return parseCaf(first);
  if (matches(first, 0, 'fLaC')) return parseFlac(first);
  if (matches(first, 0, 'OggS')) return parseOgg(first);

  // Byte signatures take precedence over caller-supplied MIME metadata. A
  // renamed or proxy-served MP3 may arrive as audio/mp4; trusting that label
  // before its ID3/frame signature would route it into the MP4 walker and
  // unnecessarily fall back to the 32-channel admission ceiling.
  if (hasMp4TopLevelSignature(first)) {
    return probeMp4TopLevelChannels(blob);
  }

  if (matches(first, 0, 'ID3')) {
    const audioOffset = id3AudioOffset(first);
    if (audioOffset === null || audioOffset >= blob.size) return null;
    const audioWindow =
      audioOffset + 4 <= first.length
        ? first.subarray(audioOffset)
        : await readWindow(blob, audioOffset, Math.min(blob.size, audioOffset + 64 * 1024));
    if (!audioWindow) return null;
    // The ID3 size points at the first audio frame. Classify only that exact
    // boundary so sync-like bytes later in MP3 payload cannot masquerade as
    // ADTS (or vice versa).
    return parseAdtsHeader(audioWindow, 0) ?? parseMp3Header(audioWindow, 0);
  }
  if (first[0] === 0xff && (first[1] & 0xf6) === 0xf0) return parseAdts(first);
  if (first[0] === 0xff && (first[1] & 0xe0) === 0xe0) {
    return parseMp3(first);
  }

  const mime = String(blob.type || '').toLowerCase();
  if (
    mime === 'audio/mp4' ||
    mime === 'audio/x-m4a' ||
    mime === 'video/mp4' ||
    mime === 'video/quicktime'
  ) {
    return probeMp4TopLevelChannels(blob);
  }

  return null;
}
