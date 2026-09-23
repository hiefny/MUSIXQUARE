interface Box {
  type: string;
  payload: number;
  end: number;
}

interface Edit {
  duration: number;
  mediaTime: number;
}

interface TrackTiming {
  id: number | null;
  edits: Edit[] | null;
  error: string | null;
}

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];
const MAX_BOXES = 4096;

function coreSampleRate(config: AudioDecoderConfig): number {
  const description = config.description;
  if (!description) return config.sampleRate;
  const bytes = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
  if (bytes.length < 2) return config.sampleRate;
  const objectType = bytes[0] >> 3;
  if (objectType === 31) return config.sampleRate;
  const index = ((bytes[0] & 7) << 1) | (bytes[1] >> 7);
  if (index === 15 && bytes.length >= 5) {
    return (bytes[1] & 127) * 131072 + bytes[2] * 512 + bytes[3] * 2 + (bytes[4] >> 7);
  }
  return AAC_SAMPLE_RATES[index] ?? config.sampleRate;
}

/**
 * Read only MP4 framing and tiny timing fields, skipping encoded mdat bytes.
 * Mediabunny applies edit-list media offsets but does not clip their end;
 * iTunes gapless tags are separate from its packet timeline altogether.
 */
export async function readAacContainerTiming(
  blob: Blob,
  trackId: number,
  config: AudioDecoderConfig,
  isCurrent?: () => boolean,
): Promise<{ origin: number | null; end: number | null }> {
  let scanned = 0;
  const read = async (start: number, end: number): Promise<DataView> => {
    if (isCurrent?.() === false)
      throw new DOMException('Large AAC preparation superseded', 'AbortError');
    const view = new DataView(await blob.slice(start, end).arrayBuffer());
    if (isCurrent?.() === false)
      throw new DOMException('Large AAC preparation superseded', 'AbortError');
    return view;
  };
  const text = (view: DataView, offset = 0): string => {
    const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, view.byteLength - offset);
    return new TextDecoder().decode(bytes);
  };
  const children = async function* (start: number, end: number): AsyncGenerator<Box> {
    for (let offset = start; offset + 8 <= end;) {
      if (++scanned > MAX_BOXES) throw new Error('Large AAC container has too many metadata boxes');
      const header = await read(offset, Math.min(end, offset + 16));
      let size = header.getUint32(0);
      let headerSize = 8;
      const type = String.fromCharCode(...new Uint8Array(header.buffer, 4, 4));
      if (size === 1) {
        if (header.byteLength < 16) return;
        size = Number(header.getBigUint64(8));
        headerSize = 16;
      } else if (size === 0) size = end - offset;
      if (!Number.isSafeInteger(size) || size < headerSize || size > end - offset) return;
      yield { type, payload: offset + headerSize, end: offset + size };
      offset += size;
    }
  };
  let timescale = 0;
  const tracks: TrackTiming[] = [];
  let gapless: { delay: number; samples: number } | null = null;
  const inspect = async (box: Box, track: TrackTiming | null): Promise<void> => {
    if (box.type === 'mvhd') {
      const view = await read(box.payload, Math.min(box.end, box.payload + 32));
      const offset = view.getUint8(0) === 1 ? 20 : 12;
      if (view.byteLength >= offset + 4) timescale = view.getUint32(offset);
    } else if (box.type === 'tkhd' && track) {
      const view = await read(box.payload, Math.min(box.end, box.payload + 32));
      const offset = view.getUint8(0) === 1 ? 20 : 12;
      if (view.byteLength >= offset + 4) track.id = view.getUint32(offset);
    } else if (box.type === 'elst' && track) {
      const header = await read(box.payload, Math.min(box.end, box.payload + 8));
      if (header.byteLength < 8) return;
      const version = header.getUint8(0);
      const count = header.getUint32(4);
      const size = version === 1 ? 20 : 12;
      if (count === 0) return;
      // A single audio edit has verified native/FAAD timing. Leading empty
      // edits and assembled segments need separate audible-tail validation.
      if (version > 1 || count > 1 || box.end - box.payload < 8 + count * size) {
        track.error = 'Unsupported large AAC edit list';
        return;
      }
      const data = await read(box.payload + 8, box.payload + 8 + count * size);
      const edits: Edit[] = [];
      for (let i = 0; i < count; i++) {
        const offset = i * size;
        const duration = version === 1 ? Number(data.getBigUint64(offset)) : data.getUint32(offset);
        const mediaTime =
          version === 1 ? Number(data.getBigInt64(offset + 8)) : data.getInt32(offset + 4);
        const rate = data.getInt32(offset + size - 4);
        if (
          !Number.isSafeInteger(duration) ||
          !Number.isSafeInteger(mediaTime) ||
          mediaTime < -1 ||
          rate !== 65536
        ) {
          track.error = 'Unsupported large AAC edit rate or timestamp';
          return;
        }
        edits.push({ duration, mediaTime });
      }
      if (
        edits.filter((edit) => edit.mediaTime >= 0).length !== 1 ||
        edits[edits.length - 1]?.mediaTime === -1
      ) {
        track.error = 'Unsupported large AAC edit sequence';
        return;
      }
      track.edits = edits;
    } else if (box.type === '----') {
      let mean = '';
      let name = '';
      let data = '';
      for await (const field of children(box.payload, box.end)) {
        if (field.end - field.payload > 4096) continue;
        const view = await read(field.payload, field.end);
        if (field.type === 'mean' && view.byteLength >= 4) mean = text(view, 4);
        if (field.type === 'name' && view.byteLength >= 4) name = text(view, 4);
        if (field.type === 'data' && view.byteLength >= 8) data = text(view, 8);
      }
      if (mean === 'com.apple.iTunes' && name === 'iTunSMPB') {
        const parts = /^\s*[\da-f]{8}\s+([\da-f]{8})\s+([\da-f]{8})\s+([\da-f]{16})\b/i.exec(data);
        if (parts) {
          const delay = Number.parseInt(parts[1], 16);
          const samples = Number.parseInt(parts[3], 16);
          if (delay > 0 && delay < 16384 && Number.isSafeInteger(samples) && samples > 0) {
            gapless = { delay, samples };
          }
        }
      }
    } else if (['moov', 'trak', 'edts', 'udta', 'meta', 'ilst'].includes(box.type)) {
      let nestedTrack = track;
      if (box.type === 'trak') {
        nestedTrack = { id: null, edits: null, error: null };
        tracks.push(nestedTrack);
      }
      const start = box.payload + (box.type === 'meta' ? 4 : 0);
      for await (const child of children(start, box.end)) await inspect(child, nestedTrack);
    }
  };
  for await (const box of children(0, blob.size)) {
    if (box.type === 'moov') {
      await inspect(box, null);
      break;
    }
  }
  const selected = tracks.find((track) => track.id === trackId);
  if (!selected) return { origin: null, end: null };
  if (selected.error) throw new Error(selected.error);
  if (selected.edits) {
    if (timescale <= 0) throw new Error('Invalid large AAC movie timescale');
    const duration = selected.edits.reduce((sum, edit) => sum + edit.duration, 0);
    if (!Number.isSafeInteger(duration)) throw new Error('Invalid large AAC edit duration');
    return {
      origin: null,
      end: duration / timescale,
    };
  }
  const tag = gapless as { delay: number; samples: number } | null;
  if (tag) {
    if (tracks.length !== 1) throw new Error('Ambiguous large AAC gapless metadata');
    const rate = coreSampleRate(config);
    if (Number.isFinite(rate) && rate > 0) {
      return { origin: tag.delay / rate, end: (tag.delay + tag.samples) / rate };
    }
  }
  return { origin: null, end: null };
}
