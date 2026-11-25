import { readFile } from 'node:fs/promises';
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

/** Rewrite the first trak's tkhd track_ID and leave every other byte intact. */
function withTrackId(original: Uint8Array, id: number): Uint8Array {
  const bytes = new Uint8Array(original);
  const view = new DataView(bytes.buffer);
  const find = (type: string, start: number, end: number): number => {
    for (let offset = start; offset + 8 <= end;) {
      const size = view.getUint32(offset);
      if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === type) return offset;
      if (size < 8) break;
      offset += size;
    }
    throw new Error(`Fixture has no ${type} box`);
  };
  const moov = find('moov', 0, bytes.length);
  const trak = find('trak', moov + 8, moov + view.getUint32(moov));
  const tkhd = find('tkhd', trak + 8, trak + view.getUint32(trak));
  const idOffset = tkhd + 8 + (bytes[tkhd + 8] === 1 ? 20 : 12);
  expect(view.getUint32(idOffset)).toBe(1);
  view.setUint32(idOffset, id);
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

  it('keeps every decoded MP3 sample when only Mediabunny accepts the gapless tag', async () => {
    // A padding below the 529-sample decoder delay makes readMp3GaplessTrim
    // refuse the tag, while Mediabunny 1.64+ still starts the packets at
    // -(delay + 529). Pin the earlier timeline: no trim, priming included.
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
    expect(Math.abs(duration - decodedFrames / SOURCE_RATE)).toBeLessThan(1 / SOURCE_RATE);
    for (const channel of pcm) {
      expect(chirpDistance(channel, delay + MPEG_SYNTHESIS_DELAY)).toBeLessThan(0.003);
    }
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
});
