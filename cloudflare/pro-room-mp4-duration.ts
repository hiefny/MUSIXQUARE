type RangeReader = (start: number, end: number) => Promise<Uint8Array>;

const MAX_BOXES = 2048;
const MAX_DEPTH = 4;
const MAX_EDIT_ENTRIES = 256;
const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60;

interface AudioTrackHeader {
  handler: string | null;
  mediaSeconds: number | null;
  trackTicks: number | null;
  editTicks: number | null;
  hasEdits: boolean;
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function unsigned64(view: DataView, offset: number): number | null {
  const value = view.getBigUint64(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function finiteSeconds(value: number): number | null {
  return Number.isFinite(value) && value > 0 && value <= MAX_DURATION_SECONDS ? value : null;
}

/**
 * Read ISO BMFF timing headers without invoking a sample-table demuxer.
 * Even a tiny untrusted stts/ctts box can declare billions of samples, so those
 * tables (and media bodies) are deliberately never traversed or expanded.
 * undefined permits another format probe; null means MP4 was recognized but
 * its finite audio presentation duration cannot be established safely.
 */
export async function readProRoomMp4Duration(
  read: RangeReader,
  size: number,
): Promise<number | null | undefined> {
  if (!Number.isSafeInteger(size) || size < 8) return undefined;
  const prefix = await read(0, 8);
  if (prefix.length !== 8 || fourcc(prefix, 4) !== 'ftyp') return undefined;

  let boxes = 0;
  let movieTimescale = 0;
  const tracks: AudioTrackHeader[] = [];
  const readExact = async (start: number, length: number, end: number) => {
    if (!Number.isSafeInteger(start + length) || length < 0 || start + length > end) {
      throw new Error('MP4_DURATION_TRUNCATED_HEADER');
    }
    const bytes = await read(start, start + length);
    if (bytes.length !== length) throw new Error('MP4_DURATION_TRUNCATED_RANGE');
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  };
  const timedHeader = async (start: number, end: number) => {
    const version = (await readExact(start, 4, end)).getUint8(0);
    if (version !== 0 && version !== 1) throw new Error('MP4_DURATION_UNKNOWN_VERSION');
    const view = await readExact(start, version === 1 ? 32 : 20, end);
    const timescale = view.getUint32(version === 1 ? 20 : 12);
    const ticks = version === 1 ? unsigned64(view, 24) : view.getUint32(16);
    // All-ones and zero durations mark indefinite/unavailable timing.
    const knownTicks = ticks !== null && ticks > 0 && !(version === 0 && ticks === 0xffffffff);
    return {
      timescale,
      seconds: timescale > 0 && knownTicks ? finiteSeconds(ticks / timescale) : null,
    };
  };
  const editDuration = async (start: number, end: number): Promise<number | null> => {
    const header = await readExact(start, 8, end);
    const version = header.getUint8(0);
    const count = header.getUint32(4);
    if ((version !== 0 && version !== 1) || count === 0 || count > MAX_EDIT_ENTRIES) return null;
    const width = version === 1 ? 20 : 12;
    const entries = await readExact(start + 8, width * count, end);
    let total = 0;
    let hasMedia = false;
    for (let index = 0; index < count; index += 1) {
      const offset = index * width;
      const duration = version === 1 ? unsigned64(entries, offset) : entries.getUint32(offset);
      const mediaTime =
        version === 1 ? entries.getBigInt64(offset + 8) : BigInt(entries.getInt32(offset + 4));
      const rateOffset = offset + (version === 1 ? 16 : 8);
      if (
        duration === null ||
        mediaTime < -1n ||
        mediaTime > BigInt(Number.MAX_SAFE_INTEGER) ||
        entries.getInt16(rateOffset) !== 1 ||
        entries.getInt16(rateOffset + 2) !== 0
      )
        return null;
      total += duration;
      if (!Number.isSafeInteger(total)) return null;
      if (mediaTime >= 0n && duration > 0) hasMedia = true;
    }
    return hasMedia && total > 0 ? total : null;
  };

  const walk = async (
    start: number,
    end: number,
    depth: number,
    container: 'root' | 'moov' | 'trak' | 'mdia' | 'edts',
    track: AudioTrackHeader | null = null,
  ): Promise<void> => {
    if (depth > MAX_DEPTH) throw new Error('MP4_DURATION_DEPTH_LIMIT');
    let offset = start;
    while (offset < end) {
      if (++boxes > MAX_BOXES) throw new Error('MP4_DURATION_BOX_LIMIT');
      const header = await readExact(offset, 8, end);
      const type = fourcc(new Uint8Array(header.buffer, header.byteOffset, 8), 4);
      const shortSize = header.getUint32(0);
      const headerLength = shortSize === 1 ? 16 : 8;
      const length =
        shortSize === 1
          ? unsigned64(await readExact(offset + 8, 8, end), 0)
          : shortSize === 0
            ? end - offset
            : shortSize;
      if (length === null || length < headerLength || length > end - offset) {
        throw new Error('MP4_DURATION_INVALID_BOX');
      }
      const body = offset + headerLength;
      const boxEnd = offset + length;
      if (container === 'root' && type === 'moov') {
        await walk(body, boxEnd, depth + 1, 'moov');
      } else if (container === 'moov' && type === 'mvhd') {
        movieTimescale = (await timedHeader(body, boxEnd)).timescale;
      } else if (container === 'moov' && type === 'trak') {
        const child: AudioTrackHeader = {
          handler: null,
          mediaSeconds: null,
          trackTicks: null,
          editTicks: null,
          hasEdits: false,
        };
        tracks.push(child);
        await walk(body, boxEnd, depth + 1, 'trak', child);
      } else if (container === 'trak' && type === 'mdia') {
        await walk(body, boxEnd, depth + 1, 'mdia', track);
      } else if (container === 'trak' && type === 'edts') {
        await walk(body, boxEnd, depth + 1, 'edts', track);
      } else if (container === 'mdia' && track && type === 'hdlr') {
        const view = await readExact(body, 12, boxEnd);
        track.handler = fourcc(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), 8);
      } else if (container === 'mdia' && track && type === 'mdhd') {
        track.mediaSeconds = (await timedHeader(body, boxEnd)).seconds;
      } else if (container === 'trak' && track && type === 'tkhd') {
        const version = (await readExact(body, 4, boxEnd)).getUint8(0);
        if (version !== 0 && version !== 1) throw new Error('MP4_DURATION_UNKNOWN_VERSION');
        const view = await readExact(body, version === 1 ? 36 : 24, boxEnd);
        const ticks = version === 1 ? unsigned64(view, 28) : view.getUint32(20);
        track.trackTicks =
          ticks !== null && ticks > 0 && !(version === 0 && ticks === 0xffffffff) ? ticks : null;
      } else if (container === 'edts' && track && type === 'elst') {
        track.hasEdits = true;
        track.editTicks = await editDuration(body, boxEnd);
      }
      // Unknown boxes include mdat, minf/stbl, stts, ctts and fragment sample
      // runs. Seek directly past them using their bounded parent extent.
      offset = boxEnd;
    }
  };

  try {
    await walk(0, size, 0, 'root');
    const audioTracks = tracks.filter((track) => track.handler === 'soun');
    // Browser decoders and the large-file engine may prefer a default or
    // higher-bitrate track over the first track. Header order cannot establish
    // which timeline is audible; use the controller's decoded duration instead.
    if (audioTracks.length !== 1) return null;
    const audio = audioTracks[0];
    if (!audio?.mediaSeconds) return null;
    if (audio.hasEdits) {
      if (!audio.editTicks || movieTimescale <= 0) return null;
      // Edit lists define the audible presentation, including priming trims
      // and leading empty edits. Track duration can round that boundary up.
      return finiteSeconds(Math.max(audio.editTicks, audio.trackTicks ?? 0) / movieTimescale);
    }
    return finiteSeconds(
      Math.max(
        audio.mediaSeconds,
        movieTimescale > 0 && audio.trackTicks !== null ? audio.trackTicks / movieTimescale : 0,
      ),
    );
  } catch {
    return null;
  }
}
