import { readFile } from 'node:fs/promises';
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';
import type { LargeAudioTrack } from '../../file-playback-resource.ts';
import { openLargeAudioTrack } from '../index.ts';
import { useRealDecoderRuntime } from './__helpers__/real-decoder-runtime.ts';

useRealDecoderRuntime();

// Every chirp fixture encodes five seconds of a synthetic 44.1 kHz chirp
// (e2e/large-audio-codec-parity.test.ts, e2e/fixtures/large-audio-aac.md).
const SOURCE_RATE = 44_100;
const SOURCE_FRAMES = SOURCE_RATE * 5;
const MPEG_SYNTHESIS_DELAY = 529;

/**
 * The MP3 fixture's source in both channels: sin(2*PI*(220*t+40*t*t)) mixed
 * from mono to stereo at -3 dB, as the lossless FLAC fixture decodes.
 */
function chirp(frame: number): number {
  const time = frame / SOURCE_RATE;
  return Math.SQRT1_2 * Math.sin(2 * Math.PI * (220 * time + 40 * time * time));
}

/**
 * Schedule the whole track on a stopped sample clock and place every source's
 * PCM by frame, the way the bounded engine hands it to Web Audio.
 */
async function render(track: LargeAudioTrack): Promise<Float32Array[]> {
  const rate = track.sampleRate;
  const channels = Array.from({ length: track.numberOfChannels }, () =>
    new Float32Array(track.length).fill(Number.NaN),
  );
  const errors: unknown[] = [];
  let scheduledEnd = 0;
  const context = {
    currentTime: 0,
    createBufferSource() {
      let startsAt = 0;
      let offset = 0;
      const source = {
        buffer: null as AudioBuffer | null,
        onended: null,
        connect() {},
        disconnect() {},
        start(when: number, at: number) {
          startsAt = when;
          offset = at;
        },
        stop(when?: number) {
          const buffer = source.buffer;
          if (when === undefined || !buffer) return;
          const end = Math.min(track.length, Math.round(when * rate));
          for (let frame = Math.round(startsAt * rate); frame < end; frame++) {
            const index = Math.round((frame / rate - startsAt + offset) * rate);
            channels.forEach((output, channel) => {
              output[frame] = buffer.getChannelData(channel)[index];
            });
          }
          scheduledEnd = Math.max(scheduledEnd, when);
        },
      };
      return source;
    },
  };
  await track.prepare(0);
  const playback = track.createPlayback({
    context: context as unknown as AudioContext,
    destination: {} as AudioNode,
    when: 0,
    offset: 0,
    onended() {},
    onerror(error) {
      errors.push(error);
    },
  });
  try {
    await vi.waitFor(
      () => {
        expect(errors).toEqual([]);
        expect(scheduledEnd).toBe(track.duration);
      },
      { timeout: 10_000 },
    );
  } finally {
    playback.stop();
  }
  return channels;
}

async function openAndRender(
  bytes: Uint8Array,
): Promise<{ duration: number; sampleRate: number; pcm: Float32Array[] }> {
  const track = await openLargeAudioTrack(new Blob([new Uint8Array(bytes)]));
  try {
    return { duration: track.duration, sampleRate: track.sampleRate, pcm: await render(track) };
  } finally {
    track.dispose();
  }
}

/** RMS distance from the source chirp, which starts at PCM frame `start`. */
function chirpDistance(pcm: Float32Array, start: number): number {
  let sum = 0;
  for (let frame = 0; frame < SOURCE_FRAMES; frame++) {
    sum += (pcm[start + frame] - chirp(frame)) ** 2;
  }
  return Math.sqrt(sum / SOURCE_FRAMES);
}

function maxDifference(left: Float32Array[], right: Float32Array[]): number {
  let max = 0;
  left.forEach((channel, index) => {
    for (let frame = 0; frame < channel.length; frame++) {
      max = Math.max(max, Math.abs(channel[frame] - right[index][frame]));
    }
  });
  return max;
}

/** The offset of the first `type` box from `start` to `end`. */
function findBox(bytes: Uint8Array, type: string, start: number, end: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = start; offset + 8 <= end;) {
    const size = view.getUint32(offset);
    if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === type) return offset;
    if (size < 8) break;
    offset += size;
  }
  throw new Error(`Fixture has no ${type} box`);
}

/** Rewrite the first trak's tkhd track_ID and leave every other byte intact. */
function withTrackId(original: Uint8Array, id: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(original);
  const view = new DataView(bytes.buffer);
  const moov = findBox(bytes, 'moov', 0, bytes.length);
  const trak = findBox(bytes, 'trak', moov + 8, moov + view.getUint32(moov));
  const tkhd = findBox(bytes, 'tkhd', trak + 8, trak + view.getUint32(trak));
  const idOffset = tkhd + 8 + (bytes[tkhd + 8] === 1 ? 20 : 12);
  expect(view.getUint32(idOffset)).toBe(1);
  view.setUint32(idOffset, id);
  return bytes;
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 8));
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(new TextEncoder().encode(type), 4);
  let offset = 8;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function fields(length: number, write?: (view: DataView) => void): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  write?.(new DataView(bytes.buffer));
  return bytes;
}

/** A full-box payload: version 0, no flags, then 32-bit words. */
function words(...values: number[]): Uint8Array<ArrayBuffer> {
  return fields(4 + values.length * 4, (view) => {
    values.forEach((value, index) => view.setUint32(4 + index * 4, value));
  });
}

/**
 * A 'vide' trak with tkhd ID 1 and one 5 s, 16-byte sample in an unknown
 * format at `sampleOffset`. It needs a sample: FFmpeg, and so Chromium's
 * decodeAudioData, reads a trak without samples as a fragmented MP4 and then
 * ignores the edit lists of the traks after it.
 */
function videoTrak(sampleOffset: number): Uint8Array<ArrayBuffer> {
  const header = fields(84, (view) => {
    view.setUint32(0, 3); // Version 0, track enabled and in the movie.
    view.setUint32(12, 1);
    view.setUint32(20, 5000);
    view.setUint32(40, 0x10000); // Identity matrix.
    view.setUint32(56, 0x10000);
    view.setUint32(72, 0x40000000);
    view.setUint32(76, 16 << 16); // Width and height, 16.16 fixed point.
    view.setUint32(80, 16 << 16);
  });
  const handler = fields(25);
  handler.set(new TextEncoder().encode('vide'), 8);
  const entry = fields(78, (view) => {
    view.setUint16(6, 1); // data_reference_index
    view.setUint32(24, (16 << 16) | 16);
    view.setUint32(28, 0x480000);
    view.setUint32(32, 0x480000);
    view.setUint16(40, 1);
    view.setUint16(74, 24);
    view.setInt16(76, -1);
  });
  const samples = box(
    'stbl',
    box('stsd', words(1), box('xxxx', entry)),
    box('stts', words(1, 1, 5000)),
    box('stsc', words(1, 1, 1, 1)),
    box('stsz', words(0, 1, 16)),
    box('stco', words(1, sampleOffset)),
  );
  return box(
    'trak',
    box('tkhd', header),
    box(
      'mdia',
      box('mdhd', words(0, 0, 1000, 5000, 0)),
      box('hdlr', handler),
      box('minf', samples),
    ),
  );
}

/**
 * Put a 'vide' trak before the audio trak, whose tkhd ID becomes 2. moov is
 * the fixture's last box, so the sample offsets into mdat stay valid.
 */
function withVideoTrakFirst(original: Uint8Array): Uint8Array<ArrayBuffer> {
  const audio = withTrackId(original, 2);
  const view = new DataView(audio.buffer);
  const moov = findBox(audio, 'moov', 0, audio.length);
  const moovSize = view.getUint32(moov);
  expect(moov + moovSize).toBe(audio.length);
  const trak = findBox(audio, 'trak', moov + 8, moov + moovSize);
  const video = videoTrak(findBox(audio, 'mdat', 0, moov) + 8);
  const bytes = new Uint8Array(audio.length + video.length);
  bytes.set(audio.subarray(0, trak));
  bytes.set(video, trak);
  bytes.set(audio.subarray(trak), trak + video.length);
  new DataView(bytes.buffer).setUint32(moov, moovSize + video.length);
  return bytes;
}

describe('real Mediabunny and decoder timing of large files', () => {
  it('starts a LAME-tagged MP3 at its first source sample and ends at its last', async () => {
    const bytes = await readFile('e2e/fixtures/large-audio-chirp.mp3');
    const { duration, sampleRate, pcm } = await openAndRender(bytes);
    expect(sampleRate).toBe(SOURCE_RATE);
    expect(Math.abs(duration - SOURCE_FRAMES / SOURCE_RATE)).toBeLessThan(1 / SOURCE_RATE);
    // One frame of misalignment is about 0.031 RMS against this chirp.
    for (const channel of pcm) expect(chirpDistance(channel, 0)).toBeLessThan(0.003);
  });

  it('keeps the native MP3 timeline when only Mediabunny accepts the gapless tag', async () => {
    // A padding below the 529-sample decoder delay makes readMp3GaplessTrim
    // refuse the tag. Mediabunny 1.64+ still starts the packets at
    // -(delay + 529), and Chromium 159's decodeAudioData skips the same start
    // and trims no end: 221,231 frames with the chirp at frame 0.
    const bytes = await readFile('e2e/fixtures/large-audio-chirp.mp3');
    const tag = bytes.indexOf('Lavc', bytes.indexOf('Xing'));
    expect(tag).toBeGreaterThan(0);
    const delay = (bytes[tag + 21] << 4) | (bytes[tag + 22] >> 4);
    const padding = ((bytes[tag + 22] & 15) << 8) | bytes[tag + 23];
    expect({ delay, padding }).toEqual({ delay: 576, padding: 1260 });
    bytes[tag + 22] = (bytes[tag + 22] & 0xf0) | ((MPEG_SYNTHESIS_DELAY - 1) >> 8);
    bytes[tag + 23] = (MPEG_SYNTHESIS_DELAY - 1) & 0xff;
    const { duration, pcm } = await openAndRender(bytes);
    const decodedFrames = delay + SOURCE_FRAMES + padding;
    const nativeFrames = decodedFrames - (delay + MPEG_SYNTHESIS_DELAY);
    expect(Math.abs(duration - nativeFrames / SOURCE_RATE)).toBeLessThan(1 / SOURCE_RATE);
    for (const channel of pcm) expect(chirpDistance(channel, 0)).toBeLessThan(0.003);
  });

  it.each(['lc-itunes', 'he-itunes'])(
    'keeps %s iTunes gapless timing when the audio tkhd track ID is not its position',
    async (name) => {
      const bytes = await readFile(`e2e/fixtures/large-audio-chirp-${name}.m4a`);
      const original = await openAndRender(bytes);
      const renumbered = await openAndRender(withTrackId(bytes, 7));
      expect(Math.abs(original.duration - SOURCE_FRAMES / SOURCE_RATE)).toBeLessThan(
        1 / original.sampleRate,
      );
      expect(renumbered.duration).toBe(original.duration);
      expect(maxDifference(renumbered.pcm, original.pcm)).toBe(0);
    },
  );

  it('keeps the he-stereo edit-list end when a video trak comes before the audio trak', async () => {
    const bytes = await readFile('e2e/fixtures/large-audio-chirp-he-stereo.m4a');
    const reordered = withVideoTrakFirst(bytes);
    // The audio track is Mediabunny's second track (id 2) and its first audio
    // track (number 1), so passing the id or counting every track would differ.
    // Chromium 159's decodeAudioData decodes this file to the original's 5 s.
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(new Blob([reordered])),
    });
    try {
      const audio = await input.getPrimaryAudioTrack();
      expect((await input.getTracks()).map((track) => track.type)).toEqual(['video', 'audio']);
      expect({ id: audio?.id, number: audio?.number }).toEqual({ id: 2, number: 1 });
    } finally {
      input.dispose();
    }
    const original = await openAndRender(bytes);
    const withVideo = await openAndRender(reordered);
    expect(Math.abs(original.duration - SOURCE_FRAMES / SOURCE_RATE)).toBeLessThan(
      1 / original.sampleRate,
    );
    expect(withVideo.duration).toBe(original.duration);
    expect(maxDifference(withVideo.pcm, original.pcm)).toBe(0);
  });
});
