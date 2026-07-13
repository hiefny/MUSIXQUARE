import { describe, expect, it } from 'vitest';

import {
  decodeInterleavedLinearPcm,
  decodeLinearPcmScalar,
  linearPcmSourceFrameByteOffset,
  planLinearPcmInputRead,
  validateLinearPcmSampleLayout,
} from '../decoder-helpers.ts';
import {
  LinearPcmDecodeError,
  type LinearPcmEncoding,
  type LinearPcmSampleLayout,
} from '../sample-format.ts';
import {
  LINEAR_PCM_STREAM_MAX_MESSAGE_FRAMES,
  type LinearPcmStreamDescriptor,
} from '../stream-protocol.ts';

const STEREO_S16: LinearPcmSampleLayout = {
  channels: 2,
  encoding: 'pcm-s16le',
  containerBitsPerSample: 16,
  validBitsPerSample: 16,
  blockAlign: 4,
};

const ENCODING_BITS: Readonly<Record<LinearPcmEncoding, 8 | 16 | 24 | 32 | 64>> = {
  'pcm-u8': 8,
  'pcm-s8': 8,
  'pcm-s16le': 16,
  'pcm-s16be': 16,
  'pcm-s24le': 24,
  'pcm-s24be': 24,
  'pcm-s32le': 32,
  'pcm-s32be': 32,
  float32le: 32,
  float32be: 32,
  float64le: 64,
  float64be: 64,
};

function monoLayout(
  encoding: LinearPcmEncoding,
  validBitsPerSample = ENCODING_BITS[encoding],
): LinearPcmSampleLayout {
  const containerBitsPerSample = ENCODING_BITS[encoding];
  return {
    channels: 1,
    encoding,
    containerBitsPerSample,
    validBitsPerSample,
    blockAlign: containerBitsPerSample / 8,
  };
}

function scalar(bytes: Uint8Array, layout: LinearPcmSampleLayout): number {
  return decodeLinearPcmScalar(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    0,
    layout,
  );
}

describe('container-neutral linear PCM helpers', () => {
  it('deinterleaves bounded PCM independently of an encoded container', () => {
    const backing = new Uint8Array(12);
    const view = new DataView(backing.buffer);
    view.setInt16(2, -32_768, true);
    view.setInt16(4, 16_384, true);
    view.setInt16(6, 0, true);
    view.setInt16(8, 32_767, true);

    const decoded = decodeInterleavedLinearPcm(backing.subarray(2, 10), STEREO_S16);

    expect(decoded.frames).toBe(2);
    expect(Array.from(decoded.channels[0]!)).toEqual([-1, 0]);
    expect(Array.from(decoded.channels[1]!)).toEqual([0.5, 32_767 / 32_768]);
  });

  it('keeps strict high-aligned valid-bit validation in the shared converter', () => {
    const layout: LinearPcmSampleLayout = {
      channels: 1,
      encoding: 'pcm-s16le',
      containerBitsPerSample: 16,
      validBitsPerSample: 12,
      blockAlign: 2,
    };

    expect(() => decodeInterleavedLinearPcm(Uint8Array.of(0xf1, 0x7f), layout)).toThrow(
      LinearPcmDecodeError,
    );
  });

  it.each<readonly [LinearPcmEncoding, Uint8Array, number]>([
    ['pcm-s8', Uint8Array.of(0x80), -1],
    ['pcm-s8', Uint8Array.of(0x7f), 127 / 128],
    ['pcm-s16be', Uint8Array.of(0x80, 0x00), -1],
    ['pcm-s16be', Uint8Array.of(0x7f, 0xff), 32_767 / 32_768],
    ['pcm-s24be', Uint8Array.of(0x80, 0x00, 0x00), -1],
    ['pcm-s24be', Uint8Array.of(0x7f, 0xff, 0xff), 8_388_607 / 8_388_608],
    ['pcm-s32be', Uint8Array.of(0x80, 0x00, 0x00, 0x00), -1],
    ['pcm-s32be', Uint8Array.of(0x7f, 0xff, 0xff, 0xff), 2_147_483_647 / 2_147_483_648],
  ])('normalizes %s against its signed container full-scale', (encoding, bytes, expected) => {
    expect(scalar(bytes, monoLayout(encoding))).toBe(expected);
  });

  it.each<readonly [LinearPcmEncoding, number, Uint8Array, Uint8Array]>([
    ['pcm-s8', 4, Uint8Array.of(0x70), Uint8Array.of(0x71)],
    ['pcm-s16be', 12, Uint8Array.of(0x7f, 0xf0), Uint8Array.of(0x7f, 0xf1)],
    ['pcm-s24be', 20, Uint8Array.of(0x7f, 0xff, 0xf0), Uint8Array.of(0x7f, 0xff, 0xf1)],
    ['pcm-s32be', 24, Uint8Array.of(0x7f, 0xff, 0xff, 0x00), Uint8Array.of(0x7f, 0xff, 0xff, 0x01)],
  ])('strictly checks high-aligned %s validBits padding', (encoding, validBits, valid, invalid) => {
    expect(() => scalar(valid, monoLayout(encoding, validBits))).not.toThrow();
    expect(() => scalar(invalid, monoLayout(encoding, validBits))).toThrow(LinearPcmDecodeError);
  });

  it('decodes big-endian IEEE float and replaces non-finite samples with silence', () => {
    const float32 = new Uint8Array(16);
    const float32View = new DataView(float32.buffer);
    float32View.setFloat32(0, Number.NaN, false);
    float32View.setFloat32(4, Number.POSITIVE_INFINITY, false);
    float32View.setFloat32(8, Number.NEGATIVE_INFINITY, false);
    float32View.setFloat32(12, 2.5, false);

    expect(
      Array.from(decodeInterleavedLinearPcm(float32, monoLayout('float32be')).channels[0]!),
    ).toEqual([0, 0, 0, 2.5]);

    const float64 = new Uint8Array(16);
    const float64View = new DataView(float64.buffer);
    float64View.setFloat64(0, Number.NaN, false);
    float64View.setFloat64(8, -1.25, false);
    expect(
      Array.from(decodeInterleavedLinearPcm(float64, monoLayout('float64be')).channels[0]!),
    ).toEqual([0, -1.25]);
  });

  it('derives and enforces exact blockAlign for new big-endian layouts', () => {
    const stereoS24Be: LinearPcmSampleLayout = {
      channels: 2,
      encoding: 'pcm-s24be',
      containerBitsPerSample: 24,
      validBitsPerSample: 20,
      blockAlign: 6,
    };

    expect(() => validateLinearPcmSampleLayout(stereoS24Be)).not.toThrow();
    expect(() => validateLinearPcmSampleLayout({ ...stereoS24Be, blockAlign: 5 })).toThrow(
      'blockAlign',
    );
  });

  it('maps sparse source frames and plans reads without container-specific state', () => {
    const logicalFileBytes = 5 * 1_024 * 1_024 * 1_024;
    const dataOffset = 80;
    const dataBytes = logicalFileBytes - dataOffset;
    const descriptor: LinearPcmStreamDescriptor = {
      sourceSampleRate: 48_000,
      outputSampleRate: 48_000,
      ...STEREO_S16,
      dataOffset,
      dataBytes,
      logicalFileBytes,
      totalSourceFrames: dataBytes / STEREO_S16.blockAlign,
      targetSourceFrame: 0,
    };

    expect(linearPcmSourceFrameByteOffset(descriptor, descriptor.totalSourceFrames)).toBe(
      logicalFileBytes,
    );
    expect(planLinearPcmInputRead(descriptor, 0)).toEqual({
      sourceFrame: 0,
      byteOffset: dataOffset,
      frames: 16_384,
      bytes: 65_536,
      final: false,
    });
    expect(() =>
      planLinearPcmInputRead(descriptor, 0, LINEAR_PCM_STREAM_MAX_MESSAGE_FRAMES + 1),
    ).toThrow('maximumFrames');
  });
});
