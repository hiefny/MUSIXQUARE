import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  EncodedAudioSource,
  EncodedAudioSourceMetadata,
} from '../../sources/encoded-audio-source.ts';
import { throwIfAborted, validateExactRead } from '../../sources/encoded-audio-source.ts';
import { parseMpegLayer3FrameHeader } from '../frame-header.ts';
import { readMp3Metadata } from '../metadata.ts';
import {
  Mpg123FrameDecoder,
  Mpg123FrameDecoderError,
  type Mpg123FrameDecoderConfig,
  type Mpg123FrameDecoderRuntimeFactory,
} from '../mpg123-frame-decoder.ts';

interface HeaderOptions {
  readonly versionBits?: 0 | 2 | 3;
  readonly bitrateIndex?: number;
  readonly sampleRateIndex?: 0 | 1 | 2;
  readonly channelModeBits?: 0 | 1 | 2 | 3;
}

interface MockDecodedAudio {
  readonly channelData: unknown;
  readonly samplesDecoded: unknown;
  readonly sampleRate: unknown;
  readonly errors: unknown;
}

const MPEG1_STEREO_CONFIG: Mpg123FrameDecoderConfig = Object.freeze({
  encodedChannels: 2,
  sampleRateHz: 44_100,
  samplesPerFrame: 1_152,
});

function makeHeader(options: HeaderOptions = {}): Uint8Array {
  return Uint8Array.of(
    0xff,
    0xe0 | ((options.versionBits ?? 3) << 3) | (1 << 1) | 1,
    ((options.bitrateIndex ?? 9) << 4) | ((options.sampleRateIndex ?? 0) << 2),
    (options.channelModeBits ?? 0) << 6,
  );
}

function makeFrame(options: HeaderOptions = {}): Uint8Array {
  const headerBytes = makeHeader(options);
  const header = parseMpegLayer3FrameHeader(headerBytes);
  const frame = new Uint8Array(header.frameLengthBytes);
  frame.set(headerBytes);
  return frame;
}

function pcm(frames: number, seed = 0): readonly [Float32Array, Float32Array] {
  const left = Float32Array.from({ length: frames }, (_, index) => (index + seed) / 2_048);
  return [left, left.slice()];
}

function validAudioResult(
  frames = MPEG1_STEREO_CONFIG.samplesPerFrame,
  sampleRate = MPEG1_STEREO_CONFIG.sampleRateHz,
): MockDecodedAudio {
  return {
    channelData: pcm(frames),
    samplesDecoded: frames,
    sampleRate,
    errors: [],
  };
}

function mockDecoder(
  result: MockDecodedAudio = validAudioResult(),
  config: Mpg123FrameDecoderConfig = MPEG1_STEREO_CONFIG,
) {
  const decodeFrame = vi.fn((_frame: Uint8Array) => result);
  const decode = vi.fn();
  const decodeFrames = vi.fn();
  const reset = vi.fn();
  const free = vi.fn();
  const runtime = {
    ready: Promise.resolve(),
    decodeFrame,
    decode,
    decodeFrames,
    reset,
    free,
  };
  const factory = vi.fn(() => runtime) as Mpg123FrameDecoderRuntimeFactory;
  return {
    decoder: new Mpg123FrameDecoder(config, factory),
    factory,
    runtime,
    decodeFrame,
    decode,
    decodeFrames,
    reset,
    free,
  };
}

class FixtureSource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly identity: string;
  readonly metadata: EncodedAudioSourceMetadata;

  constructor(
    readonly bytes: Uint8Array,
    name: string,
  ) {
    this.identity = `fixture:${name}`;
    this.metadata = Object.freeze({ name, mime: 'audio/mpeg' });
  }

  get size(): number {
    return this.bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    return this.bytes.slice(offset, end);
  }

  async close(): Promise<void> {}
}

async function verifiedFixtureFrames(name: 'demo_track.mp3' | 'dummy_audio.mp3') {
  const file = await readFile(resolve(process.cwd(), 'public', name));
  const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
  const metadata = await readMp3Metadata(
    new FixtureSource(bytes, name),
    new AbortController().signal,
  );
  if (!metadata.hasTagFrame || metadata.tagFrameOffset === null || metadata.tagFrameBytes <= 0) {
    throw new Error(`${name} must retain its scanner-verified Xing/Info metadata frame`);
  }
  const tag = bytes.slice(
    metadata.tagFrameOffset,
    metadata.tagFrameOffset + metadata.tagFrameBytes,
  );
  const audio = bytes.slice(
    metadata.firstAudioFrameOffset,
    metadata.firstAudioFrameOffset + metadata.firstAudioFrameHeader.frameLengthBytes,
  );
  return { bytes, metadata, tag, audio };
}

describe('Mpg123FrameDecoder', () => {
  it('constructs exactly one gapless-disabled runtime and exposes only its narrow boundary', async () => {
    const harness = mockDecoder();
    expect(harness.factory).toHaveBeenCalledTimes(1);
    expect(harness.factory).toHaveBeenCalledWith({ enableGapless: false });
    expect(() => harness.decoder.decodeVerifiedFrame(makeFrame(), 'audio')).toThrow(/not ready/i);

    await harness.decoder.ready;
    const decoded = harness.decoder.decodeVerifiedFrame(makeFrame(), 'audio');

    expect(harness.decodeFrame).toHaveBeenCalledTimes(1);
    expect(harness.decode).not.toHaveBeenCalled();
    expect(harness.decodeFrames).not.toHaveBeenCalled();
    expect(harness.reset).not.toHaveBeenCalled();
    expect(harness.free).not.toHaveBeenCalled();
    expect('decodeFrames' in harness.decoder).toBe(false);
    expect('reset' in harness.decoder).toBe(false);
    expect('free' in harness.decoder).toBe(false);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.channelData)).toBe(true);
    expect(Object.isFrozen(decoded.channelData[0])).toBe(false);
    expect(decoded).toMatchObject({
      kind: 'audio',
      samplesDecoded: 1_152,
      sampleRateHz: 44_100,
    });
  });

  it('accepts only exact matching complete frame headers before invoking the runtime', async () => {
    const cases: ReadonlyArray<{ readonly frame: Uint8Array; readonly message: RegExp }> = [
      { frame: makeFrame().subarray(0, makeFrame().length - 1), message: /length/i },
      { frame: makeFrame({ sampleRateIndex: 1 }), message: /header.*generation/i },
      { frame: makeFrame({ channelModeBits: 3 }), message: /header.*generation/i },
      {
        frame: makeFrame({ versionBits: 2, bitrateIndex: 8 }),
        message: /header.*generation/i,
      },
    ];

    for (const testCase of cases) {
      const harness = mockDecoder();
      await harness.decoder.ready;
      expect(() => harness.decoder.decodeVerifiedFrame(testCase.frame, 'audio')).toThrow(
        testCase.message,
      );
      expect(harness.decodeFrame).not.toHaveBeenCalled();
    }
  });

  it('treats every decoder error and malformed result as fatal', async () => {
    const malformed: ReadonlyArray<MockDecodedAudio> = [
      { ...validAudioResult(), errors: [{ message: 'bad frame' }] },
      { ...validAudioResult(), errors: null },
      { ...validAudioResult(), samplesDecoded: 1_151 },
      { ...validAudioResult(), samplesDecoded: Number.NaN },
      { ...validAudioResult(), sampleRate: 48_000 },
      { ...validAudioResult(), sampleRate: Number.NaN },
      { ...validAudioResult(), channelData: [new Float32Array(1_152)] },
      { ...validAudioResult(), channelData: [[], []] },
      { ...validAudioResult(), channelData: pcm(1_151) },
      {
        ...validAudioResult(),
        channelData: [
          Float32Array.from({ length: 1_152 }, () => Number.NaN),
          new Float32Array(1_152),
        ],
      },
    ];

    for (const result of malformed) {
      const harness = mockDecoder(result);
      await harness.decoder.ready;
      expect(() => harness.decoder.decodeVerifiedFrame(makeFrame(), 'audio')).toThrow(
        Mpg123FrameDecoderError,
      );
    }
  });

  it('poisons the generation after its first validation failure', async () => {
    const harness = mockDecoder({ ...validAudioResult(), sampleRate: 48_000 });
    await harness.decoder.ready;

    let firstError: unknown;
    try {
      harness.decoder.decodeVerifiedFrame(makeFrame(), 'audio');
    } catch (error) {
      firstError = error;
    }
    expect(firstError).toBeInstanceOf(Mpg123FrameDecoderError);
    expect(() => harness.decoder.decodeVerifiedFrame(makeFrame(), 'audio')).toThrow(firstError);
    expect(harness.decodeFrame).toHaveBeenCalledTimes(1);
  });

  it('normalizes FORCE_STEREO mono only after proving both channels are identical', async () => {
    const config: Mpg123FrameDecoderConfig = Object.freeze({
      encodedChannels: 1,
      sampleRateHz: 44_100,
      samplesPerFrame: 1_152,
    });
    const frame = makeFrame({ channelModeBits: 3 });
    const valid = mockDecoder(validAudioResult(), config);
    await valid.decoder.ready;
    expect(valid.decoder.decodeVerifiedFrame(frame, 'audio').channelData).toHaveLength(1);

    const unequal = pcm(1_152);
    unequal[1][577] += 0.25;
    const invalid = mockDecoder({ ...validAudioResult(), channelData: unequal }, config);
    await invalid.decoder.ready;
    expect(() => invalid.decoder.decodeVerifiedFrame(frame, 'audio')).toThrow(/not identical/i);
  });

  it('allows a metadata frame to produce no PCM at either zero or the expected rate', async () => {
    for (const sampleRate of [0, 44_100]) {
      const harness = mockDecoder({
        channelData: pcm(0),
        samplesDecoded: 0,
        sampleRate,
        errors: [],
      });
      await harness.decoder.ready;
      const decoded = harness.decoder.decodeVerifiedFrame(makeFrame(), 'metadata');
      expect(decoded.samplesDecoded).toBe(0);
      expect(decoded.sampleRateHz).toBe(sampleRate);
      expect(decoded.channelData).toHaveLength(2);
      expect(decoded.channelData.every((channel) => channel.length === 0)).toBe(true);
    }

    const withPcm = mockDecoder(validAudioResult());
    await withPcm.decoder.ready;
    expect(() => withPcm.decoder.decodeVerifiedFrame(makeFrame(), 'metadata')).toThrow(
      /metadata.*PCM/i,
    );

    const wrongRate = mockDecoder({
      channelData: pcm(0),
      samplesDecoded: 0,
      sampleRate: 48_000,
      errors: [],
    });
    await wrongRate.decoder.ready;
    expect(() => wrongRate.decoder.decodeVerifiedFrame(makeFrame(), 'metadata')).toThrow(
      /sample rate/i,
    );
  });

  it('decodes the real stereo tag and first audio frame with tag-independent PCM parity', async () => {
    const fixture = await verifiedFixtureFrames('demo_track.mp3');
    expect(fixture.metadata.channels).toBe(2);
    const config: Mpg123FrameDecoderConfig = Object.freeze({
      encodedChannels: fixture.metadata.channels,
      sampleRateHz: fixture.metadata.sampleRateHz,
      samplesPerFrame: fixture.metadata.samplesPerFrame,
    });

    const withTag = new Mpg123FrameDecoder(config);
    await withTag.ready;
    const metadata = withTag.decodeVerifiedFrame(fixture.tag, 'metadata');
    const afterTag = withTag.decodeVerifiedFrame(fixture.audio, 'audio');
    expect(metadata).toMatchObject({ samplesDecoded: 0, sampleRateHz: 0 });

    const withoutTag = new Mpg123FrameDecoder(config);
    await withoutTag.ready;
    const direct = withoutTag.decodeVerifiedFrame(fixture.audio, 'audio');
    expect(afterTag.channelData[0]).toEqual(direct.channelData[0]);
    expect(afterTag.channelData[1]).toEqual(direct.channelData[1]);
  });

  it('decodes the real mono tag and returns one proven-identical PCM channel', async () => {
    const fixture = await verifiedFixtureFrames('dummy_audio.mp3');
    expect(fixture.metadata.channels).toBe(1);
    const decoder = new Mpg123FrameDecoder({
      encodedChannels: fixture.metadata.channels,
      sampleRateHz: fixture.metadata.sampleRateHz,
      samplesPerFrame: fixture.metadata.samplesPerFrame,
    });
    await decoder.ready;

    expect(decoder.decodeVerifiedFrame(fixture.tag, 'metadata')).toMatchObject({
      samplesDecoded: 0,
      sampleRateHz: 0,
    });
    const audio = decoder.decodeVerifiedFrame(fixture.audio, 'audio');
    expect(audio.channelData).toHaveLength(1);
    expect(audio.channelData[0]).toHaveLength(fixture.metadata.samplesPerFrame);
    expect(audio.channelData[0]?.every(Number.isFinite)).toBe(true);
  });
});
