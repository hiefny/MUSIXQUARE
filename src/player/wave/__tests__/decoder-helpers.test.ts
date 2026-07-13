import { describe, expect, it } from 'vitest';

import {
  WavePcmDecodeError,
  createWaveStreamDescriptor,
  decodeWaveInterleavedPcm,
  decodeWavePcmScalar,
  expectedWaveOutputFrames,
  maximumWaveInputFramesPerRead,
  planWavePcmInputRead,
  remainingWaveSourceFrames,
  validateWaveStreamDescriptor,
  waveOutputFrameAtTarget,
  waveSourceFrameByteOffset,
  type WavePcmSampleLayout,
} from '../decoder-helpers.ts';
import type { WavePcmEncoding, WavePcmMetadata } from '../metadata.ts';
import {
  WAVE_STREAM_MAX_PCM_MESSAGE_FRAMES,
  WAVE_STREAM_MAX_READ_BYTES,
  type WaveStreamDescriptor,
} from '../stream-protocol.ts';

const GIB = 1_024 * 1_024 * 1_024;

const ENCODING_BITS: Readonly<Record<WavePcmEncoding, 8 | 16 | 24 | 32 | 64>> = {
  'pcm-u8': 8,
  'pcm-s16le': 16,
  'pcm-s24le': 24,
  'pcm-s32le': 32,
  float32le: 32,
  float64le: 64,
};

function sampleLayout(
  encoding: WavePcmEncoding,
  options: { readonly channels?: number; readonly validBits?: number } = {},
): WavePcmSampleLayout {
  const bits = ENCODING_BITS[encoding];
  const channels = options.channels ?? 1;
  return {
    channels,
    encoding,
    containerBitsPerSample: bits,
    validBitsPerSample: options.validBits ?? bits,
    blockAlign: channels * (bits / 8),
  };
}

function metadata(patch: Partial<WavePcmMetadata> = {}): WavePcmMetadata {
  const channels = patch.channels ?? 2;
  const encoding = patch.encoding ?? 'pcm-s16le';
  const bits = patch.containerBitsPerSample ?? ENCODING_BITS[encoding];
  const blockAlign = patch.blockAlign ?? channels * (bits / 8);
  const dataBytes = patch.dataBytes ?? blockAlign * 10;
  const dataOffset = patch.dataOffset ?? 80;
  const totalSourceFrames = patch.totalSourceFrames ?? dataBytes / blockAlign;
  const sourceSampleRate = patch.sourceSampleRate ?? 48_000;
  return {
    format: 'wave',
    container: 'riff',
    encoding,
    formatTag: 0x0001,
    sourceSampleRate,
    channels,
    containerBitsPerSample: bits,
    validBitsPerSample: patch.validBitsPerSample ?? bits,
    blockAlign,
    byteRate: patch.byteRate ?? sourceSampleRate * blockAlign,
    channelMask: patch.channelMask ?? 0,
    dataOffset,
    dataBytes,
    totalSourceFrames,
    durationSeconds: patch.durationSeconds ?? totalSourceFrames / sourceSampleRate,
    logicalFileBytes: patch.logicalFileBytes ?? dataOffset + dataBytes,
    rf64SampleCount: patch.rf64SampleCount ?? null,
    ...patch,
  };
}

function descriptor(patch: Partial<WaveStreamDescriptor> = {}): WaveStreamDescriptor {
  return {
    ...createWaveStreamDescriptor(metadata(), 0, 48_000),
    ...patch,
  };
}

function scalar(bytes: Uint8Array, layout: WavePcmSampleLayout): number {
  return decodeWavePcmScalar(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    0,
    layout,
  );
}

function int24(value: number): Uint8Array {
  const unsigned = value < 0 ? value + 0x1_000000 : value;
  return Uint8Array.of(unsigned & 0xff, (unsigned >>> 8) & 0xff, (unsigned >>> 16) & 0xff);
}

describe('WAVE stream descriptor helpers', () => {
  it('creates one frozen descriptor from verified metadata', () => {
    const value = createWaveStreamDescriptor(metadata(), 3, 96_000);

    expect(Object.isFrozen(value)).toBe(true);
    expect(value).toEqual({
      format: 'wave-pcm',
      sourceSampleRate: 48_000,
      outputSampleRate: 96_000,
      channels: 2,
      encoding: 'pcm-s16le',
      containerBitsPerSample: 16,
      validBitsPerSample: 16,
      blockAlign: 4,
      dataOffset: 80,
      dataBytes: 40,
      logicalFileBytes: 120,
      totalSourceFrames: 10,
      targetSourceFrame: 3,
    });
  });

  it('maps every source frame, including a sparse 5 GiB end frame, to an exact byte offset', () => {
    const dataOffset = 80;
    const dataBytes = 5 * GIB - dataOffset;
    const value = createWaveStreamDescriptor(
      metadata({
        container: 'rf64',
        dataOffset,
        dataBytes,
        logicalFileBytes: 5 * GIB,
        totalSourceFrames: dataBytes / 4,
      }),
      dataBytes / 4 - 1,
      48_000,
    );

    expect(waveSourceFrameByteOffset(value, 0)).toBe(dataOffset);
    expect(waveSourceFrameByteOffset(value, value.totalSourceFrames - 1)).toBe(5 * GIB - 4);
    expect(waveSourceFrameByteOffset(value, value.totalSourceFrames)).toBe(5 * GIB);
  });

  it('keeps remaining, resampled output, and output-timeline position mathematically consistent', () => {
    const direct = descriptor({ targetSourceFrame: 3 });
    expect(remainingWaveSourceFrames(direct)).toBe(7);
    expect(expectedWaveOutputFrames(direct)).toBe(7);
    expect(waveOutputFrameAtTarget(direct)).toBe(3);

    const resampled = descriptor({
      sourceSampleRate: 96_000,
      outputSampleRate: 48_000,
      dataBytes: 400,
      totalSourceFrames: 100,
      logicalFileBytes: 480,
      targetSourceFrame: 20,
    });
    expect(remainingWaveSourceFrames(resampled)).toBe(80);
    expect(expectedWaveOutputFrames(resampled)).toBe(40);
    expect(waveOutputFrameAtTarget(resampled)).toBe(10);
  });

  it('plans reads under both the 64 KiB encoded ceiling and 32,768-frame PCM ceiling', () => {
    const mono = descriptor({
      channels: 1,
      encoding: 'pcm-u8',
      containerBitsPerSample: 8,
      validBitsPerSample: 8,
      blockAlign: 1,
      dataBytes: 100_000,
      totalSourceFrames: 100_000,
      logicalFileBytes: 100_080,
    });
    expect(maximumWaveInputFramesPerRead(mono)).toBe(WAVE_STREAM_MAX_READ_BYTES);
    expect(planWavePcmInputRead(mono, 0)).toEqual({
      sourceFrame: 0,
      byteOffset: 80,
      frames: WAVE_STREAM_MAX_PCM_MESSAGE_FRAMES,
      bytes: WAVE_STREAM_MAX_PCM_MESSAGE_FRAMES,
      final: false,
    });

    const wide = descriptor({
      channels: 8,
      encoding: 'float64le',
      containerBitsPerSample: 64,
      validBitsPerSample: 64,
      blockAlign: 64,
      dataBytes: 128_000,
      totalSourceFrames: 2_000,
      logicalFileBytes: 128_080,
    });
    expect(maximumWaveInputFramesPerRead(wide)).toBe(1_024);
    expect(planWavePcmInputRead(wide, 0)).toMatchObject({
      frames: 1_024,
      bytes: WAVE_STREAM_MAX_READ_BYTES,
      final: false,
    });
    expect(planWavePcmInputRead(wide, 1_999)).toEqual({
      sourceFrame: 1_999,
      byteOffset: 80 + 1_999 * 64,
      frames: 1,
      bytes: 64,
      final: true,
    });
    expect(planWavePcmInputRead(wide, 2_000)).toBeNull();
    expect(() => planWavePcmInputRead(wide, 0, WAVE_STREAM_MAX_PCM_MESSAGE_FRAMES + 1)).toThrow(
      'maximumFrames',
    );
  });

  it.each<readonly [string, Partial<WaveStreamDescriptor>, string]>([
    ['wrong format', { format: 'nope' as 'wave-pcm' }, 'format is invalid'],
    ['zero source rate', { sourceSampleRate: 0 }, 'sourceSampleRate'],
    ['zero output rate', { outputSampleRate: 0 }, 'outputSampleRate'],
    ['too many channels', { channels: 9 }, 'channels'],
    ['encoding/container mismatch', { containerBitsPerSample: 24 }, 'containerBitsPerSample'],
    ['zero valid bits', { validBitsPerSample: 0 }, 'validBitsPerSample'],
    [
      'float precision mismatch',
      {
        encoding: 'float32le',
        containerBitsPerSample: 32,
        validBitsPerSample: 24,
        blockAlign: 8,
      },
      'float valid bits',
    ],
    ['bad block alignment', { blockAlign: 5 }, 'blockAlign'],
    ['partial data frame', { dataBytes: 41, logicalFileBytes: 121 }, 'whole number'],
    ['wrong total frames', { totalSourceFrames: 9 }, 'totalSourceFrames contradicts'],
    ['target after end', { targetSourceFrame: 11 }, 'targetSourceFrame'],
    ['data after logical end', { logicalFileBytes: 119 }, 'data exceeds'],
  ])('rejects descriptor invariant: %s', (_label, patch, message) => {
    const value = { ...descriptor(), ...patch } as WaveStreamDescriptor;
    expect(() => validateWaveStreamDescriptor(value)).toThrow(message);
  });

  it('rejects byte-offset arithmetic outside the browser safe-integer range', () => {
    const value = {
      ...descriptor(),
      dataOffset: Number.MAX_SAFE_INTEGER - 3,
      dataBytes: 8,
      logicalFileBytes: Number.MAX_SAFE_INTEGER,
      totalSourceFrames: 2,
      targetSourceFrame: 0,
    } satisfies WaveStreamDescriptor;

    expect(() => validateWaveStreamDescriptor(value)).toThrow('safe-integer range');
  });
});

describe('WAVE PCM scalar conversion', () => {
  it('normalizes unsigned 8-bit PCM around its 128 midpoint', () => {
    const layout = sampleLayout('pcm-u8');
    expect(scalar(Uint8Array.of(0), layout)).toBe(-1);
    expect(scalar(Uint8Array.of(128), layout)).toBe(0);
    expect(scalar(Uint8Array.of(255), layout)).toBe(127 / 128);
  });

  it('normalizes signed 16-, 24-, and 32-bit little-endian PCM exactly', () => {
    const int16 = new Uint8Array(2);
    const int16View = new DataView(int16.buffer);
    int16View.setInt16(0, -32_768, true);
    expect(scalar(int16, sampleLayout('pcm-s16le'))).toBe(-1);
    int16View.setInt16(0, 32_767, true);
    expect(scalar(int16, sampleLayout('pcm-s16le'))).toBe(32_767 / 32_768);

    expect(scalar(int24(-0x80_0000), sampleLayout('pcm-s24le'))).toBe(-1);
    expect(scalar(int24(0x7f_ffff), sampleLayout('pcm-s24le'))).toBe(0x7f_ffff / 0x80_0000);

    const int32 = new Uint8Array(4);
    const int32View = new DataView(int32.buffer);
    int32View.setInt32(0, -0x8000_0000, true);
    expect(scalar(int32, sampleLayout('pcm-s32le'))).toBe(-1);
    int32View.setInt32(0, 0x7fff_ffff, true);
    expect(scalar(int32, sampleLayout('pcm-s32le'))).toBe(0x7fff_ffff / 0x8000_0000);
  });

  it.each<readonly [WavePcmEncoding, number, Uint8Array, Uint8Array]>([
    ['pcm-u8', 4, Uint8Array.of(0xf0), Uint8Array.of(0xf1)],
    ['pcm-s16le', 12, Uint8Array.of(0xf0, 0x7f), Uint8Array.of(0xf1, 0x7f)],
    ['pcm-s24le', 20, Uint8Array.of(0xf0, 0xff, 0x7f), Uint8Array.of(0xf1, 0xff, 0x7f)],
    ['pcm-s32le', 24, Uint8Array.of(0x00, 0xff, 0xff, 0x7f), Uint8Array.of(0x01, 0xff, 0xff, 0x7f)],
  ])(
    'strictly validates left-aligned %s validBits padding',
    (encoding, validBits, valid, invalid) => {
      expect(() => scalar(valid, sampleLayout(encoding, { validBits }))).not.toThrow();
      let error: unknown;
      try {
        scalar(invalid, sampleLayout(encoding, { validBits }));
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(WavePcmDecodeError);
      expect((error as WavePcmDecodeError).code).toBe('nonzero-unused-bits');
    },
  );

  it('sanitizes non-finite IEEE float while preserving finite values above unity', () => {
    const float32 = new Uint8Array(16);
    const view = new DataView(float32.buffer);
    view.setFloat32(0, Number.NaN, true);
    view.setFloat32(4, Number.POSITIVE_INFINITY, true);
    view.setFloat32(8, Number.NEGATIVE_INFINITY, true);
    view.setFloat32(12, 2.5, true);

    const decoded = decodeWaveInterleavedPcm(float32, sampleLayout('float32le'));

    expect(Array.from(decoded.channels[0]!)).toEqual([0, 0, 0, 2.5]);

    const float64 = new Uint8Array(16);
    const float64View = new DataView(float64.buffer);
    float64View.setFloat64(0, Number.NaN, true);
    float64View.setFloat64(8, -1.25, true);
    expect(
      Array.from(decodeWaveInterleavedPcm(float64, sampleLayout('float64le')).channels[0]!),
    ).toEqual([0, -1.25]);
  });

  it('rejects a scalar outside its DataView', () => {
    const bytes = new Uint8Array(2);
    const view = new DataView(bytes.buffer);
    expect(() => decodeWavePcmScalar(view, 1, sampleLayout('pcm-s16le'))).toThrow(
      'exceeds the supplied byte view',
    );
  });
});

describe('WAVE interleaved-to-planar conversion', () => {
  it('preserves stereo frame and channel order from a nonzero Uint8Array offset', () => {
    const backing = new Uint8Array(12);
    const view = new DataView(backing.buffer);
    view.setInt16(2, -32_768, true);
    view.setInt16(4, 16_384, true);
    view.setInt16(6, 0, true);
    view.setInt16(8, 32_767, true);
    const bytes = backing.subarray(2, 10);

    const decoded = decodeWaveInterleavedPcm(bytes, sampleLayout('pcm-s16le', { channels: 2 }));

    expect(decoded.frames).toBe(2);
    expect(Array.from(decoded.channels[0]!)).toEqual([-1, 0]);
    expect(Array.from(decoded.channels[1]!)).toEqual([0.5, 32_767 / 32_768]);
  });

  it('keeps all eight discrete channels in source order', () => {
    const bytes = Uint8Array.from({ length: 8 }, (_, index) => 128 + index * 8);

    const decoded = decodeWaveInterleavedPcm(bytes, sampleLayout('pcm-u8', { channels: 8 }));

    expect(decoded.frames).toBe(1);
    expect(decoded.channels.map((channel) => channel[0])).toEqual([
      0, 0.0625, 0.125, 0.1875, 0.25, 0.3125, 0.375, 0.4375,
    ]);
  });

  it('accepts one exact 64 KiB input but rejects larger, empty, or partial-frame input', () => {
    const maximum = decodeWaveInterleavedPcm(
      new Uint8Array(WAVE_STREAM_MAX_READ_BYTES),
      sampleLayout('pcm-u8'),
    );
    expect(maximum.frames).toBe(WAVE_STREAM_MAX_READ_BYTES);

    expect(() =>
      decodeWaveInterleavedPcm(
        new Uint8Array(WAVE_STREAM_MAX_READ_BYTES + 1),
        sampleLayout('pcm-u8'),
      ),
    ).toThrow('1 through');
    expect(() => decodeWaveInterleavedPcm(new Uint8Array(0), sampleLayout('pcm-u8'))).toThrow(
      '1 through',
    );
    expect(() => decodeWaveInterleavedPcm(new Uint8Array(3), sampleLayout('pcm-s16le'))).toThrow(
      'whole number',
    );
  });
});
