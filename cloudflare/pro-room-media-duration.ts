import { cancelReadableBody } from './pro-room-body.ts';
import { readProRoomMp4Duration } from './pro-room-mp4-duration.ts';

interface DurationBucket {
  get(
    key: string,
    options: { range: { offset: number; length: number } },
  ): Promise<{ size?: number; body?: ReadableStream<Uint8Array> } | null>;
}

// Demux only: no PCM allocation, codec initialization, or arbitrary external URLs.
// Indexed formats usually need a few headers. Unindexed MP3/ADTS may need a
// bounded scan; do not invent a CBR duration for an unindexed VBR file.
const MAX_READ_BYTES = 16 * 1024 * 1024;
const MAX_READS = 256;
const MAX_RANGE_BYTES = 512 * 1024;
const MAX_AUDIO_FRAMES = 100_000;
const MAX_PROBE_MS = 10_000;
const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60;

function finiteDuration(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0 && value <= MAX_DURATION_SECONDS
    ? value
    : null;
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  return (
    offset >= 0 &&
    offset + text.length <= bytes.length &&
    [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0))
  );
}

type RangeReader = (start: number, end: number) => Promise<Uint8Array>;

function audioStartOffset(prefix: Uint8Array, size: number): number | null {
  if (!ascii(prefix, 0, 'ID3')) return 0;
  if (
    prefix.length < 10 ||
    (prefix[3] !== 3 && prefix[3] !== 4) ||
    prefix.slice(6, 10).some((byte) => byte > 127)
  )
    return null;
  const offset =
    10 +
    ((prefix[6]! << 21) | (prefix[7]! << 14) | (prefix[8]! << 7) | prefix[9]!) +
    (prefix[3] === 4 && prefix[5]! & 0x10 ? 10 : 0);
  return offset < size ? offset : null;
}

async function flacDuration(read: RangeReader, size: number): Promise<number | null> {
  if (size < 42) return null;
  const bytes = await read(4, 42);
  if ((bytes[0]! & 0x7f) !== 0 || bytes[1] !== 0 || bytes[2] !== 0 || bytes[3] !== 34) return null;
  // STREAMINFO's eight packed bytes contain sample-rate and the exact 36-bit
  // decoded sample count. Never follow metadata lengths or allocate PCM.
  const packed = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(14);
  const rate = Number(packed >> 44n);
  const samples = Number(packed & 0xfffffffffn);
  return rate > 0 ? finiteDuration(samples / rate) : null;
}

function safeUint64(view: DataView, offset: number): number | null {
  const value = view.getBigUint64(offset, true);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

async function waveDuration(read: RangeReader, size: number): Promise<number | null> {
  if (size < 12) return null;
  const header = await read(0, 12);
  if (!ascii(header, 8, 'WAVE')) return null;
  const rf64 = ascii(header, 0, 'RF64');
  const declared = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
    4,
    true,
  );
  if ((!rf64 && (declared < 4 || declared + 8 > size)) || (rf64 && declared !== 0xffffffff))
    return null;
  let boundary = rf64 ? size : declared + 8;
  let data64: number | null = null;
  let sampleCount64: number | null = null;
  let sampleRate = 0;
  let blockAlign = 0;
  let dataBytes: number | null = null;
  let offset = 12;
  for (let chunks = 0; chunks < 128 && offset + 8 <= boundary; chunks += 1) {
    const bytes = await read(offset, offset + 8);
    const chunkLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      4,
      true,
    );
    const start = offset + 8;
    if (rf64 && offset === 12 && !ascii(bytes, 0, 'ds64')) return null;
    let length = chunkLength;
    if (ascii(bytes, 0, 'ds64')) {
      if (!rf64 || offset !== 12 || chunkLength < 28 || start + chunkLength > boundary) return null;
      const ds = await read(start, start + 28);
      const view = new DataView(ds.buffer, ds.byteOffset, ds.byteLength);
      const riff64 = safeUint64(view, 0);
      data64 = safeUint64(view, 8);
      sampleCount64 = safeUint64(view, 16);
      if (
        riff64 === null ||
        riff64 < 4 ||
        riff64 + 8 > size ||
        data64 === null ||
        sampleCount64 === null ||
        view.getUint32(24, true) !== 0
      )
        return null;
      boundary = riff64 + 8;
    } else if (ascii(bytes, 0, 'fmt ')) {
      if (sampleRate || chunkLength < 16 || start + chunkLength > boundary) return null;
      const fmt = await read(start, start + Math.min(chunkLength, 40));
      const view = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength);
      let encoding = view.getUint16(0, true);
      const channels = view.getUint16(2, true);
      sampleRate = view.getUint32(4, true);
      const byteRate = view.getUint32(8, true);
      blockAlign = view.getUint16(12, true);
      const bits = view.getUint16(14, true);
      if (encoding === 0xfffe) {
        if (chunkLength < 40 || view.getUint16(16, true) < 22 || view.getUint16(18, true) > bits)
          return null;
        // KSDATAFORMAT_SUBTYPE_PCM / IEEE_FLOAT; other codecs need decoding
        // rules this bounded header reader deliberately does not guess.
        const suffix = [0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
        if (suffix.some((byte, index) => fmt[26 + index] !== byte)) return null;
        encoding = view.getUint16(24, true);
      }
      if (
        (encoding !== 1 && encoding !== 3) ||
        channels < 1 ||
        channels > 32 ||
        sampleRate < 1 ||
        sampleRate > 768000 ||
        ![8, 16, 24, 32, 64].includes(bits) ||
        (encoding === 3 && bits !== 32 && bits !== 64) ||
        blockAlign !== (channels * bits) / 8 ||
        byteRate !== sampleRate * blockAlign
      )
        return null;
    } else if (ascii(bytes, 0, 'data')) {
      if (dataBytes !== null) return null;
      if (rf64 && chunkLength === 0xffffffff) {
        if (data64 === null) return null;
        length = data64;
      }
      dataBytes = length;
    }
    if (!Number.isSafeInteger(start + length) || start + length > boundary) return null;
    offset = start + length + (length % 2);
  }
  if (
    offset !== boundary ||
    dataBytes === null ||
    !sampleRate ||
    !blockAlign ||
    dataBytes % blockAlign !== 0
  )
    return null;
  const samples = dataBytes / blockAlign;
  if (rf64 && sampleCount64 !== null && sampleCount64 !== 0 && sampleCount64 !== samples)
    return null;
  return finiteDuration(samples / sampleRate);
}

function mp3Frame(header: Uint8Array): { bytes: number; samples: number; rate: number } | null {
  if (header.length < 4 || header[0] !== 0xff || (header[1]! & 0xe0) !== 0xe0) return null;
  const version = (header[1]! >> 3) & 3;
  const layer = (header[1]! >> 1) & 3;
  const index = header[2]! >> 4;
  const rateIndex = (header[2]! >> 2) & 3;
  if (version === 1 || layer !== 1 || index === 0 || index === 15 || rateIndex === 3) return null;
  const rate = [44100, 48000, 32000][rateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const bitrate = (
    version === 3
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  )[index]!;
  return {
    bytes:
      Math.floor(((version === 3 ? 144000 : 72000) * bitrate) / rate) + ((header[2]! >> 1) & 1),
    samples: version === 3 ? 1152 : 576,
    rate,
  };
}

async function framedAudioDuration(
  read: RangeReader,
  size: number,
  start: number,
  kind: 'mp3' | 'adts',
): Promise<number | null> {
  let cache: Uint8Array = new Uint8Array(0);
  let cacheOffset = -1;
  const headerAt = async (offset: number, length: number) => {
    if (offset < cacheOffset || offset + length > cacheOffset + cache.length) {
      cacheOffset = offset;
      cache = await read(offset, Math.min(size, offset + MAX_RANGE_BYTES));
    }
    return cache.subarray(offset - cacheOffset, offset - cacheOffset + length);
  };
  let offset = start;
  let seconds = 0;
  let frames = 0;
  while (offset < size && frames < MAX_AUDIO_FRAMES) {
    const header = await headerAt(offset, Math.min(kind === 'mp3' ? 4 : 7, size - offset));
    if (kind === 'mp3' && size - offset === 128 && ascii(header, 0, 'TAG')) {
      offset = size;
      break;
    }
    if (kind === 'mp3') {
      const frame = mp3Frame(header);
      if (!frame || offset + frame.bytes > size) return null;
      offset += frame.bytes;
      seconds += frame.samples / frame.rate;
    } else {
      if (header.length < 7 || header[0] !== 0xff || (header[1]! & 0xf6) !== 0xf0) return null;
      const rate = [
        96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
      ][(header[2]! >> 2) & 15];
      const length = ((header[3]! & 3) << 11) | (header[4]! << 3) | (header[5]! >> 5);
      if (!rate || length < (header[1]! & 1 ? 7 : 9) || offset + length > size) return null;
      offset += length;
      seconds += (1024 * ((header[6]! & 3) + 1)) / rate;
    }
    frames += 1;
  }
  return offset === size && frames > 0 ? finiteDuration(seconds) : null;
}

/** Only the explicit frame-count header is authoritative; bitrate estimates aren't. */
async function indexedMp3Duration(
  read: (start: number, end: number) => Promise<Uint8Array>,
  size: number,
): Promise<number | null> {
  const prefix = await read(0, Math.min(size, 10));
  let offset = 0;
  if (ascii(prefix, 0, 'ID3')) {
    if (prefix.length < 10 || prefix.slice(6, 10).some((byte) => byte > 127)) return null;
    offset = 10 + ((prefix[6]! << 21) | (prefix[7]! << 14) | (prefix[8]! << 7) | prefix[9]!);
    if (prefix[3] === 4 && prefix[5]! & 0x10) offset += 10;
  }
  if (offset + 48 > size) return null;
  const bytes = await read(offset, Math.min(size, offset + 4096));
  // The first MPEG frame must begin at the validated ID3 boundary. A heuristic
  // scan could mistake an embedded cover image for a duration-bearing header.
  if (bytes[0] !== 0xff || (bytes[1]! & 0xe0) !== 0xe0) return null;
  const version = (bytes[1]! >> 3) & 3;
  const layer = (bytes[1]! >> 1) & 3;
  const sampleIndex = (bytes[2]! >> 2) & 3;
  const bitrateIndex = bytes[2]! >> 4;
  if (
    version === 1 ||
    layer !== 1 ||
    sampleIndex === 3 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15
  )
    return null;
  const sampleRate =
    [44100, 48000, 32000][sampleIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const samplesPerFrame = version === 3 ? 1152 : 576;
  const mono = bytes[3]! >> 6 === 3;
  const xingOffset = 4 + (version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Joined or truncated files keep the first part's header, which would end
  // playback early. Trust its frame count only when that many frames could span
  // the remaining bytes (largest Layer III frame at this rate, plus the header
  // frame and an ID3v1 tag) and a declared stream size matches the audio span
  // within FFmpeg's 1/16 concatenation tolerance. Otherwise the bounded scan
  // measures the whole file or leaves it unknown.
  const audioBytes = size - offset;
  const largestFrame = Math.floor((version === 3 ? 144000 * 320 : 72000 * 160) / sampleRate) + 1;
  const indexed = (frames: number, declaredBytes: number | null) =>
    (frames + 1) * largestFrame + 128 >= audioBytes &&
    (declaredBytes === null ||
      Math.abs(declaredBytes - audioBytes) <= Math.min(declaredBytes, audioBytes) / 16)
      ? finiteDuration((frames * samplesPerFrame) / sampleRate)
      : null;
  if (
    (ascii(bytes, xingOffset, 'Xing') || ascii(bytes, xingOffset, 'Info')) &&
    bytes.length >= xingOffset + 12 &&
    view.getUint32(xingOffset + 4) & 1
  ) {
    const declared =
      view.getUint32(xingOffset + 4) & 2 && bytes.length >= xingOffset + 16
        ? view.getUint32(xingOffset + 12)
        : null;
    return indexed(view.getUint32(xingOffset + 8), declared);
  }
  // Fraunhofer VBRI's frame count uses the same MPEG sample clock.
  if (ascii(bytes, 36, 'VBRI') && bytes.length >= 54) {
    return indexed(view.getUint32(50), view.getUint32(46));
  }
  return null;
}

export async function readProRoomFileDuration(
  bucket: DurationBucket,
  key: string,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<number | null> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || !key || signal?.aborted)
    return null;
  let stopped = false;
  let totalBytes = 0;
  let reads = 0;
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let finishTimeout!: (value: null) => void;
  const expired = new Promise<null>((resolve) => {
    finishTimeout = resolve;
  });
  const stop = (): void => {
    stopped = true;
    for (const reader of readers) cancelReadableBody(reader, 'PRO_MEDIA_DURATION_PROBE_STOPPED');
  };
  const abort = (): void => {
    stop();
    finishTimeout(null);
  };
  const timer = setTimeout(abort, MAX_PROBE_MS);
  signal?.addEventListener('abort', abort, { once: true });
  const read = async (start: number, end: number): Promise<Uint8Array> => {
    const length = end - start;
    if (
      stopped ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end > expectedBytes ||
      length <= 0 ||
      length > MAX_RANGE_BYTES ||
      ++reads > MAX_READS ||
      (totalBytes += length) > MAX_READ_BYTES
    )
      throw new Error('PRO_MEDIA_DURATION_PROBE_BUDGET');
    const object = await bucket.get(key, { range: { offset: start, length } });
    if (stopped || !object?.body || object.size !== expectedBytes) {
      cancelReadableBody(object?.body, 'PRO_MEDIA_DURATION_SOURCE_CHANGED');
      throw new Error('PRO_MEDIA_DURATION_SOURCE_CHANGED');
    }
    const reader = object.body.getReader();
    readers.add(reader);
    const bytes = new Uint8Array(length);
    let offset = 0;
    try {
      while (!stopped) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value.byteLength > length - offset)
          throw new Error('PRO_MEDIA_DURATION_RANGE_OVERRUN');
        bytes.set(chunk.value, offset);
        offset += chunk.value.byteLength;
      }
      if (stopped || offset !== length) throw new Error('PRO_MEDIA_DURATION_RANGE_TRUNCATED');
      return bytes;
    } finally {
      readers.delete(reader);
      cancelReadableBody(reader, 'PRO_MEDIA_DURATION_RANGE_COMPLETE');
      try {
        reader.releaseLock();
      } catch {
        /* pending non-cooperative read */
      }
    }
  };
  const probe = async (): Promise<number | null> => {
    const prefix = await read(0, Math.min(expectedBytes, 10));
    if (ascii(prefix, 0, 'fLaC')) return flacDuration(read, expectedBytes);
    if (ascii(prefix, 0, 'RIFF') || ascii(prefix, 0, 'RF64'))
      return waveDuration(read, expectedBytes);
    if (ascii(prefix, 4, 'ftyp'))
      return (await readProRoomMp4Duration(read, expectedBytes)) ?? null;
    const offset = audioStartOffset(prefix, expectedBytes);
    if (offset === null || offset + 4 > expectedBytes) return null;
    const frameHeader = await read(offset, Math.min(expectedBytes, offset + 7));
    if (mp3Frame(frameHeader)) {
      const indexedDuration = await indexedMp3Duration(read, expectedBytes);
      return indexedDuration ?? framedAudioDuration(read, expectedBytes, offset, 'mp3');
    }
    if (frameHeader[0] === 0xff && (frameHeader[1]! & 0xf6) === 0xf0) {
      return framedAudioDuration(read, expectedBytes, offset, 'adts');
    }
    // Unknown formats are intentionally not handed to a general demuxer:
    // attacker-controlled sample/tag counts can allocate or loop before a
    // custom range callback sees the request. Authorized READY still supplies
    // a decoded duration for these formats without changing playback support.
    return null;
  };
  try {
    return await Promise.race([probe().catch(() => null), expired]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    stop();
  }
}
